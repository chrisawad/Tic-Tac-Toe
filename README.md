# Tic Tac Toe

Play [Tic Tac Toe on GitHub Pages](https://chrisawad.github.io/Tic-Tac-Toe/).

- **AI Battle** — play T-3PO on Easy, Medium, or Hard. Hard uses minimax and plays an optimal game.
- **Local PvP** — pick names and colors and pass the screen between turns.
- **Play Online** — host a room and share its code, link, or QR invite. Rematches start when both players are ready.

On a rematch, players swap X and O while keeping their chosen colors and match scores. AI Battle and Local PvP save independently on the device and work offline after the first visit. Choose **Install app** for a standalone window or home-screen app.

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

Online rooms use PeerJS Cloud for signaling and WebRTC data channels for play. The browsers use public STUN servers to discover direct routes. A TURN server can carry moves when network conditions require a relay. Both players see the route selected for their game. Set `LIVE_ROOM_TEST=1` to include real two-browser tests, and set `PLAY_URL` to run the suite against an existing deployment.

## Connect Cloudflare TURN

To borrow the complete multiplayer flow for another two-player game, follow the [multiplayer integration guide](src/multiplayer/README.md). The [counter test game](tests/fixtures/counter.ts) uses the same public API with its own profiles and actions.

1. To deploy `public-games-turn` directly, run `pnpm dlx wrangler@4 login` and then `pnpm dlx wrangler@4 deploy --config turn-worker/wrangler.jsonc` from the game repository. In Cloudflare, open **Workers & Pages → public-games-turn → Settings → Variables and Secrets**. Add the **TURN Token ID** as `TURN_KEY_ID` and the matching **API key** as `TURN_API_TOKEN`, both with type **Secret**, then select **Deploy**. You can also use the [GitHub-connected setup](https://deploy.workers.cloudflare.com/?url=https://github.com/chrisawad/Tic-Tac-Toe/tree/main/turn-worker).
2. Set the game repository’s Actions **variable** `TURN_WORKER_URL` to the Worker’s public HTTPS root URL, then run the Pages deployment. For a local build, set `VITE_TURN_WORKER_URL` to that URL and configure the Worker’s `GAME_ORIGIN` to allow your local origin.
3. Create or join an online room. The Worker issues two-hour credentials to each browser and limits requests per IP address. The game still tries direct connections if the Worker is unavailable. Cloudflare bills relay traffic according to its Realtime plan. The request limit applies to credential issuance and does not cap bandwidth. [Cloudflare TURN pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/)
