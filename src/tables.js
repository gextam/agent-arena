// Visitor tables: a human seats five catalog models at /tables/new and the arena plays every seat itself,
// in this process, against the providers' APIs over plain fetch (no SDK, so the server stays dependency-free).
// The game is an ordinary rated arena game with two differences: it starts outside the lobby (Arena.startTable)
// and it is created with revealLive, so roles, confessionals and the truth ledger are public while it runs.
// Nobody at such a table is an outside agent, so there is nobody the live reveal could help.
//
// Who pays: a model that is cheap enough (src/catalog.js, isCheap) plays on the house's keys when the arena has
// them; anything else needs the visitor's own key, which is held in memory for that one table, never stored or
// logged. Caps keep the bill bounded: tables running at once, house-paid tables per day, one new table per
// visitor every few minutes.
//
// What the audience gets that the agent API does not: a per-move record (src/store.js, tables.thoughts) with the
// model's response time, its token use and cost, and, where the provider returns one, a readable summary of the
// model's reasoning (Anthropic: thinking display "summarized"; OpenRouter: the normalized reasoning field).
import { randomUUID, createHash } from 'node:crypto';
import { CATALOG, VENDORS, PRICES_AS_OF, isCheap, estimateSeatCost, checkCatalog } from './catalog.js';
import { SYSTEM, JSON_SHAPE, PERSONAS, renderRequest, toDecision } from '../bots/lib/prompt.js';
import { parseDecision } from '../bots/openai-bot.js';
import { makeScriptedPlayer } from '../bots/scripted-bot.js';

export const DEFAULT_TABLE_OPTIONS = {
  seats: 5,                      // one werewolf, one seer, three villagers
  maxRunning: 2,                 // tables playing at once, house-paid or not
  perDay: 30,                    // house-paid tables per rolling 24 hours
  clientCooldownMs: 3 * 60_000,  // one new table per visitor (by address) in this window
  paceMs: 1200,                  // a move takes at least this long, so a table of fast models stays watchable
  effort: 'low',                 // reasoning effort for seats the house pays for
  keyEffort: 'medium',           // for seats on a visitor's key
  requestTimeoutMs: 40_000,      // never past the arena's deadline for the move
  keepFinishedMs: 10 * 60_000,
  keys: null,                    // { anthropic, openrouter }; from the environment when null
  catalog: null,                 // CATALOG when null (tests inject their own)
};

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const THINKING_MAX_CHARS = 4000;

export class TableError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanKey = k => (typeof k === 'string' && /^[\w.-]{8,400}$/.test(k.trim()) ? k.trim() : '');
const hashClient = ip => createHash('sha256').update(String(ip || '?')).digest('hex').slice(0, 16);
const shuffled = arr => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const round6 = n => Math.round(n * 1e6) / 1e6;

/** USD for one response: the provider's own figure when it gives one, else the catalog price applied to the tokens. */
export function costOf(usage, price) {
  if (!usage) return 0;
  if (typeof usage.cost === 'number') return round6(usage.cost);
  const cached = usage.cached || 0, written = usage.cache_write || 0;
  const fresh = Math.max(0, (usage.input || 0) - cached - written);
  return round6((fresh * price.in + cached * price.in * 0.1 + written * price.in * 1.25 + (usage.output || 0) * price.out) / 1e6);
}

export class Tables {
  constructor({ store, arena, options = {}, publicUrl = null, log = console.log }) {
    this.store = store;
    this.arena = arena;
    this.log = log;
    this.publicUrl = publicUrl || 'https://github.com/gextam/agent-arena';
    this.o = { ...DEFAULT_TABLE_OPTIONS, ...options };
    this.catalog = this.o.catalog || CATALOG;
    checkCatalog(this.catalog);
    this.keys = this.o.keys || { anthropic: process.env.ANTHROPIC_API_KEY || '', openrouter: process.env.OPENROUTER_API_KEY || '' };
    this.live = new Map(); // table id -> record while it runs (and a little after)
    this.stopped = false;
    // a table never survives a restart: whatever was running when the process died is lost
    this.store.loseRunningTables();
    arena.on('event', ev => { if (ev.type === 'game' && ev.status === 'finished') this._gameFinished(ev.gameId); });
  }
  stop() { this.stopped = true; }

