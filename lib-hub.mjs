// The board, cut down to what the Agent Hub needs: a claude.ai page that shows
// the same four columns on any device, Paul's phone included.
//
// The page cannot reach this server (it runs inside claude.ai), and this server
// cannot write to the page's database (only the desktop app's own Claude
// sessions have that tool). So something running inside the app copies this
// document into the page's database as `board/current`: a session told to
// "refresh the Agent Hub", or a scheduled task. GET /api/hub serves it, and
// GET /api/hub?save=1 writes it to state/hub-board.json for ArtifactData's
// file_path instead, so the copy is one short read and one write. When the
// fingerprint matches the last copy, nothing that the page shows has changed
// except the clocks, and the write can be skipped.
//
// Keep it small and plain: titles, columns, to-dos and links. No transcripts.

import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const cut = (s, n) => {
  const t = String(s ?? '').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
};

/** A prompt that opens with an app notice ("<system-reminder> …") says nothing useful. */
const asked = (s) => (s.title && !s.title.trimStart().startsWith('<') ? cut(s.title, 160) : '');

function projectOf(s) {
  if (s.project) return s.project;
  const c = s.cwd || '';
  if (!c || /^\/(private\/)?(var\/folders|tmp)\//.test(c) || c.includes('/scratch-workspaces/')) return '';
  return c.split('/').filter(Boolean).pop() || '';
}

/**
 * One row per session on the board, in the board's own order.
 * `at` is when the document is built; Working rows count as active then.
 */
export function hubRows(sessions, titles, at = Date.now()) {
  return sessions.map((s) => {
    const meta = titles.get(s.id) || {};
    const last = Math.max(Number(s.lastSeen) || 0, Number(meta.lastActivityAt) || 0);
    return {
      id: s.localId || s.id,
      // The app's session id; the "Open on Mac" link needs it. Absent for a
      // session the app doesn't know (a terminal run), which then gets no link.
      localId: s.localId || null,
      title: cut(s.title_session || asked(s) || projectOf(s) || 'Untitled session', 120),
      group: s.group,
      blocked: !!s.blocked,
      routine: !!s.routine,
      live: !!s.live,
      lastActiveAt: s.group === 'working' ? at : last || null,
      since: Number(s.stateAt) || last || null,
      todos: (s.todos || []).slice(0, 8).map((t) => cut(t, 400)),
      why: cut(s.why, 200),
      needsAction: cut(s.needsAction, 300),
      statusDetail: cut(s.statusDetail, 240),
      asked: s.group === 'working' ? asked(s) : '',
      // Remote Control's session on claude.ai: claude.ai/code/<bridge> opens it
      // from the phone. Only sessions with Remote Control on have one.
      bridge: meta.bridgeId || null,
    };
  });
}

/** What changes the picture, ignoring the clocks: a refresh can skip when equal. */
export function hubFingerprint(rows) {
  const shape = rows.map(({ lastActiveAt, since, ...r }) => r);
  return createHash('sha1').update(JSON.stringify(shape)).digest('hex').slice(0, 16);
}

export function hubDoc({ sessions, titles, todoHubUrl, at = Date.now() }) {
  const rows = hubRows(sessions, titles, at);
  const counts = {};
  for (const r of rows) counts[r.group] = (counts[r.group] || 0) + 1;
  return {
    v: 1,
    refreshedAt: new Date(at).toISOString(),
    fingerprint: hubFingerprint(rows),
    counts,
    todoHubUrl: todoHubUrl || null,
    sessions: rows,
  };
}

/** Writes the document where ArtifactData's file_path can read it; returns the path. */
export async function saveHubDoc(dir, doc) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'hub-board.json');
  await writeFile(file, JSON.stringify(doc), 'utf8');
  return file;
}
