#!/usr/bin/env node
// Run a table's worth of reference bots against an arena.
//
//   node bots/run.js                                  # 5 scripted bots against http://localhost:3000, forever
//   node bots/run.js --kind claude --count 5          # 5 Claude players (needs ANTHROPIC_API_KEY or an ant profile)
//   node bots/run.js --kind mixed --count 6           # Claude players seated with scripted ones
//   node bots/run.js --games 1 --delay 1500           # play one game, pause 1.5 s before each move (watchable)
//   node bots/run.js --url https://arena.example.com  # a remote arena
//   node bots/run.js --seats "claude:claude-opus-5-5:Opus 5.5,openai:gpt-5.5:GPT-5.5,openrouter:z-ai/glm-5.3:GLM-5.3"
//                                                     # one seat per entry, provider[:model[:name]]
//   node bots/run.js --lineup lineup.json             # the same as JSON: [{"provider","model","name","persona","effort","base_url","extra"}]
//
// Providers: scripted, claude (Anthropic SDK), and any OpenAI-compatible API: openai, openrouter, deepseek, zai, xai,
// groq, ollama, or NAME with NAME_BASE_URL and NAME_API_KEY in the environment. Keys live in .env (see .env.example).
// Options: --kind scripted|claude|mixed  --count N  --games N  --delay MS  --url URL  --model ID  --effort low|medium|high
//          --names a,b,c  --seats SPEC  --lineup FILE  --no-persist
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startScriptedBot, SCRIPTED_NAMES } from './scripted-bot.js';
import { parseSeats, loadLineup } from './lib/lineup.js';
import { usageReport } from './lib/usage.js';

// Credentials and defaults can live in a gitignored .env next to package.json (see .env.example).
const ENV_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const flag = name => args.includes(`--${name}`);
if (flag('help') || flag('h')) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'));
  process.exit(0);
}

const kind = opt('kind', 'scripted');
const count = parseInt(opt('count', '5'), 10);
const games = opt('games') ? parseInt(opt('games'), 10) : Infinity;
const delayMs = parseInt(opt('delay', '0'), 10);
const baseUrl = opt('url', process.env.ARENA_URL || 'http://localhost:3000');
const names = opt('names') ? opt('names').split(',').map(s => s.trim()).filter(Boolean) : null;
const persist = !flag('no-persist');
const ctrl = new AbortController();
process.on('SIGINT', () => { console.log('\nstopping…'); ctrl.abort(); setTimeout(() => process.exit(0), 500); });

const common = { baseUrl, games, delayMs, persist, signal: ctrl.signal };

// The lineup: an explicit --lineup / --seats, or --kind and --count.
const seats = opt('lineup') ? loadLineup(opt('lineup'))
  : opt('seats') ? parseSeats(opt('seats'))
  : Array.from({ length: count }, (_, i) => ({
    provider: kind === 'claude' || (kind === 'mixed' && i % 2 === 0) ? 'claude' : 'scripted',
    name: names ? names[i] : undefined, model: opt('model'), effort: opt('effort'),
  }));

async function startSeat(seat, i) {
  const provider = seat.provider || 'scripted';
  if (provider === 'scripted') return startScriptedBot({ ...common, name: seat.name || SCRIPTED_NAMES[i % SCRIPTED_NAMES.length] });
  const { PERSONAS } = await import('./lib/prompt.js');
  const persona = PERSONAS.find(p => p.name.toLowerCase() === String(seat.persona || '').toLowerCase()) || PERSONAS[i % PERSONAS.length];
  if (provider === 'claude') {
    const { startClaudeBot } = await import('./claude-bot.js');
    return startClaudeBot({ ...common, persona, name: seat.name || persona.name, model: seat.model || undefined, effort: seat.effort || undefined });
  }
  const { startOpenAIBot } = await import('./openai-bot.js');
  return startOpenAIBot({ ...common, provider, persona, name: seat.name || persona.name, model: seat.model || undefined, apiBaseUrl: seat.base_url, extra: seat.extra });
}

const results = await Promise.allSettled(seats.map((seat, i) => startSeat(seat, i)));
for (const r of results) if (r.status === 'rejected') console.error('bot failed:', r.reason && r.reason.message);
for (const line of usageReport()) console.log(line);
process.exit(results.some(r => r.status === 'rejected') ? 1 : 0);
