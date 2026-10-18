# Port contract: self-hosted `apps/server` → Cloudflare Workers/DO

Status: implementation reference for `apps/server-cf`. Source of truth is the current
Node self-host code in this repo (`apps/server/src/server.ts`, `store.ts`, `gateway.ts`,
`main.ts`, `tests/server.test.ts`) plus `docs/protocol.md` §6–13, §22–25,
`docs/plugin-integration.md`, `apps/server/README*.md`, `examples/mock-host/index.ts`,
`packages/protocol/src/index.ts`, and the real consumer `packages/plugin/src/server-api.ts`
/ `server-connection.ts`. Where code and prose differ, the code below is what ships in
v0.5.12 and therefore what the port must reproduce. A Cloudflare port may change storage
and runtime, **not** the wire contract.

Surface: single account, single process semantics, Relay-only (`transport.relay`).
No OAuth, no host registration codes, no browser-authorization exchange, no TURN, no
Remote Web session UI, no `/api/v1/turn/credentials`. Those routes must stay 404
`METHOD_NOT_FOUND` (the plugin treats that as "feature absent" and falls back).

---

## 1. REST endpoints (exact, as implemented)

Global (applies to **every** request before routing, including `/health` and static):

- `Origin` present and `!==` configured public origin → `403 AUTH_INVALID`.
- `Sec-Fetch-Site: cross-site` → `403 AUTH_INVALID`.
- Response headers on every response: `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`.
- Error body always `{"error":{"code","message","requestId","retryable"}}`:
  `message` is the code string (not a sentence), `requestId` is a fresh UUID,
  `retryable = status === 429 || status >= 500`. `429` also sets `Retry-After: 60`.
- JSON responses: `Content-Type: application/json; charset=utf-8`.
- `POST` bodies: `Content-Type` must start with `application/json` (case-insensitive)
  else `415 INVALID_MESSAGE`; streamed body capped at **16384 bytes** total →
  `413 FRAME_TOO_LARGE`; malformed JSON → `400 INVALID_MESSAGE`.
  (Only login/register/register-owned-role/refresh actually read a body; logout and
  DELETE ignore the body/content-type.)
- Zod validation errors map to `400 INVALID_MESSAGE`; unknown throws →
  `500 INTERNAL_ERROR`.
- Node server options: `requestTimeout: 15000`, `headersTimeout: 10000`.

### Auth helpers

- `accountAuth`: accepts `Authorization: Bearer <account session token>` **or** the
  `dsh_session` cookie. **Header presence wins**: any `Authorization` header that does
  not start with `Bearer ` disables the cookie fallback and yields
  `401 ACCOUNT_AUTH_REQUIRED`. Unknown/expired session → `401 ACCOUNT_AUTH_REQUIRED`.
- `deviceAuth`: requires `Authorization: Bearer <device access token>`; missing header →
  `401 AUTH_REQUIRED`; unknown token → `401 AUTH_INVALID`; expired →
  `401 TOKEN_EXPIRED`; revoked/unknown device → `403 DEVICE_REVOKED` / `404 DEVICE_NOT_FOUND`.

### Endpoint table

