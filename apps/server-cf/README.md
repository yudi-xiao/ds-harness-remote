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

2. Review `vars` in [`wrangler.jsonc`](wrangler.jsonc): `DSH_SERVER_ACCOUNT` and `DSH_SERVER_PUBLIC_URL` must point at the real HTTPS origin (for example `https://remote.example.com`). This fork is already configured for the `shuohigh` / `https://remote-dsh.howlearnwood.com` deployment; replace both values when deploying your own account and domain.

3. Store the password as a secret (at least 12 characters, never commit it):

   ```bash
   cd apps/server-cf
   pnpm exec wrangler secret put DSH_SERVER_PASSWORD
   ```

4. Deploy (the package script is named `deploy`, which collides with pnpm's built-in command, so use `run`):

   ```bash
   pnpm --filter @dsh-remote/server-cf run deploy
   ```

   The first deployment creates the `RemoteGateway` Durable Object. Open `https://<your-domain>/` for the login page; Host and clients use the same address and the same account/password.

5. Attach the custom domain once, from **Workers & Pages → dsh-remote-server → Settings → Domains & Routes → Add custom domain**. The binding must live in the same Cloudflare account as the DNS zone. It persists across later deployments and is intentionally kept out of `wrangler.jsonc` `routes`, so `wrangler deploy --dry-run` in CI still works without Cloudflare credentials. Wait for the TLS certificate/DNS record to become active before pointing Hosts and clients at the origin.

6. Verify `GET /health` returns `{"status":"ok"}`, then open the login page.

## Deploy from GitHub (Workers Builds)

Production deploys for this fork are connected through Cloudflare Workers Builds: every push to `main` on [`yudi-xiao/ds-harness-remote`](https://github.com/yudi-xiao/ds-harness-remote) builds and deploys the `dsh-remote-server` Worker.

Configured production trigger (`main` only, repository root):

- Build command:

  ```bash
  pnpm install --frozen-lockfile && pnpm --filter @dsh-remote/protocol build && pnpm --filter @dsh-remote/server-cf assets
  ```

- Deploy command:

  ```bash
  pnpm --filter @dsh-remote/server-cf run deploy
  ```

- Build environment: `NODE_VERSION=22`, `PNPM_VERSION=9.15.4`, `SKIP_DEPENDENCY_INSTALL=1` (the explicit `pnpm install` replaces the automatic dependency step); build caching is enabled.
- `DSH_SERVER_ACCOUNT` and `DSH_SERVER_PUBLIC_URL` stay in `wrangler.jsonc`, so every build produces the correct origin. `DSH_SERVER_PASSWORD` is stored under **Worker → Settings → Variables and Secrets** and survives deployments; changing it invalidates every device token/session on the next request.
- The custom domain is bound once under **Settings → Domains & Routes** and survives later deployments.
- Connecting the repository needs the Cloudflare Workers & Pages GitHub App plus a one-time user-scoped API token with **Workers Builds Configuration: Edit** and **Workers Scripts: Read** for the Builds configuration API. Neither credential is stored in this repository.

Verified on 2026-10-18: the first manual build (`Node 22.23.3`, `pnpm 9.15.4`, 1188 packages, assets + `wrangler deploy`) succeeded, and `/health` plus login were re-checked against the custom domain afterwards. Every subsequent push to `main` runs the same trigger.

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

The same 40 assertions also passed against a real Cloudflare account and custom domain on 2026-10-18. The Worker was then deleted and redeployed from `wrangler.jsonc` to remove the E2E test devices; the clean instance re-verified `/health`, login and an empty device list. Real Desktop/Android cross-network acceptance is still pending.

## Differences and limitations vs `apps/server`

- **Relay only**: same as the Node self-hosted version, `hello.ack` reports `webrtcEnabled: false`; no WebRTC/TURN, OAuth, host registration codes, or full Remote Web session UI.
- **Password verifier**: Workers WebCrypto has no scrypt, so this implementation uses a random salt plus HMAC-SHA256. An existing Node `data/state.json` cannot be imported; devices must register again.
- **Password changes**: after changing `DSH_SERVER_PASSWORD` and redeploying, the DO detects the verifier change on its first request, clears device tokens/sessions and disconnects live sockets.
- **Web sessions** are persisted in DO SQLite (the Node version keeps them in process memory), so restarts/hibernation do not immediately log the page out.
- **Slow consumers**: Workers WebSockets have no `bufferedAmount`, so the Node version's buffered-amount disconnect is not reproduced; send failures are caught and clients recover by reconnecting.
- **Heartbeat**: the 25-second ping / 75-second timeout is driven by a DO alarm; pairing stage and relay counters are persisted in SQLite.
- **`online`** is derived from live WebSockets in the single DO, matching the Node version; no D1/R2/extra VPS is introduced.
