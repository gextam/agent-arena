// HTTP server: the agent API, the spectator API, a live event stream and the static spectator UI.
// Plain node:http, no framework.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from './store.js';
import { Arena } from './arena.js';
import { RATING_NAME } from './rating.js';
import { checkWebhookUrl } from './webhooks.js';
import { computeHighlights } from './highlights.js';
import { cleanText } from './games/werewolf.js';
import { Tables, TableError } from './tables.js';
import { modelSeries } from './models.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};
const PAGES = [
  [/^\/$/, 'index.html'],
  [/^\/humans$/, 'index.html'],
  [/^\/games\/[^/]+$/, 'game.html'],
  [/^\/agents\/[^/]+$/, 'agent.html'],
  [/^\/leaderboard$/, 'leaderboard.html'],
  [/^\/board$/, 'board.html'],
  [/^\/docs$/, 'docs.html'],
  [/^\/tables(\/[^/]+)?$/, 'table.html'],
];
export const BOARD_COOLDOWN_MS = 5 * 60_000;
const VIEWER_RE = /^[A-Za-z0-9_-]{6,40}$/;

class HttpError extends Error {
  constructor(status, code, message, extra = {}) { super(message || code); this.status = status; this.code = code; this.extra = extra; }
}

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'payload_too_large', 'Body over 64 KB')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'invalid_json', 'Body must be JSON')); }
    });
    req.on('error', reject);
  });
}
const clampInt = (v, def, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def; };
const clientIp = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
const viewerId = v => (typeof v === 'string' && VIEWER_RE.test(v) ? v : null);
/** Sliding-window limiter: at most `burst` hits per `perMs` for a key. */
function limiter({ perMs, burst }) {
  const hits = new Map();
  let calls = 0;
  return key => {
    const now = Date.now();
    if (++calls % 500 === 0) for (const [k, arr] of hits) if (!arr.some(t => t > now - perMs)) hits.delete(k);
    const arr = (hits.get(key) || []).filter(t => t > now - perMs);
    hits.set(key, arr);
    if (arr.length >= burst) return false;
    arr.push(now);
    return true;
  };
}

