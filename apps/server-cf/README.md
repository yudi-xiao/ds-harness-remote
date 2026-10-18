# Self-hosted Server on Cloudflare Workers

**English** · [中文](README.zh.md)

`apps/server-cf` is a Cloudflare Workers + Durable Objects port of [`apps/server`](../server/README.md): a single-account Remote relay with a Web login/device-status page. Existing Host plugins, Android and VS Code clients connect to the custom HTTPS server without changes.

This package does not host DeepSeek Harness itself and does not modify the model. Both the Host and clients dial out to Cloudflare, so no public IP or inbound port is required at home.

## Architecture

| Component | Responsibility |
| --- | --- |
| Worker (`src/index.ts`) | HTTPS entry point, same-origin checks, `/api/v1/*` and `/ws/v1/connect` routing, health checks, Workers Assets |
| One Durable Object (`src/gateway.ts` + `src/store.ts`) | Account sessions, device credentials, Control WebSocket, connection pairing, Noise handshake forwarding, opaque relay, rate limits |
| DO SQLite | `meta`/`devices`/`tokens`/`sessions`/`links`; only token digests and public identities are persisted |
| Workers Assets | Reuses the built login/device UI from `apps/server/web` |

The Durable Object uses the WebSocket Hibernation API: device identity lives in the socket attachment and pairing state lives in SQLite. A 25-second application-level ping is driven by a DO alarm, so the object does not need to stay resident in memory.

## Deploy

Requirements: Node.js 22, pnpm 9.15.4, a Cloudflare account (SQLite-backed Durable Objects can be created on both Free and Paid plans; see [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) for current quota).

1. Install dependencies and build the protocol package and Web UI:

   ```bash
   pnpm install
   pnpm --filter @dsh-remote/protocol build
   pnpm --filter @dsh-remote/server-cf assets
   ```

2. Edit `vars` in [`wrangler.jsonc`](wrangler.jsonc): `DSH_SERVER_ACCOUNT` and `DSH_SERVER_PUBLIC_URL` must point at the real HTTPS origin (for example `https://remote.example.com`).

3. Store the password as a secret (at least 12 characters, never commit it):

   ```bash
   cd apps/server-cf
   pnpm exec wrangler secret put DSH_SERVER_PASSWORD
   ```

4. Deploy:

   ```bash
   pnpm --filter @dsh-remote/server-cf deploy
   ```

   The first deployment creates the `RemoteGateway` Durable Object. Open `https://<your-domain>/` for the login page; Host and clients use the same address and the same account/password.

5. Verify `GET /health` returns `{"status":"ok"}`.

## Local development and verification

```bash
cp apps/server-cf/.dev.vars.example apps/server-cf/.dev.vars   # fill account/password/local URL
pnpm --filter @dsh-remote/server-cf assets                      # build Web UI into apps/server/dist/public
pnpm --filter @dsh-remote/server-cf dev                         # http://127.0.0.1:8787 by default
node apps/server-cf/scripts/e2e-local.mjs                       # needs DSH_CF_ACCOUNT / DSH_CF_PASSWORD
```

Static checks:

```bash
pnpm --filter @dsh-remote/server-cf check
pnpm --filter @dsh-remote/server-cf build     # wrangler deploy --dry-run
```

Local verification on 2026-10-18 (wrangler 4.151.1 / Node 24.21.0): `wrangler deploy --dry-run` bundled successfully, and all 40 assertions of `e2e-local.mjs` passed against `wrangler dev`, covering REST account/device credentials, cookies, device list/presence, hello/hello.ack, connection lifecycle, Noise IK handshake forwarding, bidirectional encrypted relay, replay rejection, and immediate disconnect plus token-family revocation. In addition, 3 integration tests passed under `vitest` (@cloudflare/vitest-pool-workers 0.23.0 + vitest 4.1.12), and DO SQLite kept account sessions, device tokens and refresh tokens across a `wrangler dev` restart (see [docs/cf-testing.md](docs/cf-testing.md)).

## Differences and limitations vs `apps/server`

- **Relay only**: same as the Node self-hosted version, `hello.ack` reports `webrtcEnabled: false`; no WebRTC/TURN, OAuth, host registration codes, or full Remote Web session UI.
- **Password verifier**: Workers WebCrypto has no scrypt, so this implementation uses a random salt plus HMAC-SHA256. An existing Node `data/state.json` cannot be imported; devices must register again.
- **Password changes**: after changing `DSH_SERVER_PASSWORD` and redeploying, the DO detects the verifier change on its first request, clears device tokens/sessions and disconnects live sockets.
- **Web sessions** are persisted in DO SQLite (the Node version keeps them in process memory), so restarts/hibernation do not immediately log the page out.
- **Slow consumers**: Workers WebSockets have no `bufferedAmount`, so the Node version's buffered-amount disconnect is not reproduced; send failures are caught and clients recover by reconnecting.
- **Heartbeat**: the 25-second ping / 75-second timeout is driven by a DO alarm; pairing stage and relay counters are persisted in SQLite.
- **`online`** is derived from live WebSockets in the single DO, matching the Node version; no D1/R2/extra VPS is introduced.