| Method | Path | Auth | Request | 200 response | Errors |
|---|---|---|---|---|---|
| GET | `/`, `/app`, `/app/login` | none | — | built `index.html` (text/html) | 404 `METHOD_NOT_FOUND` if asset missing |
| GET | `/assets/*`, `/icon.png`, `/brand-whale.webp`, `/landing-atmosphere.webp` | none | — | static file; `.js`→`text/javascript; charset=utf-8`, `.css`→`text/css; charset=utf-8`, `.png`, `.webp`, else html | 404 `METHOD_NOT_FOUND` |
| GET | `/health`, `/healthz`, `/ready` | none | — | `{"status":"ok"}` | — |
| POST | `/api/v1/auth/login` | none | `{email:1..254, password:1..1024}` strict | `{account, profile:{displayName:account}, isAdmin:false, token, expiresAt}` + `Set-Cookie` | 401 `AUTH_INVALID` bad creds; 403 `AUTH_INVALID` origin; 413 `FRAME_TOO_LARGE`; 415/400 `INVALID_MESSAGE`; 429 `RATE_LIMITED` (login rate or ≥256 live sessions) |
| GET | `/api/v1/auth/me` | account | — | `{account, profile:{displayName:account}, isAdmin:false}` | 401 `ACCOUNT_AUTH_REQUIRED` |
| POST | `/api/v1/auth/logout` | none (idempotent) | body ignored | `{"status":"ok"}` + expired `Set-Cookie` | — |
| GET | `/api/v1/account/devices` | account | — | `{items:[device descriptor + {membershipId, online, lastSeenAt}], serverUrl:<public origin>, transport:"relay"}` (non-revoked devices, both roles) | 401 `ACCOUNT_AUTH_REQUIRED`; 429 |
| POST | `/api/v1/devices/register` | account (Bearer account token or cookie) | `{"v":1,"device":descriptor}` strict | token pair (below) | 401 `ACCOUNT_AUTH_REQUIRED`/`AUTH_INVALID`; 403 `DEVICE_REVOKED`; 409 `PEER_IDENTITY_MISMATCH`; 429 `RATE_LIMITED` (device cap) |
| POST | `/api/v1/devices/register-owned-role` | device Bearer (account token does **not** fall back here) | `{"v":1,"device":descriptor}` strict | token pair | 401 `AUTH_REQUIRED`/`AUTH_INVALID`/`TOKEN_EXPIRED`; 403 `DEVICE_REVOKED`; 409 `INVALID_MESSAGE` if `source.deviceId` equals new id **or** `source.role` equals new role; 404 `DEVICE_NOT_FOUND`; 429 |
| POST | `/api/v1/auth/refresh` | none beyond refresh token | `{deviceId, refreshToken}` strict | token pair (new access+refresh) | 401 `AUTH_INVALID` (unknown/reused), `TOKEN_EXPIRED`; 403/404 device; 413/415/400 |
| DELETE | `/api/v1/devices/self` | device Bearer | — | `{"status":"revoked"}` | 401/403/404 |
| GET | `/api/v1/me` | device Bearer | — | full descriptor incl. `identityKey`, `membershipId`, `online`, `lastSeenAt` | 401/403/404 |
| GET | `/api/v1/devices` | device Bearer, role **must be `client`** | — | `{items:[host descriptor **without** identityKey + membershipId/online/lastSeenAt], nextCursor:null}` | 403 `MEMBERSHIP_REQUIRED` if caller is host; 401/404 |
| GET | `/api/v1/devices/{id}` | device Bearer, opposite role required | — | full descriptor incl. `identityKey` | 403 `MEMBERSHIP_REQUIRED` if same role; 404 `DEVICE_NOT_FOUND`; 403 `DEVICE_REVOKED` |
| GET | `/api/v1/devices/{id}/presence` | same as above | — | `{deviceId, online, lastSeenAt}` | same |
| any | anything else | — | — | — | 404 `METHOD_NOT_FOUND` (also for wrong method on known path) |

Token pair: `{accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt}`
(`deviceTokenPairSchema` is `.strict()` — extra fields break the plugin).

Descriptor rules (`packages/protocol/src/index.ts`): `deviceId` ULID or UUID
(`[1-8]...` UUID variant), `name` 1..128 UTF-8 bytes with visible text, `platform`
`^[a-z0-9][a-z0-9._-]*$` ≤64, `identityKey` canonical unpadded base64url 43 chars,
`clientVersion` 1..64 bytes, `harnessVersion` only on host, strict objects (no extras).

`membershipId` = `account:` + first 16 hex chars of `sha256(UTF-8 trimmed account)`.
`online` = live Control peer ("live peers in the same process/DO as the WS"), `lastSeenAt`
= last successful `hello` (initially `0`; not updated by REST).

Rate limiting (in-memory, per process, 60 s window): every non-static request after
`/health` counts against `api:<remoteAddress>` **240/min**; login additionally
`login:<remoteAddress>` **20/min**. Map capped at 4096 keys (new key while full →
`429 RATE_LIMITED`). `/health`, static routes, and the origin check are exempt from rate
limiting (origin check still applies). `Set-Cookie` (login): `dsh_session=<43 url-safe
chars>; Path=/; HttpOnly; SameSite=Strict; Max-Age=<seconds>[; Secure if public origin is
https]`. Logout sends the same cookie with empty value and `Max-Age=0`.

---

## 2. Account token lifecycle

- Password/account come from env (`DSH_SERVER_ACCOUNT`, `DSH_SERVER_PASSWORD`); account is
  `.trim()`ed; password must be ≥12 chars; public URL must be a bare HTTP(S) origin (no
  path/query/hash/userinfo) or startup fails.
