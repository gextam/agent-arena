// Persistence on Node's built-in SQLite (node:sqlite, Node 22.13+). No native modules to build.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_RATING } from './rating.js';

// 2-24 chars: letters, digits, spaces, _ . -   (must start with a letter or digit)
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{1,23}$/u;

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
    `);
    const p = sql => this.db.prepare(sql);
    this.q = {
      insertAgent: p('INSERT INTO agents (id, name, name_key, description, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      agentById: p('SELECT * FROM agents WHERE id = ?'),
      agentByToken: p('SELECT * FROM agents WHERE token_hash = ?'),
      agentByName: p('SELECT * FROM agents WHERE name_key = ?'),
      touch: p('UPDATE agents SET last_seen = ? WHERE id = ?'),
      leaderboard: p('SELECT * FROM agents ORDER BY rating DESC, games DESC, created_at ASC LIMIT ?'),
      countAgents: p('SELECT COUNT(*) AS n FROM agents'),
      countGames: p('SELECT COUNT(*) AS n FROM games'),
      insertGame: p('INSERT INTO games (id, kind, created_at, finished_at, status, winner, rounds, summary, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      insertGamePlayer: p('INSERT INTO game_players (game_id, agent_id, player_id, role, team, score, rating_before, rating_after, timeouts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      applyResult: p('UPDATE agents SET rating = ?, games = games + 1, wins = wins + ?, losses = losses + ?, draws = draws + ?, timeouts = timeouts + ? WHERE id = ?'),
      gameById: p('SELECT state FROM games WHERE id = ?'),
      recentGames: p('SELECT summary FROM games ORDER BY finished_at DESC LIMIT ?'),
      agentGames: p(`SELECT gp.role, gp.team, gp.score, gp.rating_before, gp.rating_after, gp.timeouts, g.summary
                     FROM game_players gp JOIN games g ON g.id = gp.game_id WHERE gp.agent_id = ? ORDER BY g.finished_at DESC LIMIT ?`),
      roleStats: p('SELECT role, COUNT(*) AS games, SUM(CASE WHEN score = 1 THEN 1 ELSE 0 END) AS wins FROM game_players WHERE agent_id = ? GROUP BY role'),
      history: p(`SELECT gp.game_id, gp.rating_after, g.finished_at FROM game_players gp JOIN games g ON g.id = gp.game_id
                  WHERE gp.agent_id = ? ORDER BY g.finished_at DESC LIMIT ?`),
    };
    this._touched = new Map();
  }

  close() { this.db.close(); }

  static publicAgent(row) {
    if (!row) return null;
    return {
      id: row.id, name: row.name, description: row.description, createdAt: row.created_at, lastSeen: row.last_seen,
      rating: row.rating, games: row.games, wins: row.wins, losses: row.losses, draws: row.draws, timeouts: row.timeouts,
    };
  }

  // ---- agents --------------------------------------------------------------
  createAgent({ name, description = '' }) {
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
    this.q.insertAgent.run(id, clean, key, String(description ?? '').slice(0, 280), hash(token), t, t);
    return { agent: this.getAgent(id), token };
  }
  getAgent(id) { return Store.publicAgent(this.q.agentById.get(id)); }
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

  // ---- games ---------------------------------------------------------------
  /** Persist a finished game and apply its rating changes. perPlayer: [{agentId, playerId, role, team, score, timeouts}] */
  saveFinishedGame(game, deltas, perPlayer) {
    const s = game.state;
    const db = this.db;
    db.exec('BEGIN');
    try {
      this.q.insertGame.run(s.id, s.kind, s.createdAt, s.finishedAt, s.status, s.winner, s.round, JSON.stringify(game.summary()), JSON.stringify(s));
      for (const p of perPlayer) {
        const d = deltas[p.agentId];
        this.q.insertGamePlayer.run(s.id, p.agentId, p.playerId, p.role, p.team, p.score, d.before, d.after, p.timeouts);
        this.q.applyResult.run(d.after, p.score === 1 ? 1 : 0, p.score === 0 ? 1 : 0, p.score === 0.5 ? 1 : 0, p.timeouts, p.agentId);
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
  agentGames(agentId, limit = 20) {
    return this.q.agentGames.all(agentId, limit).map(r => ({
      role: r.role, team: r.team, score: r.score, ratingBefore: r.rating_before, ratingAfter: r.rating_after, timeouts: r.timeouts,
      game: JSON.parse(r.summary),
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
}
