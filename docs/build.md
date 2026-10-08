# 构建与打包

> 本文件是**构建与打包的权威说明**。命令速查见 `AGENTS.md`；测试与换版流程见 [docs/test.md](test.md)；设计细节见 [docs/design.md](design.md)。

---

## 1. 产物与命令

| 命令 | 产物 | 必须在哪个系统上执行 |
| --- | --- | --- |
| `npm run dist:win` | `releases/LocalAIProxy-<ver>-win-portable.exe`（便携版单文件） | Windows |
| `npm run dist:mac` | `releases/LocalAIProxy-<ver>-mac.dmg` | macOS |
| `npm run dist:linux` | `releases/LocalAIProxy-<ver>-linux.AppImage` / `.deb` | Linux |

- **必须在目标系统上现场构建**（跨平台交叉构建不可靠，macOS 尤其必须在 macOS 上构建）。
- **仓库只提供构建脚本，不提交任何平台的二进制产物**；产物统一输出到 `releases/`（已 gitignore）。

---

## 2. 打包流程（原理）

后端先用 **esbuild** 打成一个 CJS 文件 `dist/backend.cjs`（`scripts/build-backend.mjs`），再交给 **electron-builder** 打包。之所以先 bundle 成 CJS，是为了规避「asar + ESM」的加载问题，并让 Electron 主进程可直接 `require`。

其它常用脚本：

```bash
npm run build:backend   # 只把后端打成 dist/backend.cjs
npm run dev:desktop     # 本地开发桌面端（先 build:backend 再 electron .）
```

---

## 3. 用户数据保护（scripts/dist.mjs）

`npm run dist:*` 实际执行 `scripts/dist.mjs`，它做两件防护：

1. **显式 `--publish never`**：electron-builder 一旦检测到 CI 环境变量（如 `CI=true`）就会「隐式发布」产物到 GitHub Releases，缺 `GH_TOKEN` 时会以失败码结束整个构建——**产物其实已经生成**，却容易被误判为构建失败。本项目只产出本地安装包、不自动发布，故统一传入 `--publish never`。
2. **备份 / 恢复 `releases/data`**：在 electron-builder 清理 `releases/` **之前**，把 `releases/data`（用户真实配置与日志）复制到**仓库之外**的临时目录，构建完成后自动恢复并逐文件校验，校验通过才删除备份。因此**重建产物不会丢用户数据**。

> **不要手工删除 `releases/data`**，也不要绕过 `scripts/dist.mjs` 直接调用 `electron-builder`。

---

## 4. 产物清理与命名

构建成功后自动清理中间产物（`mac-arm64/`、`win-unpacked/`、`linux-unpacked/` 等）与自动更新元数据（`.blockmap`、`latest-*.yml`、`builder-debug.yml`），`releases/` 只保留最终安装包与 `releases/data/`。

> 判断构建是否结束，要按**新版本号产物是否存在**来判断，不能看「`releases/` 下存在任意 exe」——旧版本 exe 一直在，会导致误判。

---

## 5. 国内网络（镜像）

Electron 本体与其打包工具（NSIS、winCodeSign 等）默认从 GitHub 下载，国内可能失败。构建前设置镜像即可：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run dist:win
```

若 `npm install` 中断导致 `node_modules/electron/dist` 缺失（postinstall 被跳过），单独补跑：`node node_modules/electron/install.js`

---

## 6. 校验产物内含新代码

构建后必须解包确认产物里是**新版**代码（避免「构建成功但产物是旧的」）：

- **macOS**：`hdiutil attach` 挂载 dmg → 用 `PlistBuddy` 读 `CFBundleShortVersionString` 核对版本号 → 读 `app.asar` 或 `resources/public`，确认 `public/` 与后端代码都是新版。
  > 注意：在 asar 二进制上 `grep` 中文串不可靠，改用 Node `Buffer.includes()` 复核。
- **Windows / Linux**：解包（`win-unpacked` / `linux-unpacked`，或用 7z 解开 AppImage）后确认 `resources/public` 与 `resources/app.asar` 为新版。

---

## 7. 平台说明与已知限制

- **Windows**：采用 **portable** 目标——双击即用，不解压、不写注册表；数据写在 exe 同级 `data/` 目录，删除该目录即彻底清除。
- **macOS**：dmg 未签名、未公证，首次打开会被 Gatekeeper 拦截。右键点按应用图标选「打开」，或执行：

  ```bash
  xattr -dr com.apple.quarantine /Applications/LocalAIProxy.app
  ```

- **Linux（尚未验证）**：本项目目前只在 macOS 上构建 / 运行过。Linux（AppImage / deb）的**数据目录落点未实测**，可能落在只读或不可写的路径（见 [docs/design.md](design.md) §9.3 与 §12 待确认）。首次在 Linux 上构建 / 运行后，请先确认 `data/` 能正常读写，再对外宣称支持。

---

## 8. 发布到 GitHub Release（CI）

仓库内置 `.github/workflows/release.yml`：**推一个 `v*` tag**，即在 GitHub 的免费 runner 上三平台各自**原生构建**，并把产物挂到**同一个草稿 Release**（人工审阅后手动 Publish）。

这样解决了「本机只有 Windows/Mac、产不出 Linux 产物」的问题，且**不需要任何 secrets**（产物未签名，用 Actions 自带的 `GITHUB_TOKEN`）。

**发版流程**：

```bash
# 1) 按 docs/contributing.md §1 递增 package.json 版本，提交并推送
# 2) 打 tag 并推送（tag 名须与版本号一致，如 v0.6.3）
git tag v0.6.3 && git push origin v0.6.3
# 3) 等 Actions 跑完 → GitHub「Releases」出现草稿 → 审阅 → Publish release
```

- **干跑**（不建 Release）：在 Actions 页面选 workflow「Release」→「Run workflow」，产物会作为 Actions artifact 供下载。
- **mac 产物是 arm64**：`macos-latest` 现为 Apple Silicon；要 Intel 版把 `macos-latest` 换成 `macos-15-intel`。
- **产物未签名**：mac 会被 Gatekeeper 拦、Windows 会 SmartScreen 提示——请在 Release 说明里写一句（mac 的处理见 §7）。
- workflow 复用 `npm run dist:mac / dist:win / dist:linux`（内含 `build:backend` 与产物清理），未绕过 `scripts/dist.mjs`。

> **与 electron-builder 自带发布的区别**：本项目 `dist.mjs` 固定 `--publish never`，并会清理 `latest-*.yml` / `.blockmap`（自动更新元数据），所以发布交给 workflow 里的 action 完成，二者互不冲突。将来若要接 `electron-updater` 自动更新，再改为保留这些元数据并启用 electron-builder 的 publish。