- Login compares `email.trim()` and the supplied password against the configured values
  with timing-safe comparison of `sha256` digests (`equal(hash(a),hash(b))`).
- Sessions are **memory-only**: token = 32 random bytes base64url; store `sha256(token)`
  hex → `expiresAt`; TTL **8 h**; lazy prune on login; cap **256 live sessions**
  (≥ cap → `429 RATE_LIMITED`); logout removes the digest; restart → all web sessions gone
  (web must re-login).
- Same-token concurrency: sessions are not rotated or refreshed.
- Password change detection lives in the store: verifier = `scryptSync(password, salt, 32)`
  hex, `salt` = 32 random bytes base64url persisted in state. On startup the verifier is
  recomputed with the env password; if it differs, **all device tokens are deleted**
  (devices stay and remain registered); if the account string changed, **all devices are
  deleted** too. Node uses default scrypt params (N=16384, r=8, p=1, 32-byte key).
  Port implication: either reproduce Node scrypt exactly (so an existing `state.json`
  stays valid) or explicitly accept that CF uses a fresh salt/verifier and previously
  issued device tokens are invalidated on first boot.
- Account token is only accepted by `accountAuth` routes; device tokens never
  authenticate account routes (`401 ACCOUNT_AUTH_REQUIRED`) and account tokens never
  authenticate device routes (`401 AUTH_INVALID`).

## 3. Device credential lifecycle

Persisted state (Node JSON file, atomic tmp+rename, dir 0700/file 0600; only token
**digests** and public identities are stored):

- `devices: { [deviceId]: { descriptor, revoked, lastSeenAt } }`
- `tokens: { [sha256(token) hex]: { kind: 'access'|'refresh', deviceId, expires, used } }`

Issue (`Store.issue`): prune expired token records, if total token records **≥ 16384** →
`429 RATE_LIMITED`; access TTL **1 h**; refresh TTL **30 d**. Returned as token pair.

- Register (`Store.register`):
  - existing record revoked → `403 DEVICE_REVOKED`;
  - existing record with different `identityKey` **or** `role` → `409 PEER_IDENTITY_MISMATCH`
    (identity pinning; `deviceId` cannot be re-pointed);
  - no existing record and `Object.keys(devices).length >= 256` → `429 RATE_LIMITED`
    (count includes revoked entries);
  - upsert descriptor, preserve previous `lastSeenAt`, then `invalidate(deviceId)` — this
    deletes all existing tokens for the device and immediately disconnects its live WS —
    then issue a brand-new pair. So re-register is idempotent in effect but **always
    rotates credentials and drops the current Control socket**;
  - `register-owned-role` inherits account from the calling device and only enforces
    distinct `deviceId` + opposite `role` (same checks otherwise).
- `authenticate(access)`: digest lookup; not found or not kind `access` →
  `401 AUTH_INVALID`; expired → `401 TOKEN_EXPIRED`; then device lookup
  (`404 DEVICE_NOT_FOUND` / `403 DEVICE_REVOKED`).
- `refresh(deviceId, refreshToken)`: device lookup first; token must exist, be kind
  `refresh`, and belong to `deviceId` else `401 AUTH_INVALID`; expired →
  `401 TOKEN_EXPIRED`; already `used` → **token-family reuse detection**:
  `invalidate(deviceId)` (all tokens gone + live WS disconnected) and `401 AUTH_INVALID`;
  otherwise mark used and issue a new pair **keeping the original refresh expiry**
  (`refreshTokenExpiresAt` does not slide on rotation).
- `revoke(deviceId)`: `get` (404/403) then `revoked = true`, `invalidate` → all tokens
  deleted and `onInvalidate` → gateway disconnects that device's socket (close 4001,
  reason code) and tears down its links with scoped `error` frames to counterparts.
  Revoke takes effect immediately, including for an existing WS.
- `lastSeenAt` / `touch`: called only on successful `hello`; sets `lastSeenAt = Date.now()`;
  updates `clientVersion` (both roles, sliced to 64 chars) and, for host only,
  `harnessVersion` (sliced to 64). REST never touches it. `GET /api/v1/me` and
  `/devices/{id}` return it, presence uses `online` + `lastSeenAt`.
- `list()` returns non-revoked devices only, in insertion order.

---

## 4. Control WebSocket contract

URL: `wss://<public-origin>/ws/v1/connect` (exact path). Clients derive it by swapping
`https→wss` and appending `/ws/v1/connect` to the base URL path, so base URL must be an
origin without path prefix.

