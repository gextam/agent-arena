// Models over time: the series behind the home page chart (src/models.js) and GET /api/models.
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelSeries, thin } from '../src/models.js';
import { startServer } from '../src/server.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = async (url, init) => { const res = await fetch(url, init); return { status: res.status, body: await res.json() }; };
async function until(fn, what, { tries = 400, every = 25 } = {}) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(every); }
  throw new Error('timed out waiting for ' + what);
}

test('modelSeries: the mean of each model after every game, hidden models left out, the leader first', () => {
  const rows = [
    // game 1: one agent of m1 wins, one of m2 loses; a house player, a scripted bot and an agent without a model also sat
    { agentId: 'a1', model: 'm1', ratingAfter: 1516, score: 1, t: 1000, gameId: 'g1' },
    { agentId: 'b1', model: 'm2', ratingAfter: 1484, score: 0, t: 1000, gameId: 'g1' },
    { agentId: 'h', model: 'house', ratingAfter: 1484, score: 0, t: 1000, gameId: 'g1' },
    { agentId: 's', model: 'scripted', ratingAfter: 1516, score: 1, t: 1000, gameId: 'g1' },
    { agentId: 'n', model: '', ratingAfter: 1484, score: 0, t: 1000, gameId: 'g1' },
    // game 2: a second m1 agent plays and loses while the first wins again; m2 draws
    { agentId: 'a1', model: 'm1', ratingAfter: 1531, score: 1, t: 2000, gameId: 'g2' },
    { agentId: 'a2', model: 'm1', ratingAfter: 1484, score: 0, t: 2000, gameId: 'g2' },
    { agentId: 'b1', model: 'm2', ratingAfter: 1500, score: 0.5, t: 2000, gameId: 'g2' },
  ];
  const out = modelSeries(rows);
  assert.deepEqual(out.models.map(m => m.model), ['m1', 'm2']);
  const [m1, m2] = out.models;
  assert.equal(m1.agents, 2); assert.equal(m1.games, 3); assert.equal(m1.wins, 2); assert.equal(m1.draws, 0);
  // two m1 seats in game 2 make one point: the mean of both agents after that game
  assert.deepEqual(m1.series, [{ t: 1000, rating: 1516 }, { t: 2000, rating: 1507.5 }]);
  assert.equal(m1.rating, 1507.5);
  assert.equal(m1.provisional, true);
  assert.equal(m2.draws, 1);
  assert.deepEqual(m2.series, [{ t: 1000, rating: 1484 }, { t: 2000, rating: 1500 }]);
  assert.equal(out.leader, 'm1');
  assert.equal(out.games, 2);
  assert.equal(out.since, 1000);
  assert.equal(out.hidden_rows, 3);
  assert.deepEqual(modelSeries([]), { models: [], leader: null, games: 0, since: null, hidden_rows: 0 });
  // six games make a model's place more than provisional
  const many = Array.from({ length: 6 }, (_, i) => ({ agentId: 'z', model: 'mz', ratingAfter: 1500 + i, score: 1, t: 1000 + i, gameId: `q${i}` }));
  assert.equal(modelSeries(many).models[0].provisional, false);
});

test('thin keeps both ends and spaces the rest evenly', () => {
  const pts = Array.from({ length: 1000 }, (_, i) => ({ t: i }));
  const t = thin(pts, 240);
  assert.equal(t.length, 240);
  assert.equal(t[0].t, 0);
  assert.equal(t.at(-1).t, 999);
  assert.equal(thin(pts.slice(0, 5), 240).length, 5);
});

test('GET /api/models serves the chart from finished games, one record per declared model', async () => {
  const scripted = (n, name) => ({ id: `t${n}`, vendor: 'arena', name, model: `chart-model-${n}`, released: '2026-01-0' + n, price: { in: 0, out: 0 }, provider: 'scripted' });
  const catalog = [scripted(1, 'Chart One'), scripted(2, 'Chart Two'), scripted(3, 'Chart Three'), scripted(4, 'Chart Four'), scripted(5, 'Chart Five')];
  const app = await startServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', loadEnv: false, arena: { tickMs: 20, actionTimeoutMs: 10_000 }, tables: { catalog, keys: { anthropic: '', openrouter: '' }, paceMs: 0, clientCooldownMs: 0 } });
  try {
    const empty = (await json(app.url + '/api/models')).body;
    assert.deepEqual(empty.models, []);
    assert.equal(empty.rating_name, 'Guile');
    const r = await json(app.url + '/api/tables', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seats: ['t1', 't2', 't3', 't4', 't5'] }) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await until(async () => (await json(app.url + `/api/tables/${r.body.table.id}`)).body.table.status === 'finished', 'the table to finish');
    const out = (await json(app.url + '/api/models')).body;
    assert.equal(out.models.length, 5);
    assert.equal(out.games, 1);
    assert.ok(out.models.every(m => m.games === 1 && m.agents === 1 && m.series.length === 1 && m.provisional));
    assert.ok(out.models.every(m => m.model.startsWith('chart-model-')));
    assert.equal(out.models[0].model, out.leader);
    assert.ok(out.models[0].rating > 1500 && out.models.at(-1).rating < 1500, 'winners above 1500, losers below');
    for (let i = 1; i < out.models.length; i++) assert.ok(out.models[i - 1].rating >= out.models[i].rating, 'sorted by rating');
  } finally {
    await app.close();
  }
});