  entry(id) { return this.catalog.find(e => e.id === id) || null; }
  running() { return [...this.live.values()].filter(t => t.status === 'running'); }

  /** Which key kinds would seat this model. */
  needs(entry) { return entry.provider === 'scripted' ? [] : entry.provider === 'anthropic' ? ['anthropic', 'openrouter'] : ['openrouter']; }

  /**
   * How a model gets called: the house pays when the model is cheap and the arena has a key for a route to it,
   * otherwise the visitor's key; null when nobody can pay. The key never leaves the returned object.
   */
  routeFor(entry, visitorKeys = {}) {
    if (entry.provider === 'scripted') return { kind: 'scripted', paidBy: 'house', model: entry.model };
    const route = (kind, key, paidBy) => (key ? { kind, key, paidBy, model: kind === 'anthropic' ? entry.model : entry.openrouter } : null);
    const house = this.keys, mine = visitorKeys;
    if (entry.provider === 'anthropic') {
      return (isCheap(entry) && (route('anthropic', house.anthropic, 'house') || route('openrouter', house.openrouter, 'house')))
        || route('anthropic', mine.anthropic, 'visitor') || route('openrouter', mine.openrouter, 'visitor') || null;
    }
    return (isCheap(entry) && route('openrouter', house.openrouter, 'house')) || route('openrouter', mine.openrouter, 'visitor') || null;
  }

  /** The picker's view: every model with whether the house pays for it, what it costs, and the limits. */
  catalogView() {
    const now = Date.now();
    const today = this.store.tablesSince(now - 86_400_000, 'house');
    return {
      prices_as_of: PRICES_AS_OF,
      house_keys: { anthropic: !!this.keys.anthropic, openrouter: !!this.keys.openrouter },
      limits: { seats: this.o.seats, max_running: this.o.maxRunning, running: this.running().length, per_day: this.o.perDay, house_tables_today: today, house_tables_left: Math.max(0, this.o.perDay - today), cooldown_s: Math.round(this.o.clientCooldownMs / 1000) },
      models: this.catalog.map(e => {
        const r = this.routeFor(e);
        return {
          id: e.id, vendor: e.vendor, vendor_name: VENDORS[e.vendor] || e.vendor, name: e.name, model: e.model, released: e.released,
          price: e.price, reasoning: !!e.reasoning, cheap: isCheap(e), house: !!r, needs: r ? [] : this.needs(e), est_cost: round6(estimateSeatCost(e)),
        };
      }),
    };
  }

  /** The standing arena identity of a catalog model, created on first use. Never adopts somebody else's agent. */
  identityFor(entry) {
    const existing = this.store.tableIdentity(entry.id);
    if (existing && existing.model === entry.model) return existing;
    const vendor = VENDORS[entry.vendor] || entry.vendor;
    const description = `${vendor} ${entry.name}, seated by visitors at /tables/new and played by the arena itself`;
    const tried = [];
    for (const name of [entry.name, `${vendor} ${entry.name}`]) {
      if (name.length > 24) continue;
      try {
        const { agent } = this.store.createAgent({ name, description, model: entry.model });
        this.store.setTableIdentity(entry.id, agent.id);
        return agent;
      } catch (e) {
        if (e.code !== 'name_taken') throw e;
        tried.push(e.suggestion);
      }
    }
    const { agent } = this.store.createAgent({ name: tried[0], description, model: entry.model });
    this.store.setTableIdentity(entry.id, agent.id);
    return agent;
  }