Upgrade gate (HTTP 403, raw response, no WS): path not exactly `/ws/v1/connect`;
`Origin` header present and ≠ configured origin; current WS client count **≥ 256**.
`ws` server: `maxPayload = 1 MiB`, `perMessageDeflate: false`.

Envelope: `{"v":1,"id":<uuid or msg_...>,"type":<controlFrameType>,"timestamp":<ms>,"payload":{...}}`,
strict schema, text messages only. Non-hello binary → `INVALID_MESSAGE`.

Per-socket receive window: resets after ≥1000 ms; >**512 frames/s** or >**16 MiB/s**
(`16 * MAX_RELAY_FRAME_BYTES`) → `RATE_LIMITED`. Enforced before parse.

Per-message processing order (reproduce exactly):

1. binary → `INVALID_MESSAGE`;
2. rate window → `RATE_LIMITED`;
3. `JSON.parse` → `INVALID_MESSAGE`;
4. `envelope.v !== 1` (when present and object) → `UNSUPPORTED_VERSION`;
5. `decodeControlFrame` (strict frame + payload schemas; per-type size limit:
   control **64 KiB** = `MAX_CONTROL_FRAME_BYTES`, relay **1 MiB** =
   `MAX_RELAY_FRAME_BYTES`) → any failure `INVALID_MESSAGE`;
6. before hello: frame must be `hello`, else `AUTH_REQUIRED`;
7. hello validation order: `store.authenticate(accessToken)` (device token only, never an
   account token), then `device.deviceId === payload.deviceId` **and**
   `device.role === payload.role` else `AUTH_INVALID`, then `protocols.includes(1)` else
   `UNSUPPORTED_VERSION`;
8. replacement: `disconnect(deviceId, 'CONNECTION_REPLACED')` **before** registering the
   new peer — the old same-device socket is closed with **4003**, its links dropped, and
   counterparts get scoped `error` frames (`CONNECTION_REPLACED`, retryable true);
9. register peer: `{ws, id: deviceId, role, capabilities: hello.capabilities,
   version: hello.clientVersion ?? descriptor.clientVersion, lastPong: now}`; clear the
   **5 s hello deadline** (deadline expiry `terminate()`s the socket with no close frame);
10. `store.touch(deviceId, hello.clientVersion, hello.harnessVersion)`;
11. send `hello.ack`.

`hello` is optional-field tolerant: `clientVersion` and `harnessVersion` absent is fine;
`protocols` must be a non-empty unique safe-int array, `capabilities` unique strings.

Self-host `hello.ack` payload (exact keystrokes; do not add fields):

```json
{
  "protocol": 1,
  "serverVersion": "self-hosted/0.1.0",
  "connectionSessionId": "<fresh UUID>",
  "heartbeatIntervalMs": 25000,
  "maxControlFrameBytes": 65536,
  "maxRelayFrameBytes": 1048576,
  "capabilities": ["transport.relay"],
  "webrtcEnabled": false,
  "webrtcFallbackTimeoutMs": 1
}
```

`capabilities` = `["transport.relay"]` **iff** the hello declared `transport.relay`, else
`[]`. `webrtcFallbackTimeoutMs: 1` is intentional (server is Relay-only); the plugin takes
`max(local 12000, ack value)`, so it does not truncate WebRTC negotiation, and
`webrtcEnabled:false` forces relay. Real plugin requires at least one negotiated transport
capability or it throws `INVALID_MESSAGE`, so any hello without `transport.relay` will
fail client-side (same as Node today).

After hello, each inbound frame re-checks: peer still current in the map (else
`AUTH_INVALID`), `store.get(peer.id)` (revoked → `DEVICE_REVOKED`), then dispatch.

### Error handling / close codes

- Generic failure: send `error` frame `{code, message:code, retryable:false}` (no
  `connectionId`), then `disconnect()`: close with **4001** (code `CONNECTION_REPLACED`
  would be 4003, but that path is used only for replacement), reason = code; force
  `terminate()` after 1 s. If no peer yet (failed hello), same close 4001 + terminate 1 s.
- Connection-scoped failure: the offending frame's payload has a string `connectionId`
  that maps to an existing link containing this peer and the error is not `RATE_LIMITED`:
  either drop that link (notify both sides with `error` + `connectionId`, retryable true)
  or send `error` `{code, message:code, connectionId, retryable:false}` to this peer only.
  **The Control socket stays open** — this is how one client's tunnel failure doesn't kill
  the Host's other clients. `RATE_LIMITED` always terminates the socket.
