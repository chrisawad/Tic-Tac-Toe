import { digest } from './admissions.js';
export { TurnAdmissions } from './admissions.js';

const routes = new Set(['/v1/matches', '/v1/join', '/v1/ticket', '/v1/credentials']);
const bodyLimit = 2048;
const turnstileURL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

async function verifyPlayer(input, secret, hostname, ip) {
  const { turnstileToken, match, session } = input;
  if (typeof turnstileToken !== 'string' || !turnstileToken || turnstileToken.length > 2048 ||
      typeof match !== 'string' || match.length !== 36 || typeof session !== 'string' || session.length !== 36) return false;
  const expected = await digest(match + ':' + session);
  const result = await fetch(turnstileURL, {
    method: 'POST', body: new URLSearchParams({ secret, response: turnstileToken, remoteip: ip }),
    redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  if (!result.ok) throw new Error('Verification unavailable');
  const proof = await result.json();
  return proof.success === true && proof.hostname === hostname && proof.action === 'game_relay' && proof.cdata === expected;
}

async function readInput(request, limit) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return { error: 415 };
  }
  const reader = request.body?.getReader();
  if (!reader) return { error: 400 };
  const bytes = new Uint8Array(limit);
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.length > limit) {
        void reader.cancel().catch(() => {});
        return { error: 413 };
      }
      bytes.set(value, size);
      size += value.length;
    }
    const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
    if (input && typeof input === 'object' && !Array.isArray(input)) return { input };
  } catch { /* Malformed requests receive the same public error. */ }
  return { error: 400 };
}

async function issueCredentials(keyId, token, headers) {
  const endpoint = 'https://rtc.live.cloudflare.com/v1/turn/keys/'
    + encodeURIComponent(keyId) + '/credentials/generate-ice-servers';
  try {
    const result = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 3600 }),
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    if (result.ok) {
      const { iceServers } = await result.json();
      if (Array.isArray(iceServers) && iceServers.some(server => server?.username && server.credential &&
          [server.urls].flat().some(url => typeof url === 'string' && /^turns?:/i.test(url)))) {
        return Response.json({ iceServers }, { headers });
      }
    }
  } catch { /* Keep upstream details private. Never replay an uncertain mint. */ }
  return Response.json({ message: 'Temporary relay credentials are unavailable.' }, { status: 502, headers });
}

export default {
  async fetch(request, env) {
    const headers = { 'Cache-Control': 'no-store', Vary: 'Origin' };
    const reply = (status, message) => Response.json({ message }, { status, headers });
    const origin = request.headers.get('Origin');
    const origins = (env.GAME_ORIGINS ?? env.GAME_ORIGIN ?? '').split(',').map(entry => entry.trim());
    if (!origin || origin === 'null' || !origins.includes(origin)) return reply(403, 'Unknown game origin.');
    headers['Access-Control-Allow-Origin'] = origin;
    const path = new URL(request.url).pathname;
    if (!routes.has(path)) return reply(404, 'Unknown relay endpoint.');
    if (request.method === 'OPTIONS') return new Response(null, {
      status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' },
    });
    if (request.method !== 'POST') return reply(405, 'Use POST.');
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) return reply(403, 'Client address unavailable.');
    const keyId = env.TURN_KEY_ID?.trim();
    const token = env.TURN_API_TOKEN?.trim();
    if (!env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_SITE_KEY || !keyId || !token || !env.ADMISSIONS || !env.CREDENTIAL_REQUESTS) return reply(503, 'Relay setup is incomplete.');
    try {
      const { input, error } = await readInput(request, path === '/v1/credentials' ? bodyLimit + 2048 : bodyLimit);
      if (error) return reply(error, 'Send a small JSON object.');
      if (path === '/v1/matches' || path === '/v1/credentials') {
        const { success } = await env.CREDENTIAL_REQUESTS.limit({ key: path + ':' + ip });
        if (!success) return reply(429, 'Try again in a minute.');
      }
      if (path === '/v1/credentials') {
        if (!(await verifyPlayer(input, env.TURNSTILE_SECRET_KEY, new URL(origin).hostname, ip))) {
          return reply(403, 'Player verification failed. Try joining again.');
        }
        input.proofHash = await digest(input.turnstileToken);
        delete input.turnstileToken;
      }
      const stub = env.ADMISSIONS.get(env.ADMISSIONS.idFromName('admissions-v1'));
      const admission = await stub.fetch(new Request('https://admissions.internal' + path, {
        method: 'POST', headers: { 'CF-Connecting-IP': ip }, body: JSON.stringify(input),
      }));
      if (path === '/v1/credentials' && admission.status === 204) return await issueCredentials(keyId, token, headers);
      if (path === '/v1/credentials' && admission.ok) return reply(503, 'Relay admission is unavailable.');
      if (admission.ok && (path === '/v1/matches' || path === '/v1/join')) {
        return Response.json({ ...await admission.json(), sitekey: env.TURNSTILE_SITE_KEY }, { headers });
      }
      return new Response(admission.body, { status: admission.status, headers: { ...headers, 'Content-Type': 'application/json' } });
    } catch {
      return reply(503, 'Relay admission is unavailable.');
    }
  },
};
