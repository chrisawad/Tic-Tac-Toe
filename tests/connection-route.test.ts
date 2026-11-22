import { expect, it, vi } from 'vitest';
import { observeConnectionRoute } from '../src/multiplayer/connection-route';

function monitor(pair: () => unknown, getStats = vi.fn().mockResolvedValue(new Map())) {
  const ice = Object.assign(new EventTarget(), { getSelectedCandidatePair: pair });
  const pc = Object.assign(new EventTarget(), { iceConnectionState: 'connected', sctp: { transport: { iceTransport: ice } }, getStats });
  const controller = new AbortController();
  const report = vi.fn();
  const refresh = observeConnectionRoute(pc as unknown as RTCPeerConnection, controller.signal, report);
  return { ice, pc, controller, report, refresh };
}

it('follows both ends of the selected route through changes and stops after the game closes', () => {
  const selected = { local: { type: 'host' }, remote: { type: 'srflx' } };
  const { ice, pc, controller, report } = monitor(() => selected);
  expect(report).toHaveBeenLastCalledWith('direct');
  selected.remote.type = 'relay';
  ice.dispatchEvent(new Event('selectedcandidatepairchange'));
  expect(report).toHaveBeenLastCalledWith('relay');
  selected.remote.type = 'prflx';
  selected.local.type = 'relay';
  ice.dispatchEvent(new Event('selectedcandidatepairchange'));
  expect(report).toHaveBeenCalledTimes(2);
  pc.iceConnectionState = 'disconnected';
  pc.dispatchEvent(new Event('iceconnectionstatechange'));
  expect(report).toHaveBeenLastCalledWith('unknown');
  controller.abort();
  pc.iceConnectionState = 'completed';
  ice.dispatchEvent(new Event('selectedcandidatepairchange'));
  expect(report).toHaveBeenCalledTimes(3);
});

it('uses the selected stats pair even when an unused nominated relay is also present', async () => {
  const stats = new Map<string, Record<string, unknown>>([
    ['transport', { type: 'transport', selectedCandidatePairId: 'used' }],
    ['used', { type: 'candidate-pair', localCandidateId: 'a', remoteCandidateId: 'b' }],
    ['unused', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'a', remoteCandidateId: 'c' }],
    ['a', { candidateType: 'host' }], ['b', { candidateType: 'prflx' }], ['c', { candidateType: 'relay' }],
  ]);
  const { report, refresh } = monitor(() => null, vi.fn().mockResolvedValue(stats));
  await refresh();
  expect(report).toHaveBeenLastCalledWith('direct');
  stats.set('transport', { type: 'transport', selectedCandidatePairId: 'unused' });
  await refresh();
  expect(report).toHaveBeenLastCalledWith('relay');
  stats.delete('transport');
  await refresh();
  expect(report).toHaveBeenLastCalledWith('unknown');
  stats.get('used')!.selected = true;
  stats.delete('b');
  await refresh();
  expect(report).toHaveBeenLastCalledWith('unknown');
});
