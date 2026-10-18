# 个人 Agent App 生态（个人 Expo 账号 + Cloudflare + DSH Host）

本仓库当前分支按“个人自用”方式维护：Android App 使用个人 Expo 账号通过 EAS Build 构建并以 EAS Update 发布 JS 更新，后端使用个人 Cloudflare 自部署 Server，Host 是运行 DeepSeek Harness + `ds-harness-remote` 插件的个人电脑。本文记录一次性初始化、构建、升级和故障处理流程。

## 当前状态（2026-10-19）

- Expo 账号已登录：`shuohigh`（该账号下同时有 `shuohigh` / `bowong` 两个 account，本仓库使用 `shuohigh`）。
- EAS 项目已创建并写入 `app.json`：`@shuohigh/dsh-agent`，`projectId 61c55e4e-03c6-4faa-b7b7-dd9ac3f92175`。
- EAS Update 已配置 `updates.url`，`preview` channel / branch 已创建。
- **首次 `preview` APK 构建成功**（build `9066fff6-8f27-462a-af70-1b0688bb3b7e`，2026-10-19）：
  - APK 直链：<https://expo.dev/artifacts/eas/5BgA6HMtWEBSpxQDluIlsONLCOXZBrBN6a2rF7IBDRQ.apk>
  - 构建页：<https://expo.dev/accounts/shuohigh/projects/dsh-agent/builds/9066fff6-8f27-462a-af70-1b0688bb3b7e>
  - 大小 136,257,561 bytes；SHA-256 `438E08B58EAAC0A0334ABFC9DC12AB2DCDE700ACD4E22E9E39A698406A25F177`
- 已校验 APK 内 `assets/index.android.bundle` 含 `session/attachment`、个人 Server URL/账号、`attachmentId` 与 `com.howlearnwood.agent`，即安装包已包含会话图片回显逻辑。
- 已校验 EAS Update 公网 manifest：`https://u.expo.dev/61c55e4e-03c6-4faa-b7b7-dd9ac3f92175` 在 `expo-platform: android`、`expo-runtime-version: 0.6.0`、`expo-channel-name: preview` 下返回 `01a14fda-2087-7d8f-9502-5059721c8c5b`。
- **真机验收通过（2026-10-19）**：新 Agent 已安装并登录，Server 设备 `3023a87f-8dcb-4525-9037-76354daaabf7`（clientVersion `0.6.0`，online）；用户确认会话内可直接看到工具结果图片（含历史图片与 `read_image` 结果）。对应改动已本地提交 `16606d0`（未推送）。
- 安装：新包名/签名与旧 `DSH Remote` 不同，因此可以与旧 App 共存，无需先卸载；建议安装 `Agent` 并完成登录后卸载旧 App。首次打开登录页 Server/账号已预填，输入个人 Server 密码登录。
- **首次 EAS Update 已发布**（`preview` 分支）：update group `cf4a86d0-6519-4228-b3fd-73cb8fe6e5ea`，runtimeVersion `0.6.0`，manifest <https://u.expo.dev/update/01a14fda-2087-7d8f-9502-5059721c8c5b>。App 启动后会按 channel 拉取该更新（内容与内置 bundle 相同，用于验证通道）。

## v0.7.0 体验重构（2026-10-19）

- **品牌统一**：显示名/启动页/登录页/设备页/关于页/安全横幅统一为 `DSH Remote Agent`；新增本地图标（深海军蓝 + 青色互联六边形节点），适配 Android 自适应图标与启动屏；旧设备名 `… · DSH Remote` 在启动时一次性迁移为 `… · DSH Remote Agent`。
- **记住登录**：设备凭据继续保存在 `expo-secure-store`；认证异常不再立即删除设备凭据，下次启动仍可用原凭据重试，只有显式“退出登录/重置”才清空。重启 App 后直接进入设备列表，无需重新输入密码。
- **会话内视频**：新增 `expo-video`。Host 端 H3 视频工具新增 `workspace_dir` 参数：生成后把 MP4 与首帧 JPEG 封面复制到 `<session workspace>/_scratch/videos/`，结果里返回 `workspace_relative_path` / `cover_relative_path` 并把封面作为原生图片附件返回。Android 会话显示“封面 + 播放按钮”卡片；点播放时才经官方只读 `workspaceFiles/readBytes` 分块拉取（≤ 120 MiB，512 KiB/块），写入 App 缓存后用 expo-video 全屏播放，历史不会自动下载视频字节。
- **构建**：`version 0.7.0` / `versionCode 52`，运行时版本 `0.7.0`。新 APK 构建 `b4f03830-186c-4861-ae9f-37c9ad8c6599`（preview，FINISHED）：
  - APK 直链：<https://expo.dev/artifacts/eas/NQumxj6sQc5E2wXXmsQR_d6sh8Ty8NgJs55qZ0IXf0E.apk>
  - 构建页：<https://expo.dev/accounts/shuohigh/projects/dsh-agent/builds/b4f03830-186c-4861-ae9f-37c9ad8c6599>
  - 大小 140,387,455 bytes；SHA-256 `1F9EECA14F0141B5361356D9EBC6561D4F1BDB0D6ED1A8C591A2231EFCFD991C`；同包名/同签名，可直接覆盖安装并保留登录数据。
  - 已解包校验：`assets/index.android.bundle` 含 `DSH Remote Agent`、`workspace_relative_path`、`cover_relative_path`、`video/mp4`、`chat-videos`；`classes3.dex` 含 `expo-video` / `ExpoVideo` / `expo.modules.video`，说明原生视频模块已编入。
  - 旧 `0.6.0` 的 EAS Update 不会下发到 `0.7.0`；`expo-video` 是原生模块，必须重新安装 APK。
