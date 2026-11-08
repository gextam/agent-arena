// Captures the README / docs screenshots with headless Chrome over the DevTools protocol.
// No dependencies: Node 22+ has a built-in WebSocket client.
//
//   node tools/screenshots.mjs            # writes docs/screenshots/*.png
//
// It starts its own arena on a random port with a throw-away database, fills it with scripted
// bots (three quick games for history, then one slow game to photograph live), takes the pictures
// and shuts everything down. Nothing private is shown: every agent is a bundled bot.
//
// Environment:
//   CHROME   path to chrome.exe / msedge.exe if it is not in a standard location
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startServer } from '../src/server.js';
import { startScriptedBot } from '../bots/scripted-bot.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const CHROME = process.env.CHROME || CANDIDATES.find(p => fs.existsSync(p));
const W = 1440, H = 900, PORT = 9335;
if (!CHROME) { console.error('No Chrome/Edge found - set CHROME=<path>'); process.exit(1); }
if (typeof WebSocket === 'undefined') { console.error('Node 22 or newer is required (built-in WebSocket).'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- a private arena full of bots ---- */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-arena-shots-'));
const app = await startServer({ port: 0, host: '127.0.0.1', dataDir, arena: { fillWindowMs: 800, actionTimeoutMs: 30_000, tickMs: 100 } });
const BASE = `http://127.0.0.1:${app.port}`;
const api = p => fetch(BASE + p).then(r => r.json());
const ctrl = new AbortController();
const quiet = () => {};
const bot = (name, opts) => startScriptedBot({ name, baseUrl: BASE, persist: false, signal: ctrl.signal, log: quiet, ...opts });
console.log('arena on', BASE, '- playing three quick games for history…');
await Promise.all(['Moonshine', 'Tallow', 'Brambleton', 'Vesper', 'Quill'].map(name => bot(name, { games: 3, delayMs: 0 })));
console.log('history ready:', (await api('/api/health')).games, 'games');

/* ---- headless Chrome ---- */
const profile = path.join(os.tmpdir(), 'agent_arena_shots_profile');
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--window-size=${W},${H}`, '--hide-scrollbars', '--disable-gpu',
  '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
let target = null;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); target = list.find(t => t.type === 'page'); } catch { /* not up yet */ }
}
if (!target) { chrome.kill(); throw new Error('Chrome did not expose a page target'); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = ev => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
  if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
};
const cdp = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async expr => {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'eval failed');
  return r.result.value;
};
const waitFor = async (expr, ms = 60_000, label = expr) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await evalJs(expr)) return true; } catch { /* loading */ } await sleep(200); }
  throw new Error('Timed out waiting for: ' + label);
};
const open = async (p, ready = "document.querySelector('#app') && document.querySelector('#app').children.length > 0") => {
  await cdp('Page.navigate', { url: BASE + p });
  await waitFor(ready, 30_000, p);
  await evalJs('document.fonts.ready.then(() => 1)');
  await sleep(1400); // let the entrance animation finish
};
const settle = async () => { await evalJs('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))'); await sleep(250); };
const shot = async name => {
  await settle();
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  console.log('wrote', name);
};
// An element rendered at 2x for a crisp close-up. Scrolls it into view first; clip is in page coordinates.
const shotEl = async (name, selector, pad = 12, scale = 2) => {
  const box = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'start' }); window.scrollBy(0, -80);
    const b = el.getBoundingClientRect(); return { x: b.left + window.scrollX, y: b.top + window.scrollY, width: b.width, height: b.height }; })()`);
  if (!box) throw new Error('No element for ' + selector);
  await settle();
  const clip = { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: Math.min(box.height + pad * 2, 1800), scale };
  const r = await cdp('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  console.log('wrote', name);
};

try {
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  /* ---- the lobby, half full ---- */
  const slow = { games: 1, delayMs: 2000 };
  const first = ['Harrow', 'Sable', 'Finch'].map(name => bot(name, slow));
  for (let i = 0; i < 50 && (await api('/api/lobby')).waiting.length < 3; i++) await sleep(100);
  await open('/');
  await shotEl('lobby.png', '.lobby', 0);

  /* ---- a live table ---- */
  const rest = ['Marrow', 'Lantern', 'Rook'].map(name => bot(name, slow));
  let game = null;
  for (let i = 0; i < 300 && !game; i++) {
    await sleep(300);
    const running = (await api('/api/games?status=running')).games;
    if (running.length) {
      const view = await api(`/api/games/${running[0].id}`);
      if (view.phase === 'day_discussion' && view.log.filter(e => e.type === 'statement').length >= 3) game = view;
    }
  }
  if (!game) throw new Error('the slow game never reached a discussion');
  await open('/');
  await shot('home.png');
  await open(`/games/${game.id}`, "document.querySelectorAll('.statement').length >= 3");
  await shot('game-live.png');

  /* ---- the finished game, then the reveal ---- */
  await Promise.all([...first, ...rest]);
  await open(`/games/${game.id}`, "document.querySelector('.gameover')");
  await shot('game-finished.png');
  await shotEl('game-over.png', '.gameover', 0);
  // a query string makes this a real navigation (a bare hash change would not reload the page)
  await cdp('Page.navigate', { url: `${BASE}/games/${game.id}?revealed=1#reveal` });
  await waitFor("document.querySelectorAll('.thought').length > 5", 30_000, 'reveal');
  await evalJs('document.fonts.ready.then(() => 1)');
  await sleep(2500); // the staggered unfold
  await evalJs("document.querySelector('.band.day').scrollIntoView({ block: 'start' }); window.scrollBy(0, -80); 1");
  await shot('game-reveal.png');
  await shotEl('night-reveal.png', '.band.night', 0);
  await shotEl('vote.png', '.vote', 14);
  await shotEl('statement-reveal.png', '.statement.lying', 0);

  /* ---- leaderboard, an agent, the guide ---- */
  await open('/leaderboard', "document.querySelector('table.lb tbody tr')");
  await shot('leaderboard.png');
  const top = (await api('/api/leaderboard?limit=1')).agents[0];
  await open(`/agents/${top.id}`, "document.querySelector('.hrow')");
  await shot('agent.png');
  await open('/docs', "document.querySelector('.doc h2')");
  await shot('docs.png');
  console.log('done ->', OUT);
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  try { ws.close(); } catch { /* ignore */ }
  chrome.kill();
  ctrl.abort();
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit();
}
