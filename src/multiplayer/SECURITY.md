# Multiplayer relay security

Boxes and Tic-Tac-Toe share a Cloudflare TURN relay for players whose devices cannot connect directly. Copying the public game code gives a fork the multiplayer implementation. To obtain credentials for our relay, each player still has to pass verification on an approved hostname and present a valid match ticket.

## What players see

PeerJS introduces the two browsers. They first try to exchange moves directly over WebRTC. Solo games, local games, and successful direct connections skip relay verification and use no TURN bandwidth.

If the other device answers but the direct connection fails, **both players** see **Verify to connect**. Cloudflare Turnstile checks each browser for signs of automation. It can finish automatically or ask the player to tick a checkbox. Players can choose **Cancel** to stop the connection attempt. No account, email, or password is required. Moves and rematches use the established connection. A reconnect that needs fresh relay credentials triggers a new check. [Game client](relay-admission.ts) · [Verification dialog](turnstile.ts) · [Turnstile widget modes](https://developers.cloudflare.com/turnstile/concepts/widget/)

## How a player gets relay access

1. **Claim a seat.** The host and guest establish separate sessions for a short-lived relay match. The guest proves possession of the random secret committed to when the match was created. Once both seats are claimed, each player can request a single-use ticket for their own seat. The room code, invite link, and QR code help players find each other. None grants relay access on its own.
2. **Verify the browser.** Each browser sends its ticket and Turnstile token to the shared JavaScript Worker, `public-games-turn`, which runs on Cloudflare. The Worker checks the request origin against its allowlist and validates the token directly with Cloudflare’s Siteverify service. It requires a successful result for the approved hostname, the `game_relay` action, and the expected hash of that match ID and seat session.
3. **Issue a credential.** A Cloudflare Durable Object checks the ticket’s seat and expiry, marks the verification proof as spent, consumes the ticket, and reserves one issuance in a single transaction. This prevents concurrent requests from redeeming the same proof or ticket twice. Only then does the Worker request a **one-hour TURN credential** for that browser. If verification fails or is unavailable, the Worker denies the credential. The browsers send relayed game traffic through Cloudflare TURN directly.

[Worker source](https://github.com/chrisawad/Tic-Tac-Toe/blob/main/turn-worker/worker.js) · [Ticket and quota enforcement](https://github.com/chrisawad/Tic-Tac-Toe/blob/main/turn-worker/admissions.js) · [Cloudflare token validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)

## What a public fork can access

The Worker URL and the Turnstile site key are public by design. The browser needs both. The long-lived TURN API credential and Turnstile verification secret stay in Cloudflare Worker secrets. Fork maintainers who want managed relay support should configure their own Worker URL, TURN key, and hostname-restricted Turnstile widget. Publishing changes to the shared Worker requires Cloudflare deployment access. Reading or forking either GitHub repository grants no such access. [Worker configuration and deployment](https://github.com/chrisawad/Tic-Tac-Toe#connect-cloudflare-turn)

A copy hosted on another domain cannot obtain a token for the approved hostname just by copying the URL and site key. The current games run on `chrisawad.github.io`. The hostname check covers that host, including other paths on it. Turnstile does not authenticate a particular Git commit or identify the person playing.

The ticket and proof protect **issuance**. Once issued, the temporary TURN credential can be reused by someone who obtains it until it expires or is revoked. One-hour expiry limits that exposure. [Cloudflare credential controls](https://developers.cloudflare.com/realtime/turn/generate-credentials/)

## Limits and billing

| Control | Shared Worker policy |
| --- | --- |
| Relay match creation | 6 per IP per minute, 120 total per minute |
| Relay setup window | 5 minutes |
| Match tickets | 4 per seat per relay match, each valid for up to 1 minute |
| TURN credential issuance | 12 per IP per minute, 120 total per rolling hour across both games |
| Issued TURN credential | 1 hour |

These limits count admissions. The Worker has **no per-game or account-wide bandwidth cutoff**. A valid credential can carry traffic throughout its lifetime, and Cloudflare meters the outbound bytes at the relay. Cloudflare currently includes 1,000 GB per month shared across Realtime TURN and SFU, then charges $0.05 per additional GB. Turnstile reduces unauthorized use, but neither verification nor the issuance limits guarantee a zero bill. [Realtime pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/) · [TURN usage analytics](https://developers.cloudflare.com/realtime/turn/analytics/)
