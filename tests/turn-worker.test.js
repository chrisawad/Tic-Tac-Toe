import { afterEach, expect, it, vi } from 'vitest';
import worker from '../turn-worker/worker.js';

const origin = 'https://game.example';
function request(method = 'POST', gameOrigin = origin) {
  return new Request('https://worker.example/', { method, headers: { Origin: gameOrigin, 'CF-Connecting-IP': '192.0.2.1' } });
}
function bindings(success = true) {
  return { GAME_ORIGIN: origin, TURN_KEY_ID: 'test-turn-id', TURN_API_TOKEN: 'test-api-key', CREDENTIAL_REQUESTS: { limit: vi.fn(async () => ({ success })) } };
}
afterEach(() => vi.unstubAllGlobals());

it('sends the API key only to the upstream and returns uncached temporary credentials', async () => {
  const iceServers = [{ urls: ['turn:turn.cloudflare.com:3478'], username: 'short-lived', credential: 'temporary' }];
  const upstream = vi.fn(async () => Response.json({ iceServers, other: 'unused' }));
  vi.stubGlobal('fetch', upstream);
  const env = bindings();
  const result = await worker.fetch(request(), env);
  expect(result.status).toBe(200);
  expect(result.headers.get('cache-control')).toBe('no-store');
  expect(result.headers.get('access-control-allow-origin')).toBe(origin);
  expect(await result.json()).toEqual({ iceServers });
  expect(env.CREDENTIAL_REQUESTS.limit).toHaveBeenCalledWith({ key: '192.0.2.1' });
  expect(upstream).toHaveBeenCalledWith('https://rtc.live.cloudflare.com/v1/turn/keys/test-turn-id/credentials/generate-ice-servers',
    expect.objectContaining({ method: 'POST', redirect: 'manual', headers: expect.objectContaining({ Authorization: 'Bearer test-api-key' }), body: JSON.stringify({ ttl: 7200 }) }));
});

it('avoids upstream calls for foreign origins, incomplete setups and rate-limited clients', async () => {
  const upstream = vi.fn();
  vi.stubGlobal('fetch', upstream);
  expect((await worker.fetch(request('POST', 'https://other.example'), bindings())).status).toBe(403);
  expect((await worker.fetch(request('GET'), bindings())).status).toBe(405);
  expect((await worker.fetch(request(), { ...bindings(), TURN_API_TOKEN: '' })).status).toBe(503);
  expect((await worker.fetch(request(), bindings(false))).status).toBe(429);
  expect(upstream).not.toHaveBeenCalled();
});

it.each([302, 401])('keeps upstream details private on a redirect or credential error (%i)', async status => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private upstream body', { status })));
  const failed = await worker.fetch(request(), bindings());
  expect(failed.status).toBe(502);
  expect(await failed.json()).toEqual({ message: 'Cloudflare TURN returned HTTP ' + status + '.' });
});
