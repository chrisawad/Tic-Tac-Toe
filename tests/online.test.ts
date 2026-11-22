import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultPlayers } from '../src/game';
import { ticTacToeOnline } from '../src/online';
import { openPeerRoom } from '../src/multiplayer/room';

const { createPeer } = vi.hoisted(() => ({ createPeer: vi.fn() }));
vi.mock('peerjs', () => ({
  util: { defaultConfig: { iceServers: [{ urls: 'turn:relay.example', username: 'host', credential: 'sample' }] } },
  Peer: class { constructor(id: string, options: { config: RTCConfiguration; token?: string }) { return createPeer(id, options); } },
}));

function attempt(serviceConnected = true) {
  const rtc = Object.assign(new EventTarget(), { remoteDescription: null as { type: 'answer' } | null, iceConnectionState: 'new' });
  const channel = Object.assign(new EventEmitter(), { peerConnection: rtc, open: false, send: vi.fn() });
  const peer = Object.assign(new EventEmitter(), { open: serviceConnected, destroy: vi.fn(), connect: () => channel });
  createPeer.mockReturnValue(peer);
  const failure = vi.fn();
  const start = vi.fn();
  openPeerRoom(ticTacToeOnline, defaultPlayers[1], 'ABC23', { waiting: vi.fn(), start, action: vi.fn(), failure });
  if (serviceConnected) peer.emit('open');
  return { rtc, channel, peer, failure, start };
}

function pendingChannel(id: string) {
  const rtc = Object.assign(new EventTarget(), { remoteDescription: { type: 'answer' }, iceConnectionState: 'checking' });
  const channel = Object.assign(new EventEmitter(), {
    peer: id, peerConnection: rtc as typeof rtc | null, open: false, send: vi.fn(), close: vi.fn(),
  });
  // An unopened channel can be cleaned up without emitting close.
  channel.close.mockImplementation(() => { channel.peerConnection = null; });
  return channel;
}

