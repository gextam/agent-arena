import { h, $, api, post, config, stream, debounce, renderChrome, roleTag, nameChip, avatar, winnerPill, ROLE, WINNER, ICON, fmtRating, fmtDelta, deltaClass, fmtDuration, timeAgo, phaseLabel, short, setTitle, viewerId, viewerName, setViewerName, pct } from './ui.js';

renderChrome('home');
const id = location.pathname.split('/').pop();
const viewer = viewerId();
let game = null;
let revealed = location.hash === '#reveal';
let justRevealed = false;
let chat = [];
let guesses = null;
let applause = {};
let myClap = localStorage.getItem(`aa_clap_${id}`);

const byId = pid => game.players.find(p => p.id === pid);
const nameOf = pid => (byId(pid) || { name: pid }).name;
const done = () => game.status === 'finished';
const knownRole = pid => { const p = byId(pid); return done() || !p.alive ? p.role : null; };
const secret = (type, round, playerId, seq) => game.secrets && game.secrets.actions.find(a => a.type === type && a.round === round && a.playerId === playerId && (seq == null || a.seq === seq));
const thoughtCount = { n: 0 };

function note(msg) {
  const el = $('#note');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(note.t);
  note.t = setTimeout(() => { el.hidden = true; }, 3500);
}

function thought(text, timedOut) {
  if (!revealed) return null;
  const i = thoughtCount.n++;
  if (!text) return h('div', { class: 'thought empty-t', style: { '--i': i } }, h('span', { class: 'k' }, 'thinking'), timedOut ? 'No answer before the deadline.' : 'No reasoning was given.');
  return h('div', { class: 'thought', style: { '--i': i } }, h('span', { class: 'k' }, 'thinking'), text);
}

function buildRounds() {
  const rounds = new Map();
  const get = r => { if (!rounds.has(r)) rounds.set(r, { round: r, phases: [], night: { actions: [], whispers: [], dawn: null, result: null }, statements: [], voteResult: null }); return rounds.get(r); };
  for (const e of game.log) {
    if (e.type === 'phase') get(e.round).phases.push(e.phase);
    else if (e.type === 'dawn') get(e.round).night.dawn = e;
    else if (e.type === 'statement') get(e.round).statements.push(e);
    else if (e.type === 'vote_result') get(e.round).voteResult = e;
  }
  if (game.secrets) {
    for (const a of game.secrets.actions) {
      if (a.type === 'night_action') get(a.round).night.actions.push(a);
      if (a.type === 'night_result') get(a.round).night.result = a;
      if (a.type === 'whisper') get(a.round).night.whispers.push(a);
    }
  }
  return [...rounds.values()].sort((a, b) => a.round - b.round);
}

function nightActionText(a) {
  const t = a.target ? h('b', {}, nameOf(a.target)) : null;
  switch (a.role) {
    case 'werewolf': return a.target ? ['chose to kill ', t, a.timedOut ? ' (picked at random after the deadline)' : ''] : ['made no choice'];
    case 'seer': return a.target ? ['inspected ', t, ': ', h('b', { class: a.result === 'werewolf' ? 'tag werewolf' : 'tag villager' }, a.result === 'werewolf' ? 'werewolf' : 'not a werewolf')] : ['inspected nobody'];
    case 'doctor': return a.target ? ['protected ', t] : ['protected nobody'];
    default: return ['slept'];
  }
}

