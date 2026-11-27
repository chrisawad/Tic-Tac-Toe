import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker, { TurnAdmissions } from '../turn-worker/worker.js';
import { limits } from '../turn-worker/admissions.js';

const origin = 'https://game.example';
const ip = '192.0.2.1';
const iceServers = [{ urls: ['turn:relay.invalid:3478'], username: 'fixture', credential: 'fixture' }];
let db, storage, env, upstream, now, alarmAt;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  now = Date.UTC(2026, 0, 1);
  alarmAt = null;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  storage = {
    sql: { exec(sql, ...args) {
      if (sql.trim().startsWith('CREATE TABLE')) { db.exec(sql); return []; }
      return db.prepare(sql).all(...args);
    } },
    getAlarm: async () => alarmAt,
    setAlarm: async at => { alarmAt = at; },
    transactionSync(run) {
      db.exec('BEGIN');
      try { const result = run(); db.exec('COMMIT'); return result; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
  const admissions = new TurnAdmissions({ storage });
  env = {
    GAME_ORIGIN: origin, TURN_KEY_ID: 'test-id', TURN_API_TOKEN: 'test-api-key',
    CREDENTIAL_REQUESTS: { limit: vi.fn(async () => ({ success: true })) },
    ADMISSIONS: { idFromName: key => key, get: () => admissions },
  };
  upstream = vi.fn(async () => Response.json({ iceServers, extra: 'private' }));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); db.close(); });

function post(path, body, address = ip, options = {}) {
  const init = {
    method: 'POST', body: body === undefined ? undefined : JSON.stringify(body),
    ...options, headers: { Origin: origin, 'CF-Connecting-IP': address, 'Content-Type': 'application/json', ...options.headers },
  };
  return worker.fetch(new Request('https://worker.example/' + path, init), env);
}
async function create(address = ip) {
  const secret = crypto.randomUUID();
  const guestCommitment = createHash('sha256').update(secret).digest('hex');
  const params = { game: 'test-game', hostPeer: 'host', guestPeer: 'guest', guestCommitment };
  const response = await post('v1/matches', params, address);
  expect(response.status).toBe(200);
  const { match, session } = await response.json();
  return { match, secret, host: { match, session }, params };
}
async function pair(address = ip) {
  const room = await create(address);
  const result = await post('v1/join', { match: room.match, secret: room.secret });
  expect(result.status).toBe(200);
  return { ...room, guest: { match: room.match, ...(await result.json()) } };
}
async function ticket(seat) {
  const result = await post('v1/ticket', seat);
  expect(result.status).toBe(200);
  return { ...seat, ...(await result.json()) };
}
const mint = (grant, address) => post('v1/credentials', grant, address);

it('denies the old POST, foreign origins, malformed inputs and incomplete deployment', async () => {
  expect((await post('', undefined)).status).toBe(404);
  env.GAME_ORIGINS = origin + ', https://second.example';
  for (const allowed of [origin, 'https://second.example']) {
    const result = await post('v1/credentials', undefined, ip, { method: 'OPTIONS', headers: { Origin: allowed } });
    expect(result.status).toBe(204);
    expect(result.headers.get('Access-Control-Allow-Origin')).toBe(allowed);
    expect(result.headers.get('Access-Control-Allow-Headers')).toMatch(/content-type/i);
  }
  for (const value of ['null', '', 'https://game.example.other', 'http://game.example']) {
    const denied = await post('v1/matches', {}, ip, { headers: { Origin: value } });
    expect(denied.status).toBe(403);
    expect(denied.headers.has('Access-Control-Allow-Origin')).toBe(false);
  }
  expect((await post('v1/join', undefined, ip, { method: 'GET' })).status).toBe(405);
  expect((await post('v1/join', undefined, ip, { body: '{' })).status).toBe(400);
  expect((await post('v1/join', [])).status).toBe(400);
  expect((await post('v1/matches', { game: 'a'.repeat(3000) })).status).toBe(413);
  expect((await post('v1/join', {}, ip, { headers: { 'Content-Type': 'text/plain' } })).status).toBe(415);
  expect((await post('v1/matches', {})).status).toBe(400);
  expect((await post('v1/credentials', {}, '')).status).toBe(403);
  env.CREDENTIAL_REQUESTS.limit.mockResolvedValue({ success: false });
  expect((await post('v1/matches', {})).status).toBe(429);
  env.TURN_API_TOKEN = '';
  expect((await post('v1/matches', {})).status).toBe(503);
  expect(upstream).not.toHaveBeenCalled();
});

it('waits for a second seat, verifies the guest proof and makes concurrent claims idempotent', async () => {
  const { match, host, secret } = await create();
  expect((await post('v1/ticket', host)).status).toBe(409);
  expect((await post('v1/join', { match, secret: crypto.randomUUID() })).status).toBe(403);
  expect((await post('v1/ticket', { match, session: crypto.randomUUID() })).status).toBe(403);
  const claims = await Promise.all([1, 2].map(async () => (await post('v1/join', { match, secret })).json()));
  expect(claims[0]).toEqual(claims[1]);
  expect(claims[0].session).toBeTruthy();
  expect(claims[0].session).not.toBe(host.session);
  expect(upstream).not.toHaveBeenCalled();
});

