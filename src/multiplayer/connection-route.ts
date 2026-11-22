export type ConnectionRoute = 'direct' | 'relay' | 'unknown';

const directTypes = ['host', 'srflx', 'prflx'];

function classify(local?: string | null, remote?: string | null): ConnectionRoute {
  if (local === 'relay' || remote === 'relay') return 'relay';
  return directTypes.includes(local ?? '') && directTypes.includes(remote ?? '') ? 'direct' : 'unknown';
}

function routeFromStats(stats: RTCStatsReport): ConnectionRoute {
  let selectedId: string | undefined;
  let legacyPair: RTCIceCandidatePairStats | undefined;
  stats.forEach(entry => {
    if (entry.type === 'transport' && entry.selectedCandidatePairId) selectedId = entry.selectedCandidatePairId;
    if (entry.type === 'candidate-pair' && entry.selected === true) legacyPair = entry;
  });
  const pair = selectedId ? stats.get(selectedId) : legacyPair;
  return classify(stats.get(pair?.localCandidateId)?.candidateType, stats.get(pair?.remoteCandidateId)?.candidateType);
}

export function observeConnectionRoute(pc: RTCPeerConnection, signal: AbortSignal, report: (route: ConnectionRoute) => void) {
  const ice = pc.sctp?.transport?.iceTransport;
  let revision = 0;
  let last: ConnectionRoute | undefined;

  async function refresh() {
    if (signal.aborted) return;
    const current = ++revision;
    let route: ConnectionRoute = 'unknown';
    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      try {
        const pair = ice?.getSelectedCandidatePair?.();
        route = classify(pair?.local?.type, pair?.remote?.type);
      } catch { /* Fall back to the selected pair in the statistics report. */ }
      if (route === 'unknown') {
        try { route = routeFromStats(await pc.getStats()); }
        catch { /* Some browsers expose only partial connection details. */ }
      }
    }
    if (current === revision && !signal.aborted && route !== last) {
      last = route;
      report(route);
    }
  }

  ice?.addEventListener('selectedcandidatepairchange', refresh, { signal });
  pc.addEventListener('iceconnectionstatechange', refresh, { signal });
  void refresh();
  return refresh;
}
