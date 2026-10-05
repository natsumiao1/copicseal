# 发布流水线

> **面向对象**：维护者
> **覆盖范围**：GitHub Actions 打包、版本号规则、更新签名密钥、自动更新验证

---

## 1. 触发方式

| 工作流 | 触发 | 结果 |
|--------|------|------|
| `Release CI`（`.github/workflows/release.yml`） | 推送 `v*` 标签 | 打包四个目标 → 生成 `latest.json` → 发布 GitHub Release |
| `Beta CI`（`.github/workflows/beta.yml`) | 推送到 `dev` 分支、或手动 `workflow_dispatch` | 打包四个目标，只上传 Actions artifact，不创建 Release |

两个工作流都调用 `.github/workflows/build.yml`（`workflow_call`），打包步骤只在那一处维护。

---

## 2. 打包矩阵

| 产物标识 | 运行器 | Rust target | `--bundles` | 安装包 |
|----------|--------|-------------|-------------|--------|
| `windows-x64` | `windows-2025` | `x86_64-pc-windows-msvc` | `nsis` | `*-setup.exe` |
| `windows-arm64` | `windows-11-arm` | `aarch64-pc-windows-msvc` | `nsis` | `*-arm64-setup.exe` |
| `macos-arm64` | `macos-15` | `aarch64-apple-darwin` | `app,dmg` | `*.dmg`（含 `*.app.tar.gz`） |
| `macos-x64` | `macos-15-intel` | `x86_64-apple-darwin` | `app,dmg` | `*.dmg`（含 `*.app.tar.gz`） |

产物落在 `src-tauri/target/<target>/release/bundle/` 下（`nsis/`、`dmg/`、`macos/`）。

- Windows 只发布 NSIS：更新清单里一个 `windows-x86_64` 平台键只能指向一种安装包，统一成 NSIS 才能让所有 Windows 用户走同一条更新路径
- macOS 的 `*.dmg` 用于首次安装，`*.app.tar.gz` 供自动更新使用

---

## 3. 版本号

三处版本号（`package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`）以 `scripts/sync-version.mjs` 为唯一同步入口：

```bash
pnpm sync:version 0.5.1   # 指定版本：写入 package.json 并同步另外两处
pnpm sync:version         # 不带参数：以 package.json 为准同步另外两处
```

发布流程：

1. 本地执行 `pnpm sync:version 0.5.1`，提交版本号改动
2. `git tag v0.5.1 && git push origin v0.5.1`
3. CI 以标签为准再次同步，因此仓库与产物版本一定一致

标签必须是 `v<semver>` 形式，否则 `sync-version.mjs` 会在编译前直接失败。

---

## 4. 更新签名密钥（自动更新的前提）

Tauri 更新包使用 minisign 签名校验，**与操作系统代码签名无关**，必须先生成好才能发布可自动更新的版本。

- **只需一对密钥**：`plugins.updater.pubkey` 只有一个字段，四个打包任务共用同一个 `TAURI_SIGNING_PRIVATE_KEY`
- **不需要 Apple / 微软开发者账号**：不买代码签名的代价只体现在首次安装（Windows 弹 SmartScreen、macOS 需在「隐私与安全性」放行），后续自动更新不受影响

### 4.1 生成密钥对

```bash
# macOS / Linux
pnpm tauri signer generate -w ~/.tauri/copicseal.key
# Windows（PowerShell 不为原生程序展开 ~）
pnpm tauri signer generate -w "$env:USERPROFILE\.tauri\copicseal.key"
```

命令会提示设置密码（可留空），输出私钥文件与公钥字符串。

### 4.2 配置公钥

把公钥**内容**（不是路径）填进 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`，替换占位符 `PENDING_RELEASE_KEY`。流水线在「配置了签名密钥但公钥仍是占位符」时会直接报错拦截。

### 4.3 配置 GitHub Secrets

| Secret | 内容 |
|--------|------|
| `TAURI_SIGNING_PRIVATE_KEY` | 私钥文件**内容**（不是路径） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 生成时设置的密码；未设密码则留空 |

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/copicseal.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

本地构建更新包时需要真实环境变量（`.env` 不生效）：`TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。

### 4.4 约束与风险

- **私钥丢失后，已安装的客户端再也无法收到更新**；公钥轮换同理（旧客户端只认旧公钥），请离线备份私钥与密码
- 第一个带真实公钥的版本是「更新基线」：在它之前发布的任何构建都无法自动更新
- 公钥只在下载校验阶段被解析：仍是占位符时「检查更新」能正常返回版本号，但点击下载会因公钥无法解码失败
- 未配置签名密钥时流水线仍可跑：走 `.github/tauri-nosign.conf.json` 关闭 `createUpdaterArtifacts`，只产出安装包，自动更新不可用
- **重新生成密钥等价于一次「密钥丢失」**：所有按旧公钥构建的版本永远收不到更新。想平滑轮换需在客户端保留过渡逻辑（Rust 侧 `updater_builder().pubkey(<新公钥>)` 运行时指定公钥，过渡版本先试新公钥、失败再退回旧公钥）；JS 侧 `check()` 不支持指定公钥
- 私钥泄露到公开位置时必须立即轮换

