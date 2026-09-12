# Design notes — Claude Co-Play, slash-command edition

Status: **built and verified.** This file is the record of *why* it is shaped the
way it is, and where the implementation diverged from the original plan. For
install and usage instructions see `README.md`.

## The problem this edition solves

The original `claude-coplay` (still intact at `~/claude-coplay`) is a *wrapper*:
`claude-coplay "task"` creates a temp state file, writes a `settings.json` with
the pause/resume hooks, launches `claude --settings <that file>`, and splits a
tmux window itself.

That trick depends on injecting hooks **at launch**. If Claude is already
running, you cannot retroactively add `--settings` hooks — so an in-session
`/snake` requires the hooks to **already be active**. The original plan was to
move them into `~/.claude/settings.json` and merge/unmerge them there.

## What changed: plugin instead of global settings

**We ship as a Claude Code plugin instead.** A plugin bundles `hooks/hooks.json`
and `commands/*.md`, so the hooks are always-on for every session **without ever
touching `~/.claude/settings.json`**. That removes the riskiest part of the
original plan (non-destructively merging and later un-merging entries in a
shared user-owned file) and makes uninstall `rm -rf ~/.claude/skills/coplay`.

Install is a directory copy, because `~/.claude/skills/<name>/` auto-loads as
`<name>@skills-dir`. So there is no installer script at all.

## The open research question: resolved

> *Is the current session id reachable from the slash-command `!` bash context?*

**Yes.** Verified live: `CLAUDE_CODE_SESSION_ID` is exported into
- the **hook** environment (and matches the `session_id` in the hook's stdin
  JSON), and
- the **slash command's `!` bash** environment.

So the "robust" per-session path turned out to cost nothing, and the fallback
single-fixed-file design was never needed. The state file is
`~/.claude-coplay/sessions/$CLAUDE_CODE_SESSION_ID.state`, the hooks stay
one-line `echo`s (no stdin JSON parsing, no helper interpreter), and concurrent
Claude sessions cannot stomp on each other.

`CLAUDE_PID` is exported to both contexts too, if a future version wants
liveness checks.

## Plugin API findings (claude v2.1.269)

These cost real time to pin down. Trust the empirical results over the docs.

1. **Hook events must be nested under a top-level `"hooks"` key.** The flat
   format (event names as top-level keys) is rejected with a Settings Error.
   This was already known from the wrapper version and still holds for
   `hooks/hooks.json`.
2. **Plugin `commands/*.md` files are inventoried as _skills_**
   (`claude plugin details` reports them under "Skills"), and `commands/` is
   documented as a legacy layout. Despite that, the **`!` bash prefix still
   executes deterministically** from a plugin command — it does not depend on
   the model choosing to act.
3. **`${CLAUDE_PLUGIN_ROOT}` in a command's `!` bash is a template
   substitution, not an environment variable.** Only the **braced** form works;
   bare `$CLAUDE_PLUGIN_ROOT` expands to empty there. (Inside *hooks* it is a
   genuine env var and either form works.) `bin/launch.sh` therefore also
   derives its own root from `$0` and never relies on the variable.
4. **A `!` command that exits non-zero silently aborts the entire turn** — the
   user sees no output whatsoever, not even an error. This is the single most
   confusing failure mode in the whole system, and the reason `bin/launch.sh`
   and `bin/status.sh` **always exit 0** and print their own diagnostics. It
   also means a `!` command blocked by permissions looks identical to one that
   never ran.
5. **`SessionStart` and `SessionEnd` both fire**, which is what makes clean pane
   shutdown possible (see below).
6. `disable-model-invocation: true` keeps Claude from launching games on its own
   initiative; only the user typing the command can.

## Design decisions worth keeping

- **State file contract stays one word.** `WORKING` or `PAUSED`, nothing else.
  The reader tolerates trailing whitespace and ignores any extra
  whitespace-separated fields, so the format can be extended later without
  breaking old games. It is also still compatible with the wrapper edition's
  state files.
- **`SessionEnd` deletes the state file**, and the game treats "file gone for
  >1.5s" as "session over, close the pane". That is why panes never linger.
  A crash that skips `SessionEnd` leaves a stale `WORKING` file and the game
  keeps playing — acceptable, and the pane is one `q` away from closing.
