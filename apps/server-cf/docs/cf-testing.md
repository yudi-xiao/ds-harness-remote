# 测试与本地验证（apps/server-cf）

分两层验证，均已在 2026-10-18 本机执行通过。

## 1. Vitest + Workers pool（自动化集成测试）

- 依赖：`vitest@4.1.12`、`@cloudflare/vitest-pool-workers@0.23.0`（官方已改名为 `@cloudflare/vitest-plugin`，0.23.0 会打印迁移警告，暂固定此版本）。
- 配置：`vitest.config.ts` 使用 `cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' }, miniflare: { bindings: { ... } } })`；测试在 workerd 内运行，`import { SELF, env } from 'cloudflare:test'`。
- 用例：`tests/server.test.ts`（3 个契约级用例）
  1. 账号/设备凭据与 membership：错误密码 401、Cookie 登录、账号 token 不能调用设备接口、设备列表只含 Host 且不泄露 identityKey、host 角色不能列设备、presence=false、identity pinning 409。
  2. Control + Relay：`hello.ack` relay-only、connect.request/incoming/accepted、`transport.selected`、`secure.handshake` 两阶段、opaque relay 转发、重复 counter scoped error 且不断开 Control、设备撤销后 socket 4001 关闭 + token 失效 + 对端收到 scoped error。
  3. Refresh：refresh token 轮换、旧 token 重放触发 token family 撤销。
- 运行：

  ```bash
  pnpm --filter @dsh-remote/server-cf exec vitest run
  ```

- 结果：`3 passed (3)`，约 0.7s。
- 类型检查：`pnpm --filter @dsh-remote/server-cf check`（tsc --noEmit，退出码 0）。

## 2. 真实 wrangler dev 端到端脚本

`scripts/e2e-local.mjs` 通过 HTTP + 原生 WebSocket 直连运行中的 `wrangler dev`，覆盖真实 workerd / DO SQLite / Assets / Hibernation WebSocket 组合：

```bash
# 终端 A
pnpm --filter @dsh-remote/protocol build
pnpm --filter @dsh-remote/server-cf assets
pnpm --filter @dsh-remote/server-cf dev

# 终端 B
DSH_CF_ACCOUNT=owner@example.com DSH_CF_PASSWORD=... node apps/server-cf/scripts/e2e-local.mjs
```

覆盖 40 项断言：health/静态页/404、登录与 Cookie、设备注册/固定/角色、设备列表/presence、hello/hello.ack、连接生命周期、真实 Noise IK 握手转发、双向密文 relay、replay 拒绝、撤销断线、refresh 轮换与重放撤销、logout。结果为 `E2E PASS`。

正常输出不应出现 `Uncaught TypeError: Can't read from request stream after response has been sent`：带 `{}` body 的 `POST /api/v1/auth/logout` 会走“路由不读 body”的排空路径，若回归会重新出现在 `wrangler dev` 日志中（见 `docs/cf-runtime.md` 第 6 节）。运行 `wrangler dev` 请使用包内脚本/版本（`pnpm --filter @dsh-remote/server-cf dev`，4.151.1），不要直接执行根 `node_modules/wrangler`（4.124.0，行为不同）。

## 3. 其余验证命令

```bash
pnpm --filter @dsh-remote/server-cf build     # wrangler deploy --dry-run
```

2026-10-18 结果：打包成功，读取 7 个静态资源文件，bundle 176.68 KiB（gzip 32.38 KiB），DO/Assets/vars 绑定识别正常。

## 4. 环境注意事项

- 运行 workerd/esbuild 需要允许子进程；受限沙箱会 `spawn EPERM`。
- `wrangler dev` 必须使用包内固定版本（`pnpm --filter @dsh-remote/server-cf dev`，lockfile 为 4.151.1）。根 `node_modules/wrangler` 是 vitest pool 自带的 4.124.0，直接执行会得到较旧 workerd，曾导致 logout 后 500，不能作为验证环境。
- vitest pool 内置 workerd 支持的 compatibility date 上限为 `2026-08-22`，`wrangler.jsonc` 当前为 `2026-08-01`。
- 测试中的 identityKey 使用固定的规范 32 字节 base64url 字符串（无需引入 `@dsh-remote/crypto`，避免 workerd 测试环境解析 workspace 包依赖）。
