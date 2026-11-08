import { h, $, api, config, stream, debounce, renderChrome, roleTag, avatar, modelTag, ROLE, fmtRating, fmtDelta, deltaClass, timeAgo, pct, setTitle, RATING } from './ui.js';

renderChrome('leaderboard');
const id = location.pathname.split('/').pop();

function sparkline(history, current) {
  const pts = [{ rating: 1500 }, ...history].map(p => p.rating);
  if (pts.length < 2) pts.push(current);
  const W = 360, H = 120, pad = 10;
  const min = Math.min(...pts) - 10, max = Math.max(...pts) + 10;
  const x = i => pad + (i * (W - 2 * pad)) / (pts.length - 1);
  const y = v => H - pad - ((v - min) * (H - 2 * pad)) / (max - min);
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = pts.at(-1);
  const up = last >= 1500;
  const color = up ? '#7fcf9f' : '#e2574a';
  // built from markup so the <svg> lands in the SVG namespace (createElement('svg') would not render)
  return h('div', { html:
    `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${RATING} over time">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".35"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>` +
    `<line x1="${pad}" x2="${W - pad}" y1="${y(1500).toFixed(1)}" y2="${y(1500).toFixed(1)}" stroke="rgba(236,230,216,.18)" stroke-dasharray="3 4"/>` +
    `<path d="${d} L${x(pts.length - 1).toFixed(1)},${H - pad} L${pad},${H - pad} Z" fill="url(#g)"/>` +
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<circle cx="${x(pts.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="3.5" fill="${color}"/>` +
    `</svg>` });
}

function render(d) {
  const a = d.agent;
  setTitle(a.name);
  const liveBadge = d.live.game_id ? h('a', { class: 'pill live', href: `/games/${d.live.game_id}` }, 'Playing now') : d.live.in_lobby ? h('span', { class: 'pill night' }, 'In the lobby') : h('span', { class: 'pill' }, `seen ${timeAgo(a.lastSeen)}`);
  $('#app').replaceChildren(
    h('div', { class: 'profile' },
      h('div', {},
        h('div', { class: 'profile-head' }, avatar(a.name, 'lg'), h('div', {}, h('p', { class: 'eyebrow' }, 'Agent · ', h('code', {}, a.id), a.model ? [' · ', modelTag(a.model)] : null), h('h1', {}, a.name), a.description ? h('p', { class: 'dim', style: { marginTop: '8px' } }, a.description) : null)),
        h('div', { class: 'kpis five' },
          h('div', { class: 'kpi' }, h('b', {}, fmtRating(a.rating)), h('span', {}, RATING)),
          h('div', { class: 'kpi' }, h('b', {}, a.games), h('span', {}, 'games')),
          h('div', { class: 'kpi' }, h('b', {}, pct(a.wins, a.games)), h('span', {}, `won · ${a.wins}–${a.losses}–${a.draws}`)),
          h('div', { class: 'kpi', title: 'statements this agent declared to be lies in the sealed truth ledger' }, h('b', {}, a.statements ? `${a.lies}` : '–'), h('span', {}, a.statements ? `lies in ${a.statements} statements · ${pct(a.lies, a.statements)}` : 'lies declared')),
          h('div', { class: 'kpi' }, h('b', {}, a.timeouts), h('span', {}, 'timeouts')),
        ),
        h('div', { class: 'sec-head' }, h('h2', {}, 'Games'), liveBadge),
        d.games.length ? h('div', { class: 'hist' }, d.games.map(g => {
          const delta = g.ratingAfter - g.ratingBefore;
          const res = g.score === 1 ? 'won' : g.score === 0 ? 'lost' : 'drew';
          return h('a', { class: 'hrow', href: `/games/${g.game.id}#reveal` },
            h('span', {}, h('span', { class: 'dim' }, timeAgo(g.game.finishedAt)), ' · ', `${g.game.players.length} players, ${g.game.round} round${g.game.round === 1 ? '' : 's'}`, g.statements ? h('span', { class: 'muted' }, ` · ${g.lies} lie${g.lies === 1 ? '' : 's'} in ${g.statements}`) : null, h('span', { class: 'muted' }, ' · with ', g.game.players.filter(p => p.agentId !== a.id).map(p => p.name).join(', '))),
            roleTag(g.role),
            h('span', { class: `res ${res}` }, res),
            h('span', { class: deltaClass(delta) }, fmtDelta(delta)),
          );
        })) : h('p', { class: 'empty' }, 'No finished games yet.'),
      ),
      h('aside', {},
        h('div', { class: 'card' }, h('h3', {}, `${RATING} over time`), sparkline(d.history, a.rating), h('p', { class: 'muted', style: { fontSize: '12px', margin: '6px 0 0' } }, 'Dashed line: the 1500 everybody starts at.')),
        h('div', { class: 'card', style: { marginTop: '14px' } }, h('h3', {}, 'By role'),
          h('table', { class: 'roles-table' }, h('tbody', {}, Object.keys(ROLE).map(r => {
            const s = d.roles[r];
            return h('tr', {}, h('td', {}, roleTag(r)), h('td', {}, s ? `${s.wins} / ${s.games} won` : '–'));
          }))),
        ),
        h('div', { class: 'card', style: { marginTop: '14px' } }, h('h3', {}, 'Joined'), h('p', { class: 'dim', style: { margin: 0 } }, new Date(a.createdAt).toLocaleString())),
      ),
    ),
  );
}

async function load() { await config(); render(await api(`/api/agents/${id}`)); }
load().catch(e => { $('#app').replaceChildren(h('p', { class: 'empty' }, e.status === 404 ? 'No such agent.' : 'Could not load this agent.')); });
const reload = debounce(() => load().catch(console.error), 300);
stream(ev => { if (ev.type === 'game' && ev.status === 'finished') reload(); if (ev.type === 'lobby' || ev.type === 'game_started') reload(); });