- **0.7.0 EAS Update 已发布**（`preview` 分支，runtime `0.7.0`）：
  - 首个更新：group `a0c861df-5a03-488a-8029-145f823eadc3`，manifest <https://u.expo.dev/update/01a15012-b191-7a0c-8ca7-4816264dfdc3>。
  - 视频分块修复（JS-only）：`workspaceFiles/readBytes` 的二进制 `data` 会被 client-core 还原为 `Uint8Array`，原实现只接受 base64 字符串，导致点击播放报“视频文件不在会话工作区中”；现同时支持 `Uint8Array` 与 legacy base64。修复更新 group `8ac8104e-4fd4-467a-b421-ee18f86ae39f`，manifest <https://u.expo.dev/update/01a15022-7633-7606-83d3-ba305eb4017d>。
  - 诊断增强：关于页新增“运行版本 / 更新 ID / Bundle 来源（内置包或 OTA）”，便于确认当前实际运行的 JS 版本。
- **真机验收通过（2026-10-19）**：关于页确认更新 ID `01a15026-…` / Bundle 来源为 OTA；会话内视频卡片点击后成功下载并播放（有声），登录保持、`DSH Remote Agent` 名称与新图标均已确认。真实 H3 生成视频（含封面）可在下一次新对话中按同一契约验证。最新更新 group `d05f1573-812f-4c3a-8405-341471e75d06`，manifest <https://u.expo.dev/update/01a15024-458f-7cf7-b051-fa404519c646>。
  - 文件预览二进制修复：`workspaceFiles/readBytes` 的 `Uint8Array` 同样会被 Files 面板图片/PDF 预览读取；解析现同时接受两种形态（25 文件 / 143 测试）。最新更新 group `6f7a765d-5629-4f0a-86ed-df078268206e`，manifest <https://u.expo.dev/update/01a15026-2b27-76d8-afae-5e2215075fd5>。
- **Host 侧前置条件**：本机 H3 工具已支持 `workspace_dir`（`C:\Users\shuoh\WebstormProjects\LLM\integrations\dsh\local-tools-mcp.cjs` + `media-result.cjs` + `services/h3-comfy.cjs` / `model-scheduler.cjs` / `services/inspect-video.py`，用 `runtime\h3-env` 的 PyAV 抽首帧）。模型需在调用 `generate_video` 时把当前会话工作区作为 `workspace_dir` 传入；MCP 进程需在 DSH 新会话中重启后才会暴露新参数。

## 组成

| 组件 | 个人配置 |
| --- | --- |
| Android App | 显示名 `DSH Remote Agent`，包名 `com.howlearnwood.agent`，`version 0.7.0` / `versionCode 52`；EAS 云构建 |
| Expo 项目 | `@shuohigh/dsh-agent`，projectId `61c55e4e-03c6-4faa-b7b7-dd9ac3f92175`（已写入 `app.json`） |
| 应用签名 | 本地 release keystore（`apps/android/keystores/`，不入库，需离线备份；本机备份在 `~/.dsh/personal/agent-signing/`） |
| 更新通道 | EAS Update：`preview`（自用 APK）与 `production`（备用），`updates.url = https://u.expo.dev/61c55e4e-03c6-4faa-b7b7-dd9ac3f92175` |
| Server | Cloudflare Worker + Durable Object，`https://remote-dsh.howlearnwood.com`，单账号 `shuohigh` |
| Host | DeepSeek Harness Desktop + `ds-harness-remote` 插件（本仓库 npm 包或 GitHub 安装） |
| App 默认连接 | 登录页预填个人 Server URL 与账号，见 `apps/android/eas.json` 的 `EXPO_PUBLIC_*` |

