// Visitor tables: five catalog models seated by a human and played by the arena itself (src/tables.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.js';
import { CATALOG, checkCatalog, isCheap, latest, HOUSE_MAX_IN, HOUSE_MAX_OUT } from '../src/catalog.js';
import { costOf } from '../src/tables.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = async (url, init) => { const res = await fetch(url, init); return { status: res.status, body: await res.json() }; };
const postJson = (url, body) => json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function until(fn, what, { tries = 400, every = 25 } = {}) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(every); }
  throw new Error('timed out waiting for ' + what);
}

// a catalog of scripted players (no model, no key) plus one model nobody pays for
const scripted = (n, name) => ({ id: `t${n}`, vendor: 'arena', name, model: `test-model-${n}`, released: '2026-01-0' + n, price: { in: 0, out: 0 }, provider: 'scripted' });
const TEST_CATALOG = [
  scripted(1, 'Test One'), scripted(2, 'Test Two'), scripted(3, 'Test Three'), scripted(4, 'Test Four'), scripted(5, 'Test Five'), scripted(6, 'Test Six'),
  { id: 'pricey', vendor: 'openai', name: 'Pricey Model', model: 'openai/pricey', openrouter: 'openai/pricey', released: '2026-02-01', price: { in: 10, out: 50 }, provider: 'openrouter', reasoning: true, json: true },
];
const FIVE = ['t1', 't2', 't3', 't4', 't5'];
// paceMs keeps a table of scripted players alive for a few seconds (unpaced, a whole game takes 40 ms)
const tableOptions = { catalog: TEST_CATALOG, keys: { anthropic: '', openrouter: '' }, paceMs: 150, maxRunning: 1, clientCooldownMs: 0, perDay: 5 };

test('the built-in catalog is sound: twenty or more current models, valid arena names, a house tier', () => {
  assert.ok(checkCatalog(CATALOG));
  assert.ok(CATALOG.length >= 20, `${CATALOG.length} models`);
  assert.ok(new Set(CATALOG.map(e => e.vendor)).size >= 8, 'several vendors');
  const cheap = CATALOG.filter(isCheap);
  assert.ok(cheap.length >= 8, 'enough models for the house to pay for');
  for (const e of cheap) assert.ok(e.price.in <= HOUSE_MAX_IN && e.price.out <= HOUSE_MAX_OUT);
  const top = latest(20);
  assert.equal(top.length, 20);
  for (let i = 1; i < top.length; i++) assert.ok(top[i - 1].released >= top[i].released, 'latest() sorts by release date');
  for (const e of CATALOG) assert.ok(e.provider === 'anthropic' ? e.model.startsWith('claude-') : e.openrouter.includes('/'), `${e.id}: ${e.model}`);
  assert.throws(() => checkCatalog([scripted(1, 'Aa'), scripted(1, 'Bb')]), /duplicate catalog id/);
  assert.throws(() => checkCatalog([scripted(1, 'This name is far too long for the arena to accept')]), /not a valid arena name/);
});

test('costOf prefers the provider figure and otherwise prices tokens, cache reads at a tenth', () => {
  assert.equal(costOf(null, { in: 1, out: 5 }), 0);
  assert.equal(costOf({ input: 1000, output: 100, cost: 0.0042 }, { in: 1, out: 5 }), 0.0042);
  assert.equal(costOf({ input: 1_000_000, output: 100_000 }, { in: 1, out: 5 }), 1.5);
  assert.equal(costOf({ input: 1_000_000, output: 0, cached: 1_000_000 }, { in: 1, out: 5 }), 0.1);
});