- **Restart fires on the `PAUSED → WORKING` edge**, not on "state is WORKING".
  Restarting on the level would instantly restart in the same breath as the
  crash, because you die while Claude is still working.
- **One game at a time per session**, tracked via `<session>.<game>.pane` files
  holding tmux pane ids (the game deletes its own on exit). Re-running the
  current game just focuses its pane; launching a different one kills the old
  pane first. This is not merely tidiness: two game panes both act on the same
  WORKING/PAUSED edge, so both call `tmux select-pane` and whichever lands
  last wins. In practice the older game stole the keyboard and the newly
  launched one looked dead. Enforcing a single pane removes the ambiguity
  rather than trying to arbitrate it.
- **Resizes are adopted by the next board, never mid-game**, so a resize cannot
  scramble a run in progress. If the pane shrinks below what the current board
  needs, the game freezes behind a notice instead of letting the frame scroll
  off the top of the pane; enlarging the pane resumes the same run. This was a
  real bug found in testing, not a hypothetical.
- **Nothing stops two games from sharing one state file** (they would freeze
  and resume together, which falls out of the design for free) -- the launcher
  restricts it to one pane purely because of the focus contention above. If
  auto-focus were ever made opt-in, concurrent games could be allowed again.
- **Focus follows the work, driven off the same two state edges.** On
  `PAUSED → WORKING` the game grabs the keyboard; on `WORKING → PAUSED` it
  hands it back to Claude. The game learns its own pane id from tmux's
  `TMUX_PANE` env var and Claude's from a 4th argv passed by `bin/launch.sh`
  (read before `split-window`, while the script is still running in Claude's
  pane). `tmux select-pane` calls are fire-and-forget so a closed pane can
  never disturb the game loop, and `f` toggles the whole behaviour off.
  Because only *edges* trigger it, manually switching panes mid-turn sticks
  until the next transition instead of being fought over.
- **Keypresses while frozen are acknowledged** in the footer rather than
  silently dropped. A paused game that ignores input is indistinguishable
  from a pane that never got the keystroke, which reads as "pane switching
  is broken". This was a real report, not a hypothetical.

## Shared engine

`lib/engine.js` owns terminal setup, pane sizing, state polling, pause/resume,
score recording, and all chrome. Games declare themselves and a board
(`step` / `key` / `rows` / `score` / `dead`); the contract is documented at the
bottom of that file. Snake, Tetris and Asteroids are all implemented against it,
so a fourth game is a single file plus a command file.

2048 was built first and then removed: being turn-based, it was the one game
that gained nothing from the auto-pause mechanic (freezing a turn-based game
costs the player nothing, so the whole feature was invisible there) and it
lacked the continuously-moving feel the rest of the set has. Asteroids replaced
it deliberately: drifting momentum is the most continuous thing on offer, and
it is the most forgiving of interruption, since the player resumes exactly
where they drifted to.

While porting, the original Snake's self-collision check was fixed: it tested
every segment including the tail tip, which moves out of the way on the same
tick, so following your own tail killed you.

## Known limitations

- **Requires tmux, and requires Claude to already be running inside it.** There
  is no in-place pane otherwise. `bin/launch.sh` detects both "tmux missing" and
  "not inside tmux" and prints tailored guidance. The wrapper edition remains
  the zero-setup, works-anywhere alternative; the two coexist.
- **Hooks are global once installed** — they run for every Claude session, not
  just ones where you are playing. They are plain `echo`s, so the cost is a
  couple of bytes and no interpreter startup.
- If the session id changes mid-session, a running game keeps watching the old
  file. Hooks and the launcher read the same variable, so they stay mutually
  consistent; the stale game would simply stop reacting until restarted.

## Environment notes (this machine)

- `claude` v2.1.269 at `~/.local/bin/claude`; node v26.8.2; tmux 3.7c.
- Zero runtime dependencies (`fs`, `os`, `path` only).
- **macOS TCC:** `~/Desktop`, `~/Documents`, `~/Downloads` can be OS-locked to
  the terminal. Keep this project under `~`, not Desktop. There may be a stale,
  locked `~/Desktop/claude-coplay` copy that can be deleted via Finder.
