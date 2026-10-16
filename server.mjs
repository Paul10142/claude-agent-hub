#!/usr/bin/env node
// Agent Dashboard — a live view of every Claude Code session on this machine.
//
// Consumes the same event stream the hooks already post to 127.0.0.1:7823,
// so no hook changes are needed. Zero dependencies by design: this runs at
// login and must never break because of a package update.
//
//   POST /event    ingest one hook event
//   GET  /         the dashboard
//   GET  /stream   server-sent events (live push to the browser)
//   GET  /api/state JSON snapshot (debugging, and a seam for a remote view)

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { sessionIndex, sessionDetail, turnInfo } from './lib-sessions.mjs';
import { readTodo } from './lib-todo.mjs';

const HOST = process.env.AGENT_DASH_HOST || '127.0.0.1';
const PORT = Number(process.env.AGENT_DASH_PORT || 7823);
const HERE = path.dirname(fileURLToPath(import.meta.url));

// The header's "To-Do Hub" link. It points at a private page, so it lives in
// config.json (gitignored) rather than in the published HTML; no hubUrl, no button.
function hubUrl() {
  for (const name of ['config.json', 'config.example.json']) {
    try {
      const u = JSON.parse(readFileSync(path.join(HERE, name), 'utf8')).hubUrl;
      return typeof u === 'string' && /^https:\/\//.test(u) ? u : null;
    } catch { /* try the next candidate */ }
  }
  return null;
}
const HUB_URL = hubUrl();

/** session_id -> record */
const sessions = new Map();
/** cliSessionId -> {title, localId, branch} from the desktop app's own store */
let titleCache = new Map();
/** connected SSE clients */
const clients = new Set();
/** session id -> how its latest turn ended (see turnInfo in lib-sessions.mjs) */
const turns = new Map();

const now = () => Date.now();

// ---------------------------------------------------------------- git lookup
// cwd -> {project, branch, at}. Cheap, cached, and never blocks ingestion.
const gitCache = new Map();
const GIT_TTL = 15_000;

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 2500 }, (err, stdout) =>
      resolve(err ? null : String(stdout).trim() || null),
    );
  });
}