- Frames sent through `send()` while `bufferedAmount > 4 MiB` → disconnect
  `SLOW_CONSUMER` (close 4001). No equivalent sync backpressure on Workers; approximate
  and keep the code name.
- Close-code map the plugin actually consumes (`server-connection.ts`): 4002→`AUTH_INVALID`,
  4003→`CONNECTION_REPLACED` (terminal, stops auto-reconnect), 4004→`DEVICE_REVOKED`,
  4007→`RATE_LIMITED`, 4011→`UNSUPPORTED_VERSION`, everything else→`CONNECTION_FAILED`
  (retryable). The self-host server only ever sends **4001 or 4003**; keep that exact
  behavior instead of "upgrading" to 4002/4004, otherwise client retry/refresh behavior
  changes. Revocation via REST closes the revoked device's socket with 4001 + reason
  `AUTH_INVALID` and does not send it an error frame; plugin then reconnects and gets an
  `error` frame + 4001 on the failed hello.
- On socket close, if the peer is still mapped under the same id, call
  `disconnect(id, 'CONNECTION_FAILED')` (drops links, notifies counterparts).

### Connection lifecycle (relay)

Link: `{id: uuid, host, client, stage: 'pending'|'accepted'|'handshake'|'ready',
created, counters: Map<senderDeviceId, lastCounter>}`.

1. `connect.request` from a **client** only (host → `MEMBERSHIP_REQUIRED`).
   `hostDeviceId` must be an online peer with role host, else direct `error`
   `{code:'HOST_OFFLINE', message:'Host is offline.', retryable:true}` (no disconnect);
   host device must still exist in store. Required: `preferredTransports` includes
   `relay` **and** both peers advertised `transport.relay` in hello, else
   `CAPABILITY_NOT_SUPPORTED`. Then drop old links where `old.client === peer.id` or
   (`old.host === host.id` and host is **not** modern) with `CONNECTION_REPLACED`; links
   map capped at **256** (`RATE_LIMITED`); create link (`randomUUID`), stage `pending`.
2. Server → host `connect.incoming`
   `{connectionId, clientDeviceId, clientIdentityKey:<from store>, authorization:"account",
   preferredTransports:["relay"]}` (always exactly `["relay"]`, not the request list).
3. Host replies `connect.accepted` (stage → `accepted`, forwarded to client) or
   `connect.rejected` (link deleted, forwarded). Only the host may reply, only in
   `pending`.
4. Client sends `transport.selected` `{connectionId, targetDeviceId: hostDeviceId,
   transport:"relay"}`; only `relay` accepted (`CAPABILITY_NOT_SUPPORTED`); forwarded to
   the host **only if the host is modern** (`modernHost`, below), otherwise swallowed.
   `signal.*` frames are silently ignored (relay-only).
5. `secure.handshake` step **1** from client in `accepted` → stage `handshake`; step **2**
   from host in `handshake` → stage `ready`; else `INVALID_MESSAGE`. Forwarded to the
   counterpart. Server never parses Noise data.
6. `relay` allowed only in `ready`; `counter` must be strictly greater than the previous
   counter **for that sender in that link** (per-direction independent map, initial −1)
   else `INVALID_MESSAGE`; ciphertext forwarded unchanged, never logged/stored/parsed.
7. Any other frame for a link → `INVALID_MESSAGE`.

Shared checks for all post-`connect.request` frames: `payload.connectionId` must map to a
link and this peer must be its host or client (`CONNECTION_NOT_FOUND`); the counterpart
must be online and still in the store (`CONNECTION_FAILED` / revoked errors);
`payload.targetDeviceId` must equal the counterpart (`CONNECTION_NOT_FOUND`); stage must
not be `pending` (`CONNECTION_NOT_FOUND`). Only `pending` accepts `connect.accepted` /
`connect.rejected` (host only).

Heartbeat (every **25 s**): for each peer, if `now - lastPong > 75_000` → disconnect
`CONNECTION_FAILED`; else generate a fresh nonce and send `ping {nonce}`. Client `pong`
with the matching nonce refreshes `lastPong` and clears the nonce; unmatched `pong` is
ignored. Inbound `ping` from a client is answered with `pong {nonce}` (Hooks/plugin do
this too; mock-host relies on it). Links not `ready` after **30 s** are dropped with
`CONNECTION_FAILED` (scoped `error` with `connectionId` to the client and to modern hosts;
link deleted, sockets stay).

