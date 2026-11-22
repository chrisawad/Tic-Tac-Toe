import { util, type DataConnection } from 'peerjs';

export const defaultRtcConfig: RTCConfiguration = {
  ...util.defaultConfig,
  iceServers: [...util.defaultConfig.iceServers, { urls: 'stun:stun.cloudflare.com:3478' }],
};

const directServers: RTCIceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

async function fetchRelayServers(endpoint: string, signal: AbortSignal): Promise<RTCIceServer[]> {
  const response = await fetch(endpoint, {
    method: 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
    signal: AbortSignal.any([signal, AbortSignal.timeout(4_000)]),
  });
  if (!response.ok) throw new Error('Relay credential request failed.');
  const { iceServers } = await response.json();
  const servers: RTCIceServer[] = [];
  if (Array.isArray(iceServers)) {
    for (const server of iceServers) {
      if (!server || typeof server.username !== 'string' || typeof server.credential !== 'string') continue;
      const urls = [server.urls].flat().filter((url): url is string =>
        typeof url === 'string' && /^turns?:[\w.-]+:\d+(\?transport=(udp|tcp))?$/i.test(url) && !/:53(?:\?|$)/.test(url));
      if (urls.length) servers.push({ urls, username: server.username, credential: server.credential });
    }
  }
  if (!servers.length) throw new Error('No usable relay servers.');
  return servers;
}

export async function relayConfiguration(endpoint: string, signal: AbortSignal) {
  try {
    const relays = await fetchRelayServers(endpoint, signal);
    return { config: { ...defaultRtcConfig, iceServers: [...directServers, ...relays] }, unavailable: false };
  } catch {
    return { config: { ...defaultRtcConfig, iceServers: directServers }, unavailable: true };
  }
}

export function trackConnectionSetup(connection: DataConnection, host: boolean, signal: AbortSignal, relayUnavailable: boolean) {
  const pc = connection.peerConnection;
  let opened = false;
  let networkConnected = false;
  let gatheredRelay = false;
  let relayIssue = '';
  connection.on('open', () => { opened = true; });
  connection.on('iceStateChanged', state => {
    if (state === 'connected' || state === 'completed') networkConnected = true;
  });
  pc.addEventListener('icecandidate', event => {
    if (event.candidate?.type === 'relay') gatheredRelay = true;
  }, { signal });
  pc.addEventListener('icecandidateerror', event => {
    if (!/^turns?:/i.test(event.url) || event.errorCode !== 701) return;
    // 701 covers reachability. Only some browsers identify a DNS failure.
    if (/host lookup|dns|name resolution/i.test(event.errorText)) {
      relayIssue = 'This device couldn’t look up a backup relay’s address.';
    } else if (!relayIssue) {
      relayIssue = 'This device couldn’t reach a backup relay.';
    }
  }, { signal });
  return () => {
    if (opened) return 'The devices connected, but game setup didn’t finish. Return to the game on both devices and try joining again.';
    if (!host && !pc.remoteDescription) return 'No reply arrived from the host. Ask them to keep the room open and share their current code.';
    if (networkConnected || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      return 'Room found. The devices reached each other, but the game channel didn’t open. Keep both games on screen and try joining again.';
    }
    if (relayIssue && !gatheredRelay) return `Room found, but no direct connection opened. ${relayIssue} Try joining again.`;
    if (relayUnavailable) return 'Room found, but no direct connection opened. This device couldn’t get temporary access to the backup relay. Try joining again in a minute.';
    return 'Room found, but the devices couldn’t establish a game connection. Keep both games open and try joining again.';
  };
}
