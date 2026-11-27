# Tic Tac Toe

Play [Tic Tac Toe](https://tictactoe.chrisawad.com/).

- **AI Battle** — play T-3PO on Easy, Medium, or Hard. Hard uses minimax and plays an optimal game.
- **Local PvP** — pick names and colors and pass the screen between turns.
- **Play Online** — create a private room, join a five-character invite, or find a public 3×3 match. Both players vote for a rematch. The score carries over and the other player takes X.

On a rematch, players swap X and O while keeping their chosen colors and match scores. AI Battle and Local PvP save independently on the device and work offline after the first visit. Choose **Install** to open the installation dialog.

## Run locally

With Node 24 and pnpm 11.25.0:

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

Use `pnpm preview` to run the production build, including the service worker. The build uses Vite, TypeScript, Tailwind CSS, and Vite PWA. GitHub Actions tests and deploys `dist/` to Pages on pushes to `main`. The same directory can be served from any HTTPS static host. Set `BASE_PATH` to the published subpath if it differs from the default relative base.

Online rooms use PeerJS Cloud for signaling and WebRTC data channels for play. The browsers use public STUN servers to discover direct routes. A TURN server can carry moves when network conditions require a relay. Both players see the route selected for their game. A saved match reopens offline in the same browser profile. Moves resume when both seats reconnect. Guests can still join hosts running the original private-room protocol.

The browser suite runs two players against a local signaling server and decodes the actual invite QR. Set `LIVE_ROOM_TEST=1` to exercise the public signaling service, or set `PLAY_URL` to test an existing deployment.

## Connect Cloudflare TURN

To borrow the complete multiplayer flow for another two-player game, follow the [multiplayer integration guide](src/multiplayer/README.md). The [counter test game](tests/fixtures/counter.ts) uses the same public API with its own profiles and actions.

1. To deploy `public-games-turn` directly, run `pnpm dlx wrangler@4 login` and then `pnpm dlx wrangler@4 deploy --config turn-worker/wrangler.jsonc --keep-vars` from the game repository. The configuration includes the SQLite Durable Object migration for `ADMISSIONS` and the existing `CREDENTIAL_REQUESTS` rate limiter. For a new deployment, add the **TURN Token ID** as `TURN_KEY_ID` and its matching **API key** as `TURN_API_TOKEN` in **Workers & Pages → public-games-turn → Settings → Variables and Secrets**. Set both as **Secret**. You can also use the [GitHub-connected setup](https://deploy.workers.cloudflare.com/?url=https://github.com/chrisawad/Tic-Tac-Toe/tree/main/turn-worker).
2. Set the game repository’s Actions **variable** `TURN_WORKER_URL` to the Worker’s public HTTPS root URL, then run the Pages deployment. For a local build, set `VITE_TURN_WORKER_URL` to that URL and configure the Worker’s `GAME_ORIGIN` to allow your local origin.
3. Create or join an online room. A direct connection makes zero Worker requests. When a remote peer answers but the direct data channel fails, the browsers exchange a guest commitment and match ID through signaling. Each browser keeps its own session and redeems a separate ticket for two-hour TURN credentials. Older clients can still play directly and need an update to use this relay.

### Relay admission protocol

The shared Worker accepts JSON POSTs from the configured game origins. It returns `404` for the old root POST. The match identifier is separate from the game's public invite code.

| Route | Request | Success |
| --- | --- | --- |
| `/v1/matches` | `game, hostPeer, guestPeer, guestCommitment` | `match, session` for the host |
| `/v1/join` | `match, secret` | `session` for the guest, stable on retry |
| `/v1/ticket` | `match, session` | `ticket` once both seats are claimed, or HTTP 409 while waiting |
| `/v1/credentials` | `match, session, ticket` | `iceServers` |

The commitment is the lowercase hex SHA-256 digest of the guest's random UUID. Matches last five minutes. Each seat can obtain up to four tickets per match. A ticket expires after one minute or when its match expires, whichever comes first. Redemption consumes the ticket and reserves one issuance in a single storage transaction before calling Cloudflare. An interrupted upstream request requires a fresh ticket. Alarms remove expired records even when the service goes idle.

The shared coordinator limits match creation to 6 per IP and 120 total per minute. Credential issuance is limited to 12 per IP per minute and 120 total per rolling hour across all games. The edge limiter also limits repeated attempts. These quotas bound credential issuance by anonymous pairs. Cloudflare meters the bandwidth those credentials use separately. [Cloudflare TURN pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/)
