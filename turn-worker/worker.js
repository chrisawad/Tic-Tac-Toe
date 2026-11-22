export default {
  async fetch(request, env) {
    const headers = { 'Cache-Control': 'no-store', 'Vary': 'Origin' };
    const reply = (status, message) => Response.json({ message }, { status, headers });
    if (new URL(request.url).pathname !== '/') return reply(404, 'Unknown endpoint.');
    if (request.headers.get('Origin') !== env.GAME_ORIGIN) return reply(403, 'Unknown game origin.');
    headers['Access-Control-Allow-Origin'] = env.GAME_ORIGIN;
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'POST' } });
    }
    if (request.method !== 'POST') return reply(405, 'Use POST.');
    if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) return reply(503, 'Relay setup is incomplete.');
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) return reply(403, 'Client address unavailable.');
    const { success } = await env.CREDENTIAL_REQUESTS.limit({ key: ip });
    if (!success) return reply(429, 'Try again in a minute.');

    const endpoint = 'https://rtc.live.cloudflare.com/v1/turn/keys/'
      + encodeURIComponent(env.TURN_KEY_ID) + '/credentials/generate-ice-servers';
    try {
      const result = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.TURN_API_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 7200 }),
        redirect: 'error',
      });
      if (result.ok) {
        const { iceServers } = await result.json();
        if (Array.isArray(iceServers)) return Response.json({ iceServers }, { headers });
      }
    } catch { /* Keep upstream errors and credential details private. */ }
    return reply(502, 'Temporary relay credentials are unavailable.');
  },
};
