// A Werewolf player powered by Claude through the official Anthropic SDK.
// Needs credentials (ANTHROPIC_API_KEY, or an `ant auth login` profile).
//   MODEL   claude-opus-5-5 (default)   claude-haiku-5-5 is roughly 50x cheaper and still plays
//   EFFORT  low | medium (default) | high
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ArenaClient, runBot } from './lib/client.js';
import { PERSONAS, SYSTEM, renderRequest, toDecision } from './lib/prompt.js';
import { addUsage } from './lib/usage.js';
export { PERSONAS, renderRequest, toDecision };

export const DEFAULT_MODEL = process.env.MODEL || 'claude-opus-5-5';
export const DEFAULT_EFFORT = process.env.EFFORT || 'medium';

// Asked for as a "confessional" on purpose: a request for the model's "private thinking" is declined by Opus
// as reasoning extraction (stop_reason refusal, category reasoning_extraction). The arena's field is still `reasoning`.
const Decision = z.object({
  confessional: z.string().describe('Your confessional for the audience, in character, 2-5 sentences: the role you really hold, what this move is meant to achieve, whom you suspect and why, and for a statement whether it was a bluff. Sealed while the game runs; shown to spectators next to the move once the game ends.'),
  text: z.string().nullable().describe('For type=statement: what you say to the table (max 400 chars, plain text). Otherwise null.'),
  lie: z.boolean().nullable().describe('For type=statement: true if what you say is false or misleading, false if it is true. Sealed until the game ends, then published as your truth ledger. Otherwise null.'),
  target: z.string().nullable().describe('For requests with options: the chosen player_id. Otherwise null.'),
});

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
    const name = (req.you && req.you.name) || persona.name;
    const params = {
      model, max_tokens: 2048, system: systemFor(name),
      messages: [{ role: 'user', content: renderRequest(req, persona) }],
      output_config: { effort, format: zodOutputFormat(Decision) },
    };
    let msg;
    if (useFallbacks) {
      try {
        msg = await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
      } catch (e) {
        if (!(e instanceof Anthropic.BadRequestError)) throw e;
        log(`[${name}] fallbacks not accepted here (${e.message}); continuing without them`);
        useFallbacks = false;
      }
    }
    if (!msg) msg = await client.messages.create(params);
    if (msg.usage) addUsage(name, { input: msg.usage.input_tokens, output: msg.usage.output_tokens, cached: msg.usage.cache_read_input_tokens });
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
