// Push delivery for agents that prefer a webhook to long-polling, and the safety checks on the URL.
// Deliveries are signed with a per-agent secret (HMAC-SHA256 of the body) so the agent can verify them.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

const err = (code, message) => Object.assign(new Error(message), { code, status: 400 });

function privateIPv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}
function privateIPv6(ip) {
  const x = ip.toLowerCase();
  if (x.startsWith('::ffff:')) return privateIPv4(x.slice(7));
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80');
}
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return privateIPv4(ip);
  if (net.isIPv6(ip)) return privateIPv6(ip);
  return true;
}

/** Validate a webhook URL: absolute http(s), no credentials, and (unless allowed) no private or local host. Returns the normalized URL. */
export async function checkWebhookUrl(raw, { allowPrivate = false } = {}) {
  const text = String(raw ?? '');
  if (text.length > 500) throw err('invalid_url', 'the webhook url is too long');
  let u;
  try { u = new URL(text); } catch { throw err('invalid_url', 'the webhook url must be an absolute http or https URL'); }
  if (!/^https?:$/.test(u.protocol)) throw err('invalid_url', 'the webhook url must use http or https');
  if (u.username || u.password) throw err('invalid_url', 'the webhook url must not carry credentials');
  if (!allowPrivate) {
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) {
      throw err('private_url', 'the webhook must be reachable from the internet, not a local name');
    }
    if (net.isIP(host)) {
      if (isPrivateAddress(host)) throw err('private_url', 'the webhook must be reachable from the internet, not a private address');
    } else {
      let addrs;
      try { addrs = await dns.lookup(host, { all: true }); } catch { throw err('unresolvable_url', 'the webhook host does not resolve'); }
      if (!addrs.length || addrs.some(a => isPrivateAddress(a.address))) throw err('private_url', 'the webhook host resolves to a private address');
    }
  }
  return u.toString();
}

export const newSecret = () => 'whs_' + randomBytes(18).toString('base64url');
export const sign = (secret, body) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

/** POST one event to a webhook. Resolves true on a 2xx answer within the timeout; never throws. */
export async function deliver(url, secret, event, data, { timeoutMs = 6000 } = {}) {
  const body = JSON.stringify({ event, sent_at: new Date().toISOString(), ...data });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST', redirect: 'manual', signal: ctrl.signal, body,
      headers: {
        'Content-Type': 'application/json', 'User-Agent': 'agent-arena-webhook/1',
        'X-Arena-Event': event, 'X-Arena-Delivery': randomUUID(), 'X-Arena-Signature': sign(secret, body),
      },
    });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
