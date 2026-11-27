# Two-player browser multiplayer

Copy the entire `src/multiplayer/` directory into your web game and import from its `index.ts`. The module uses TypeScript, browser APIs, PeerJS for signaling, and WebRTC for reliable ordered game messages. It runs in an HTTPS browser page or on localhost.

```sh
pnpm add peerjs@1.5.5 qrcode@1.5.4
pnpm add -D @types/qrcode
```

## Connect a game

Define a unique `namespace`, a validator for your player profile, and a parser for your game actions. Give incompatible protocol versions separate namespaces. The namespace isolates signaling IDs, room locks, and the default waiting-room storage key, even when games share a site and TURN service.

```ts
import { createMultiplayer, type MultiplayerGame } from './multiplayer';

type Action = { kind: 'add'; points: number };
const rules: MultiplayerGame<string, Action> = {
  namespace: 'my-studio-counter-v1',
  isProfile: (value): value is string => typeof value === 'string',
  parseAction(value) {
    if (value && typeof value === 'object' && 'kind' in value && value.kind === 'add'
      && 'points' in value && value.points === 2) return { kind: 'add', points: 2 };
    return null;
  },
};

let total = 0;
const status = document.querySelector<HTMLElement>('#status')!;
const session = createMultiplayer(rules, {
  invite(code, message) { status.textContent = message + ' Room ' + code; },
  start(players, seat) { total = 0; status.textContent = 'Playing as ' + players[seat]; },
  action(action) { total += action.points; },
  error(message) { status.textContent = message; },
});

// From the host's button
session.host('Amy');
// On the other device, call session.join('Bea', code) with the invitation code.
// From either player's button, apply the local action after a successful send.
function addTwo() {
  if (session.send({ kind: 'add', points: 2 })) total += 2;
}
```

Both devices receive `start` with profiles in host/guest order. The host occupies seat `0`, the guest seat `1`. `action(action, sender)` receives only remote actions accepted by your parser. Each game checks legality against its own state, including turn, round and duplicate moves. Use JSON-serializable objects for messages. The transport reserves the `kind` values `hello`, `welcome`, `ping` and `leave`.

## Invites and room lifetime

- Use `inviteURL(code)` for a shareable URL and `readInviteCode(new URL(location.href))` on launch. A valid invite takes the player to your join screen. Otherwise call `session.restore()` to reopen a saved host lobby.
- For a forwarding domain that redirects to a fixed game URL, pass `code => inviteURL(code, publicGameUrl, 'fragment')` as the fourth argument of `createInviteControls`. Copy, Share, and QR then use the same `#room=` link. The destination accepts both fragment and query invites.
- For copy, native share, and a QR code, call `createInviteControls({ code, link, qr, copy, share }, { title, text }, onCopied)` with your own DOM elements. Call the returned `show(code)` inside `invite`, `clear()` when the lobby closes, and `dispose()` when unmounting.
- The optional `opening(joinCode, restoring)`, `status(message)`, and `route(route)` callbacks drive your UI. Routes are `direct`, `relay`, or `unknown`. The module reads the selected ICE pair during gameplay.
- `session.leave()` closes the room and clears the waiting-room record. `session.dispose()` also removes page lifecycle listeners. Waiting hosts can recover after app switching or a network interruption. A disconnection during an active match ends the session.
- For games with rounds, `createRematchRule(advance)` counts one vote per seat for the current finished round. Supply a pure `advance(state)` that returns the same state while play is in progress, and fresh `[false, false]` votes for each new round. Send a `RematchRequest` with the round number and apply the rule for each player's vote.
- Optional `hello`, `acceptGuest`, and `acceptWelcome` hooks let a game negotiate player choices. Tic-Tac-Toe uses these hooks for color conflicts and compatibility with earlier installed versions.

## Share the relay

Pass the public HTTPS credential Worker URL in `rules.relayUrl` to enable managed TURN. Direct connections use STUN. If the remote peer answers but ICE cannot open a data channel, both browsers use signaling to register a two-seat match with the Worker. Each browser redeems its own single-use ticket, keeps its temporary TURN credentials in memory and applies them to that connection. Reconnecting to an occupied seat also requires the saved guest's proof. Direct play continues if the Worker is unavailable. Without a configured Worker, the module uses the transport's default ICE configuration.

