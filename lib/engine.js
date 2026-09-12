'use strict';

// Shared harness for every coplay game.
//
// It owns everything that is NOT game logic: terminal setup, sizing the board
// to the tmux pane, polling the Claude Code state file, freezing/resuming,
// recording scores, drawing the chrome (header / border / footer), and exiting
// cleanly when the Claude session goes away.
//
// A game module only has to describe itself and its board. See GAME CONTRACT
// at the bottom of this file.

const fs = require('fs');
const { spawn } = require('child_process');
const scores = require('./scores.js');

const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);

// How long the state file may stay missing before we assume the Claude session
// ended and close the pane. The SessionEnd hook deletes the file on purpose,
// so this is the normal shutdown path, not just a crash guard.
const GONE_GRACE_MS = 1500;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

class Harness {
  constructor(game, stateFile, paneRefFile, homePane) {
    this.game = game;
    this.stateFile = stateFile;
    this.paneRefFile = paneRefFile || null;
    this.prevState = 'WORKING';
    this.missingSince = 0;
    this.paused = false;
    this.recorded = false;
    this.best = scores.getPersonalBest(game.id);
    this.tooSmall = null;
    this.board = null;
    this.needsFullRedraw = true;
    this.relayoutPending = false;
    this.cramped = false;
    this.pokedAt = 0;

    // Auto-focus. Claude's pane id is passed in by bin/launch.sh; tmux tells
    // us our own via TMUX_PANE. With both we can move the keyboard to follow
    // the work: to the game while Claude is busy, back to Claude when it
    // needs an answer. Disabled if either is unknown (e.g. run by hand).
    this.homePane = homePane || null;
    this.gamePane = process.env.TMUX_PANE || null;
    this.canFocus = !!(this.homePane && this.gamePane);
    this.autoFocus = this.canFocus;
  }

  // Fire and forget: if this fails (pane already closed, tmux gone) the game
  // must carry on regardless, so errors are deliberately swallowed.
  focusPane(target) {
    if (!this.autoFocus || !target) return;
    try {
      const p = spawn('tmux', ['select-pane', '-t', target], { stdio: 'ignore' });
      p.on('error', () => {});
      p.unref();
    } catch (e) { /* ignore */ }
  }

  // ---- layout -----------------------------------------------------------

  // Chrome is 5 rows (header, top border, bottom border, footer, and one spare
  // row so a final newline can never scroll the frame). Horizontally it is 2
  // cols of border plus one spare col, so that a full-width line can never
  // sit exactly at the right edge and trigger the terminal's auto-wrap.
  measure() {
    const cols = process.stdout.columns || 46;
    const rows = process.stdout.rows || 24;
    return { availW: cols - 3, availH: rows - 5 };
  }

  newBoard() {
    const m = this.measure();
    const g = this.game;

    if (m.availW < g.minCols || m.availH < g.minRows) {
      this.tooSmall = m;
      this.board = null;
      this.needsFullRedraw = true;
      return;
    }

    this.tooSmall = null;
    const dims = g.dims(m.availW, m.availH);
    this.w = dims.w;
    this.h = dims.h;
    this.board = g.create(this.w, this.h);
    this.recorded = false;
    this.relayoutPending = false;
    this.needsFullRedraw = true;
  }

  // Does the board currently in play still fit the pane? If the pane shrinks
  // under a game in progress the frame would scroll off the top, so this is
  // detected and a notice is shown instead of a broken frame.
  fitsPane() {
    if (!this.board) return true;
    const cols = process.stdout.columns || 46;
    const rows = process.stdout.rows || 24;
    return this.w + 3 <= cols && this.h + 5 <= rows;
  }

  // ---- state file -------------------------------------------------------

  // Returns 'WORKING', 'PAUSED', or null when the file is gone.
  readState() {
    let raw;
    try {
      raw = fs.readFileSync(this.stateFile, 'utf8');
    } catch (e) {
      return null;
    }
    // Tolerate a trailing newline and any future extra fields on the line.
    const word = raw.trim().split(/\s+/)[0];
    return word === 'WORKING' ? 'WORKING' : 'PAUSED';
  }

  // ---- main loop --------------------------------------------------------

