// Lineups: who sits at the table. Either a short spec, one seat per comma-separated entry,
//   provider[:model[:name]]            e.g. "claude:claude-opus-5-5:Opus 5.5,openai:gpt-5.1:GPT-5.1,scripted"
// or a JSON file with an array of seats:
//   [{"provider": "openrouter", "model": "z-ai/glm-4.6", "name": "GLM-4.6", "persona": "Thorne", "extra": {"reasoning": {"effort": "low"}}}]
// Seat fields: provider (scripted, claude, or an OpenAI-compatible provider), model, name, persona (a PERSONAS name),
// effort (Claude only), base_url (OpenAI-compatible only), extra (request fields merged into the chat-completions body).
// Model ids that contain ':' (OpenRouter variants such as ":free") need the JSON form.
import fs from 'node:fs';

export function parseSeats(spec) {
  return String(spec).split(',').map(s => s.trim()).filter(Boolean).map(entry => {
    const [provider, model, name] = entry.split(':').map(x => x.trim());
    if (!provider) throw new Error(`bad seat "${entry}": expected provider[:model[:name]]`);
    return normalizeSeat({ provider, model, name });
  });
}

export function loadLineup(file) {
  const seats = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(seats) || !seats.length) throw new Error(`${file}: expected a non-empty JSON array of seats`);
  return seats.map(normalizeSeat);
}

export function normalizeSeat(seat) {
  if (!seat || typeof seat !== 'object') throw new Error('a seat must be an object');
  const out = { provider: String(seat.provider || 'scripted').toLowerCase() };
  for (const k of ['model', 'name', 'persona', 'effort']) if (seat[k]) out[k] = String(seat[k]);
  if (seat.base_url || seat.baseUrl) out.base_url = String(seat.base_url || seat.baseUrl);
  if (seat.extra && typeof seat.extra === 'object') out.extra = seat.extra;
  return out;
}