function renderNight(r) {
  const kids = [h('div', { class: 'band-head' }, h('span', { class: 'glyph', html: ICON.moon }), h('h3', {}, `Night ${r.round}`), h('span', { class: 'sub' }, 'the village sleeps'))];
  if (revealed && r.night.whispers.length) {
    kids.push(h('div', { class: 'whispers' }, h('span', { class: 'k' }, 'pack whispers · sealed until now'),
      r.night.whispers.map(w => h('div', { class: 'whisper' }, h('b', {}, nameOf(w.playerId)), w.text))));
  }
  if (revealed && r.night.actions.length) {
    kids.push(h('div', { class: 'acts' }, r.night.actions.map(a => h('div', { class: 'act' },
      nameChip(byId(a.playerId), { role: a.role }),
      h('div', { class: 'what' }, ...nightActionText(a)),
      thought(a.reasoning, a.timedOut),
    ))));
    if (r.night.result && r.night.result.saved) kids.push(h('div', { class: 'dawn' }, h('span', { class: 'k' }, 'saved'), h('span', {}, `The doctor was standing over ${nameOf(r.night.result.wolfTarget)}.`)));
  }
  const d = r.night.dawn;
  if (d) {
    kids.push(h('div', { class: 'dawn' }, h('span', { class: 'k' }, 'dawn'),
      d.victim ? [h('span', {}, nameOf(d.victim), ' was found dead.'), roleTag(d.role)] : h('span', {}, 'Nobody died.')));
  } else if (game.status === 'running' && game.phase === 'night' && game.round === r.round) {
    kids.push(h('div', { class: 'dawn muted' }, h('span', { class: 'k' }, 'now'), 'Choices are being made in the dark…'));
  }
  return h('div', { class: 'band night' }, kids);
}

async function clap(seq) {
  try {
    const r = await post(`/api/games/${id}/applaud`, { viewer, seq });
    applause = r.applause;
    myClap = String(seq);
    localStorage.setItem(`aa_clap_${id}`, myClap);
    render();
  } catch (e) { note(e.message); }
}

function renderDay(r) {
  if (!r.phases.includes('day_discussion')) return null;
  const kids = [h('div', { class: 'band-head' }, h('span', { class: 'glyph', html: ICON.sun }), h('h3', {}, `Day ${r.round}`), h('span', { class: 'sub' }, `${game.players.filter(p => p.alive || (p.diedRound === r.round && p.causeOfDeath === 'vote') || (p.diedRound > r.round)).length} at the table`))];
  const statements = [];
  let pass = 0;
  for (const s of r.statements) {
    if (s.pass !== pass) { pass = s.pass; if (game.options.discussionRounds > 1) statements.push(h('div', { class: 'pass-sep' }, `pass ${pass} of ${game.options.discussionRounds}`)); }
    const p = byId(s.playerId);
    const role = knownRole(s.playerId);
    const sec = secret('statement', r.round, s.playerId, s.seq);
    const declared = !!(sec && sec.lie === true);
    const wolf = revealed && p.role === 'werewolf';
    const lying = wolf || (revealed && declared);
    statements.push(h('article', { class: `statement${lying ? ' lying' : ''}` },
      h('div', { class: 'who' }, nameChip(p), role ? roleTag(role) : null,
        wolf ? h('span', { class: 'lie' }, 'wolf speaking') : null,
        revealed && declared ? h('span', { class: 'lie declared', title: 'the agent itself marked this statement as a lie in the sealed ledger' }, 'declared a lie') : null,
        revealed && sec && sec.lie === false ? h('span', { class: 'lie true', title: 'the agent marked this statement as true in the sealed ledger' }, 'declared true') : null,
        done() && revealed && lying && s.text ? h('button', { class: `clap${myClap === String(s.seq) ? ' on' : ''}`, title: 'applaud this as the best lie of the game', onclick: () => clap(s.seq) }, `👏 ${applause[s.seq] || 0}`) : null,
        h('span', { class: 'pass' }, `#${s.seq}`)),
      h('p', { class: `text${s.text ? '' : ' silent'}` }, s.text || (s.timedOut ? 'Said nothing before the deadline.' : 'Said nothing.')),
      sec ? thought(sec.reasoning, sec.timedOut) : null,
    ));
  }
  kids.push(h('div', { class: 'statements' }, statements));
  const v = r.voteResult;
  if (v) {
    const voters = Object.keys(v.votes);
    const tallyEntries = Object.entries(v.tally).sort((a, b) => b[1] - a[1]);
    const maxN = Math.max(1, voters.length);
    kids.push(h('div', { class: 'vote' },
      h('h4', {}, 'The vote'),
      h('div', { class: 'tally' }, tallyEntries.map(([pid, n]) => h('div', { class: `tally-row${v.eliminated === pid ? ' out' : ''}` },
        nameChip(byId(pid), { role: knownRole(pid) }),
        h('div', { class: 'bar' }, h('i', { style: { width: `${Math.round(100 * n / maxN)}%` } })),
        h('span', { class: 'n' }, n),
      ))),
      h('div', { class: 'ballots' }, voters.map(voter => h('span', { class: 'ballot' }, avatar(nameOf(voter), 'sm'), nameOf(voter), h('span', { class: 'arrow' }, '→'), v.votes[voter] ? nameOf(v.votes[voter]) : h('span', { class: 'ab' }, 'abstained')))),
      v.eliminated
        ? h('div', { class: 'verdict' }, h('span', {}, nameOf(v.eliminated), ' was voted out.'), roleTag(v.role))
        : h('div', { class: 'verdict none' }, v.tie ? 'A tie. Nobody was eliminated.' : 'Nobody was eliminated.'),
      revealed ? h('div', { class: 'vote-thoughts' }, voters.map(voter => {
        const sec = secret('vote', r.round, voter);
        return h('div', { class: 'act' }, nameChip(byId(voter), { role: byId(voter).role }), h('div', { class: 'what' }, 'voted ', v.votes[voter] ? h('b', {}, nameOf(v.votes[voter])) : 'to abstain'), sec ? thought(sec.reasoning, sec.timedOut) : null);
      })) : null,
    ));
  }
  return h('div', { class: 'band day' }, kids);
}

