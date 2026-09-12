#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCORES_DIR = path.join(os.homedir(), '.claude-coplay');
const SCORES_FILE = path.join(SCORES_DIR, 'scores.json');

// This module is deliberately the only place that knows how scores are
// persisted. If a remote / cross-player leaderboard is added later, it
// should be added behind these same three functions so nothing in the
// games or the launcher needs to change.

function loadAll() {
  try {
    const raw = fs.readFileSync(SCORES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

function saveAll(data) {
  fs.mkdirSync(SCORES_DIR, { recursive: true });
  fs.writeFileSync(SCORES_FILE, JSON.stringify(data, null, 2));
}

function addScore(game, score) {
  const data = loadAll();
  if (!Array.isArray(data[game])) data[game] = [];
  data[game].push({ score, date: new Date().toISOString() });
  saveAll(data);
  return data[game];
}

function getTopScores(game, n) {
  const limit = n || 5;
  const data = loadAll();
  const list = Array.isArray(data[game]) ? data[game].slice() : [];
  list.sort((a, b) => b.score - a.score);
  return list.slice(0, limit);
}

function getPersonalBest(game) {
  const top = getTopScores(game, 1);
  return top.length ? top[0].score : 0;
}

module.exports = { addScore, getTopScores, getPersonalBest, SCORES_FILE };
