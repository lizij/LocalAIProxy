# LocalAIProxy

**OpenAI 协议兼容的本地 AI 转发代理**——对外提供一个本地 BaseURL + APIKey，把请求原样透传给任意公开 AI Provider，并用网页实时展示「发出去的请求原文」和「收到的响应原文」。

> 适合场景：不透明的 agent 工具只认一个 OpenAI 兼容入口，而你想换成 DeepSeek 等任意 Provider，同时想看清理它到底发了什么。

---

## 它解决什么问题

- 很多 AI 工具（agent / CLI / 客户端）只允许填一个 `base_url` + `api_key`，无法自由切换 Provider；
- 出问题时看不到工具实际发出的请求，难以排查；
- 自建 Provider 又希望局域网内其他机器也能共用。

LocalAIProxy 把这三件事一次解决：**统一入口 + 原样透传 + 全程可见**。

## 特性

| 能力 | 说明 |
| --- | --- |
| OpenAI 兼容入口 | 提供 `/v1/*`，`model` 原样透传，URL 自动避免 `/v1/v1` 重复 |
| 流式转发 | 完整支持 SSE，逐块实时转发，不做缓冲 |
| 省 Token | 客户端断开连接时立即中止上游请求 |
| 访问控制 | 客户端需携带本地 API Key（常量时间比较）；日志中的密钥一律打码 |
| 请求看得懂 | 每条记录展开后**先给「摘要」卡片**：谁发的、发给了谁、说了什么、模型回了什么、token 用量多少——普通用户一眼能看懂；摘要之下才是可复制的原始报文 |
| 多 Provider 切换 | 可配置多个上游 Provider，网页上一键切换当前使用的一个（类似 ccswitch），切换即时生效、无需重启；旧版单上游配置自动迁移 |
| 请求日志 | 网页实时滚动展示最近 1000 条记录，支持搜索、状态过滤与历史回看；展开的长日志头部**吸顶**，随时可点击收起 |
| 日志不丢 | 内存优先读取 + 异步追加 JSONL 落盘，按天/按大小轮转，支持按日期回看 |
| 免命令行验证 | 网页内「保存并测试」支持**两条路径**并会标明用了哪条：**直连上游**（只验证 Provider 配置）或**经本地代理**（验证端到端链路），结果在页面内流式渲染 |
| 桌面端 | Electron + 内嵌 Chromium，三系统渲染一致；单实例、可最小化、**关窗即退出，无后台残留** |
| 跨平台 | Windows / macOS / Linux；运行时零第三方依赖（仅 Node 内置模块） |

---

## 快速开始

### 方式一：桌面端（推荐）

