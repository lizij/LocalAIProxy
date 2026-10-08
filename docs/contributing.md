# 开发协作规范

> 版本号、代码约束、Git / GitHub 协作的**权威说明**。入口与文档路由见 [AGENTS.md](../AGENTS.md)；测试与换版顺序见 [docs/test.md](test.md)。

---

## 1. 版本号规约（重要：自更新）

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

## 2. 代码约束（不要破坏）

1. **运行时零第三方依赖**：`src/` 与 `public/` 只允许使用 Node 内置模块（`node:*`）与浏览器原生 API。第三方包仅可作为 `devDependencies`（构建/打包用）。
2. **ESM**：`src/**` 与 `public/app.js` 使用 ESM；Electron 主进程使用 CJS（`electron/main.cjs`），因其需 `require` 打包后的 `dist/backend.cjs`。
3. **前后端共用一份装配逻辑**：命令行入口与 Electron 主进程都必须通过 `src/app.js` 的 `createApp()` 启动服务，禁止复制粘贴启动代码。
4. **路径可配置**：`LOCAL_AI_PROXY_HOME`（数据目录）、`LOCAL_AI_PROXY_PUBLIC_DIR`（静态页面目录）、`LOCAL_AI_PROXY_VERSION`（版本号）三个环境变量是桌面模式与命令行模式的契约，改动时需同步 `electron/main.cjs`。特别注意 **`LOCAL_AI_PROXY_PUBLIC_DIR` 必须在打包与开发两种模式下都显式注入**：后端会被 esbuild 打成 CJS，此时 `import.meta.url` 失效，程序无法自行推断 `public/` 的位置（曾因此出现「开发模式打开窗口后页面 404」的问题）。
5. **跨平台**：一律 `node:path` 处理路径，不写死分隔符；不依赖平台特有的 shell 命令。
6. **无 daemon / 单实例**：Electron 侧保持「关窗即退出」与 `requestSingleInstanceLock()`；不要引入托盘常驻、开机自启、后台守护等行为。
7. **关服必须强制断开存量连接**：`src/app.js` 的 `stop()` 里除了 `server.close()`，还必须调用 `server.closeAllConnections()` 并叠加超时兜底。原因是控制台页面持有 SSE 长连接，`server.close()` 的回调会一直不触发，导致「端口释放了但进程不退出」。修改关闭逻辑时务必保持这一点。
8. **国内构建需设镜像**：Electron 及其打包工具默认走 GitHub，构建前需设置 `ELECTRON_MIRROR` 与 `ELECTRON_BUILDER_BINARIES_MIRROR`（见 [docs/build.md](build.md) §5）。
9. **安全默认值**：日志中的密钥一律打码；管理端口默认只监听 `127.0.0.1`；代理端口对局域网开放时保持 `requireClientKey: true`。
10. **不要再造路由框架**：`node:http` 手写路由已足够，不要为几个接口引入 Express/Fastify。
11. **配置档隔离**：开发/测试/验证一律走 `test` 档（`LOCAL_AI_PROXY_PROFILE=test`）。`src/config.js` 里已硬性禁止 test 档写入 `config.json`、并强制 test 档日志目录为 `logs-test`——**不要移除这两处保护**，也不要把测试数据写进用户的 `logs/`。

---

## 3. 明确不要做的事

- 不要把 `node_modules/`、`releases/`、`dist/`、`data/` 提交进仓库。
- 不要把某个平台的二进制产物放进仓库（见 [docs/build.md](build.md) 在目标系统现场构建）。
- 不要为了省事把服务拆成后台守护进程或常驻托盘。
- 不要在日志中记录明文密钥。
- 不要跳过版本号递增。

---

## 4. Git 提交与 GitHub 协作规范

### 4.1 仓库信息

- 仓库：`lizij/LocalAIProxy`（GitHub 公开仓库）。两种等价访问地址，**本地用哪种由环境探测决定（见 4.6），不要写死**：
  - HTTPS：`https://github.com/lizij/LocalAIProxy.git`
  - SSH：`git@github.com:lizij/LocalAIProxy.git`
- 主分支：`main`
- 远端已存在一个仅含 `LICENSE` 的初始提交，与本地历史无共同祖先。首次推送必须先 `git fetch origin` 再 `git rebase origin/main`，让本地提交接到远端之后，**严禁用 `--force` 覆盖远端**。

### 4.2 提交信息规范（Conventional Commits）

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
docs: 同步 docs/design.md 的打包与版本号规约
chore(release): 0.2.2
```

### 4.3 提交与版本号的关系

- 一个「改动集合 / 一次交付」对应一次版本递增（见 §1），不要每次 `git commit` 都改版本号。
- 发布可单独用一个 `chore(release): <version>` 提交收尾。

### 4.4 提交前必查（脱敏红线）

**绝不提交**：

- `data/` 目录——其中的 `config.json` 保存着**上游 Provider 的真实 API Key**，`logs/` 里是带提示词的请求日志；
- 任何 `.env`、令牌、PAT、SSH 私钥、证书；
- `node_modules/`、`dist/`、`releases/`（含各平台二进制产物）。

**流程要求**：

- 提交前先 `git status --short` 看清暂存清单；对可疑内容用 `git diff --cached` 复核。
- 暂存时优先按文件名精确 `git add <file>`，慎用 `git add -A`。
- **远程 URL 中不得内嵌令牌**（如 `https://user:token@github.com/...`）。
- 一旦误提交密钥：**视为已泄露**，立即到服务商吊销该 Key / PAT，再重写历史（`git filter-repo`）并 force-push 清理（仅限非共享分支，且需人工确认）。

### 4.5 标准操作流程

```bash
git status --short                 # 1. 看清将提交什么
git add <具体文件>                  # 2. 精确暂存
git diff --cached                  # 3. 复核差异
git commit -m "feat(scope): 摘要"   # 4. 提交（版本号按 §1 递增）
git fetch origin                   # 5. 同步远端
git rebase origin/main             # 6. 变基到最新
git push origin main               # 7. 推送——若失败，按 4.6 探测其他通道
```

**禁止**：向 `main` 强制推送（`--force` / `-f`）；用 `--no-verify` 跳过钩子；提交上述任何红线内容。

### 4.6 推送执行与认证处置

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

**约束**：不得把令牌内嵌进 URL（见 4.4）；不得对 `main` 强推（`--force`）；探测命令必须带超时，禁止让命令阻塞等待输入；若推送被拒（如远端有新提交），先 `git fetch` 再 `git rebase origin/main`，**不要**用 `--force` 掩盖冲突。