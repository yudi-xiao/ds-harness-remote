# Cloudflare 运行时与配置速查（apps/server-cf）

本文只记录在本仓库 `apps/server-cf` 上**实际验证过**的 Cloudflare 行为与配置，作为实现和维护参考。验证环境：Node 24.21.0、pnpm 9.15.4、wrangler 4.151.1（workerd 1.20261012）、`@cloudflare/vitest-pool-workers` 0.23.0（其内置 workerd 最高支持 compatibility date `2026-08-22`）。日期：2026-10-18。

## 1. Wrangler 配置

`wrangler.jsonc` 中实际生效的字段：

```jsonc
{
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01",
  "assets": {
    "directory": "../server/dist/public",   // 复用 apps/server/web 的 vite 产物
    "binding": "ASSETS",
    "not_found_handling": "404-page",
    "run_worker_first": true
  },
  "durable_objects": { "bindings": [{ "name": "REMOTE", "class_name": "RemoteGateway" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["RemoteGateway"] }],
  "vars": { "DSH_SERVER_ACCOUNT": "...", "DSH_SERVER_PUBLIC_URL": "https://..." },
  "dev": { "port": 8787 }
}
```

已验证：

- `new_sqlite_classes` 创建 SQLite-backed DO；`ctx.storage.sql` 可用。
- `run_worker_first: true` 时 Worker 先处理所有请求，再通过 `env.ASSETS.fetch(request)` 回退静态资源；`not_found_handling: "404-page"` 使缺失的 `/assets/*` 返回 404 而不是回退 index.html。
- `wrangler deploy --dry-run` 能识别 DO、Assets 与 vars，输出 bundle 大小与绑定表。
- `wrangler dev` 自动读取 `.dev.vars`（本地覆盖 vars）；`--persist-to .wrangler/state` 时 DO SQLite 数据跨进程重启保留（已实测）。
- **compatibility date 上限取决于运行 workerd 的版本**：vitest-pool-workers 内置 workerd 只支持到 `2026-08-22`，使用 `2026-10-01` 会导致测试运行时启动失败（`This Worker requires compatibility date ... newest ... 2026-08-22`）。当前统一设为 `2026-08-01`。

## 2. Durable Object WebSocket Hibernation

实现使用（`src/gateway.ts`）：

- `ctx.acceptWebSocket(server)` 接受连接，之后由 `webSocketMessage` / `webSocketClose` / `webSocketError` 分发。
- 设备身份写入 `ws.serializeAttachment({ deviceId, role, capabilities, version, lastPong, nonce })`；DO 被唤醒后通过 `ctx.getWebSockets()` + `deserializeAttachment()` 重建 peers。
- 连接配对/握手阶段/relay counter 持久化在 DO SQLite 的 `links` 表，进程内 `Map` 只是缓存。
- 心跳不使用 `setInterval`：用 `ctx.storage.setAlarm(Date.now() + 25_000)` 驱动，每次 alarm 向所有 socket 发送 `ping` 并检查 75 秒超时，然后按需续订 alarm；无 socket 时不再设置 alarm，DO 可以休眠。
- 5 秒 hello 超时不做定时器，改为在 alarm 里按 attachment 的 `acceptedAt` 扫描未认证 socket 并关闭。

已验证：真实 `wrangler dev` 下 WebSocket upgrade → `hello`/`hello.ack` → connect 生命周期 → Noise 握手转发 → 双向 relay 全部工作（见 `scripts/e2e-local.mjs`）。

## 3. DO SQLite

- 初始化使用 `ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS ...")`，幂等；`blockConcurrencyWhile` 中执行建表/配置校验。
- 查询通过 `cursor.toArray()` 取行；写入用参数绑定（`?`）。
- 数据表：`meta`/`devices`/`tokens`/`sessions`/`links`；token 只存 SHA-256 摘要。
- 已实测：`wrangler dev` 进程重启（同一 `--persist-to`）后账号会话、设备 token、refresh token 均保留。
- 未验证/未使用：KV 风格 `storage.put/get` 与 SQL 混用、事务显式 API、跨对象迁移。

