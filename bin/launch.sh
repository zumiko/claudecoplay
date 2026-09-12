#!/bin/sh
# Open a coplay game in a tmux pane beside the current Claude session.
#
# Invoked from a slash command's `!` prefix, which means two things matter a
# lot:
#   1. This script must ALWAYS exit 0. A non-zero exit from a `!` prefix makes
#      Claude Code silently abort the whole turn, so the user would see nothing
#      at all instead of an error message. Every failure path here prints a
#      human-readable explanation and exits 0.
#   2. Its output is the only feedback the user gets, so it has to read well.
#
# Usage: launch.sh <game-name>

set -u

GAME="${1:-snake}"

# The game name is interpolated into a path, so keep it to a plain identifier.
case "$GAME" in
  '' | *[!A-Za-z0-9_-]*)
    echo "coplay: invalid game name '$GAME'."
    exit 0
    ;;
esac

# Resolve the plugin root from this script's own location rather than trusting
# an environment variable, so it works via the slash command, by hand, or from
# a checkout in any directory.
BIN_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || BIN_DIR=""
if [ -z "$BIN_DIR" ]; then
  echo "coplay: could not resolve its own install directory."
  exit 0
fi
ROOT=$(dirname -- "$BIN_DIR")

say() {
  echo "$@"
  exit 0
}

# Single-quote a string for safe inclusion in the shell command we hand to
# tmux. tmux takes one command string, so the paths inside it get re-parsed by
# a shell and need real quoting.
shquote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

GAME_JS="$ROOT/games/$GAME.js"
if [ ! -f "$GAME_JS" ]; then
  available=$(ls "$ROOT/games" 2>/dev/null | sed 's/\.js$//' | tr '\n' ' ')
  say "coplay: no game called '$GAME'. Available: $available"
fi

if ! command -v node >/dev/null 2>&1; then
  say "coplay needs Node.js (16+) on PATH, but 'node' was not found."
fi

if ! command -v tmux >/dev/null 2>&1; then
  say "coplay needs tmux to open a game pane, but tmux is not installed.

  macOS:          brew install tmux
  Debian/Ubuntu:  sudo apt install tmux

Then run this to reopen Claude inside tmux, carrying on from where you are:

    tmux new -s coplay 'claude --continue'

and type /$GAME again."
fi

if [ -z "${TMUX:-}" ]; then
  # 'claude --continue' resumes this same conversation, so moving into tmux
  # costs nothing -- you pick up exactly where you left off.
  say "coplay needs Claude to be running inside tmux so it has a pane to split
into, and this session is not.

Copy this, quit Claude here, and run it. It reopens this same conversation
inside tmux, so you lose nothing:

    tmux new -s coplay 'claude --continue'

Then type /$GAME. (Already have a tmux session? 'tmux attach -t coplay'.)"
fi

SID="${CLAUDE_CODE_SESSION_ID:-unknown}"
STATE_DIR="$HOME/.claude-coplay/sessions"
STATE_FILE="$STATE_DIR/$SID.state"
PANE_REF="$STATE_DIR/$SID.$GAME.pane"

if ! mkdir -p "$STATE_DIR" 2>/dev/null; then
  say "coplay: could not create $STATE_DIR."
fi

# Housekeeping: SessionEnd removes these on a clean exit, but a non-interactive
# `claude -p` run or a hard kill can leave one behind. A live session rewrites
# its state file on every prompt and tool call, so anything untouched for a week
# belongs to a session that is long gone.
find "$STATE_DIR" -maxdepth 1 -type f -mtime +7 \( -name '*.state' -o -name '*.pane' \) -delete 2>/dev/null

# The hooks normally create this, but /<game> may be the very first thing that
# happens in a session, and a missing file reads as PAUSED.
[ -f "$STATE_FILE" ] || echo WORKING > "$STATE_FILE"

