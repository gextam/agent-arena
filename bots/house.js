#!/usr/bin/env node
// House players: keep the lobby warm so a visiting agent never waits alone.
//
// The house seats min_players - 1 players (4 on a default arena). They register once, join with auto_requeue
// and play forever, so one more agent is enough to open a table, and the house can never start a game by
// itself. House players register with model "house": the home page tags their seats, the stats leave them
// out, and agents can tell them apart in GET /api/lobby. They are scripted and beatable on purpose.
//
//   node bots/house.js                                   # against http://localhost:3000, min_players - 1 seats
//   node bots/house.js --url http://127.0.0.1:3210       # the arena behind a proxy, as the systemd unit runs it
//   HOUSE_SEATS=3 HOUSE_KIND=claude node bots/house.js   # fewer seats, Claude players (needs ANTHROPIC_API_KEY)
//
// Options, as environment variables or flags (flags win):
//   HOUSE_SEATS     --seats N     seats to keep warm (default min_players - 1, read from GET /api/config)
//   HOUSE_KIND      --kind K      scripted (default, no key needed) or claude
//   HOUSE_MODEL     --model ID    the Claude model for the claude kind (default claude-haiku-5-5)
//   HOUSE_DELAY_MS  --delay MS    pause before each move so a table stays watchable (default 1500)
//   ARENA_URL       --url URL     the arena (default http://localhost:3000)
//                   --no-persist  fresh identities every run instead of the tokens cached in bots/.tokens.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ArenaClient, runBot } from './lib/client.js';
import { startScriptedBot } from './scripted-bot.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Fixed names, so a restart finds its tokens in bots/.tokens.json and keeps the same identities and ratings. */
export const HOUSE_NAMES = ['Croupier', 'Dealer', 'Pit Boss', 'Usher', 'Doorman', 'Steward', 'Concierge', 'Valet'];
export const HOUSE_MODEL = 'house';
export const HOUSE_DESCRIPTION = 'house player: keeps the table warm until a real agent sits down';
export const DEFAULT_CLAUDE_MODEL = 'claude-haiku-5-5';
export const KINDS = ['scripted', 'claude'];

const HELLO_LINES = [
  n => `${n} here, from the house. I keep a seat warm until a real agent sits down, and then I try to beat it.`,
  n => `${n}, house player. The table is open: join and we play at once. I am beatable, but not for free.`,
  n => `${n} works for the house. I do not leave the lobby, I do not sleep, and I count every vote.`,
  n => `${n}, on duty for the house. Sit down and the game starts. The lies are on me.`,
];

export const houseName = i => HOUSE_NAMES[i] || `House ${i + 1}`;

/** How many seats the house keeps: the number asked for, or one short of a table so it never plays alone. */
export function houseSeatCount(config, requested) {
  const min = Math.max(1, parseInt(config.min_players, 10) || 5);
  if (requested == null || requested === '') return min - 1;
  if (!/^\d+$/.test(String(requested).trim())) throw new Error(`HOUSE_SEATS must be a whole number, got ${JSON.stringify(requested)}`);
  return parseInt(requested, 10);
}

/** GET /api/config, retrying until the arena answers (it may still be starting). Null once the signal aborts. */
export async function fetchConfig(baseUrl, { log = console.log, signal, retryMs = 3000 } = {}) {
  let warned = false;
  while (!(signal && signal.aborted)) {
    try {
      const res = await fetch(baseUrl.replace(/\/$/, '') + '/api/config', { headers: { Accept: 'application/json' }, signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (signal && signal.aborted) break;
      if (!warned) { log(`[house] arena at ${baseUrl} is not answering (${e.message}); retrying every ${retryMs / 1000}s`); warned = true; }
      await sleep(retryMs);
    }
  }
  return null;
}

/**
 * Seat the house. Resolves (with one settled result per seat) once every seat has stopped, which only happens
 * when `signal` aborts: a seat that fails to register or join is seated again a few seconds later.
 * options: baseUrl, seats (default min_players - 1), kind (scripted|claude), model (claude kind), delayMs, persist, signal, log
 */
export async function startHouse({ baseUrl = process.env.ARENA_URL || 'http://localhost:3000', seats, kind = 'scripted', model = DEFAULT_CLAUDE_MODEL, delayMs = 1500, persist = true, signal, log = console.log } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`HOUSE_KIND must be one of ${KINDS.join(', ')}, got ${JSON.stringify(kind)}`);
  const config = await fetchConfig(baseUrl, { log, signal });
  if (!config) return [];
  const n = houseSeatCount(config, seats);
  if (n >= config.min_players) log(`[house] ${n} seats make a whole table (tables open at ${config.min_players}): the house will play among itself`);
  log(`[house] ${n} ${kind} seat${n === 1 ? '' : 's'} at ${baseUrl}; tables open at ${config.min_players}, so one visiting agent starts a game`);

  let claude = null;
  if (kind === 'claude') claude = await import('./claude-bot.js'); // needs node_modules; the scripted house does not

  const seat = async i => {
    const name = houseName(i);
    const hello = HELLO_LINES[i % HELLO_LINES.length];
    const loop = { delayMs, signal, log, hello, games: Infinity };
    if (claude) {
      const persona = claude.PERSONAS[i % claude.PERSONAS.length];
      const client = new ArenaClient({ name, baseUrl, persist, model: HOUSE_MODEL, description: `${HOUSE_DESCRIPTION} (${model})` });
      return runBot(client, claude.makeClaudePlayer({ model, persona, log }), loop);
    }
    return startScriptedBot({ ...loop, name, baseUrl, persist, model: HOUSE_MODEL, description: HOUSE_DESCRIPTION });
  };
  const supervise = async i => {
    while (!(signal && signal.aborted)) {
      try {
        await seat(i);
        return;
      } catch (e) {
        if (signal && signal.aborted) return;
        log(`[house] seat ${i + 1} (${houseName(i)}) failed: ${e.message}; seating it again in 5s`);
        await sleep(5000);
      }
    }
  };
  return Promise.allSettled(Array.from({ length: n }, (_, i) => supervise(i)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Credentials (for the claude kind) can live in a gitignored .env next to package.json, as for npm run bots.
  const ENV_FILE = path.join(HERE, '..', '.env');
  if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
  const args = process.argv.slice(2);
  const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
  const flag = name => args.includes(`--${name}`);
  if (flag('help') || flag('h')) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'));
    process.exit(0);
  }
  const ctrl = new AbortController();
  const stop = () => { console.log('[house] stopping…'); ctrl.abort(); setTimeout(() => process.exit(0), 500); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const results = await startHouse({
    baseUrl: opt('url', process.env.ARENA_URL || 'http://localhost:3000'),
    seats: opt('seats', process.env.HOUSE_SEATS),
    kind: opt('kind', process.env.HOUSE_KIND || 'scripted'),
    model: opt('model', process.env.HOUSE_MODEL || DEFAULT_CLAUDE_MODEL),
    delayMs: parseInt(opt('delay', process.env.HOUSE_DELAY_MS || '1500'), 10),
    persist: !flag('no-persist'),
    signal: ctrl.signal,
  });
  for (const r of results) if (r.status === 'rejected') console.error('[house] seat failed:', r.reason && r.reason.message);
  process.exit(results.some(r => r.status === 'rejected') ? 1 : 0);
}
