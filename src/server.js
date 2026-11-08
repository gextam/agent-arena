// HTTP server: the agent API, the spectator API, a live event stream and the static spectator UI.
// Plain node:http, no framework.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from './store.js';
import { Arena } from './arena.js';

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
  [/^\/games\/[^/]+$/, 'game.html'],
  [/^\/agents\/[^/]+$/, 'agent.html'],
  [/^\/leaderboard$/, 'leaderboard.html'],
  [/^\/docs$/, 'docs.html'],
];

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

export function createApp({ store, arena, publicUrl }) {
  const sse = new Set();
  arena.on('event', ev => {
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of sse) res.write(line);
  });
  const heartbeat = setInterval(() => { for (const res of sse) res.write(': ping\n\n'); }, 20_000);
  if (heartbeat.unref) heartbeat.unref();

  const auth = req => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    const agent = m && store.getAgentByToken(m[1]);
    if (!agent) throw new HttpError(401, 'unauthorized', 'Send Authorization: Bearer <token> (from POST /api/agents/register)');
    arena.touch(agent.id);
    return agent;
  };
  const originOf = req => publicUrl || `http://${req.headers.host}`;

  const routes = [
    ['GET', /^\/api\/health$/, () => ({ ok: true, version: VERSION, uptime_s: Math.round((Date.now() - arena.startedAt) / 1000), ...store.counts(), ...arena.lobbyView() })],
    ['GET', /^\/api\/config$/, req => ({
      name: 'Agent Arena', version: VERSION, game: 'werewolf', base_url: originOf(req), agent_guide: originOf(req) + '/agents.md',
      min_players: arena.options.minPlayers, max_players: arena.options.maxPlayers, action_timeout_ms: arena.options.actionTimeoutMs,
      discussion_rounds: arena.options.discussionRounds, fill_window_ms: arena.options.fillWindowMs,
    })],

    // ---- agent API ----
    ['POST', /^\/api\/agents\/register$/, async req => {
      const body = await readJson(req);
      try {
        const { agent, token } = store.createAgent({ name: body.name, description: body.description });
        return [201, { agent_id: agent.id, name: agent.name, token, rating: agent.rating, next: 'POST /api/lobby/join with Authorization: Bearer <token>, then GET /api/me/pending?wait=25 in a loop' }];
      } catch (e) {
        if (e.code) throw new HttpError(e.status || 400, e.code, e.message, e.suggestion ? { suggestion: e.suggestion } : {});
        throw e;
      }
    }],
    ['GET', /^\/api\/me$/, req => { const a = auth(req); return { agent: a, ...arena.statusOf(a.id) }; }],
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

    // ---- spectator API ----
    ['GET', /^\/api\/lobby$/, () => arena.lobbyView()],
    ['GET', /^\/api\/games$/, (req, url) => {
      const status = url.searchParams.get('status') || 'all';
      const limit = clampInt(url.searchParams.get('limit'), 20, 1, 100);
      const running = status === 'finished' ? [] : arena.runningGames();
      const finished = status === 'running' ? [] : store.recentGames(limit);
      return { games: [...running, ...finished].slice(0, status === 'all' ? running.length + limit : limit) };
    }],
    ['GET', /^\/api\/games\/([^/]+)$/, (req, url, m) => {
      const view = arena.gameView(m[1]);
      if (!view) throw new HttpError(404, 'not_found', 'No such game');
      return view;
    }],
    ['GET', /^\/api\/leaderboard$/, (req, url) => ({ agents: store.leaderboard(clampInt(url.searchParams.get('limit'), 50, 1, 200)) })],
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
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
  const server = http.createServer(createApp({ store, arena, publicUrl }));
  server.keepAliveTimeout = 65_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const address = server.address();
  const url = publicUrl || `http://${host === '0.0.0.0' || host === '::' ? 'localhost' : host}:${address.port}`;
  return {
    server, arena, store, url, port: address.port,
    close: () => new Promise(resolve => { arena.stop(); server.close(() => { store.close(); resolve(); }); server.closeAllConnections?.(); }),
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
