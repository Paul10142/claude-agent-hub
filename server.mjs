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
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { sessionIndex, sessionDetail } from './lib-sessions.mjs';
import { readTodo } from './lib-todo.mjs';

const HOST = process.env.AGENT_DASH_HOST || '127.0.0.1';
const PORT = Number(process.env.AGENT_DASH_PORT || 7823);
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** session_id -> record */
const sessions = new Map();
/** cliSessionId -> {title, localId, branch} from the desktop app's own store */
let titleCache = new Map();
/** connected SSE clients */
const clients = new Set();

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
// Paul's mental model, not the hook's:
//   needsInput  — the agent has stopped and the ball is in his court. That is
//                 BOTH a permission prompt (Waiting) and a finished turn (Idle).
//                 Treating "Idle" as its own quiet category was the bug: the
//                 app called these "needs input" while the board called them idle.
//   working     — actively running.
//   completed   — the session has ended.
// Only a session that has actually ASKED for something counts as needing Paul.
//
// 'Idle' means the turn ended — which is NOT the same as wanting him. An agent
// that kicked off a CI run and is waiting on it ends its turn and sits Idle for
// many minutes while GitHub works; calling that "needs input" sent Paul to a
// window that had nothing to ask. 'Waiting' is the honest signal: it only fires
// on a permission prompt or a question.
//
// The trade, stated plainly: an agent that genuinely finished and is waiting for
// Paul now sits under Working until it asks him something. False "working" is
// cheaper than false "needs you" — the second one wastes a trip.
function groupOf(state) {
  if (state === 'Waiting') return 'needsInput';
  if (state === 'Ended') return 'completed';
  return 'working';
}

// The board used to show ONLY sessions that had fired a hook since this server
// last started, so a restart emptied it and a quiet window stayed invisible.
// The app's own store is the complete list; live hook events layer on top.
const RECENT_MS = 45 * 60 * 1000;      // still likely an open window
const KEEP_MS   = 24 * 60 * 60 * 1000; // older than this is history, not a board item

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
      // Not emitting events means it is not running. So it is either waiting on
      // Paul or finished; recency is the only evidence available.
      state: Date.now() - last < RECENT_MS ? 'Idle' : 'Ended',
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
      group: groupOf(s.state),
      blocked: s.state === 'Waiting',       // permission prompt: the loud kind
      title_session: meta.title || null,     // the chat-window name from the app
      localId: meta.localId || null,
      branch: s.branch || meta.branch || null,
    };
  });
  for (const st of fromStore()) list.push({ ...st, group: groupOf(st.state), blocked: false });
  const rank = { needsInput: 0, working: 1, completed: 2 };
  list.sort(
    (a, b) =>
      (rank[a.group] ?? 9) - (rank[b.group] ?? 9) ||
      (b.blocked ? 1 : 0) - (a.blocked ? 1 : 0) ||
      (b.live ? 1 : 0) - (a.live ? 1 : 0) ||
      b.lastSeen - a.lastSeen,
  );
  return { serverTime: now(), home: os.homedir(), sessions: list };
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

  sessions.set(id, rec);
  broadcast();

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
refreshTitles();
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