function renderPending() {
  if (game.status !== 'running' || !game.pending.length) return null;
  const deadline = Math.min(...game.pending.map(p => p.deadline));
  const total = game.options.actionTimeoutMs;
  const type = game.pending[0].type;
  let msg;
  if (type === 'night') msg = `Night ${game.round}. ${game.pending.length} player${game.pending.length === 1 ? '' : 's'} choosing in the dark…`;
  else if (type === 'statement') msg = `${nameOf(game.pending[0].playerId)} is speaking…`;
  else msg = `Voting. Waiting on ${game.pending.map(p => nameOf(p.playerId)).join(', ')}…`;
  return h('div', { class: `pending ${type === 'night' ? 'night' : 'day'}`, 'data-deadline': deadline, 'data-total': total },
    h('div', { class: 'row' }, h('span', { class: `pill ${type === 'night' ? 'night' : 'live'}` }, type === 'night' ? 'Night' : 'Day'), h('span', { class: 'msg' }, msg), h('span', { class: 'cd' }, '')),
    h('div', { class: 'track' }, h('i', { style: { width: '100%' } })),
  );
}
function tickCountdown() {
  const el = $('.pending');
  if (!el) return;
  const left = Math.max(0, +el.dataset.deadline - Date.now());
  el.querySelector('.cd').textContent = `${Math.ceil(left / 1000)}s`;
  el.querySelector('.track i').style.width = `${Math.round(100 * left / +el.dataset.total)}%`;
}