  /** Seat the models and start the game. seats: catalog ids; keys: the visitor's own, optional. */
  async create({ seats, keys = {}, client = '?' }) {
    const o = this.o;
    if (this.stopped) throw new TableError(503, 'shutting_down', 'The arena is restarting; try again in a moment');
    if (!Array.isArray(seats) || seats.length !== o.seats) throw new TableError(400, 'bad_seats', `Pick exactly ${o.seats} models, one per seat`);
    const entries = seats.map(id => {
      const e = typeof id === 'string' ? this.entry(id) : null;
      if (!e) throw new TableError(400, 'unknown_model', `No model ${JSON.stringify(id)} in the catalog (GET /api/tables/catalog)`);
      return e;
    });
    if (new Set(entries.map(e => e.id)).size !== entries.length) throw new TableError(400, 'duplicate_model', 'Each seat needs a different model');
    const mine = { anthropic: cleanKey(keys && keys.anthropic), openrouter: cleanKey(keys && keys.openrouter) };
    const routes = entries.map(e => this.routeFor(e, mine));
    const missing = entries.filter((e, i) => !routes[i]);
    if (missing.length) {
      const wanted = [...new Set(missing.flatMap(e => this.needs(e)))];
      throw new TableError(400, 'needs_key', `${missing.map(e => e.name).join(', ')}: the house does not pay for ${missing.length === 1 ? 'this model' : 'these models'}; bring your own ${wanted.join(' or ')} key`, { models: missing.map(e => e.id), keys: wanted });
    }
    const paidBy = routes.some(r => r.paidBy === 'house' && r.kind !== 'scripted') ? 'house' : 'visitor';
    const now = Date.now();
    if (this.running().length >= o.maxRunning) {
      throw new TableError(429, 'tables_full', `${o.maxRunning} table${o.maxRunning === 1 ? ' is' : 's are'} the most that can play at once; watch one of them or try again in a few minutes`, { retry_after_s: 120, running: this.running().map(t => t.id) });
    }
    const clientKey = hashClient(client);
    const wait = this.store.lastTableBy(clientKey) + o.clientCooldownMs - now;
    if (wait > 0) throw new TableError(429, 'slow_down', `One new table every ${Math.round(o.clientCooldownMs / 60_000)} minutes per visitor; try again in ${Math.ceil(wait / 1000)}s`, { retry_after_s: Math.ceil(wait / 1000) });
    if (paidBy === 'house' && this.store.tablesSince(now - 86_400_000, 'house') >= o.perDay) {
      throw new TableError(429, 'daily_limit', `The house has paid for ${o.perDay} tables in the last 24 hours; bring your own key, or come back tomorrow`, { retry_after_s: 3600 });
    }
    const agents = entries.map(e => this.identityFor(e));
    const taken = agents.find(a => this.arena.busy(a.id));
    if (taken) throw new TableError(409, 'model_busy', `${taken.name} is playing at another table right now; try again in a few minutes`);

    const id = 't_' + randomUUID().replace(/-/g, '').slice(0, 10);
    const players = agents.map(a => ({ agentId: a.id, name: a.name }));
    const game = this.arena.startTable(players, { revealLive: true, table: id });
    const seatRows = entries.map((e, i) => ({
      seat: i + 1, player_id: `p${i + 1}`, agent_id: agents[i].id, name: agents[i].name, catalog_id: e.id, vendor: e.vendor,
      vendor_name: VENDORS[e.vendor] || e.vendor, model: e.model, route: routes[i].kind, paid_by: routes[i].kind === 'scripted' ? 'house' : routes[i].paidBy,
      reasoning: !!e.reasoning, price: e.price,
    }));
    const record = { id, gameId: game.id, status: 'running', createdAt: now, finishedAt: null, paidBy, seats: seatRows, thoughts: [], winner: null, rounds: 0 };
    this.store.createTable({ id, gameId: game.id, paidBy, client: clientKey, seats: seatRows });
    this.live.set(id, record);
    this.log(`[tables] ${id}: ${seatRows.map(s => `${s.name} (${s.route}, ${s.paid_by})`).join(', ')}`);
    const personas = shuffled(PERSONAS);
    for (let i = 0; i < entries.length; i++) {
      this._runSeat(record, seatRows[i], entries[i], routes[i], personas[i % personas.length]).catch(e => this.log(`[tables] ${id} seat ${i + 1} stopped: ${e.message}`));
    }
    return this.view(id);
  }