## 一次性初始化

### 1. 登录个人 Expo 账号

EAS 构建需要本机 EAS CLI 登录个人 Expo 账号（登录态保存在本机 `~/.expo`，不写入仓库）。

```bash
pnpm dlx eas-cli@latest login
# 无交互终端（例如由 Agent 驱动）时使用设备码：
pnpm dlx eas-cli@latest login --device --non-interactive
# 浏览器确认授权后，用浏览器显示的号码完成：
pnpm dlx eas-cli@latest login --device --non-interactive --resume <REQUEST_ID> --match <NUMBER>
```

确认账号：`pnpm dlx eas-cli@latest whoami`。

### 2. 创建/关联 EAS 项目

在 `apps/android` 目录执行（会把 `owner` 与 `extra.eas.projectId` 写入 `app.json`；本项目已完成）：

```bash
pnpm dlx eas-cli@latest init --account shuohigh --non-interactive --force
pnpm dlx eas-cli@latest update:configure   # 写入 updates.url；需要已初始化项目
```

`eas.json` 在仓库中固定：

- `preview`：内部发行 APK，`channel: preview`，本地签名；
- `production`：AAB，`channel: production`；
- 构建时用 Node `22.14.0`、pnpm `9.15.4`，与仓库锁文件一致；
- `EXPO_PUBLIC_DSH_REMOTE_SERVER` / `EXPO_PUBLIC_DSH_REMOTE_ACCOUNT` 注入个人默认登录信息。

### 3. 本地签名（Android）

EAS 云构建使用 `credentialsSource: "local"`，需要：

- `apps/android/keystores/release.keystore`：一次生成、永久复用；
- `apps/android/credentials.json`：keystore 路径、密码与 alias。

两者都已在 `.gitignore` 中排除，**不得提交**；请把 keystore 与密码离线备份。丢失后已安装的 App 无法再接收同包名更新，只能卸载重装。

生成方式（需要 JDK 的 `keytool`）：

```bash
keytool -genkeypair -v -storetype JKS -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass <STORE_PASSWORD> -keypass <KEY_PASSWORD> -alias agent-release \
  -keystore apps/android/keystores/release.keystore \
  -dname "CN=com.howlearnwood.agent,OU=Personal,O=Howlearnwood,L=Beijing,S=Beijing,C=CN"
```

`apps/android/credentials.json` 示例（放入绝对路径或相对 `apps/android` 的路径均可）：

```json
{
  "android": {
    "keystore": {
      "keystorePath": "keystores/release.keystore",
      "keystorePassword": "<STORE_PASSWORD>",
      "keyAlias": "agent-release",
      "keyPassword": "<KEY_PASSWORD>"
    }
  }
}
```

### 4. Cloudflare Server

`apps/server-cf` 已按个人账号与域名配置（`wrangler.jsonc`）：

- `DSH_SERVER_ACCOUNT=shuohigh`
- `DSH_SERVER_PUBLIC_URL=https://remote-dsh.howlearnwood.com`
- 登录密码保存在 Worker secret：`pnpm --dir apps/server-cf exec wrangler secret put DSH_SERVER_PASSWORD`

部署：

```bash
pnpm --filter @dsh-remote/protocol build
pnpm --filter @dsh-remote/server-cf assets
pnpm --filter @dsh-remote/server-cf run deploy
```

推送到 fork `main` 时 Cloudflare Workers Builds 会自动重新构建部署；本地手动部署前先 `wrangler login`（凭据只保存在本机 `~/.wrangler` / `%APPDATA%`）。

### 5. Host 与手机首次登录

1. Host 安装/更新本插件的发布包（npm 或 GitHub）；Host 需登录同一 Server 账号并保持运行。
2. 手机安装 `DSH Remote Agent` APK 后打开：Server URL 与账号已预填，输入 Server 密码登录；之后正常重启/OTA 更新会保持登录，直接进入设备列表。
3. 在设备列表中选择自己的 Host，验证指纹并信任，再进入会话。

## 构建 APK

```bash
pnpm --dir apps/android dlx eas-cli@latest build -p android --profile preview --non-interactive
# Agent/CI 可加 --no-wait --json 只提交构建并拿到 build id，再用 build:view/build:list 轮询
```

