// Token usage per player, collected by the model-backed players and printed by bots/run.js when it exits.
export const USAGE = new Map();

export function addUsage(name, { input = 0, output = 0, cached = 0 } = {}) {
  const u = USAGE.get(name) || { calls: 0, input: 0, output: 0, cached: 0 };
  u.calls++;
  u.input += input || 0;
  u.output += output || 0;
  u.cached += cached || 0;
  USAGE.set(name, u);
}

export function usageReport() {
  return [...USAGE].map(([name, u]) => `[${name}] ${u.calls} model calls, ${u.input} input tokens (${u.cached} from cache), ${u.output} output tokens`);
}
