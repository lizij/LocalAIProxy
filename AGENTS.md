# AGENTS.md

本文件是本仓库的「代理协作指南」。任何 AI 代理或开发者在本仓库做改动前，必须先读本文件。

---

## 1. 项目是什么

LocalAIProxy：一个 **OpenAI 协议兼容的本地 AI 转发代理**。

- 对外暴露一个本地 BaseURL + APIKey（代理端口，默认 `0.0.0.0:8787`）；
- 把请求**原样透传**到用户配置的任意公开 Provider（单 Provider + model 透传）；
- 提供网页控制台（管理端口，默认 `127.0.0.1:8788`）实时查看**发往 Provider 的请求原文与收到的响应原文**；
- 通过 **Electron** 封装成桌面应用：一个窗口 + 内嵌 Chromium，窗口即服务，关窗即退出，无后台残留。

架构与设计细节见 `docs/DESIGN.md`（本文件只讲「怎么改、怎么发」）。

---

## 2. 命令速查

| 目的 | 命令 |
| --- | --- |
| 命令行模式启动（无 GUI，纯 Node） | `npm start` |
| 本地开发桌面应用 | `npm run dev:desktop` |
| 只打包后端为 `dist/backend.cjs` | `npm run build:backend` |
| 打包当前系统的安装产物 | `npm run dist` |
| 打包 Windows 便携 exe | `npm run dist:win` |
| 打包 macOS dmg | `npm run dist:mac` |
| 打包 Linux AppImage + deb | `npm run dist:linux` |

**打包必须在目标系统上进行**：Windows 产物在 Windows 上构建、macOS 产物在 macOS 上构建、Linux 产物在 Linux 上构建。仓库不提交任何平台的二进制产物。产物统一输出到 `releases/`。

