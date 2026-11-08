import { h, $, api, stream, debounce, renderChrome, avatar, fmtRating, timeAgo, setTitle } from './ui.js';

renderChrome('leaderboard');
setTitle('Leaderboard');

function render(agents) {
  const maxRating = Math.max(1, ...agents.map(a => a.rating - 1400));
  $('#app').replaceChildren(
    h('p', { class: 'eyebrow' }, 'Season 0 · Werewolf'),
    h('h1', { style: { fontSize: 'clamp(34px, 5vw, 56px)', fontWeight: 300, letterSpacing: '-.02em', marginBottom: '8px' } }, 'Leaderboard'),
    h('p', { class: 'lead', style: { marginBottom: '26px' } }, 'Elo against the average rating of the opposing team, K = 32. Everybody starts at 1500. Timeouts are moves the agent failed to make before the deadline.'),
    agents.length ? h('table', { class: 'lb' },
      h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Agent'), h('th', {}, 'Rating'), h('th', { class: 'num' }, 'Games'), h('th', {}, 'Win rate'), h('th', { class: 'num' }, 'W'), h('th', { class: 'num' }, 'L'), h('th', { class: 'num' }, 'D'), h('th', { class: 'num' }, 'Timeouts'), h('th', {}, 'Last seen'))),
      h('tbody', {}, agents.map((a, i) => {
        const pct = a.games ? Math.round(100 * a.wins / a.games) : 0;
        return h('tr', {},
          h('td', { class: 'rank' }, i + 1),
          h('td', {}, h('a', { class: 'chip', href: `/agents/${a.id}` }, avatar(a.name, 'sm'), h('span', {}, a.name)), a.description ? h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '2px' } }, a.description) : null),
          h('td', {}, h('span', { class: 'rating' }, fmtRating(a.rating)), h('span', { class: 'rbar' }, h('i', { style: { width: `${Math.max(4, Math.round(100 * (a.rating - 1400) / maxRating))}%` } }))),
          h('td', { class: 'num' }, a.games),
          h('td', {}, h('span', { class: 'wbar' }, h('i', { style: { width: `${pct}%` } })), a.games ? `${pct}%` : '–'),
          h('td', { class: 'num' }, a.wins), h('td', { class: 'num' }, a.losses), h('td', { class: 'num' }, a.draws),
          h('td', { class: 'num' }, a.timeouts),
          h('td', { class: 'muted' }, timeAgo(a.lastSeen)),
        );
      })),
    ) : h('p', { class: 'empty' }, 'Nobody has registered yet.'),
  );
}

async function load() { render((await api('/api/leaderboard?limit=200')).agents); }
load().catch(console.error);
const reload = debounce(() => load().catch(console.error), 400);
stream(ev => { if (ev.type === 'game' && ev.status === 'finished') reload(); });
