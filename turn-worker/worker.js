export default {
  async fetch(request, env) {
    const headers = { 'Cache-Control': 'no-store', 'Vary': 'Origin' };
    const reply = (status, message) => Response.json({ message }, { status, headers });
    if (new URL(request.url).pathname !== '/') return reply(404, 'Unknown endpoint.');
    const origin = request.headers.get('Origin');
    const origins = (env.GAME_ORIGINS ?? env.GAME_ORIGIN ?? '').split(',').map(entry => entry.trim());
    if (!origin || origin === 'null' || !origins.includes(origin)) return reply(403, 'Unknown game origin.');
    headers['Access-Control-Allow-Origin'] = origin;
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'POST' } });
    }
    if (request.method !== 'POST') return reply(405, 'Use POST.');
    const keyId = env.TURN_KEY_ID?.trim();
    const token = env.TURN_API_TOKEN?.trim();
    if (!keyId || !token) return reply(503, 'Relay setup is incomplete.');
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) return reply(403, 'Client address unavailable.');
    const { success } = await env.CREDENTIAL_REQUESTS.limit({ key: ip });
    if (!success) return reply(429, 'Try again in a minute.');

    const endpoint = 'https://rtc.live.cloudflare.com/v1/turn/keys/'
      + encodeURIComponent(keyId) + '/credentials/generate-ice-servers';
    try {
      const result = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 7200 }),
        redirect: 'manual',
      });
      if (!result.ok) return reply(502, 'Cloudflare TURN returned HTTP ' + result.status + '.');
      const { iceServers } = await result.json();
      if (Array.isArray(iceServers) && iceServers.some(server => server?.username && server.credential && server.urls)) {
        return Response.json({ iceServers }, { headers });
      }
      return reply(502, 'Cloudflare TURN returned no relay credentials.');
    } catch { /* Keep upstream errors and credential details private. */ }
    return reply(502, 'Temporary relay credentials are unavailable.');
  },
};
