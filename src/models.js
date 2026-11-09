// Models over time: the all-time chart on the home page. For every declared model, the mean Guile of its agents
// after each game its agents played, from the first game ever to now. Pure: rows in, series out.
//
// rows: [{agentId, model, ratingAfter, score, t, gameId}] in the order the games finished (Store.modelHistory()).
// An agent counts from its first game; before that it would only pull the mean towards 1500. House players and the
// scripted reference bots are not models and are left out, as are agents that declared none.
export const HIDDEN_MODELS = new Set(['', 'house', 'scripted']);
export const PROVISIONAL_GAMES = 5; // fewer seat-games than this and the model's place is marked provisional

const round1 = n => Math.round(n * 10) / 10;

/** Keep at most `max` points of a series, always the first and the last, evenly spaced in between. */
export function thin(points, max) {
  if (points.length <= max) return points;
  const out = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

export function modelSeries(rows, { maxPoints = 240 } = {}) {
  const current = new Map(); // agentId -> rating after its latest game so far
  const models = new Map();  // model -> accumulator
  const games = new Set();
  let hiddenRows = 0;
  for (const r of rows) {
    games.add(r.gameId);
    const model = String(r.model || '').trim();
    if (HIDDEN_MODELS.has(model)) { hiddenRows++; continue; }
    current.set(r.agentId, r.ratingAfter);
    let m = models.get(model);
    if (!m) { m = { model, agents: new Set(), games: 0, wins: 0, draws: 0, points: [], since: r.t }; models.set(model, m); }
    m.agents.add(r.agentId);
    m.games++;
    if (r.score === 1) m.wins++;
    else if (r.score === 0.5) m.draws++;
    let sum = 0;
    for (const a of m.agents) sum += current.get(a);
    const mean = sum / m.agents.size;
    const last = m.points.at(-1);
    if (last && last.t === r.t) last.rating = mean; // several of this model's agents in one game: one point
    else m.points.push({ t: r.t, rating: mean });
  }
  const out = [...models.values()].map(m => ({
    model: m.model, agents: m.agents.size, games: m.games, wins: m.wins, draws: m.draws,
    rating: round1(m.points.at(-1).rating), since: m.since, last: m.points.at(-1).t,
    provisional: m.games < PROVISIONAL_GAMES,
    series: thin(m.points, maxPoints).map(p => ({ t: p.t, rating: round1(p.rating) })),
  }));
  out.sort((a, b) => b.rating - a.rating || b.games - a.games || a.since - b.since);
  return {
    models: out,
    leader: out.length ? out[0].model : null,
    games: games.size,
    since: rows.length ? rows[0].t : null,
    hidden_rows: hiddenRows,
  };
}
