// Persistence on Node's built-in SQLite (node:sqlite, Node 22.13+). No native modules to build.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_RATING } from './rating.js';
import { newSecret } from './webhooks.js';

// 2-24 chars: letters, digits, spaces, _ . -   (must start with a letter or digit)
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{1,23}$/u;
export const WEBHOOK_MAX_FAILURES = 8;

export class NameTakenError extends Error {
  constructor(name, suggestion) { super(`The name "${name}" is taken`); this.code = 'name_taken'; this.status = 409; this.suggestion = suggestion; }
}
export class InvalidNameError extends Error {
  constructor() { super('Names are 2-24 characters: letters, digits, spaces, _ . -'); this.code = 'invalid_name'; this.status = 400; }
}

const hash = token => createHash('sha256').update(token).digest('hex');

export class Store {
  constructor(file = ':memory:') {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        rating REAL NOT NULL DEFAULT ${DEFAULT_RATING},
        games INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        draws INTEGER NOT NULL DEFAULT 0,
        timeouts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL,
        winner TEXT,
        rounds INTEGER NOT NULL DEFAULT 0,
        summary TEXT NOT NULL,
        state TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS games_finished ON games(finished_at DESC);
      CREATE TABLE IF NOT EXISTS game_players (
        game_id TEXT NOT NULL REFERENCES games(id),
        agent_id TEXT NOT NULL REFERENCES agents(id),
        player_id TEXT NOT NULL,
        role TEXT NOT NULL,
        team TEXT NOT NULL,
        score REAL NOT NULL,
        rating_before REAL NOT NULL,
        rating_after REAL NOT NULL,
        timeouts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (game_id, agent_id)
      );
      CREATE INDEX IF NOT EXISTS game_players_agent ON game_players(agent_id);
      CREATE TABLE IF NOT EXISTS board (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        t INTEGER NOT NULL,
        text TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id TEXT NOT NULL,
        t INTEGER NOT NULL,
        name TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_game ON chat(game_id, id);
      CREATE TABLE IF NOT EXISTS guesses (
        game_id TEXT NOT NULL,
        viewer TEXT NOT NULL,
        target TEXT NOT NULL,
        t INTEGER NOT NULL,
        PRIMARY KEY (game_id, viewer)
      );
      CREATE TABLE IF NOT EXISTS applause (
        game_id TEXT NOT NULL,
        viewer TEXT NOT NULL,
        seq INTEGER NOT NULL,
        t INTEGER NOT NULL,
        PRIMARY KEY (game_id, viewer)
      );
      -- visitor tables (src/tables.js): five catalog models seated by a human, played by the arena itself
      CREATE TABLE IF NOT EXISTS tables (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL,
        game_id TEXT,
        paid_by TEXT NOT NULL,
        client TEXT NOT NULL,
        seats TEXT NOT NULL,
        thoughts TEXT NOT NULL DEFAULT '[]',
        winner TEXT,
        rounds INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS tables_created ON tables(created_at DESC);
      -- one standing arena identity per catalog model, so its games accumulate on one record
      CREATE TABLE IF NOT EXISTS table_identities (
        catalog_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id)
      );
    `);
    // columns added after the first release; harmless on a fresh database
    this._addColumn('agents', 'model', "TEXT NOT NULL DEFAULT ''");
    this._addColumn('agents', 'lies', 'INTEGER NOT NULL DEFAULT 0');
    this._addColumn('agents', 'statements', 'INTEGER NOT NULL DEFAULT 0');
    this._addColumn('agents', 'webhook_url', 'TEXT');
    this._addColumn('agents', 'webhook_secret', 'TEXT');
    this._addColumn('agents', 'webhook_failures', 'INTEGER NOT NULL DEFAULT 0');
    this._addColumn('game_players', 'lies', 'INTEGER NOT NULL DEFAULT 0');
    this._addColumn('game_players', 'statements', 'INTEGER NOT NULL DEFAULT 0');

    const p = sql => this.db.prepare(sql);
    this.q = {
      insertAgent: p('INSERT INTO agents (id, name, name_key, description, model, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      agentById: p('SELECT * FROM agents WHERE id = ?'),
      agentByToken: p('SELECT * FROM agents WHERE token_hash = ?'),
      agentByName: p('SELECT * FROM agents WHERE name_key = ?'),
      touch: p('UPDATE agents SET last_seen = ? WHERE id = ?'),
      leaderboard: p('SELECT * FROM agents ORDER BY rating DESC, games DESC, created_at ASC LIMIT ?'),
      countAgents: p('SELECT COUNT(*) AS n FROM agents'),
      countGames: p('SELECT COUNT(*) AS n FROM games'),
      insertGame: p('INSERT INTO games (id, kind, created_at, finished_at, status, winner, rounds, summary, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      insertGamePlayer: p('INSERT INTO game_players (game_id, agent_id, player_id, role, team, score, rating_before, rating_after, timeouts, lies, statements) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      applyResult: p('UPDATE agents SET rating = ?, games = games + 1, wins = wins + ?, losses = losses + ?, draws = draws + ?, timeouts = timeouts + ?, lies = lies + ?, statements = statements + ? WHERE id = ?'),
      gameById: p('SELECT state FROM games WHERE id = ?'),
      recentGames: p('SELECT summary FROM games ORDER BY finished_at DESC LIMIT ?'),
      recentStates: p('SELECT state FROM games ORDER BY finished_at DESC LIMIT ?'),
      agentGames: p(`SELECT gp.role, gp.team, gp.score, gp.rating_before, gp.rating_after, gp.timeouts, gp.lies, gp.statements, g.summary
                     FROM game_players gp JOIN games g ON g.id = gp.game_id WHERE gp.agent_id = ? ORDER BY g.finished_at DESC LIMIT ?`),
      roleStats: p('SELECT role, COUNT(*) AS games, SUM(CASE WHEN score = 1 THEN 1 ELSE 0 END) AS wins FROM game_players WHERE agent_id = ? GROUP BY role'),
      history: p(`SELECT gp.game_id, gp.rating_after, g.finished_at FROM game_players gp JOIN games g ON g.id = gp.game_id
                  WHERE gp.agent_id = ? ORDER BY g.finished_at DESC LIMIT ?`),
      playerRole: p('SELECT role FROM game_players WHERE game_id = ? AND player_id = ?'),
      // webhooks
      setWebhook: p('UPDATE agents SET webhook_url = ?, webhook_secret = ?, webhook_failures = 0 WHERE id = ?'),
      webhookOk: p('UPDATE agents SET webhook_failures = 0 WHERE id = ?'),
      webhookFail: p('UPDATE agents SET webhook_failures = webhook_failures + 1 WHERE id = ?'),
      // board
      insertBoard: p('INSERT INTO board (agent_id, t, text) VALUES (?, ?, ?)'),
      boardRow: p('SELECT b.id, b.t, b.text, a.id AS agent_id, a.name, a.rating, a.model FROM board b JOIN agents a ON a.id = b.agent_id WHERE b.id = ?'),
      boardList: p('SELECT b.id, b.t, b.text, a.id AS agent_id, a.name, a.rating, a.model FROM board b JOIN agents a ON a.id = b.agent_id WHERE b.id < ? ORDER BY b.id DESC LIMIT ?'),
      boardLast: p('SELECT MAX(t) AS t FROM board WHERE agent_id = ?'),
      countBoard: p('SELECT COUNT(*) AS n FROM board'),
      // chat
      insertChat: p('INSERT INTO chat (game_id, t, name, text) VALUES (?, ?, ?, ?)'),
      chatList: p('SELECT id, t, name, text FROM chat WHERE game_id = ? AND id > ? ORDER BY id ASC LIMIT ?'),
      chatCount: p('SELECT COUNT(*) AS n FROM chat WHERE game_id = ?'),
      chatPrune: p('DELETE FROM chat WHERE game_id = ? AND id NOT IN (SELECT id FROM chat WHERE game_id = ? ORDER BY id DESC LIMIT ?)'),
      // guesses and applause
      upsertGuess: p('INSERT INTO guesses (game_id, viewer, target, t) VALUES (?, ?, ?, ?) ON CONFLICT(game_id, viewer) DO UPDATE SET target = excluded.target, t = excluded.t'),
      guessTally: p('SELECT target, COUNT(*) AS n FROM guesses WHERE game_id = ? GROUP BY target'),
      guessOf: p('SELECT target FROM guesses WHERE game_id = ? AND viewer = ?'),
      guessAll: p('SELECT game_id, target, COUNT(*) AS n FROM guesses GROUP BY game_id, target'),
      upsertApplause: p('INSERT INTO applause (game_id, viewer, seq, t) VALUES (?, ?, ?, ?) ON CONFLICT(game_id, viewer) DO UPDATE SET seq = excluded.seq, t = excluded.t'),
      applauseTally: p('SELECT seq, COUNT(*) AS n FROM applause WHERE game_id = ? GROUP BY seq'),
      applauseAll: p('SELECT game_id, seq, COUNT(*) AS n FROM applause GROUP BY game_id, seq'),
      // totals; the house players (model 'house', bots/house.js) keep seats warm and are neither agents nor a model here
      lieTotals: p('SELECT COALESCE(SUM(lies), 0) AS lies, COALESCE(SUM(statements), 0) AS statements FROM agents'),
      modelCount: p("SELECT COUNT(DISTINCT model) AS n FROM agents WHERE model <> '' AND model <> 'house'"),
      guestCount: p("SELECT COUNT(*) AS n FROM agents WHERE model <> 'house'"),
      // visitor tables
      insertTable: p('INSERT INTO tables (id, created_at, finished_at, status, game_id, paid_by, client, seats, thoughts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      updateTable: p('UPDATE tables SET status = ?, finished_at = ?, thoughts = ?, winner = ?, rounds = ? WHERE id = ?'),
      loseTables: p("UPDATE tables SET status = 'lost', finished_at = ? WHERE status = 'running'"),
      tableById: p('SELECT * FROM tables WHERE id = ?'),
      recentTables: p('SELECT * FROM tables ORDER BY created_at DESC LIMIT ?'),
      tablesSince: p('SELECT COUNT(*) AS n FROM tables WHERE created_at >= ? AND paid_by = ?'),
      lastTableBy: p('SELECT MAX(created_at) AS t FROM tables WHERE client = ?'),
      identityFor: p('SELECT agent_id FROM table_identities WHERE catalog_id = ?'),
      setIdentity: p('INSERT INTO table_identities (catalog_id, agent_id) VALUES (?, ?) ON CONFLICT(catalog_id) DO UPDATE SET agent_id = excluded.agent_id'),
    };
    this._touched = new Map();
  }

  _addColumn(table, column, definition) {
    const has = this.db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
    if (!has) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  close() { this.db.close(); }

  static publicAgent(row) {
    if (!row) return null;
    return {
      id: row.id, name: row.name, description: row.description, model: row.model || '', createdAt: row.created_at, lastSeen: row.last_seen,
      rating: row.rating, guile: row.rating, games: row.games, wins: row.wins, losses: row.losses, draws: row.draws, timeouts: row.timeouts,
      lies: row.lies || 0, statements: row.statements || 0,
    };
  }
  /** The agent's own view: public fields plus its webhook (never the secret). */
  static privateAgent(row) {
    const a = Store.publicAgent(row);
    if (!a) return null;
    a.webhook = row.webhook_url ? { url: row.webhook_url, failures: row.webhook_failures, disabled: row.webhook_failures >= WEBHOOK_MAX_FAILURES } : null;
    return a;
  }

  // ---- agents --------------------------------------------------------------
  createAgent({ name, description = '', model = '' }) {
    const clean = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (!NAME_RE.test(clean)) throw new InvalidNameError();
    const key = clean.toLowerCase();
    if (this.q.agentByName.get(key)) {
      let n = 2;
      while (this.q.agentByName.get(`${key}-${n}`)) n++;
      throw new NameTakenError(clean, `${clean}-${n}`);
    }
    const id = 'ag_' + randomUUID().replace(/-/g, '').slice(0, 12);
    const token = 'ark_' + randomBytes(24).toString('base64url');
    const t = Date.now();
    this.q.insertAgent.run(id, clean, key, String(description ?? '').slice(0, 280), String(model ?? '').trim().slice(0, 60), hash(token), t, t);
    return { agent: this.getAgent(id), token };
  }
  getAgent(id) { return Store.publicAgent(this.q.agentById.get(id)); }
  getAgentPrivate(id) { return Store.privateAgent(this.q.agentById.get(id)); }
  getAgentByToken(token) { return typeof token === 'string' && token ? Store.publicAgent(this.q.agentByToken.get(hash(token))) : null; }
  findAgentByName(name) { return Store.publicAgent(this.q.agentByName.get(String(name ?? '').trim().toLowerCase())); }
  touchAgent(id) {
    const t = Date.now();
    if ((this._touched.get(id) || 0) > t - 10_000) return;
    this._touched.set(id, t);
    this.q.touch.run(t, id);
  }
  leaderboard(limit = 50) { return this.q.leaderboard.all(limit).map(Store.publicAgent); }
  counts() { return { agents: this.q.countAgents.get().n, games: this.q.countGames.get().n }; }

  // ---- webhooks ------------------------------------------------------------
  /** Set (or clear with null) an agent's webhook. Returns {url, secret} so the agent can verify signatures. */
  setWebhook(agentId, url) {
    const secret = url ? newSecret() : null;
    this.q.setWebhook.run(url || null, secret, agentId);
    return { url: url || null, secret };
  }
  getWebhook(agentId) {
    const row = this.q.agentById.get(agentId);
    if (!row || !row.webhook_url || row.webhook_failures >= WEBHOOK_MAX_FAILURES) return null;
    return { url: row.webhook_url, secret: row.webhook_secret, failures: row.webhook_failures };
  }
  webhookResult(agentId, ok) { (ok ? this.q.webhookOk : this.q.webhookFail).run(agentId); }

  // ---- games ---------------------------------------------------------------
  /** Persist a finished game and apply its rating changes. perPlayer: [{agentId, playerId, role, team, score, timeouts, lies, statements}] */
  saveFinishedGame(game, deltas, perPlayer) {
    const s = game.state;
    const db = this.db;
    db.exec('BEGIN');
    try {
      this.q.insertGame.run(s.id, s.kind, s.createdAt, s.finishedAt, s.status, s.winner, s.round, JSON.stringify(game.summary()), JSON.stringify(s));
      for (const p of perPlayer) {
        const d = deltas[p.agentId];
        this.q.insertGamePlayer.run(s.id, p.agentId, p.playerId, p.role, p.team, p.score, d.before, d.after, p.timeouts, p.lies || 0, p.statements || 0);
        this.q.applyResult.run(d.after, p.score === 1 ? 1 : 0, p.score === 0 ? 1 : 0, p.score === 0.5 ? 1 : 0, p.timeouts, p.lies || 0, p.statements || 0, p.agentId);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  getGameState(id) {
    const row = this.q.gameById.get(id);
    return row ? JSON.parse(row.state) : null;
  }
  recentGames(limit = 20) { return this.q.recentGames.all(limit).map(r => JSON.parse(r.summary)); }
  recentFinishedStates(limit = 40) { return this.q.recentStates.all(limit).map(r => JSON.parse(r.state)); }
  agentGames(agentId, limit = 20) {
    return this.q.agentGames.all(agentId, limit).map(r => ({
      role: r.role, team: r.team, score: r.score, ratingBefore: r.rating_before, ratingAfter: r.rating_after, timeouts: r.timeouts,
      lies: r.lies, statements: r.statements, game: JSON.parse(r.summary),
    }));
  }
  agentRoleStats(agentId) {
    const out = {};
    for (const r of this.q.roleStats.all(agentId)) out[r.role] = { games: r.games, wins: r.wins };
    return out;
  }
  ratingHistory(agentId, limit = 60) {
    return this.q.history.all(agentId, limit).reverse().map(r => ({ gameId: r.game_id, rating: r.rating_after, t: r.finished_at }));
  }

  // ---- the agent message board --------------------------------------------
  lastBoardPost(agentId) { return this.q.boardLast.get(agentId).t || 0; }
  postBoard(agentId, text) {
    const r = this.q.insertBoard.run(agentId, Date.now(), text);
    return Store.boardPost(this.q.boardRow.get(r.lastInsertRowid));
  }
  boardPosts(limit = 50, before = Number.MAX_SAFE_INTEGER) { return this.q.boardList.all(before, limit).map(Store.boardPost); }
  static boardPost(r) { return { id: r.id, t: r.t, text: r.text, agent: { id: r.agent_id, name: r.name, rating: r.rating, model: r.model || '' } }; }

  // ---- spectator chat ------------------------------------------------------
  addChat(gameId, name, text) {
    const t = Date.now();
    const r = this.q.insertChat.run(gameId, t, name, text);
    if (this.q.chatCount.get(gameId).n > 400) this.q.chatPrune.run(gameId, gameId, 300);
    return { id: Number(r.lastInsertRowid), t, name, text };
  }
  chat(gameId, afterId = 0, limit = 200) { return this.q.chatList.all(gameId, afterId, limit); }

  // ---- guess the wolf, applause -------------------------------------------
  setGuess(gameId, viewer, target) { this.q.upsertGuess.run(gameId, viewer, target, Date.now()); }
  guessOf(gameId, viewer) { const r = this.q.guessOf.get(gameId, viewer); return r ? r.target : null; }
  guessTally(gameId) {
    const counts = {};
    let total = 0;
    for (const r of this.q.guessTally.all(gameId)) { counts[r.target] = r.n; total += r.n; }
    return { total, counts };
  }
  /** How often the crowd's favourite suspect turned out to be a werewolf, over finished games with guesses. */
  crowdStats() {
    const byGame = new Map();
    for (const r of this.q.guessAll.all()) {
      if (!byGame.has(r.game_id)) byGame.set(r.game_id, []);
      byGame.get(r.game_id).push(r);
    }
    let games = 0, correct = 0;
    for (const [gameId, rows] of byGame) {
      const max = Math.max(...rows.map(r => r.n));
      const top = rows.filter(r => r.n === max);
      const role = this.q.playerRole.get(gameId, top[0].target);
      if (!role) continue; // still running, or lost
      games++;
      if (top.length === 1 && role.role === 'werewolf') correct++;
    }
    return { games, correct, pct: games ? Math.round(100 * correct / games) : null };
  }
  applaud(gameId, viewer, seq) { this.q.upsertApplause.run(gameId, viewer, seq, Date.now()); }
  applauseFor(gameId) { const out = {}; for (const r of this.q.applauseTally.all(gameId)) out[r.seq] = r.n; return out; }
  applauseAll() {
    const out = new Map();
    for (const r of this.q.applauseAll.all()) { if (!out.has(r.game_id)) out.set(r.game_id, {}); out.get(r.game_id)[r.seq] = r.n; }
    return out;
  }

  // ---- visitor tables ------------------------------------------------------
  static tableRow(r) {
    if (!r) return null;
    return { id: r.id, createdAt: r.created_at, finishedAt: r.finished_at, status: r.status, gameId: r.game_id, paidBy: r.paid_by, seats: JSON.parse(r.seats), thoughts: JSON.parse(r.thoughts || '[]'), winner: r.winner || null, rounds: r.rounds || 0 };
  }
  createTable({ id, gameId, paidBy, client, seats }) {
    this.q.insertTable.run(id, Date.now(), null, 'running', gameId, paidBy, client, JSON.stringify(seats), '[]');
    return this.getTable(id);
  }
  /** Persist progress (the thoughts collected so far) and, when the table ends, its result. */
  updateTable(id, { status, finishedAt = null, thoughts = [], winner = null, rounds = 0 }) { this.q.updateTable.run(status, finishedAt, JSON.stringify(thoughts), winner, rounds, id); }
  /** At startup: no table survives a restart, so whatever was still running is lost. */
  loseRunningTables() { this.q.loseTables.run(Date.now()); }
  getTable(id) { return Store.tableRow(this.q.tableById.get(id)); }
  recentTables(limit = 20) { return this.q.recentTables.all(limit).map(Store.tableRow); }
  tablesSince(sinceMs, paidBy = 'house') { return this.q.tablesSince.get(sinceMs, paidBy).n; }
  lastTableBy(client) { return this.q.lastTableBy.get(client).t || 0; }
  tableIdentity(catalogId) { const r = this.q.identityFor.get(catalogId); return r ? this.getAgent(r.agent_id) : null; }
  setTableIdentity(catalogId, agentId) { this.q.setIdentity.run(catalogId, agentId); }

  // ---- totals for the human-facing stats ----------------------------------
  totals() {
    const lies = this.q.lieTotals.get();
    return { ...this.counts(), agents: this.q.guestCount.get().n, models: this.q.modelCount.get().n, lies: lies.lies, statements: lies.statements, board_posts: this.q.countBoard.get().n, crowd: this.crowdStats() };
  }
}
