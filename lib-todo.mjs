// Parses every project's HUMAN_TODO.md into discrete items.
//
// Detail capture rule: everything from an item's own line up to the NEXT item
// or the next heading belongs to that item, regardless of indentation. An
// earlier version only kept indented continuation lines and silently dropped
// just over half the file.

import { readFile, stat } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';

// Read a file as it exists on origin/main, not as it exists in the working
// tree. Other sessions leave these checkouts on feature branches constantly,
// and the board should show the landed truth rather than whatever someone
// happens to have checked out. Falls back to the working copy if git can't
// answer (no network, detached state, file not tracked yet).
function gitShow(repo, rel) {
  return new Promise((resolve) => {
    execFile('git', ['-C', repo, 'show', `origin/main:${rel}`], { maxBuffer: 8e6, timeout: 4000 },
      (err, stdout) => resolve(err ? null : stdout));
  });
}

// Two distinct lists, deliberately not merged:
//   actions   — only Paul can do these (dashboards, secrets, his credentials)
//   decisions — questions he can answer in a sentence to any agent
import os from 'node:os';

const HOME = os.homedir();
const expand = (p) => (p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p);

/**
 * Which lists to read, and what each one is.
 *
 *   action   — things only a human can do (dashboards, secrets, credentials)
 *   decision — questions an agent could act on once answered
 *
 * Paths live in config.json, which is gitignored: this file should carry no
 * personal paths or project names.
 */
function loadConfig() {
  const here = path.dirname(new URL(import.meta.url).pathname);
  for (const name of ['config.json', 'config.example.json']) {
    try {
      const raw = readFileSync(path.join(here, name), 'utf8');
      const cfg = JSON.parse(raw);
      return (cfg.lists || []).map(l => ({
        project: l.project,
        kindOf: l.kind || 'action',
        path: expand(l.path),
      }));
    } catch { /* try the next candidate */ }
  }
  return [];
}

export const TODO_FILES = loadConfig();

const ITEM = /^(\s*)(?:[-*]|\d+\.)\s+\[( |x|X)\]\s+(.*)$/;
const HEADING = /^(#{1,4})\s+(.*)$/;

const cleanHeading = (h) => h.replace(/^[^\p{L}\p{N}]+/u, '').trim();

function stripMd(md) {
  return md
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function summarise(md) {
  let t = stripMd(md);
  const stop = t.search(/(?<=[.?!])\s/);
  if (stop > 28) t = t.slice(0, stop);
  if (t.length > 130) t = t.slice(0, 127).replace(/\s+\S*$/, '') + '…';
  return t.replace(/[\s.:—-]+$/, '');
}

/**
 * Decision or Action?
 *
 * Paul's point: "where should storage archives live" is something he can just
 * answer in a chat, whereas "create this secret in GitHub" is something only he
 * can physically go and do. Both are his, but they cost him very different
 * amounts of effort, so the board labels them.
 *
 * This is a heuristic on wording, not ground truth — it is shown as a label,
 * never used to hide anything.
 */
function classify(text, detail) {
  const t = `${text}\n${detail}`.toLowerCase();
  const doIt = [
    'dashboard', 'settings →', 'settings->', 'console.cloud', 'supabase dashboard',
    'new repository secret', 'gh secret', 'paste', 'toggle', 'create an account',
    'webmaster', 'search console', 'api keys', 'rotate', 'reset the password',
    'sign in', 'log in', 'install', 'vercel →', 'notion →', 'add the integration',
  ];
  const decide = [
    'decide', 'confirm ', 'choose', 'tell me', 'tell an agent', 'say the word',
    'your call', 'worth knowing', 'read ', 'review ', 'approve', 'recommendation',
    'let me know', 'which ', 'whether ',
  ];
  const a = doIt.filter(k => t.includes(k)).length;
  const d = decide.filter(k => t.includes(k)).length;
  if (a > d) return 'action';
  if (d > a) return 'decision';
  return a ? 'action' : 'decision';
}

function parse(content, project, file) {
  const lines = content.split('\n');
  const items = [];
  let h2 = '', h3 = '';
  let cur = null;
  // Prose between a heading and its first checkbox is context for every item
  // under it — the "why this section exists" paragraph. Without it an item can
  // read as a bare instruction with no reason attached.
  let introFrom = 0, intro = '';
  const takeIntro = (upto) => lines.slice(introFrom, upto).join('\n').trim();

  const flush = (endLine) => {
    if (!cur) return;
    const body = lines.slice(cur.line, endLine).join('\n').replace(/\s+$/, '');
    cur.detail = body.replace(/^\n+/, '');
    cur.summary = summarise(cur.text);
    cur.kind = classify(cur.text, cur.detail);
    cur.project = project;
    cur.file = file;
    items.push(cur);
    cur = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = line.match(HEADING);
    if (h) {
      flush(i);
      if (h[1].length <= 2) { h2 = cleanHeading(h[2]); h3 = ''; }
      else h3 = cleanHeading(h[2]);
      introFrom = i + 1; intro = '';
      continue;
    }
    const m = line.match(ITEM);
    if (m) {
      if (!items.some(x => x.section === (h3 ? `${h2} — ${h3}` : h2)) && !cur) intro = takeIntro(i);
      flush(i);
      cur = {
        id: `${project}:L${i}`,
        line: i + 1,
        done: m[2].toLowerCase() === 'x',
        text: m[3].trim(),
        section: h3 ? `${h2} — ${h3}` : h2,
        h2, h3,
        intro,
      };
    }
  }
  flush(lines.length);
  return items;
}

export async function readTodo() {
  const sources = [];
  let items = [];
  let newest = 0;

  for (const src of TODO_FILES) {
    try {
      // Walk up from the file until a .git directory appears; that is the repo.
      let repo = path.dirname(src.path);
      while (repo !== path.dirname(repo) && !existsSync(path.join(repo, '.git'))) repo = path.dirname(repo);
      const rel = src.path.slice(repo.length + 1);
      let content = await gitShow(repo, rel);
      let st;
      if (content == null) { content = await readFile(src.path, 'utf8'); st = await stat(src.path); }
      else { try { st = await stat(src.path); } catch { st = { mtimeMs: Date.now() }; } }
      items = items.concat(parse(content, src.project, src.path).map(i => ({ ...i, list: src.kindOf })));
      newest = Math.max(newest, st.mtimeMs);
      sources.push({ project: src.project, path: src.path, mtime: st.mtimeMs, ok: true });
    } catch (e) {
      sources.push({ project: src.project, path: src.path, ok: false, error: String(e.message || e) });
    }
  }

  return {
    ok: true,
    mtime: newest,
    sources,
    items,
    open: items.filter(i => !i.done && i.list === 'action').length,
    openDecisions: items.filter(i => !i.done && i.list === 'decision').length,
    done: items.filter(i => i.done).length,
  };
}