## 4. Web Crypto 与 Workers 全局

- 可用：`crypto.subtle.digest('SHA-256')`、`crypto.subtle.importKey/sign`（HMAC）、`crypto.getRandomValues`、`crypto.randomUUID`、`TextEncoder/TextDecoder`、`btoa/atob`。
- **不可用：scrypt**（Workers WebCrypto 无此算法），因此密码校验改为随机盐 + HMAC-SHA256；不能迁移 Node 版 `data/state.json` 的 scrypt verifier。
- 服务端 WebSocket 未使用 `bufferedAmount`（Node `ws` 的慢消费者检测依赖它）；当前实现对发送失败只做捕获，依赖客户端重连恢复。

## 5. Workers Assets

- 构建产物来自 `apps/server/web`（vite → `apps/server/dist/public`），`wrangler dev` 下 `/`、`/app`、`/app/login` 均返回构建后的 React 页面，缺失资源返回 404（已由 E2E 覆盖）。
- Worker 对静态响应统一追加 `Cache-Control: no-store` 与 CSP/nosniff/referrer 头；101 WebSocket 响应不做包装。

## 6. REST 请求体（workerd 行为）

- `readJson` 用流式读取并在累计超过 16 KiB 时立即返回 413，与 `apps/server/src/server.ts` 的 `body()` 一致；不要先 `request.arrayBuffer()` 再检查大小，否则可能先缓冲超限请求。
- 不读取请求体的路由（`POST /api/v1/auth/logout`、DELETE/GET）必须在返回响应前把请求体读到 EOF。仅调用 `request.body.cancel()` 不够：Worker 转发到 DO 的请求体管道只有读到结束才会完成，否则 `wrangler dev` 会在响应后抛 `Uncaught TypeError: Can't read from request stream after response has been sent`；较旧的 workerd（例如 `@cloudflare/vitest-pool-workers@0.23.0` 依赖的 wrangler 4.124.0）还会让同连接后续请求返回 500。`scripts/e2e-local.mjs` 的 logout（带 `{}` body）覆盖该路径，正常输出不应出现该异常。

## 7. 本地验证环境注意

- `wrangler dev` 使用包内固定版本：`pnpm --filter @dsh-remote/server-cf dev`（`pnpm-lock.yaml` 为 4.151.1）。根 `node_modules/wrangler` 可能是 `@cloudflare/vitest-pool-workers@0.23.0` 自带的 4.124.0，直接执行会得到不同 workerd 行为（本次调试中曾导致 logout 后 500），不要用它验证。
- 自定义域名通过 Dashboard（**Settings → Domains & Routes → Add custom domain**）或 `PUT /accounts/{id}/workers/domains` 绑定；删除 Worker 会一并移除绑定，重新部署后需要重新添加。刻意不把 custom domain 写进 `wrangler.jsonc` 的 `routes`，以便没有 Cloudflare 凭据的 CI `wrangler deploy --dry-run` 仍能通过；若改用 `routes`，CI 必须提供凭据。
- 本机 DSH 沙箱禁止 Node 通过管道 `spawn` 子进程，esbuild/workerd/wrangler 会报 `spawn EPERM`；构建与测试需在放宽权限的终端执行。这是验证环境限制，不是代码问题。
- esbuild 在系统 Temp 目录删除临时文件可能被拒绝（`Access is denied`），把 `TMP`/`TEMP` 指向工作区目录即可。
- `@cloudflare/vitest-pool-workers` 已被官方重命名为 `@cloudflare/vitest-plugin`，0.23.0 会打印迁移警告；当前固定使用 0.23.0 + vitest 4.1.12，对应测试见 `docs/cf-testing.md`。
