#!/bin/sh
# Adds the Agent Board connector (mcp-board.mjs) to the Claude desktop app, then reopens the app.
#
# Run it from Terminal with the Claude app closed (⌘Q). While the app runs it keeps its settings in
# memory and saves them back over claude_desktop_config.json, so an entry added then is lost the
# next time any setting changes (this happened on 2026-10-16).
#
#   sh ~/.claude/agent-dashboard/hub/install-connector.sh
#
# Undo: delete the "agent-board" entry from that file with the app closed, or restore the backup
# this writes next to it.
set -eu

CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
SERVER="$(cd "$(dirname "$0")/.." && pwd)/mcp-board.mjs"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || NODE=/usr/local/bin/node

claude_open() {
  [ "$(osascript -e 'application "Claude" is running' 2>/dev/null)" = "true" ] && return 0
  ps -axo comm= | grep -qx '/Applications/Claude.app/Contents/MacOS/Claude'
}
if claude_open; then
  echo "The Claude app is still open. Quit it (⌘Q), then run this again."
  exit 1
fi
[ -f "$CFG" ] || { echo "Can't find the Claude app's settings file: $CFG"; exit 1; }
[ -f "$SERVER" ] || { echo "Can't find the connector: $SERVER"; exit 1; }
[ -x "$NODE" ] || { echo "Can't find Node at $NODE"; exit 1; }

cp -p "$CFG" "$CFG.before-agent-board-$(date +%Y%m%d-%H%M%S)"

/usr/bin/python3 - "$CFG" "$NODE" "$SERVER" <<'EOF'
import json, os, sys, tempfile
cfg, node, server = sys.argv[1:4]
with open(cfg) as f:
    d = json.load(f)
want = {"command": node, "args": [server]}
servers = d.setdefault("mcpServers", {})
if servers.get("agent-board") == want:
    print("The Agent Board connector was already there.")
    sys.exit(0)
servers["agent-board"] = want
# Write a checked copy beside the file, then swap it in, so a failure leaves the original untouched.
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(cfg), prefix=".claude_desktop_config.")
with os.fdopen(fd, "w") as f:
    json.dump(d, f, indent=2)
with open(tmp) as f:
    check = json.load(f)
assert check["mcpServers"]["agent-board"] == want
assert {k: v for k, v in check.items() if k != "mcpServers"} == {k: v for k, v in d.items() if k != "mcpServers"}
os.chmod(tmp, 0o600)
os.replace(tmp, cfg)
print("Added the Agent Board connector.")
EOF

open -a Claude
echo "Claude is reopening. Open Agent Hub from your Pinned list and tap Refresh."