- EAS 默认按 `.gitignore` 上传当前工作目录（含未提交改动），不需要先 commit；如需完全可复现可开启 `eas.json` 的 `cli.requireCommit`。
- `credentials.json` 必须是**无 BOM 的有效 JSON**，否则 EAS CLI 会报 “credentials.json must exist … and contain a valid JSON”；`keystorePath` 相对 `apps/android` 解析。
- EAS 构建前会执行 `apps/android/package.json` 的 `eas-build-post-install`（`scripts/eas-post-install.mjs`）：构建 `packages/**`、生成 xterm/PDF renderer 与可选 Intelligent UI renderer，再交给 Expo prebuild 与 Gradle。
- 自定义 config plugin 使用 `.cjs`（`plugins/with-remote-foreground-service.cjs`），因为 `apps/android/package.json` 是 `"type": "module"`；插件从 `android.package` 动态读取包名并替换 Kotlin 模板，改包名不需要改插件源码。
- 构建完成后从 expo.dev 构建页下载/安装 APK。同包名同签名的新版本可直接覆盖安装；旧 `DSH Remote` 包名不同，可与当前 App 共存。
- `versionCode` 必须在每次安装升级前递增（`app.json` 的 `android.versionCode`）；新增原生模块（如 `expo-video`）或改权限/图标时必须重新构建 APK，不能只发 OTA。

## JS 更新（EAS Update，免重装）

只改 JS/TS 或 `app.json` 中的 JS 可见配置时：

```bash
# apps/android/.env（不入库）保存个人预填值，保证 OTA bundle 与 APK 一致：
# EXPO_PUBLIC_DSH_REMOTE_SERVER=https://remote-dsh.howlearnwood.com
# EXPO_PUBLIC_DSH_REMOTE_ACCOUNT=shuohigh
pnpm --dir apps/android dlx eas-cli@latest update --branch preview --environment preview --non-interactive --message "fix: ..."
```

- `--environment preview` 在 `--non-interactive` 下必填；`.env` 中的 `EXPO_PUBLIC_*` 会在本地导出时内联进 OTA bundle。
- 当前 APK 的 runtimeVersion 为 `0.7.0`；给 `0.7.0` 发布更新时必须使用同一分支/通道，旧 `0.6.0` 的更新不会下发到新版本。
- 若本机 Windows 上 Hermes 报 `permission denied` / `Failed to open file ... .hbc`，把 `TMP`/`TEMP` 指向用户可写目录后重试（本仓库开发机由 Agent 运行时遇到过该限制）。
- `preview` 构建的 channel 会收到 `preview` 分支更新；`runtimeVersion.policy = appVersion`，因此同一 `version` 内的更新可下发。
- 原生依赖/权限/包名/签名变化必须重新构建 APK，并递增 `version`（runtimeVersion）与 `versionCode`。

## 会话图片回显

Android App 现在会在会话中直接显示工具结果图片：

- 原生 `tool/result` 与历史图片块保留官方 `attachment` 引用；
- 打开会话/加载更早历史/收到新事件时，经官方只读 `session.attachment`（rc.2 ApiProxy 与 Typert Remote 两条数据面）按会话授权读取；
- 客户端校验附件 id、media type、canonical base64 与字节数（单张 ≤ 12 MiB），按 Host 比例自适应显示，点击可全屏，折叠的工具过程组也直接展示结果图片；
- 旧 Host 没有该端点时保留占位符，不影响会话其它内容。

## 会话视频结果（v0.7.0）

Android 会话现在可以显示并播放 Host 生成的视频结果：

1. Host 的 `generate_video` 工具生成 MP4 后，把当前 DSH 会话工作区作为 `workspace_dir` 传入（工具 schema 已更新）；MCP 会把 MP4 与首帧 JPEG 复制到 `<workspace>/_scratch/videos/`，并在结果 JSON 中写入 `workspace_relative_path`、`cover_relative_path`、`bytes`、`duration_seconds`、`width`、`height`，同时返回封面图片附件。
2. Android 解析该结果后显示“封面 + 播放按钮”卡片；封面走现有图片附件链路，视频字节在用户点击播放时才经官方 `workspaceFiles/readBytes` 按 512 KiB 分块下载到 App 缓存（单视频上限 120 MiB），再用 `expo-video` 全屏播放。
3. 历史记录只显示卡片，不会自动下载视频；缓存文件以会话 + 路径 + 文件版本为键，文件变化会重新拉取。
4. 若 Host 未传 `workspace_dir`（旧 MCP 或旧会话），结果只显示文本/封面，不显示可播放卡片；MCP schema 变更需要新的 DSH 会话才会生效。

