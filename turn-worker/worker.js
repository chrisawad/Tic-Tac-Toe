export { TurnAdmissions } from './admissions.js';

const routes = new Set(['/v1/matches', '/v1/join', '/v1/ticket', '/v1/credentials']);
const bodyLimit = 2048;

async function readInput(request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return { error: 415 };
  }
  const reader = request.body?.getReader();
  if (!reader) return { error: 400 };
  const bytes = new Uint8Array(bodyLimit);
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.length > bodyLimit) {
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
      body: JSON.stringify({ ttl: 7200 }),
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
    if (!keyId || !token || !env.ADMISSIONS || !env.CREDENTIAL_REQUESTS) return reply(503, 'Relay setup is incomplete.');
    try {
      const { input, error } = await readInput(request);
      if (error) return reply(error, 'Send a small JSON object.');
      if (path === '/v1/matches' || path === '/v1/credentials') {
        const { success } = await env.CREDENTIAL_REQUESTS.limit({ key: path + ':' + ip });
        if (!success) return reply(429, 'Try again in a minute.');
      }
      const stub = env.ADMISSIONS.get(env.ADMISSIONS.idFromName('admissions-v1'));
      const admission = await stub.fetch(new Request('https://admissions.internal' + path, {
        method: 'POST', headers: { 'CF-Connecting-IP': ip }, body: JSON.stringify(input),
      }));
      if (path === '/v1/credentials' && admission.status === 204) return await issueCredentials(keyId, token, headers);
      if (path === '/v1/credentials' && admission.ok) return reply(503, 'Relay admission is unavailable.');
      return new Response(admission.body, { status: admission.status, headers: { ...headers, 'Content-Type': 'application/json' } });
    } catch {
      return reply(503, 'Relay admission is unavailable.');
    }
  },
};
