#!/usr/bin/env node
'use strict';

// Asteroids. The ship drifts with real momentum and the screen wraps, which
// gives it the continuously-moving feel that a turn-based game can't have --
// and makes it forgiving of constant interruptions, since you resume exactly
// where you drifted to.
//
// Two things shape the implementation:
//   * Positions and velocities are floats, rounded only at render time, so
//     motion is smooth rather than jumping a whole cell at a time.
//   * Terminal cells are about twice as tall as they are wide, so every
//     vertical velocity is halved and every vertical distance is doubled when
//     measuring. Without that, everything moves and collides twice as fast
//     going up and down as it does sideways.

const engine = require('../lib/engine.js');
const clamp = engine.clamp;
const ESC = engine.ESC;

const ACCEL = 0.22;
const MAX_SPEED = 1.1;
const DRAG = 0.985;
// 45-degree steps, so the glyph drawn for the ship is always its exact
// heading. Finer rotation would let the ship point somewhere its character
// can't show, and you would shoot at an angle you didn't aim.
const TURN = Math.PI / 4;
const MAX_BULLETS = 4;
const BULLET_SPEED = 1.1;
const THRUST_TICKS = 3;
const RESPAWN_INVULN = 40;
const WAVE_PAUSE = 25;
const SCORE_BIG = 20;
const SCORE_SMALL = 50;

// Screen coordinates: x grows right, y grows down. So angle 0 points right and
// -PI/2 points up.
function headingChar(angle) {
  const TAU = Math.PI * 2;
  const t = ((angle % TAU) + TAU) % TAU;
  const octant = Math.round(t / (Math.PI / 4)) % 8;
  return ['>', '\\', 'v', '/', '<', '\\', '^', '/'][octant];
}

