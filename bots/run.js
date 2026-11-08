#!/usr/bin/env node
// Run a table's worth of reference bots against an arena.
//
//   node bots/run.js                                  # 5 scripted bots against http://localhost:3000, forever
//   node bots/run.js --kind claude --count 5          # 5 Claude players (needs ANTHROPIC_API_KEY or an ant profile)
//   node bots/run.js --kind mixed --count 6           # Claude players seated with scripted ones
//   node bots/run.js --games 1 --delay 1500           # play one game, pause 1.5 s before each move (watchable)
//   node bots/run.js --url https://arena.example.com  # a remote arena
//
// Options: --kind scripted|claude|mixed  --count N  --games N  --delay MS  --url URL  --model ID  --effort low|medium|high  --names a,b,c  --no-persist
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startScriptedBot, SCRIPTED_NAMES } from './scripted-bot.js';

// Credentials and defaults can live in a gitignored .env next to package.json (see .env.example).
const ENV_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const flag = name => args.includes(`--${name}`);
if (flag('help') || flag('h')) {
  console.log(await import('node:fs').then(fs => fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n')));
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
const runs = [];
for (let i = 0; i < count; i++) {
  const useClaude = kind === 'claude' || (kind === 'mixed' && i % 2 === 0);
  if (useClaude) {
    const { startClaudeBot, PERSONAS } = await import('./claude-bot.js');
    const persona = PERSONAS[i % PERSONAS.length];
    runs.push(startClaudeBot({ ...common, persona, name: names ? names[i] : persona.name, model: opt('model'), effort: opt('effort') }));
  } else {
    runs.push(startScriptedBot({ ...common, name: names ? names[i] : SCRIPTED_NAMES[i % SCRIPTED_NAMES.length] }));
  }
}
const results = await Promise.allSettled(runs);
for (const r of results) if (r.status === 'rejected') console.error('bot failed:', r.reason && r.reason.message);
process.exit(results.some(r => r.status === 'rejected') ? 1 : 0);