仓库**不提交任何二进制产物**，需在本机构建（见 [从源码构建](#从源码构建)）。构建后直接双击运行产物：

- Windows：`releases/LocalAIProxy-<版本>-win-portable.exe`（便携版，双击即用，不写注册表）
- macOS：`releases/LocalAIProxy-<版本>-mac.dmg`
- Linux：`releases/LocalAIProxy-<版本>-linux.AppImage`

启动后会自动打开窗口，窗口关闭时服务与进程一并退出。

> **同一时间只允许一个实例**。若在旧实例仍在运行时启动新版本，**旧窗口**会弹出原生提示（同时显示「已在运行的版本」与「你刚启动的版本」），可选择「退出当前实例」；确认退出后重新启动新版本即可。若两个版本号相同，则只把已有窗口切到前台，不打扰你。

### 方式二：命令行模式（无 GUI）

需要 **Node.js >= 20**：

```bash
git clone https://github.com/lizij/LocalAIProxy.git
cd LocalAIProxy
npm start
```

启动后终端会打印代理地址、局域网地址、客户端 API Key 与管理页地址。

---

## 使用

1. 打开网页控制台：`http://127.0.0.1:8788`，页面分为 **上游 Provider** / **请求日志** / **本地接入** 三个 tab。首次使用（还没有任何 Provider）会直接停在上游 Provider tab。
2. 在「**上游 Provider**」tab 点「**+ 新增 Provider**」，填写：

   | 字段 | 示例 |
   | --- | --- |
   | 名称 | `DeepSeek` |
   | Base URL | `https://api.deepseek.com` |
   | API Key | 你在该 Provider 申请的 Key |
   | Model（兜底） | `deepseek-chat` |

   保存后列表里会出现这张卡片，并自动设为**使用中**。可以继续新增多个 Provider（如 Kimi、OpenAI），之后**点击任意卡片即可切换当前使用的一个**，切换即时生效、无需重启；卡片右侧的「编辑 / 删除」用于修改或移除。

3. 选择「**测试路径**」后点「**保存并测试**」，会针对**当前启用的 Provider** 真实请求一次并流式渲染回复：

   | 测试路径 | 含义 | 用途 |
   | --- | --- | --- |
   | **直连上游** | 绕过本地代理，直接打上游的 `/v1/chat/completions` | 只验证 Provider 的 Base URL / API Key / Model 是否正确 |
   | **经本地代理** | 打本机 `http://127.0.0.1:8787/v1/chat/completions` 并带本地 Key | 验证端到端链路：**本地 Key 鉴权 → 转发 → 日志落库** |

   测试结果上方会标明**实际走的是哪条路径**（`✓ 直连上游 · …` / `✓ 经本地代理 · …`）。不确定用哪个时：先「直连上游」确认 Provider 没问题，再「经本地代理」确认真实客户端调用也能通。
4. 在「**请求日志**」tab 里点开任意一条：**先看「摘要」卡片**（模型、消息、回复内容、token 用量），需要细节时再往下看「原始报文」（密钥已打码，可一键复制/下载）。展开的长日志在滚动时头部会吸顶，随时可再点它收起。
5. 把 AI 工具的入口指向本代理，例如：

   ```bash
   OPENAI_BASE_URL=http://127.0.0.1:8787/v1
   OPENAI_API_KEY=<网页「本地接入」tab 里的 sk-local-...>
   ```

   Python SDK 示例：

   ```python
   from openai import OpenAI

   client = OpenAI(
       base_url="http://127.0.0.1:8787/v1",
       api_key="sk-local-xxxxxxxx",  # 本地 Key，不是上游 Key
   )
   print(client.chat.completions.create(
       model="deepseek-chat",
       messages=[{"role": "user", "content": "你好"}],
   ).choices[0].message.content)
   ```

### 局域网共用

代理默认监听 `0.0.0.0:8787`，局域网其他机器直接使用即可：

```
OPENAI_BASE_URL=http://<本机局域网IP>:8787/v1
```

启动时会打印可用的局域网地址。若连不通，请放行防火墙的 **8787** 端口。

> 管理页默认只监听 `127.0.0.1:8788`（因为页面会暴露完整请求/响应内容）。确实需要远程查看时，再改 `admin.host` 并设置管理口令。

---

## 配置

配置保存在数据目录下的 `config.json`，**首次启动自动生成**，也可直接在网页上修改（Provider 相关配置保存后即时生效）。旧版本用的是单一 `upstream` 对象，升级后启动时会**自动迁移**为 `providers` 列表（无需手工改配置）。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `proxy.host` / `proxy.port` | `0.0.0.0` / `8787` | 代理监听地址（局域网入口） |
| `proxy.apiKey` | 自动生成 | 客户端访问本代理所需的 Key |
| `proxy.requireClientKey` | `true` | 是否校验客户端 Key（局域网开放时建议保持开启） |
| `proxy.maxBodyBytes` | 32 MB | 单次请求体上限 |
| `proxy.connectTimeoutMs` | 15000 | 连接上游超时 |
| `proxy.requestTimeoutMs` | 300000 | 上游空闲超时 |
| `admin.host` / `admin.port` | `127.0.0.1` / `8788` | 管理页监听地址 |
| `admin.password` | 空 | 管理口令；`admin.host` 非本机时必填 |
| `providers[]` | 空 | 上游 Provider 列表，每项含 `id`/`name`/`baseUrl`/`apiKey`/`model`/`insecureTLS`；网页上可新增/编辑/删除 |
| `providers[].model` | 空 | 该 Provider 的兜底模型（仅当请求未携带 `model` 时使用） |
| `providers[].insecureTLS` | `false` | 跳过该上游的证书校验（仅自签证书场景） |
| `activeProviderId` | 空 | 当前启用的 Provider `id`；转发时使用它，找不到则回落到列表首项 |
| `log.memorySize` | 1000 | 内存中保留的日志条数（网页滚动窗口） |
| `log.dir` | `logs` | 日志目录（相对数据目录） |
| `log.maxFileSizeMB` | 64 | 单个日志文件上限，超过即轮转 |
| `log.maxDays` | 7 | 日志保留天数 |

### 数据目录

| 运行方式 | 数据目录 |
| --- | --- |
| 桌面端 · Windows 便携版 | exe 同级的 `data/` 目录 |
| 桌面端 · macOS | `~/Library/Application Support/LocalAIProxy/data` |
| 命令行模式 | 当前工作目录下的 `data/` |

可用环境变量 `LOCAL_AI_PROXY_HOME` 覆盖。命令行模式与 Windows 便携版都**刻意不使用系统用户目录**，以保证行为一致、整个目录可搬移；macOS 桌面端因 app 包内部不可写（dmg 直接运行时为只读挂载），改用系统标准用户数据目录（见上表）。**数据目录里含上游密钥与请求日志，请勿提交到仓库。**

数据目录内按「配置档」隔离用户数据与开发测试数据：

| 档位 | 启用方式 | 配置文件 | 日志目录 | 用途 |
| --- | --- | --- | --- | --- |
| 用户档（默认） | 无需设置 | `config.json` | `logs/` | 你的真实使用 |
| 测试档 | `LOCAL_AI_PROXY_PROFILE=test`（或 `npm run start:test`） | `config-test.json` | `logs-test/` | 开发 / 联调 |

测试档**永远不会读写你的 `config.json`**；首次启动时它会从 `config.json` **只读**复制一份结构配置（含上游信息，便于直连真实 Provider 联调），但日志写入独立的 `logs-test/`，不会污染你的历史日志。

---

## 从源码构建

```bash
npm install
```

然后按目标系统执行：

| 命令 | 产物 | 必须在哪个系统执行 |
| --- | --- | --- |
| `npm run dist:win` | Windows 便携版 exe | Windows |
| `npm run dist:mac` | macOS dmg | macOS |
| `npm run dist:linux` | Linux AppImage + deb | Linux |

其他脚本：

```bash
npm start              # 命令行模式（用户档）
npm run start:test     # 命令行模式（测试档：config-test.json / logs-test）
npm run dev:desktop    # 本地开发桌面端
npm run build:backend  # 只把后端打成 dist/backend.cjs
```

> `dist:*` 实际由 `scripts/dist.mjs` 执行：它会在 electron-builder 清理 `releases/` 之前，先把 `releases/data`（你的真实配置与日志）备份到仓库之外，构建完成后自动恢复并校验，所以**重建 exe 不会丢你的数据**。

**国内网络**：Electron 及其打包工具默认从 GitHub 下载，可能失败，先设置镜像：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run dist:win
```

若 `npm install` 中断导致 `node_modules/electron/dist` 缺失，单独补跑：`node node_modules/electron/install.js`

**macOS 提示**：dmg 产物未签名、未公证，首次打开会被 Gatekeeper 拦截。请右键点按应用图标选择「打开」，或执行：

```bash
xattr -dr com.apple.quarantine /Applications/LocalAIProxy.app
```

---

## 目录结构

```
src/
  index.js          # 命令行入口
  app.js            # 应用装配（命令行与桌面共用）
  config.js         # 配置读写 / 默认值 / 密钥打码
  version.js        # 版本号
  proxy/            # 代理端口：server / forward / auth
  log/              # 日志：store（Ring Buffer + JSONL）/ reader
  admin/            # 管理端口：server / http / test
electron/main.cjs   # 桌面端主进程：启动服务 + 窗口生命周期
public/             # 网页控制台（原生 HTML/CSS/JS，无构建）
scripts/            # 构建脚本
docs/DESIGN.md      # 方案设计
AGENTS.md           # 协作指南（命令、版本规约、代码约束、Git 规范）
```

### 端口一览

| 端口 | 用途 | 是否对局域网开放 |
| --- | --- | --- |
| 8787 | OpenAI 兼容代理 `/v1/*`、`/health` | 是（默认，需客户端 Key） |
| 8788 | 网页控制台与管理 API | 否（默认仅本机） |

---

## 安全说明

- 上游 API Key 只保存在本机 `config.json`，**不会写入日志**，转发日志中的 `authorization` 一律打码；
- 管理页默认仅本机可访问；对外暴露时必须设置 `admin.password`；
- 代理端对局域网开放时，请保持 `proxy.requireClientKey: true`；
- 数据目录包含敏感提示词，建议保持为当前用户私有权限。

## 版本号

采用标准 semver 三位，**单一来源是 `package.json` 的 `version`**，并自动展示在网页控制台右下角角标、桌面端窗口标题、`/health` 与 `/api/admin/status` 的 `version` 字段中。

## 文档

- [docs/DESIGN.md](docs/DESIGN.md) —— 架构、模块设计、接口、构建与决策记录
- [AGENTS.md](AGENTS.md) —— 命令速查、版本规约、代码约束、Git/GitHub 协作规范

## License

[Apache License 2.0](LICENSE)
