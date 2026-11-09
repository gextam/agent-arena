// A Werewolf player for any OpenAI-compatible chat-completions API: OpenAI, OpenRouter, DeepSeek, z.ai (GLM),
// xAI, Groq, Ollama and the like. No SDK, plain fetch. The model gets the same system prompt and request
// rendering as the Claude player and is asked for one JSON object (confessional, text, lie, target); the
// endpoint's JSON mode is used where it is accepted and dropped where it is not.
//
//   provider   a preset below, or any NAME with NAME_BASE_URL (and NAME_API_KEY) in the environment
//   model      the provider's model id; the preset's default otherwise
//   extra      request fields merged into the body (e.g. {"reasoning_effort": "low"}); unsupported ones are dropped on a 400
import { ArenaClient, runBot } from './lib/client.js';
import { PERSONAS, SYSTEM, JSON_SHAPE, renderRequest, toDecision } from './lib/prompt.js';
import { addUsage } from './lib/usage.js';

export const PROVIDERS = {
  openai:     { baseUrl: 'https://api.openai.com/v1', keyVar: 'OPENAI_API_KEY', model: 'gpt-5.5', extra: { reasoning_effort: 'low' } },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', keyVar: 'OPENROUTER_API_KEY', model: 'openai/gpt-5.5',
    headers: { 'HTTP-Referer': 'https://cocojs.com', 'X-Title': 'Agent Arena' } },
  deepseek:   { baseUrl: 'https://api.deepseek.com/v1', keyVar: 'DEEPSEEK_API_KEY', model: 'deepseek-chat' },
  zai:        { baseUrl: 'https://api.z.ai/api/paas/v4', keyVar: 'ZAI_API_KEY', model: 'glm-4.6', extra: { thinking: { type: 'disabled' } } },
  xai:        { baseUrl: 'https://api.x.ai/v1', keyVar: 'XAI_API_KEY', model: 'grok-4-fast' },
  groq:       { baseUrl: 'https://api.groq.com/openai/v1', keyVar: 'GROQ_API_KEY', model: 'llama-3.3-70b-versatile' },
  ollama:     { baseUrl: 'http://localhost:11434/v1', keyVar: 'OLLAMA_API_KEY', model: 'llama3.1', noKey: true },
};

/** Resolve a provider name plus overrides to {baseUrl, apiKey, model, headers, extra}. */
export function resolveProvider(provider, { apiBaseUrl, apiKey, model, extra } = {}) {
  const preset = PROVIDERS[provider] || {};
  const envName = provider.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const keyVar = preset.keyVar || `${envName}_API_KEY`;
  const baseUrl = String(apiBaseUrl || process.env[`${envName}_BASE_URL`] || preset.baseUrl || '').replace(/\/+$/, '');
  const key = apiKey || process.env[keyVar] || process.env[`${envName}_API_KEY`] || '';
  if (!baseUrl) throw new Error(`provider ${provider}: no base URL (set ${envName}_BASE_URL in .env, or use a preset: ${Object.keys(PROVIDERS).join(', ')})`);
  if (!key && !preset.noKey) throw new Error(`provider ${provider}: no API key (set ${keyVar} in .env)`);
  return { baseUrl, apiKey: key, model: model || process.env[`${envName}_MODEL`] || preset.model, headers: preset.headers || {}, extra: { ...(preset.extra || {}), ...(extra || {}) } };
}

/** Pull the decision object out of a model reply that may be fenced or wrapped in prose. */
export function parseDecision(text) {
  let s = Array.isArray(text) ? text.map(p => (p && p.text) || '').join('') : String(text ?? '');
  s = s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error(`no JSON object in the reply: ${s.slice(0, 80)}`);
  const o = JSON.parse(s.slice(a, b + 1));
  const str = v => (v === null || v === undefined ? null : String(v));
  const lie = typeof o.lie === 'boolean' ? o.lie : o.lie === 'true' ? true : o.lie === 'false' ? false : null;
  return { confessional: str(o.confessional ?? o.reasoning) || '', text: str(o.text), lie, target: str(o.target) };
}

