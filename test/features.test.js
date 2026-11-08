// The v0.2 features over HTTP: the truth ledger, pack whispers, the message board, spectator chat,
// guess the wolf, applause and highlights, webhooks, stats and the new pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { startServer } from '../src/server.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function client(base) {
  return async (method, path, { token, body } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
}
async function register(api, names, model = 'test-model') {
  const out = [];
  for (const name of names) {
    const r = await api('POST', '/api/agents/register', { body: { name, description: 'test bot', model } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    out.push(r.body);
  }
  return out;
}
async function waitForRunningGame(api) {
  for (let i = 0; i < 100; i++) {
    const { body } = await api('GET', '/api/games?status=running');
    if (body.games.length) return body.games[0];
    await sleep(50);
  }
  throw new Error('no game started');
}
async function waitForPhase(api, gameId, phase) {
  for (let i = 0; i < 200; i++) {
    const { body } = await api('GET', `/api/games/${gameId}`);
    if (body.phase === phase || body.status === 'finished') return body;
    await sleep(30);
  }
  throw new Error('phase never reached: ' + phase);
}
const legalAction = req => {
  if (req.type === 'statement') return { text: `${req.you.name} says: I am a plain villager.`, lie: req.you.role === 'werewolf' };
  if (req.options.length) return { target: req.options[Math.floor(Math.random() * req.options.length)].player_id };
  return {};
};
/** Poll-and-act loop for one agent until it leaves the game. */
async function play(api, a, { onRequest } = {}) {
  for (;;) {
    const r = await api('GET', '/api/me/pending?wait=5', { token: a.token });
    assert.equal(r.status, 200);
    if (!r.body.request) { if (!r.body.game_id) return; continue; }
    const req = r.body.request;
    if (onRequest) await onRequest(req);
    const act = await api('POST', '/api/me/act', { token: a.token, body: { request_id: req.request_id, action: legalAction(req), reasoning: `${a.name} thinks` } });
    assert.equal(act.status, 200, JSON.stringify(act.body));
  }
}

test('truth ledger, whispers, guesses, chat, applause, highlights and stats over one game', async () => {
  const app = await startServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', humanGamesUrl: 'https://example.com/games/', arena: { fillWindowMs: 0, actionTimeoutMs: 10_000, tickMs: 50 } });
  try {
    const api = client(app.url);
    const cfg = (await api('GET', '/api/config')).body;
    assert.equal(cfg.rating_name, 'Guile');
    assert.equal(cfg.human_games_url, 'https://example.com/games/');
    assert.equal(cfg.features.truth_ledger, true);

    const agents = await register(api, ['Ash', 'Birch', 'Cedar', 'Dune', 'Elm']);
    for (const a of agents) await api('POST', '/api/lobby/join', { token: a.token, body: {} });
    const game = await waitForRunningGame(api);

    // night 1: every agent holds a night request; find the wolf and the villagers
    const firsts = [];
    for (const a of agents) { const r = await api('GET', '/api/me/pending', { token: a.token }); firsts.push({ a, req: r.body.request }); }
    const wolf = firsts.find(x => x.req.you.role === 'werewolf');
    const villager = firsts.find(x => x.req.you.role === 'villager');
    assert.ok(wolf && villager);
    const w1 = await api('POST', '/api/me/whisper', { token: wolf.a.token, body: { text: 'Pack: I will go for the loud one.' } });
    assert.equal(w1.status, 200, JSON.stringify(w1.body));
    assert.equal(w1.body.whispers.length, 1);
    const w2 = await api('POST', '/api/me/whisper', { token: villager.a.token, body: { text: 'psst' } });
    assert.equal(w2.status, 409);
    assert.equal(w2.body.error, 'not_a_werewolf');
    const again = (await api('GET', '/api/me/pending', { token: wolf.a.token })).body.request;
    assert.equal(again.you.pack_whispers.length, 1, 'the wolf reads its own whisper back');
    assert.ok(!JSON.stringify((await api('GET', `/api/games/${game.id}`)).body.log).includes('loud one'), 'whispers never reach the public log');

    // a viewer guesses while the table is live; the tally stays sealed
    const alive = (await api('GET', `/api/games/${game.id}`)).body.players.filter(p => p.alive);
    assert.equal((await api('POST', `/api/games/${game.id}/guess`, { body: { viewer: 'bad id!', target: alive[0].id } })).status, 400);
    const g1 = await api('POST', `/api/games/${game.id}/guess`, { body: { viewer: 'viewer_one', target: wolf.req.you.player_id } });
    assert.equal(g1.status, 200, JSON.stringify(g1.body));
    await api('POST', `/api/games/${game.id}/guess`, { body: { viewer: 'viewer_two', target: villager.req.you.player_id } });
    await api('POST', `/api/games/${game.id}/guess`, { body: { viewer: 'viewer_three', target: wolf.req.you.player_id } });
    const sealed = (await api('GET', `/api/games/${game.id}/guesses?viewer=viewer_one`)).body;
    assert.equal(sealed.hidden, true);
    assert.equal(sealed.total, 3);
    assert.equal(sealed.mine, wolf.req.you.player_id);
    assert.equal(sealed.counts, undefined);

    // viewers chat; agents cannot see it; the limiter bites after five quick messages
    const c1 = await api('POST', `/api/games/${game.id}/chat`, { body: { name: 'Nora', text: 'I think Cedar is lying' } });
    assert.equal(c1.status, 201);
    let limited = 0;
    for (let i = 0; i < 6; i++) { const r = await api('POST', `/api/games/${game.id}/chat`, { body: { name: 'Nora', text: `msg ${i}` } }); if (r.status === 429) limited++; }
    assert.ok(limited >= 1, 'chat is rate limited');
    const chat = (await api('GET', `/api/games/${game.id}/chat`)).body.messages;
    assert.equal(chat[0].name, 'Nora');
    assert.ok(!JSON.stringify(again).includes('Cedar is lying'));

    // act on the night, then whispering by day is refused
    for (const { a, req } of firsts) assert.equal((await api('POST', '/api/me/act', { token: a.token, body: { request_id: req.request_id, action: legalAction(req), reasoning: 'night' } })).status, 200);
    const day = await waitForPhase(api, game.id, 'day_discussion');
    if (day.status !== 'finished') {
      const w3 = await api('POST', '/api/me/whisper', { token: wolf.a.token, body: { text: 'too late' } });
      assert.equal(w3.status, 409);
      assert.equal(w3.body.error, 'not_night');
    }

    // finish the game
    await Promise.all(agents.map(a => play(api, a)));
    const view = (await api('GET', `/api/games/${game.id}`)).body;
    assert.equal(view.status, 'finished');
    const statements = view.secrets.actions.filter(a => a.type === 'statement');
    assert.ok(statements.some(a => a.lie === true), 'the wolf declared lies in the ledger');
    assert.ok(statements.some(a => a.lie === false), 'villagers declared the truth');
    assert.ok(view.secrets.actions.some(a => a.type === 'whisper' && a.text.includes('loud one')), 'the whisper is published after the game');
    assert.ok(view.stats.lies[wolf.req.you.player_id] >= 1);

    // guesses close and are revealed with the answer
    assert.equal((await api('POST', `/api/games/${game.id}/guess`, { body: { viewer: 'viewer_one', target: alive[0].id } })).status, 409);
    const open = (await api('GET', `/api/games/${game.id}/guesses?viewer=viewer_one`)).body;
    assert.equal(open.hidden, false);
    assert.equal(open.total, 3);
    assert.equal(open.crowd_pick, wolf.req.you.player_id);
    assert.equal(open.crowd_right, true);
    assert.equal(open.mine_right, true);
    assert.deepEqual(open.wolves, [wolf.req.you.player_id]);

    // applause for the best lie
    const lieSeq = statements.find(a => a.lie === true).seq;
    assert.equal((await api('POST', `/api/games/${game.id}/applaud`, { body: { viewer: 'viewer_one', seq: 'x' } })).status, 400);
    const ap = await api('POST', `/api/games/${game.id}/applaud`, { body: { viewer: 'viewer_one', seq: lieSeq } });
    assert.equal(ap.status, 200, JSON.stringify(ap.body));
    assert.equal(ap.body.applause[lieSeq], 1);
    const hl = (await api('GET', '/api/highlights')).body.highlights;
    assert.ok(hl.length >= 1);
    assert.equal(hl[0].seq, lieSeq, 'the applauded lie ranks first');
    assert.equal(hl[0].declared, true);
    assert.equal(hl[0].gameId, game.id);

    // the leaderboard carries the ledger, stats carry the crowd
    const lb = (await api('GET', '/api/leaderboard')).body;
    assert.equal(lb.rating_name, 'Guile');
    const wolfRow = lb.agents.find(a => a.name === wolf.a.name);
    assert.ok(wolfRow.lies >= 1 && wolfRow.statements >= wolfRow.lies);
    assert.equal(wolfRow.model, 'test-model');
    assert.equal(wolfRow.guile, wolfRow.rating);
    const stats = (await api('GET', '/api/stats')).body;
    assert.equal(stats.games, 1);
    assert.ok(stats.lies >= 1);
    assert.equal(stats.models, 1);
    assert.equal(stats.crowd.games, 1);
    assert.equal(stats.crowd.correct, 1);

    // pages
    for (const p of ['/board', '/humans', '/']) {
      const res = await fetch(app.url + p);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/html/);
    }
  } finally {
    await app.close();
  }
});

test('the agent message board: agents post, with a cooldown; humans read', async () => {
  const app = await startServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', arena: { tickMs: 50 } });
  try {
    const api = client(app.url);
    const [a] = await register(api, ['Poster']);
    assert.equal((await api('POST', '/api/board', { body: { text: 'no token' } })).status, 401);
    assert.equal((await api('POST', '/api/board', { token: a.token, body: { text: '   ' } })).status, 400);
    const p1 = await api('POST', '/api/board', { token: a.token, body: { text: 'Poster here. <b>bold</b> stays text.' } });
    assert.equal(p1.status, 201, JSON.stringify(p1.body));
    assert.equal(p1.body.post.agent.name, 'Poster');
    const p2 = await api('POST', '/api/board', { token: a.token, body: { text: 'again' } });
    assert.equal(p2.status, 429);
    assert.ok(p2.body.retry_after_s > 0);
    const list = (await api('GET', '/api/board')).body;
    assert.equal(list.posts.length, 1);
    assert.equal(list.posts[0].text, 'Poster here. <b>bold</b> stays text.');
    assert.equal(list.cooldown_s, 300);
    assert.equal((await api('GET', '/api/stats')).body.board_posts, 1);
  } finally {
    await app.close();
  }
});

test('webhooks: an agent that never polls receives signed requests and the game-over notice', async () => {
  const app = await startServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', allowPrivateWebhooks: true, arena: { fillWindowMs: 0, actionTimeoutMs: 10_000, tickMs: 50 } });
  const received = [];
  let hookAgent = null;
  const api = client(app.url);
  // the agent's own server: it answers every request it is pushed
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      received.push({ headers: req.headers, body: JSON.parse(body), raw: body });
      res.writeHead(200); res.end('ok');
      const ev = JSON.parse(body);
      if (ev.event === 'request') {
        const r = ev.request;
        await api('POST', '/api/me/act', { token: hookAgent.token, body: { request_id: r.request_id, action: legalAction(r), reasoning: 'pushed' } });
      }
    });
  });
  await new Promise(r => receiver.listen(0, '127.0.0.1', r));
  try {
    const agents = await register(api, ['Hook', 'Poll1', 'Poll2', 'Poll3', 'Poll4']);
    hookAgent = agents[0];
    const bad = await api('POST', '/api/me/webhook', { token: hookAgent.token, body: { url: 'ftp://example.com/x' } });
    assert.equal(bad.status, 400);
    const url = `http://127.0.0.1:${receiver.address().port}/hook`;
    const set = await api('POST', '/api/me/webhook', { token: hookAgent.token, body: { url } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.match(set.body.secret, /^whs_/);
    const me = (await api('GET', '/api/me', { token: hookAgent.token })).body;
    assert.equal(me.agent.webhook.url, url);
    assert.equal(me.agent.webhook_secret, undefined);

    for (const a of agents) await api('POST', '/api/lobby/join', { token: a.token, body: {} });
    const game = await waitForRunningGame(api);
    // the four pollers play; the hooked agent only ever reacts to deliveries
    await Promise.all(agents.slice(1).map(a => play(api, a)));
    for (let i = 0; i < 100 && (await api('GET', `/api/games/${game.id}`)).body.status !== 'finished'; i++) await sleep(50);
    const view = (await api('GET', `/api/games/${game.id}`)).body;
    assert.equal(view.status, 'finished');

    const requests = received.filter(r => r.body.event === 'request');
    assert.ok(requests.length >= 1, 'the hooked agent was pushed its requests');
    assert.equal(requests[0].headers['x-arena-event'], 'request');
    assert.equal(requests[0].body.agent_id, hookAgent.agent_id);
    const sig = 'sha256=' + createHmac('sha256', set.body.secret).update(requests[0].raw).digest('hex');
    assert.equal(requests[0].headers['x-arena-signature'], sig, 'deliveries are signed with the agent secret');
    for (let i = 0; i < 40 && !received.some(r => r.body.event === 'game_over'); i++) await sleep(50);
    const over = received.find(r => r.body.event === 'game_over');
    assert.ok(over, 'the game-over notice was pushed');
    assert.equal(over.body.game_id, game.id);
    assert.ok(['werewolves', 'village', 'draw'].includes(over.body.winner));
    const hooked = view.players.find(p => p.agentId === hookAgent.agent_id);
    assert.equal(view.stats.timeouts[hooked.id] || 0, 0, 'the hooked agent never timed out');

    assert.equal((await api('DELETE', '/api/me/webhook', { token: hookAgent.token })).status, 200);
    assert.equal((await api('GET', '/api/me', { token: hookAgent.token })).body.agent.webhook, null);
  } finally {
    receiver.close();
    await app.close();
  }
});

test('private webhook targets are refused unless the arena allows them', async () => {
  const app = await startServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', arena: { tickMs: 50 } });
  try {
    const api = client(app.url);
    const [a] = await register(api, ['Local']);
    for (const url of ['http://127.0.0.1:9/x', 'http://localhost/x', 'http://10.1.2.3/x', 'http://[::1]/x', 'not a url']) {
      const r = await api('POST', '/api/me/webhook', { token: a.token, body: { url } });
      assert.equal(r.status, 400, url);
    }
  } finally {
    await app.close();
  }
});
