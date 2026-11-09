import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeOpenAIPlayer, parseDecision, resolveProvider, PROVIDERS } from '../bots/openai-bot.js';
import { parseSeats, normalizeSeat } from '../bots/lib/lineup.js';

const players = [
  { player_id: 'p1', name: 'Ondine', alive: true, role: null },
  { player_id: 'p2', name: 'Moonshine', alive: true, role: null },
  { player_id: 'p3', name: 'Tallow', alive: true, role: null },
];
const statementReq = {
  type: 'statement', round: 1, pass: 1, passes: 2, seconds_left: 40, players, options: [], history: [],
  you: { player_id: 'p1', name: 'Ondine', role: 'werewolf', team: 'werewolves', alive: true },
  role_counts: { werewolf: 1, villager: 2 }, instructions: 'speak',
};

test('parseDecision tolerates fences, prose and string booleans', () => {
  const fenced = parseDecision('```json\n{"confessional": "I am the wolf.", "text": "I am a villager.", "lie": true, "target": null}\n```');
  assert.deepEqual(fenced, { confessional: 'I am the wolf.', text: 'I am a villager.', lie: true, target: null });
  const prose = parseDecision('Sure! Here is my move: {"reasoning": "seer here", "text": null, "lie": "false", "target": "p2"} Hope that helps.');
  assert.deepEqual(prose, { confessional: 'seer here', text: null, lie: false, target: 'p2' });
  assert.throws(() => parseDecision('I would rather not.'), /no JSON object/);
});

test('seats parse from provider:model:name entries and normalize JSON seats', () => {
  const seats = parseSeats('claude:claude-opus-5-5:Opus 5.5, openai:gpt-5.1 ,scripted');
  assert.deepEqual(seats, [
    { provider: 'claude', model: 'claude-opus-5-5', name: 'Opus 5.5' },
    { provider: 'openai', model: 'gpt-5.1' },
    { provider: 'scripted' },
  ]);
  assert.deepEqual(normalizeSeat({ provider: 'OpenRouter', model: 'z-ai/glm-4.6', persona: 'Thorne', extra: { reasoning: { effort: 'low' } } }),
    { provider: 'openrouter', model: 'z-ai/glm-4.6', persona: 'Thorne', extra: { reasoning: { effort: 'low' } } });
  assert.throws(() => parseSeats(':gpt-5.1'), /bad seat/);
});

test('providers resolve from presets and environment, and refuse to start without a key', () => {
  const saved = { ...process.env };
  try {
    delete process.env.OPENAI_API_KEY;
    assert.throws(() => resolveProvider('openai'), /OPENAI_API_KEY/);
    assert.throws(() => resolveProvider('mycloud', { apiKey: 'k' }), /MYCLOUD_BASE_URL/);
    process.env.MYCLOUD_BASE_URL = 'https://llm.example.com/v1/';
    process.env.MYCLOUD_API_KEY = 'secret';
    process.env.MYCLOUD_MODEL = 'big-model';
    assert.deepEqual(resolveProvider('mycloud'), { baseUrl: 'https://llm.example.com/v1', apiKey: 'secret', model: 'big-model', headers: {}, extra: {} });
    const dr = resolveProvider('deepseek', { apiKey: 'k', extra: { temperature: 0.7 } });
    assert.equal(dr.baseUrl, PROVIDERS.deepseek.baseUrl);
    assert.equal(dr.model, PROVIDERS.deepseek.model);
    assert.deepEqual(dr.extra, { temperature: 0.7 });
    assert.equal(resolveProvider('ollama').apiKey, '');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('the OpenAI-compatible player calls chat/completions, drops a refused response_format, and maps the reply', async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', d => { b += d; }).on('end', () => {
      const body = JSON.parse(b);
      calls.push({ url: req.url, auth: req.headers.authorization, body });
      res.setHeader('content-type', 'application/json');
      if (body.response_format) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: { message: "Unsupported parameter: 'response_format' is not supported with this model." } }));
      }
      res.writeHead(200);
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '```json\n{"confessional":"I am the wolf and this is a bluff.","text":"I am a villager, plain as bread.","lie":true,"target":null}\n```' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 40 },
      }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const decide = makeOpenAIPlayer({ provider: 'fake', apiBaseUrl: `http://127.0.0.1:${port}/v1/`, apiKey: 'k', model: 'm', extra: { reasoning_effort: 'low' }, log: () => {} });
    const d = await decide(statementReq);
    assert.deepEqual(d.action, { text: 'I am a villager, plain as bread.', lie: true });
    assert.equal(d.reasoning, 'I am the wolf and this is a bluff.');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, '/v1/chat/completions');
    assert.equal(calls[0].auth, 'Bearer k');
    assert.ok(calls[0].body.response_format, 'first try uses JSON mode');
    assert.ok(!calls[1].body.response_format, 'retry drops JSON mode');
    assert.equal(calls[1].body.model, 'm');
    assert.equal(calls[1].body.reasoning_effort, 'low');
    assert.equal(calls[1].body.messages[0].role, 'system');
    assert.match(calls[1].body.messages[0].content, /Your name at this table is Ondine/);
    assert.match(calls[1].body.messages[1].content, /REQUEST: statement/);
    // JSON mode stays off for the next request
    await decide(statementReq);
    assert.equal(calls.length, 3);
    assert.ok(!calls[2].body.response_format);
  } finally {
    server.close();
  }
});
