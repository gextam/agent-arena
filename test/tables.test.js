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

// two cheap OpenRouter models the house pays for, answered by the fake OpenRouter below (the tests never go online)
const cheap = (id, name) => ({ id, vendor: 'z-ai', name, model: `z-ai/${id}`, openrouter: `z-ai/${id}`, released: '2026-03-01', price: { in: 0.1, out: 0.2 }, provider: 'openrouter', reasoning: false, json: false });
const BUDGET_CATALOG = [...TEST_CATALOG, scripted(7, 'Test Seven'), scripted(8, 'Test Eight'), cheap('cheap1', 'Cheap One'), cheap('cheap2', 'Cheap Two')];
const HOUSE_KEY = 'sk-or-house-0123456789', VISITOR_KEY = 'sk-or-visitor-9876543210';
/** Stand in for OpenRouter: every call gets a legal-enough decision, a reasoning line and the given cost. */
function fakeOpenRouter(costPerCall) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://openrouter.ai/')) return real(url, init);
    calls.push({ auth: init.headers.authorization, body: JSON.parse(init.body) });
    const content = JSON.stringify({ target: 'p3', text: 'I am a plain villager, honestly.', lie: false, confessional: 'A test move.' });
    const reply = { model: 'z-ai/fake', choices: [{ message: { content, reasoning: 'fake reasoning' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 50, cost: costPerCall } };
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, restore() { globalThis.fetch = real; } };
}
const finished = (app, id) => until(async () => { const v = (await json(app.url + `/api/tables/${id}`)).body; return v.table.status === 'finished' ? v : null; }, `table ${id} to finish`, { tries: 1200 });

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

test('the house stops paying at its daily dollar budget: refused ahead by the estimate, cut to neutral moves past it, then every seat on the visitor\'s key', async () => {
  const fake = fakeOpenRouter(0.02);
  const app = await startServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', loadEnv: false, arena: { tickMs: 20, actionTimeoutMs: 10_000 }, tables: { ...tableOptions, catalog: BUDGET_CATALOG, keys: { anthropic: '', openrouter: HOUSE_KEY }, houseBudgetUsd: 0.04, perClientDay: 10 } });
  try {
    let cat = (await json(app.url + '/api/tables/catalog')).body;
    assert.deepEqual([cat.limits.house_budget_usd, cat.limits.house_spent_usd, cat.limits.house_left_usd, cat.limits.house_closed, cat.limits.your_house_tables_today], [0.04, 0, 0.04, null, 0]);
    assert.ok(cat.models.find(m => m.id === 'cheap1').house, 'a cheap model is on the house while the budget lasts');
    assert.deepEqual(cat.models.find(m => m.id === 'cheap1').needs, []);

    // a table that would take the house past its budget is refused before it starts (two cheap seats estimate at $0.011)
    app.tables.spend.push({ t: Date.now(), usd: 0.035 });
    const two = ['cheap1', 'cheap2', 't1', 't2', 't3'];
    let r = await postJson(app.url + '/api/tables', { seats: two });
    assert.equal(r.status, 429); assert.equal(r.body.error, 'budget_spent');
    assert.equal(r.body.spent_usd, 0.035); assert.equal(r.body.budget_usd, 0.04); assert.ok(r.body.retry_after_s >= 60);
    assert.equal(app.tables.houseClosed(), null, 'under the budget the house is still open');

    // with $0.025 spent the estimate fits; the two fake seats then cost two cents a move and the budget runs out on the first
    app.tables.spend.length = 0;
    app.tables.spend.push({ t: Date.now(), usd: 0.025 });
    r = await postJson(app.url + '/api/tables', { seats: two });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.table.paid_by, 'house');
    assert.ok(r.body.table.seats.slice(0, 2).every(s => s.route === 'openrouter' && s.paid_by === 'house'));
    const done = await finished(app, r.body.table.id);
    const mine = done.table.thoughts.filter(th => th.seat <= 2);
    const paid = mine.filter(th => !th.stand_in), cut = mine.filter(th => th.stand_in);
    assert.ok(paid.length >= 1 && paid.length <= 2, `${paid.length} paid moves (the night moves that went out before the budget was gone)`);
    assert.ok(cut.length >= 1, 'later moves of the house seats were neutral');
    for (const th of cut) { assert.match(th.error, /budget/); assert.equal(th.cost_usd, 0); assert.equal(th.thinking, null); assert.equal(th.applied, true); }
    for (const th of paid) { assert.equal(th.cost_usd, 0.02); assert.equal(th.thinking, 'fake reasoning'); assert.equal(th.served_by, 'z-ai/fake'); }
    assert.equal(done.table.totals.cost_usd, Math.round(paid.length * 0.02 * 1e6) / 1e6);
    assert.equal(fake.calls.length, paid.length);
    assert.ok(fake.calls.every(c => c.auth === `Bearer ${HOUSE_KEY}`), 'the house key was used');
    const spentAfter = app.tables.houseSpent();
    assert.ok(spentAfter >= 0.04, `${spentAfter} spent`);
    assert.equal(app.tables.houseClosed(), 'budget');

    // the house is closed: cheap models now need the visitor's key like any other
    cat = (await json(app.url + '/api/tables/catalog')).body;
    assert.equal(cat.limits.house_closed, 'budget');
    assert.equal(cat.limits.house_left_usd, 0);
    assert.ok(cat.limits.house_reopens_s >= 60);
    assert.equal(cat.models.find(m => m.id === 'cheap1').house, false);
    assert.deepEqual(cat.models.find(m => m.id === 'cheap1').needs, ['openrouter']);
    assert.ok(cat.models.find(m => m.id === 't1').house, 'scripted seats cost nothing and stay on the house');
    r = await postJson(app.url + '/api/tables', { seats: ['cheap1', 't1', 't2', 't3', 't4'] });
    assert.equal(r.status, 429); assert.equal(r.body.error, 'house_closed'); assert.equal(r.body.reason, 'budget');
    assert.deepEqual(r.body.models, ['cheap1']); assert.deepEqual(r.body.keys, ['openrouter']);
    assert.match(r.body.message, /\$0\.04/);
    // ... and with one, the table runs on it and costs the house nothing
    const before = fake.calls.length;
    r = await postJson(app.url + '/api/tables', { seats: ['cheap1', 't1', 't2', 't3', 't4'], keys: { openrouter: VISITOR_KEY } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.table.paid_by, 'visitor');
    assert.equal(r.body.table.seats[0].paid_by, 'visitor');
    const yours = await finished(app, r.body.table.id);
    const played = yours.table.thoughts.filter(th => th.seat === 1);
    assert.ok(played.length >= 1 && played.every(th => !th.stand_in && th.cost_usd === 0.02), 'every move of the visitor-paid seat was answered');
    assert.ok(fake.calls.slice(before).length === played.length && fake.calls.slice(before).every(c => c.auth === `Bearer ${VISITOR_KEY}`), 'the visitor key was used');
    assert.equal(app.tables.houseSpent(), spentAfter, 'the visitor\'s moves are not on the house ledger');
  } finally {
    await app.close();
    fake.restore();
  }
});