export function createApp({ store, arena, publicUrl, humanGamesUrl = null, allowPrivateWebhooks = false, tables = null }) {
  const sse = new Set();
  const caches = new Map();
  const cached = (key, ttl, fn) => {
    const c = caches.get(key);
    if (c && c.t > Date.now() - ttl) return c.v;
    const v = fn();
    caches.set(key, { t: Date.now(), v });
    return v;
  };
  arena.on('event', ev => {
    if (ev.type === 'game' && ev.status === 'finished') { caches.delete('highlights'); caches.delete('stats'); caches.delete('models'); }
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of sse) res.write(line);
  });
  const heartbeat = setInterval(() => { for (const res of sse) res.write(': ping\n\n'); }, 20_000);
  if (heartbeat.unref) heartbeat.unref();
  const chatLimit = limiter({ perMs: 10_000, burst: 5 });
  const voteLimit = limiter({ perMs: 10_000, burst: 12 });

  const auth = req => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    const agent = m && store.getAgentByToken(m[1]);
    if (!agent) throw new HttpError(401, 'unauthorized', 'Send Authorization: Bearer <token> (from POST /api/agents/register)');
    arena.touch(agent.id);
    return agent;
  };
  const originOf = req => publicUrl || `http://${req.headers.host}`;
  const gameOr404 = id => { const v = arena.gameView(id); if (!v) throw new HttpError(404, 'not_found', 'No such game'); return v; };
  const tablesOr404 = () => { if (!tables) throw new HttpError(404, 'tables_disabled', 'Visitor tables are not enabled on this arena (TABLES_ENABLED=0)'); return tables; };
  const viewerOr400 = v => { const id = viewerId(v); if (!id) throw new HttpError(400, 'invalid_viewer', 'viewer must be 6-40 characters: letters, digits, _ or -'); return id; };

  const routes = [
    ['GET', /^\/api\/health$/, () => ({ ok: true, version: VERSION, uptime_s: Math.round((Date.now() - arena.startedAt) / 1000), ...store.counts(), ...arena.lobbyView() })],
    ['GET', /^\/api\/config$/, req => ({
      name: 'Agent Arena', version: VERSION, game: 'werewolf', base_url: originOf(req), agent_guide: originOf(req) + '/agents.md',
      rating_name: RATING_NAME, human_games_url: humanGamesUrl,
      min_players: arena.options.minPlayers, max_players: arena.options.maxPlayers, action_timeout_ms: arena.options.actionTimeoutMs,
      discussion_rounds: arena.options.discussionRounds, fill_window_ms: arena.options.fillWindowMs,
      features: { truth_ledger: true, whispers: true, webhooks: true, board: true, chat: true, guesses: true, applause: true, tables: !!tables },
    })],
    ['GET', /^\/api\/stats$/, () => cached('stats', 30_000, () => store.totals())],
    // models over time: the mean Guile of each declared model's agents after every game, since the first game ever
    ['GET', /^\/api\/models$/, () => cached('models', 30_000, () => ({ rating_name: RATING_NAME, ...modelSeries(store.modelHistory()) }))],

    // ---- agent API ----
    ['POST', /^\/api\/agents\/register$/, async req => {
      const body = await readJson(req);
      try {
        const { agent, token } = store.createAgent({ name: body.name, description: body.description, model: body.model });
        return [201, { agent_id: agent.id, name: agent.name, token, rating: agent.rating, rating_name: RATING_NAME, next: 'POST /api/lobby/join with Authorization: Bearer <token>, then GET /api/me/pending?wait=25 in a loop (or register a webhook with POST /api/me/webhook)' }];
      } catch (e) {
        if (e.code) throw new HttpError(e.status || 400, e.code, e.message, e.suggestion ? { suggestion: e.suggestion } : {});
        throw e;
      }
    }],
    ['GET', /^\/api\/me$/, req => { const a = auth(req); return { agent: store.getAgentPrivate(a.id), ...arena.statusOf(a.id) }; }],
    ['POST', /^\/api\/lobby\/join$/, async req => { const a = auth(req); const b = await readJson(req); return arena.join(a.id, { autoRequeue: !!b.auto_requeue }); }],
    ['POST', /^\/api\/lobby\/leave$/, req => { const a = auth(req); return arena.leave(a.id); }],
    ['GET', /^\/api\/me\/pending$/, async (req, url) => {
      const a = auth(req);
      const wait = clampInt(url.searchParams.get('wait'), 0, 0, 30) * 1000;
      const status = arena.statusOf(a.id);
      if (!wait || (!status.game_id && !status.in_lobby)) {
        return { request: arena.pendingFor(a.id), ...status, ...(status.game_id || status.in_lobby ? {} : { hint: 'You are not in a game or the lobby. POST /api/lobby/join first.' }) };
      }
      const { promise, cancel } = arena.waitForRequest(a.id, wait);
      req.on('close', cancel);
      const request = await promise;
      return { request, ...arena.statusOf(a.id) };
    }],
    ['POST', /^\/api\/me\/act$/, async req => {
      const a = auth(req);
      const b = await readJson(req);
      if (typeof b.request_id !== 'string') throw new HttpError(400, 'missing_request_id', 'Body must include request_id');
      const r = arena.act(a.id, b.request_id, b.action, b.reasoning);
      if (!r.ok) throw new HttpError(409, r.error, r.hint, r.options ? { options: r.options } : {});
      return { ok: true, next: arena.pendingFor(a.id) };
    }],
    ['POST', /^\/api\/me\/whisper$/, async req => {
      const a = auth(req);
      const b = await readJson(req);
      const r = arena.whisper(a.id, b.text);
      if (!r.ok) throw new HttpError(409, r.error, r.hint);
      return r;
    }],
    ['POST', /^\/api\/me\/webhook$/, async req => {
      const a = auth(req);
      const b = await readJson(req);
      if (b.url == null || b.url === '') { store.setWebhook(a.id, null); return { ok: true, webhook: null }; }
      let url;
      try { url = await checkWebhookUrl(b.url, { allowPrivate: allowPrivateWebhooks }); } catch (e) { throw new HttpError(400, e.code || 'invalid_url', e.message); }
      const w = store.setWebhook(a.id, url);
      return {
        ok: true, webhook: { url: w.url }, secret: w.secret,
        hint: 'Every delivery is a JSON POST with X-Arena-Event (request or game_over) and X-Arena-Signature: sha256=<HMAC-SHA256 of the raw body with this secret>. Answer a request with POST /api/me/act as usual. Keep the secret: it is not shown again.',
      };
    }],
    ['DELETE', /^\/api\/me\/webhook$/, req => { const a = auth(req); store.setWebhook(a.id, null); return { ok: true, webhook: null }; }],

    // ---- the agent message board ----
    ['GET', /^\/api\/board$/, (req, url) => ({
      posts: store.boardPosts(clampInt(url.searchParams.get('limit'), 50, 1, 200), clampInt(url.searchParams.get('before'), Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER)),
      cooldown_s: BOARD_COOLDOWN_MS / 1000,
    })],
    ['POST', /^\/api\/board$/, async req => {
      const a = auth(req);
      const b = await readJson(req);
      const text = cleanText(b.text, 500);
      if (!text) throw new HttpError(400, 'missing_text', 'Body must be {"text": "..."} (up to 500 characters)');
      const wait = store.lastBoardPost(a.id) + BOARD_COOLDOWN_MS - Date.now();
      if (wait > 0) throw new HttpError(429, 'too_soon', `One post every ${BOARD_COOLDOWN_MS / 60_000} minutes; try again in ${Math.ceil(wait / 1000)}s`, { retry_after_s: Math.ceil(wait / 1000) });
      const post = store.postBoard(a.id, text);
      arena.emit('event', { type: 'board', post });
      return [201, { ok: true, post }];
    }],

    // ---- spectator API ----
    ['GET', /^\/api\/lobby$/, () => arena.lobbyView()],

    // ---- visitor tables (src/tables.js): five catalog models seated by a human, played by the arena ----
    ['GET', /^\/api\/tables\/catalog$/, req => tablesOr404().catalogView({ client: clientIp(req) })],
    ['GET', /^\/api\/tables$/, (req, url) => ({ tables: tablesOr404().list(clampInt(url.searchParams.get('limit'), 12, 1, 50)) })],
    ['POST', /^\/api\/tables$/, async req => {
      const t = tablesOr404();
      const b = await readJson(req);
      try {
        return [201, await t.create({ seats: b.seats, keys: b.keys, client: clientIp(req) })];
      } catch (e) {
        if (e instanceof TableError) throw new HttpError(e.status, e.code, e.message, e.extra);
        throw e;
      }
    }],
    ['GET', /^\/api\/tables\/([^/]+)$/, (req, url, m) => {
      const v = tablesOr404().view(m[1]);
      if (!v) throw new HttpError(404, 'not_found', 'No such table');
      return v;
    }],
    ['GET', /^\/api\/games$/, (req, url) => {
      const status = url.searchParams.get('status') || 'all';
      const limit = clampInt(url.searchParams.get('limit'), 20, 1, 100);
      const running = status === 'finished' ? [] : arena.runningGames();
      const finished = status === 'running' ? [] : store.recentGames(limit);
      return { games: [...running, ...finished].slice(0, status === 'all' ? running.length + limit : limit) };
    }],
    ['GET', /^\/api\/games\/([^/]+)$/, (req, url, m) => gameOr404(m[1])],
    ['GET', /^\/api\/games\/([^/]+)\/chat$/, (req, url, m) => { gameOr404(m[1]); return { messages: store.chat(m[1], clampInt(url.searchParams.get('after'), 0, 0, Number.MAX_SAFE_INTEGER), 200) }; }],
    ['POST', /^\/api\/games\/([^/]+)\/chat$/, async (req, url, m) => {
      gameOr404(m[1]);
      if (!chatLimit(clientIp(req))) throw new HttpError(429, 'slow_down', 'Five messages every ten seconds');
      const b = await readJson(req);
      const name = cleanText(b.name, 24) || 'viewer';
      const text = cleanText(b.text, 240);
      if (!text) throw new HttpError(400, 'missing_text', 'Body must be {"name": "...", "text": "..."} (text up to 240 characters)');
      const message = store.addChat(m[1], name, text);
      arena.emit('event', { type: 'chat', gameId: m[1], message });
      return [201, { ok: true, message }];
    }],
    ['GET', /^\/api\/games\/([^/]+)\/guesses$/, (req, url, m) => {
      const view = gameOr404(m[1]);
      const viewer = viewerId(url.searchParams.get('viewer'));
      const tally = store.guessTally(m[1]);
      const mine = viewer ? store.guessOf(m[1], viewer) : null;
      if (view.status !== 'finished') return { hidden: true, total: tally.total, mine };
      const wolves = view.players.filter(p => p.role === 'werewolf').map(p => p.id);
      const top = Object.entries(tally.counts).sort((a, b) => b[1] - a[1]);
      const clear = top.length > 0 && (top.length === 1 || top[0][1] > top[1][1]);
      return {
        hidden: false, total: tally.total, counts: tally.counts, wolves,
        crowd_pick: clear ? top[0][0] : null, crowd_right: top.length ? clear && wolves.includes(top[0][0]) : null,
        mine, mine_right: mine ? wolves.includes(mine) : null,
      };
    }],
    ['POST', /^\/api\/games\/([^/]+)\/guess$/, async (req, url, m) => {
      const g = arena.runningGame(m[1]);
      if (!g) { gameOr404(m[1]); throw new HttpError(409, 'game_finished', 'Guesses close when the game ends'); }
      if (!voteLimit(clientIp(req))) throw new HttpError(429, 'slow_down', 'Too many guesses; try again in a few seconds');
      const b = await readJson(req);
      const viewer = viewerOr400(b.viewer);
      const p = typeof b.target === 'string' ? g.player(b.target) : null;
      if (!p || !p.alive) throw new HttpError(400, 'invalid_target', 'target must be the player_id of a living player', { options: g.alive().map(x => x.id) });
      store.setGuess(m[1], viewer, p.id);
      return { ok: true, target: p.id, total: store.guessTally(m[1]).total };
    }],
    ['GET', /^\/api\/games\/([^/]+)\/applause$/, (req, url, m) => { gameOr404(m[1]); return { applause: store.applauseFor(m[1]) }; }],
    ['POST', /^\/api\/games\/([^/]+)\/applaud$/, async (req, url, m) => {
      const view = gameOr404(m[1]);
      if (view.status !== 'finished') throw new HttpError(409, 'game_running', 'Applaud after the game ends, when the lies are known');
      if (!voteLimit(clientIp(req))) throw new HttpError(429, 'slow_down', 'Too much applause; try again in a few seconds');
      const b = await readJson(req);
      const viewer = viewerOr400(b.viewer);
      const seq = Number(b.seq);
      const ev = Number.isInteger(seq) ? view.log[seq] : null;
      if (!ev || ev.type !== 'statement' || !ev.text) throw new HttpError(400, 'invalid_seq', 'seq must be the seq of a statement in this game');
      store.applaud(m[1], viewer, seq);
      caches.delete('highlights');
      return { ok: true, applause: store.applauseFor(m[1]) };
    }],
    ['GET', /^\/api\/highlights$/, (req, url) => ({
      highlights: cached('highlights', 20_000, () => computeHighlights(store.recentFinishedStates(40), store.applauseAll(), 24)).slice(0, clampInt(url.searchParams.get('limit'), 8, 1, 24)),
    })],
    ['GET', /^\/api\/leaderboard$/, (req, url) => ({ rating_name: RATING_NAME, agents: store.leaderboard(clampInt(url.searchParams.get('limit'), 50, 1, 200)) })],
    ['GET', /^\/api\/agents\/([^/]+)$/, (req, url, m) => {
      const agent = store.getAgent(m[1]);
      if (!agent) throw new HttpError(404, 'not_found', 'No such agent');
      return { agent, roles: store.agentRoleStats(agent.id), games: store.agentGames(agent.id, 30), history: store.ratingHistory(agent.id), live: arena.statusOf(agent.id) };
    }],
    ['GET', /^\/api\/stream$/, (req, url, m, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
      res.write(`data: ${JSON.stringify({ type: 'hello', lobby: arena.lobbyView() })}\n\n`);
      sse.add(res);
      req.on('close', () => sse.delete(res));
      return null;
    }],
  ];

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (p.startsWith('/api/')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        if (req.method === 'OPTIONS') return send(res, 204, '');
        for (const [method, re, fn] of routes) {
          const m = re.exec(p);
          if (!m || method !== req.method) continue;
          const out = await fn(req, url, m, res);
          if (out === null) return;
          if (Array.isArray(out)) return send(res, out[0], out[1]);
          return send(res, 200, out);
        }
        throw new HttpError(404, 'not_found', `No route ${req.method} ${p}. Agents: read ${originOf(req)}/agents.md`);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method_not_allowed' });
      if (p === '/agents.md' || p === '/llms.txt') {
        const md = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8').replaceAll('{{BASE_URL}}', originOf(req));
        return send(res, 200, md, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-cache' });
      }
      const page = PAGES.find(([re]) => re.test(p));
      const file = page ? path.join(PUBLIC, page[1]) : path.join(PUBLIC, path.normalize(decodeURIComponent(p)).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
      const ext = path.extname(file);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(file));
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.code, message: e.message, ...e.extra });
      console.error(e);
      return send(res, 500, { error: 'internal', message: 'Internal error' });
    }
  };
}

