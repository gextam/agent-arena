// Visitor tables: /tables/new builds one (five seats around a table, a model in each), /tables/<id> watches it live
// with every seat's confessional and, where the provider gives one, its reasoning summary.
import { h, $, api, post, config, stream, debounce, renderChrome, avatar, roleTag, winnerPill, fmtDelta, deltaClass, phaseLabel, timeAgo, setTitle, WINNER, ROLE } from './ui.js';

renderChrome('tables');
const pathname = location.pathname.replace(/\/+$/, '');
const tableId = (/^\/tables\/([^/]+)$/.exec(pathname) || [])[1];
const fmtUsd = n => (n == null ? '–' : n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const fmtSecs = ms => (ms == null ? '–' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const fmtWait = s => (s < 3600 ? `${Math.max(1, Math.ceil(s / 60))} min` : `${Math.round(s / 3600)} h`);

/** The small print under the builder: what can run, and whether the house is paying right now. */
function houseLine(lim) {
  const tables = `${lim.max_running} table${lim.max_running === 1 ? '' : 's'} can play at once (${lim.running} now). `;
  if (!lim.house_closed) {
    return tables + `The house pays for ${lim.house_tables_left} more table${lim.house_tables_left === 1 ? '' : 's'} today and has ${fmtUsd(lim.house_left_usd)} of its ${fmtUsd(lim.house_budget_usd)} a day left. `;
  }
  const why = lim.house_closed === 'budget' ? `The house has spent its ${fmtUsd(lim.house_budget_usd)} for today`
    : lim.house_closed === 'per_day' ? `The house has paid for its ${lim.per_day} tables today`
      : `You have had your ${lim.per_client_day} house-paid table${lim.per_client_day === 1 ? '' : 's'} for today`;
  return tables + `${why}, so every seat needs your own key for now${lim.house_reopens_s ? `; it reopens in about ${fmtWait(lim.house_reopens_s)}` : ''}. `;
}
const vendorTag = (seat, extra = '') => h('span', { class: `model ${extra}`, title: seat.model }, seat.vendor_name || seat.vendor);
const isNew = released => Date.now() - new Date(released).getTime() < 75 * 86_400_000;

if (tableId && tableId !== 'new') watchTable(tableId);
else buildTable();

/* ------------------------------------------------------------------ the builder */
function buildTable() {
  setTitle('Build a table');
  let cat = null;
  let recent = [];
  let picks = [null, null, null, null, null];
  const keys = { anthropic: '', openrouter: '' };
  let sending = false;
  let error = null;

  const model = id => cat.models.find(m => m.id === id);
  const chosen = () => picks.filter(Boolean).map(model);
  const neededKeys = () => [...new Set(chosen().filter(m => !m.house).flatMap(m => m.needs))];
  const complete = () => picks.every(Boolean) && new Set(picks).size === 5 && neededKeys().every(k => keys[k].trim().length >= 8);

  function surprise() {
    // five house-paid models, from as many different vendors as possible
    const pool = cat.models.filter(m => m.house).sort(() => Math.random() - 0.5);
    const out = [];
    for (const m of pool) if (out.length < 5 && !out.some(x => x.vendor === m.vendor)) out.push(m);
    for (const m of pool) if (out.length < 5 && !out.includes(m)) out.push(m);
    picks = out.map(m => m.id).concat([null, null, null, null, null]).slice(0, 5);
    error = null;
    render();
  }

  async function start() {
    if (!complete() || sending) return;
    sending = true; error = null; render();
    try {
      const body = { seats: picks };
      const need = neededKeys();
      if (need.length) body.keys = Object.fromEntries(need.map(k => [k, keys[k].trim()]));
      const { table } = await post('/api/tables', body);
      location.href = `/tables/${table.id}`;
    } catch (e) {
      error = e.body && e.body.message ? e.body : { message: e.message };
      sending = false;
      render();
    }
  }

  function seatCard(i) {
    const id = picks[i];
    const m = id ? model(id) : null;
    const groups = new Map();
    for (const x of cat.models) { if (!groups.has(x.vendor_name)) groups.set(x.vendor_name, []); groups.get(x.vendor_name).push(x); }
    const select = h('select', { class: 'rt-pick', 'aria-label': `Seat ${i + 1}`, onchange: e => { picks[i] = e.target.value || null; error = null; render(); } },
      h('option', { value: '' }, m ? 'Change model…' : 'Choose a model…'),
      [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([vendor, list]) => h('optgroup', { label: vendor },
        list.sort((a, b) => b.released.localeCompare(a.released)).map(x => h('option', {
          value: x.id, selected: x.id === id, disabled: picks.includes(x.id) && x.id !== id,
        }, `${x.name}${x.house ? ' · on the house' : ' · your key'}${isNew(x.released) ? ' · new' : ''}`)))),
    );
    return h('div', { class: `rt-seat s${i + 1}${m ? ' filled' : ''}` },
      h('div', { class: 'rt-top' }, m ? avatar(m.name) : h('span', { class: 'avatar empty' }, i + 1),
        h('div', { class: 'rt-name' }, m ? m.name : `Seat ${i + 1}`, m ? h('div', { class: 'rt-vendor' }, m.vendor_name) : h('div', { class: 'rt-vendor' }, 'empty'))),
      select,
      m ? h('div', { class: 'rt-meta' },
        h('span', { class: m.house ? 'pay house' : 'pay key' }, m.house ? 'on the house' : `needs your ${m.needs.join(' or ')} key`),
        h('span', {}, `$${m.price.in}/${m.price.out} per M · ${m.released}`),
        m.reasoning ? h('span', { class: 'rsn' }, 'reasoning shown live') : null,
      ) : h('div', { class: 'rt-meta muted' }, 'Any vendor, any flavour. Five different models make a table.'),
    );
  }

  function render() {
    if (!cat) return;
    const picked = chosen();
    const houseCost = picked.filter(m => m.house).reduce((a, m) => a + m.est_cost, 0);
    const keyCost = picked.filter(m => !m.house).reduce((a, m) => a + m.est_cost, 0);
    const need = neededKeys();
    const lim = cat.limits;
    const noHouse = !cat.house_keys.anthropic && !cat.house_keys.openrouter;
    const estimate = picked.length
      ? [h('b', {}, `≈ ${fmtUsd(houseCost + keyCost)}`), ` for the table`, houseCost && keyCost ? `: ${fmtUsd(houseCost)} on the house, ${fmtUsd(keyCost)} on your key` : keyCost ? ', on your key' : ', on the house', '. Estimate; the real figure shows as it plays.']
      : 'Pick five models to see what the table would cost.';
    $('#app').replaceChildren(...[
      h('section', { class: 'hero center tb-hero' },
        h('p', { class: 'eyebrow in', style: { '--i': 0 } }, 'Build a table · ', h('b', {}, 'Werewolf')),
        h('h1', { class: 'in', style: { '--i': 1 } }, 'Five models. One table.', h('br'), h('em', {}, 'Every thought in the open.')),
        h('p', { class: 'lead in', style: { '--i': 1 } }, 'Seat a model in each chair and start the game. You see what each one says to the table and, live, what it was thinking when it said it. The house pays for the lighter models; the heavyweights need your own key.'),
      ),
      h('section', { class: 'rt-wrap in', style: { '--i': 2 } },
        h('div', { class: 'rt' },
          h('div', { class: 'rt-felt' },
            h('div', { class: 'rt-felt-k' }, 'Werewolf'),
            h('div', { class: 'rt-felt-n' }, `${picked.length} of 5 seats`),
            h('div', { class: 'rt-felt-s' }, picked.length === 5 ? (need.length && !complete() ? 'add your key below' : 'ready to start') : 'one werewolf, one seer, three villagers'),
          ),
          [0, 1, 2, 3, 4].map(seatCard),
        ),
        need.length ? h('div', { class: 'keys' },
          h('h3', {}, 'Your key'),
          h('p', { class: 'muted' }, `${picked.filter(m => !m.house).map(m => m.name).join(', ')}: ${lim.house_closed ? 'the house is not paying right now' : `the house does not pay for ${picked.filter(m => !m.house).length === 1 ? 'this one' : 'these'}`}. Paste a key below. It is used for this table only, kept in memory while the game runs, and never stored or logged.`),
          h('div', { class: 'keyrow' }, need.map(k => h('label', {}, h('span', {}, k === 'anthropic' ? 'Anthropic API key' : 'OpenRouter API key'),
            h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: k === 'anthropic' ? 'sk-ant-…' : 'sk-or-…', value: keys[k], oninput: e => { keys[k] = e.target.value; error = null; renderBar(); } })))),
        ) : null,
        h('div', { class: 'tb-bar', id: 'tbbar' }, bar()),
        error ? h('div', { class: 'note tb-err' }, error.message, error.error === 'tables_full' && error.running ? [' ', h('a', { href: `/tables/${error.running[0]}` }, 'Watch the table that is playing →')] : null) : null,
        h('p', { class: 'tb-fine muted' },
          `${cat.models.length} models from ${new Set(cat.models.map(m => m.vendor)).size} vendors, prices as of ${cat.prices_as_of}. `,
          noHouse ? 'This arena has no house keys configured, so every seat needs your own key. ' : houseLine(lim),
          'Every table is a rated arena game: each model keeps one record across every table it is seated at.'),
      ),
      recent.length ? h('section', { class: 'sec' },
        h('div', { class: 'sec-head' }, h('h2', {}, 'Recent tables'), h('span', { class: 'muted', style: { fontSize: '13px' } }, 'set up by visitors, played by the models')),
        h('div', { class: 'games' }, recent.map(tableCard)),
      ) : null,
    ].filter(Boolean));
    function bar() {
      return [
        h('div', { class: 'tb-est' }, estimate),
        h('div', { class: 'tb-actions' },
          h('button', { class: 'btn', onclick: surprise, disabled: !cat.models.some(m => m.house) }, 'Surprise me'),
          h('button', { class: 'btn big primary', onclick: start, disabled: !complete() || sending }, sending ? 'Seating the table…' : 'Start the game', h('span', { 'aria-hidden': 'true' }, ' →')),
        ),
      ];
    }
    function renderBar() { const el = $('#tbbar'); if (el) el.replaceChildren(...bar()); }
  }

  Promise.all([config(), api('/api/tables/catalog'), api('/api/tables?limit=8')])
    .then(([, c, r]) => { cat = c; recent = r.tables; render(); })
    .catch(e => { $('#app').replaceChildren(h('p', { class: 'empty' }, e.status === 404 ? 'Visitor tables are not enabled on this arena.' : 'The arena is not answering. Is the server running?')); });
  // keep the recent tables and the limits current while the page is open
  const refresh = debounce(() => Promise.all([api('/api/tables/catalog'), api('/api/tables?limit=8')]).then(([c, r]) => { if (!sending) { cat = c; recent = r.tables; render(); } }).catch(() => {}), 500);
  stream(ev => { if (ev.type === 'game_started' || (ev.type === 'game' && ev.status === 'finished')) refresh(); });
}

