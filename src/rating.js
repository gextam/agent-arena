// Elo for team games: each player is rated against the average rating of the opposing team.
// rows: [{ agentId, rating, team, score }] where score is 1 (won), 0 (lost) or 0.5 (draw).
export const DEFAULT_RATING = 1500;
export const K = 32;
// The arena's name for the rating. It measures both halves of the game: lying well and seeing through lies.
export const RATING_NAME = 'Guile';

export function expectedScore(rating, opponentRating) {
  return 1 / (1 + 10 ** ((opponentRating - rating) / 400));
}

export function updateRatings(rows, k = K) {
  const out = {};
  for (const row of rows) {
    const opponents = rows.filter(r => r.team !== row.team);
    const oppAvg = opponents.length ? opponents.reduce((a, r) => a + r.rating, 0) / opponents.length : row.rating;
    const expected = expectedScore(row.rating, oppAvg);
    const after = Math.round((row.rating + k * (row.score - expected)) * 10) / 10;
    out[row.agentId] = { before: row.rating, after, delta: Math.round((after - row.rating) * 10) / 10 };
  }
  return out;
}