function renderGameOver() {
  if (!done()) return null;
  const over = game.log.find(e => e.type === 'game_over');
  const dur = game.finishedAt - game.createdAt;
  const lies = Object.values(game.stats.lies || {}).reduce((a, b) => a + b, 0);
  const statements = Object.values(game.stats.statements || {}).reduce((a, b) => a + b, 0);
  const whispers = game.secrets ? game.secrets.actions.filter(a => a.type === 'whisper').length : 0;
  return h('section', { class: `gameover ${game.winner}` },
    h('p', { class: 'eyebrow' }, `Game over after ${game.round} round${game.round === 1 ? '' : 's'} · ${fmtDuration(dur)}`),
    h('h2', {}, game.winner === 'draw' ? 'A draw.' : [WINNER[game.winner].split(' ')[0] + ' ', h('em', {}, game.winner === 'village' ? 'wins.' : 'win.')]),
    h('p', { class: 'ledger' }, `Truth ledger: ${statements} statement${statements === 1 ? '' : 's'}, ${lies} declared ${lies === 1 ? 'a lie' : 'lies'}${whispers ? `, ${whispers} pack whisper${whispers === 1 ? '' : 's'}` : ''}.`),
    h('div', { class: 'roster' }, game.players.map(p => {
      const d = game.ratings && game.ratings[p.agentId];
      const l = (game.stats.lies || {})[p.id] || 0;
      return h('a', { class: `pcard${p.alive ? '' : ' dead'}`, href: `/agents/${p.agentId}` }, avatar(p.name),
        h('div', {}, h('div', { class: 'pn' }, p.name), h('div', { class: 'ps' }, d ? [fmtRating(d.before), ' ', h('span', { class: deltaClass(d.delta) }, fmtDelta(d.delta))] : '', l ? ` · ${l} lie${l === 1 ? '' : 's'}` : '')),
        roleTag(over ? over.roles[p.id] : p.role));
    })),
    h('div', { class: 'actions' },
      revealed ? h('span', { class: 'muted', style: { fontSize: '13px' } }, 'Private reasoning, the truth ledger and the whispers are shown in the timeline above. Applaud the best lie with 👏.') : h('button', { class: 'btn sun', onclick: () => setRevealed(true) }, 'Reveal every private thought'),
      h('a', { class: 'btn small', href: '/' }, 'Back to the arena'),
    ),
  );
}

/* ---- guess the wolf -------------------------------------------------------- */
async function loadGuesses() { guesses = await api(`/api/games/${id}/guesses?viewer=${viewer}`).catch(() => null); }
async function guess(target) {
  try { await post(`/api/games/${id}/guess`, { viewer, target }); await loadGuesses(); render(); } catch (e) { note(e.body && e.body.message || e.message); }
}
function recordGuess() {
  if (!guesses || guesses.hidden || !guesses.mine) return;
  const rec = JSON.parse(localStorage.getItem('aa_guess_record') || '{"games":0,"right":0,"seen":[]}');
  if (rec.seen.includes(id)) return;
  rec.seen = rec.seen.concat(id).slice(-300); rec.games++; if (guesses.mine_right) rec.right++;
  localStorage.setItem('aa_guess_record', JSON.stringify(rec));
}
function renderGuess() {
  const box = h('div', { class: 'guess', id: 'guess' });
  if (!done()) {
    const alive = game.players.filter(p => p.alive);
    box.append(h('h4', {}, 'Who is the wolf?'),
      h('div', { class: 'opts' }, alive.map(p => h('button', { class: `gbtn${guesses && guesses.mine === p.id ? ' mine' : ''}`, onclick: () => guess(p.id) }, avatar(p.name, 'sm'), p.name))),
      h('p', { class: 'res' }, guesses && guesses.mine ? [`You picked `, h('b', {}, nameOf(guesses.mine)), '. '] : 'Pick a suspect. ', guesses && guesses.total ? `${guesses.total} viewer${guesses.total === 1 ? ' has' : 's have'} guessed; the tally is sealed until the game ends.` : 'Guesses are sealed until the game ends.'));
    return box;
  }
  if (!guesses || guesses.hidden) return null;
  if (!guesses.total) return h('div', { class: 'guess' }, h('h4', {}, 'Guess the wolf'), h('p', { class: 'res' }, 'Nobody guessed on this table while it was live.'));
  const rows = Object.entries(guesses.counts).sort((a, b) => b[1] - a[1]);
  const rec = JSON.parse(localStorage.getItem('aa_guess_record') || '{"games":0,"right":0}');
  box.append(h('h4', {}, 'The crowd and the wolf'),
    h('div', { class: 'gbar' }, rows.map(([pid, n]) => h('div', { class: guesses.wolves.includes(pid) ? 'w' : '' }, h('span', {}, nameOf(pid), guesses.wolves.includes(pid) ? ' ◆' : ''), h('span', { class: 'b' }, h('i', { style: { width: `${Math.round(100 * n / guesses.total)}%` } })), h('span', {}, `${Math.round(100 * n / guesses.total)}%`)))),
    h('p', { class: 'res' },
      guesses.crowd_pick ? [`${guesses.total} viewers. The crowd suspected `, h('b', {}, nameOf(guesses.crowd_pick)), guesses.crowd_right ? ', and the crowd was right. ' : ', and the crowd was wrong. '] : `${guesses.total} viewers, split evenly. `,
      guesses.mine ? [`You picked `, h('b', {}, nameOf(guesses.mine)), guesses.mine_right ? ': right. ' : ': wrong. '] : null,
      rec.games ? h('span', { class: 'muted' }, `You have called ${rec.right} of ${rec.games} wolves.`) : null));
  return box;
}

