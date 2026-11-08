// House players: they keep min_players - 1 seats warm, never open a table by themselves, and the first
// visiting agent gets a game that includes them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.js';
import { startHouse, houseSeatCount, HOUSE_NAMES } from '../bots/house.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = async (url, init) => { const res = await fetch(url, init); return { status: res.status, body: await res.json() }; };
async function until(fn, what, { tries = 200, every = 25 } = {}) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(every); }
  throw new Error('timed out waiting for ' + what);
}

test('the house seats one player short of a table unless told otherwise', () => {
  assert.equal(houseSeatCount({ min_players: 5, max_players: 8 }), 4);
  assert.equal(houseSeatCount({ min_players: 6, max_players: 8 }, undefined), 5);
  assert.equal(houseSeatCount({ min_players: 5, max_players: 8 }, ''), 4);
  assert.equal(houseSeatCount({ min_players: 5, max_players: 8 }, '2'), 2);
  assert.equal(houseSeatCount({ min_players: 5, max_players: 8 }, 0), 0);
  assert.throws(() => houseSeatCount({ min_players: 5 }, 'four'));
  assert.throws(() => houseSeatCount({ min_players: 5 }, '-1'));
});

test('house players wait without starting a game among themselves; a visiting agent opens a table that includes them', async () => {
  const app = await startServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', arena: { fillWindowMs: 50, tickMs: 20, actionTimeoutMs: 10_000 } });
  const ctrl = new AbortController();
  const house = startHouse({ baseUrl: app.url, persist: false, delayMs: 0, signal: ctrl.signal, log: () => {} });
  try {
    // four house players show up in the lobby, tagged as the house, under their fixed names
    const lobby = await until(async () => { const { body } = await json(app.url + '/api/lobby'); return body.waiting.length === 4 ? body : null; }, 'four house players');
    assert.ok(lobby.waiting.every(w => w.model === 'house'), JSON.stringify(lobby.waiting));
    assert.deepEqual(lobby.waiting.map(w => w.name).sort(), HOUSE_NAMES.slice(0, 4).sort());
    assert.equal(lobby.starts_in_ms, null, 'the fill window never opens for the house alone');
    // and they stay there: many ticks later there is still no game
    await sleep(300);
    const health = (await json(app.url + '/api/health')).body;
    assert.equal(health.running_games, 0);
    assert.equal(health.games, 0);
    assert.equal(health.waiting.length, 4);
    // the human-facing stats do not count the house as agents or as a model
    const stats = (await json(app.url + '/api/stats')).body;
    assert.equal(stats.agents, 0);
    assert.equal(stats.models, 0);

    // a visitor arrives, without auto_requeue
    const reg = await json(app.url + '/api/agents/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Visitor', model: 'test-model' }) });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const auth = { Authorization: `Bearer ${reg.body.token}`, 'Content-Type': 'application/json' };
    const joined = await json(app.url + '/api/lobby/join', { method: 'POST', headers: auth, body: JSON.stringify({ auto_requeue: false }) });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    const game = await until(async () => (await json(app.url + '/api/games?status=running')).body.games[0], 'a running game');
    assert.equal(game.players.length, 5);
    assert.deepEqual(game.players.map(p => p.name).sort(), ['Visitor', ...HOUSE_NAMES.slice(0, 4)].sort());

    // the visitor makes legal moves until the game ends; the house plays its own seats
    for (;;) {
      const r = await json(app.url + '/api/me/pending?wait=5', { headers: auth });
      assert.equal(r.status, 200);
      if (!r.body.request) { if (!r.body.game_id) break; continue; }
      const req = r.body.request;
      const action = req.type === 'statement' ? { text: 'Visitor here. I am a plain villager.', lie: req.you.role === 'werewolf' }
        : req.options.length ? { target: req.options[0].player_id } : {};
      const act = await json(app.url + '/api/me/act', { method: 'POST', headers: auth, body: JSON.stringify({ request_id: req.request_id, action, reasoning: 'visiting' }) });
      assert.equal(act.status, 200, JSON.stringify(act.body));
    }
    const finished = (await json(app.url + `/api/games/${game.id}`)).body;
    assert.equal(finished.status, 'finished');
    assert.ok(['village', 'werewolves', 'draw'].includes(finished.winner));

    // afterwards the house is back in the lobby and the visitor is not; only the visitor counts as an agent
    const again = await until(async () => { const { body } = await json(app.url + '/api/lobby'); return body.waiting.length === 4 ? body : null; }, 'the house back in the lobby');
    assert.ok(again.waiting.every(w => w.model === 'house'));
    assert.equal(again.starts_in_ms, null);
    const after = (await json(app.url + '/api/stats')).body;
    assert.equal(after.agents, 1);
    assert.equal(after.models, 1);
    assert.equal(after.games, 1);
  } finally {
    ctrl.abort();
    await app.close();
    await house; // every seat notices the abort as soon as its poll returns
  }
});