`modernHost(version)` = regex `^v?(\d+)\.(\d+)\.(\d+)(?:\+.*)?$` and version ≥ **0.2.15**.
It gates: forwarding `transport.selected` to that host, delivering scoped link errors to
that host, and allowing a host to fan-in multiple clients (legacy hosts replace their old
link on every new `connect.request`). Version used is `hello.clientVersion` else the
stored descriptor version.

---

## 5. What real clients depend on

Canonical consumer is `packages/plugin/src/server-api.ts` (Host and Client constructors);
Android/VS Code/browser use the same REST/WS subset through their own clients and
`docs/plugin-integration.md` §1–11.

- Base URL: normalized bare `https` origin (default hosted `https://d.r2049.cn`); REST at
  `{base}/api/v1/...`, WS at `wss://{host}/ws/v1/connect`. Login, register, refresh, and
  WS must be same-origin; switching server must not reuse credentials/identity.
- Login expects: `token` string ≥16 chars, integer `expiresAt`, non-empty `account`
  ≤254, boolean `isAdmin`; then register (`/devices/register`, Bearer account token) and
  parse the token pair strictly (`deviceTokenPairSchema`, `.strict()`).
- Client role (Desktop Client, browser launcher, Android as member device) previously
  registers with an account token too; owned-role registration is used by the same
  plugin install to obtain the opposite role from an existing **device** access token.
- Refresh: plugin refreshes 30 s before expiry under a cross-process directory lock; on
  `TOKEN_EXPIRED` refresh-and-retry once; on `AUTH_INVALID`/`DEVICE_REVOKED` stop and
  clear credentials. Reuse detection must revoke the family.
- List/pin: `GET /api/v1/devices` items must have `role:"host"`, non-empty `membershipId`;
  `GET /api/v1/devices/{hostId}` must include role, name, platform, canonical
  `identityKey`, `membershipId`, `online`, `lastSeenAt` — the Host and Client pin
  `identityKey` per `deviceId` from it. Host also uses it to validate `connect.incoming`.
- `GET /api/v1/me`, `DELETE /api/v1/devices/self`, presence are used by the plugin
  (`deviceFor`, `presenceFor`, `revokeCurrentDevice`).
- WS: plugin sends `hello` immediately on open and has its own **10 s** hello timer;
  rejects any frame before `hello.ack`; validates ack's protocol/serverVersion/
  connectionSessionId/integers; applies `maxControlFrameBytes`/`maxRelayFrameBytes`;
  requires ≥1 negotiated transport capability; sends `pong` for every `ping`; treats
  `error` frames with `connectionId` as tunnel-only (drop that tunnel, keep socket);
  `error` frame `DEVICE_REVOKED` closes its own socket with 4004; 4003 stops reconnect.
- Byte-compatible items: status codes + `error.code` strings, cookie name/flags,
  `membershipId` format, `serverVersion` value, hello.ack field set, 4001/4003 close
  codes, `Retry-After: 60`, and strict JSON schemas (no extra fields).
- Out of self-host scope (must 404, not fake success): OAuth (`/auth/oauth/*`),
  `/devices/register-with-code`, browser authorization exchange, `/api/v1/turn/*`,
  account device rename `PATCH /api/v1/account/devices/{id}` (Android tolerates 404 and
  keeps the edited name for retry), and any Remote Web session UI.

---

## 6. Cloudflare port gotchas

- **Origin header**: Node `ws` clients and Node/Android fetch may omit `Origin`; the
  self-host server accepts a missing Origin and rejects only a **mismatched** one. The CF
  port must keep "absent → allowed, present → must equal configured PUBLIC origin".
  Cloudflare adds `CF-Connecting-IP` etc., not Origin; do not start requiring Origin.
- **Configured public origin**: derive origin checks, `Set-Cookie Secure`, `serverUrl`
  (in `/account/devices`) and join URLs from a configured `PUBLIC_URL` (env), not from
  `request.url` — behind a proxy/Workers the request host can differ. The Node server
  validates it is a bare origin at startup; mirror that validation.
