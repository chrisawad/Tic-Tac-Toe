import { createLobbyStore, type HostLobby } from './lobby-store';
import { isRoomCode } from './invite';
import { offlineMessage, openPeerRoom, type MultiplayerGame, type RoomHandlers, type Seat } from './room';

export interface MultiplayerEvents<Profile, Action> {
  opening?: (joinCode: string | null, restoring: boolean) => void;
  invite: (code: string, message: string) => void;
  status?: (message: string) => void;
  route?: RoomHandlers<Profile, Action>['route'];
  start: (players: [Profile, Profile], seat: Seat, originalProfile: Profile) => void;
  action: (action: Action, sender: Seat) => void;
  error: (message: string, joinCode: string | null) => void;
}

export function createMultiplayer<Profile, Action extends object>(
  game: MultiplayerGame<Profile, Action>, events: MultiplayerEvents<Profile, Action>,
) {
  const store = createLobbyStore(game.storageKey ?? game.namespace + ':waiting-host', game.isProfile);
  const lifetime = new AbortController();
  const options = { signal: lifetime.signal };
  let room: ReturnType<typeof openPeerRoom<Profile, Action>> | undefined;
  let lobby: HostLobby<Profile> | null = null;
  let retryTimer: number | undefined;
  let retries = 0;
  let joinIssue = '';
  let retryUntil = 0;
  let attempt = 0;

  function clearLobby() {
    window.clearTimeout(retryTimer);
    if (lobby) store.forget(lobby);
    lobby = null;
    retries = 0;
    retryUntil = 0;
    joinIssue = '';
  }

  function disconnect() {
    attempt++;
    room?.close();
    room = undefined;
  }

  function leave() {
    disconnect();
    clearLobby();
  }

  function resume() {
    if (!lobby || room || document.hidden) return;
    events.status?.(navigator.onLine ? `Reopening room ${lobby.code}…` : `Room ${lobby.code} will reopen when you’re back online.`);
    if (navigator.onLine) connect(lobby.profile, null);
  }

  function suspend() {
    if (!lobby) return;
    store.remember(lobby);
    window.clearTimeout(retryTimer);
    disconnect();
  }

  function connect(profile: Profile, code: string | null) {
    if (lifetime.signal.aborted) return;
    window.clearTimeout(retryTimer);
    disconnect();
    const current = attempt;
    if (!navigator.onLine) {
      events.error(offlineMessage, code);
      return;
    }
    events.opening?.(code, Boolean(lobby));
    try {
      const connection = openPeerRoom(game, profile, code, {
        waiting(code, token) {
          retries = 0;
          lobby = { code, token, profile };
          store.remember(lobby);
          events.invite(code, joinIssue || 'Waiting for a friend to join…');
        },
        connecting() { events.status?.('Room found. Still connecting the devices… Keep both games on screen.'); },
        route: events.route,
        start(players, seat) {
          clearLobby();
          events.start(players, seat, profile);
        },
        action(action) { events.action(action, code === null ? 1 : 0); },
        failure(message, reason) {
          if (current !== attempt) return;
          attempt++;
          room = undefined;
          if (lobby && (reason === 'guest' || reason === 'service')) {
            if (reason === 'guest') joinIssue = message;
            events.status?.(navigator.onLine ? `${message} Reopening room ${lobby.code}…`
              : `Room ${lobby.code} will reopen when you’re back online.`);
            if (!document.hidden && navigator.onLine) {
              retryTimer = window.setTimeout(resume, Math.min(1000 * 2 ** retries, 15_000));
              retries++;
            }
            return;
          }
          if (code && reason === 'host' && navigator.onLine && Date.now() < retryUntil) {
            events.status?.(`Waiting for room ${code}. Your host may still be sharing the invite…`);
            retryTimer = window.setTimeout(() => connect(profile, code), 2500);
            return;
          }
          // The original window still owns the saved registration.
          if (reason === 'other-window') lobby = null;
          clearLobby();
          events.error(message, code);
        },
      }, lobby ?? undefined);
      if (current === attempt) room = connection;
      else connection.close();
    } catch {
      leave();
      events.error('This browser couldn’t start online play. Open the game in an up-to-date browser and try again.', code);
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && lobby) store.remember(lobby);
    else resume();
  }, options);
  document.addEventListener('freeze', suspend, options);
  document.addEventListener('resume', resume, options);
  window.addEventListener('pagehide', suspend, options);
  window.addEventListener('pageshow', resume, options);
  window.addEventListener('online', resume, options);
  window.addEventListener('offline', () => { suspend(); resume(); }, options);

  return {
    host(profile: Profile) { leave(); connect(profile, null); },
    join(profile: Profile, input: string) {
      const code = input.trim().toUpperCase();
      if (!isRoomCode(code)) { events.error('Enter the five-character code from your friend.', code); return; }
      leave();
      retryUntil = Date.now() + 25_000;
      connect(profile, code);
    },
    restore() {
      if (room || lobby || lifetime.signal.aborted) return false;
      lobby = store.read();
      if (!lobby) return false;
      events.opening?.(null, true);
      events.invite(lobby.code, 'Waiting for a friend to join…');
      resume();
      return true;
    },
    get active() { return Boolean(room || lobby); },
    send(action: Action) { return room?.send(action) ?? false; },
    leave,
    dispose() { lifetime.abort(); leave(); },
  };
}
