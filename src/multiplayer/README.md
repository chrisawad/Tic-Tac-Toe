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
- For copy, native share, and a QR code, call `createInviteControls({ code, link, qr, copy, share }, { title, text }, onCopied)` with your own DOM elements. Call the returned `show(code)` inside `invite`, `clear()` when the lobby closes, and `dispose()` when unmounting.
- The optional `opening(joinCode, restoring)`, `status(message)`, and `route(route)` callbacks drive your UI. Routes are `direct`, `relay`, or `unknown`. The module reads the selected ICE pair during gameplay.
- `session.leave()` closes the room and clears the waiting-room record. `session.dispose()` also removes page lifecycle listeners. Waiting hosts can recover after app switching or a network interruption. A disconnection during an active match ends the session.
- For games with rounds, `createRematchRule(advance)` counts one vote per seat for the current finished round. Supply a pure `advance(state)` that returns the same state while play is in progress, and fresh `[false, false]` votes for each new round. Send a `RematchRequest` with the round number and apply the rule for each player's vote.
- Optional `hello`, `acceptGuest`, and `acceptWelcome` hooks let a game negotiate player choices. Tic-Tac-Toe uses these hooks for color conflicts and compatibility with earlier installed versions.

## Share the relay

Pass the public HTTPS credential Worker URL in `rules.relayUrl` to enable managed TURN. The module requests temporary credentials when hosting or joining and retains them in memory. Without that setting it uses the transport's default ICE configuration. A temporary credential-service outage still allows direct play.

Games on the same GitHub Pages origin can use the same Worker. For games on different origins, configure the Worker's `GAME_ORIGINS` with a comma-separated list of exact origins, including the original game. The existing `GAME_ORIGIN` remains the default when the list is absent. Keep `TURN_KEY_ID` and `TURN_API_TOKEN` in the Worker’s secret settings.