// Which request field a 400 complains about, if we can tell; that field is dropped and the request retried once.
function unsupportedParam(status, text) {
  if (status !== 400) return null;
  const m = text.match(/[Uu]nsupported parameter:? '?([A-Za-z_][A-Za-z0-9_.]*)/) || text.match(/[Uu]nrecognized request argument(?:s)? supplied:? ([A-Za-z_][A-Za-z0-9_]*)/)
    || text.match(/'?([A-Za-z_][A-Za-z0-9_]*)'? is not supported/) || text.match(/[Ii]nvalid parameter:? '?([A-Za-z_][A-Za-z0-9_]*)/);
  if (m) return m[1].split('.')[0];
  for (const k of ['response_format', 'reasoning_effort', 'thinking', 'reasoning']) if (text.includes(k)) return k;
  return null;
}

export function makeOpenAIPlayer({ provider = 'openai', model, apiBaseUrl, apiKey, extra, persona = PERSONAS[0], timeoutMs = 40_000, log = console.log } = {}) {
  const p = resolveProvider(provider, { apiBaseUrl, apiKey, model, extra });
  const label = `${provider}/${p.model}`;
  const dropped = new Set(); // request fields this endpoint rejected
  let jsonMode = true;

  return async function decide(req, attempt = 0) {
    const name = (req.you && req.you.name) || persona.name;
    const body = {
      model: p.model,
      messages: [
        { role: 'system', content: `${SYSTEM}\n\n${JSON_SHAPE}\n\nYour name at this table is ${name}. Persona: ${persona.style}.` },
        { role: 'user', content: renderRequest(req, persona) },
      ],
      ...p.extra,
    };
    if (jsonMode) body.response_format = { type: 'json_object' };
    for (const k of dropped) delete body[k];

    const ctrl = new AbortController();
    const budget = Math.max(5_000, Math.min(timeoutMs, ((req.seconds_left || 45) - 3) * 1000));
    const timer = setTimeout(() => ctrl.abort(), budget);
    let res;
    try {
      res = await fetch(`${p.baseUrl}/chat/completions`, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'content-type': 'application/json', ...(p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}), ...p.headers },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`${label}: ${e.name === 'AbortError' ? `no reply within ${Math.round(budget / 1000)}s` : e.message}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const bad = unsupportedParam(res.status, text);
      if (bad && attempt < 3 && (bad === 'response_format' ? jsonMode : bad in body)) {
        if (bad === 'response_format') jsonMode = false; else dropped.add(bad);
        log(`[${name}] ${label} rejects ${bad}; continuing without it`);
        return decide(req, attempt + 1);
      }
      throw new Error(`${label}: HTTP ${res.status} ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    const data = await res.json();
    const choice = data.choices && data.choices[0];
    const message = choice && choice.message;
    if (data.usage) addUsage(name, { input: data.usage.prompt_tokens, output: data.usage.completion_tokens, cached: data.usage.prompt_tokens_details && data.usage.prompt_tokens_details.cached_tokens });
    if (message && message.refusal) throw new Error(`${label}: model declined (${String(message.refusal).slice(0, 120)})`);
    if (!message || !message.content) throw new Error(`${label}: empty reply${choice && choice.finish_reason ? ` (${choice.finish_reason})` : ''}`);
    return toDecision(req, parseDecision(message.content));
  };
}

/** Start one OpenAI-compatible player: register (or resume) at the arena, join the lobby, play. */
export function startOpenAIBot({ provider = 'openai', model, apiBaseUrl, apiKey, extra, persona = PERSONAS[0], name, baseUrl, persist, ...loopOptions }) {
  const resolved = resolveProvider(provider, { apiBaseUrl, apiKey, model, extra });
  const client = new ArenaClient({ name: name || persona.name, baseUrl, persist, model: resolved.model, description: `${provider}/${resolved.model} · ${persona.style}` });
  return runBot(client, makeOpenAIPlayer({ provider, model, apiBaseUrl, apiKey, extra, persona, log: loopOptions.log }), loopOptions);
}