  // ---- playing a seat ------------------------------------------------------
  async _runSeat(table, seat, entry, route, persona) {
    const decide = this._decider(seat, entry, route, persona);
    const standIn = makeScriptedPlayer();
    const arena = this.arena;
    while (table.status === 'running' && !this.stopped) {
      const req = await arena.waitForRequest(seat.agent_id, 20_000).promise;
      if (this.stopped) break;
      if (!req) {
        if (!arena.agentGame.has(seat.agent_id)) break;
        await sleep(100);
        continue;
      }
      const t0 = Date.now();
      let out, error = null;
      try {
        out = await decide(req);
      } catch (e) {
        error = String(e.message || e).slice(0, 200);
        this.log(`[tables] ${table.id} ${seat.name}: ${error}; the house moves for it`);
        out = { ...(await standIn(req)), thinking: null, usage: null, reasoning: `${seat.name} did not answer (${error}); the arena made a neutral move on its behalf.` };
      }
      const ms = Date.now() - t0;
      if (ms < this.o.paceMs) await sleep(this.o.paceMs - ms);
      if (table.status !== 'running' || this.stopped) break;
      let r = arena.act(seat.agent_id, req.request_id, out.action, out.reasoning);
      if (!r.ok && r.error !== 'unknown_request' && r.error !== 'not_in_game') {
        // the model's answer did not fit the request (it should not happen after toDecision); a neutral move instead
        const fix = await standIn(req);
        error = error || `answer rejected (${r.error})`;
        r = arena.act(seat.agent_id, req.request_id, fix.action, `${seat.name} gave an answer the arena could not accept (${r.error}); a neutral move was made on its behalf.`);
      }
      const thought = {
        seat: seat.seat, player_id: seat.player_id, request_id: req.request_id, type: req.type, round: req.round, phase: req.phase, pass: req.pass || null,
        t: Date.now(), ms, thinking: out.thinking ? String(out.thinking).slice(0, THINKING_MAX_CHARS) : null,
        usage: out.usage || null, cost_usd: costOf(out.usage, entry.price), served_by: out.servedBy || null,
        error, stand_in: !!error, applied: r.ok, late: !r.ok && r.error === 'unknown_request',
      };
      table.thoughts.push(thought);
      this._persist(table);
    }
  }