  tick() {
    const state = this.readState();

    if (state === null) {
      const now = Date.now();
      if (!this.missingSince) this.missingSince = now;
      if (now - this.missingSince > GONE_GRACE_MS) {
        this.quit('Claude session ended - closing Co-Play.');
        return;
      }
    } else {
      this.missingSince = 0;
    }

    this.paused = state !== 'WORKING';

    const cramped = !this.fitsPane();
    if (cramped !== this.cramped) this.needsFullRedraw = true;
    this.cramped = cramped;

    // Dead + Claude just started a fresh work cycle => new game. Firing on the
    // PAUSED->WORKING *edge* (rather than merely "state is WORKING") avoids
    // instantly restarting in the same breath as the crash, which happens
    // while Claude is still WORKING.
    const effective = state === null ? 'PAUSED' : state;
    const resumedEdge = this.prevState !== 'WORKING' && effective === 'WORKING';
    const pausedEdge = this.prevState === 'WORKING' && effective !== 'WORKING';
    if (resumedEdge && (this.relayoutPending || !this.board || this.board.dead)) {
      this.newBoard();
    }
    if (resumedEdge) this.focusPane(this.gamePane);
    if (pausedEdge) this.focusPane(this.homePane);
    this.prevState = effective;

    if (this.board && !this.paused && !this.cramped && !this.board.dead) {
      this.board.step();
    }

    if (this.board && this.board.dead && !this.recorded) {
      // Zero-score games are noise in the leaderboard; skip them.
      if (this.board.score > 0) {
        scores.addScore(this.game.id, this.board.score);
        this.best = scores.getPersonalBest(this.game.id);
      }
      this.recorded = true;
    }

    this.render();
  }

  // ---- rendering --------------------------------------------------------

  render() {
    const out = [];
    if (this.needsFullRedraw) {
      out.push(ESC + '[2J');
      this.needsFullRedraw = false;
    }
    out.push(ESC + '[H');

    if (this.tooSmall) {
      const g = this.game;
      this.writeNotice(out, [
        '  ' + g.title + ' needs a bigger pane.',
        '',
        '  Needs at least ' + (g.minCols + 3) + ' cols x ' + (g.minRows + 5) + ' rows.',
        '  This pane gives ' + (this.tooSmall.availW + 3) + ' x ' + (this.tooSmall.availH + 5) + '.',
        '',
        '  Widen it (Ctrl-b then Left/Right, or drag',
        '  the divider), then press "r". "q" to close.',
      ]);
      return;
    }

    if (this.cramped) {
      // The board is kept in memory: enlarging the pane again resumes the
      // same run exactly where it left off.
      this.writeNotice(out, [
        '  ' + this.game.title + ' paused - pane too small.',
        '',
        '  This run needs ' + (this.w + 3) + ' cols x ' + (this.h + 5) + ' rows.',
        '  The pane is now ' + (process.stdout.columns || 0) + ' x ' + (process.stdout.rows || 0) + '.',
        '',
        '  Enlarge the pane to carry on where you left',
        '  off, or press "r" to restart at this size.',
      ]);
      return;
    }

    // The header and footer are chrome that sits OUTSIDE the board, so they
    // may use the full pane width. Clipping them to the board truncated the
    // control hints on the narrower games. ESC[K clears the rest of the line,
    // so nothing needs padding.
    const paneW = Math.max(this.w + 2, (process.stdout.columns || (this.w + 2)) - 1);
    const line = (s) => s.slice(0, paneW) + ESC + '[K';

    // Choose the longest variant that actually fits the pane, so a narrow
    // split loses whole words instead of being chopped mid-word.
    const fit = (options) => {
      for (let i = 0; i < options.length; i++) {
        if (options[i].length <= paneW) return options[i];
      }
      return options[options.length - 1];
    };

    let status = this.board.status ? this.board.status() : '';
    if (this.canFocus && !this.autoFocus) {
      status = status ? status + '  autofocus off' : 'autofocus off';
    }
    const titled = '  ' + this.game.title + (this.paused ? ' [PAUSED]' : '');
    const withBest = titled + '  score ' + this.board.score + '  best ' + this.best;
    out.push(line(fit([
      status ? withBest + '  ' + status : withBest,
      withBest,
      titled + '  ' + this.board.score,
    ])) + '\n');
    out.push(line('+' + '-'.repeat(this.w) + '+') + '\n');

    const rows = this.board.rows();
    for (let y = 0; y < this.h; y++) {
      const row = rows[y] === undefined ? '' : rows[y];
      out.push('|' + row.slice(0, this.w).padEnd(this.w) + '|' + ESC + '[K\n');
    }
    out.push(line('+' + '-'.repeat(this.w) + '+') + '\n');

    let footer;
    if (this.paused) {
      const acked = this.pokedAt && Date.now() - this.pokedAt < 2500;
      footer = acked
        ? fit([
          '  [PAUSED] this pane has focus - answer Claude to resume',
          '  [PAUSED] answer Claude to resume',
          '  [PAUSED]',
        ])
        : fit([
          '  [PAUSED] Claude needs you - check the other pane',
          '  [PAUSED] Claude needs you',
          '  [PAUSED]',
        ]);
    } else if (this.board.dead) {
      footer = fit([
        '  Game over - "r" for a new game, or prompt Claude',
        '  Game over - "r" restarts',
        '  Game over',
      ]);
    } else {
      const short = this.game.controlsShort || this.game.controls;
      footer = fit([
        this.canFocus
          ? '  ' + this.game.controls + ', f: autofocus, q: quit'
          : '  ' + this.game.controls + ', q to quit',
        '  ' + this.game.controls + ', q to quit',
        '  ' + short + ', q to quit',
        '  ' + short,
        '  q to quit',
      ]);
    }
    out.push(line(footer) + '\n');

    process.stdout.write(out.join(''));
  }

