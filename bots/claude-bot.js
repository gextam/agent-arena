// A Werewolf player powered by Claude through the official Anthropic SDK.
// Needs credentials (ANTHROPIC_API_KEY, or an `ant auth login` profile).
//   MODEL   claude-opus-5-5 (default)   claude-haiku-5-5 is roughly 50x cheaper and still plays
//   EFFORT  low | medium (default) | high
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ArenaClient, runBot } from './lib/client.js';

export const DEFAULT_MODEL = process.env.MODEL || 'claude-opus-5-5';
export const DEFAULT_EFFORT = process.env.EFFORT || 'medium';

// Names are deliberately disjoint from SCRIPTED_NAMES: the token cache is keyed by name, so a shared
// name would make a Claude player inherit a scripted bot's identity and rating.
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

const Decision = z.object({
  reasoning: z.string().describe('Your private thinking: real role, real plan, real suspicions, and whether your statement is a lie. 2-5 sentences. Published to spectators after the game.'),
  text: z.string().nullable().describe('For type=statement: what you say to the table (max 400 chars, plain text). Otherwise null.'),
  lie: z.boolean().nullable().describe('For type=statement: true if what you say is false or misleading, false if it is true. Sealed until the game ends, then published as your truth ledger. Otherwise null.'),
  target: z.string().nullable().describe('For requests with options: the chosen player_id. Otherwise null.'),
});

const SYSTEM = `You are an AI agent playing Werewolf in Agent Arena, an open arena where AI agents compete at games of skill while humans watch. Each request describes the game state and what is needed from you: a night action, a public statement, or a vote. Play to win for your team.

How to play well
- Werewolf: blend in. Claim villager, keep your story consistent, vote with the crowd, deflect calmly. At night kill the players most likely to expose you; a claimed seer first.
- Seer: inspect the most influential or suspicious living player. Reveal a found werewolf when it can win a vote, knowing you become the next target.
- Doctor: protect a claimed seer, otherwise whoever the werewolves most want dead, otherwise yourself.
- Villager: track who voted for whom and who was wrong. Press contradictions. Do not follow a vote without a reason.
- Statements are short, concrete and addressed to the table: name names, give reasons, refer to what actually happened in the history. No markdown, no lists, under 400 characters.
- Your reasoning is private while the game runs and is published to the audience afterwards, next to what you said. Write what you actually think: your real role, your plan, your suspicions, and say so when your statement is a lie. Spectators compare the two.
- The truth ledger: with every statement, set lie to true when what you say is false or misleading and false when it is true. It is sealed until the game ends, then published; an honest ledger is part of the show and a lie well told is admired.

Output: a single JSON object matching the schema (reasoning, text, lie, target). For a statement, text and lie are required. For a request with options, target must be one of the option player_ids.`;

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

export function toDecision(req, parsed) {
  const reasoning = parsed.reasoning || '';
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

/** decide(request) backed by Claude. */
export function makeClaudePlayer({ model = DEFAULT_MODEL, effort = DEFAULT_EFFORT, persona = PERSONAS[0], log = console.log } = {}) {
  const client = new Anthropic({ timeout: 40_000, maxRetries: 1 });
  // The name comes from the request: the arena may have renamed a taken name (Moth-2), and the
  // system block is cached per name.
  const systems = new Map();
  const systemFor = name => {
    if (!systems.has(name)) systems.set(name, [{ type: 'text', text: `${SYSTEM}\n\nYour name at this table is ${name}. Persona: ${persona.style}.`, cache_control: { type: 'ephemeral' } }]);
    return systems.get(name);
  };
  // Opus-tier models can decline a request; the server-side fallback re-runs it on another model.
  // Haiku has no fallback and rejects the parameter.
  let useFallbacks = !/haiku/i.test(model);

  return async function decide(req) {
    const params = {
      model, max_tokens: 2048, system: systemFor((req.you && req.you.name) || persona.name),
      messages: [{ role: 'user', content: renderRequest(req, persona) }],
      output_config: { effort, format: zodOutputFormat(Decision) },
    };
    let msg;
    if (useFallbacks) {
      try {
        msg = await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
      } catch (e) {
        if (!(e instanceof Anthropic.BadRequestError)) throw e;
        log(`[${persona.name}] fallbacks not accepted here (${e.message}); continuing without them`);
        useFallbacks = false;
      }
    }
    if (!msg) msg = await client.messages.create(params);
    if (msg.stop_reason === 'refusal') throw new Error(`model declined (${msg.stop_details && msg.stop_details.category})`);
    if (msg.stop_reason === 'max_tokens') throw new Error('response cut off at max_tokens');
    const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const parsed = Decision.parse(JSON.parse(text));
    return toDecision(req, parsed);
  };
}

export function startClaudeBot({ persona, model = DEFAULT_MODEL, effort = DEFAULT_EFFORT, baseUrl, persist, name, ...loopOptions }) {
  const client = new ArenaClient({ name: name || persona.name, baseUrl, persist, model, description: `${model} · ${persona.style}` });
  return runBot(client, makeClaudePlayer({ model, effort, persona, log: loopOptions.log }), loopOptions);
}
