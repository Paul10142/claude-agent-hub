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
      // The app's own summary of the latest turn, only if it is about that turn.
      const current = d.postTurnSummaryFor && d.postTurnSummaryFor === d.lastAssistantUuid;
      next.set(cli, {
        title: d.title || null,
        localId: d.sessionId || null,
        branch: d.branch || null,
        cwd: d.worktreePath || d.cwd || null,
        archived: !!d.isArchived,
        lastActivityAt: d.lastActivityAt || null,
        // Started by a scheduled task (daily health check, hub check, ...).
        routine: !!d.scheduledTaskId,
        // Something the app's summary says Paul has to do, e.g. "answer the 4 decisions".
        needsAction: current ? (d.postTurnSummary?.needs_action || '').trim() : '',
        // Its one-line summary of what the turn did, e.g. "#239 done; loop running next".
        statusDetail: current ? (d.postTurnSummary?.status_detail || '').trim() : '',
        // Open pull requests whose CI the app is watching; a failure wakes the agent.
        watchedPrs: (d.prs || []).filter(p => p.state === 'OPEN' && p.autoFix).map(p => p.prNumber),
        // The session that started this one; it gets woken when this one finishes.
        parentLocalId: d.spawnedFrom?.sessionId || null,
        // Remote Control's session on claude.ai, newest last; claude.ai/code/<id>
        // opens it on the phone. Absent when Remote Control is off.
        bridgeId: Array.isArray(d.bridgeSessionIds) ? d.bridgeSessionIds.at(-1) || null : null,
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

// ---------------------------------------------------------- turn endings
// Paul's global CLAUDE.md fixes how a status reply ends: "**HUB:**",
// "**BRANCH:**" and "**SAVE:**" lines, the SAVE line last. It reads exactly
// ARCHIVE_LINE when the thread can be archived, "Not yet: ..." otherwise.
// Older replies end "**Hub:** ... **Branch:** ..." with ARCHIVE_LINE bare on the
// last line, or with the archive sentence alone, so both shapes are accepted.
const ARCHIVE_LINE = 'Everything has been saved. You can archive this thread.';
const HUB_LINE = /^\*\*HUB:\*\*/i;
const SAVE_LABEL = /^\*\*SAVE:\*\*\s*/i;

/** The agent's own word that it is done: the archive sentence as the last line. */
export function isArchivable(text) {
  if (!text) return false;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.at(-1)?.replace(SAVE_LABEL, '').replace(/^[*_]+|[*_]+$/g, '') === ARCHIVE_LINE;
}

/** A status reply's closing HUB line, in the last five lines. */
export function hasHubLine(text) {
  if (!text) return false;
  return text.split('\n').map(l => l.trim()).filter(Boolean).slice(-5).some(l => HUB_LINE.test(l));
}

/**
 * The open items under a reply's "## ✅ TO-DO ITEMS" heading: top-level "- [ ]"
 * lines, up to the next heading, the Hub line or the archive sentence. Fillers
 * like "- [ ] Nothing new from you." are not to-dos. section is false when the
 * reply has no such heading at all.
 */
export function replyTodos(text) {
  if (!text) return { section: false, items: [] };
  const lines = text.split('\n');
  const start = lines.findIndex(l => /^\s*(?:#{1,6}\s+|\*\*).*TO-?DO ITEMS/i.test(l));
  if (start < 0) return { section: false, items: [] };
  const items = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\s*#{1,6}\s/.test(l) || HUB_LINE.test(l.trim()) || SAVE_LABEL.test(l.trim()) || l.trim() === ARCHIVE_LINE || l.trim() === '---') break;
    const m = /^ ?[-*]\s+\[ \]\s+(.+)/.exec(l);
    if (!m) continue;
    const item = m[1].replace(/\*\*/g, '').trim();
    if (/^(nothing|none|no new|no to-?dos?|n\/a)\b/i.test(item)) continue;
    items.push(item);
  }
  return { section: true, items };
}

// Things that wake an agent up again without Paul: a background command, a
// background subagent or a Monitor sends a <task-notification> when it ends.
const LAUNCH = /^(?:Command running in background with ID: (\w+)|Async agent launched successfully|Monitor started \(task (\w+))/;
const TASK_DONE = new Set(['completed', 'failed', 'killed', 'stopped']);
const textOf = (c) => typeof c === 'string' ? c
  : Array.isArray(c) ? c.map(x => (x && typeof x.text === 'string') ? x.text : '').join('') : '';

/**
 * How the latest turn ended, read from the transcript: the agent's latest reply
 * (null if anything has been sent to it since), and what it left running.
 */
function readTurn(text) {
  const lines = text.split('\n');
  lines.shift(); // a tail read starts mid-line
  const uses = new Map();     // tool_use id -> tool_use
  const launched = new Map(); // tool_use id -> {task, tool, desc, at}
  const done = new Set();     // tool_use ids and task ids that have finished
  let reply = null, replyAt = null, wakeAt = null;
  for (const raw of lines) {
    // Finish notices arrive as user text, queue operations or attachments, so
    // read them off the raw line rather than one JSON shape.
    if (raw.includes('<task-notification>')) {
      for (const m of raw.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
        const st = /<status>(\w+)<\/status>/.exec(m[1]);
        if (st && TASK_DONE.has(st[1]))
          for (const k of m[1].matchAll(/<(?:tool-use-id|task-id)>(\w+)</g)) done.add(k[1]);
      }
    }
    let d;
    try { d = JSON.parse(raw); } catch { continue; }
    if (d.isSidechain) continue;
    const c = d.message?.content;
    if (d.type === 'assistant' && Array.isArray(c)) {
      for (const x of c) {
        if (x?.type !== 'tool_use') continue;
        uses.set(x.id, x);
        if (x.name === 'ScheduleWakeup') {
          const at = Date.parse(d.timestamp);
          wakeAt = x.input?.stop ? null : (at && x.input?.delaySeconds ? at + x.input.delaySeconds * 1000 : null);
        }
      }
      const txt = c.filter(x => x?.type === 'text').map(x => x.text).join('').trim();
      if (txt) { reply = txt; replyAt = Date.parse(d.timestamp) || null; }
    }
    if (d.type === 'user' && Array.isArray(c)) {
      for (const x of c) {
        if (x?.type !== 'tool_result') continue;
        const u = uses.get(x.tool_use_id);
        const m = u && LAUNCH.exec(textOf(x.content).trimStart());
        if (!m) continue;
        const agent = /agentId: (\w+)/.exec(textOf(x.content));
        launched.set(x.tool_use_id, {
          task: m[1] || m[2] || agent?.[1] || null,
          tool: u.name,
          desc: u.input?.description || '',
          at: Date.parse(d.timestamp) || null,
        });
      }
    }
    // A prompt, an answer or a notice sent after the reply makes it old news.
    if (d.type === 'user' && !d.isMeta && !(Array.isArray(c) && c.some(x => x?.type === 'tool_result'))) reply = null;
  }
  const pending = [...launched.entries()]
    .filter(([id, v]) => !done.has(id) && !(v.task && done.has(v.task)))
    .map(([, v]) => ({ tool: v.tool, desc: v.desc, at: v.at }));
  return { reply, replyAt: reply ? replyAt : null, pending, wakeAt };
}

const pathMemo = new Map();  // cliId -> {p, at}
const PATH_TTL = 60_000;     // a session can move folders, so re-resolve now and then
const turnMemo = new Map();  // cliId -> {p, mtimeMs, size, info}
const TURN_BYTES = 6_000_000; // enough to reach back past most background launches

/**
 * How this session's latest turn ended. Cheap enough to call every few seconds:
 * the transcript is re-read only after it changes.
 *   archivable  the reply ends with the archive sentence
 *   hubLine     the reply ends with a Hub line
 *   todos       open items under its TO-DO ITEMS heading (todoSection: has one)
 *   replyAt     when that reply was written
 *   pending     background commands, subagents and monitors still running
 *   wakeAt      when a scheduled check-in (ScheduleWakeup) is due, if any
 *   quietSince  when the transcript last changed
 */
export async function turnInfo(cliId) {
  let m = pathMemo.get(cliId);
  if (!m || Date.now() - m.at > PATH_TTL) {
    m = { p: await transcriptPath(cliId), at: Date.now() };
    pathMemo.set(cliId, m);
  }
  if (!m.p) return null;
  let s;
  try { s = await stat(m.p); } catch { pathMemo.delete(cliId); return null; }
  const hit = turnMemo.get(cliId);
  if (hit && hit.p === m.p && hit.mtimeMs === s.mtimeMs && hit.size === s.size) return hit.info;
  const t = readTurn(await tail(m.p, TURN_BYTES));
  const todo = replyTodos(t.reply);
  const info = {
    archivable: isArchivable(t.reply),
    hubLine: hasHubLine(t.reply),
    todos: todo.items,
    todoSection: todo.section,
    replyAt: t.replyAt,
    pending: t.pending,
    wakeAt: t.wakeAt,
    quietSince: s.mtimeMs,
  };
  turnMemo.set(cliId, { p: m.p, mtimeMs: s.mtimeMs, size: s.size, info });
  return info;
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