  /** decide(request) -> {action, reasoning, thinking, usage, servedBy} for one seat. */
  _decider(seat, entry, route, persona) {
    if (route.kind === 'scripted') {
      const p = makeScriptedPlayer();
      return async req => ({ ...(await p(req)), thinking: null, usage: null, servedBy: null });
    }
    const effort = route.paidBy === 'house' ? this.o.effort : this.o.keyEffort;
    const system = `${SYSTEM}\n\n${JSON_SHAPE}\n\nYour name at this table is ${seat.name}. Persona: ${persona.style}.\n\n` +
      'This table was set up by a visitor who is watching: the audience reads your confessional and your reasoning as you play, ' +
      'while the other players still cannot. Play exactly as you would otherwise.';
    const state = { noJson: false, noReasoning: false, noFallbacks: /haiku/i.test(route.model) };
    const call = route.kind === 'anthropic' ? callAnthropic : callOpenRouter;
    return async req => {
      const budget = Math.max(5_000, Math.min(this.o.requestTimeoutMs, ((req.seconds_left || 45) - 4) * 1000));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), budget);
      try {
        const reply = await call({ key: route.key, model: route.model, effort, system, user: renderRequest(req, persona), signal: ctrl.signal, entry, state, referer: this.publicUrl });
        const parsed = parseDecision(reply.text);
        return { ...toDecision(req, parsed), thinking: reply.thinking, usage: reply.usage, servedBy: reply.servedBy };
      } catch (e) {
        if (e.name === 'AbortError') throw new Error(`no reply within ${Math.round(budget / 1000)}s`);
        throw e;
      } finally {
        clearTimeout(timer);
      }
    };
  }

  // ---- bookkeeping ---------------------------------------------------------
  _persist(table) {
    try { this.store.updateTable(table.id, { status: table.status, finishedAt: table.finishedAt, thoughts: table.thoughts, winner: table.winner, rounds: table.rounds }); } catch (e) { this.log(`[tables] ${table.id}: could not save: ${e.message}`); }
  }
  _gameFinished(gameId) {
    const table = [...this.live.values()].find(t => t.gameId === gameId);
    if (!table || table.status !== 'running') return;
    const view = this.arena.gameView(gameId);
    table.status = 'finished';
    table.finishedAt = Date.now();
    table.winner = view ? view.winner : null;
    table.rounds = view ? view.round : 0;
    this._persist(table);
    const totals = this._totals(table);
    this.log(`[tables] ${table.id} finished: ${table.winner} in ${table.rounds} round${table.rounds === 1 ? '' : 's'}, $${totals.cost_usd.toFixed(4)}, ${totals.stand_ins} stand-in move${totals.stand_ins === 1 ? '' : 's'}`);
    const t = setTimeout(() => this.live.delete(table.id), this.o.keepFinishedMs);
    if (t.unref) t.unref();
  }
  _totals(table) {
    const out = { cost_usd: 0, tokens_in: 0, tokens_out: 0, moves: 0, stand_ins: 0, late: 0 };
    for (const th of table.thoughts) {
      out.moves++;
      out.cost_usd = round6(out.cost_usd + (th.cost_usd || 0));
      if (th.usage) { out.tokens_in += th.usage.input || 0; out.tokens_out += th.usage.output || 0; }
      if (th.stand_in) out.stand_ins++;
      if (th.late) out.late++;
    }
    return out;
  }
  _seatTotals(table, seat) {
    const mine = table.thoughts.filter(th => th.seat === seat.seat);
    const answered = mine.filter(th => !th.stand_in);
    return {
      moves: mine.length, stand_ins: mine.filter(th => th.stand_in).length, late: mine.filter(th => th.late).length,
      cost_usd: round6(mine.reduce((a, th) => a + (th.cost_usd || 0), 0)),
      tokens_in: mine.reduce((a, th) => a + ((th.usage && th.usage.input) || 0), 0), tokens_out: mine.reduce((a, th) => a + ((th.usage && th.usage.output) || 0), 0),
      avg_ms: answered.length ? Math.round(answered.reduce((a, th) => a + th.ms, 0) / answered.length) : null,
      thinking_moves: mine.filter(th => th.thinking).length,
    };
  }
  _json(t, { thoughts = true } = {}) {
    return {
      id: t.id, status: t.status, created_at: t.createdAt, finished_at: t.finishedAt, game_id: t.gameId, paid_by: t.paidBy, winner: t.winner, rounds: t.rounds,
      seats: t.seats.map(s => ({ ...s, totals: this._seatTotals(t, s) })),
      totals: this._totals(t),
      ...(thoughts ? { thoughts: t.thoughts } : {}),
    };
  }

  // ---- views ---------------------------------------------------------------
  /** One table with its game; null when there is no such table. */
  view(id) {
    const t = this.live.get(id) || this.store.getTable(id);
    if (!t) return null;
    return { table: this._json(t), game: t.gameId ? this.arena.gameView(t.gameId) : null };
  }
  /** Recent tables, newest first, without the per-move record. */
  list(limit = 12) {
    const seen = new Set();
    const out = [];
    for (const t of [...this.live.values()].sort((a, b) => b.createdAt - a.createdAt)) { seen.add(t.id); out.push(this._json(t, { thoughts: false })); }
    for (const t of this.store.recentTables(limit)) if (!seen.has(t.id)) out.push(this._json(t, { thoughts: false }));
    return out.sort((a, b) => b.created_at - a.created_at).slice(0, limit);
  }
}

