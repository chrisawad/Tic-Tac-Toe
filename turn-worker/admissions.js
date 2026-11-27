const minute = 60_000;
export const limits = {
  matchLifetime: 5 * minute,
  ticketLifetime: minute,
  ticketsPerSeat: 4,
  create: { window: minute, perIP: 6, total: 120 },
  redeem: { window: 60 * minute, perIP: 12, ipWindow: minute, total: 120 },
};

const failure = (status, message) => Response.json({ message }, { status });
const denied = () => failure(403, 'Invalid or expired relay admission.');

function validPeer(value) {
  return typeof value === 'string' && value.length <= 200 && /^[\x21-\x7e]+$/.test(value);
}
function isUUID(value) {
  return typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(value);
}
async function digest(secret) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

// A single durable coordinator makes the aggregate allowance and redemption atomic across regions.
export class TurnAdmissions {
  constructor(ctx) {
    this.storage = ctx.storage;
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY, game TEXT NOT NULL, host_peer TEXT NOT NULL, guest_peer TEXT NOT NULL,
        commitment TEXT NOT NULL, host_session TEXT NOT NULL, guest_session TEXT,
        host_issued INTEGER NOT NULL DEFAULT 0, guest_issued INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS match_expiry ON matches(expires);
      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY, match_id TEXT NOT NULL, seat TEXT NOT NULL, expires INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ticket_expiry ON tickets(expires);
      CREATE TABLE IF NOT EXISTS usage (kind TEXT NOT NULL, ip TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS usage_time ON usage(kind, at);
      CREATE INDEX IF NOT EXISTS usage_ip ON usage(kind, ip, at);
    `);
  }

  prune(now) {
    this.sql.exec('DELETE FROM tickets WHERE expires <= ?', now);
    this.sql.exec('DELETE FROM matches WHERE expires <= ?', now);
    for (const kind of ['create', 'redeem']) {
      this.sql.exec('DELETE FROM usage WHERE kind = ? AND at <= ?', kind, now - limits[kind].window);
    }
  }

  async alarm() {
    const now = Date.now();
    this.prune(now);
    const [row] = this.sql.exec('SELECT EXISTS(SELECT 1 FROM matches) OR EXISTS(SELECT 1 FROM usage) AS pending');
    if (row.pending) await this.storage.setAlarm(now + minute);
  }

  reserve(kind, ip, now) {
    const policy = limits[kind];
    const [global] = this.sql.exec('SELECT count(*) AS count FROM usage WHERE kind = ? AND at > ?', kind, now - policy.window);
    const [client] = this.sql.exec('SELECT count(*) AS count FROM usage WHERE kind = ? AND ip = ? AND at > ?',
      kind, ip, now - (policy.ipWindow ?? policy.window));
    if (global.count >= policy.total || client.count >= policy.perIP) return false;
    this.sql.exec('INSERT INTO usage VALUES (?, ?, ?)', kind, ip, now);
    return true;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const input = await request.json();
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) return denied();
    if (path === '/v1/matches') {
      const { game, hostPeer, guestPeer, guestCommitment } = input;
      if (![game, hostPeer, guestPeer].every(validPeer) || hostPeer === guestPeer ||
          typeof guestCommitment !== 'string' || !/^[a-f0-9]{64}$/.test(guestCommitment)) {
        return failure(400, 'Invalid relay match.');
      }
      if (await this.storage.getAlarm() === null) await this.storage.setAlarm(Date.now() + minute);
      return this.storage.transactionSync(() => {
        const now = Date.now();
        if (!this.reserve('create', ip, now)) return failure(429, 'Relay match limit reached.');
        const match = crypto.randomUUID();
        const session = crypto.randomUUID();
        this.sql.exec('INSERT INTO matches (id,game,host_peer,guest_peer,commitment,host_session,expires) VALUES (?,?,?,?,?,?,?)',
          match, game, hostPeer, guestPeer, guestCommitment, session, now + limits.matchLifetime);
        return Response.json({ match, session });
      });
    }

    if (!isUUID(input.match)) return denied();
    let proof;
    if (path === '/v1/join') {
      if (!isUUID(input.secret)) return denied();
      proof = await digest(input.secret);
    } else if (!isUUID(input.session)) return denied();
    return this.storage.transactionSync(() => {
      const now = Date.now();
      const [match] = this.sql.exec('SELECT * FROM matches WHERE id = ? AND expires > ?', input.match, now);
      if (!match) return denied();
      if (path === '/v1/join') {
        if (proof !== match.commitment) return denied();
        const session = match.guest_session ?? crypto.randomUUID();
        if (!match.guest_session) this.sql.exec('UPDATE matches SET guest_session = ? WHERE id = ?', session, match.id);
        return Response.json({ session });
      }
      const seat = input.session === match.host_session ? 'host' : input.session === match.guest_session ? 'guest' : null;
      if (!seat) return denied();
      if (!match.guest_session) return failure(409, 'Waiting for the second relay seat.');
      if (path === '/v1/ticket') {
        const column = seat === 'host' ? 'host_issued' : 'guest_issued';
        if (match[column] >= limits.ticketsPerSeat) return failure(429, 'Relay seat limit reached.');
        const ticket = crypto.randomUUID();
        this.sql.exec(`UPDATE matches SET ${column} = ${column} + 1 WHERE id = ?`, match.id);
        this.sql.exec('INSERT INTO tickets VALUES (?,?,?,?)', ticket, match.id, seat, Math.min(match.expires, now + limits.ticketLifetime));
        return Response.json({ ticket });
      }
      if (path !== '/v1/credentials' || !isUUID(input.ticket)) return denied();
      const [valid] = this.sql.exec('SELECT 1 FROM tickets WHERE id = ? AND match_id = ? AND seat = ? AND expires > ?',
        input.ticket, match.id, seat, now);
      if (!valid) return denied();
      if (!this.reserve('redeem', ip, now)) return failure(429, 'Relay credential limit reached.');
      this.sql.exec('DELETE FROM tickets WHERE id = ?', input.ticket);
      return new Response(null, { status: 204 });
    });
  }
}