async function enrich(cwd) {
  if (!cwd) return { project: null, branch: null };
  const hit = gitCache.get(cwd);
  if (hit && now() - hit.at < GIT_TTL) return hit;
  const [top, branch] = await Promise.all([
    run('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], cwd),
    run('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], cwd),
  ]);
  // Only a real repo earns a project name. Outside one — a scratch or temp
  // directory — leave it null so the board can show a sensible fallback
  // instead of a meaningless folder name like "T".
  const project = top ? path.basename(top) : null;
  const rec = { project, branch, worktree: path.basename(cwd), at: now() };
  gitCache.set(cwd, rec);
  return rec;
}

// ------------------------------------------------------------- liveness
// A crashed agent never sends "Ended", so trusting events alone leaves ghosts
// on the board forever. The pid is authoritative: if the process is gone, the
// session is gone, whatever the last event claimed.
function alive(pid) {
  if (!pid) return true; // unknown pid: fall back to the staleness sweep
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const STALE_MS = 15 * 60 * 1000;

function sweep() {
  let changed = false;
  for (const [id, s] of sessions) {
    if (s.state === 'Ended') {
      if (now() - s.lastSeen > 60_000) { sessions.delete(id); changed = true; }
      continue;
    }
    if (!alive(s.pid)) { sessions.delete(id); changed = true; continue; }
    if (now() - s.lastSeen > STALE_MS) { sessions.delete(id); changed = true; }
  }
  if (changed) broadcast();
}

// ------------------------------------------------------------------ state
// Paul's columns (2026-10-16), decided once a turn is over by two questions:
// does it leave him something to do, and will it carry on without him?
//   needsInput  — he has something to do: a permission prompt or question
//                 ('Waiting'), or to-do items in the agent's latest reply (the
//                 "## ✅ TO-DO ITEMS" checkboxes; the app's own turn summary
//                 stands in when the reply has no such section).
//   ready       — the turn is over, no to-dos, and nothing will happen until he
//                 looks: a report to read, or a stalled agent. A finished one
//                 (archive sentence) sits here for its first hour, so he sees it.
//   working     — mid-turn ('Working').
//   background  — the turn is over, no to-dos, but something it started will
//                 wake it again on its own: a background command, subagent or
//                 monitor still running, an open pull request whose CI the app
//                 is watching, a scheduled check-in, or a session it started.
//   completed   — the reply ends with the archive sentence, has no to-dos, and
//                 is over an hour old: only archiving is left. Shown only after
//                 "Show Completed" ("things I haven't been able to archive yet").
//
// History: every ended turn used to sit under Working, so an agent waiting on
// CI would not send Paul to a window with nothing to ask. Background is now that
// bucket, said out loud. Then "Ready for You" took finished turns, and on
// 2026-10-16 Paul drew the line between it and Needs Input: "Anything that has
// a to-do item should show up under Needs input."
//
// The archive sentence beats anything left running (a forgotten dev server must
// not hold a finished session in Background). To-dos beat it: they stay in
// Needs Input until Paul archives the session.
//
// Anything left running counts only while the transcript has moved in the last
// three hours. Background tasks die with their session, and a session that has
// been silent that long is not about to be woken.
const BG_QUIET_MS = 3 * 60 * 60 * 1000;
const FRESH_MS = 60 * 60 * 1000; // a finished session shows in Ready for You this long

function backgroundReason(t, meta) {
  if (!t || now() - t.quietSince > BG_QUIET_MS) return null;
  const why = [];
  const n = (k, one, many) => (k === 1 ? one : `${k} ${many}`);
  const cmds = t.pending.filter(p => p.tool === 'Bash');
  const agents = t.pending.filter(p => p.tool === 'Agent');
  const mons = t.pending.filter(p => p.tool === 'Monitor');
  if (cmds.length) why.push(cmds.length === 1 && cmds[0].desc ? cmds[0].desc : n(cmds.length, 'A background command', 'background commands'));
  if (agents.length) why.push(n(agents.length, 'A helper agent', 'helper agents'));
  if (mons.length) why.push(mons.length === 1 && mons[0].desc ? mons[0].desc : n(mons.length, 'A monitor', 'monitors'));
  if (meta?.watchedPrs?.length) why.push(`CI on PR #${meta.watchedPrs.join(', #')}`);
  if (t.wakeAt && t.wakeAt > now()) {
    const d = new Date(t.wakeAt);
    why.push(`Check-in at ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
  }
  return why.length ? why.join(' · ') : null;
}

function todosOf(t, meta) {
  if (t?.todos?.length) return t.todos;
  // No TO-DO section (a short reply, or a question in the app's box): the app's
  // own summary of the turn says whether Paul has something to do.
  if (!t?.todoSection && meta?.needsAction) return [meta.needsAction];
  return [];
}

function classify(state, t, meta) {
  if (state === 'Waiting') return { group: 'needsInput', todos: [] };
  if (state === 'Working') return { group: 'working', todos: [] };
  // Idle, or Ended: the turn is over either way.
  const todos = todosOf(t, meta);
  if (todos.length) return { group: 'needsInput', todos };
  if (t?.archivable)
    return { group: now() - (t.replyAt || t.quietSince) < FRESH_MS ? 'ready' : 'completed', todos };
  const why = backgroundReason(t, meta);
  return why ? { group: 'background', why, todos } : { group: 'ready', todos };
}

// The board used to show ONLY sessions that had fired a hook since this server
// last started, so a restart emptied it and a quiet window stayed invisible.
// The app's own store is the complete list; live hook events layer on top.
const KEEP_MS = 24 * 60 * 60 * 1000; // older than this is history, not a board item

function fromStore() {
  const out = [];
  for (const [cli, m] of titleCache) {
    if (!cli || m.archived) continue;
    if (sessions.has(cli)) continue;           // a live session wins
    const last = Number(m.lastActivityAt) || 0;
    if (!last || Date.now() - last > KEEP_MS) continue;
    out.push({
      id: cli,
      live: false,                              // no hook signal — say so, never guess loudly
      agent: 'Claude',
      // Not emitting events means it is not mid-turn. Which column it belongs
      // in is read from its transcript (classify). It used to read 'Ended'
      // after 45 quiet minutes and drop into a Completed section; Paul archives
      // what he has finished, so an unarchived window is never "completed".
      state: 'Idle',
      cwd: m.cwd || '',
      branch: m.branch || null,
      title_session: m.title || null,
      localId: m.localId || null,
      lastSeen: last,
      stateAt: last,
      firstSeen: last,
    });
  }
  return out;
}

function snapshot() {
  const titles = titleCache;
  const list = [...sessions.values()].map((s) => {
    const meta = titles.get(s.id) || {};
    return {
      ...s,
      live: true,
      ...classify(s.state, turns.get(s.id), meta),
      blocked: s.state === 'Waiting',       // permission prompt: the loud kind
      title_session: meta.title || null,     // the chat-window name from the app
      localId: meta.localId || null,
      branch: s.branch || meta.branch || null,
      routine: !!meta.routine,
      needsAction: meta.needsAction || '',
      statusDetail: meta.statusDetail || '',
    };
  });
  for (const st of fromStore()) {
    const meta = titles.get(st.id) || {};
    list.push({ ...st, ...classify(st.state, turns.get(st.id), meta), blocked: false,
      routine: !!meta.routine, needsAction: meta.needsAction || '', statusDetail: meta.statusDetail || '' });
  }
  // A session that started side sessions is woken when they finish, so while
  // one of them is still going, so is it.
  const running = new Map();
  for (const r of list) {
    const parent = titles.get(r.id)?.parentLocalId;
    if (parent && (r.group === 'working' || r.group === 'background'))
      running.set(parent, (running.get(parent) || 0) + 1);
  }
  for (const r of list) {
    const k = r.localId && running.get(r.localId);
    const t = turns.get(r.id);
    if (!k || r.group !== 'ready' || t?.archivable) continue;
    if (t && now() - t.quietSince > BG_QUIET_MS) continue;
    r.group = 'background';
    r.why = k === 1 ? 'A session it started' : `${k} sessions it started`;
  }
  const rank = { needsInput: 0, ready: 1, working: 2, background: 3, completed: 4 };
  list.sort(
    (a, b) =>
      (rank[a.group] ?? 9) - (rank[b.group] ?? 9) ||
      (b.blocked ? 1 : 0) - (a.blocked ? 1 : 0) ||
      (b.live ? 1 : 0) - (a.live ? 1 : 0) ||
      b.lastSeen - a.lastSeen,
  );
  return { serverTime: now(), home: os.homedir(), hubUrl: HUB_URL, sessions: list };
}

function broadcast() {
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

async function ingest(ev) {
  const id = String(ev.session_id || 'default');
  const prev = sessions.get(id) || {
    id,
    firstSeen: now(),
    prompts: 0,
    tools: 0,
  };

  const rec = {
    ...prev,
    id,
    agent: ev.agent || prev.agent || 'Claude',
    state: ev.state || prev.state || 'Working',
    event: ev.event || prev.event || '',
    cwd: ev.cwd || prev.cwd || '',
    terminal: ev.terminal || prev.terminal || '',
    pid: ev.pid || prev.pid || null,
    lastSeen: now(),
  };

  // `title` only arrives on UserPromptSubmit — it is the task you asked for.
  if (ev.ask) { rec.ask = ev.ask; }
  if (ev.title) {
    rec.title = ev.title;
    rec.taskAt = now();
    rec.prompts = (prev.prompts || 0) + 1;
  }
  if (ev.event === 'PreToolUse') rec.tools = (prev.tools || 0) + 1;
  // Track when the current state began, so the board can show "waiting 4m".
  if (prev.state !== rec.state) rec.stateAt = now();
  else rec.stateAt = prev.stateAt || now();

  // A new turn makes the last one old news; until the next one is read, the
  // board knows nothing about how it ended.
  if (rec.state === 'Working') turns.delete(id);
  sessions.set(id, rec);
  broadcast();
  if (rec.state !== 'Working') refreshTurns();

  // Enrichment is deliberately after the broadcast: the board updates
  // instantly, then fills in project/branch a moment later.
  const g = await enrich(rec.cwd);
  const cur = sessions.get(id);
  if (cur && (cur.project !== g.project || cur.branch !== g.branch)) {
    cur.project = g.project;
    cur.branch = g.branch;
    cur.worktree = g.worktree;
    broadcast();
  }
}

// ------------------------------------------------------------------ server
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 1e6) { b = b.slice(0, 1e6); req.destroy(); }
    });
    req.on('end', () => resolve(b));
    req.on('error', () => resolve(''));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'POST' && url.pathname === '/event') {
    const body = await readBody(req);
    try { await ingest(JSON.parse(body || '{}')); } catch { /* never fail a hook */ }
    res.writeHead(204).end();
    return;
  }

  if (url.pathname === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20_000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (url.pathname === '/api/todo') {
    // Parsed into discrete items so the board can show numbered open actions.
    // Read fresh every time: other sessions edit this file constantly.
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(await readTodo()));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }

  if (url.pathname.startsWith('/api/session/')) {
    const id = decodeURIComponent(url.pathname.split('/').pop() || '');
    const detail = await sessionDetail(id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(detail));
    return;
  }

  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(snapshot(), null, 2));
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = await readFile(path.join(HERE, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500).end('dashboard html missing');
    }
    return;
  }

  res.writeHead(404).end('not found');
});

setInterval(sweep, 5_000).unref?.();

// How each ended turn finished. Reads transcripts, so it runs beside the board
// rather than inside snapshot(); turnInfo only re-reads a transcript that has
// changed since last time.
let checking = false, again = false;
// Everything classify() reads, including the two clocks, so crossing the
// one-hour or three-hour line re-sorts the board without any new event.
const turnKey = (t) => t ? [t.archivable, t.todos.length, t.todoSection, t.pending.length, t.wakeAt,
  t.quietSince > now() - BG_QUIET_MS, (t.replyAt || t.quietSince) > now() - FRESH_MS].join('|') : '';
async function refreshTurns() {
  if (checking) { again = true; return; } // an event mid-check: run once more after
  checking = true;
  try {
    const ids = new Set();
    for (const s of sessions.values()) if (s.state !== 'Working') ids.add(s.id);
    for (const s of fromStore()) ids.add(s.id);
    let changed = false;
    for (const id of ids) {
      const t = await turnInfo(id).catch(() => null);
      // A new turn may have started while the transcript was being read.
      if (sessions.get(id)?.state === 'Working') continue;
      if (turnKey(turns.get(id)) !== turnKey(t)) changed = true;
      if (t) turns.set(id, t); else turns.delete(id);
    }
    for (const id of turns.keys()) if (!ids.has(id)) turns.delete(id);
    if (changed) broadcast();
  } finally {
    checking = false;
    if (again) { again = false; refreshTurns(); }
  }
}
setInterval(refreshTurns, 5_000).unref?.();

async function refreshTitles() {
  try {
    const idx = await sessionIndex();
    let changed = idx.size !== titleCache.size;
    if (!changed) {
      for (const [k, v] of idx) {
        const p = titleCache.get(k);
        if (!p || p.title !== v.title) { changed = true; break; }
      }
    }
    titleCache = idx;
    if (changed && sessions.size) broadcast();
  } catch { /* the board still works without titles */ }
}
refreshTitles().then(refreshTurns);
setInterval(refreshTitles, 5_000).unref?.();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[agent-dashboard] port ${PORT} is already in use.`);
    process.exit(1);
  }
  console.error('[agent-dashboard]', err);
});

server.listen(PORT, HOST, () => {
  console.log(`[agent-dashboard] http://${HOST}:${PORT}`);
});
