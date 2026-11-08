import test from 'node:test';
import assert from 'node:assert/strict';
import { WerewolfGame, ROLE_TABLE, countRoles, cleanText } from '../src/games/werewolf.js';

// deterministic rng
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const NAMES = ['Ash', 'Birch', 'Cedar', 'Dune', 'Elm', 'Fern', 'Gale', 'Holt'];
const players = n => NAMES.slice(0, n).map((name, i) => ({ agentId: `agent-${i}`, name }));

function newGame(n, seed = 1, options = {}) {
  const clock = { t: 1_000_000 };
  const game = WerewolfGame.create({ id: 'g1', players: players(n), options, rng: lcg(seed), now: () => clock.t });
  return { game, clock };
}

/** Answer every pending request using chooser(req, player) -> action. */
function step(game, chooser) {
  for (const req of game.pending.slice()) {
    const p = game.player(req.playerId);
    assert.ok(p.alive, 'dead players are never asked to act');
    const payload = game.requestPayload(req);
    assert.equal(payload.request_id, req.requestId);
    assert.equal(payload.you.player_id, p.id);
    const r = game.act(req.requestId, { action: chooser(req, p), reasoning: 'because' });
    assert.ok(r.ok, JSON.stringify(r));
  }
}
const randomChooser = rng => (req, p) => {
  if (req.type === 'statement') return { text: `I am ${p.name} and I am innocent.` };
  if (req.options.length) return { target: req.options[Math.floor(rng() * req.options.length)] };
  return {};
};
function playOut(game, rng) {
  let guard = 0;
  while (game.state.status === 'running') {
    assert.ok(game.pending.length > 0, 'a running game always has pending requests');
    step(game, randomChooser(rng));
    if (++guard > 5000) throw new Error('game did not terminate');
  }
}

test('role table: every size has the right number of roles', () => {
  for (const n of [5, 6, 7, 8]) {
    const counts = countRoles(ROLE_TABLE[n]);
    assert.equal(ROLE_TABLE[n].length, n);
    assert.ok(counts.werewolf >= 1);
    assert.equal(counts.seer, 1);
    assert.ok(counts.werewolf < n - counts.werewolf, 'village starts with the majority');
  }
});

test('random games terminate with a consistent winner at every table size', () => {
  for (const n of [5, 6, 7, 8]) {
    for (let seed = 1; seed <= 25; seed++) {
      const { game } = newGame(n, seed);
      playOut(game, lcg(seed * 7919));
      const s = game.state;
      assert.ok(['village', 'werewolves', 'draw'].includes(s.winner), `winner ${s.winner}`);
      assert.equal(s.log.at(-1).type, 'game_over');
      assert.equal(s.pending.length, 0);
      const alive = s.players.filter(p => p.alive);
      const wolves = alive.filter(p => p.role === 'werewolf').length;
      if (s.winner === 'village') assert.equal(wolves, 0);
      if (s.winner === 'werewolves') assert.ok(wolves >= alive.length - wolves);
      // every statement has its private reasoning recorded
      const statements = s.log.filter(e => e.type === 'statement');
      const secretStatements = s.secrets.actions.filter(a => a.type === 'statement');
      assert.equal(statements.length, secretStatements.length);
    }
  }
});

test('spectators see no roles or secrets while the game runs, everything when it ends', () => {
  const { game } = newGame(5, 3);
  const live = game.publicView();
  assert.ok(live.players.every(p => p.role === null));
  assert.equal(live.secrets, null);
  assert.equal(live.pending.length, 5, 'all five players get a night request, villagers included');
  playOut(game, lcg(3));
  const done = game.publicView();
  assert.ok(done.players.every(p => p.role));
  assert.ok(done.secrets.actions.length > 0);
  assert.ok(done.log.some(e => e.type === 'game_over' && e.roles));
});

test('the doctor saves the werewolves\' target', () => {
  const { game } = newGame(6, 11); // six players: one werewolf, one seer, one doctor
  const wolf = game.state.players.find(p => p.role === 'werewolf');
  const target = game.state.players.find(p => p.role === 'villager');
  step(game, (req, p) => {
    if (p.role === 'werewolf') return { target: target.id };
    if (p.role === 'doctor') return { target: target.id };
    if (req.options.length) return { target: req.options[0] };
    return {};
  });
  const dawn = game.state.log.find(e => e.type === 'dawn');
  assert.equal(dawn.victim, null);
  assert.ok(target.alive);
  assert.equal(game.state.phase, 'day_discussion');
  const result = game.state.secrets.actions.find(a => a.type === 'night_result');
  assert.equal(result.saved, true);
  assert.equal(result.wolfTarget, target.id);
  assert.ok(wolf.alive);
});