function createBoard(w, h) {
  const board = { score: 0, dead: false, wave: 1, ships: 3 };
  let ship, asteroids, bullets, invuln, thrusting, wavePause, frame, blinking;

  function wrap(o) {
    o.x = ((o.x % w) + w) % w;
    o.y = ((o.y % h) + h) % h;
  }

  // `blink` marks the new ship as flashing so its invulnerability is
  // visible. Deliberately off for the very first ship: blinking at game
  // start just looks like there is no ship yet.
  function resetShip(blink) {
    ship = { x: w / 2, y: h / 2, vx: 0, vy: 0, a: -Math.PI / 2 };
    invuln = RESPAWN_INVULN;
    blinking = !!blink;
    thrusting = 0;
  }

  function newAsteroid() {
    // Always spawn on an edge, so a new rock can never materialise on top of
    // the ship.
    let x, y;
    if (Math.random() < 0.5) {
      x = Math.random() * w;
      y = Math.random() < 0.5 ? 0 : h - 1;
    } else {
      x = Math.random() < 0.5 ? 0 : w - 1;
      y = Math.random() * h;
    }
    const a = Math.random() * Math.PI * 2;
    const speed = 0.12 + Math.random() * 0.12;
    return { x: x, y: y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed * 0.5, size: 2 };
  }

  function spawnWave(count) {
    asteroids = [];
    for (let i = 0; i < count; i++) asteroids.push(newAsteroid());
  }

  // Index of the asteroid overlapping this point, or -1. Distances are
  // measured the short way round, since the field wraps.
  function asteroidAt(x, y, generous) {
    for (let i = 0; i < asteroids.length; i++) {
      const a = asteroids[i];
      let dx = x - a.x;
      let dy = y - a.y;
      if (dx > w / 2) dx -= w;
      if (dx < -w / 2) dx += w;
      if (dy > h / 2) dy -= h;
      if (dy < -h / 2) dy += h;
      const d2 = dx * dx + (dy * 2) * (dy * 2);
      const r = (a.size === 2 ? 1.7 : 1.1) + (generous ? 0.4 : 0);
      if (d2 <= r * r) return i;
    }
    return -1;
  }

  function destroy(i) {
    const a = asteroids[i];
    asteroids.splice(i, 1);
    if (a.size === 2) {
      board.score += SCORE_BIG;
      for (let k = 0; k < 2; k++) {
        const ang = Math.random() * Math.PI * 2;
        const speed = 0.2 + Math.random() * 0.15;
        asteroids.push({
          x: a.x, y: a.y,
          vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed * 0.5,
          size: 1,
        });
      }
    } else {
      board.score += SCORE_SMALL;
    }
  }

  function fire() {
    if (bullets.length >= MAX_BULLETS) return;
    bullets.push({
      x: ship.x + Math.cos(ship.a),
      y: ship.y + Math.sin(ship.a) * 0.5,
      vx: ship.vx + Math.cos(ship.a) * BULLET_SPEED,
      vy: ship.vy + Math.sin(ship.a) * BULLET_SPEED * 0.5,
      life: Math.max(14, Math.round(w * 0.5)),
    });
  }

  bullets = [];
  wavePause = WAVE_PAUSE;
  frame = 0;
  resetShip(false);
  spawnWave(board.wave + 2);

  board.step = function step() {
    frame++;
    if (invuln > 0) invuln--;

    if (thrusting > 0) {
      thrusting--;
      ship.vx += Math.cos(ship.a) * ACCEL;
      ship.vy += Math.sin(ship.a) * ACCEL * 0.5;
    }
    // A little drag: without it the ship is near-uncontrollable on a field
    // this small, since you cannot coast for long before wrapping.
    ship.vx *= DRAG;
    ship.vy *= DRAG;
    const speed = Math.sqrt(ship.vx * ship.vx + (ship.vy * 2) * (ship.vy * 2));
    if (speed > MAX_SPEED) {
      const k = MAX_SPEED / speed;
      ship.vx *= k;
      ship.vy *= k;
    }
    ship.x += ship.vx;
    ship.y += ship.vy;
    wrap(ship);

    for (let i = 0; i < asteroids.length; i++) {
      const a = asteroids[i];
      a.x += a.vx;
      a.y += a.vy;
      wrap(a);
    }

    // Bullets move more than a cell per tick, so advance them in half-steps
    // and test after each: a single jump could pass straight through a rock.
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      let spent = false;
      for (let s = 0; s < 2 && !spent; s++) {
        b.x += b.vx / 2;
        b.y += b.vy / 2;
        wrap(b);
        b.life -= 0.5;
        if (b.life <= 0) {
          spent = true;
          break;
        }
        const hit = asteroidAt(b.x, b.y, false);
        if (hit >= 0) {
          destroy(hit);
          spent = true;
        }
      }
      if (spent) bullets.splice(i, 1);
    }

    if (invuln <= 0 && asteroidAt(ship.x, ship.y, true) >= 0) {
      board.ships--;
      if (board.ships <= 0) {
        board.dead = true;
        return;
      }
      resetShip(true);
      bullets = [];
    }

    if (asteroids.length === 0) {
      wavePause--;
      if (wavePause <= 0) {
        board.wave++;
        spawnWave(board.wave + 2);
        wavePause = WAVE_PAUSE;
      }
    }
  };

  board.key = function key(k) {
    if (k === ESC + '[D' || k === 'a') ship.a -= TURN;
    else if (k === ESC + '[C' || k === 'd') ship.a += TURN;
    else if (k === ESC + '[A' || k === 'w') thrusting = THRUST_TICKS;
    else if (k === ESC + '[B' || k === 's') {
      // Brake. Classic Asteroids has hyperspace here, but on a field this
      // small being able to stop is far more useful.
      ship.vx *= 0.7;
      ship.vy *= 0.7;
    } else if (k === ' ') fire();
  };

  board.rows = function rows() {
    const grid = [];
    for (let y = 0; y < h; y++) grid.push(new Array(w).fill(' '));
    const put = (x, y, ch) => {
      const cx = ((Math.round(x) % w) + w) % w;
      const cy = ((Math.round(y) % h) + h) % h;
      grid[cy][cx] = ch;
    };

    for (let i = 0; i < asteroids.length; i++) {
      put(asteroids[i].x, asteroids[i].y, asteroids[i].size === 2 ? 'O' : 'o');
    }
    for (let i = 0; i < bullets.length; i++) put(bullets[i].x, bullets[i].y, '.');
    // Blink a freshly respawned ship so its invulnerability is visible.
    if (!blinking || invuln <= 0 || Math.floor(frame / 3) % 2 === 0) {
      put(ship.x, ship.y, headingChar(ship.a));
    }

    const out = [];
    for (let y = 0; y < h; y++) out.push(grid[y].join(''));
    return out;
  };

  board.status = function status() {
    return 'wave ' + board.wave + '  ships ' + board.ships;
  };

  return board;
}

engine.run({
  id: 'asteroids',
  title: 'ASTEROIDS',
  tickMs: 60,
  controls: 'arrows turn/thrust, space fires, down brakes',
  controlsShort: 'arrows + space',
  minCols: 30,
  minRows: 12,
  dims: (availW, availH) => ({ w: clamp(availW, 30, 80), h: clamp(availH, 12, 30) }),
  create: createBoard,
});
