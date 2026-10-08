# AGENTS.md

本文件是本仓库的「代理协作指南」。任何 AI 代理或开发者在本仓库做改动前，必须先读本文件。

---

## 1. 项目是什么

LocalAIProxy：一个 **OpenAI 协议兼容的本地 AI 转发代理**。

- 对外暴露一个本地 BaseURL + APIKey（代理端口，默认 `0.0.0.0:8787`）；
- 把请求**原样透传**到用户配置的任意公开 Provider（多 Provider 可一键切换 + `model` 原样透传，代理不做补全）；
- 提供网页控制台（管理端口，默认 `127.0.0.1:8788`）实时查看**发往 Provider 的请求原文与收到的响应原文**；
- 通过 **Electron** 封装成桌面应用：一个窗口 + 内嵌 Chromium，窗口即服务，关窗即退出，无后台残留。

架构与设计细节见 `docs/DESIGN.md`（本文件只讲「怎么改、怎么发」）。

---

## 2. 命令速查

| 目的 | 命令 |
| --- | --- |
| 命令行模式启动（无 GUI，纯 Node） | `npm start` |
| **测试档**命令行启动（不碰用户 config.json） | `npm run start:test` |
| 本地开发桌面应用 | `npm run dev:desktop` |
| 只打包后端为 `dist/backend.cjs` | `npm run build:backend` |
| 打包当前系统的安装产物 | `npm run dist` |
| 打包 Windows 便携 exe | `npm run dist:win` |
| 打包 macOS dmg | `npm run dist:mac` |
| 打包 Linux AppImage + deb | `npm run dist:linux` |

**打包必须在目标系统上进行**：Windows 产物在 Windows 上构建、macOS 产物在 macOS 上构建、Linux 产物在 Linux 上构建。仓库不提交任何平台的二进制产物。产物统一输出到 `releases/`。

> **Linux 桌面端尚未验证**：目前只在 macOS 上构建过。Linux（AppImage/deb）的数据目录落点未实测，可能落在只读或不可写的路径（详见 `docs/DESIGN.md` §9.3 与 §12 待确认）。首次在 Linux 上构建/运行后，请先确认 `data/` 能正常读写再对外宣称支持。