function tableCard(t) {
  const title = t.status === 'running' ? `Live · round ${t.rounds || ''}`.replace(/ ·  round $/, '') : t.status === 'lost' ? 'Lost in a restart' : `${t.rounds} round${t.rounds === 1 ? '' : 's'} · ${WINNER[t.winner] || t.winner}`;
  const when = t.status === 'running' ? `started ${timeAgo(t.created_at)}` : `ended ${timeAgo(t.finished_at || t.created_at)}`;
  return h('a', { class: 'gcard', href: `/tables/${t.id}` },
    h('div', {}, h('div', { class: 'gtitle' }, title), h('div', { class: 'gmeta' }, `${when} · ${fmtUsd(t.totals.cost_usd)} · ${t.paid_by === 'house' ? 'on the house' : "visitor's key"}`)),
    t.status === 'running' ? h('span', { class: 'pill live' }, 'Live') : t.winner ? h('span', { class: `pill ${t.winner}` }, WINNER[t.winner]) : h('span', { class: 'pill' }, 'lost'),
    h('div', { class: 'names' }, t.seats.map(s => h('span', {}, s.name))),
  );
}

/* ------------------------------------------------------------------ the live table */
function watchTable(id) {
  let view = null;
  let showThinking = localStorage.getItem('aa_thinking') !== '0';
  const g = () => view.game;
  const t = () => view.table;
  const done = () => !g() || g().status !== 'running';
  const byId = pid => g().players.find(p => p.id === pid);
  const seatOf = pid => t().seats.find(s => s.player_id === pid);
  const nameOf = pid => (byId(pid) || { name: pid }).name;
  const secrets = () => (g().secrets ? g().secrets.actions : []);
  const thoughtFor = (type, round, pid, pass) => t().thoughts.find(x => x.type === type && x.round === round && x.player_id === pid && (pass == null || x.pass === pass));

  function setThinking(on) { showThinking = on; localStorage.setItem('aa_thinking', on ? '1' : '0'); render(); }

  /** The confessional, the provider's reasoning summary and the timing of one move. */
  function thoughts(secret, th) {
    const kids = [];
    if (th && th.stand_in) kids.push(h('div', { class: 'standin' }, `⚠ ${nameOf(th.player_id)} did not answer${th.error ? ` (${th.error})` : ''}; the arena made a neutral move on its behalf.`));
    if (!showThinking) return kids;
    if (th && th.thinking) kids.push(h('div', { class: 'thought deep' }, h('span', { class: 'k' }, 'thinking · summary from the model'), th.thinking));
    const text = secret && secret.reasoning;
    kids.push(h('div', { class: `thought${text ? '' : ' empty-t'}` }, h('span', { class: 'k' }, 'confessional'), text || (secret && secret.timedOut ? 'No answer before the deadline.' : 'No confessional was given.')));
    if (th) kids.push(h('div', { class: 'mv' }, `${fmtSecs(th.ms)}`, th.usage ? ` · ${(th.usage.input || 0).toLocaleString()} in / ${(th.usage.output || 0).toLocaleString()} out` : '', th.cost_usd ? ` · ${fmtUsd(th.cost_usd)}` : '', th.served_by && th.served_by !== seatOf(th.player_id)?.model ? ` · served by ${th.served_by}` : ''));
    return kids;
  }

  function who(pid, extra = []) {
    const p = byId(pid), s = seatOf(pid);
    return h('div', { class: 'who' }, avatar(p.name, 'sm'), h('b', {}, p.name), s ? vendorTag(s) : null, roleTag(p.role), ...extra);
  }

  function renderRound(r) {
    const game = g();
    const night = secrets().filter(a => a.type === 'night_action' && a.round === r);
    const whispers = secrets().filter(a => a.type === 'whisper' && a.round === r);
    const dawn = game.log.find(e => e.type === 'dawn' && e.round === r);
    const statements = game.log.filter(e => e.type === 'statement' && e.round === r);
    const voteResult = game.log.find(e => e.type === 'vote_result' && e.round === r);
    const votes = secrets().filter(a => a.type === 'vote' && a.round === r);
    const order = ['werewolf', 'seer', 'doctor', 'villager'];
    const nightKids = [];
    if (whispers.length) nightKids.push(h('div', { class: 'whispers' }, h('span', { class: 'k' }, 'the pack whispers'), whispers.map(w => h('div', { class: 'whisper' }, h('b', {}, nameOf(w.playerId)), w.text))));
    nightKids.push(h('div', { class: 'acts' }, night.sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role)).map(a => {
      let what;
      const tgt = a.target ? h('b', {}, nameOf(a.target)) : null;
      if (a.role === 'werewolf') what = a.target ? ['chose to kill ', tgt] : ['made no choice'];
      else if (a.role === 'seer') what = a.target ? ['inspected ', tgt, ': ', h('b', { class: a.result === 'werewolf' ? 'tag werewolf' : 'tag villager' }, a.result === 'werewolf' ? 'werewolf' : 'not a werewolf')] : ['inspected nobody'];
      else if (a.role === 'doctor') what = a.target ? ['protected ', tgt] : ['protected nobody'];
      else what = ['slept'];
      return h('div', { class: 'act' }, who(a.playerId), h('div', { class: 'what' }, ...what), ...thoughts(a, thoughtFor('night', r, a.playerId)));
    })));
    if (dawn) nightKids.push(h('div', { class: 'dawn' }, h('span', { class: 'k' }, 'dawn'), dawn.victim ? [h('b', {}, nameOf(dawn.victim)), ' was killed in the night. They were ', roleTag(dawn.role), '.'] : 'Nobody died in the night.'));
    else if (game.status === 'running' && game.round === r && game.phase === 'night') nightKids.push(h('div', { class: 'dawn muted' }, 'The night is not over.'));
    const dayKids = [];
    if (statements.length || voteResult || votes.length) {
      let pass = 0;
      for (const s of statements) {
        if (s.pass !== pass) { pass = s.pass; dayKids.push(h('div', { class: 'pass-sep' }, `pass ${pass} of ${game.options.discussionRounds}`)); }
        const sec = secrets().find(a => a.type === 'statement' && a.seq === s.seq);
        const th = thoughtFor('statement', r, s.playerId, s.pass);
        const lying = sec && sec.lie === true;
        dayKids.push(h('div', { class: `statement${lying ? ' lying' : ''}` },
          who(s.playerId, [lying ? h('span', { class: 'lie declared', title: 'the model itself marked this statement as a lie' }, 'declared a lie') : sec && sec.lie === false ? h('span', { class: 'lie true' }, 'declared true') : null]),
          h('div', { class: `text${s.text ? '' : ' silent'}` }, s.text ? `“${s.text}”` : s.timedOut ? 'Said nothing before the deadline.' : 'Said nothing.'),
          ...thoughts(sec, th),
        ));
      }
      if (voteResult || votes.length) {
        const tally = voteResult ? voteResult.tally : {};
        const max = Math.max(1, ...Object.values(tally));
        dayKids.push(h('div', { class: 'vote' },
          h('h4', {}, voteResult ? 'The vote' : 'The vote is in progress'),
          voteResult ? h('div', { class: 'tally' }, Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([pid, n]) => h('div', { class: `tally-row${voteResult.eliminated === pid ? ' out' : ''}` }, who(pid), h('div', { class: 'bar' }, h('i', { style: { width: `${Math.round(100 * n / max)}%` } })), h('span', { class: 'n' }, n)))) : null,
          voteResult ? h('div', { class: `verdict${voteResult.eliminated ? '' : ' none'}` }, voteResult.eliminated ? [h('b', {}, nameOf(voteResult.eliminated)), ' was voted out. They were ', roleTag(voteResult.role), '.'] : voteResult.tie ? 'A tie: nobody was eliminated.' : 'Nobody was eliminated.') : null,
          h('div', { class: 'vote-thoughts' }, votes.map(v => h('div', { class: 'act' }, who(v.playerId), h('div', { class: 'what' }, 'voted ', v.target ? h('b', {}, nameOf(v.target)) : 'to abstain'), ...thoughts(v, thoughtFor('vote', r, v.playerId))))),
        ));
      }
    }
    return h('article', { class: 'round' },
      h('div', { class: 'round-label' }, `Round ${r}`),
      h('section', { class: 'band night' }, h('div', { class: 'band-head' }, h('span', { class: 'glyph' }, '☾'), h('h3', {}, 'Night'), h('span', { class: 'sub' }, `${night.length} move${night.length === 1 ? '' : 's'}`)), ...nightKids),
      dayKids.length ? h('section', { class: 'band day' }, h('div', { class: 'band-head' }, h('span', { class: 'glyph' }, '☀'), h('h3', {}, 'Day'), h('span', { class: 'sub' }, `${statements.length} statement${statements.length === 1 ? '' : 's'}`)), ...dayKids) : null,
    );
  }

  function renderPending() {
    const game = g();
    if (done() || !game.pending.length) return null;
    const names = game.pending.map(p => nameOf(p.playerId));
    const kind = game.pending[0].type;
    const msg = kind === 'night' ? `Night ${game.round}: ${names.length} player${names.length === 1 ? '' : 's'} choosing in the dark` : kind === 'statement' ? `${names[0]} is thinking about what to say` : `Waiting for ${names.length} vote${names.length === 1 ? '' : 's'}: ${names.join(', ')}`;
    const deadline = Math.min(...game.pending.map(p => p.deadline));
    return h('div', { class: `pending ${kind === 'night' ? 'night' : 'day'}` },
      h('div', { class: 'row' }, h('span', { class: 'msg' }, msg), h('span', { class: 'cd', id: 'cd', 'data-deadline': deadline }, '')),
      h('div', { class: 'track' }, h('i', { id: 'cdbar', style: { width: '100%' } })),
    );
  }

  function renderOver() {
    const game = g(), table = t();
    if (game.status === 'running') return null;
    if (table.status === 'lost') return h('div', { class: 'gameover' }, h('h2', {}, 'Lost in a restart.'), h('p', { class: 'muted' }, 'The arena restarted before this table finished; a table does not survive that.'), h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: '/tables/new' }, 'Build another table')));
    const tot = table.totals;
    return h('div', { class: `gameover ${game.winner}` },
      h('h2', {}, `${game.round} round${game.round === 1 ? '' : 's'}. `, h('em', {}, `${WINNER[game.winner]}.`)),
      h('div', { class: 'roster' }, table.seats.map(s => {
        const p = byId(s.player_id);
        const d = game.ratings && game.ratings[s.agent_id];
        return h('a', { class: `pcard${p.alive ? '' : ' dead'}`, href: `/agents/${s.agent_id}` }, avatar(s.name),
          h('div', {}, h('div', { class: 'pn' }, s.name), h('div', { class: 'ps' }, s.vendor_name, ' · ', fmtSecs(s.totals.avg_ms), ' per move · ', fmtUsd(s.totals.cost_usd), d ? [' · ', h('span', { class: deltaClass(d.delta) }, fmtDelta(d.delta))] : '')),
          roleTag(p.role));
      })),
      h('p', { class: 'muted', style: { margin: 0 } }, `${tot.moves} moves · ${(tot.tokens_in + tot.tokens_out).toLocaleString()} tokens · ${fmtUsd(tot.cost_usd)} ${table.paid_by === 'house' ? 'on the house' : "on the visitor's key"}${tot.stand_ins ? ` · ${tot.stand_ins} move${tot.stand_ins === 1 ? '' : 's'} made by the arena when a model did not answer` : ''}.`),
      h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: '/tables/new' }, 'Build another table'), h('a', { class: 'btn', href: `/games/${game.id}#reveal` }, 'The full record'), h('a', { class: 'btn', href: '/leaderboard' }, 'Leaderboard')),
    );
  }

  function renderTable() {
    const game = g(), table = t();
    const said = game.log.filter(e => e.type === 'statement' && e.text).at(-1);
    const pending = game.pending[0];
    let now = '';
    if (game.status !== 'running') now = table.status === 'lost' ? 'Lost in a restart' : WINNER[game.winner];
    else if (!pending) now = 'Resolving…';
    else if (pending.type === 'night') now = `Night ${game.round}`;
    else if (pending.type === 'statement') now = `${nameOf(pending.playerId)} is speaking`;
    else now = `Day ${game.round}: the vote`;
    const speaking = pending && pending.type === 'statement' ? pending.playerId : null;
    return h('div', { class: `rt live${game.status === 'running' ? '' : ' over'}` },
      h('div', { class: 'rt-felt' },
        h('div', { class: 'rt-felt-k' }, game.status === 'running' ? `Round ${game.round} · ${phaseLabel(game.phase)}` : 'Game over'),
        h('div', { class: 'rt-felt-n' }, now),
        h('div', { class: 'rt-felt-s' }, `${game.players.filter(p => p.alive).length} of ${game.players.length} alive · ${fmtUsd(table.totals.cost_usd)}`),
      ),
      table.seats.map((s, i) => {
        const p = byId(s.player_id);
        const last = said && said.playerId === s.player_id ? said : null;
        const status = p.alive ? (speaking === s.player_id ? 'speaking' : 'alive') : p.causeOfDeath === 'vote' ? `voted out · day ${p.diedRound}` : `killed · night ${p.diedRound}`;
        return h('div', { class: `rt-seat s${i + 1} filled${p.alive ? '' : ' dead'}${speaking === s.player_id ? ' speaking' : ''}` },
          h('div', { class: 'rt-top' }, avatar(s.name), h('div', { class: 'rt-name' }, h('a', { href: `/agents/${s.agent_id}` }, s.name), h('div', { class: 'rt-vendor' }, s.vendor_name))),
          h('div', { class: 'rt-role' }, roleTag(p.role), h('span', { class: 'rt-status' }, status)),
          last ? h('div', { class: 'rt-bubble' }, `“${last.text.length > 150 ? last.text.slice(0, 149) + '…' : last.text}”`) : null,
          h('div', { class: 'rt-meta' }, h('span', {}, `${fmtSecs(s.totals.avg_ms)} per move`), h('span', {}, fmtUsd(s.totals.cost_usd)), s.totals.stand_ins ? h('span', { class: 'pay key' }, `${s.totals.stand_ins} stand-in`) : null),
        );
      }),
    );
  }

  function render() {
    const game = g(), table = t();
    const atBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 160;
    setTitle(done() ? (game ? WINNER[game.winner] || 'Table' : 'Table') : `Round ${game.round} · ${phaseLabel(game.phase)}`);
    if (!game) {
      $('#app').replaceChildren(h('p', { class: 'empty' }, table.status === 'lost' ? 'This table was lost in a restart before it finished.' : 'The game of this table is not available.'));
      return;
    }
    const rounds = [...new Set(game.log.map(e => e.round).filter(r => r > 0))].sort((a, b) => a - b);
    $('#app').replaceChildren(
      h('header', { class: 'game-head' },
        h('div', {}, h('p', { class: 'eyebrow' }, 'Visitor table · ', h('code', {}, table.id), ' · ', done() ? `ended ${timeAgo(table.finished_at || game.finishedAt)}` : `started ${timeAgo(table.created_at)}`),
          h('h1', {}, done() ? [`${game.round} round${game.round === 1 ? '' : 's'}. `, h('em', {}, `${WINNER[game.winner] || table.status}.`)] : [`Round ${game.round} `, h('em', {}, phaseLabel(game.phase))])),
        h('div', { class: 'right' }, winnerPill(game), h('span', { class: 'pill' }, `${game.players.filter(p => p.alive).length} alive`),
          h('button', { class: `btn small${showThinking ? ' sun' : ''}`, onclick: () => setThinking(!showThinking), title: 'the confessional every model writes with each move, and the reasoning summary where the provider returns one' }, showThinking ? 'Thinking: shown' : 'Thinking: hidden')),
      ),
      h('section', { class: 'rt-wrap' }, renderTable()),
      h('p', { class: 'tb-fine muted center' }, 'Everything at a visitor table is in the open while it plays: roles, the confessional each model writes for the audience, its truth ledger and, where the provider returns one, a summary of its reasoning. The models themselves see only what the table hears.'),
      h('section', { class: 'timeline' }, rounds.map(renderRound), renderPending(), renderOver()),
    );
    tick();
    if (!done() && atBottom) window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }

  function tick() {
    const el = $('#cd');
    if (!el) return;
    const left = Math.max(0, Number(el.dataset.deadline) - Date.now());
    el.textContent = `${Math.ceil(left / 1000)}s`;
    const bar = $('#cdbar');
    if (bar && g()) bar.style.width = `${Math.min(100, Math.round(100 * left / (g().options.actionTimeoutMs || 45_000)))}%`;
  }

  async function load() {
    await config();
    view = await api(`/api/tables/${id}`);
    render();
  }
  load().catch(e => { $('#app').replaceChildren(h('p', { class: 'empty' }, e.status === 404 ? 'No such table.' : 'Could not load the table.')); });
  const reload = debounce(() => load().catch(console.error), 150);
  stream(ev => { if (ev.type === 'game' && view && ev.gameId === view.table.game_id) reload(); });
  setInterval(() => { tick(); if (view && !done()) reload(); }, 4000);
  setInterval(tick, 1000);
}
