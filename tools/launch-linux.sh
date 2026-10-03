#!/usr/bin/env bash
# AgentCraft Foreman launcher for Linux (NouStef mini PC).
#
# Starts the Foreman with the hermes backend (characters = NouStef gateway sessions),
# optionally bound to a LAN/Tailscale address so the game can connect from another machine.
#
# Usage:
#   tools/launch-linux.sh                       # local, sim-free hermes backend, loopback only
#   tools/launch-linux.sh --remote 100.x.y.z    # bind the given address (requires AGENTCRAFT_TOKEN)
#   tools/launch-linux.sh --repo /path/to/repo  # register a repo
#   tools/launch-linux.sh --stop                # stop a running Foreman
#
# Env:
#   AGENTCRAFT_HERMES_KEY  (required) the Hermes gateway API server key (API_SERVER_KEY)
#   AGENTCRAFT_TOKEN       shared secret for remote mode
#   AGENTCRAFT_PORT        WebSocket port (default 7878)
set -euo pipefail
cd "$(dirname "$0")/../foreman"

LOG_DIR="${AGENTCRAFT_LOG_DIR:-$HOME/.agentcraft/logs}"
mkdir -p "$LOG_DIR"

if [[ "${1:-}" == "--stop" ]]; then
  for f in ~/.agentcraft/*/foreman.json ~/.agentcraft/foreman.json; do
    [[ -f "$f" ]] || continue
    pid=$(python3 -c "import json;print(json.load(open('$f')).get('pid',0))" 2>/dev/null || echo 0)
    if [[ "$pid" != 0 ]] && kill -0 "$pid" 2>/dev/null; then
      echo "stopping Foreman pid $pid ($f)"
      kill "$pid"
    fi
  done
  exit 0
fi

REMOTE_ADDR=""
EXTRA=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote) REMOTE_ADDR="$2"; shift 2 ;;
    *) EXTRA+=("$1"); shift ;;
  esac
done

if [[ -n "$REMOTE_ADDR" ]]; then
  [[ -n "${AGENTCRAFT_TOKEN:-}" ]] || { echo "remote mode needs AGENTCRAFT_TOKEN set (shared secret for the game client)" >&2; exit 1; }
  EXTRA+=("--host" "$REMOTE_ADDR" "--token" "$AGENTCRAFT_TOKEN")
fi

[[ -n "${AGENTCRAFT_HERMES_KEY:-}" ]] || { echo "AGENTCRAFT_HERMES_KEY is not set (the Hermes gateway API server key)" >&2; exit 1; }

if [[ ! -d node_modules ]]; then
  echo "installing dependencies (first run)..."
  npm install --silent
fi

STAMP=$(date +%Y%m%d-%H%M%S)
echo "starting Foreman (hermes backend) -> $LOG_DIR/foreman-$STAMP.log"
nohup npm run start -- --backend hermes "${EXTRA[@]}" >"$LOG_DIR/foreman-$STAMP.log" 2>&1 &
NPID=$!
sleep 3
if kill -0 "$NPID" 2>/dev/null; then
  echo "Foreman starting (launcher pid $NPID); log: $LOG_DIR/foreman-$STAMP.log"
  grep -m1 "AgentCraft Foreman" "$LOG_DIR/foreman-$STAMP.log" || true
else
  echo "Foreman failed to start:" >&2
  tail -20 "$LOG_DIR/foreman-$STAMP.log" >&2
  exit 1
fi
