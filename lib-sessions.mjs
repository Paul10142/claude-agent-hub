// Reads the desktop app's own session store and per-session transcripts, so the
// board can show the chat-window title you see in the app — and, on click, what
// the agent is actually doing — rather than just a folder name.

import { readdir, readFile, stat, open } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const STORE_ROOT = path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
const PROJECTS = path.join(HOME, '.claude', 'projects');

/** cliSessionId -> {title, localId, branch, cwd, archived, lastActivityAt} */
let index = new Map();
let indexedAt = 0;
const INDEX_TTL = 5_000;

async function walkJson(dir, out, depth = 0) {
  if (depth > 3) return;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walkJson(p, out, depth + 1);
    else if (e.name.endsWith('.json')) out.push(p);
  }
}

export async function sessionIndex() {
  if (Date.now() - indexedAt < INDEX_TTL) return index;
  const files = [];
  await walkJson(STORE_ROOT, files);
  const next = new Map();
  await Promise.all(files.map(async (f) => {
    try {
      const d = JSON.parse(await readFile(f, 'utf8'));
      const cli = d.cliSessionId;
      if (!cli) return;
      next.set(cli, {
        title: d.title || null,
        localId: d.sessionId || null,
        branch: d.branch || null,
        cwd: d.worktreePath || d.cwd || null,
        archived: !!d.isArchived,
        lastActivityAt: d.lastActivityAt || null,
      });
    } catch { /* a half-written file is not an error worth surfacing */ }
  }));
  if (next.size) { index = next; indexedAt = Date.now(); }
  return index;
}

// ------------------------------------------------------------- transcripts
/** Read only the tail of a transcript — these files reach megabytes. */
async function tail(file, bytes = 1_200_000) {
  let fh;
  try {
    fh = await open(file, 'r');
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
  } catch { return ''; }
  finally { try { await fh?.close(); } catch {} }
}

async function transcriptPath(cliId) {
  let dirs;
  try { dirs = await readdir(PROJECTS, { withFileTypes: true }); } catch { return null; }
  const candidates = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const p = path.join(PROJECTS, d.name, `${cliId}.jsonl`);
    try { const s = await stat(p); candidates.push({ p, m: s.mtimeMs }); } catch {}
  }
  candidates.sort((a, b) => b.m - a.m);
  return candidates[0]?.p || null;
}

// --------------------------------------------------------- finished replies
// Paul's global CLAUDE.md fixes how a final status reply ends. Until 2026-10-16
// its last line started "**Hub:**" (where the to-dos went, whether the branch
// can be archived). Since then a thread that can be archived ends with exactly
// ARCHIVE_LINE, and one that can't ends with neither, because the agent is still
// on it. Either marker means the agent has posted its final update and the next
// move is Paul's: read it.
const ARCHIVE_LINE = 'Everything has been saved. You can archive this thread.';

export function isFinishedReply(text) {
  if (!text) return false;
  // The last three lines, because the archive sentence (or the scratch-folder
  // offer) can follow the Hub line.
  const end = text.split('\n').map(l => l.trim()).filter(Boolean).slice(-3);
  if (end.at(-1)?.replace(/^[*_]+|[*_]+$/g, '') === ARCHIVE_LINE) return true;
  return end.some(l => l.startsWith('**Hub:**'));
}

/**
 * The agent's latest reply, or null if anything has been sent to it since: a
 * new prompt, an answer, or a background-task notice it has yet to answer.
 */
function latestReply(text) {
  const lines = text.split('\n');
  lines.shift(); // a tail read starts mid-line
  for (let i = lines.length - 1; i >= 0; i--) {
    let d;
    try { d = JSON.parse(lines[i]); } catch { continue; }
    if (d.isSidechain) continue;
    const c = d.message?.content;
    if (d.type === 'user' && !d.isMeta) {
      const toolResult = Array.isArray(c) && c.some(x => x?.type === 'tool_result');
      if (!toolResult) return null;
    }
    if (d.type === 'assistant' && Array.isArray(c)) {
      const txt = c.filter(x => x?.type === 'text').map(x => x.text).join('').trim();
      if (txt) return txt;
    }
  }
  return null;
}

const pathMemo = new Map();  // cliId -> {p, at}
const PATH_TTL = 60_000;     // a session can move folders, so re-resolve now and then
const replyMemo = new Map(); // cliId -> {p, mtimeMs, size, finished}

/**
 * Has this session's latest reply been a finished status reply? Cheap enough to
 * call every few seconds: the transcript is re-read only after it changes.
 */
export async function replyFinished(cliId) {
  let m = pathMemo.get(cliId);
  if (!m || Date.now() - m.at > PATH_TTL) {
    m = { p: await transcriptPath(cliId), at: Date.now() };
    pathMemo.set(cliId, m);
  }
  if (!m.p) return false;
  let s;
  try { s = await stat(m.p); } catch { pathMemo.delete(cliId); return false; }
  const hit = replyMemo.get(cliId);
  if (hit && hit.p === m.p && hit.mtimeMs === s.mtimeMs && hit.size === s.size) return hit.finished;
  const finished = isFinishedReply(latestReply(await tail(m.p)));
  replyMemo.set(cliId, { p: m.p, mtimeMs: s.mtimeMs, size: s.size, finished });
  return finished;
}

/**
 * What is this agent actually doing? Pulls the last thing you asked, the last
 * thing Claude said, and its current to-do list if it keeps one.
 */
export async function sessionDetail(cliId) {
  const file = await transcriptPath(cliId);
  if (!file) return { available: false };
  const text = await tail(file);
  const lines = text.split('\n');
  // The first line of a tail read is usually a fragment.
  if (lines.length) lines.shift();

  let lastPrompt = null, lastAssistant = null, todos = null, question = null;
  const activity = [];

  for (let i = lines.length - 1; i >= 0; i--) {
    let d;
    try { d = JSON.parse(lines[i]); } catch { continue; }
    const t = d.type;

    if (t === 'last-prompt' && !lastPrompt) lastPrompt = d.lastPrompt || null;

    if (t === 'assistant') {
      const content = d.message?.content;
      if (Array.isArray(content)) {
        if (!lastAssistant) {
          const txt = content.filter(c => c?.type === 'text').map(c => c.text).join('').trim();
          if (txt) lastAssistant = txt;
        }
        for (const c of content) {
          if (c?.type === 'tool_use') {
            // A multiple-choice question the agent is blocked on. This is the
            // single most useful thing the board can show, so it is read
            // straight from the transcript rather than inferred.
            if (!question && c.name === 'AskUserQuestion' && Array.isArray(c.input?.questions)) {
              question = c.input.questions.map(q => ({
                header: q.header || null,
                question: q.question || '',
                multi: !!q.multiSelect,
                options: (q.options || []).map(o => ({
                  label: o.label || '', description: o.description || '',
                })),
              }));
            }
            if (!todos && c.name === 'TodoWrite' && Array.isArray(c.input?.todos)) {
              todos = c.input.todos.map(x => ({ status: x.status, content: x.content }));
            }
            if (activity.length < 12 && c.name !== 'TodoWrite') {
              const d0 = c.input?.description || c.input?.file_path || c.input?.command || c.input?.pattern || '';
              activity.push({ tool: c.name, detail: String(d0).slice(0, 110) });
            }
          }
        }
      }
    }
    if (lastPrompt && lastAssistant && todos && question && activity.length >= 12) break;
  }

  return {
    available: true,
    lastPrompt,
    lastAssistant: lastAssistant ? lastAssistant.slice(0, 40_000) : null,
    todos,
    question,
    activity,
  };
}