it('binds tickets to the match and seat and reserves each mint once across concurrent requests', async () => {
  const a = await pair();
  const b = await pair();
  const [host, guest] = await Promise.all([ticket(a.host), ticket(a.guest)]);
  for (const wrong of [a.guest, b.host, { match: b.match, session: a.host.session }]) {
    expect((await mint({ ...wrong, ticket: host.ticket })).status).toBe(403);
  }
  const responses = await Promise.all([mint(host), mint(host), mint(guest)]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 200, 403]);
  for (const response of responses.filter(r => r.ok)) {
    expect(await response.json()).toEqual({ iceServers });
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
  expect(upstream).toHaveBeenCalledTimes(2);
  expect(upstream).toHaveBeenCalledWith('https://rtc.live.cloudflare.com/v1/turn/keys/test-id/credentials/generate-ice-servers',
    expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-api-key' }), redirect: 'manual', body: '{"ttl":7200}' }));
});

it('rejects expired tickets and matches without waiting for cleanup, then frees idle storage', async () => {
  const room = await pair();
  const grant = await ticket(room.host);
  expect(alarmAt).toBeGreaterThan(now);
  now += limits.ticketLifetime;
  expect((await mint(grant)).status).toBe(403);
  const second = await ticket(room.host);
  now += limits.matchLifetime;
  expect((await mint(second)).status).toBe(403);
  expect((await post('v1/ticket', room.guest)).status).toBe(403);
  expect((await post('v1/join', { match: room.match, secret: room.secret })).status).toBe(403);
  const restarted = new TurnAdmissions({ storage });
  alarmAt = null;
  await restarted.alarm();
  expect(alarmAt).toBeNull();
  for (const table of ['matches', 'usage', 'tickets']) expect(db.prepare('SELECT count(*) AS n FROM ' + table).get().n).toBe(0);
});

it('bounds tickets for each seat and match creation per address', async () => {
  const room = await pair();
  const issued = await Promise.all(Array.from({ length: limits.ticketsPerSeat + 2 }, () => post('v1/ticket', room.host)));
  expect(issued.filter(r => r.ok)).toHaveLength(limits.ticketsPerSeat);
  expect(issued.filter(r => r.status === 429)).toHaveLength(2);
  await ticket(room.guest);
  for (let i = 1; i < limits.create.perIP; i++) await create();
  expect((await post('v1/matches', room.params)).status).toBe(429);
  await create('192.0.2.2');
  now += limits.create.window;
  await create();
});

it('enforces an IP allowance and a shared rolling ceiling across seats and addresses', async () => {
  let count = 0;
  const address = () => '192.0.2.' + (2 + Math.floor(count / limits.redeem.perIP));
  while (count < limits.redeem.total) {
    const room = await pair(address());
    for (const seat of [room.host, room.guest]) {
      for (let i = 0; i < limits.ticketsPerSeat && count < limits.redeem.total; i++) {
        const grant = await ticket(seat);
        if (count === limits.redeem.perIP) expect((await mint(grant, '192.0.2.2')).status).toBe(429);
        expect((await mint(grant, address())).status).toBe(200);
        count++;
      }
    }
  }
  const other = await pair('198.51.100.1');
  expect((await mint(await ticket(other.host), '198.51.100.1')).status).toBe(429);
  now += limits.redeem.window;
  expect((await mint(await ticket((await pair()).host))).status).toBe(200);
});

it('bounds total match creation across addresses', async () => {
  const room = await create();
  for (let i = 1; i < limits.create.total; i++) {
    await create('192.0.2.' + (2 + Math.floor(i / limits.create.perIP)));
  }
  expect((await post('v1/matches', room.params, '198.51.100.1')).status).toBe(429);
  expect(upstream).not.toHaveBeenCalled();
});

it('fails closed when the coordinator cannot commit a redemption', async () => {
  const grant = await ticket((await pair()).host);
  db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON tickets BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  expect((await mint(grant)).status).toBe(503);
  expect(upstream).not.toHaveBeenCalled();
  expect(db.prepare("SELECT count(*) AS n FROM usage WHERE kind = 'redeem'").get().n).toBe(0);
  db.exec('DROP TRIGGER fail_delete');
  expect((await mint(grant)).status).toBe(200);
});

it.each([302, 401, 503, 200])('consumes uncertain mints and hides upstream errors or bad payloads (%i)', async status => {
  upstream.mockResolvedValue(new Response('private-upstream-body', { status }));
  const grant = await ticket((await pair()).guest);
  const response = await mint(grant);
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ message: 'Temporary relay credentials are unavailable.' });
  expect((await mint(grant)).status).toBe(403);
  expect(upstream).toHaveBeenCalledTimes(1);
});
