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
- 安装：新包名/签名与旧 `DSH Remote` 不同，因此可以与旧 App 共存，无需先卸载；建议安装 `Agent` 并完成登录后卸载旧 App。首次打开登录页 Server/账号已预填，输入个人 Server 密码登录。
- **首次 EAS Update 已发布**（`preview` 分支）：update group `cf4a86d0-6519-4228-b3fd-73cb8fe6e5ea`，runtimeVersion `0.6.0`，manifest <https://u.expo.dev/update/01a14fda-2087-7d8f-9502-5059721c8c5b>。App 启动后会按 channel 拉取该更新（内容与内置 bundle 相同，用于验证通道）。

## 组成

| 组件 | 个人配置 |
| --- | --- |
| Android App | 显示名 `Agent`，包名 `com.howlearnwood.agent`，`version 0.6.0` / `versionCode 51`；EAS 云构建 |
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
2. 手机安装 `Agent` APK 后打开：Server URL 与账号已预填，输入 Server 密码登录。
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
- 构建完成后从 expo.dev 构建页下载/安装 APK。由于本次改为个人包名与新签名，首次安装需先卸载旧 `DSH Remote`。
- `versionCode` 必须在每次安装升级前递增（`app.json` 的 `android.versionCode`）。

## JS 更新（EAS Update，免重装）

只改 JS/TS 或 `app.json` 中的 JS 可见配置时：

```bash
# apps/android/.env（不入库）保存个人预填值，保证 OTA bundle 与 APK 一致：
# EXPO_PUBLIC_DSH_REMOTE_SERVER=https://remote-dsh.howlearnwood.com
# EXPO_PUBLIC_DSH_REMOTE_ACCOUNT=shuohigh
pnpm --dir apps/android dlx eas-cli@latest update --branch preview --environment preview --non-interactive --message "fix: ..."
```

- `--environment preview` 在 `--non-interactive` 下必填；`.env` 中的 `EXPO_PUBLIC_*` 会在本地导出时内联进 OTA bundle。
- 若本机 Windows 上 Hermes 报 `permission denied` / `Failed to open file ... .hbc`，把 `TMP`/`TEMP` 指向用户可写目录后重试（本仓库开发机由 Agent 运行时遇到过该限制）。
- `preview` 构建的 channel 会收到 `preview` 分支更新；`runtimeVersion.policy = appVersion`，因此同一 `version` 内的更新可下发。
- 原生依赖/权限/包名/签名变化必须重新构建 APK，并递增 `version`（runtimeVersion）与 `versionCode`。

## 会话图片回显

Android App 现在会在会话中直接显示工具结果图片：

- 原生 `tool/result` 与历史图片块保留官方 `attachment` 引用；
- 打开会话/加载更早历史/收到新事件时，经官方只读 `session.attachment`（rc.2 ApiProxy 与 Typert Remote 两条数据面）按会话授权读取；
- 客户端校验附件 id、media type、canonical base64 与字节数（单张 ≤ 12 MiB），按 Host 比例自适应显示，点击可全屏，折叠的工具过程组也直接展示结果图片；
- 旧 Host 没有该端点时保留占位符，不影响会话其它内容。

## 安全与维护

- 不提交：`keystore`、`credentials.json`、`.env`、`.dev.vars`、`.wrangler/`、`.tmp/`、`_scratch/`。
- Expo 登录态可用 `pnpm dlx eas-cli@latest logout` 撤销；Server 密码只保存在 Cloudflare secret 与手机安全存储中。
- 若要回到上游开源配置，撤销 `apps/android/app.json` 的包名/名称与 `extra.eas.projectId` 即可，注意签名与版本号同步调整。