  // Draws a short message in place of the board. Only used when the pane is
  // too small for a frame, so it clips rather than letting lines wrap.
  writeNotice(out, lines) {
    const narrow = (process.stdout.columns || 40) - 1;
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i].slice(0, narrow) + ESC + '[K\n');
    }
    // Wipe whatever the previous, larger frame left below the message.
    out.push(ESC + '[J');
    process.stdout.write(out.join(''));
  }

  // ---- lifecycle --------------------------------------------------------

  quit(message) {
    if (this.timer) clearInterval(this.timer);
    // Drop the pane marker so a later /<game> opens a fresh pane instead of
    // trying to focus this dead one.
    if (this.paneRefFile) {
      try { fs.unlinkSync(this.paneRefFile); } catch (e) { /* already gone */ }
    }
    process.stdout.write(ESC + '[2J' + ESC + '[H' + ESC + '[?25h');
    if (message) process.stdout.write(message + '\n');
    process.exit(0);
  }

  onKey(key) {
    if (key === CTRL_C || key === 'q') {
      this.quit(null);
      return;
    }
    if (key === 'r' && (this.tooSmall || this.cramped || (this.board && this.board.dead))) {
      this.newBoard();
      return;
    }
    if (key === 'f' && this.canFocus) {
      this.autoFocus = !this.autoFocus;
      if (this.board || this.tooSmall) this.render();
      return;
    }
    // A frozen game that silently swallows keys looks exactly like a pane
    // that never received them, which makes people think pane switching is
    // broken. Acknowledge the keypress in the footer instead of dropping it.
    if (this.paused || this.cramped) {
      this.pokedAt = Date.now();
      if (this.board || this.tooSmall) this.render();
      return;
    }
    if (this.board && !this.board.dead && this.board.key) {
      this.board.key(key);
    }
  }

  start() {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (key) => this.onKey(key));

    process.stdout.on('resize', () => {
      // Never resize a board mid-game (that would scramble a run in progress);
      // just redraw now and adopt the new size for the next board.
      this.needsFullRedraw = true;
      this.relayoutPending = true;
      if (this.tooSmall) this.newBoard();
      this.render();
    });

    process.on('exit', () => process.stdout.write(ESC + '[?25h'));
    const sigs = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (let i = 0; i < sigs.length; i++) {
      process.on(sigs[i], () => this.quit(null));
    }

    process.stdout.write(ESC + '[?25l');
    this.newBoard();
    this.timer = setInterval(() => this.tick(), this.game.tickMs);
  }
}

function run(game) {
  const stateFile = process.argv[2];
  if (!stateFile) {
    process.stderr.write('Usage: ' + game.id + '.js <state-file> [pane-ref-file]\n');
    process.exit(1);
  }
  new Harness(game, stateFile, process.argv[3], process.argv[4]).start();
}

// GAME CONTRACT
// -------------
// A game module exports:
//   id        string  key used in scores.json (e.g. 'snake')
//   title     string  shown in the header
//   tickMs    number  how often step() is called
//   controls  string  one-line control hint for the footer
//   minCols   number  minimum inner width it can render into
//   minRows   number  minimum inner height it can render into
//   dims(availW, availH) -> { w, h }   inner render area to use
//   create(w, h) -> board
//
// A board exposes:
//   score       number   read every frame
//   dead        boolean  read every frame
//   step()               advance one tick (never called while paused/dead)
//   key(k)               raw keypress (never called while paused/dead)
//   rows()      -> string[]  exactly h strings, each <= w chars
//   status()    -> string    optional extra header text
module.exports = { run, clamp, ESC, CTRL_C };
