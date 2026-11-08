// Werewolf game engine: a pure state machine. No timers, no I/O, no network.
// The arena (src/arena.js) drives it: it hands out pending requests to agents,
// feeds actions back in with act(), and calls expire() when deadlines pass.
//
// Public information lives in state.log (what spectators see live).
// Private information lives in state.secrets (revealed when the game ends).
import { randomUUID } from 'node:crypto';

export const KIND = 'werewolf';
export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 8;

export const ROLE_TABLE = {
  5: ['werewolf', 'seer', 'villager', 'villager', 'villager'],
  6: ['werewolf', 'seer', 'doctor', 'villager', 'villager', 'villager'],
  7: ['werewolf', 'werewolf', 'seer', 'doctor', 'villager', 'villager', 'villager'],
  8: ['werewolf', 'werewolf', 'seer', 'doctor', 'villager', 'villager', 'villager', 'villager'],
};

export const ROLES = {
  werewolf: { team: 'werewolves', label: 'Werewolf' },
  seer: { team: 'village', label: 'Seer' },
  doctor: { team: 'village', label: 'Doctor' },
  villager: { team: 'village', label: 'Villager' },
};

export const RULES_TEXT =
  'Werewolf. The werewolves know each other and kill one player every night. ' +
  'The seer learns whether one player is a werewolf every night. The doctor protects one player every night ' +
  '(if the werewolves target that player, nobody dies). Villagers have no night power. ' +
  'Every day the living players speak in turn, then everyone votes. The player with the most votes is eliminated; ' +
  'a tie eliminates nobody. The role of every dead player is revealed. ' +
  'The village wins when every werewolf is dead. The werewolves win when they equal or outnumber the other players.';

export const DEFAULT_OPTIONS = {
  discussionRounds: 2,      // passes of statements per day
  statementMaxChars: 400,
  reasoningMaxChars: 1500,
  maxRounds: 10,            // safety valve: the game is a draw after this many rounds
  actionTimeoutMs: 45_000,  // per request
};

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];

export function countRoles(roles) {
  const out = {};
  for (const r of roles) out[r] = (out[r] || 0) + 1;
  return out;
}

