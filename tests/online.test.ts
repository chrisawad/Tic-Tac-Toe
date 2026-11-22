import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultPlayers } from '../src/game';
import { openRoom } from '../src/online';

const { createPeer } = vi.hoisted(() => ({ createPeer: vi.fn() }));
vi.mock('peerjs', () => ({ Peer: class { constructor() { return createPeer(); } } }));

function attempt(serviceConnected = true) {
  const rtc = Object.assign(new EventTarget(), { remoteDescription: null as { type: 'answer' } | null });
  const channel = Object.assign(new EventEmitter(), { peerConnection: rtc, open: false, send: vi.fn() });
  const peer = Object.assign(new EventEmitter(), { open: serviceConnected, destroy: vi.fn(), connect: () => channel });
  createPeer.mockReturnValue(peer);
  const failure = vi.fn();
  openRoom(defaultPlayers[1], 'ABC23', { waiting: vi.fn(), start: vi.fn(), action: vi.fn(), failure });
  if (serviceConnected) peer.emit('open');
  return { rtc, channel, peer, failure };
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
    rtc.dispatchEvent(Object.assign(new Event('icecandidateerror'), { url, errorCode: 701, errorText }));
    if (gathered) rtc.dispatchEvent(Object.assign(new Event('icecandidate'), { candidate: { type: 'relay' } }));
    expect(failure).not.toHaveBeenCalled();
    vi.advanceTimersByTime(16_000);
    expect(failure).toHaveBeenCalledWith(expect.stringContaining(expected));
  });

  it('distinguishes a missing host reply from a room lookup failure', () => {
    const silent = attempt();
    vi.advanceTimersByTime(16_000);
    expect(silent.failure).toHaveBeenCalledWith(expect.stringContaining('No reply arrived from the host'));
    const missing = attempt();
    missing.peer.emit('error', { type: 'peer-unavailable' });
    expect(missing.failure).toHaveBeenCalledWith(expect.stringContaining('Room ABC23 couldn’t be found'));
  });

  it('distinguishes a room service timeout from losing an established service connection', () => {
    const pending = attempt(false);
    vi.advanceTimersByTime(16_000);
    expect(pending.failure).toHaveBeenCalledWith(expect.stringContaining('room service in time'));
    const connected = attempt();
    connected.peer.emit('error', { type: 'network' });
    expect(connected.failure).toHaveBeenCalledWith(expect.stringContaining('lost its connection to the PeerJS room service'));
  });

  it('distinguishes game setup failure from losing contact during a match', () => {
    const setup = attempt();
    setup.channel.open = true;
    setup.channel.emit('open');
    setup.channel.emit('close');
    expect(setup.failure).toHaveBeenCalledWith(expect.stringContaining('game setup didn’t finish'));
    const game = attempt();
    game.channel.open = true;
    game.channel.emit('open');
    game.channel.emit('data', { kind: 'welcome', profile: defaultPlayers[0] });
    game.channel.emit('close');
    expect(game.failure).toHaveBeenCalledWith(expect.stringContaining('Lost contact'));
  });
});