test('the seer learns alignments privately', () => {
  const { game } = newGame(5, 5);
  const seer = game.state.players.find(p => p.role === 'seer');
  const wolf = game.state.players.find(p => p.role === 'werewolf');
  step(game, (req, p) => {
    if (p.role === 'seer') return { target: wolf.id };
    if (req.options.length) return { target: req.options.find(id => id !== seer.id) || req.options[0] };
    return {};
  });
  // next request for the seer (a statement or a vote) carries the inspection
  const req = game.pending.find(r => r.playerId === seer.id) || game.pending[0];
  const payload = game.requestPayload({ ...req, playerId: seer.id });
  assert.deepEqual(payload.you.inspections.map(i => [i.player_id, i.result]), [[wolf.id, 'werewolf']]);
  // and nothing about it is public
  assert.ok(!JSON.stringify(game.state.log).includes('inspection'));
});

test('a tied vote eliminates nobody and the game goes on', () => {
  const { game } = newGame(5, 8);
  step(game, randomChooser(lcg(8)));                      // night 1: one villager dies
  while (game.state.phase === 'day_discussion') step(game, randomChooser(lcg(9)));
  assert.equal(game.state.phase, 'day_vote');
  const voters = game.pending.map(r => r.playerId);
  assert.equal(voters.length, 4);
  // pair everyone up: a->b, b->a, c->d, d->c
  const partner = { [voters[0]]: voters[1], [voters[1]]: voters[0], [voters[2]]: voters[3], [voters[3]]: voters[2] };
  step(game, (req, p) => ({ target: partner[p.id] }));
  const vr = game.state.log.findLast(e => e.type === 'vote_result');
  assert.equal(vr.tie, true);
  assert.equal(vr.eliminated, null);
  assert.equal(game.state.round, 2);
  assert.equal(game.state.phase, 'night');
});

test('expired requests get default actions and count as timeouts', () => {
  const { game, clock } = newGame(5, 2, { actionTimeoutMs: 1000 });
  assert.equal(game.expire(clock.t + 999), 0, 'nothing expires before the deadline');
  assert.equal(game.expire(clock.t + 1000), 5);
  // the werewolf picked a random victim, so the day started
  assert.equal(game.state.phase, 'day_discussion');
  assert.ok(game.state.log.find(e => e.type === 'dawn').victim);
  assert.equal(Object.keys(game.state.stats.timeouts).length, 5);
  // a timed-out statement is recorded as an empty statement
  clock.t += 5000;
  assert.equal(game.expire(clock.t), 1);
  const st = game.state.log.find(e => e.type === 'statement');
  assert.equal(st.text, '');
  assert.equal(st.timedOut, true);
});

test('invalid actions are rejected without changing the game', () => {
  const { game } = newGame(5, 4);
  const wolfReq = game.pending.find(r => game.player(r.playerId).role === 'werewolf');
  const before = JSON.stringify(game.state);
  assert.equal(game.act('nope', { action: {} }).error, 'unknown_request');
  assert.equal(game.act(wolfReq.requestId, { action: { target: 'p99' } }).error, 'invalid_target');
  assert.equal(game.act(wolfReq.requestId, { action: { target: wolfReq.playerId } }).error, 'invalid_target');
  assert.equal(JSON.stringify(game.state), before);
  step(game, randomChooser(lcg(4)));
  const speak = game.pending[0];
  assert.equal(speak.type, 'statement');
  assert.equal(game.act(speak.requestId, { action: { target: 'p1' } }).error, 'missing_text');
});

test('statements are cleaned and capped, and show up in the transcript', () => {
  const { game } = newGame(5, 6, { statementMaxChars: 20 });
  step(game, randomChooser(lcg(6)));
  const speaker = game.player(game.pending[0].playerId);
  game.act(game.pending[0].requestId, { action: { text: '  Hello\n\n there,  this is a very long statement indeed ' }, reasoning: 'x' });
  const st = game.state.log.findLast(e => e.type === 'statement');
  assert.equal(st.text.length, 20);
  assert.ok(st.text.startsWith('Hello there, this'));
  assert.ok(game.transcript().some(l => l.startsWith(`${speaker.name} (pass 1): "Hello there`)));
  assert.equal(cleanText(123, 10), '');
});