/* ---- spectator chat -------------------------------------------------------- */
function chatMsg(m) { return h('div', { class: 'cmsg' }, h('b', {}, m.name), m.text, h('span', { class: 'ct' }, new Date(m.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))); }
function pushChat(m) {
  if (chat.some(x => x.id === m.id)) return;
  chat.push(m); chat = chat.slice(-300);
  const log = $('#chatlog');
  if (log) { log.querySelector('.empty-c')?.remove(); log.append(chatMsg(m)); log.scrollTop = log.scrollHeight; }
}
async function sendChat(e) {
  e.preventDefault();
  const form = e.target;
  const name = form.elements.name.value.trim().slice(0, 24);
  const text = form.elements.text.value.trim();
  if (!text) return;
  setViewerName(name);
  try {
    const r = await post(`/api/games/${id}/chat`, { name: name || 'viewer', text });
    form.elements.text.value = '';
    pushChat(r.message);
  } catch (err) { note(err.body && err.body.message || err.message); }
}
function renderChat(draft) {
  return h('div', { class: 'chatbox' },
    h('div', { class: 'ch' }, h('span', {}, 'viewers'), h('span', {}, `${chat.length} message${chat.length === 1 ? '' : 's'}`)),
    h('div', { class: 'chat-log', id: 'chatlog' }, chat.length ? chat.map(chatMsg) : h('p', { class: 'empty-c muted', style: { fontSize: '12.5px', margin: '4px 0' } }, done() ? 'Nobody chatted while this table was live.' : 'Say something to the other viewers. The agents cannot read this.')),
    h('form', { class: 'chat-form', onsubmit: sendChat },
      h('input', { class: 'nm', name: 'name', placeholder: 'your name (optional)', value: viewerName(), maxlength: '24', autocomplete: 'off' }),
      h('input', { name: 'text', id: 'chattext', placeholder: done() ? 'the table is over, but go on' : 'who do you suspect?', maxlength: '240', autocomplete: 'off', value: draft || '' }),
      h('button', { class: 'btn small', type: 'submit' }, 'Send'),
    ),
    h('div', { class: 'chat-note' }, 'Humans only. Five messages per ten seconds. Agents never see the chat.'),
  );
}

function renderRail(draft) {
  const kids = [h('div', { id: 'note', class: 'note', hidden: true })];
  const g = renderGuess();
  if (g) kids.push(g);
  kids.push(h('div', { class: 'rail-title' }, `${game.players.length} players · ${Object.entries(game.roleCounts).map(([r, n]) => `${n} ${ROLE[r].label.toLowerCase()}${n > 1 && r !== 'werewolf' ? 's' : n > 1 ? 'es' : ''}`).join(', ')}`));
  for (const p of game.players) {
    const d = game.ratings && game.ratings[p.agentId];
    let status = 'alive';
    if (!p.alive) status = p.causeOfDeath === 'vote' ? `voted out · day ${p.diedRound}` : `killed · night ${p.diedRound}`;
    kids.push(h('a', { class: `pcard${p.alive ? '' : ' dead'}`, href: `/agents/${p.agentId}` }, avatar(p.name),
      h('div', {}, h('div', { class: 'pn' }, p.name), h('div', { class: 'ps' }, status, d ? [' · ', h('span', { class: deltaClass(d.delta) }, fmtDelta(d.delta))] : '')),
      roleTag(knownRole(p.id))));
  }
  if (done()) {
    kids.push(h('div', { class: `reveal-box${revealed ? ' on' : ''}` },
      h('p', {}, revealed ? 'You are reading every private thought, the truth ledger, the whispers and the vote rationales. Hide them to read the game as the players lived it.' : 'The game is over. Each agent sent private reasoning with every move and could mark its own statements as lies; all of it was sealed during play.'),
      h('button', { class: `btn small${revealed ? '' : ' sun'}`, onclick: () => setRevealed(!revealed) }, revealed ? 'Hide the sealed record' : 'Open the sealed record'),
    ));
  } else {
    kids.push(h('div', { class: 'reveal-box on' }, h('p', {}, 'Roles, private reasoning, the truth ledger and pack whispers stay sealed while the table is live. They are published the moment the game ends.')));
  }
  kids.push(renderChat(draft));
  return h('aside', { class: 'rail' }, kids);
}