export function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const t = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export class WerewolfGame {
  /** @param {object} state serialized state  @param {{rng?: () => number, now?: () => number}} [deps] */
  constructor(state, { rng = Math.random, now = Date.now } = {}) {
    this.state = state;
    this.rng = rng;
    this.now = now;
  }

  /** Create and start a new game. players: [{agentId, name}] */
  static create({ id = randomUUID(), players, options = {}, rng = Math.random, now = Date.now }) {
    const n = players.length;
    if (!ROLE_TABLE[n]) throw new Error(`Werewolf needs ${MIN_PLAYERS}-${MAX_PLAYERS} players, got ${n}`);
    const roles = shuffle(ROLE_TABLE[n], rng);
    const state = {
      id,
      kind: KIND,
      status: 'running',
      createdAt: now(),
      finishedAt: null,
      winner: null,
      options: { ...DEFAULT_OPTIONS, ...options },
      players: players.map((p, i) => ({
        id: `p${i + 1}`, agentId: p.agentId, name: p.name, role: roles[i],
        alive: true, diedRound: null, causeOfDeath: null,
      })),
      round: 0,
      phase: 'setup',
      step: 0,
      night: null,
      discussion: null,
      vote: null,
      pending: [],
      log: [],
      secrets: { actions: [], inspections: {} },
      stats: { timeouts: {} },
      ratings: null,
    };
    const game = new WerewolfGame(state, { rng, now });
    game._log({ type: 'game_start', players: state.players.map(p => ({ id: p.id, name: p.name })), roleCounts: countRoles(roles) });
    game._startNight();
    return game;
  }

  // ---- helpers -------------------------------------------------------------
  get id() { return this.state.id; }
  get pending() { return this.state.pending; }
  player(id) { return this.state.players.find(p => p.id === id); }
  alive() { return this.state.players.filter(p => p.alive); }
  playerByAgent(agentId) { return this.state.players.find(p => p.agentId === agentId); }

  _log(ev) {
    const s = this.state;
    const entry = { seq: s.log.length, t: this.now(), round: s.round, phase: s.phase, ...ev };
    s.log.push(entry);
    return entry;
  }
  _secret(ev) {
    this.state.secrets.actions.push({ t: this.now(), round: this.state.round, phase: this.state.phase, ...ev });
  }
  _requests(list) {
    const s = this.state;
    s.step++;
    const t = this.now();
    const deadline = t + s.options.actionTimeoutMs;
    s.pending = list.map(r => ({
      requestId: `${s.id}:${s.step}:${r.playerId}`, playerId: r.playerId, type: r.type,
      options: r.options, createdAt: t, deadline,
    }));
  }
  _timeout(playerId) {
    const t = this.state.stats.timeouts;
    t[playerId] = (t[playerId] || 0) + 1;
  }

  // ---- night ---------------------------------------------------------------
  _startNight() {
    const s = this.state;
    s.round++;
    s.phase = 'night';
    s.night = { kills: {}, seer: null, doctor: null };
    this._log({ type: 'phase', phase: 'night' });
    // Every living player gets a night request, villagers included (they "sleep"),
    // so that request timing never leaks who has a role.
    this._requests(this.alive().map(p => ({ playerId: p.id, type: 'night', options: this._nightOptions(p) })));
  }
  _nightOptions(p) {
    const alive = this.alive();
    switch (p.role) {
      case 'werewolf': return alive.filter(x => x.role !== 'werewolf').map(x => x.id);
      case 'seer': return alive.filter(x => x.id !== p.id).map(x => x.id);
      case 'doctor': return alive.map(x => x.id);
      default: return [];
    }
  }
  _applyNight(req, action, reasoning, timedOut) {
    const s = this.state;
    const p = this.player(req.playerId);
    const n = s.night;
    let target = action && typeof action.target === 'string' ? action.target : null;
    if (timedOut) target = p.role === 'werewolf' && req.options.length ? pick(req.options, this.rng) : null;
    if (target && !req.options.includes(target)) target = null;
    let result = null;
    switch (p.role) {
      case 'werewolf':
        if (target) n.kills[p.id] = target;
        break;
      case 'seer':
        if (target) {
          result = this.player(target).role === 'werewolf' ? 'werewolf' : 'not_werewolf';
          (s.secrets.inspections[p.id] ||= []).push({ round: s.round, target, result });
        }
        break;
      case 'doctor':
        if (target) n.doctor = target;
        break;
      default:
        break;
    }
    this._secret({ type: 'night_action', playerId: p.id, role: p.role, target, result, reasoning, timedOut });
    if (timedOut) this._timeout(p.id);
    if (!s.pending.length) this._resolveNight();
  }
  _resolveNight() {
    const s = this.state;
    const n = s.night;
    const choices = Object.values(n.kills);
    let victimId = null;
    if (choices.length) {
      const tally = countRoles(choices);
      const max = Math.max(...Object.values(tally));
      victimId = pick(Object.keys(tally).filter(k => tally[k] === max), this.rng);
    }
    const saved = !!(victimId && n.doctor === victimId);
    let died = null;
    if (victimId && !saved) {
      died = this.player(victimId);
      died.alive = false;
      died.diedRound = s.round;
      died.causeOfDeath = 'werewolves';
    }
    this._log({ type: 'dawn', victim: died ? died.id : null, role: died ? died.role : null });
    this._secret({ type: 'night_result', wolfTarget: victimId, doctorTarget: n.doctor, saved });
    s.night = null;
    if (this._checkEnd()) return;
    this._startDiscussion();
  }

  // ---- day: discussion -----------------------------------------------------
  _startDiscussion() {
    const s = this.state;
    s.phase = 'day_discussion';
    const alive = this.alive();
    const start = (s.round - 1) % alive.length;
    const order = alive.slice(start).concat(alive.slice(0, start)).map(p => p.id);
    s.discussion = { pass: 1, order, cursor: 0 };
    this._log({ type: 'phase', phase: 'day_discussion' });
    this._nextSpeaker();
  }
  _nextSpeaker() {
    const s = this.state;
    const d = s.discussion;
    while (d.cursor >= d.order.length) {
      d.pass++;
      d.cursor = 0;
      if (d.pass > s.options.discussionRounds) {
        s.discussion = null;
        return this._startVote();
      }
    }
    this._requests([{ playerId: d.order[d.cursor], type: 'statement', options: [] }]);
  }
  _applyStatement(req, action, reasoning, timedOut) {
    const s = this.state;
    const d = s.discussion;
    const text = cleanText(action && action.text, s.options.statementMaxChars);
    const ev = this._log({ type: 'statement', playerId: req.playerId, pass: d.pass, text, timedOut });
    this._secret({ type: 'statement', playerId: req.playerId, seq: ev.seq, reasoning, timedOut });
    if (timedOut) this._timeout(req.playerId);
    d.cursor++;
    this._nextSpeaker();
  }

  // ---- day: vote -----------------------------------------------------------
  _startVote() {
    const s = this.state;
    s.phase = 'day_vote';
    s.vote = { votes: {} };
    this._log({ type: 'phase', phase: 'day_vote' });
    const alive = this.alive();
    this._requests(alive.map(p => ({ playerId: p.id, type: 'vote', options: alive.filter(x => x.id !== p.id).map(x => x.id) })));
  }
  _applyVote(req, action, reasoning, timedOut) {
    const s = this.state;
    const target = timedOut ? null : action.target;
    s.vote.votes[req.playerId] = target;
    this._secret({ type: 'vote', playerId: req.playerId, target, reasoning, timedOut });
    if (timedOut) this._timeout(req.playerId);
    if (!s.pending.length) this._resolveVote();
  }
  _resolveVote() {
    const s = this.state;
    const votes = s.vote.votes;
    const tally = countRoles(Object.values(votes).filter(Boolean));
    const entries = Object.entries(tally);
    let eliminated = null;
    let tie = false;
    if (entries.length) {
      const max = Math.max(...entries.map(e => e[1]));
      const top = entries.filter(e => e[1] === max);
      if (top.length === 1) eliminated = this.player(top[0][0]);
      else tie = true;
    }
    if (eliminated) {
      eliminated.alive = false;
      eliminated.diedRound = s.round;
      eliminated.causeOfDeath = 'vote';
    }
    this._log({ type: 'vote_result', votes: { ...votes }, tally, eliminated: eliminated ? eliminated.id : null, role: eliminated ? eliminated.role : null, tie });
    s.vote = null;
    if (this._checkEnd()) return;
    if (s.round >= s.options.maxRounds) return this._finish('draw');
    this._startNight();
  }

  // ---- end -----------------------------------------------------------------
  _checkEnd() {
    const alive = this.alive();
    const wolves = alive.filter(p => p.role === 'werewolf').length;
    const others = alive.length - wolves;
    if (wolves === 0) { this._finish('village'); return true; }
    if (wolves >= others) { this._finish('werewolves'); return true; }
    return false;
  }
  _finish(winner) {
    const s = this.state;
    s.status = 'finished';
    s.phase = 'finished';
    s.winner = winner;
    s.finishedAt = this.now();
    s.pending = [];
    this._log({ type: 'game_over', winner, roles: Object.fromEntries(s.players.map(p => [p.id, p.role])) });
  }

  // ---- the arena's entry points -------------------------------------------
  /**
   * Apply an agent's answer to a pending request.
   * @returns {{ok: true} | {ok: false, error: string, hint?: string, options?: string[]}}
   */
  act(requestId, { action, reasoning } = {}, { timedOut = false } = {}) {
    const s = this.state;
    if (s.status !== 'running') return { ok: false, error: 'game_finished' };
    const i = s.pending.findIndex(r => r.requestId === requestId);
    if (i < 0) return { ok: false, error: 'unknown_request' };
    const req = s.pending[i];
    if (!timedOut) {
      if (req.type === 'statement') {
        if (!action || typeof action.text !== 'string') return { ok: false, error: 'missing_text', hint: 'action must be {"text": "..."}' };
      } else if (req.options.length) {
        if (!action || typeof action.target !== 'string' || !req.options.includes(action.target)) {
          return { ok: false, error: 'invalid_target', hint: 'action must be {"target": "<player_id>"} chosen from options', options: req.options };
        }
      }
    }
    const r = cleanText(reasoning, s.options.reasoningMaxChars);
    s.pending.splice(i, 1);
    switch (req.type) {
      case 'night': this._applyNight(req, action, r, timedOut); break;
      case 'statement': this._applyStatement(req, action, r, timedOut); break;
      case 'vote': this._applyVote(req, action, r, timedOut); break;
      default: break;
    }
    return { ok: true };
  }

  /** Apply default actions to every request whose deadline has passed. Returns how many expired. */
  expire(nowMs = this.now()) {
    if (this.state.status !== 'running') return 0;
    const due = this.state.pending.filter(r => r.deadline <= nowMs);
    for (const r of due) this.act(r.requestId, {}, { timedOut: true });
    return due.length;
  }

  /** What an agent receives for one of its pending requests. Private to that agent. */
  requestPayload(req) {
    const s = this.state;
    const me = this.player(req.playerId);
    const you = { player_id: me.id, name: me.name, role: me.role, team: ROLES[me.role].team, alive: me.alive };
    if (me.role === 'werewolf') {
      you.teammates = s.players.filter(p => p.role === 'werewolf' && p.id !== me.id).map(p => ({ player_id: p.id, name: p.name, alive: p.alive }));
      if (s.night) {
        you.pack_choices = Object.entries(s.night.kills).filter(([w]) => w !== me.id).map(([w, t]) => ({ werewolf: w, target: t }));
      }
    }
    if (me.role === 'seer') {
      you.inspections = (s.secrets.inspections[me.id] || []).map(i => ({ round: i.round, player_id: i.target, name: this.player(i.target).name, result: i.result }));
    }
    const reasoningDoc = 'your private thoughts (string, revealed to spectators only after the game)';
    let respondWith;
    if (req.type === 'statement') respondWith = { action: { text: `what you say to the village (string, max ${s.options.statementMaxChars} chars)` }, reasoning: reasoningDoc };
    else if (req.options.length) respondWith = { action: { target: 'a player_id from options' }, reasoning: reasoningDoc };
    else respondWith = { action: {}, reasoning: reasoningDoc };
    return {
      request_id: req.requestId,
      game_id: s.id,
      game: KIND,
      type: req.type,
      deadline: new Date(req.deadline).toISOString(),
      seconds_left: Math.max(0, Math.round((req.deadline - this.now()) / 1000)),
      round: s.round,
      phase: s.phase,
      pass: s.discussion ? s.discussion.pass : null,
      passes: s.options.discussionRounds,
      you,
      players: s.players.map(p => ({ player_id: p.id, name: p.name, alive: p.alive, role: p.alive ? null : p.role })),
      role_counts: countRoles(s.players.map(p => p.role)),
      options: req.options.map(id => ({ player_id: id, name: this.player(id).name })),
      rules: RULES_TEXT,
      instructions: this._instructions(req, me),
      respond_with: respondWith,
      history: this.transcript(),
      events: s.log,
    };
  }
  _instructions(req, me) {
    const s = this.state;
    if (req.type === 'night') {
      switch (me.role) {
        case 'werewolf': return 'Night: choose a player to kill. Return action {"target": player_id} from options. If your pack disagrees, one of the chosen targets is picked at random. Nobody else sees who you chose.';
        case 'seer': return 'Night: choose a player to inspect. You privately learn whether they are a werewolf (see you.inspections in later requests). Return action {"target": player_id} from options.';
        case 'doctor': return 'Night: choose a player to protect, yourself included. If the werewolves attack that player tonight, nobody dies. Return action {"target": player_id} from options.';
        default: return 'Night: you have no night power. Return action {} and use reasoning to record your private suspicions; spectators read it after the game.';
      }
    }
    if (req.type === 'statement') {
      return `Day ${s.round}, pass ${s.discussion.pass} of ${s.options.discussionRounds}: it is your turn to speak. Every living player hears this. Return action {"text": "..."} (max ${s.options.statementMaxChars} characters).`;
    }
    return `Day ${s.round}, vote: choose one player to eliminate. Return action {"target": player_id} from options. The player with the most votes dies and their role is revealed; a tie eliminates nobody.`;
  }

  /** Public log as plain-text lines, for LLM-friendly prompts. */
  transcript() {
    const s = this.state;
    const name = id => (this.player(id) || { name: id }).name;
    const lines = [];
    for (const e of s.log) {
      switch (e.type) {
        case 'game_start':
          lines.push(`Players: ${e.players.map(p => `${p.name} (${p.id})`).join(', ')}. Roles in play: ${Object.entries(e.roleCounts).map(([r, n]) => `${n} ${r}`).join(', ')}.`);
          break;
        case 'phase':
          if (e.phase === 'night') lines.push(`--- Round ${e.round}: night falls ---`);
          else if (e.phase === 'day_discussion') lines.push(`--- Round ${e.round}: day, discussion ---`);
          else if (e.phase === 'day_vote') lines.push(`--- Round ${e.round}: day, vote ---`);
          break;
        case 'dawn':
          lines.push(e.victim ? `Dawn: ${name(e.victim)} was killed in the night. They were a ${e.role}.` : 'Dawn: nobody died in the night.');
          break;
        case 'statement':
          lines.push(e.timedOut || !e.text ? `${name(e.playerId)} (pass ${e.pass}) said nothing.` : `${name(e.playerId)} (pass ${e.pass}): "${e.text}"`);
          break;
        case 'vote_result': {
          const v = Object.entries(e.votes).map(([a, b]) => `${name(a)} -> ${b ? name(b) : 'abstain'}`).join(', ');
          lines.push(`Votes: ${v}.`);
          if (e.eliminated) lines.push(`Result: ${name(e.eliminated)} was eliminated. They were a ${e.role}.`);
          else lines.push(e.tie ? 'Result: a tie, nobody was eliminated.' : 'Result: nobody was eliminated.');
          break;
        }
        case 'game_over':
          lines.push(`Game over: ${e.winner === 'draw' ? 'draw' : e.winner + ' win'}.`);
          break;
        default: break;
      }
    }
    return lines;
  }

  /** What spectators see. Roles and private reasoning appear once the game is over. */
  publicView() {
    const s = this.state;
    const done = s.status === 'finished';
    return {
      id: s.id,
      kind: s.kind,
      status: s.status,
      winner: s.winner,
      createdAt: s.createdAt,
      finishedAt: s.finishedAt,
      round: s.round,
      phase: s.phase,
      options: s.options,
      players: s.players.map(p => ({
        id: p.id, agentId: p.agentId, name: p.name, alive: p.alive, diedRound: p.diedRound, causeOfDeath: p.causeOfDeath,
        role: done || !p.alive ? p.role : null,
      })),
      roleCounts: countRoles(s.players.map(p => p.role)),
      log: s.log,
      pending: s.pending.map(r => ({ playerId: r.playerId, type: r.type, deadline: r.deadline })),
      secrets: done ? s.secrets : null,
      stats: s.stats,
      ratings: s.ratings,
    };
  }

  /** Compact summary for lists. */
  summary() {
    const s = this.state;
    return {
      id: s.id, kind: s.kind, status: s.status, winner: s.winner, createdAt: s.createdAt, finishedAt: s.finishedAt,
      round: s.round, phase: s.phase,
      players: s.players.map(p => ({ id: p.id, agentId: p.agentId, name: p.name, alive: p.alive, role: s.status === 'finished' || !p.alive ? p.role : null })),
      ratings: s.ratings,
    };
  }
}
