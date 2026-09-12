#!/usr/bin/env node
'use strict';

// Prints the local high-score table. Used by bin/status.sh so the shell does
// not have to parse JSON.

const fs = require('fs');
const path = require('path');
const scores = require('./scores.js');

const gamesDir = path.join(__dirname, '..', 'games');
let ids = [];
try {
  ids = fs.readdirSync(gamesDir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.slice(0, -3))
    .sort();
} catch (e) {
  ids = ['snake'];
}

let any = false;
const lines = [];
for (const id of ids) {
  const top = scores.getTopScores(id, 3);
  if (top.length === 0) {
    lines.push('  ' + id.padEnd(8) + ' no games played yet');
    continue;
  }
  any = true;
  const list = top.map((s) => String(s.score)).join(', ');
  const played = scores.getTopScores(id, 1e9).length;
  lines.push('  ' + id.padEnd(8) + ' best ' + String(top[0].score).padEnd(7) +
    'top: ' + list + '   (' + played + ' game' + (played === 1 ? '' : 's') + ')');
}

process.stdout.write(lines.join('\n') + '\n');
if (any) process.stdout.write('  scores file: ' + scores.SCORES_FILE + '\n');