Games on the same GitHub Pages origin can use the same Worker. For games on different origins, configure the Worker's `GAME_ORIGINS` with a comma-separated list of exact origins, including the original game. The existing `GAME_ORIGIN` remains the default when the list is absent. Keep `TURN_KEY_ID` and `TURN_API_TOKEN` in the Worker’s secret settings. Deploy the versioned admission routes in Tic-Tac-Toe’s `turn-worker/`. The old unauthenticated credential route must be disabled at the Worker. Anonymous clients can still form matches, so apply server-side issuance limits and monitor TURN bandwidth.

## Public matchmaking and resumable matches

`createMultiplayer` keeps the existing Tic-Tac-Toe action protocol and five-character invites. Games that need public matchmaking or active-match recovery can use `createAuthoritativeMultiplayer`. In this mode the host checks moves and sends both players the resulting state. Use a separate versioned namespace when migrating a game to this protocol. Existing rooms can finish using their original client.

The following game gives each player one turn to add a point. It uses a six-character invite and a single public queue.

```ts
import { createAuthoritativeMultiplayer, createRoomCodes, createRoomPersistence } from './multiplayer';

type Profile = { name: string };
type State = { points: number };
const store = createRoomPersistence<Profile, null>({
  namespace: 'my-studio-two-turns-v1',
  codes: createRoomCodes(6),
  isProfile: (p): p is Profile => !!p && typeof p === 'object' && 'name' in p && typeof p.name === 'string',
  isSettings: (settings): settings is null => settings === null,
});
const rooms = createAuthoritativeMultiplayer<Profile, null, State, number>({
  store,
  queueKey: () => 'standard',
  settings: () => null,
  initial: () => ({ points: 0 }),
  isState: (s): s is State => !!s && typeof s === 'object' && 'points' in s &&
    typeof s.points === 'number' && Number.isInteger(s.points) && s.points >= 0 && s.points <= 2,
  isMove: (move): move is number => move === 1,
  apply: (s, move, seat) => s.points < 2 && seat === (s.points === 0 ? 'Player1' : 'Player2')
    ? { points: s.points + move } : s,
  revision: s => s.points,
  finished: s => s.points === 2,
});

const session = await rooms.enter('public', { name: 'Amy' }, null);
session.watch(view => console.log(view.room.code, view.room.state, view.route));
// In response to the player's controls:
// session.move(1);
// session.rematch();
// await session.leave();
```

- Use `enter('create', profile, settings)` for a private host, `enter('join', profile, settings, code)` for a guest, and `enter('public', profile, settings)` to find or host a public match. The host determines settings for invited players. For multiple queues, return a stable PeerJS-ID-safe string from `queueKey` for each group of compatible settings. Each operation accepts a final progress callback after the code.
- On launch, use `store.readMatch()` to find the current tab’s room or the most recently saved active match on this device. When opening an invite, pass its code to `store.readMatch(code)` and `enter('restore', profile, settings, code)` so a different invitation opens normally. Joining by code also reuses a matching seat. A saved board opens offline and reconnects automatically. Both players must be connected to make a move.
- Browsers with Web Locks can recover a match in a new window on the same origin and browser profile. Each seat has one owner. A frozen window releases its connection and lock, and a hidden window can hand its seat to a returning player. Other browsers retain same-tab recovery. An installed app can also reopen its unoccupied waiting host lobby for two hours via `store.waitingHost.read()`. `stop()` preserves a match for recovery. Explicit `leave()` clears that seat and informs a connected opponent.
- `apply` must be pure, returning its input for an illegal move and a fresh state for an accepted one. `revision` must change after each accepted move. Guests send their round and revision with each move. Snapshots, moves, settings, and profiles must be JSON-serializable and fit into the 40,000-character message limit. The module adds a `connected` field to each player profile. `acceptGuest` can resolve choices such as conflicting player colors.
- Each seat can vote once on a finished round. `view.room.rematchVotes` stores votes in host/guest order. The host starts the next round after both votes. Supply `advanceRound(previous)` to carry scores or alternate starting players. The default creates a fresh state with the same settings. In an existing compatible older room, `rematchRequester` identifies the designated seat when vote negotiation is unavailable.
- Supply `relayUrl` and optional signaling `peerOptions` to the game adapter. The module reads neither environment variables nor another game's files. Use `createRoomFeedback(store.codes.length).roomFailure(error, operation)` for player-facing error text.