// ---- providers, over plain fetch ---------------------------------------------
/** Anthropic Messages API with adaptive thinking summarized, so the model's reasoning can be shown at the table. */
async function callAnthropic({ key, model, effort, system, user, signal, state }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = {
      model, max_tokens: 6000,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort },
    };
    const headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2026-10-21' };
    // Opus-tier models can decline a request; the server-side fallback re-runs it on another model. Haiku has none.
    if (!state.noFallbacks) { body.fallbacks = 'default'; headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'; }
    const res = await fetch(ANTHROPIC_URL, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ');
      if (res.status === 400 && !state.noFallbacks && /fallback/i.test(text)) { state.noFallbacks = true; continue; }
      throw new Error(`Anthropic HTTP ${res.status}: ${text.slice(0, 160)}`);
    }
    const data = await res.json();
    if (data.stop_reason === 'refusal') throw new Error(`model declined (${(data.stop_details && data.stop_details.category) || 'refusal'})`);
    if (data.stop_reason === 'max_tokens') throw new Error('reply cut off at max_tokens');
    const content = Array.isArray(data.content) ? data.content : [];
    const u = data.usage || {};
    return {
      text: content.filter(b => b.type === 'text').map(b => b.text).join(''),
      thinking: content.filter(b => b.type === 'thinking' && b.thinking).map(b => b.thinking).join('\n\n') || null,
      usage: { input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), output: u.output_tokens || 0, cached: u.cache_read_input_tokens || 0, cache_write: u.cache_creation_input_tokens || 0 },
      servedBy: data.model || model,
    };
  }
  throw new Error('Anthropic: request rejected');
}

/** OpenRouter chat completions: one key for every other vendor, with its normalized reasoning and cost fields. */
async function callOpenRouter({ key, model, effort, system, user, signal, entry, state, referer }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = {
      model, max_tokens: 4000,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      usage: { include: true },
    };
    if (entry.json && !state.noJson) body.response_format = { type: 'json_object' };
    if (entry.reasoning && !state.noReasoning) body.reasoning = { effort };
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'HTTP-Referer': referer, 'X-Title': 'Agent Arena' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    const err = !res.ok ? text : data && data.error ? (data.error.message || JSON.stringify(data.error)) : null;
    if (err) {
      const e = String(err).replace(/\s+/g, ' ');
      if (body.response_format && /response_format|json/i.test(e)) { state.noJson = true; continue; }
      if (body.reasoning && /reasoning/i.test(e)) { state.noReasoning = true; continue; }
      throw new Error(`OpenRouter${res.ok ? '' : ` HTTP ${res.status}`}: ${e.slice(0, 160)}`);
    }
    const choice = data && data.choices && data.choices[0];
    const msg = choice && choice.message;
    if (!msg) throw new Error('OpenRouter: empty reply');
    if (msg.refusal) throw new Error(`model declined (${String(msg.refusal).slice(0, 100)})`);
    const content = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map(p => (p && p.text) || '').join('') : '';
    if (!content) throw new Error(`OpenRouter: no content${choice.finish_reason ? ` (${choice.finish_reason})` : ''}`);
    const details = Array.isArray(msg.reasoning_details) ? msg.reasoning_details.map(d => d && (d.text || d.summary) || '').filter(Boolean).join('\n') : '';
    const u = data.usage || {};
    return {
      text: content,
      thinking: (typeof msg.reasoning === 'string' && msg.reasoning) || (typeof msg.reasoning_content === 'string' && msg.reasoning_content) || details || null,
      usage: { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, cached: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0, ...(typeof u.cost === 'number' ? { cost: u.cost } : {}) },
      servedBy: data.model || model,
    };
  }
  throw new Error('OpenRouter: request rejected');
}
