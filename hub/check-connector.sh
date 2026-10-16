#!/bin/sh
# Checks everything the Agent Hub's live board depends on and says, in plain words, what to fix.
# Safe to run any time, with Claude open or closed: it only reads.
#
#   sh ~/.claude/agent-dashboard/hub/check-connector.sh

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="$HERE/mcp-board.mjs"
CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
PORT="${AGENT_DASH_PORT:-7823}"
problems=0
ok()  { echo "OK    $1"; }
bad() { echo "FIX   $1"; echo "      → $2"; problems=$((problems + 1)); }

# 1. The board itself, which the connector reads.
if curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/hub" | grep -q 200; then
  ok "The Agent Dashboard is running."
else
  bad "The Agent Dashboard isn't running, so there is no board to show." "Run: agents start"
fi

# 2. The app's settings list the connector, pointing at files that exist.
entry="$(/usr/bin/python3 - "$CFG" <<'EOF' 2>/dev/null
import json, sys
try:
    e = json.load(open(sys.argv[1])).get("mcpServers", {}).get("agent-board")
except Exception:
    e = None
print("" if not e else e.get("command", "") + "\t" + (e.get("args") or [""])[0])
EOF
)"
if [ -z "$entry" ]; then
  bad "The Claude app's settings don't list the Agent Board connector." \
      "Quit Claude (⌘Q), then in Terminal run: sh $HERE/hub/install-connector.sh"
else
  node="$(printf '%s' "$entry" | cut -f1)"; script="$(printf '%s' "$entry" | cut -f2)"
  if [ ! -x "$node" ]; then
    bad "The connector is set to start with Node at $node, which isn't there any more." \
        "Quit Claude (⌘Q), then in Terminal run: sh $HERE/hub/install-connector.sh"
  elif [ ! -f "$script" ]; then
    bad "The connector file the app is told to start ($script) is missing." \
        "Put the agent-dashboard folder back at $HERE, or rerun the installer with Claude closed."
  else
    ok "The Claude app's settings list the connector."
  fi
fi

# 3. The app actually started it, and is running the current version of the file.
started="$(ps -axo lstart=,command= | grep "[n]ode $SERVER" | head -1 | cut -c1-24)"
if [ -z "$started" ]; then
  if [ "$(osascript -e 'application "Claude" is running' 2>/dev/null)" = "true" ]; then
    bad "Claude is open but hasn't started the connector." "Quit Claude (⌘Q) and open it again."
  else
    ok "Claude is closed; it starts the connector when you open it."
  fi
else
  run_s="$(date -j -f '%a %b %e %T %Y' "$started" +%s 2>/dev/null || echo 0)"
  file_s="$(stat -f %m "$SERVER")"
  if [ "$run_s" -gt 0 ] && [ "$file_s" -gt "$run_s" ]; then
    bad "Claude is running an older copy of the connector (the file changed after Claude opened)." \
        "Quit Claude (⌘Q) and open it again."
  else
    ok "Claude is running the connector (since $started)."
  fi
fi

# 4. The connector answers, the same way the app talks to it.
answer="$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"0"}}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | /usr/bin/env node "$SERVER" 2>/dev/null)"
if printf '%s' "$answer" | grep -q '"open_session"' && printf '%s' "$answer" | grep -q '"board"'; then
  ok "The connector answers, with both of its tools (board, open_session)."
else
  bad "The connector doesn't answer properly when started." "Ask a Claude session to look at $SERVER."
fi

echo
if [ "$problems" -eq 0 ]; then
  echo "All good. If the page still isn't live, open it from the Pinned list in the Claude app (not a browser) and tap Refresh."
else
  echo "$problems thing(s) to fix, above."
fi
