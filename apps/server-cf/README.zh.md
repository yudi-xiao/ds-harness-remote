# Cloudflare Workers 自部署 Server

[English](README.md) · **中文**

`apps/server-cf` 是 [`apps/server`](../server/README.md) 的 Cloudflare Workers + Durable Objects 移植版：单账号 Remote 中继，Web 提供首页、登录和设备状态页；Host 插件、Android、VS Code 客户端仍按原有协议连接自定义 HTTPS Server，无需修改客户端。

本包不包含 DSH 本体，也不修改 DeepSeek 模型。Host 和客户端都主动连出到 Cloudflare，家宽不需要公网 IP 或入站端口。

## 架构

| 组件 | 职责 |
| --- | --- |
| Worker（`src/index.ts`） | HTTPS 入口、同源校验、`/api/v1/*` 与 `/ws/v1/connect` 路由、健康检查、Workers Assets |
| 单个 Durable Object（`src/gateway.ts` + `src/store.ts`） | 账号会话、设备凭据、Control WebSocket、连接配对、Noise 握手转发、opaque Relay、限流 |
| DO SQLite | `meta`/`devices`/`tokens`/`sessions`/`links`，只保存 token 摘要与公开身份 |
| Workers Assets | 复用 `apps/server/web` 的登录/设备状态页构建产物 |

Durable Object 使用 WebSocket Hibernation API：设备身份放在 socket attachment 中，连接配对状态放在 SQLite；空闲连接由 alarm 维持 25 秒应用层 ping，不要求 DO 常驻内存。

## 部署

前置：Node.js 22、pnpm 9.15.4、Cloudflare 账号（SQLite-backed Durable Objects 在 Free/Paid 计划均可创建，实际额度见 [DO 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)）。

1. 安装依赖并构建协议包与 Web 页面：

   ```bash
   pnpm install
   pnpm --filter @dsh-remote/protocol build
   pnpm --filter @dsh-remote/server-cf assets
   ```

2. 编辑 [`wrangler.jsonc`](wrangler.jsonc) 的 `vars`：`DSH_SERVER_ACCOUNT` 和 `DSH_SERVER_PUBLIC_URL` 必须是实际 HTTPS 站点根地址（例如 `https://remote.example.com`）。

3. 写入密码 secret（至少 12 字符，不要提交到仓库）：

   ```bash
   cd apps/server-cf
   pnpm exec wrangler secret put DSH_SERVER_PASSWORD
   ```

4. 部署：

   ```bash
   pnpm --filter @dsh-remote/server-cf deploy
   ```

   首次部署会创建 `RemoteGateway` Durable Object。打开 `https://<你的域名>/` 查看登录页；Host 和客户端填写同一个地址、使用同一账号密码登录。

5. 验证健康检查：`GET /health` 返回 `{"status":"ok"}`。Host 插件与客户端按原方式注册设备和建立加密连接。

## 本地开发与验证

```bash
cp apps/server-cf/.dev.vars.example apps/server-cf/.dev.vars   # 填写账号/密码/本地地址
pnpm --filter @dsh-remote/server-cf assets                      # 构建 Web 页面到 apps/server/dist/public
pnpm --filter @dsh-remote/server-cf dev                         # 默认 http://127.0.0.1:8787
node apps/server-cf/scripts/e2e-local.mjs                       # 需要 DSH_CF_ACCOUNT / DSH_CF_PASSWORD
```

结构校验：

```bash
pnpm --filter @dsh-remote/server-cf check
pnpm --filter @dsh-remote/server-cf build     # wrangler deploy --dry-run
```

2026-10-18 本地验证（wrangler 4.151.1 / Node 24.21.0）：`wrangler deploy --dry-run` 打包通过；`wrangler dev` 下 `e2e-local.mjs` 的 40 项断言全部通过，覆盖 REST 账号/设备凭据、Cookie、设备列表/在线状态、hello/hello.ack、连接生命周期、Noise IK 握手转发、双向加密 Relay、重放拒绝、撤销后即时断线与 token family 失效。另有 `vitest`（@cloudflare/vitest-pool-workers 0.23.0 + vitest 4.1.12）3 个集成用例通过；DO SQLite 在 `wrangler dev` 进程重启后保留账号会话、设备 token 与 refresh token（详见 [docs/cf-testing.md](docs/cf-testing.md)）。

## 与 `apps/server` 的差异与限制

- **仅 Relay**：与 Node 自部署版一致，`hello.ack` 返回 `webrtcEnabled: false`，不提供 WebRTC/TURN、OAuth、主机匹配码或完整 Remote Web 会话界面。
- **密码校验**：Workers WebCrypto 没有 scrypt，本实现使用随机盐 + HMAC-SHA256 校验部署密码。不能直接导入 Node 版 `data/state.json`；迁移需要重新注册设备。
- **密码变更**：修改 `DSH_SERVER_PASSWORD` 后重新部署，DO 首次请求会检测校验器变化、清空设备 token 与会话并断开现有连接。
- **Web 登录会话**：保存在 DO SQLite（Node 版是进程内存），因此 Worker 重启/休眠不会让已登录页面立即掉线。
- **慢客户端**：Workers WebSocket 没有 `bufferedAmount`，无法像 Node 版那样按缓冲量主动断开慢消费者；错误发送会被捕获，连接由客户端重连恢复。
- **心跳**：25 秒 ping / 75 秒超时由 DO alarm 驱动；连接配对阶段/relay counter 会持久化到 SQLite。
- **`online` 语义**：单 DO 内按当前 live WebSocket 计算，和 Node 版一致；不引入 D1、R2、额外 VPS。

## 相关文档

- [`docs/port-contract.md`](docs/port-contract.md)：Node 服务端 REST/WS 契约与 CF 移植对照
- [`apps/server/README.zh.md`](../server/README.zh.md)：Node 自部署版本
- [`docs/protocol.md`](../../docs/protocol.md)：线协议权威说明
- [`docs/plugin-integration.md`](../../docs/plugin-integration.md)：Host 插件账号/设备接入契约
