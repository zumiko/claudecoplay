#!/bin/sh
# Report whether coplay is wired up correctly in this session, plus
# local high scores. Always exits 0 (see the note in bin/launch.sh).

set -u

BIN_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || BIN_DIR=""
ROOT=$(dirname -- "$BIN_DIR")

SID="${CLAUDE_CODE_SESSION_ID:-unknown}"
STATE_DIR="$HOME/.claude-coplay/sessions"
STATE_FILE="$STATE_DIR/$SID.state"

echo "coplay"
echo

echo "Environment"
if command -v node >/dev/null 2>&1; then
  echo "  node    $(node --version)"
else
  echo "  node    MISSING - install Node.js 16+"
fi
if command -v tmux >/dev/null 2>&1; then
  echo "  tmux    $(tmux -V)"
else
  echo "  tmux    MISSING - brew install tmux / sudo apt install tmux"
fi
if [ -n "${TMUX:-}" ]; then
  echo "  pane    inside tmux, ready to split"
else
  echo "  pane    NOT inside tmux - games cannot open a pane from here"
  echo ""
  echo "  To fix it, quit Claude and run this. It reopens this same"
  echo "  conversation inside tmux, so you lose nothing:"
  echo ""
  echo "      tmux new -s coplay 'claude --continue'"
fi

echo
echo "Attention state"
if [ -f "$STATE_FILE" ]; then
  echo "  hooks   active ($(cat "$STATE_FILE" 2>/dev/null))"
  echo "  file    $STATE_FILE"
else
  echo "  hooks   no state file yet for this session."
  echo "          If this persists after a prompt, the plugin's hooks are not"
  echo "          loading - check: claude plugin list"
fi

running=""
for ref in "$STATE_DIR/$SID."*.pane; do
  [ -f "$ref" ] || continue
  game=$(basename "$ref" .pane)
  game=$(echo "$game" | sed "s/^$SID\.//")
  pane=$(cat "$ref" 2>/dev/null || echo "")
  if [ -n "$pane" ] && tmux list-panes -a -F '#{pane_id}' 2>/dev/null | grep -qx -- "$pane"; then
    running="$running $game($pane)"
  fi
done
if [ -n "$running" ]; then
  echo "  panes  $running"
fi

echo
echo "Games"
for f in "$ROOT/games"/*.js; do
  [ -f "$f" ] || continue
  name=$(basename "$f" .js)
  echo "  /$name"
done

echo
echo "High scores"
if command -v node >/dev/null 2>&1; then
  node "$ROOT/lib/print-scores.js" 2>/dev/null || echo "  (none yet)"
else
  echo "  (needs node)"
fi

exit 0
