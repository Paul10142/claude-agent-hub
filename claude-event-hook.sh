#!/bin/bash
set -u
STATE="${1:-Working}"
HOST="${AGENT_DASH_HOST:-127.0.0.1}"
PORT="${AGENT_DASH_PORT:-7823}"
HOOK_JSON=$(cat)

find_agent_pid() {
  local pid=$PPID
  local max=6
  while [ "$max" -gt 0 ] && [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
    local name
    name=$(ps -o comm= -p "$pid" 2>/dev/null)
    case "$name" in
      *claude*|*Claude*) echo "$pid"; return 0 ;;
    esac
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    max=$((max - 1))
  done
  return 1
}

AGENT_PID="$(find_agent_pid 2>/dev/null || true)"

payload=$(
  STATE="$STATE" HOOK_JSON="$HOOK_JSON" TERM_PROGRAM="${TERM_PROGRAM:-}" AGENT_PID="${AGENT_PID:-}" /usr/bin/python3 - <<'PY' 2>/dev/null
import json, os, sys
try:
    d = json.loads(os.environ.get("HOOK_JSON") or "{}")
except Exception:
    d = {}

state = os.environ.get("STATE") or "Working"
ask = ""
if state == "Auto":
    state = "Working"
elif state == "ToolFail":
    state = "Idle" if d.get("is_interrupt") is True else "Working"
elif state == "Waiting":
    msg = d.get("message") or ""
    state = "Waiting" if "permission" in msg.lower() else "Idle"
    ask = msg

session_id = d.get("session_id") or "default"
cwd = d.get("cwd") or ""
title = ""
if d.get("hook_event_name") == "UserPromptSubmit":
    prompt = d.get("prompt")
    if isinstance(prompt, str) and prompt.strip():
        title = prompt.strip()[:120]
term_map = {
    "iTerm.app": "iTerm",
    "Apple_Terminal": "Terminal",
    "vscode": "VS Code",
    "WarpTerminal": "Warp",
    "ghostty": "Ghostty",
    "Hyper": "Hyper",
    "WezTerm": "WezTerm",
    "kitty": "kitty",
    "tabby": "Tabby",
    "alacritty": "Alacritty",
}
raw_term = os.environ.get("TERM_PROGRAM") or ""
try:
    pid = int(os.environ.get("AGENT_PID") or 0) or None
except Exception:
    pid = None
sys.stdout.write(json.dumps({
    "state": state,
    "agent": "Claude",
    "event": d.get("hook_event_name") or "",
    "session_id": session_id,
    "cwd": cwd,
    "title": title,
    "terminal": term_map.get(raw_term, raw_term),
    "pid": pid,
    "ask": ask,
}))
PY
)

if [ -z "${payload:-}" ]; then
  payload="{\"state\":\"${STATE}\",\"agent\":\"Claude\"}"
fi

if [ "$STATE" = "Ended" ]; then
  curl -s -m 2 -X POST "http://${HOST}:${PORT}/event"     -H 'Content-Type: application/json'     --data-raw "$payload" >/dev/null 2>&1
else
  curl -s -m 1 -X POST "http://${HOST}:${PORT}/event"     -H 'Content-Type: application/json'     --data-raw "$payload" >/dev/null 2>&1 &
fi

exit 0