test('a visitor seats five models, the arena plays them with everything revealed live, and the record is kept', async () => {
  const app = await startServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', loadEnv: false, arena: { tickMs: 20, actionTimeoutMs: 10_000 }, tables: tableOptions });
  try {
    const cat = (await json(app.url + '/api/tables/catalog')).body;
    assert.equal(cat.models.length, TEST_CATALOG.length);
    assert.deepEqual(cat.house_keys, { anthropic: false, openrouter: false });
    assert.equal(cat.limits.max_running, 1);
    assert.ok(cat.models.find(m => m.id === 't1').house, 'the house seats a scripted player');
    const pricey = cat.models.find(m => m.id === 'pricey');
    assert.equal(pricey.house, false);
    assert.deepEqual(pricey.needs, ['openrouter']);
    assert.ok((await json(app.url + '/api/config')).body.features.tables);

    // what the builder refuses
    let r = await postJson(app.url + '/api/tables', { seats: FIVE.slice(0, 4) });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'bad_seats');
    r = await postJson(app.url + '/api/tables', { seats: ['t1', 't1', 't2', 't3', 't4'] });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'duplicate_model');
    r = await postJson(app.url + '/api/tables', { seats: ['t1', 't2', 't3', 't4', 'nope'] });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'unknown_model');
    r = await postJson(app.url + '/api/tables', { seats: ['t1', 't2', 't3', 't4', 'pricey'] });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'needs_key');
    assert.deepEqual(r.body.models, ['pricey']); assert.deepEqual(r.body.keys, ['openrouter']);
    assert.equal((await json(app.url + '/api/tables/nope')).status, 404);

    // a table starts at once, outside the lobby, with its sealed record open while it runs
    r = await postJson(app.url + '/api/tables', { seats: FIVE });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const { table, game } = r.body;
    assert.equal(table.status, 'running');
    // only one table at a time here (checked first, while the first one is certainly still playing)
    r = await postJson(app.url + '/api/tables', { seats: ['t2', 't3', 't4', 't5', 't6'] });
    assert.equal(r.status, 429); assert.equal(r.body.error, 'tables_full');
    assert.equal(table.seats.length, 5);
    assert.deepEqual(table.seats.map(s => s.name), ['Test One', 'Test Two', 'Test Three', 'Test Four', 'Test Five']);
    assert.ok(table.seats.every(s => s.route === 'scripted' && s.paid_by === 'house' && s.agent_id.startsWith('ag_')));
    assert.equal(game.status, 'running');
    assert.ok(game.options.revealLive);
    assert.equal(game.options.table, table.id);
    assert.ok(game.secrets, 'secrets are open while a visitor table runs');
    assert.ok(game.players.every(p => p.role), 'roles are visible while a visitor table runs');
    assert.equal((await json(app.url + '/api/lobby')).body.waiting.length, 0, 'nobody went through the lobby');

    // the scripted seats play it out
    const done = await until(async () => { const v = (await json(app.url + `/api/tables/${table.id}`)).body; return v.table.status === 'finished' ? v : null; }, 'the table to finish');
    assert.equal(done.game.status, 'finished');
    assert.ok(['village', 'werewolves', 'draw'].includes(done.table.winner));
    assert.equal(done.table.winner, done.game.winner);
    assert.equal(done.table.rounds, done.game.round);
    assert.ok(done.table.thoughts.length >= 10, `${done.table.thoughts.length} moves recorded`);
    for (const th of done.table.thoughts) {
      assert.ok(th.seat >= 1 && th.seat <= 5);
      assert.ok(['night', 'statement', 'vote'].includes(th.type));
      assert.ok(Number.isInteger(th.ms) && th.ms >= 0);
      assert.equal(th.stand_in, false);
      assert.equal(th.applied, true);
    }
    assert.equal(done.table.totals.moves, done.table.thoughts.length);
    assert.equal(done.table.totals.cost_usd, 0);
    assert.ok(done.table.seats.every(s => s.totals.moves > 0 && s.totals.avg_ms != null));
    // every move of every seat was made by the arena, none fell to the deadline
    assert.deepEqual(done.game.stats.timeouts, {});
    // the game is an ordinary rated game of the arena
    const finished = (await json(app.url + '/api/games?status=finished')).body.games;
    assert.ok(finished.some(g => g.id === table.game_id));
    const a1 = (await json(app.url + `/api/agents/${table.seats[0].agent_id}`)).body;
    assert.equal(a1.agent.games, 1);
    assert.equal(a1.agent.model, 'test-model-1');
    assert.notEqual(a1.agent.rating, 1500);
    const list = (await json(app.url + '/api/tables')).body.tables;
    assert.equal(list.length, 1);
    assert.equal(list[0].id, table.id);
    assert.equal(list[0].winner, done.table.winner);
    assert.equal(list[0].thoughts, undefined, 'the list leaves the per-move record out');

    // a second table reuses the standing identities, so a model's games accumulate on one record
    r = await postJson(app.url + '/api/tables', { seats: FIVE });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.table.seats.map(s => s.agent_id), table.seats.map(s => s.agent_id));
    await until(async () => (await json(app.url + `/api/tables/${r.body.table.id}`)).body.table.status === 'finished', 'the second table to finish');
    assert.equal((await json(app.url + `/api/agents/${table.seats[0].agent_id}`)).body.agent.games, 2);
    assert.equal((await json(app.url + '/api/tables')).body.tables.length, 2);
  } finally {
    await app.close();
  }
});

test('a model that is busy elsewhere cannot be seated twice, and a table is lost when the arena restarts', async () => {
  const app = await startServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', loadEnv: false, arena: { tickMs: 20, actionTimeoutMs: 10_000 }, tables: { ...tableOptions, maxRunning: 2, paceMs: 400 } });
  try {
    const first = await postJson(app.url + '/api/tables', { seats: FIVE });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const again = await postJson(app.url + '/api/tables', { seats: ['t1', 't2', 't3', 't4', 't6'] });
    assert.equal(again.status, 409); assert.equal(again.body.error, 'model_busy');
    assert.match(again.body.message, /Test One/);
    // the store marks a table that was still running when the process stopped
    app.tables.stop();
    app.store.loseRunningTables();
    assert.equal(app.store.getTable(first.body.table.id).status, 'lost');
  } finally {
    await app.close();
  }
});