---

## 5. 可选：操作系统代码签名

与更新签名完全独立，**不配置不影响自动更新**，只是首次安装体验差一些。

- **macOS**（消除 Gatekeeper 提示）：配置 `APPLE_CERTIFICATE`（`.p12` 的 base64）、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`、`APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`。未签名时更新包替换 `.app` 后同样受 Gatekeeper 约束
- **ad-hoc 兜底**：用户反馈「已损坏、无法打开」时可在 `bundle.macOS.signingIdentity` 填 `"-"`，但可能让 arm64 程序在 Rosetta 下运行且未实测，建议先按未签名发布
- **Windows**：需 OV/EV 代码签名证书，当前流水线未配置

---

## 6. 更新源与清单

`plugins.updater.endpoints` 按顺序尝试自建服务与 GitHub Release 上的 `latest.json`。回退行为（以实现为准）：

| 情况 | 行为 |
|------|------|
| 传输错误（DNS 不存在、连接失败） | 记录错误并继续下一个 endpoint |
| 非 2XX（含 404） | 继续下一个 endpoint |
| `204 No Content` | **立即判定「无更新」，不再继续** |
| `200` + 响应体不是 JSON | **整体失败，不再继续** |
| `200` + 结构不合法 | 记录错误并继续下一个 endpoint |

因此自建服务上线后：无更新时返回 `404` 才会回退到 GitHub；返回 `204` 表示「以我为准」。

**静态清单**（Release 上的 `latest.json`，由 `scripts/generate-latest-json.mjs` 生成）包含 `version`、`pub_date` 与四个平台键（`windows-x86_64` / `windows-aarch64` / `darwin-x86_64` / `darwin-aarch64`）：

- `signature` 必须是 `.sig` 文件**内容**（不能是路径或链接），`url` 必须是绝对地址，Tauri 会先整份校验再比较版本
- 平台键为 `{os}-{arch}`，运行时先找 `{os}-{arch}-{installer}`（如 `windows-x86_64-nsis`）再回退到 `{os}-{arch}`

**自建更新服务**：URL 中可用 `{{target}}`（`windows`/`darwin`）、`{{arch}}`（`x86_64`/`aarch64`）、`{{current_version}}`；有更新返回 `200` 与 `{ "version", "url", "signature", "notes?", "pub_date?" }`，无更新按上表选择 `204` 或 `404`。

---

## 7. 安装形态与自动更新

- **Windows**：必须通过 NSIS `-setup.exe` 安装；安装阶段由安装器结束并重新拉起（`installMode: passive`），界面上的「请重新启动」主要针对 macOS
- **macOS**：从 `.dmg` 拖入 `/Applications`；更新时插件替换 `.app` 包（权限不足时提权），完成后需用户手动重启
- 更新包由清单指向的安装器决定方式（NSIS 或 `msiexec`）；绿色版 / 未安装的副本不参与更新
- 预发布标签（如 `v0.6.0-beta.1`）不会被 `releases/latest/download/latest.json` 命中，这是 GitHub 端点固有限制

---

## 8. 验证自动更新

本地验证（需已生成密钥）：

1. 用 `0.5.0` 构建并安装（`bundle.createUpdaterArtifacts: true` + 签名环境变量）
2. `pnpm sync:version 0.5.1` 后重新构建，得到新产物与 `.sig`
3. `node scripts/generate-latest-json.mjs --dist <产物目录> --tag v0.5.1 --version 0.5.1` 生成清单，用本地 HTTP 服务托管
4. endpoint 临时指向本地地址并打开 `plugins.updater.dangerousInsecureTransportProtocol`（release 构建对 `http://` 直接报错）
5. 在已安装的 `0.5.0` 中点击「检查更新」，观察版本号、下载进度与安装结果

正式验证：安装 vN，发布 vN+1，在应用内「设置 → 关于」执行检查与安装。

---

## 9. 已知缺口

- `updates.copicseal.com` 尚未部署（当前 DNS 不解析，客户端回退到 GitHub 端点）
- macOS 未配置签名与公证；Windows 未配置代码签名证书
- 预发布版本无法通过 GitHub 端点被自动发现
- 在配置真实公钥之前发布的版本永远无法自动更新
