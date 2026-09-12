# coplay

An attention layer for Claude Code. While Claude works autonomously, you play a
small ASCII game in a tmux pane beside it. The game **freezes the instant Claude
needs you** — a permission prompt, a clarifying question, or finishing — and
**resumes** the moment Claude starts working again.

```
+-------------------------+  +----------------------------+
|  claude                 |  |  SNAKE  score 7  best 23   |
|                         |  |  +----------------------+  |
|  > add retry logic to   |  |  |        ====>      *  |  |
|    the uploader         |  |  |                      |  |
|                         |  |  +----------------------+  |
|  * Editing upload.ts    |  |  arrows/wasd to steer      |
+-------------------------+  +----------------------------+
```

Games: **`/snake`**, **`/tetris`**, **`/asteroids`**. Status and high scores:
**`/coplay`**.

Focus moves for you: the game takes the keyboard while Claude works and gives
it back when Claude needs an answer.

## Install

Inside Claude Code:

```
/plugin marketplace add zumiko/claudecoplay
/plugin install coplay@coplay
```

Restart Claude Code so the hooks load, then check it:

```sh
claude plugin list      # expect: coplay@coplay ... enabled
```

## Run it

The games need a tmux pane to split into, so **Claude has to be running inside
tmux**. A session that is already running outside tmux can't be moved into one —
but this single command reopens your current conversation inside tmux, so you
lose nothing:

```sh
tmux new -s coplay 'claude --continue'
```

Then type `/snake`, `/tetris` or `/asteroids`.

Starting from scratch, `bin/coplay` does the same thing for a fresh session
(handy on your PATH as `coplay`):

```sh
./bin/coplay                # new session inside tmux
./bin/coplay --continue     # resume your last conversation instead
```

Not sure whether you're set up? `/coplay` reports what's wired up, and prints
the command above if you aren't in tmux.

### Requirements

- **tmux** — `brew install tmux`, or `sudo apt install tmux`
- **Node.js 16+**

No npm dependencies; the games use only `fs`, `os` and `path`.

### Keys

| key | does |
| --- | --- |
| arrows / wasd | play |
| space | hard drop (Tetris), fire (Asteroids) |
| `r` | new game after you die |
| `f` | stop focus following the work |
| `q` | close the game pane |

### Uninstall

```sh
/plugin uninstall coplay
rm -rf ~/.claude-coplay      # only if you also want your high scores gone
```

Nothing is ever written to `~/.claude/settings.json`, so there's nothing to
un-merge.

### Developing on it

```sh
git clone https://github.com/zumiko/claudecoplay
claude --plugin-dir ./coplay      # loads it in place, no install
```

## How it works

Three moving parts, and the contract between them is one word in a file.

**1. Hooks (`hooks/hooks.json`)** — bundled with the plugin, so they are active
in every session without touching your global settings. They write a single word
to a per-session state file:

| Hook event         | Writes    |
| ------------------ | --------- |
| `SessionStart`     | `WORKING` |
| `UserPromptSubmit` | `WORKING` |
| `PreToolUse`       | `WORKING` |
| `PostToolUse`      | `WORKING` |
| `Notification`     | `PAUSED`  |
| `Stop`             | `PAUSED`  |
| `SessionEnd`       | deletes the file |

Each is a plain `echo` — no interpreter starts up, so the cost per hook is
negligible.

**2. The slash commands (`commands/*.md`)** — each one runs `bin/launch.sh` via
the `!` prefix, which executes **deterministically** at invocation rather than
depending on the model deciding to act. `launch.sh` checks the environment and
then:

```sh
tmux split-window -h -d -l 40% "node games/snake.js <state-file> <pane-ref>"
```

`-d` returns immediately and hands the process to tmux, so the game outlives the
slash-command invocation and keeps focus in Claude's pane.

**3. The games (`games/*.js`)** — poll the state file every tick. Anything other
than `WORKING` means freeze.

### Per-session isolation

The state file is keyed by session id:

```
~/.claude-coplay/sessions/<CLAUDE_CODE_SESSION_ID>.state
```

Claude Code exports `CLAUDE_CODE_SESSION_ID` into both the hook environment and
the slash command's `!` bash environment, and it matches the `session_id` in the
hook's stdin JSON. So **concurrent Claude sessions never stomp on each other**,
and it costs no JSON parsing — the hooks stay one-line `echo`s.

### Lifecycle

- **Focus follows the work.** Submit a prompt and the keyboard moves to the
  game pane; the moment Claude needs you it moves back to Claude's pane. So
  you type, play, answer, play, without touching `Ctrl-b`. Press `f` in the
  game to turn this off (the header then shows `autofocus off`).
- **Death → restart.** Press `r`, or just send Claude a new prompt: the game
  restarts on the `PAUSED → WORKING` edge.
- **Session ends → pane closes.** `SessionEnd` deletes the state file; the game
  sees it vanish and exits, so panes never linger.
- **One game at a time.** Re-running the game that is already up just focuses
  its pane; starting a different one (`/tetris` while Snake is open) closes the
  old pane first, so there is never any doubt about which game has the
  keyboard.
- **Resizing** never disturbs a run in progress. The board keeps its size; if
  the pane gets too small the game freezes behind a notice until you enlarge it
  again, or press `r` to restart at the new size.

## Adding a game

`lib/engine.js` owns terminal setup, pane sizing, state polling, pause/resume,
score recording and all the chrome. A game only describes itself and its board:

```js
engine.run({
  id: 'pong', title: 'PONG', tickMs: 60,
  controls: 'arrows to move',
  minCols: 20, minRows: 10,
  dims: (availW, availH) => ({ w: ..., h: ... }),
  create: (w, h) => ({ score, dead, step(), key(k), rows(), status() }),
});
```

Drop it in `games/`, add a matching `commands/pong.md`, and `/coplay` picks it up
automatically. The full contract is documented at the bottom of
`lib/engine.js`.

High scores live in `~/.claude-coplay/scores.json` via `lib/scores.js`, which is
the single seam to replace for a future remote leaderboard.

## Notes on the Claude Code plugin API

Findings verified live against **claude v2.1.269** while building this. They are
easy to get wrong, so they are recorded here:

- Hook events **must** be nested under a top-level `"hooks"` key. The flat
  format (event names as top-level keys) is rejected with a Settings Error.
- Plugin `commands/*.md` files are inventoried as **skills**, but the `!` bash
  prefix still executes deterministically.
- In a command's `!` bash, `${CLAUDE_PLUGIN_ROOT}` is **template-substituted by
  Claude Code** and only works in the **braced** form — bare
  `$CLAUDE_PLUGIN_ROOT` is empty there. (In *hooks*, it is a real environment
  variable and either form works.)
- If a `!` command exits non-zero **the whole turn is silently aborted** and the
  user sees nothing. This is why `bin/launch.sh` always exits 0 and prints its
  own errors.
- `disable-model-invocation: true` keeps Claude from launching games at its own
  discretion; only you can, by typing the command.

## Relationship to the wrapper version

The original `claude-coplay` is a *launcher*: it wraps Claude
(`claude-coplay "task"`), injects the hooks with `--settings`, and creates the
tmux session itself. That works anywhere with zero setup but cannot be triggered
from inside a session that is already running.

This edition trades the wrapper for always-on plugin hooks, which is what makes
an in-session `/snake` possible. The two can coexist.