describe('room failure messages', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout, setInterval, clearInterval }));
    vi.stubGlobal('navigator', { onLine: true });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('isolates identical room codes by game namespace', () => {
    const handlers = { waiting: vi.fn(), start: vi.fn(), action: vi.fn(), failure: vi.fn() };
    for (const namespace of ['studio-counter-v1', 'studio-cards-v1']) {
      createPeer.mockReturnValue(Object.assign(new EventEmitter(), { destroy: vi.fn() }));
      const host = openPeerRoom({ ...ticTacToeOnline, namespace }, defaultPlayers[0], null, handlers, { code: 'ABC23' });
      expect(createPeer.mock.lastCall![0]).toBe(namespace + '-ABC23');
      host.close();
    }
  });

  it.each([true, false])('negotiates colors with a guest that supports overrides = %s', acceptsColor => {
    const peer = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    createPeer.mockReturnValue(peer);
    const start = vi.fn();
    const profile = defaultPlayers[0];
    const room = openPeerRoom(ticTacToeOnline, profile, null, { waiting: vi.fn(), start, action: vi.fn(), failure: vi.fn() });
    const channel = Object.assign(new EventEmitter(), { peerConnection: new EventTarget(), open: true, send: vi.fn() });
    peer.emit('connection', channel);
    const guest = { ...profile, name: 'Guest' };
    channel.emit('data', { kind: 'hello', profile: guest, ...(acceptsColor ? { acceptsColor: true } : {}) });
    const [players, seat] = start.mock.calls[0];
    expect(seat).toBe(0);
    expect(players[1].color === profile.color).toBe(!acceptsColor);
    expect(channel.send).toHaveBeenCalledWith({ kind: 'welcome', profile, guestColor: players[1].color });
    room.close();
  });

  it('can still start a direct connection when relay credential issuance fails', async () => {
    vi.stubEnv('VITE_TURN_WORKER_URL', 'https://worker.example/');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    const { peer, rtc, channel, failure } = attempt(false);
    await vi.waitFor(() => expect(peer.listenerCount('open')).toBe(1));
    peer.emit('open');
    const options = createPeer.mock.lastCall![1];
    expect(options.config.iceServers).toEqual([{ urls: expect.arrayContaining(['stun:stun.cloudflare.com:3478']) }]);
    rtc.remoteDescription = { type: 'answer' };
    channel.emit('close');
    expect(failure).toHaveBeenCalledWith(expect.stringContaining('temporary access to the backup relay'), undefined);
  });

  it.each(['error', 'silent close', 'new offer'])('keeps the invite open across a pending guest’s %s', issue => {
    const peer = Object.assign(new EventEmitter(), { open: true, destroy: vi.fn() });
    createPeer.mockClear().mockReturnValue(peer);
    const handlers = { waiting: vi.fn(), status: vi.fn(), start: vi.fn(), action: vi.fn(), failure: vi.fn() };
    const host = openPeerRoom(ticTacToeOnline, defaultPlayers[0], null, handlers);
    peer.emit('open');
    const first = pendingChannel('guest');
    peer.emit('connection', first);
    if (issue === 'error') {
      first.emit('error', new Error('failed'));
      expect(handlers.status).toHaveBeenCalledWith(expect.stringContaining('Room is still open'));
    } else if (issue === 'silent close') {
      first.close();
      vi.advanceTimersByTime(16_000);
    }
    const second = pendingChannel('guest');
    peer.emit('connection', second);
    first.emit('close');
    first.emit('data', { kind: 'hello', profile: defaultPlayers[1] });
    peer.emit('error', { type: 'webrtc' });
    peer.emit('error', { type: 'peer-unavailable' });
    expect(handlers.start).not.toHaveBeenCalled();
    second.open = true;
    second.emit('data', { kind: 'hello', profile: defaultPlayers[1] });
    expect(handlers.start).toHaveBeenCalledOnce();
    expect(handlers.failure).not.toHaveBeenCalled();
    expect(createPeer).toHaveBeenCalledOnce();
    expect(peer.destroy).not.toHaveBeenCalled();
    host.close();
  });

  it.each(['exhausted', 'cancelled'])('bounds the relay retry for a known room when %s', async outcome => {
    const game = { ...ticTacToeOnline, relayUrl: 'https://worker.example/' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      iceServers: [{ urls: 'turn:relay.example:3478', username: 'test', credential: 'test' }],
    })));
    const first = pendingChannel('host');
    const second = pendingChannel('host');
    const peer = Object.assign(new EventEmitter(), {
      open: true, destroy: vi.fn(), options: { config: {} as RTCConfiguration },
      connect: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
    });
    createPeer.mockClear().mockReturnValue(peer);
    const handlers = { waiting: vi.fn(), status: vi.fn(), start: vi.fn(), action: vi.fn(), failure: vi.fn() };
    const guest = openPeerRoom(game, defaultPlayers[1], 'ABC23', handlers);
    await vi.waitFor(() => expect(peer.listenerCount('open')).toBe(1));
    peer.emit('open');
    expect(createPeer.mock.lastCall![1].config.iceTransportPolicy).not.toBe('relay');
    first.emit('error', new Error('failed'));
    first.emit('close');
    expect(handlers.status).toHaveBeenCalledExactlyOnceWith('Room found. Retrying through the backup relay…');
    expect(handlers.failure).not.toHaveBeenCalled();
    if (outcome === 'cancelled') guest.close();
    vi.advanceTimersByTime(1000);
    if (outcome === 'cancelled') {
      expect(peer.connect).toHaveBeenCalledOnce();
      expect(handlers.failure).not.toHaveBeenCalled();
    } else {
      expect(peer.options.config.iceTransportPolicy).toBe('relay');
      expect(peer.connect.mock.calls[1]).toEqual(peer.connect.mock.calls[0]);
      second.emit('error', new Error('failed'));
      vi.advanceTimersByTime(60_000);
      expect(peer.connect).toHaveBeenCalledTimes(2);
      expect(handlers.failure).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('try joining again'), undefined);
    }
    expect(createPeer).toHaveBeenCalledOnce();
  });

  it.each([
    ['turn:relay.example', 'TURN host lookup received error.', false, 'look up a backup relay'],
    ['turns:relay.example', 'Server unreachable', false, 'reach a backup relay'],
    ['stun:stun.example', 'STUN host lookup received error.', false, 'establish a game connection'],
    ['turn:relay.example', 'TURN host lookup received error.', true, 'establish a game connection'],
  ] as const)('uses evidence from %s (%s, relay gathered = %s)', (url, errorText, gathered, expected) => {
    const { rtc, failure } = attempt();
    rtc.remoteDescription = { type: 'answer' };
    rtc.iceConnectionState = 'failed';
    rtc.dispatchEvent(Object.assign(new Event('icecandidateerror'), { url, errorCode: 701, errorText }));
    if (gathered) rtc.dispatchEvent(Object.assign(new Event('icecandidate'), { candidate: { type: 'relay' } }));
    expect(failure).not.toHaveBeenCalled();
    vi.advanceTimersByTime(16_000);
    expect(failure).toHaveBeenCalledWith(expect.stringContaining(expected), undefined);
  });

  it('can start on a slow direct path after a relay DNS error', () => {
    const { rtc, channel, failure, start } = attempt();
    rtc.remoteDescription = { type: 'answer' };
    rtc.iceConnectionState = 'checking';
    rtc.dispatchEvent(Object.assign(new Event('icecandidateerror'), {
      url: 'turn:relay.example', errorCode: 701, errorText: 'TURN host lookup received error.',
    }));
    vi.advanceTimersByTime(23_000);
    expect(failure).not.toHaveBeenCalled();
    channel.open = true;
    channel.emit('open');
    channel.emit('data', { kind: 'welcome', profile: defaultPlayers[0] });
    vi.advanceTimersByTime(18_000);
    expect(start).toHaveBeenCalledOnce();
    expect(failure).not.toHaveBeenCalled();
  });

  it('reports a game channel timeout separately when a network path already connected', () => {
    const { rtc, channel, failure } = attempt();
    rtc.remoteDescription = { type: 'answer' };
    rtc.iceConnectionState = 'completed';
    channel.emit('iceStateChanged', 'completed');
    vi.advanceTimersByTime(40_000);
    expect(failure).toHaveBeenCalledWith(expect.stringContaining('devices reached each other'), undefined);
  });

  it('distinguishes a missing host reply from a room lookup failure', () => {
    const silent = attempt();
    vi.advanceTimersByTime(16_000);
    expect(silent.failure).toHaveBeenCalledWith(expect.stringContaining('No reply arrived from the host'), 'host');
    const missing = attempt();
    missing.peer.emit('error', { type: 'peer-unavailable' });
    expect(missing.failure).toHaveBeenCalledWith(expect.stringContaining('Room ABC23 couldn’t be found'), 'host');
  });

  it('distinguishes a room service timeout from losing an established service connection', () => {
    const pending = attempt(false);
    vi.advanceTimersByTime(16_000);
    expect(pending.failure).toHaveBeenCalledWith(expect.stringContaining('room service didn’t respond in time'), 'service');
    const connected = attempt();
    connected.peer.emit('error', { type: 'network' });
    expect(connected.failure).toHaveBeenCalledWith(expect.stringContaining('lost its connection to the room service'), 'service');
  });

  it('distinguishes game setup failure from losing contact during a match', () => {
    const setup = attempt();
    setup.channel.open = true;
    setup.channel.emit('open');
    setup.channel.emit('close');
    expect(setup.failure).toHaveBeenCalledWith(expect.stringContaining('game setup didn’t finish'), 'host');
    const game = attempt();
    game.channel.open = true;
    game.channel.emit('open');
    game.channel.emit('data', { kind: 'welcome', profile: defaultPlayers[0] });
    game.channel.emit('close');
    expect(game.failure).toHaveBeenCalledWith(expect.stringContaining('Lost contact'), undefined);
  });

  it('stops on a genuine registration conflict without replacing the shared code', () => {
    const peer = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    createPeer.mockClear().mockReturnValue(peer);
    const failure = vi.fn();
    openPeerRoom(ticTacToeOnline, defaultPlayers[0], null, { waiting: vi.fn(), start: vi.fn(), action: vi.fn(), failure }, { code: 'ABC23' });
    peer.emit('error', { type: 'unavailable-id' });
    expect(createPeer).toHaveBeenCalledExactlyOnceWith('chrisawad-tic-tac-toe-v1-ABC23', expect.objectContaining({ token: expect.any(String) }));
    expect(failure).toHaveBeenCalledWith(expect.stringContaining('Room ABC23 is still in use'), undefined);
  });

  it('reuses the current host session across an in-page reconnect without browser locks', () => {
    const waiting = vi.fn();
    const handlers = { waiting, start: vi.fn(), action: vi.fn(), failure: vi.fn() };
    const first = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    createPeer.mockReturnValue(first);
    const room = openPeerRoom(ticTacToeOnline, defaultPlayers[0], null, handlers);
    first.emit('open');
    const [code, token] = waiting.mock.calls[0];
    room.close();
    const next = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    createPeer.mockReturnValue(next);
    openPeerRoom(ticTacToeOnline, defaultPlayers[0], null, handlers, { code, token });
    expect(createPeer).toHaveBeenLastCalledWith('chrisawad-tic-tac-toe-v1-' + code, expect.objectContaining({ token }));
    next.emit('open');
    expect(waiting).toHaveBeenLastCalledWith(code, token);
  });
});