test('a visitor gets a daily share of house-paid tables; past it their tables run on their own key', async () => {
  const fake = fakeOpenRouter(0.001);
  const app = await startServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', loadEnv: false, arena: { tickMs: 20, actionTimeoutMs: 10_000 }, tables: { ...tableOptions, catalog: BUDGET_CATALOG, keys: { anthropic: '', openrouter: HOUSE_KEY }, houseBudgetUsd: 10, perClientDay: 1, maxRunning: 2 } });
  try {
    let cat = (await json(app.url + '/api/tables/catalog')).body;
    assert.equal(cat.limits.per_client_day, 1);
    assert.equal(cat.limits.your_house_tables_today, 0);
    let r = await postJson(app.url + '/api/tables', { seats: ['cheap1', 't1', 't2', 't3', 't4'] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.table.paid_by, 'house');
    const first = r.body.table.id;
    cat = (await json(app.url + '/api/tables/catalog')).body;
    assert.equal(cat.limits.your_house_tables_today, 1);
    assert.equal(cat.limits.house_closed, 'per_client');
    assert.equal(cat.models.find(m => m.id === 'cheap2').house, false);
    r = await postJson(app.url + '/api/tables', { seats: ['cheap2', 't5', 't6', 't7', 't8'] });
    assert.equal(r.status, 429); assert.equal(r.body.error, 'house_closed'); assert.equal(r.body.reason, 'per_client');
    assert.match(r.body.message, /1 table a day per visitor/);
    r = await postJson(app.url + '/api/tables', { seats: ['cheap2', 't5', 't6', 't7', 't8'], keys: { openrouter: VISITOR_KEY } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.table.paid_by, 'visitor');
    const [a, b] = await Promise.all([finished(app, first), finished(app, r.body.table.id)]);
    const houseMoves = a.table.thoughts.filter(th => th.seat === 1 && !th.stand_in).length;
    assert.ok(houseMoves >= 1);
    assert.equal(app.tables.houseSpent(), Math.round(houseMoves * 0.001 * 1e6) / 1e6, 'only the house-paid seat is on the ledger');
    assert.ok(b.table.thoughts.filter(th => th.seat === 1).every(th => !th.stand_in));
    assert.ok(fake.calls.some(c => c.auth === `Bearer ${HOUSE_KEY}`) && fake.calls.some(c => c.auth === `Bearer ${VISITOR_KEY}`));
    assert.equal((await json(app.url + '/api/tables/catalog')).body.limits.house_spent_usd, app.tables.houseSpent());
  } finally {
    await app.close();
    fake.restore();
  }
});