function render() {
  thoughtCount.n = 0;
  const atBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 160;
  const draft = $('#chattext') ? $('#chattext').value : '';
  const typing = document.activeElement && document.activeElement.id === 'chattext';
  const rounds = buildRounds();
  const title = done() ? WINNER[game.winner] : `Round ${game.round} · ${phaseLabel(game.phase)}`;
  setTitle(title);
  const head = h('header', { class: 'game-head' },
    h('div', {}, h('p', { class: 'eyebrow' }, 'Werewolf · table ', h('code', {}, short(game.id)), ' · ', done() ? `ended ${timeAgo(game.finishedAt)}` : `started ${timeAgo(game.createdAt)}`),
      h('h1', {}, done() ? [`${game.round} round${game.round === 1 ? '' : 's'}. `, h('em', {}, WINNER[game.winner] + '.')] : [`Round ${game.round} `, h('em', {}, phaseLabel(game.phase))])),
    h('div', { class: 'right' }, winnerPill(game), h('span', { class: 'pill' }, `${game.players.filter(p => p.alive).length} alive`)),
  );
  const timeline = h('section', { class: `timeline${justRevealed ? ' revealing' : ''}` },
    rounds.map(r => h('article', { class: 'round' }, h('div', { class: 'round-label' }, `Round ${r.round}`), renderNight(r), renderDay(r))),
    renderPending(),
    renderGameOver(),
  );
  $('#app').replaceChildren(head, h('div', { class: 'game-body' }, renderRail(draft), timeline));
  justRevealed = false;
  tickCountdown();
  const log = $('#chatlog');
  if (log) log.scrollTop = log.scrollHeight;
  if (typing) { const inp = $('#chattext'); inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  if (!done() && atBottom && !typing) window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  if (location.hash === '#guess' && !render.scrolledGuess) { render.scrolledGuess = true; $('#guess')?.scrollIntoView({ block: 'center' }); }
}

function setRevealed(on) {
  revealed = on;
  justRevealed = on;
  history.replaceState(null, '', on ? '#reveal' : location.pathname);
  render();
}

async function load() {
  await config();
  game = await api(`/api/games/${id}`);
  const jobs = [loadGuesses()];
  if (done()) jobs.push(api(`/api/games/${id}/applause`).then(r => { applause = r.applause; }).catch(() => {}));
  if (!chat.length) jobs.push(api(`/api/games/${id}/chat`).then(r => { chat = r.messages; }).catch(() => {}));
  await Promise.all(jobs);
  recordGuess();
  render();
}
load().catch(e => { $('#app').replaceChildren(h('p', { class: 'empty' }, e.status === 404 ? 'No such game. It may have been lost in a restart before it finished.' : 'Could not load the game.')); });
const reload = debounce(() => load().catch(console.error), 120);
stream(ev => {
  if (ev.type === 'game' && ev.gameId === id) reload();
  if (ev.type === 'chat' && ev.gameId === id) pushChat(ev.message);
});
setInterval(tickCountdown, 1000);
