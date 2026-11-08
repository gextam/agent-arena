import test from 'node:test';
import assert from 'node:assert/strict';
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

async function waitForRunningGame(api) {
  for (let i = 0; i < 100; i++) {
    const { body } = await api('GET', '/api/games?status=running');
    if (body.games.length) return body.games;
    await sleep(50);
  }
  throw new Error('no game started');
}

test('five agents register, join and play a whole game over HTTP', async () => {
  const app = await startServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', arena: { fillWindowMs: 0, actionTimeoutMs: 10_000, tickMs: 50 } });
  try {
    const api = client(app.url);

    const agents = [];
    for (const name of ['Ash', 'Birch', 'Cedar', 'Dune', 'Elm']) {
      const r = await api('POST', '/api/agents/register', { body: { name, description: 'test bot' } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.match(r.body.token, /^ark_/);
      agents.push(r.body);
    }
    const dup = await api('POST', '/api/agents/register', { body: { name: 'ash' } });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.suggestion, 'ash-2');
    assert.equal((await api('POST', '/api/agents/register', { body: { name: '!' } })).status, 400);
    assert.equal((await api('GET', '/api/me')).status, 401);
    assert.equal((await api('GET', '/api/me', { token: 'ark_nope' })).status, 401);

    const me = await api('GET', '/api/me', { token: agents[0].token });
    assert.equal(me.body.agent.name, 'Ash');
    assert.equal(me.body.in_lobby, false);

    for (const a of agents) {
      const r = await api('POST', '/api/lobby/join', { token: a.token, body: { auto_requeue: false } });
      assert.equal(r.status, 200);
    }
    const [game] = await waitForRunningGame(api);
    assert.equal(game.players.length, 5);
    assert.ok(game.players.every(p => p.role === null), 'no roles leak while running');

    const live = (await api('GET', `/api/games/${game.id}`)).body;
    assert.equal(live.secrets, null);
    assert.equal(live.pending.length, 5);

    // a request belongs to its agent only
    const first = await api('GET', '/api/me/pending', { token: agents[0].token });
    assert.ok(first.body.request);
    const stolen = await api('POST', '/api/me/act', { token: agents[1].token, body: { request_id: first.body.request.request_id, action: {} } });
    assert.equal(stolen.status, 409);
    assert.equal(stolen.body.error, 'not_your_request');

    const play = async a => {
      for (;;) {
        const r = await api('GET', '/api/me/pending?wait=5', { token: a.token });
        assert.equal(r.status, 200);
        if (!r.body.request) { if (!r.body.game_id) return; continue; }
        const req = r.body.request;
        assert.equal(req.you.name, a.name);
        let action;
        if (req.type === 'statement') action = { text: `${req.you.name} here. I am a ${req.you.role === 'werewolf' ? 'villager' : req.you.role}.` };
        else if (req.options.length) action = { target: req.options[Math.floor(Math.random() * req.options.length)].player_id };
        else action = {};
        const act = await api('POST', '/api/me/act', { token: a.token, body: { request_id: req.request_id, action, reasoning: `${a.name} thinks` } });
        assert.equal(act.status, 200, JSON.stringify(act.body));
      }
    };
    await Promise.all(agents.map(play));

    const view = (await api('GET', `/api/games/${game.id}`)).body;
    assert.equal(view.status, 'finished');
    assert.ok(['village', 'werewolves', 'draw'].includes(view.winner));
    assert.ok(view.secrets.actions.length > 0, 'reasoning is revealed after the game');
    assert.ok(view.players.every(p => p.role));
    assert.equal(Object.keys(view.ratings).length, 5);

    const lb = (await api('GET', '/api/leaderboard')).body.agents;
    assert.equal(lb.length, 5);
    assert.ok(lb.every(a => a.games === 1));
    assert.ok(lb.some(a => a.rating !== 1500));

    const prof = (await api('GET', `/api/agents/${agents[0].agent_id}`)).body;
    assert.equal(prof.games.length, 1);
    assert.equal(prof.history.length, 1);
    assert.ok(Object.keys(prof.roles).length === 1);

    assert.equal((await api('GET', '/api/games?status=finished')).body.games[0].id, game.id);
    assert.equal((await api('GET', '/api/games/nope')).status, 404);

    const md = await (await fetch(app.url + '/agents.md')).text();
    assert.ok(md.includes(app.url + '/api/agents/register'));
    const health = (await api('GET', '/api/health')).body;
    assert.equal(health.games, 1);
    assert.equal(health.agents, 5);
  } finally {
    await app.close();
  }
});

test('agents that never answer still produce a finished game, with timeout strikes', async () => {
  const app = await startServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', arena: { fillWindowMs: 0, actionTimeoutMs: 80, tickMs: 20 } });
  try {
    const api = client(app.url);
    const tokens = [];
    for (const name of ['Mute1', 'Mute2', 'Mute3', 'Mute4', 'Mute5']) {
      tokens.push((await api('POST', '/api/agents/register', { body: { name } })).body.token);
    }
    for (const t of tokens) await api('POST', '/api/lobby/join', { token: t, body: { auto_requeue: true } });
    const [game] = await waitForRunningGame(api);
    let view;
    for (let i = 0; i < 400; i++) {
      await sleep(50);
      view = (await api('GET', `/api/games/${game.id}`)).body;
      if (view.status === 'finished') break;
    }
    assert.equal(view.status, 'finished');
    assert.equal(view.winner, 'werewolves', 'silent villages lose');
    const lb = (await api('GET', '/api/leaderboard')).body.agents;
    assert.ok(lb.every(a => a.timeouts > 0));
    // auto_requeue put everyone back in the lobby and a second game started
    const lobby = (await api('GET', '/api/lobby')).body;
    const running = (await api('GET', '/api/games?status=running')).body.games;
    assert.ok(lobby.waiting.length + running.length * 5 >= 5);
  } finally {
    await app.close();
  }
});

test('the event stream announces games', async () => {
  const app = await startServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', arena: { fillWindowMs: 0, tickMs: 20 } });
  try {
    const api = client(app.url);
    const ctrl = new AbortController();
    const res = await fetch(app.url + '/api/stream', { signal: ctrl.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const next = async () => { const { value } = await reader.read(); buf += dec.decode(value); return buf; };
    await next();
    assert.ok(buf.includes('"type":"hello"'));
    const t = (await api('POST', '/api/agents/register', { body: { name: 'Streamer' } })).body.token;
    await api('POST', '/api/lobby/join', { token: t });
    for (let i = 0; i < 20 && !buf.includes('"type":"lobby"'); i++) await next();
    assert.ok(buf.includes('"type":"lobby"'));
    ctrl.abort();
  } finally {
    await app.close();
  }
});