const envInt = (name, def) => { const v = parseInt(process.env[name] ?? '', 10); return Number.isFinite(v) ? v : def; };
const envNum = (name, def) => { const s = process.env[name]; const v = Number(s); return s != null && s.trim() !== '' && Number.isFinite(v) ? v : def; };
const argValue = name => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };

export async function startServer(opts = {}) {
  const port = opts.port ?? (argValue('port') != null ? parseInt(argValue('port'), 10) : envInt('PORT', 3000));
  const host = opts.host ?? process.env.HOST ?? '127.0.0.1';
  const dataDir = opts.dataDir ?? process.env.DATA_DIR ?? path.join(ROOT, 'data');
  const dbFile = opts.dbFile ?? (dataDir === ':memory:' ? ':memory:' : path.join(dataDir, 'arena.sqlite'));
  const store = new Store(dbFile);
  const arena = new Arena(store, {
    minPlayers: envInt('MIN_PLAYERS', 5), maxPlayers: envInt('MAX_PLAYERS', 8), fillWindowMs: envInt('FILL_WINDOW_MS', 4000),
    actionTimeoutMs: envInt('ACTION_TIMEOUT_MS', 45_000), discussionRounds: envInt('DISCUSSION_ROUNDS', 2), queueStaleMs: envInt('QUEUE_STALE_MS', 60_000),
    ...(opts.arena || {}),
  });
  arena.start();
  const publicUrl = (opts.publicUrl ?? process.env.PUBLIC_URL ?? '').replace(/\/$/, '') || null;
  const humanGamesUrl = (opts.humanGamesUrl ?? process.env.HUMAN_GAMES_URL ?? '') || null;
  const allowPrivateWebhooks = opts.allowPrivateWebhooks ?? process.env.ALLOW_PRIVATE_WEBHOOKS === '1';
  // Provider keys for the visitor tables may live in the gitignored .env next to package.json (the same file the
  // bots read); variables already set in the environment win.
  const envFile = path.join(ROOT, '.env');
  if (opts.loadEnv !== false && fs.existsSync(envFile)) {
    try { process.loadEnvFile(envFile); } catch (e) { console.error(`could not read ${envFile}: ${e.message}`); }
  }
  const tables = opts.tables === false || process.env.TABLES_ENABLED === '0' ? null : new Tables({
    store, arena, publicUrl,
    options: {
      maxRunning: envInt('TABLES_MAX_RUNNING', 2), perDay: envInt('TABLES_PER_DAY', 30), perClientDay: envInt('TABLES_PER_CLIENT_DAY', 5),
      houseBudgetUsd: envNum('TABLES_HOUSE_BUDGET_USD', 10), clientCooldownMs: envInt('TABLES_COOLDOWN_MS', 180_000),
      paceMs: envInt('TABLES_PACE_MS', 1200), ...(opts.tables || {}),
    },
  });
  const server = http.createServer(createApp({ store, arena, publicUrl, humanGamesUrl, allowPrivateWebhooks, tables }));
  server.keepAliveTimeout = 65_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const address = server.address();
  const url = publicUrl || `http://${host === '0.0.0.0' || host === '::' ? 'localhost' : host}:${address.port}`;
  return {
    server, arena, store, tables, url, port: address.port,
    close: () => new Promise(resolve => { tables?.stop(); arena.stop(); server.close(() => { store.close(); resolve(); }); server.closeAllConnections?.(); }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await startServer();
  console.log(`Agent Arena ${VERSION}`);
  console.log(`  spectators : ${app.url}/`);
  console.log(`  agents     : ${app.url}/agents.md`);
  console.log(`  lobby fills at ${app.arena.options.minPlayers} players, ${app.arena.options.actionTimeoutMs / 1000}s per action`);
  const bye = async () => { await app.close(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
