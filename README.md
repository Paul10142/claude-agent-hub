# Agent Dashboard

A live board of every [Claude Code](https://claude.com/claude-code) session running on your Mac — what each one is doing, which one is blocked waiting on you, and the human to-do lists they've written for you.

It runs locally, needs no API key, costs no tokens, and has zero dependencies.


## Why

If you run one coding agent, you don't need this. If you run five, you have five terminal windows, five different clocks, and no idea which one is stuck asking you a question while the others quietly finish.

This gives you one page that answers three things at a glance:

- **What is each agent doing right now?**
- **Which one is blocked on me?**
- **What has it written down that only I can do?**

## How it works

Claude Code fires [hooks](https://code.claude.com/docs/en/hooks) on every prompt, tool call, permission request and session end. A small shell script posts each one to a local server, which pushes to your browser over Server-Sent Events.

```
Claude Code hooks ──POST──▶ server.mjs ──SSE──▶ your browser
```

No polling, no API calls, no tokens. The board updates the instant something happens.

It also reads Claude's own session store for the real chat-window titles, and each session's transcript for what the agent last said and its current to-do list.

## Install

Requires Node 18+ and macOS.

```bash
git clone https://github.com/YOURNAME/agent-dashboard.git ~/.claude/agent-dashboard
cd ~/.claude/agent-dashboard
cp config.example.json config.json      # then edit it — see below
```

Wire the hooks into `~/.claude/settings.json`. Each of the eight events calls the same script with a different state:

```json
{
  "hooks": {
    "PreToolUse":        [{ "hooks": [{ "type": "command", "command": "sh -c '\"$0\" \"$1\" >/dev/null 2>&1 || true' '~/.claude/hooks/claude-event-hook.sh' Working" }] }],
    "PostToolUse":       [{ "hooks": [{ "type": "command", "command": "sh -c '\"$0\" \"$1\" >/dev/null 2>&1 || true' '~/.claude/hooks/claude-event-hook.sh' Auto" }] }],
    "UserPromptSubmit":  [{ "hooks": [{ "type": "command", "command": "sh -c '\"$0\" \"$1\" >/dev/null 2>&1 || true' '~/.claude/hooks/claude-event-hook.sh' Working" }] }],
    "Notification":      [{ "hooks": [{ "type": "command", "command": "sh -c '\"$0\" \"$1\" >/dev/null 2>&1 || true' '~/.claude/hooks/claude-event-hook.sh' Waiting" }] }],
    "Stop":              [{ "hooks": [{ "type": "command", "command": "sh -c '\"$0\" \"$1\" >/dev/null 2>&1 || true' '~/.claude/hooks/claude-event-hook.sh' Idle" }] }],
    "SessionStart":      [{ "hooks": [{ "type": "command", "command": "sh -c '\"$0\" \"$1\" >/dev/null 2>&1 || true' '~/.claude/hooks/claude-event-hook.sh' Idle" }] }],
    "SessionEnd":        [{ "hooks": [{ "type": "command", "command": "sh -c '\"$0\" \"$1\" >/dev/null 2>&1 || true' '~/.claude/hooks/claude-event-hook.sh' Ended" }] }]
  }
}
```

> **The `sh -c '... || true'` wrapper is not optional.** A `PreToolUse` hook that exits non-zero blocks the tool — so if the script ever fails to parse, *every tool call in every session* fails, including the ones you'd need to fix it. Ask me how I know. The wrapper means a broken hook costs you the dashboard and nothing else.

Then start it:

```bash
node server.mjs        # http://127.0.0.1:7823
```

To run it at login, see `agent-dashboard.plist.example` — set `RunAtLoad` true and `KeepAlive` **false**, so that stopping it actually stops it.

## Configure

`config.json` (gitignored) tells it which to-do files to read:

```json
{
  "port": 7823,
  "lists": [
    { "project": "My Project", "kind": "action",   "path": "~/code/my-project/docs/HUMAN_TODO.md" },
    { "project": "My Project", "kind": "decision", "path": "~/code/my-project/docs/DECISIONS.md" }
  ]
}
```

Two kinds, deliberately separate:

- **`action`** — things only a human can do. Dashboards, secrets, account settings.
- **`decision`** — questions an agent could act on the moment you answer.

Mixing them is the mistake this exists to fix. A list of 60 "your to-dos" that is really 45 unanswered questions is a list nobody reads.

Any Markdown file works. It parses `- [ ]` and `1. [ ]`, groups consecutive items under a heading into one multi-step task, and reads each file from `origin/main` rather than your working tree, so a colleague's feature branch can't change what your board says.

## The tabs

| Tab | Shows |
| --- | --- |
| **Agents** | Live sessions in four columns: needs input, ready for you, working, background. Click one for what you asked, what it last said, its to-do list and recent actions. |
| **Manual** | Things only you can do, numbered, grouped into tasks. |
| **Decisions** | Questions you can answer in a sentence. |

How the Agents tab groups sessions, in four columns across the top:

| Column | When |
| --- | --- |
| **Needs Input** | The agent asked: a permission prompt or a question. |
| **Ready for You** | The turn is over and nothing it started will wake it up again: a report to read, a decision, or a stalled agent. |
| **Working** | Mid-turn. |
| **Background** | The turn is over, but something it started will wake it: a background command, helper agent or monitor still running, an open PR whose CI the app is watching, a scheduled check-in, or a session it started. The row says which. |

Each column shows five agents and scrolls; "Show All" expands it. Click one and its detail fills the bottom half of the page, with an **Open in Claude** button that brings that session forward in the app. Routines (sessions started by a scheduled task) are hidden until you click "Show Routines".

A reply that ends with `Everything has been saved. You can archive this thread.` always counts as Ready for You. That's the closing line this setup's `CLAUDE.md` requires; change `isArchivable()` in `lib-sessions.mjs` to match yours.

Ticking items builds a copy-pasteable hand-off note — the page can't edit your files, so it writes the message for an agent to do it.

## Deliberate limitations

- **It cannot send messages to an agent.** Claude Code opens no local port and each session is an isolated process, so a local page has no way in. Better to say so than ship a text box that silently does nothing.
- **State is in memory.** Restarting clears the live board; sessions repopulate on their next event, and the session list is re-read from Claude's own store.
- **macOS only.** It reads `~/Library/Application Support/Claude`.

## License

MIT