**国内网络**：Electron 及其打包工具默认从 GitHub 下载，构建前先设镜像（否则会卡在下载或直接失败）：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run dist:win
```

首次 `npm install` 若中断，`node_modules/electron/dist` 可能缺失（postinstall 被跳过）；此时单独补跑：`node node_modules/electron/install.js`。

---

## 3. 版本号规约（重要：自更新）

- 版本号采用**标准 semver 三位**：`MAJOR.MINOR.PATCH`。
- **单一来源**：`package.json` 的 `version` 字段。禁止在其他文件中手写版本号。
  - 命令行模式：由 `src/version.js` 读取 `package.json`。
  - 桌面模式：Electron 主进程用 `app.getVersion()` 注入 `LOCAL_AI_PROXY_VERSION`，`src/version.js` 优先读该环境变量。
- **自更新要求**：**每次对项目做出有效改动后，必须同步更新 `package.json` 的 `version`**，按下述规则递增：

  | 改动性质 | 递增位 | 示例 |
  | --- | --- | --- |
  | 破坏性变更（接口/配置结构不兼容） | MAJOR | `0.2.0` → `1.0.0` |
  | 新增功能（向后兼容） | MINOR | `0.2.0` → `0.3.0` |
  | 修复缺陷 / 文档 / 内部重构 | PATCH | `0.2.0` → `0.2.1` |

- 版本号会在**网页控制台右下角角标**与 **Electron 窗口标题**中展示；改版本号无需改前端代码，重启后自动生效。
- **递增粒度是「一个改动集合 / 一次交付」，不是「一次文件编辑」**：同一批次内的代码、文档同步只递增一次，避免版本号空转。
- 递增后若重新构建了产物（如 `releases/` 里的 exe），则仓库版本号必须与产物一致的版本号保持同步；**不要让"改了文档就把版本号 +1"导致已交付的 exe 版本与仓库版本对不上**——这类文档同步并入原批次即可。

---

## 4. 文档同步规约

- **任何重要改动（新增/变更功能、接口、配置项、构建方式、架构调整）都必须同步更新 `docs/DESIGN.md`。**
- 新增管理端 API 端点时，需同时更新 `docs/DESIGN.md` 第 7 节的接口表。
- 新增/删除源码文件时，需同步更新 `docs/DESIGN.md` 第 5 节的目录结构。
- 不要另起新的设计文档；统一维护 `docs/DESIGN.md`。

---

## 5. 代码约束（不要破坏）

1. **运行时零第三方依赖**：`src/` 与 `public/` 只允许使用 Node 内置模块（`node:*`）与浏览器原生 API。第三方包仅可作为 `devDependencies`（构建/打包用）。
2. **ESM**：`src/**` 与 `public/app.js` 使用 ESM；Electron 主进程使用 CJS（`electron/main.cjs`），因其需 `require` 打包后的 `dist/backend.cjs`。
3. **前后端共用一份装配逻辑**：命令行入口与 Electron 主进程都必须通过 `src/app.js` 的 `createApp()` 启动服务，禁止复制粘贴启动代码。
4. **路径可配置**：`LOCAL_AI_PROXY_HOME`（数据目录）、`LOCAL_AI_PROXY_PUBLIC_DIR`（静态页面目录）、`LOCAL_AI_PROXY_VERSION`（版本号）三个环境变量是桌面模式与命令行模式的契约，改动时需同步 `electron/main.cjs`。特别注意 **`LOCAL_AI_PROXY_PUBLIC_DIR` 必须在打包与开发两种模式下都显式注入**：后端会被 esbuild 打成 CJS，此时 `import.meta.url` 失效，程序无法自行推断 `public/` 的位置（曾因此出现「开发模式打开窗口后页面 404」的问题）。
5. **跨平台**：一律 `node:path` 处理路径，不写死分隔符；不依赖平台特有的 shell 命令。
6. **无 daemon / 单实例**：Electron 侧保持「关窗即退出」与 `requestSingleInstanceLock()`；不要引入托盘常驻、开机自启、后台守护等行为。
7. **关服必须强制断开存量连接**：`src/app.js` 的 `stop()` 里除了 `server.close()`，还必须调用 `server.closeAllConnections()` 并叠加超时兜底。原因是控制台页面持有 SSE 长连接，`server.close()` 的回调会一直不触发，导致「端口释放了但进程不退出」。修改关闭逻辑时务必保持这一点。
8. **国内构建需设镜像**：Electron 及其打包工具默认走 GitHub，构建前需设置 `ELECTRON_MIRROR` 与 `ELECTRON_BUILDER_BINARIES_MIRROR`（见 `docs/DESIGN.md` 9.4）。
9. **安全默认值**：日志中的密钥一律打码；管理端口默认只监听 `127.0.0.1`；代理端口对局域网开放时保持 `requireClientKey: true`。
10. **不要再造路由框架**：`node:http` 手写路由已足够，不要为几个接口引入 Express/Fastify。

---

## 6. 目录结构（当前）

```
package.json            # 版本号单一来源 + electron-builder 配置 + 脚本
AGENTS.md               # 本文件
docs/DESIGN.md          # 方案设计（重要改动必须同步）
electron/main.cjs       # Electron 主进程：启动服务 + 创建窗口 + 生命周期
scripts/build-backend.mjs  # esbuild 把 src/app.js 打包为 dist/backend.cjs
src/
  index.js              # 命令行入口
  app.js                # 应用装配（命令行与桌面共用）
  version.js            # 版本号解析
  config.js             # 配置读写 / 默认值 / 密钥打码
  proxy/                # 代理端口：server / forward / auth
  log/                  # 日志：store（Ring Buffer + JSONL）/ reader
  admin/                # 管理端口：server / http / test
public/                 # 网页控制台（原生 HTML/CSS/JS，无构建）
releases/               # 打包产物（git 忽略）
dist/                   # 后端打包产物（git 忽略，由 build:backend 生成）
data/                   # 运行时数据：config.json + logs/（git 忽略）
```

---

## 7. 改动后的自检清单

- [ ] 已按第 3 节递增 `package.json` 的 `version`。
- [ ] 已按第 4 节同步更新 `docs/DESIGN.md`。
- [ ] `node --check` 能通过所有 JS 文件（或直接启动无报错）。
- [ ] `npm start` 可用：`/health` 与 `/api/admin/status` 正常返回，且 `status.version` 为新版本号。
- [ ] 改动涉及界面时，网页控制台右下角版本角标显示正确。
- [ ] 改动涉及桌面壳时，`npm run dev:desktop` 能打开窗口；关闭窗口后进程完全退出（任务管理器中无残留）。
- [ ] 未引入运行时第三方依赖。

---

## 8. 明确不要做的事

- 不要把 `node_modules/`、`releases/`、`dist/`、`data/` 提交进仓库。
- 不要把某个平台的二进制产物放进仓库（按第 2 节在目标系统现场构建）。
- 不要为了省事把服务拆成后台守护进程或常驻托盘。
- 不要在日志中记录明文密钥。
- 不要跳过版本号递增。

---

## 9. Git 提交与 GitHub 协作规范

### 9.1 仓库信息

- 远端：`https://github.com/lizij/LocalAIProxy.git`（公开仓库）
- 主分支：`main`
- 远端已存在一个仅含 `LICENSE` 的初始提交，与本地历史无共同祖先。首次推送必须先 `git fetch origin` 再 `git rebase origin/main`，让本地提交接到远端之后，**严禁用 `--force` 覆盖远端**。

### 9.2 提交信息规范（Conventional Commits）

格式：`<type>(<scope>): <subject>`

| type | 用途 |
| --- | --- |
| `feat` | 新增功能 |
| `fix` | 修复缺陷 |
| `docs` | 仅文档 |
| `refactor` | 重构（不改变外部行为） |
| `build` | 构建/打包脚本或依赖变更 |
| `chore` | 杂项（发布、配置等） |
| `perf` | 性能优化 |
| `test` | 测试相关 |

- `<scope>` 可省略，常用值：`proxy`、`admin`、`log`、`desktop`、`build`、`docs`。
- `<subject>`：动词开头、不超过 50 字、句末不加句号。中英文均可。
- 正文（可选）说明**为什么**改，而不是重复改了哪些文件；关联 issue 用 `Refs #12` / `Closes #12`。
- 破坏性变更：type 后加 `!`（如 `feat(api)!: ...`），并在正文写 `BREAKING CHANGE: ...`。

示例：

```
feat(desktop): 增加 Electron 桌面壳，关窗即退出
fix(proxy): 修复 SSE 长连接导致关服不退出
docs: 同步 DESIGN.md 的打包与版本号规约
chore(release): 0.2.2
```

### 9.3 提交与版本号的关系

- 一个「改动集合 / 一次交付」对应一次版本递增（见第 3 节），不要每次 `git commit` 都改版本号。
- 发布可单独用一个 `chore(release): <version>` 提交收尾。

### 9.4 提交前必查（脱敏红线）

**绝不提交**：

- `data/` 目录——其中的 `config.json` 保存着**上游 Provider 的真实 API Key**，`logs/` 里是带提示词的请求日志；
- 任何 `.env`、令牌、PAT、SSH 私钥、证书；
- `node_modules/`、`dist/`、`releases/`（含各平台二进制产物）。

**流程要求**：

- 提交前先 `git status --short` 看清暂存清单；对可疑内容用 `git diff --cached` 复核。
- 暂存时优先按文件名精确 `git add <file>`，慎用 `git add -A`。
- **远程 URL 中不得内嵌令牌**（如 `https://user:token@github.com/...`）。
- 一旦误提交密钥：**视为已泄露**，立即到服务商吊销该 Key / PAT，再重写历史（`git filter-repo`）并 force-push 清理（仅限非共享分支，且需人工确认）。

### 9.5 标准操作流程

```bash
git status --short                 # 1. 看清将提交什么
git add <具体文件>                  # 2. 精确暂存
git diff --cached                  # 3. 复核差异
git commit -m "feat(scope): 摘要"   # 4. 提交（版本号按第 3 节递增）
git fetch origin                   # 5. 同步远端
git rebase origin/main             # 6. 变基到最新
git push origin main               # 7. 推送（首次可加 -u）
```

**禁止**：向 `main` 强制推送（`--force` / `-f`）；用 `--no-verify` 跳过钩子；提交上述任何红线内容。
