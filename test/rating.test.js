import test from 'node:test';
import assert from 'node:assert/strict';
import { updateRatings, expectedScore } from '../src/rating.js';

test('equal teams: winners gain what losers lose', () => {
  const rows = [
    { agentId: 'w', rating: 1500, team: 'werewolves', score: 1 },
    { agentId: 'a', rating: 1500, team: 'village', score: 0 },
    { agentId: 'b', rating: 1500, team: 'village', score: 0 },
  ];
  const r = updateRatings(rows);
  assert.equal(r.w.delta, 16);
  assert.equal(r.a.delta, -16);
  assert.equal(r.b.after, 1484);
});

test('an underdog gains more than a favourite', () => {
  const r = updateRatings([
    { agentId: 'low', rating: 1300, team: 'village', score: 1 },
    { agentId: 'high', rating: 1700, team: 'werewolves', score: 0 },
  ]);
  assert.ok(r.low.delta > 16);
  assert.ok(r.high.delta < -16);
  assert.ok(Math.abs(r.low.delta + r.high.delta) < 0.2);
});

test('a draw between equals changes nothing', () => {
  const r = updateRatings([
    { agentId: 'x', rating: 1500, team: 'village', score: 0.5 },
    { agentId: 'y', rating: 1500, team: 'werewolves', score: 0.5 },
  ]);
  assert.equal(r.x.delta, 0);
  assert.equal(expectedScore(1500, 1500), 0.5);
});