## 会话用量与本地 Saluki 优化（v0.7.0 增量）

Android 会话标题下方新增一行紧凑指标，数据全部来自 Host 官方 session projections（token-meter），随每一步实时更新：

- **上下文占用**：`contextPressure.projectedTokens`（下一次请求的 prompt 估算，缺失时回落到 `pressureTokens`）/ `contextWindow`；达到 85% 时变为警示色。
- **缓存命中**：`cacheReadTokens / (uncachedInputTokens + cacheReadTokens + cacheWriteTokens)`；provider 不上报缓存（部分本地 llama.cpp 版本）时隐藏该指标，不展示虚假的 0%。
- **权限等级**：`permissions.currentValue` 映射为只读 / 工作区写入 / 完全访问；完全访问使用警示色。
- 点击指标打开“对话信息”，可查看上下文构成（系统 / 工具 / 消息）、Token 用量、累计与本轮缓存命中、权限等级、沙箱/审批（Host 上报时）以及当前模型。

对应 OTA：group `a8174995-e74d-4436-8a96-79e1cf430cd2`，id `01a1505d-8f1d-71a7-aa74-dfa34238b638`（runtime `0.7.0`，JS-only）；Android check 与 26 文件 / 146 测试通过。

### 当前本机 Saluki 配置

来自 `~/.dsh/profiles/desktop/cordis.patch.yml`：

- provider `local-saluki`：llama.cpp OpenAI 兼容端点 `http://127.0.0.1:18080/v1`，模型 `underdog-saluki-27b`，`contextWindow: 131072`，`maxTokens: 16384`，`reasoningEfforts: off/high`。
- `compaction-basic` 自动压缩：`thresholdRatio: 0.6`、`headroomTokens: 8192`、`retainTokens: 8192`、`maxTokens: 16384`。
- 当前会话（写作时）实际使用 `deepseek-account/deepseek-flash`；权限 `danger-full-access`（完全访问，审批 `never`）。切到本地 Saluki 后权限策略照常由 per-session 权限控制。

### 本地 Saluki 优化建议

1. **保持 prompt 前缀稳定**：固定系统提示、工具表、模型和 reasoning effort；同一任务尽量在同一会话继续。频繁切换模型、MCP server 或 skill 会让 llama.cpp 的前缀缓存失效，应用内“缓存命中”可直接观察。
2. **控制上下文长度**：128K 窗口、60% 阈值约 78.6K token 触发压缩；27B 模型在长上下文下延迟和质量都会下降。新任务开新会话，长任务在 60% 前后主动 `/compact` 或新会话，避免等到 100%。
3. **降低输出上限**：交互式编码可把 `maxTokens` 从 16384 降到 8192；复杂重构或长输出任务再临时提高。`reasoningEfforts: high` 只用于困难任务。
4. **精简工具面**：在“对话信息 → 上下文构成”观察工具 token 占比；关闭不用的 MCP server、skill 和插件，减少每次请求的 prefill。本机 `local_models`/REA/office 工具较多，按需启用。
5. **图片/视频按需**：本地 Saluki 声明支持图片，但视觉输入会显著增加 prefill；只发必要截图。图片/视频生成会占用 GPU（调度器会临时卸载/恢复 Saluki），不要在长会话推理期间并发生成。
6. **llama.cpp 参数核对**：确认 `--ctx-size` 与 DSH `contextWindow` 一致（131072），开启 prompt cache / `--cache-reuse` 与 flash attention；显存不足时用量化 KV cache、降低 `--parallel`/batch，避免 OOM 重试。
7. **本地并发**：同一时间只保留一个活跃本地会话以保持 slot/KV 缓存热度；本地模型上大量并行子代理会增加 GPU 排队，建议串行。
8. **数据可信度**：缓存命中为 provider 上报值；若本地 provider 不返回 cached token，应用会隐藏该指标，可用 llama.cpp 日志或 usage 响应确认。

## 安全与维护

- 不提交：`keystore`、`credentials.json`、`.env`、`.dev.vars`、`.wrangler/`、`.tmp/`、`_scratch/`。
- Expo 登录态可用 `pnpm dlx eas-cli@latest logout` 撤销；Server 密码只保存在 Cloudflare secret 与手机安全存储中。
- 若要回到上游开源配置，撤销 `apps/android/app.json` 的包名/名称与 `extra.eas.projectId` 即可，注意签名与版本号同步调整。
