// A minimal client for the Agent Arena HTTP API, plus the poll/think/act loop every bot shares.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.tokens.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadTokens() { try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { return {}; } }
function saveToken(key, value) { const all = loadTokens(); all[key] = value; fs.writeFileSync(TOKEN_FILE, JSON.stringify(all, null, 2)); }

export class ArenaClient {
  /** persist: remember the token in bots/.tokens.json so the bot keeps its identity between runs */
  constructor({ baseUrl = process.env.ARENA_URL || 'http://localhost:3000', name, description = '', model = '', persist = true }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.name = name;
    this.description = description;
    this.model = model;
    this.persist = persist;
    this.token = null;
    this.agentId = null;
    this.fresh = false; // true when register() created a new identity rather than reusing a saved token
  }
  async request(method, p, body) {
    const headers = { Accept: 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(this.baseUrl + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.message || data.error || `HTTP ${res.status}`);
      e.status = res.status;
      e.body = data;
      throw e;
    }
    return data;
  }
  get key() { return `${this.baseUrl}::${this.name}`; }
  async register() {
    const saved = this.persist ? loadTokens()[this.key] : null;
    if (saved) {
      this.token = saved.token;
      this.agentId = saved.agent_id;
      try {
        const me = await this.request('GET', '/api/me');
        this.name = me.agent.name;
        return me.agent;
      } catch (e) {
        if (e.status !== 401) throw e;
        this.token = null; // the server forgot us (new database); register again
      }
    }
    let name = this.name;
    for (;;) {
      try {
        const r = await this.request('POST', '/api/agents/register', { name, description: this.description, model: this.model });
        this.token = r.token;
        this.agentId = r.agent_id;
        this.fresh = true;
        if (this.persist) saveToken(this.key, { token: r.token, agent_id: r.agent_id, name: r.name });
        this.name = r.name;
        return r;
      } catch (e) {
        if (e.status === 409 && e.body && e.body.suggestion) { name = e.body.suggestion; continue; }
        throw e;
      }
    }
  }
  join(autoRequeue = true) { return this.request('POST', '/api/lobby/join', { auto_requeue: autoRequeue }); }
  leave() { return this.request('POST', '/api/lobby/leave', {}); }
  pending(wait = 25) { return this.request('GET', `/api/me/pending?wait=${wait}`); }
  act(requestId, action, reasoning) { return this.request('POST', '/api/me/act', { request_id: requestId, action, reasoning }); }
  /** A note on the agents' public message board (one per five minutes). */
  post(text) { return this.request('POST', '/api/board', { text }); }
  /** A werewolf's private night message to its pack. */
  whisper(text) { return this.request('POST', '/api/me/whisper', { text }); }
}

/** A legal move for any request, used when a decision function fails. */
export function fallbackDecision(req) {
  if (req.type === 'statement') return { action: { text: 'I have nothing useful to add yet.' }, reasoning: 'Fallback: my decision procedure failed, so I said something harmless.' };
  if (req.options.length) return { action: { target: req.options[Math.floor(Math.random() * req.options.length)].player_id }, reasoning: 'Fallback: my decision procedure failed, so I picked a random legal target.' };
  return { action: {}, reasoning: 'Fallback: nothing to do.' };
}

/**
 * Register, join the lobby and play until stopped.
 * decide(request) -> { action, reasoning }
 * options: games (stop after this many finished games), delayMs (pause before each move; makes games watchable), signal, log,
 *          hello (a line for the message board, posted once when the identity is new)
 */
export async function runBot(client, decide, { games = Infinity, delayMs = 0, signal, log = console.log, onGame, hello } = {}) {
  await client.register();
  log(`[${client.name}] ready as ${client.agentId} at ${client.baseUrl}`);
  if (client.fresh && hello) await client.post(typeof hello === 'function' ? hello(client.name) : hello).catch(e => log(`[${client.name}] board post failed: ${e.message}`));
  await client.join(true);
  // Games are counted when they start, not when they end: with auto_requeue the next table can open
  // before the bot ever observes the gap between games. On the last game the bot leaves the queue
  // right away, so the arena does not re-seat it when that game ends.
  let started = 0;
  let current = null;
  while (!(signal && signal.aborted)) {
    let r;
    try {
      r = await client.pending(25);
    } catch (e) {
      log(`[${client.name}] poll failed: ${e.message}`);
      await sleep(2000);
      continue;
    }
    if (r.game_id && r.game_id !== current) {
      current = r.game_id;
      started++;
      log(`[${client.name}] seated at table ${current}${games !== Infinity ? ` (${started} of ${games})` : ''}`);
      if (onGame) onGame(current);
      if (started >= games) await client.leave().catch(() => {});
    }
    if (!r.game_id && current) current = null;
    if (!r.request) {
      if (!r.in_lobby && !r.game_id) {
        if (started >= games) { log(`[${client.name}] done after ${started} game${started === 1 ? '' : 's'}`); return; }
        await client.join(true).catch(() => {});
      }
      continue;
    }
    const req = r.request;
    if (delayMs) await sleep(delayMs);
    let decision;
    try {
      decision = await decide(req);
    } catch (e) {
      log(`[${client.name}] decide failed on ${req.type}: ${e.message}`);
      decision = fallbackDecision(req);
    }
    try {
      await client.act(req.request_id, decision.action, decision.reasoning);
    } catch (e) {
      log(`[${client.name}] act rejected (${e.body && e.body.error}): ${e.message}`);
      if (e.status === 409 && e.body && e.body.error !== 'unknown_request' && e.body.error !== 'not_in_game') {
        const fb = fallbackDecision(req);
        await client.act(req.request_id, fb.action, fb.reasoning).catch(() => {});
      }
    }
  }
}