- **WebSocket upgrade**: Workers must route `Upgrade: websocket` to a DO and return a
  101; failures (wrong path/origin/cap) should be a plain 403 Response (clients then
  surface `CONNECTION_FAILED`/retry, same as Node's 403). Do not accept the socket and
  close it later for these gates.
- **Same DO owns REST presence + all WS peers**: `online` is computed from the live peer
  map. If REST runs in a different isolate/DO than the WebSockets, `/devices/{id}`,
  `/presence`, `/account/devices` online flags will be wrong. Route all account REST and
  all Control WS for the (single) account through the same DO, or replicate presence into
  shared storage with identical read-your-write semantics.
- **Rate-limit key**: Node keys on `socket.remoteAddress`. Workers have no socket; use
  `CF-Connecting-IP` (fall back to a constant) and accept that the 240/min and 20/min
  windows become per-DO/edge approximations rather than global per-process counters.
- **Cookie + Bearer coexistence**: `Authorization` header presence suppresses the cookie
  fallback (`dsh_session` regex `[A-Za-z0-9_-]+`). Preserve this; browsers send the cookie
  on same-origin fetches; plugins send Bearer.
- **Body cap**: enforce 16384 bytes by reading the request stream and cancelling, like
  Node; `arrayBuffer()` alone still works but must reject over-cap before JSON parse and
  must check content-type first.
- **`/health` before rate limit, static before health**: keep the routing order
  (origin → static → health → rate limit → API) so health checks and pages never consume
  rate-limit budget; static `404` must produce the JSON error envelope, not HTML.
- **SPA fallback**: Node serves `index.html` only for `/`, `/app`, `/app/login`; any other
  path (e.g. `/app/remote` on a cold load) is a 404. Workers Assets SPA fallback would
  change behavior — disable `not_found_handling: single-page-application` or replicate the
  exact three routes.
- **Static assets + headers**: every response carries the security headers, including
  assets and health. Workers Assets responses bypass the fetch handler unless routed
  through it; add the headers (or use `_headers` equivalent) so `/assets/*` matches Node.
- **Heartbeat/deadlines under hibernation**: the 5 s hello deadline, 25 s ping, 75 s
  pong timeout, 30 s pending-link timeout and 1 s terminate-after-close all need
  alarms/setTimeout semantics. If the DO can hibernate with unacknowledged sockets, they
  will be lost; keep the DO awake until hello (and long enough to run timers) or drive
  them from `alarm()` with per-peer deadlines persisted. Node `terminate()` has no
  Workers equivalent — close + bounded grace is acceptable, but do not leave half-open
  peers counted against the 256 cap.
- **Backpressure**: no `bufferedAmount` on Workers WebSockets; `send()` does not throw for
  slow peers. Keep the `SLOW_CONSUMER` behavior only as best-effort (bounded queue →
  close 4001 `SLOW_CONSUMER`); never silently buffer unbounded relay frames.
- **Close codes/reasons**: browsers/ws clients accept 4001/4003; reason length ≤123
  bytes. Confirm workerd forwards application close codes (cf-runtime doc) before relying
  on 4003 stopping client auto-reconnect.
- **REST ↔ WS revocation**: `invalidate()` must synchronously disconnect the DO's live
  socket (and notify link counterparts) before the REST response returns; the plugin
  treats `DELETE /devices/self` + immediate close as the contract.
- **`127.0.0.1` vs public URL**: local `wrangler dev`/Miniflare origin differs from the
  configured PUBLIC_URL; tests and local UIs must send no Origin (native clients) or set
  PUBLIC_URL to the exact origin. Cross-origin browser fetches must be rejected as today.
- **Crypto**: token = 32 random bytes base64url (43 chars, no padding); `sha256` hex for
  token digests, account hash and `membershipId`; `randomUUID()` for frame ids,
  connection ids, connectionSessionId and `requestId`. WebCrypto outputs match Node;
  scrypt does not — see §2.
- **Persistence / single writer**: Node state is one JSON snapshot rewritten atomically on
  every mutation. A single DO is the natural single-writer equivalent; await storage
  writes before replying so token rotation/reuse detection is durable and
  read-your-write, and don't hold plaintext tokens in storage.
- **Limits**: 256 WS sockets, 256 devices (revoked included), 16384 token records, 256
  live account sessions, 256 active links — all per single account/process; preserve the
  numbers and the error codes (`RATE_LIMITED`).

---

## 7. Acceptance matrix

- [ ] `/health(z)`, `/ready` return `{"status":"ok"}` unauthenticated, no rate-limit cost.
- [ ] `/`, `/app`, `/app/login` serve index HTML; `/assets/*` correct content types;
      missing asset / other path → 404 JSON `METHOD_NOT_FOUND`; no SPA catch-all.
- [ ] Cross-origin `Origin` and `Sec-Fetch-Site: cross-site` → 403 `AUTH_INVALID` on
      REST and WS; absent Origin accepted (native clients).
- [ ] Security headers (`no-store`, `nosniff`, `no-referrer`, CSP) on every response.
- [ ] Login bad creds → 401 `AUTH_INVALID`; success sets HttpOnly SameSite=Strict cookie
      (Secure only on https), returns token/expiresAt/account/profile/isAdmin; `auth/me`
      works with Bearer and with cookie; logout invalidates both.
- [ ] JSON-only content type (415), 16 KiB body cap (413 `FRAME_TOO_LARGE`), malformed
      JSON (400), strict schemas (extra fields rejected).
- [ ] Account: 8 h TTL, 256-session cap, restart drops sessions.
- [ ] Password change invalidates all device tokens, keeps devices; account change wipes
      devices too (or CF documented equivalent).
- [ ] Register with account token; same deviceId+identity re-register rotates tokens and
      drops the old socket; identity/role change → 409 `PEER_IDENTITY_MISMATCH`; revoked
      → 403; 256-device cap → 429.
- [ ] register-owned-role: device Bearer accepted, account Bearer rejected; same
      deviceId/role → 409; opposite role gets a fresh pair.
- [ ] Refresh rotates; old access token dies; reused refresh token → 401 and revokes the
      whole family; refresh expiry does not slide.
- [ ] `GET /devices` (client only) lists hosts without `identityKey` and with
      `membershipId`/`online`/`lastSeenAt`; host caller → 403; same-role detail → 403;
      cross-account does not exist by construction.
- [ ] `membershipId` = `account:<sha256(account) first 16 hex>` identical for every
      device and stable across restart.
- [ ] `DELETE /devices/self` returns `{status:"revoked"}` and immediately closes that
      device's WS (close 4001) with scoped `error` frames to link counterparts.
- [ ] WS: wrong path/origin/257th socket → HTTP 403; hello required within 5 s; frames
      before hello.ack rejected; binary/oversized/unknown version/unknown type handled
      with the exact codes; account token in hello → `AUTH_INVALID`; role mismatch →
      `AUTH_INVALID`; protocols without 1 → `UNSUPPORTED_VERSION`.
- [ ] `hello.ack` byte-shape above (`self-hosted/0.1.0`, `connectionSessionId`,
      25000/65536/1048576, `["transport.relay"]` iff declared, `webrtcEnabled:false`,
      `webrtcFallbackTimeoutMs:1`).
- [ ] Same-device reconnect closes old socket with 4003 `CONNECTION_REPLACED`; new socket
      stays usable; 4003 not used elsewhere.
- [ ] `connect.request` → `connect.incoming` (`["relay"]`, `identityKey` from store)
      → `accepted`/`rejected` → `transport.selected` (relay only; host forwarding gated by
      modernHost) → `secure.handshake` step 1 client → step 2 host → `ready`.
- [ ] Relay counter strictly increasing per sender; replay/out-of-order/replayed link
      errors are scoped to the link when `connectionId` is present; Control socket stays
      open; relay ciphertext forwarded unchanged and never logged.
- [ ] `HOST_OFFLINE` retryable error; `CAPABILITY_NOT_SUPPORTED` when either side lacks
      `transport.relay`; `MEMBERSHIP_REQUIRED` for host-originated connect; 256-link cap.
- [ ] Heartbeat: server ping every 25 s, pong echoes nonce, 75 s silence closes with
      `CONNECTION_FAILED`; 30 s pending-link timeout drops only the link.
- [ ] Rate limits: 240 API/min and 20 login/min per client key → 429 + `Retry-After: 60`;
      512 frames/s / 16 MiB/s WS window → `RATE_LIMITED` + close.
- [ ] Legacy-host compatibility: non-modern hosts get no `transport.selected`/scoped
      errors and are limited to one active client link (last-client-wins).
- [ ] Real plugin smoke (Host + Client on two identities): login → register →
      refresh-on-403/TOKEN_EXPIRED recovery → hello.ack → connect → Noise handshake →
      encrypted relay round-trip; `GET /devices/{peer}` identity pinning verified.
