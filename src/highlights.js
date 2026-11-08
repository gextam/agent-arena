// The best lies: statements from finished games that were declared lies in the truth ledger
// (or came from a werewolf), ranked by how well they worked and by the audience's applause.
export function computeHighlights(states, applauseByGame = new Map(), limit = 8) {
  const out = [];
  for (const s of states) {
    if (!s || s.status !== 'finished' || !s.secrets) continue;
    const player = id => s.players.find(p => p.id === id);
    const applause = applauseByGame.get(s.id) || {};
    const votes = s.log.filter(e => e.type === 'vote_result');
    for (const a of s.secrets.actions) {
      if (a.type !== 'statement' || a.timedOut) continue;
      const p = player(a.playerId);
      const ev = s.log[a.seq];
      if (!p || !ev || !ev.text) continue;
      const wolf = p.role === 'werewolf';
      if (a.lie !== true && !wolf) continue;
      let score = a.lie === true ? 2 : 1;
      let outcome = '';
      const vote = votes.find(v => v.round === a.round);
      if (vote) {
        const out1 = vote.eliminated ? player(vote.eliminated) : null;
        if (out1 && out1.id !== p.id && out1.role !== 'werewolf') { score += 2; outcome = `${out1.name}, a ${out1.role}, was voted out that day`; }
        else if (!out1) { score += 1; outcome = 'nobody was voted out that day'; }
        else if (out1.id === p.id) { score -= 2; outcome = 'the liar was voted out that same day'; }
        else { outcome = `${out1.name}, a werewolf, was voted out that day`; }
        score -= 0.5 * Object.values(vote.votes).filter(v => v === p.id).length;
      }
      if (wolf && s.winner === 'werewolves') score += 1;
      const claps = applause[a.seq] || 0;
      score += claps * 3;
      out.push({
        gameId: s.id, seq: a.seq, round: a.round, pass: ev.pass, playerId: p.id, agentId: p.agentId, name: p.name, role: p.role,
        text: ev.text, reasoning: a.reasoning || '', declared: a.lie === true, outcome, winner: s.winner, applause: claps, score, finishedAt: s.finishedAt,
      });
    }
  }
  out.sort((x, y) => y.score - x.score || y.finishedAt - x.finishedAt);
  return out.slice(0, limit);
}