**国内网络**：Electron 及其打包工具默认从 GitHub 下载，构建前先设镜像（否则会卡在下载或直接失败）：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run dist:win
```

首次 `npm install` 若中断，`node_modules/electron/dist` 可能缺失（postinstall 被跳过）；此时单独补跑：`node node_modules/electron/install.js`。

**开发/测试必须用测试档**：`npm run start:test`（或设 `LOCAL_AI_PROXY_PROFILE=test`）会读写 `data/config-test.json` 与 `data/logs-test/`，**绝不读取或改动用户的 `data/config.json`**。任何验证、联调、截图、接口调用，都必须走测试档。

**动配置前必须先确认 8787/8788 上是谁在跑**：若已有实例占用端口，你发往 `/api/admin/*` 的请求会打到**别人的实例**（曾因此把用户的真实上游配置覆盖成了测试值）。先确认端口空闲，或只用测试档自己启动的实例。

**构建已自动保护用户数据**：`npm run dist:*` 实际执行 `scripts/dist.mjs`，会在 electron-builder 清理 `releases/` **之前**把 `releases/data` 备份到仓库之外的临时目录，构建完成后自动恢复并逐文件校验，校验通过才删除备份。因此**不要手工删除 `releases/data`**，也不要绕过 `scripts/dist.mjs` 直接调用 `electron-builder`。
判断构建是否结束，要按**新版本号产物是否存在**来判断，不能用「`releases/` 下存在任意 exe」——旧版本 exe 一直在，会导致误判。

**换版必须先退旧实例、再清理、后构建**（标准顺序，三系统统一）：

1. **终止旧实例**：结束正在运行的 `LocalAIProxy.app` / `LocalAIProxy.exe` 进程；macOS 若用户是「挂载 dmg 直接双击运行」，还需卸载旧的 `/Volumes/LocalAIProxy *` 卷。
2. **清理旧产物**：只删**旧版本**产物与中间目录、元数据；**当前版本产物必须保留**（用户靠它双击运行）。
3. **递增版本号** → 4. **构建** → 5. **校验产物内含新代码**（解包确认 `public/` 与 `backend` 是新版）→ 6. **启动/提示用户启动新版本**。

> 为什么先退进程再清理：Windows 上正在运行的 exe / 被占用的 `win-unpacked/` 会触发文件锁，导致删除或覆盖失败；若等到**构建中途**才失败，会留下「清了一半」的中间状态，比事先退出更糟。macOS 虽允许删除运行中的 app 文件，但为流程一致与后续启动（单实例锁 + 端口）顺畅，同样按此顺序执行。这些收尾动作（杀进程、卸卷、删旧产物）代理应自行完成，不要推给用户。
>
> 单实例锁导致的「双击新版却看到旧界面」：现在旧实例会弹原生对话框提示两个版本号并可一键退出（见 `docs/DESIGN.md` 9.2），但仍应遵循上面第 1 步主动退出旧实例。

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
11. **配置档隔离**：开发/测试/验证一律走 `test` 档（`LOCAL_AI_PROXY_PROFILE=test`）。`src/config.js` 里已硬性禁止 test 档写入 `config.json`、并强制 test 档日志目录为 `logs-test`——**不要移除这两处保护**，也不要把测试数据写进用户的 `logs/`。

---

## 6. 目录结构（当前）

```
package.json            # 版本号单一来源 + electron-builder 配置 + 脚本
AGENTS.md               # 本文件
docs/DESIGN.md          # 方案设计（重要改动必须同步）
electron/main.cjs       # Electron 主进程：启动服务 + 创建窗口 + 生命周期
scripts/build-backend.mjs  # esbuild 把 src/app.js 打包为 dist/backend.cjs
scripts/start-test.mjs     # 以测试档启动命令行模式（config-test.json / logs-test）
scripts/dist.mjs           # 构建包装：构建前后自动备份/恢复 releases/data
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

- 仓库：`lizij/LocalAIProxy`（GitHub 公开仓库）。两种等价访问地址，**本地用哪种由环境探测决定（见 9.6），不要写死**：
  - HTTPS：`https://github.com/lizij/LocalAIProxy.git`
  - SSH：`git@github.com:lizij/LocalAIProxy.git`
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
git push origin main               # 7. 推送——若失败，按 9.6 探测其他通道
```

**禁止**：向 `main` 强制推送（`--force` / `-f`）；用 `--no-verify` 跳过钩子；提交上述任何红线内容。

### 9.6 推送执行与认证处置

**原则**：提交完成后的推送由代理负责做完（用户已授权代理直接执行 `git push`）。遇到认证/网络问题时，代理**先自行探测并尝试可用通道**，能自动解决就自动解决；只有在所有通道都不可用、或需要用户做授权决定时，才向用户求助，并说明「已试过什么、各自报了什么错、缺什么、建议怎么修」。**不要把「认证失败」直接等同于「交给用户去执行」。**

**标准动作**：`git fetch origin` → `git rebase origin/main` → `git push origin main` → `git ls-remote origin main` 核对远端 SHA 与本地 `git rev-parse HEAD` 一致。

**通道探测（按序，先探测再决定；命令一律带 `GIT_TERMINAL_PROMPT=0` 与超时，避免阻塞等输入）**：

1. 先记录现状：`git remote -v`，确认当前 remote 用的是哪种协议。
2. 探测当前协议能否免交互认证：
   - HTTPS：`printf "protocol=https\nhost=github.com\n\n" | git credential fill`，能返回用户名即视为可用（凭据由系统凭据管理器托管：Windows=Git Credential Manager、macOS=Keychain、Linux=libsecret）。
   - 可用 → 直接推送。
3. HTTPS 不可用 → 探测 SSH：`ssh -o ConnectTimeout=8 -T git@github.com`，返回 `Hi <user>!` 即可用。
4. 仍不可用 → 探测 `gh auth status`（若装了 gh）、`GH_TOKEN` / `GITHUB_TOKEN` 环境变量。
5. 选定通道后推送：
   - **优先用一次性 URL**（如 `git push git@github.com:lizij/LocalAIProxy.git main`），不改动本地 remote 配置，副作用最小；
   - 若用户或工程约定明确希望固化，再 `git remote set-url origin <url>`。
6. 全部通道都用不通（例如需要人工输密码、钥匙串无凭据且本环境无法弹窗）→ **此时才向用户求助**，并给出确切的补救命令（如「请在本机终端执行 `git push` 登录一次，凭据会写入系统凭据管理器」）。

**约束**：不得把令牌内嵌进 URL（见 9.4）；不得对 `main` 强推（`--force`）；探测命令必须带超时，禁止让命令阻塞等待输入；若推送被拒（如远端有新提交），先 `git fetch` 再 `git rebase origin/main`，**不要**用 `--force` 掩盖冲突。
