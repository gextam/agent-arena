// The model catalog for visitor tables (src/tables.js, /tables/new): a hand-picked list of current models from
// the major vendors, with the ids they are served under and a price snapshot used for cost estimates.
//
// Why by hand: "the twenty latest models" is an editorial choice that changes monthly, and OpenRouter's full list
// runs to hundreds of entries. Ids, release dates and prices come from GET https://openrouter.ai/api/v1/models
// (public, no key) and the vendors' own pages; refresh them with the snapshot date below when you add a model.
//
// Routes: Anthropic models are called directly (ANTHROPIC_API_KEY) and fall back to OpenRouter; every other vendor
// goes through OpenRouter (OPENROUTER_API_KEY), one key for all of them. A visitor can bring their own key for
// either route. `model` is what the arena records on the agent (the same ids bots/run.js uses), `openrouter` the
// id on OpenRouter. Prices are USD per million tokens (in/out). `reasoning`: the API returns a readable summary of
// the model's thinking, shown live at the table.
export const PRICES_AS_OF = '2026-11-09';

// A model is "on the house" when both prices are at or under these, so a whole table costs a few cents.
export const HOUSE_MAX_IN = Number(process.env.TABLES_HOUSE_MAX_IN) || 1.25;
export const HOUSE_MAX_OUT = Number(process.env.TABLES_HOUSE_MAX_OUT) || 2.5;

export const VENDORS = {
  anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', xai: 'xAI', deepseek: 'DeepSeek', zai: 'Z.ai',
  qwen: 'Alibaba Qwen', moonshot: 'Moonshot', minimax: 'MiniMax', mistral: 'Mistral', meta: 'Meta', tencent: 'Tencent',
  nvidia: 'NVIDIA', cohere: 'Cohere', amazon: 'Amazon', arena: 'Agent Arena',
};

const m = (id, vendor, name, model, openrouter, released, priceIn, priceOut, flags = 'rj') => ({
  id, vendor, name, model, openrouter, released, price: { in: priceIn, out: priceOut },
  provider: vendor === 'anthropic' ? 'anthropic' : 'openrouter',
  reasoning: flags.includes('r'), json: flags.includes('j'),
});

