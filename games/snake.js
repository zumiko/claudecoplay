#!/usr/bin/env node
'use strict';

// Snake. Body is '=', the head is direction-aware ('>' '<' '^' 'v'), food is
// '*'. All pausing/scoring/rendering chrome lives in lib/engine.js.

const engine = require('../lib/engine.js');
const clamp = engine.clamp;
const ESC = engine.ESC;

const DIRS = {};
DIRS[ESC + '[A'] = { x: 0, y: -1 };
DIRS[ESC + '[B'] = { x: 0, y: 1 };
DIRS[ESC + '[C'] = { x: 1, y: 0 };
DIRS[ESC + '[D'] = { x: -1, y: 0 };
// WASD as well, so the game is playable on keyboards/terminals where the
// arrow keys are grabbed by something else.
DIRS.w = { x: 0, y: -1 };
DIRS.s = { x: 0, y: 1 };
DIRS.d = { x: 1, y: 0 };
DIRS.a = { x: -1, y: 0 };

function randInt(n) {
  return Math.floor(Math.random() * n);
}

function createBoard(w, h) {
  const board = {
    score: 0,
    dead: false,
    snake: [{ x: Math.floor(w / 2), y: Math.floor(h / 2) }],
    dir: { x: 1, y: 0 },
    // Buffered so a keypress mid-tick is applied on the very next step
    // instead of being dropped.
    nextDir: { x: 1, y: 0 },
    food: null,
  };

  function placeFood() {
    // The board can in principle be filled completely; bail out rather than
    // spin forever if there is nowhere left to put food.
    if (board.snake.length >= w * h) {
      board.food = null;
      return;
    }
    for (;;) {
      const f = { x: randInt(w), y: randInt(h) };
      let clash = false;
      for (let i = 0; i < board.snake.length; i++) {
        if (board.snake[i].x === f.x && board.snake[i].y === f.y) { clash = true; break; }
      }
      if (!clash) { board.food = f; return; }
    }
  }
  placeFood();

  board.step = function step() {
    board.dir = board.nextDir;
    const head = { x: board.snake[0].x + board.dir.x, y: board.snake[0].y + board.dir.y };

    if (head.x < 0 || head.x >= w || head.y < 0 || head.y >= h) {
      board.dead = true;
      return;
    }
    // The tail tip moves out of the way this same tick, so colliding with it
    // is legal -- only check the segments that will still be there.
    const ateFood = board.food && head.x === board.food.x && head.y === board.food.y;
    const checkLen = ateFood ? board.snake.length : board.snake.length - 1;
    for (let i = 0; i < checkLen; i++) {
      if (board.snake[i].x === head.x && board.snake[i].y === head.y) {
        board.dead = true;
        return;
      }
    }

    board.snake.unshift(head);
    if (ateFood) {
      board.score += 1;
      placeFood();
    } else {
      board.snake.pop();
    }
  };

  board.key = function key(k) {
    const d = DIRS[k];
    if (!d) return;
    // No instant 180-degree reversals.
    if (d.x === -board.dir.x && d.y === -board.dir.y) return;
    board.nextDir = d;
  };

  board.rows = function rows() {
    const grid = [];
    for (let y = 0; y < h; y++) grid.push(new Array(w).fill(' '));
    if (board.food) grid[board.food.y][board.food.x] = '*';

    let headChar = 'v';
    if (board.dir.x === 1) headChar = '>';
    else if (board.dir.x === -1) headChar = '<';
    else if (board.dir.y === -1) headChar = '^';

    for (let i = 0; i < board.snake.length; i++) {
      const s = board.snake[i];
      if (s.y >= 0 && s.y < h && s.x >= 0 && s.x < w) {
        grid[s.y][s.x] = i === 0 ? headChar : '=';
      }
    }
    const out = [];
    for (let y = 0; y < h; y++) out.push(grid[y].join(''));
    return out;
  };

  board.status = function status() {
    return 'len ' + board.snake.length;
  };

  return board;
}

engine.run({
  id: 'snake',
  title: 'SNAKE',
  tickMs: 140,
  controls: 'arrows/wasd to steer',
  controlsShort: 'arrows/wasd',
  minCols: 20,
  minRows: 10,
  dims: (availW, availH) => ({ w: clamp(availW, 20, 60), h: clamp(availH, 10, 30) }),
  create: createBoard,
});