# One game at a time per session. Re-running the game that is already up just
# focuses it; switching to a different game closes the old one first. Two game
# panes would otherwise both grab the keyboard on every WORKING/PAUSED change,
# and whichever tmux call landed last would win -- so the new game could look
# dead while the old one silently took your keystrokes.
alive() {
  [ -n "$1" ] && tmux list-panes -a -F '#{pane_id}' 2>/dev/null | grep -qx -- "$1"
}

CLOSED=""
for ref in "$STATE_DIR/$SID."*.pane; do
  [ -f "$ref" ] || continue
  existing=$(cat "$ref" 2>/dev/null || echo "")

  if [ "$ref" = "$PANE_REF" ]; then
    if alive "$existing"; then
      tmux select-pane -t "$existing" >/dev/null 2>&1
      say "coplay: $GAME is already running in pane $existing - focused it."
    fi
    rm -f "$ref"
    continue
  fi

  if alive "$existing"; then
    tmux kill-pane -t "$existing" >/dev/null 2>&1
    was=$(basename "$ref" .pane)
    was=${was#"$SID."}
    CLOSED="$CLOSED $was"
  fi
  rm -f "$ref"
done

# Keep the pane open if node dies, otherwise the error scrolls away instantly
# and the pane vanishes before it can be read.
# The id of Claude's own pane. The game needs it so it can hand the keyboard
# back when Claude wants input. Safe to read now: split-window -d has not run
# yet, and this script runs inside Claude's pane.
here=$(tmux display-message -p '#{pane_id}' 2>/dev/null || echo "")

CMD="node $(shquote "$GAME_JS") $(shquote "$STATE_FILE") $(shquote "$PANE_REF") $(shquote "$here")"
CMD="$CMD || { printf '\\ncoplay exited with an error. Press Enter to close.'; read _ignored; }"

# -d keeps focus in Claude's pane; -P -F makes tmux print the new pane id so we
# can track it.
try_split() {
  tmux split-window -h -d "$@" -P -F '#{pane_id}' "$CMD" 2>&1
}

# A successful split prints a pane id like "%7"; anything else is an error
# message. Testing the output rather than $? matters here, because $? after an
# if-block refers to the last command *inside* it, not to tmux.
is_pane() {
  case "$1" in
    %[0-9]*) return 0 ;;
    *) return 1 ;;
  esac
}

# Percentage sizing with -l needs tmux 3.1+; -p is the older spelling; a bare
# split (even halves) is the last resort.
pane=$(try_split -l 40%)
is_pane "$pane" || pane=$(try_split -p 40)
is_pane "$pane" || pane=$(try_split)
is_pane "$pane" || say "coplay: tmux could not open a pane: $pane"

echo "$pane" > "$PANE_REF"

# Label both panes and turn on the border titles, so it is always obvious which
# pane is which and which one currently has focus. Note that setting a title
# with select-pane also FOCUSES that pane, so remember where we were and set
# this pane's title last -- that restores focus as a side effect. Without this,
# typing /snake would yank the cursor out of Claude's pane.
upper=$(printf '%s' "$GAME" | tr 'a-z' 'A-Z')
tmux select-pane -t "$pane" -T " $upper " >/dev/null 2>&1
if [ -n "$here" ]; then
  tmux select-pane -t "$here" -T ' CLAUDE ' >/dev/null 2>&1
fi
# Window-scoped, so it only affects the window you played in.
tmux set-option -w pane-border-status top >/dev/null 2>&1

if [ -n "$CLOSED" ]; then
  echo "coplay: closed$CLOSED (one game at a time)."
fi
say "coplay: $GAME is running in tmux pane $pane. It freezes by itself
whenever Claude needs you, and resumes when Claude gets back to work.
Focus follows the work automatically: the game takes the keyboard while Claude
works, and hands it back the moment Claude needs you. Press "f" in the game to
turn that off, or Ctrl-b then arrows to move between panes yourself."
