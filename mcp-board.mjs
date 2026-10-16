#!/usr/bin/env node
// A local MCP server that lets the Agent Hub page read this board live.
//
// A claude.ai page can't reach 127.0.0.1, but the Claude desktop app can lend
// a page a local MCP server (the page declares it as "host:agent-board"). The
// app starts this file over stdio; its one tool, `board`, returns the same
// document as GET /api/hub. Read-only: it changes nothing, on the Mac or in
// the app. Zero dependencies, like the server.
//
// Add to ~/Library/Application Support/Claude/claude_desktop_config.json:
//   "mcpServers": { "agent-board": { "command": "/usr/local/bin/node",
//                                    "args": ["<this folder>/mcp-board.mjs"] } }
// then restart the Claude app.

import http from 'node:http';
import readline from 'node:readline';

const PORT = Number(process.env.AGENT_DASH_PORT || 7823);
const VERSION = '1.0.0';

const TOOLS = [{
  name: 'board',
  title: 'Agent board',
  description: "Every Claude Code session on this Mac from the last 24 hours that isn't archived, in the "
    + "Agent Dashboard's columns (Needs Input, Ready for You, Working, Background, Completed), as JSON.",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}];

function fetchBoard() {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/hub', timeout: 5000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => (res.statusCode === 200 ? resolve(body) : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'agent-board', version: VERSION },
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS });
    case 'tools/call': {
      if (params?.name !== 'board') return fail(id, -32602, `Unknown tool: ${params?.name}`);
      try {
        return reply(id, { content: [{ type: 'text', text: await fetchBoard() }] });
      } catch (e) {
        // A tool-level failure, so the page can say what is wrong instead of a blank board.
        return reply(id, {
          isError: true,
          content: [{ type: 'text', text: `The Agent Dashboard isn't answering on this Mac (${e.message}). Start it with: agents start` }],
        });
      }
    }
    default:
      if (isRequest) return fail(id, -32601, `Method not found: ${method}`);
      return undefined; // notifications (initialized, cancelled) need no answer
  }
}

const pending = new Set();
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'Parse error'); }
  const p = handle(msg).catch((e) => fail(msg?.id ?? null, -32603, String(e?.message || e)));
  pending.add(p);
  p.finally(() => pending.delete(p));
});
// The app closed the pipe: answer what is in flight, then go.
rl.on('close', () => Promise.allSettled([...pending]).then(() => process.exit(0)));
