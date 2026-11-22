import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultPlayers } from '../src/game';
import { openRoom } from '../src/online';

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
  openRoom(defaultPlayers[1], 'ABC23', { waiting: vi.fn(), start, action: vi.fn(), failure });
  if (serviceConnected) peer.emit('open');
  return { rtc, channel, peer, failure, start };
}

describe('room failure messages', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout, setInterval, clearInterval }));
    vi.stubGlobal('navigator', { onLine: true });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

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
    openRoom(defaultPlayers[0], null, { waiting: vi.fn(), start: vi.fn(), action: vi.fn(), failure }, { code: 'ABC23' });
    peer.emit('error', { type: 'unavailable-id' });
    expect(createPeer).toHaveBeenCalledExactlyOnceWith('chrisawad-tic-tac-toe-v1-ABC23', expect.objectContaining({ token: expect.any(String) }));
    expect(failure).toHaveBeenCalledWith(expect.stringContaining('Room ABC23 is still in use'), undefined);
  });

  it('reuses the current host session across an in-page reconnect without browser locks', () => {
    const waiting = vi.fn();
    const handlers = { waiting, start: vi.fn(), action: vi.fn(), failure: vi.fn() };
    const first = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    createPeer.mockReturnValue(first);
    const room = openRoom(defaultPlayers[0], null, handlers);
    first.emit('open');
    const [code, token] = waiting.mock.calls[0];
    room.close();
    const next = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    createPeer.mockReturnValue(next);
    openRoom(defaultPlayers[0], null, handlers, { code, token });
    expect(createPeer).toHaveBeenLastCalledWith('chrisawad-tic-tac-toe-v1-' + code, expect.objectContaining({ token }));
    next.emit('open');
    expect(waiting).toHaveBeenLastCalledWith(code, token);
  });
});
