import test from 'node:test';
import assert from 'node:assert/strict';
import { WerewolfGame } from '../src/games/werewolf.js';
import { makeScriptedPlayer, startScriptedBot } from '../bots/scripted-bot.js';
import { renderRequest, toDecision, PERSONAS } from '../bots/claude-bot.js';
import { startServer } from '../src/server.js';

test('reference bots play exactly the number of games they were asked for, then leave', async () => {
  const app = await startServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', arena: { fillWindowMs: 0, tickMs: 20 } });
  try {
    const quiet = () => {};
    const bots = ['Ash', 'Birch', 'Cedar', 'Dune', 'Elm'].map(name => startScriptedBot({ name, baseUrl: app.url, persist: false, games: 2, delayMs: 0, log: quiet }));
    await Promise.all(bots); // hangs if a bot miscounts its games
    const health = await (await fetch(app.url + '/api/health')).json();
    assert.equal(health.games, 2);
    assert.equal(health.running_games, 0);
    assert.equal(health.waiting.length, 0, 'nobody is left waiting in the lobby');
  } finally {
    await app.close();
  }
});

const NAMES = ['Ash', 'Birch', 'Cedar', 'Dune', 'Elm', 'Fern', 'Gale', 'Holt'];

test('the scripted bot plays whole games without an illegal move or a broken sentence', async () => {
  for (const n of [5, 6, 7, 8]) {
    for (let seed = 0; seed < 5; seed++) {
      const players = NAMES.slice(0, n).map((name, i) => ({ agentId: `a${i}`, name }));
      const game = WerewolfGame.create({ players });
      const brains = Object.fromEntries(players.map(p => [p.agentId, makeScriptedPlayer()]));
      let guard = 0;
      while (game.state.status === 'running') {
        for (const req of game.pending.slice()) {
          const payload = game.requestPayload(req);
          const decision = await brains[game.player(req.playerId).agentId](payload);
          const r = game.act(req.requestId, decision);
          assert.ok(r.ok, `${payload.type} by ${payload.you.role}: ${JSON.stringify(r)} <- ${JSON.stringify(decision)}`);
          assert.ok(typeof decision.reasoning === 'string' && decision.reasoning.length > 0, 'every move explains itself');
          assert.ok(!JSON.stringify(decision).includes('undefined'), `no undefined in ${JSON.stringify(decision)}`);
        }
        if (++guard > 5000) throw new Error('did not finish');
      }
      assert.ok(['village', 'werewolves', 'draw'].includes(game.state.winner));
      // the seer never lies in its reasoning, the wolf always admits it
      for (const a of game.state.secrets.actions) {
        if (a.type === 'statement' && game.player(a.playerId).role === 'werewolf') assert.match(a.reasoning, /werewolf/i);
      }
    }
  }
});

test('the Claude bot renders a request as text and maps the model answer to a legal action', () => {
  const players = NAMES.slice(0, 5).map((name, i) => ({ agentId: `a${i}`, name }));
  const game = WerewolfGame.create({ players });
  const wolfReq = game.pending.find(r => game.player(r.playerId).role === 'werewolf');
  const payload = game.requestPayload(wolfReq);
  const text = renderRequest(payload, PERSONAS[0]);
  assert.match(text, /REQUEST: night/);
  assert.match(text, /role werewolf, team werewolves/);
  assert.match(text, /OPTIONS: p\d = /);
  assert.match(text, /INSTRUCTIONS: Night: choose a player to kill/);

  const legal = payload.options.map(o => o.player_id);
  // a proper id passes through
  assert.equal(toDecision(payload, { confessional: 'r', text: null, target: legal[0] }).action.target, legal[0]);
  // a name instead of an id is resolved
  assert.equal(toDecision(payload, { confessional: 'r', text: null, target: payload.options[1].name.toUpperCase() }).action.target, legal[1]);
  // nonsense becomes some legal target rather than an illegal move
  assert.ok(legal.includes(toDecision(payload, { confessional: 'r', text: null, target: 'nobody' }).action.target));
  // statements are capped at the arena's limit
  const speech = toDecision({ ...payload, type: 'statement', options: [] }, { confessional: 'r', text: 'x'.repeat(900), target: null });
  assert.equal(speech.action.text.length, 400);
  // villagers at night send an empty action
  assert.deepEqual(toDecision({ ...payload, options: [] }, { confessional: 'quiet', text: null, target: null }).action, {});
});
