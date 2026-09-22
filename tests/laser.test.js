const test = require('node:test');
const assert = require('node:assert/strict');
const Laser = require('../js/laser.js');

test('laser: isLaserTool erkennt nur "laser"', () => {
  assert.equal(Laser.isLaserTool('laser'), true);
  assert.equal(Laser.isLaserTool('pen'), false);
  assert.equal(Laser.isLaserTool('marker'), false);
  assert.equal(Laser.isLaserTool(undefined), false);
});

test('laser: push deckelt Trail auf TRAIL_MAX', () => {
  let t = Laser.createTrail();
  for (let i = 0; i < Laser.TRAIL_MAX + 10; i++) t = Laser.push(t, { x: i, y: i, t: 1000 + i });
  assert.equal(t.length, Laser.TRAIL_MAX);
  assert.equal(t[t.length - 1].x, Laser.TRAIL_MAX + 9);
});

test('laser: prune entfernt alte Punkte, frische bleiben', () => {
  const trail = [{ x: 0, y: 0, t: 0 }, { x: 1, y: 1, t: 900 }, { x: 2, y: 2, t: 1000 }];
  const kept = Laser.prune(trail, 1000, 700);
  assert.deepEqual(kept.map(p => p.x), [1, 2]);
  assert.deepEqual(Laser.prune([], 1000), []);
});

test('laser: alphaFor 1 -> 0 über FADE_MS', () => {
  assert.equal(Laser.alphaFor(0), 1);
  assert.ok(Laser.alphaFor(Laser.FADE_MS / 2) > 0.4 && Laser.alphaFor(Laser.FADE_MS / 2) < 0.6);
  assert.equal(Laser.alphaFor(Laser.FADE_MS), 0);
  assert.equal(Laser.alphaFor(Laser.FADE_MS + 100), 0);
});

test('laser: push ignoriert ungültige Punkte', () => {
  let t = Laser.createTrail();
  t = Laser.push(t, null);
  t = Laser.push(t, { x: NaN, y: 1 });
  assert.equal(t.length, 0);
});
