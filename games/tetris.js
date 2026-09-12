#!/usr/bin/env node
'use strict';

// Tetris. 10 columns wide; the height adapts to the pane. Blocks are drawn
// two characters wide ('[]') because terminal cells are about twice as tall
// as they are wide, which keeps the pieces looking square.

const engine = require('../lib/engine.js');
const clamp = engine.clamp;
const ESC = engine.ESC;

const COLS = 10;
const BOARD_CHARS = COLS * 2;
// 2 chars of divider (' |') plus 9 chars of panel text.
const PANEL_CHARS = 11;

// Each piece lists the filled cells inside a box of side `box`. Rotation is
// done inside that box, which is why I and O get their own sizes: rotating a
// 3-wide piece inside a 4-wide box makes it visibly drift sideways.
const PIECES = [
  { name: 'I', box: 4, cells: [[0, 1], [1, 1], [2, 1], [3, 1]], glyph: '[]' },
  { name: 'O', box: 2, cells: [[0, 0], [1, 0], [0, 1], [1, 1]], glyph: '[]' },
  { name: 'T', box: 3, cells: [[1, 0], [0, 1], [1, 1], [2, 1]], glyph: '[]' },
  { name: 'S', box: 3, cells: [[1, 0], [2, 0], [0, 1], [1, 1]], glyph: '[]' },
  { name: 'Z', box: 3, cells: [[0, 0], [1, 0], [1, 1], [2, 1]], glyph: '[]' },
  { name: 'J', box: 3, cells: [[0, 0], [0, 1], [1, 1], [2, 1]], glyph: '[]' },
  { name: 'L', box: 3, cells: [[2, 0], [0, 1], [1, 1], [2, 1]], glyph: '[]' },
];

const LINE_SCORES = [0, 100, 300, 500, 800];

function rotateCells(cells, box, times) {
  let out = cells;
  for (let t = 0; t < times; t++) {
    // Clockwise inside the box: (x, y) -> (box - 1 - y, x)
    out = out.map((c) => [box - 1 - c[1], c[0]]);
  }
  return out;
}

function randPiece() {
  return Math.floor(Math.random() * PIECES.length);
}

