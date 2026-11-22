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

Online rooms use PeerJS Cloud for signaling and WebRTC data channels for play. Chrome and other browsers can use Google's and Cloudflare's public STUN servers to discover direct routes. If Wi-Fi isolation or network filtering blocks those routes, play requires a reachable TURN relay. The game uses the library's default relay configuration. The app has no account service, and closing a room ends its session. Set `LIVE_ROOM_TEST=1` to include real two-browser tests, and set `PLAY_URL` to run the suite against an existing deployment.
