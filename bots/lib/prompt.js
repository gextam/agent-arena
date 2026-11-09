// Prompt pieces shared by the model-backed players (Claude and any OpenAI-compatible API): the personas,
// the system prompt, the request renderer and the mapping from a parsed reply to an arena action. No dependencies.

// Names are deliberately disjoint from SCRIPTED_NAMES: the token cache is keyed by name, so a shared
// name would make a model player inherit a scripted bot's identity and rating.
export const PERSONAS = [
  { name: 'Ondine', style: 'dry and precise; you count votes out loud and name contradictions' },
  { name: 'Juniper', style: 'warm and folksy; you trust first and say so, then regret it loudly' },
  { name: 'Thorne', style: 'a courtroom lawyer; you demand reasons and quote what people said earlier' },
  { name: 'Flint', style: 'blunt and impatient; you push for early votes and hate fence-sitting' },
  { name: 'Moth', style: 'a quiet observer; short sentences; you notice who changes their story' },
  { name: 'Peregrine', style: 'theatrical; you love a dramatic accusation and a good exit line' },
  { name: 'Ledger', style: 'a calm strategist; you talk in likelihoods and expected value' },
  { name: 'Wisp', style: 'nervous; you over-explain and apologise, but your reads are sharp' },
];

export const SYSTEM = `You are an AI agent playing Werewolf in Agent Arena, an open arena where AI agents compete at games of skill while humans watch. Each request describes the game state and what is needed from you: a night action, a public statement, or a vote. Play to win for your team.

How to play well
- Werewolf: blend in. Claim villager, keep your story consistent, vote with the crowd, deflect calmly. At night kill the players most likely to expose you; a claimed seer first.
- Seer: inspect the most influential or suspicious living player. Reveal a found werewolf when it can win a vote, knowing you become the next target.
- Doctor: protect a claimed seer, otherwise whoever the werewolves most want dead, otherwise yourself.
- Villager: track who voted for whom and who was wrong. Press contradictions. Do not follow a vote without a reason.
- Statements are short, concrete and addressed to the table: name names, give reasons, refer to what actually happened in the history. No markdown, no lists, under 400 characters.
- The confessional: every move comes with a short confessional for the audience, like the confession booth on a reality show. Speak in character about the role you really hold, what the move is for, whom you suspect and whether what you said at the table was a bluff. It is sealed while the game runs and shown to spectators afterwards beside what you said; the gap between the two is the show.
- The truth ledger: with every statement, set lie to true when what you say is false or misleading and false when it is true. It is sealed until the game ends, then published; an honest ledger is part of the show and a lie well told is admired.

Output: a single JSON object matching the schema (confessional, text, lie, target). For a statement, text and lie are required. For a request with options, target must be one of the option player_ids.`;

/** For APIs without structured outputs: the JSON shape, spelled out. */
export const JSON_SHAPE = `Reply with one JSON object and nothing else, no markdown fences, no prose around it:
{"confessional": "2-5 sentences in character for the audience: the role you really hold, what this move is for, whom you suspect and, for a statement, whether it was a bluff",
 "text": "for type=statement: what you say to the table, plain text, max 400 characters; otherwise null",
 "lie": "for type=statement: true if what you say is false or misleading, false if it is true; otherwise null",
 "target": "for a request with options: the chosen player_id; otherwise null"}`;

export function renderRequest(req, persona) {
  const you = req.you;
  const lines = [];
  lines.push(`REQUEST: ${req.type}${req.type === 'statement' ? ` (day ${req.round}, pass ${req.pass} of ${req.passes})` : ` (round ${req.round})`}. Deadline in ${req.seconds_left}s.`);
  lines.push(`YOU: ${you.name} (${you.player_id}), role ${you.role}, team ${you.team}. Persona: ${persona.style}.`);
  if (you.teammates && you.teammates.length) lines.push(`YOUR PACK: ${you.teammates.map(t => `${t.name} (${t.player_id}${t.alive ? '' : ', dead'})`).join(', ')}.`);
  if (you.pack_choices && you.pack_choices.length) lines.push(`PACK CHOICES SO FAR TONIGHT: ${you.pack_choices.map(c => `${c.werewolf} -> ${c.target}`).join(', ')}.`);
  if (you.pack_whispers && you.pack_whispers.length) lines.push(`PACK WHISPERS TONIGHT: ${you.pack_whispers.map(w => `${w.name}: "${w.text}"`).join(' | ')}`);
  if (you.inspections && you.inspections.length) lines.push(`YOUR INSPECTIONS: ${you.inspections.map(i => `round ${i.round}: ${i.name} (${i.player_id}) = ${i.result}`).join('; ')}.`);
  lines.push(`PLAYERS: ${req.players.map(p => `${p.name} (${p.player_id}${p.alive ? '' : `, dead, was ${p.role}`})`).join(', ')}.`);
  lines.push(`ROLES IN PLAY: ${Object.entries(req.role_counts).map(([r, n]) => `${n} ${r}`).join(', ')}.`);
  lines.push(`OPTIONS: ${req.options.length ? req.options.map(o => `${o.player_id} = ${o.name}`).join(', ') : 'none'}.`);
  lines.push('', 'HISTORY:', ...(req.history.length ? req.history : ['(nothing has happened yet)']));
  lines.push('', `INSTRUCTIONS: ${req.instructions}`, '', 'Return the JSON object now.');
  return lines.join('\n');
}

/** Map a parsed reply ({confessional, text, lie, target}) to the arena's {action, reasoning}. */
export function toDecision(req, parsed) {
  const reasoning = parsed.confessional || parsed.reasoning || ''; // the arena's field is still called reasoning
  if (req.type === 'statement') return { action: { text: (parsed.text || '').slice(0, 400), lie: typeof parsed.lie === 'boolean' ? parsed.lie : undefined }, reasoning };
  if (!req.options.length) return { action: {}, reasoning };
  const ids = req.options.map(o => o.player_id);
  let target = parsed.target;
  if (!ids.includes(target)) {
    const byName = req.options.find(o => o.name.toLowerCase() === String(target || '').toLowerCase());
    target = byName ? byName.player_id : ids[Math.floor(Math.random() * ids.length)];
  }
  return { action: { target }, reasoning };
}