function createBoard(w, h) {
  const ROWS = h;
  const grid = [];
  for (let y = 0; y < ROWS; y++) grid.push(new Array(COLS).fill(null));

  const board = {
    score: 0,
    dead: false,
    lines: 0,
    level: 1,
    frames: 0,
    piece: null,
    nextType: randPiece(),
  };

  function cellsOf(type, rot, px, py) {
    const p = PIECES[type];
    return rotateCells(p.cells, p.box, rot).map((c) => [px + c[0], py + c[1]]);
  }

  function collides(type, rot, px, py) {
    const cells = cellsOf(type, rot, px, py);
    for (let i = 0; i < cells.length; i++) {
      const x = cells[i][0];
      const y = cells[i][1];
      if (x < 0 || x >= COLS || y >= ROWS) return true;
      // Above the ceiling is allowed while spawning, just not occupied space.
      if (y >= 0 && grid[y][x] !== null) return true;
    }
    return false;
  }

  function spawn() {
    const type = board.nextType;
    board.nextType = randPiece();
    const p = PIECES[type];
    const px = Math.floor((COLS - p.box) / 2);
    const py = 0;
    if (collides(type, 0, px, py)) {
      board.dead = true;
      board.piece = null;
      return;
    }
    board.piece = { type: type, rot: 0, x: px, y: py };
  }

  function lockPiece() {
    const pc = board.piece;
    const cells = cellsOf(pc.type, pc.rot, pc.x, pc.y);
    for (let i = 0; i < cells.length; i++) {
      const x = cells[i][0];
      const y = cells[i][1];
      if (y >= 0 && y < ROWS) grid[y][x] = PIECES[pc.type].glyph;
    }

    // Clear full rows.
    let cleared = 0;
    for (let y = ROWS - 1; y >= 0; y--) {
      let full = true;
      for (let x = 0; x < COLS; x++) {
        if (grid[y][x] === null) { full = false; break; }
      }
      if (full) {
        grid.splice(y, 1);
        grid.unshift(new Array(COLS).fill(null));
        cleared++;
        y++; // re-check the row that dropped into this slot
      }
    }
    if (cleared > 0) {
      board.lines += cleared;
      board.score += LINE_SCORES[cleared] * board.level;
      board.level = Math.floor(board.lines / 10) + 1;
    }
    spawn();
  }

  function tryMove(dx, dy) {
    const pc = board.piece;
    if (!pc) return false;
    if (collides(pc.type, pc.rot, pc.x + dx, pc.y + dy)) return false;
    pc.x += dx;
    pc.y += dy;
    return true;
  }

  function tryRotate() {
    const pc = board.piece;
    if (!pc) return;
    const rot = (pc.rot + 1) % 4;
    // Basic wall kick: try in place, then nudge sideways.
    const kicks = [0, -1, 1, -2, 2];
    for (let i = 0; i < kicks.length; i++) {
      if (!collides(pc.type, rot, pc.x + kicks[i], pc.y)) {
        pc.rot = rot;
        pc.x += kicks[i];
        return;
      }
    }
  }

  function framesPerDrop() {
    // tickMs is 50, so level 1 falls every ~500ms down to ~150ms.
    return Math.max(3, 11 - board.level);
  }

  spawn();

  board.step = function step() {
    if (!board.piece) return;
    board.frames++;
    if (board.frames >= framesPerDrop()) {
      board.frames = 0;
      if (!tryMove(0, 1)) lockPiece();
    }
  };

  board.key = function key(k) {
    if (!board.piece) return;
    if (k === ESC + '[D' || k === 'a') { tryMove(-1, 0); return; }
    if (k === ESC + '[C' || k === 'd') { tryMove(1, 0); return; }
    if (k === ESC + '[A' || k === 'w') { tryRotate(); return; }
    if (k === ESC + '[B' || k === 's') {
      // Soft drop: a point per row, and reset gravity so holding down feels
      // responsive rather than fighting the timer.
      if (tryMove(0, 1)) board.score += 1;
      board.frames = 0;
      return;
    }
    if (k === ' ') {
      let dropped = 0;
      while (tryMove(0, 1)) dropped++;
      board.score += dropped * 2;
      lockPiece();
      return;
    }
  };

  board.rows = function rows() {
    // Start from the settled blocks, then stamp the live piece on top.
    const cells = [];
    for (let y = 0; y < ROWS; y++) cells.push(grid[y].slice());
    if (board.piece) {
      const pc = board.piece;
      const live = cellsOf(pc.type, pc.rot, pc.x, pc.y);
      for (let i = 0; i < live.length; i++) {
        const x = live[i][0];
        const y = live[i][1];
        if (y >= 0 && y < ROWS && x >= 0 && x < COLS) cells[y][x] = PIECES[pc.type].glyph;
      }
    }

    const panel = w >= BOARD_CHARS + PANEL_CHARS ? buildPanel() : null;

    const out = [];
    for (let y = 0; y < ROWS; y++) {
      let line = '';
      for (let x = 0; x < COLS; x++) line += cells[y][x] === null ? '  ' : cells[y][x];
      if (panel) line += ' |' + (panel[y] === undefined ? '' : panel[y]);
      out.push(line);
    }
    return out;
  };

  function buildPanel() {
    const p = PIECES[board.nextType];
    const shape = rotateCells(p.cells, p.box, 0);
    const preview = [];
    for (let y = 0; y < p.box; y++) {
      let line = '';
      for (let x = 0; x < p.box; x++) {
        let filled = false;
        for (let i = 0; i < shape.length; i++) {
          if (shape[i][0] === x && shape[i][1] === y) { filled = true; break; }
        }
        line += filled ? '[]' : '  ';
      }
      if (line.trim() !== '') preview.push(' ' + line);
    }
    const lines = [' NEXT'].concat(preview, ['', ' lines', ' ' + board.lines, '', ' level', ' ' + board.level]);
    // Pad out to the full board height so the frame edge stays straight.
    while (lines.length < ROWS) lines.push('');
    return lines;
  }

  board.status = function status() {
    return 'lv ' + board.level + '  lines ' + board.lines;
  };

  return board;
}

engine.run({
  id: 'tetris',
  title: 'TETRIS',
  tickMs: 50,
  controls: 'arrows move/rotate, space drops',
  controlsShort: 'arrows + space',
  minCols: BOARD_CHARS,
  minRows: 12,
  dims: (availW, availH) => ({
    w: availW >= BOARD_CHARS + PANEL_CHARS ? BOARD_CHARS + PANEL_CHARS : BOARD_CHARS,
    h: clamp(availH, 12, 20),
  }),
  create: createBoard,
});
