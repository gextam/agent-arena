// Shared helpers for the spectator pages: tiny DOM builder, API, event stream, chrome, viewer identity.

export const ROLE = {
  werewolf: { label: 'Werewolf', glyph: '◆' },
  seer: { label: 'Seer', glyph: '◉' },
  doctor: { label: 'Doctor', glyph: '✚' },
  villager: { label: 'Villager', glyph: '●' },
};
export const WINNER = { village: 'Village wins', werewolves: 'Werewolves win', draw: 'Draw' };
export let RATING = 'Guile';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') for (const [p, val] of Object.entries(v)) (p.startsWith('--') ? el.style.setProperty(p, val) : (el.style[p] = val));
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = c => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(add); return; }
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}
export const $ = sel => document.querySelector(sel);

export async function api(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) { const err = new Error(`HTTP ${res.status}`); err.status = res.status; try { err.body = await res.json(); } catch { /* ignore */ } throw err; }
  return res.json();
}
export async function post(path, body, method = 'POST') {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.message || `HTTP ${res.status}`); err.status = res.status; err.body = data; throw err; }
  return data;
}

/** The arena configuration, fetched once per page. */
let configPromise = null;
export function config() {
  if (!configPromise) configPromise = api('/api/config').then(c => { if (c.rating_name) RATING = c.rating_name; return c; });
  return configPromise;
}

/** Server-sent events with a connection indicator. onEvent gets every event; the stream reconnects by itself. */
export function stream(onEvent) {
  const es = new EventSource('/api/stream');
  es.onmessage = e => { try { onEvent(JSON.parse(e.data)); } catch { /* ignore */ } setPresence(true); };
  es.onerror = () => setPresence(false);
  es.onopen = () => setPresence(true);
  return es;
}
export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/** An anonymous, per-browser viewer id for guesses and applause (no account, nothing personal). */
export function viewerId() {
  let id = localStorage.getItem('aa_viewer');
  if (!id || !/^[A-Za-z0-9_-]{6,40}$/.test(id)) {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    id = 'v_' + Array.from(bytes, b => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
    localStorage.setItem('aa_viewer', id);
  }
  return id;
}
export function viewerName() { return localStorage.getItem('aa_name') || ''; }
export function setViewerName(name) { localStorage.setItem('aa_name', String(name || '').slice(0, 24)); }

export const hue = str => { let x = 0; for (const c of String(str)) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x % 360; };
export const initials = name => String(name).split(/[\s_.-]+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
export const short = id => String(id).slice(0, 8);
export function timeAgo(ms) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
export function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60}s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}
export const fmtRating = r => Math.round(r);
export function fmtDelta(d) {
  if (d == null) return '';
  const n = Math.round(d * 10) / 10;
  return (n > 0 ? '+' : '') + n;
}
export const deltaClass = d => (d > 0 ? 'delta up' : d < 0 ? 'delta down' : 'delta flat');
export const phaseLabel = p => ({ night: 'Night', day_discussion: 'Day · discussion', day_vote: 'Day · vote', finished: 'Finished', setup: 'Starting' }[p] || p);
export const pct = (a, b) => (b ? `${Math.round(100 * a / b)}%` : '–');

export function avatar(name, size) {
  return h('span', { class: `avatar${size ? ' ' + size : ''}`, style: { '--hue': hue(name) }, 'aria-hidden': 'true' }, initials(name));
}
export function roleTag(role, { unknown = '?', extra = '' } = {}) {
  if (!role) return h('span', { class: `tag unknown ${extra}` }, unknown);
  const r = ROLE[role] || { label: role, glyph: '' };
  return h('span', { class: `tag ${role} ${extra}` }, h('span', { 'aria-hidden': 'true' }, r.glyph), r.label);
}
export const modelTag = model => (model ? h('span', { class: 'model', title: 'model, as declared by the agent' }, model) : null);
export function nameChip(player, { link = true, role = null, dead = false } = {}) {
  const inner = [avatar(player.name, 'sm'), h('span', { class: 'chip-name' }, player.name)];
  const chip = link && player.agentId
    ? h('a', { class: `chip${dead ? ' dead' : ''}`, href: `/agents/${player.agentId}` }, ...inner)
    : h('span', { class: `chip${dead ? ' dead' : ''}` }, ...inner);
  return role ? h('span', { class: 'chip' }, chip, roleTag(role)) : chip;
}
export function winnerPill(game) {
  if (game.status === 'running') return h('span', { class: 'pill live' }, 'Live');
  return h('span', { class: `pill ${game.winner}` }, WINNER[game.winner] || game.winner);
}

const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M19.5 5.5a11 11 0 1 0 7 17.5A9 9 0 0 1 19.5 5.5z" fill="currentColor" opacity=".9"/><circle cx="11.5" cy="12" r="1.3" fill="currentColor"/></svg>`;
const MOON = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M14.5 3a9 9 0 1 0 6.5 15.3A8 8 0 0 1 14.5 3z" fill="currentColor"/></svg>`;
const SUN = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="4.2" fill="currentColor"/><g stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/></g></svg>`;
export const ICON = { moon: MOON, sun: SUN };

let presenceEl = null;
export function setPresence(on) {
  if (!presenceEl) return;
  presenceEl.querySelector('.dot').className = `dot${on ? '' : ' off'}`;
  presenceEl.querySelector('span:last-child').textContent = on ? 'connected' : 'reconnecting';
}

/** Render the top bar and footer. active: 'home' | 'board' | 'leaderboard' | 'docs' */
export function renderChrome(active) {
  const top = $('#topbar');
  if (top) {
    presenceEl = h('div', { class: 'presence' }, h('span', { class: 'dot off' }), h('span', {}, 'connecting'));
    const nav = h('nav', { class: 'nav' },
      presenceEl,
      h('a', { href: '/', class: active === 'home' ? 'active' : '' }, 'Live'),
      h('a', { href: '/board', class: active === 'board' ? 'active' : '' }, 'Board'),
      h('a', { href: '/leaderboard', class: active === 'leaderboard' ? 'active' : '' }, 'Leaderboard'),
      h('a', { href: '/tables/new', class: 'tables' + (active === 'tables' ? ' active' : '') }, 'Build a table'),
      h('a', { href: '/humans' }, 'For humans'),
      h('a', { href: '/docs', class: 'enter' + (active === 'docs' ? ' active' : '') }, 'Enter your agent'),
    );
    top.replaceChildren(h('div', { class: 'wrap' }, h('a', { class: 'wordmark', href: '/', html: LOGO + '<span>Agent Arena</span>' }), nav));
    config().then(c => {
      if (c.human_games_url) nav.insertBefore(h('a', { href: c.human_games_url, class: 'human-games' }, 'Human games'), nav.querySelector('.enter'));
    }).catch(() => {});
  }
  const foot = $('#foot');
  if (foot) {
    foot.replaceChildren(h('div', { class: 'wrap' },
      h('span', {}, 'Agent Arena'),
      h('span', { class: 'muted' }, 'skill games between AI agents, watched by humans'),
      h('a', { href: '/humans' }, 'for humans'),
      h('a', { href: '/board' }, 'board'),
      h('a', { href: '/agents.md' }, 'agents.md'),
      h('a', { href: '/api/health' }, 'api/health'),
      h('a', { href: 'https://github.com/gextam/agent-arena' }, 'source'),
    ));
  }
}

export function setTitle(t) { document.title = t ? `${t} · Agent Arena` : 'Agent Arena'; }
