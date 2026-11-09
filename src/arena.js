// The arena: lobby, matchmaking, request delivery (long-poll and webhooks), deadlines, ratings.
// Games themselves are pure state machines in src/games/.
import { EventEmitter } from 'node:events';
import { WerewolfGame, MIN_PLAYERS, MAX_PLAYERS, ROLES } from './games/werewolf.js';
import { updateRatings } from './rating.js';
import { deliver } from './webhooks.js';

export const DEFAULT_ARENA_OPTIONS = {
  minPlayers: MIN_PLAYERS,
  maxPlayers: MAX_PLAYERS,
  fillWindowMs: 4_000,      // once minPlayers are waiting, wait this long for more before starting
  queueStaleMs: 60_000,     // an agent that stops polling for this long is dropped from the lobby
  actionTimeoutMs: 45_000,  // per request; a late agent gets a default action and a timeout strike
  discussionRounds: 2,
  keepFinishedMs: 10 * 60_000,
  tickMs: 250,
  webhookTimeoutMs: 6_000,
};

export class Arena extends EventEmitter {
  constructor(store, options = {}) {
    super();
    this.store = store;
    this.options = { ...DEFAULT_ARENA_OPTIONS, ...options };
    this.options.minPlayers = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, this.options.minPlayers));
    this.options.maxPlayers = Math.max(this.options.minPlayers, Math.min(MAX_PLAYERS, this.options.maxPlayers));
    this.queue = [];               // [{agentId, joinedAt}]
    this.autoRequeue = new Set();  // agents that rejoin the lobby after every game
    this.games = new Map();        // gameId -> WerewolfGame (running, and finished for a while)
    this.agentGame = new Map();    // agentId -> gameId while playing
    this.waiters = new Map();      // agentId -> [{resolve, timer}] long-poll waiters
    this.lastSeen = new Map();     // agentId -> ms
    this.pushed = new Map();       // gameId -> Set(requestId) already delivered to a webhook
    this.fillSince = null;
    this.timer = null;
    this.startedAt = Date.now();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.options.tickMs);
    if (this.timer.unref) this.timer.unref();
  }
  stop() {
    clearInterval(this.timer);
    this.timer = null;
    for (const list of this.waiters.values()) for (const w of list.slice()) w.resolve(null);
  }

  // ---- presence ------------------------------------------------------------
  touch(agentId) {
    this.lastSeen.set(agentId, Date.now());
    this.store.touchAgent(agentId);
  }
  statusOf(agentId) {
    const pos = this.queue.findIndex(q => q.agentId === agentId);
    return {
      in_lobby: pos >= 0,
      position: pos >= 0 ? pos + 1 : null,
      game_id: this.agentGame.get(agentId) || null,
      auto_requeue: this.autoRequeue.has(agentId),
    };
  }

  // ---- lobby ---------------------------------------------------------------
  join(agentId, { autoRequeue = false } = {}) {
    if (autoRequeue) this.autoRequeue.add(agentId); else this.autoRequeue.delete(agentId);
    this.touch(agentId);
    const gid = this.agentGame.get(agentId);
    if (gid) return { status: 'in_game', game_id: gid };
    if (!this.queue.some(q => q.agentId === agentId)) {
      this.queue.push({ agentId, joinedAt: Date.now() });
      this._lobbyChanged();
    }
    this.tick();
    const again = this.agentGame.get(agentId);
    if (again) return { status: 'in_game', game_id: again };
    return { status: 'queued', position: this.queue.findIndex(q => q.agentId === agentId) + 1, waiting: this.queue.length, needed: this.options.minPlayers };
  }
  leave(agentId) {
    this.autoRequeue.delete(agentId);
    const before = this.queue.length;
    this.queue = this.queue.filter(q => q.agentId !== agentId);
    if (this.queue.length !== before) this._lobbyChanged();
    return { status: 'left', game_id: this.agentGame.get(agentId) || null };
  }
  lobbyView() {
    const now = Date.now();
    return {
      waiting: this.queue.map(q => {
        const a = this.store.getAgent(q.agentId);
        // model lets the UI and agents tell house players (model 'house', see bots/house.js) from visitors
        return { agent_id: q.agentId, name: a ? a.name : q.agentId, model: a ? a.model : '', rating: a ? a.rating : null, since: q.joinedAt };
      }),
      min_players: this.options.minPlayers,
      max_players: this.options.maxPlayers,
      starts_in_ms: this.fillSince != null ? Math.max(0, this.options.fillWindowMs - (now - this.fillSince)) : null,
      running_games: [...this.games.values()].filter(g => g.state.status === 'running').length,
    };
  }
  _lobbyChanged() { this.emit('event', { type: 'lobby', waiting: this.queue.length }); }

  // ---- matchmaking and deadlines ------------------------------------------
  tick() {
    const now = Date.now();
    // webhook agents do not poll, so a delivered request keeps them "present" for its lifetime
    const fresh = this.queue.filter(q => (this.lastSeen.get(q.agentId) ?? q.joinedAt) > now - this.options.queueStaleMs || this.store.getWebhook(q.agentId));
    if (fresh.length !== this.queue.length) {
      this.queue = fresh;
      this._lobbyChanged();
    }
    if (this.queue.length >= this.options.minPlayers) {
      if (this.fillSince == null) this.fillSince = now;
      if (this.queue.length >= this.options.maxPlayers || now - this.fillSince >= this.options.fillWindowMs) this._startGame();
    } else {
      this.fillSince = null;
    }
    for (const g of this.games.values()) {
      if (g.state.status === 'running' && g.expire(now) > 0) this._afterChange(g);
    }
  }
  _startGame() {
    const seats = this.queue.splice(0, this.options.maxPlayers);
    this.fillSince = null;
    const players = seats.map(s => {
      const a = this.store.getAgent(s.agentId);
      return { agentId: s.agentId, name: a ? a.name : s.agentId };
    });
    const game = WerewolfGame.create({ players, options: { actionTimeoutMs: this.options.actionTimeoutMs, discussionRounds: this.options.discussionRounds } });
    this.games.set(game.id, game);
    for (const p of players) this.agentGame.set(p.agentId, game.id);
    this.emit('event', { type: 'game_started', gameId: game.id });
    this._lobbyChanged();
    this._afterChange(game);
  }
  /** True while the agent is seated at a running table or waiting in the lobby. */
  busy(agentId) { return this.agentGame.has(agentId) || this.queue.some(q => q.agentId === agentId); }
  /**
   * Start a game for a given set of agents, outside the lobby: a visitor table (src/tables.js) whose seats the
   * arena plays itself. players: [{agentId, name}]; options are merged over the arena's game options.
   */
  startTable(players, options = {}) {
    const taken = players.find(p => this.busy(p.agentId));
    if (taken) throw new Error(`${taken.name} is already seated or waiting`);
    const game = WerewolfGame.create({ players, options: { actionTimeoutMs: this.options.actionTimeoutMs, discussionRounds: this.options.discussionRounds, ...options } });
    this.games.set(game.id, game);
    for (const p of players) this.agentGame.set(p.agentId, game.id);
    this.emit('event', { type: 'game_started', gameId: game.id, table: options.table || null });
    this._afterChange(game);
    return game;
  }
  _afterChange(game) {
    if (game.state.status === 'finished') this._finishGame(game);
    const s = game.state;
    this.emit('event', { type: 'game', gameId: s.id, status: s.status, round: s.round, phase: s.phase, winner: s.winner });
    this._wakeWaiters();
    if (s.status === 'running') this._pushRequests(game);
  }
  _finishGame(game) {
    const s = game.state;
    const rows = s.players.map(p => {
      const a = this.store.getAgent(p.agentId);
      const team = ROLES[p.role].team;
      const score = s.winner === 'draw' ? 0.5 : (team === s.winner ? 1 : 0);
      return {
        agentId: p.agentId, playerId: p.id, role: p.role, team, score, rating: a ? a.rating : 1500,
        timeouts: s.stats.timeouts[p.id] || 0, lies: (s.stats.lies || {})[p.id] || 0, statements: (s.stats.statements || {})[p.id] || 0,
      };
    });
    const deltas = updateRatings(rows);
    s.ratings = deltas;
    this.store.saveFinishedGame(game, deltas, rows);
    for (const p of s.players) {
      this.agentGame.delete(p.agentId);
      if (this.autoRequeue.has(p.agentId) && !this.queue.some(q => q.agentId === p.agentId)) this.queue.push({ agentId: p.agentId, joinedAt: Date.now() });
      // tell long-pollers the game is over so they do not sit out their full wait
      for (const w of (this.waiters.get(p.agentId) || []).slice()) w.resolve(null);
      const hook = this.store.getWebhook(p.agentId);
      if (hook) {
        const row = rows.find(r => r.agentId === p.agentId);
        this._push(p.agentId, hook, 'game_over', { agent_id: p.agentId, game_id: s.id, winner: s.winner, your_role: p.role, your_team: row.team, your_score: row.score, rating: deltas[p.agentId], in_lobby: this.autoRequeue.has(p.agentId) });
      }
    }
    this._lobbyChanged();
    const t = setTimeout(() => { this.games.delete(s.id); this.pushed.delete(s.id); }, this.options.keepFinishedMs);
    if (t.unref) t.unref();
  }

  // ---- request delivery ----------------------------------------------------
  pendingFor(agentId) {
    const gid = this.agentGame.get(agentId);
    if (!gid) return null;
    const g = this.games.get(gid);
    if (!g || g.state.status !== 'running') return null;
    const me = g.playerByAgent(agentId);
    const req = me && g.pending.find(r => r.playerId === me.id);
    return req ? g.requestPayload(req) : null;
  }
  /** Resolve with the agent's pending request as soon as there is one, or null after timeoutMs. */
  waitForRequest(agentId, timeoutMs) {
    const now = this.pendingFor(agentId);
    if (now) return { promise: Promise.resolve(now), cancel() {} };
    let entry;
    const promise = new Promise(resolve => {
      entry = { resolve: null, timer: null };
      const done = value => {
        clearTimeout(entry.timer);
        const list = this.waiters.get(agentId) || [];
        this.waiters.set(agentId, list.filter(e => e !== entry));
        resolve(value);
      };
      entry.resolve = done;
      entry.timer = setTimeout(() => done(null), timeoutMs);
      if (!this.waiters.has(agentId)) this.waiters.set(agentId, []);
      this.waiters.get(agentId).push(entry);
    });
    return { promise, cancel: () => entry.resolve(null) };
  }
  _wakeWaiters() {
    for (const [agentId, list] of this.waiters) {
      if (!list.length) continue;
      const payload = this.pendingFor(agentId);
      if (payload) for (const e of list.slice()) e.resolve(payload);
    }
  }
  /** Push every not-yet-delivered pending request of a game to the agents that registered a webhook. */
  _pushRequests(game) {
    const s = game.state;
    if (!this.pushed.has(s.id)) this.pushed.set(s.id, new Set());
    const done = this.pushed.get(s.id);
    for (const req of s.pending) {
      if (done.has(req.requestId)) continue;
      const player = game.player(req.playerId);
      const hook = this.store.getWebhook(player.agentId);
      if (!hook) continue;
      done.add(req.requestId);
      this._push(player.agentId, hook, 'request', { agent_id: player.agentId, request: game.requestPayload(req) });
    }
  }
  _push(agentId, hook, event, data) {
    deliver(hook.url, hook.secret, event, data, { timeoutMs: this.options.webhookTimeoutMs })
      .then(ok => { this.store.webhookResult(agentId, ok); this.emit('webhook', { agentId, event, ok }); })
      .catch(() => {});
  }
  act(agentId, requestId, action, reasoning) {
    const gid = this.agentGame.get(agentId);
    const g = gid && this.games.get(gid);
    if (!g || g.state.status !== 'running') return { ok: false, error: 'not_in_game', hint: 'join the lobby and wait for a request' };
    const me = g.playerByAgent(agentId);
    const req = g.pending.find(r => r.requestId === requestId);
    if (!req) return { ok: false, error: 'unknown_request', hint: 'this request is no longer pending; poll /api/me/pending for the current one' };
    if (req.playerId !== me.id) return { ok: false, error: 'not_your_request' };
    const res = g.act(requestId, { action, reasoning });
    if (res.ok) this._afterChange(g);
    return res;
  }
  /** A werewolf's private night message to its pack. */
  whisper(agentId, text) {
    const gid = this.agentGame.get(agentId);
    const g = gid && this.games.get(gid);
    if (!g || g.state.status !== 'running') return { ok: false, error: 'not_in_game', hint: 'you can only whisper while seated at a running table' };
    const me = g.playerByAgent(agentId);
    return g.whisper(me.id, text);
  }

  // ---- spectating ----------------------------------------------------------
  runningGames() {
    return [...this.games.values()].filter(g => g.state.status === 'running').sort((a, b) => b.state.createdAt - a.state.createdAt).map(g => g.summary());
  }
  runningGame(id) {
    const g = this.games.get(id);
    return g && g.state.status === 'running' ? g : null;
  }
  gameView(id) {
    const g = this.games.get(id);
    if (g) return g.publicView();
    const state = this.store.getGameState(id);
    return state ? new WerewolfGame(state).publicView() : null;
  }
}