export const CATALOG = [
  // Anthropic (direct API; OpenRouter as the fallback route)
  m('claude-haiku-5-5', 'anthropic', 'Claude Haiku 5.5', 'claude-haiku-5-5', 'anthropic/claude-haiku-5.5', '2026-10-07', 0.10, 0.50),
  m('claude-sonnet-5-5', 'anthropic', 'Claude Sonnet 5.5', 'claude-sonnet-5-5', 'anthropic/claude-sonnet-5.5', '2026-09-28', 2, 10),
  m('claude-opus-5-5', 'anthropic', 'Claude Opus 5.5', 'claude-opus-5-5', 'anthropic/claude-opus-5.5', '2026-09-22', 4, 20),
  m('claude-fable-5-1', 'anthropic', 'Claude Fable 5.1', 'claude-fable-5-1', 'anthropic/claude-fable-5.1', '2026-09-01', 10, 50),
  m('claude-opus-4-8', 'anthropic', 'Claude Opus 4.8', 'claude-opus-4-8', 'anthropic/claude-opus-4.8', '2026-05-27', 5, 25),
  // OpenAI
  m('gpt-6-1-terra', 'openai', 'GPT-6.1 Terra', 'openai/gpt-6.1-terra', 'openai/gpt-6.1-terra', '2026-10-26', 1, 5),
  m('gpt-6-1-sol', 'openai', 'GPT-6.1 Sol', 'openai/gpt-6.1-sol', 'openai/gpt-6.1-sol', '2026-09-29', 2, 10),
  m('gpt-6-luna', 'openai', 'GPT-6 Luna', 'openai/gpt-6-luna', 'openai/gpt-6-luna', '2026-09-22', 0.10, 0.50),
  m('gpt-6-astra', 'openai', 'GPT-6 Astra', 'openai/gpt-6-astra', 'openai/gpt-6-astra', '2026-09-04', 10, 50),
  // Google
  m('gemini-4-argon', 'google', 'Gemini 4 Argon', 'google/gemini-4-argon', 'google/gemini-4-argon', '2026-10-13', 2, 10),
  m('gemini-3-8-flash', 'google', 'Gemini 3.8 Flash', 'google/gemini-3.8-flash', 'google/gemini-3.8-flash', '2026-09-02', 0.83, 4.13),
  m('gemini-3-5-flash-lite', 'google', 'Gemini 3.5 Flash Lite', 'google/gemini-3.5-flash-lite', 'google/gemini-3.5-flash-lite', '2026-07-21', 0.30, 2.50),
  // xAI
  m('grok-4-7', 'xai', 'Grok 4.7', 'x-ai/grok-4.7', 'x-ai/grok-4.7', '2026-09-21', 2, 6),
  m('grok-4-3', 'xai', 'Grok 4.3', 'x-ai/grok-4.3', 'x-ai/grok-4.3', '2026-04-30', 1.25, 2.50),
  // DeepSeek
  m('deepseek-v4-pro', 'deepseek', 'DeepSeek V4 Pro', 'deepseek/deepseek-v4-pro-0813', 'deepseek/deepseek-v4-pro-0813', '2026-08-12', 0.11, 4.44),
  m('deepseek-v4-1-flash', 'deepseek', 'DeepSeek V4.1 Flash', 'deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash', '2026-09-10', 0.05, 0.57),
  // Z.ai
  m('glm-5-3-prime', 'zai', 'GLM-5.3 Prime', 'z-ai/glm-5.3-prime', 'z-ai/glm-5.3-prime', '2026-09-23', 2.80, 8.80),
  m('glm-5-3', 'zai', 'GLM-5.3', 'z-ai/glm-5.3', 'z-ai/glm-5.3', '2026-08-18', 0.07, 1.40),
  // Alibaba Qwen
  m('qwen3-8-max-prime', 'qwen', 'Qwen3.8 Max Prime', 'qwen/qwen3.8-max-prime', 'qwen/qwen3.8-max-prime', '2026-09-23', 4, 12),
  m('qwen3-8-flash', 'qwen', 'Qwen3.8 Flash', 'qwen/qwen3.8-flash', 'qwen/qwen3.8-flash', '2026-08-26', 0.15, 0.47),
  // Moonshot, MiniMax, Mistral, Meta, Tencent, NVIDIA, Cohere, Amazon
  m('kimi-k3-1-pro', 'moonshot', 'Kimi K3.1 Pro', 'moonshotai/kimi-k3.1-pro', 'moonshotai/kimi-k3.1-pro', '2026-10-23', 2, 10),
  m('minimax-m3-1-flash', 'minimax', 'MiniMax M3.1 Flash', 'minimax/minimax-m3.1-flash', 'minimax/minimax-m3.1-flash', '2026-10-19', 0.15, 0.60),
  m('mistral-large-4', 'mistral', 'Mistral Large 4', 'mistralai/mistral-large-4-0', 'mistralai/mistral-large-4-0', '2026-10-06', 0.70, 2.10),
  m('llama-4-maverick', 'meta', 'Llama 4 Maverick', 'meta-llama/llama-4-maverick', 'meta-llama/llama-4-maverick', '2025-04-05', 0.35, 1, 'j'),
  m('tencent-hy4', 'tencent', 'Tencent Hy4', 'tencent/hy4', 'tencent/hy4', '2026-11-04', 0.42, 1.25),
  m('nemotron-3-5-super', 'nvidia', 'Nemotron 3.5 Super', 'nvidia/nemotron-3.5-super-vl', 'nvidia/nemotron-3.5-super-vl', '2026-10-15', 0.15, 0.50),
  m('command-a-plus', 'cohere', 'Command A Plus', 'cohere/command-a-plus', 'cohere/command-a-plus', '2026-09-22', 0.30, 1.50),
  m('nova-2-lite', 'amazon', 'Nova 2 Lite', 'amazon/nova-2-lite-v1', 'amazon/nova-2-lite-v1', '2025-12-02', 0.30, 2.50, 'r'),
];

/** True when a model is cheap enough for the house to pay for it. */
export const isCheap = entry => entry.price.in <= HOUSE_MAX_IN && entry.price.out <= HOUSE_MAX_OUT;

export const byId = id => CATALOG.find(e => e.id === id) || null;

/** The `limit` most recently released models. */
export const latest = (limit = 20, catalog = CATALOG) => catalog.slice().sort((a, b) => b.released.localeCompare(a.released)).slice(0, limit);

// Rough token use of one seat over one game (the history grows with every request): for the cost estimate shown
// before a table starts. Real usage is read from the providers' responses while the table plays.
export const EST_TOKENS_PER_SEAT = { in: 45_000, out: 5_000 };
export const estimateSeatCost = entry => (EST_TOKENS_PER_SEAT.in * entry.price.in + EST_TOKENS_PER_SEAT.out * entry.price.out) / 1e6;

/** Validate a catalog (the built-in one, or one injected for tests). Throws on the first problem. */
export function checkCatalog(catalog = CATALOG) {
  const ids = new Set(), names = new Set();
  for (const e of catalog) {
    if (!e.id || !e.vendor || !e.name || !e.model || !e.released || !e.price) throw new Error(`catalog entry incomplete: ${JSON.stringify(e)}`);
    if (ids.has(e.id)) throw new Error(`duplicate catalog id ${e.id}`);
    if (names.has(e.name.toLowerCase())) throw new Error(`duplicate catalog name ${e.name}`);
    ids.add(e.id); names.add(e.name.toLowerCase());
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _.-]{1,23}$/u.test(e.name)) throw new Error(`catalog name "${e.name}" is not a valid arena name (2-24 chars: letters, digits, spaces, _ . -)`);
    if (!['anthropic', 'openrouter', 'scripted'].includes(e.provider)) throw new Error(`catalog entry ${e.id}: unknown provider ${e.provider}`);
    if (!(e.price.in >= 0 && e.price.out >= 0)) throw new Error(`catalog entry ${e.id}: bad price`);
  }
  return true;
}
checkCatalog();
