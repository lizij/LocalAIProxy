# LocalAIProxy 方案设计

> 一个 OpenAI 协议兼容的本地 AI 转发代理：对外提供本地 BaseURL + APIKey，对内把请求透明转发到任意公开 AI Provider，并提供网页实时查看请求/响应原文。

---

## 1. 项目定位

解决的核心问题：**不透明的 agent 工具只会认一个 OpenAI 兼容入口，而你想用 DeepSeek 等任意 Provider，并且想看清工具到底发了什么。**

- 一台机器（或局域网内多台机器）把请求发到本服务；
- 本服务把请求**原样转发**给用户配置的上游 Provider；
- 用户通过浏览器实时看到「发出去的请求原文」和「收到的响应原文」。

---

## 2. 需求确认结论

| 编号 | 需求 | 结论 |
| --- | --- | --- |
| 1 | 本地 Provider 服务，有独立 BaseURL/APIKey，支持局域网连接 | 监听 `0.0.0.0`，客户端用本地 Key 鉴权 |
| 2 | 转发到任意公开 Provider（用户填 baseurl/apikey/model） | **单 Provider + model 透传**（客户端传什么 model 就透传什么） |
| 3 | 网页滚动展示最近 1000 条请求原文 | 记录**请求原文 + 响应原文**；内存滚动窗口 1000 条 |
| 4 | 跨 Windows / Linux / macOS | 纯 Node.js + 仅内置模块，零原生依赖 |
| 5 | 技术不限，优先兼容性与部署便利，建议 Node.js | **Node.js >= 20（推荐 20 LTS / 22），零第三方依赖** |
| 6 | （用户补充）日志不丢、可随时回看 | **内存优先读取 + 异步落盘 JSONL**，可加载历史文件回看 |

---

## 3. 总体架构

```
┌──────────────────┐        ┌──────────────────────────────────────────┐        ┌──────────────────┐
│  Agent 工具       │        │            LocalAIProxy (单进程)           │        │  上游 Provider    │
│ (不透明客户端)     │        │                                          │        │  (DeepSeek/...)   │
│                  │  HTTP  │  ┌───────────────┐   ┌────────────────┐   │  HTTPS │                  │
│ base_url =        ├───────►│  │ 代理端口 8787  │──►│  转发器(tee)    │───┼───────►│ api.deepseek.com │
│  http://<ip>:8787│ /v1/*  │  │ (0.0.0.0)     │   │ 转发+抓取原文   │   │        │                  │
│ api_key = 本地Key │        │  └───────┬───────┘   └───────┬────────┘   │◄───────┤                  │
└──────────────────┘        │          │ 写入              │ 写入        │        └──────────────────┘
                            │          ▼                   ▼            │
                            │   ┌────────────────────────────────────┐  │
┌──────────────────┐        │   │  日志核心                          │  │
│  浏览器           │        │   │  Ring Buffer(内存 1000 条)          │  │
│  (用户/开发者)     │◄──────►│   │  + 异步追加 JSONL 文件(可回看)       │  │
│                  │ 管理端口 │   └────────────────────────────────────┘  │
│  http://          │ 8788   │  ┌───────────────┐                        │
│   127.0.0.1:8788 │        │  │ 管理/Web 端口  │                        │
│                  │        │  │ (127.0.0.1)   │                        │
└──────────────────┘        │  └───────────────┘                        │
                            └──────────────────────────────────────────┘
```

**双端口设计（已确认）**

| 端口 | 默认地址 | 用途 | 鉴权 |
| --- | --- | --- | --- |
| 代理端口 | `0.0.0.0:8787` | 对局域网客户端提供 `/v1/*` OpenAI 兼容接口 | 校验客户端 `Authorization: Bearer <本地Key>` |
| 管理端口 | `127.0.0.1:8788` | 网页 UI、配置管理、日志查询与实时推送 | 默认仅本机可访问 + 管理口令 |

> 为什么拆两个端口：管理页面会暴露**完整请求/响应内容**（可能含敏感提示词），默认只绑本机最安全。需要远程看日志时，把 `admin.host` 改为 `0.0.0.0` 并设置管理口令即可。
> 若你更想要单端口（简单），可改为同端口按路径区分：`/v1/*` 为代理、`/` 与 `/api/admin/*` 为管理。

---

## 4. 技术选型

**结论：Node.js >= 20，零第三方运行时依赖，只用 `node:` 内置模块。**

| 关注点 | 方案 | 理由 |
| --- | --- | --- |
| HTTP 服务 | 内置 `node:http` | 无依赖；对 SSE 透传控制最直接 |
| 上游请求 | 内置全局 `fetch`（Node 21+ 稳定；Node 20 可用但会打印实验性警告，必要时改用 `node:https`） | 流式响应体可直接 `for await` 逐块读取并透传 |
| Web UI | 原生 HTML/CSS/JS 静态文件，**无构建步骤** | 跨平台部署最省事，clone 即可跑 |
| 实时推送 | SSE（`text/event-stream`） | 服务端→浏览器单向推送足够；比 WebSocket 更简单 |
| 日志落盘 | 内置 `node:fs` 写流 + 自实现按大小/日期轮转 | 避免引入轮转库；逻辑很短 |
| 配置存储 | 单个 JSON 文件 | 跨平台、可手改、易备份 |

不选的方案及原因：

- **Express / Fastify**：仅路由功能，零依赖手写路由已足够，减少部署体积与版本风险。
- **pkg 打包**：官方已于 2024 年归档弃用。若将来要免安装单文件，用官方 **Node SEA**（Node 22+ 稳定）或 Bun `--compile`；本期按「纯 Node 运行」实现，打包留作可选增强。
- **Go / Python**：跨平台可行但需要各自工具链；Node 最贴合「部署便利 + 无编译」。

---

## 5. 目录结构

```
LocalAIProxy/
├─ package.json               # 版本号单一来源 + electron-builder 配置 + 脚本
├─ AGENTS.md                  # 代理协作指南（命令、版本规约、约束、Git 规范）
├─ README.md                  # 项目说明（面向使用者：快速开始、配置、构建）
├─ LICENSE                    # Apache-2.0
├─ .gitignore
├─ docs/
│  └─ DESIGN.md               # 本文件
├─ electron/
│  └─ main.cjs                # Electron 主进程：启动服务 + 创建窗口 + 生命周期
├─ scripts/
│  └─ build-backend.mjs       # esbuild 把 src/app.js 打包成 dist/backend.cjs
├─ src/
│  ├─ index.js                # 命令行入口（无 GUI）
│  ├─ app.js                  # 应用装配：createApp()，命令行与桌面共用
│  ├─ version.js              # 版本号解析（package.json / 环境变量）
│  ├─ config.js               # 配置读写/校验/默认值/密钥打码
│  ├─ proxy/
│  │  ├─ server.js            # 代理端口 HTTP 服务（/v1/* + /health + CORS）
│  │  ├─ forward.js           # 请求转发核心（含流式 tee、断开中止）
│  │  └─ auth.js              # 客户端 Key 校验
│  ├─ log/
│  │  ├─ store.js             # Ring Buffer + 异步 JSONL 落盘 + 轮转
│  │  └─ reader.js            # 历史文件读取（分页/按日期）
│  └─ admin/
│     ├─ server.js            # 管理端口 HTTP 服务 + REST API + SSE 推送 + 口令登录
│     ├─ http.js              # json / readJson 小工具
│     └─ test.js              # 网页「保存并测试」：直连上游发一次真实请求
├─ public/                    # 网页控制台（原生 HTML/CSS/JS，无构建）
│  ├─ index.html
│  ├─ app.js
│  └─ style.css
├─ dist/                      # 构建产物：backend.cjs（git 忽略）
├─ releases/                  # 打包产物（git 忽略）
└─ data/                      # 运行时数据，即 HOME（git 忽略）
   ├─ config.json
   └─ logs/                   # 相对 HOME
      ├─ 2026-10-07.jsonl
      └─ 2026-10-07.1.jsonl
```

---

## 6. 模块设计

### 6.1 代理转发模块（核心）

**通用透传**：代理端口接收 `/v1/*` 的所有方法（GET/POST），把方法、路径、查询串、请求体、请求头转发到上游。

- **URL 拼接**：`activeProvider.baseUrl` + 请求路径（例如 `https://api.deepseek.com` + `/v1/chat/completions`）。注意处理 baseurl 末尾是否带 `/`、是否已含 `/v1`。
- **多 Provider 与启用切换**：配置里维护一个 Provider 列表（`providers[]`）与一个启用指针（`activeProviderId`）。转发时始终取**当前启用的那个** Provider（指针失效则回落到列表首项）；每条请求都实时读配置，因此网页上切换 Provider **即时生效、无需重启**。
- **请求头处理**：
  - 覆盖 `Authorization: Bearer <当前启用 Provider 的 APIKey>`（客户端带来的本地 Key **不转发**给上游）；
  - 透传 `Content-Type`、`Accept`、`User-Agent` 等业务头；
  - 剥离 `Host`（由 fetch 依目标 URL 自动生成）、`Content-Length`（由 fetch 重新计算）、`Connection`、`Transfer-Encoding` 等逐跳头。
- **model 透传**：请求体中的 `model` 原样保留，不替换。Provider 的 `model` 仅作**兜底**：当请求体未提供 `model` 时补上，并用于网页示例展示。
- **流式（SSE）透传**：
  1. 判断上游响应 `Content-Type` 是否 `text/event-stream`；
  2. 设定响应头 `Content-Type: text/event-stream`、`Cache-Control: no-cache, no-transform`、`Connection: keep-alive`、`X-Accel-Buffering: no`；
  3. 用 `for await (const chunk of upstream.body)` 逐块 `res.write(chunk)`，**同时累积到缓冲用于日志**；
  4. 结束后 `res.end()`。
- **客户端断开时中止上游**：监听 `res.on('close')`，若未正常结束，则 `AbortController.abort()` 掉上游请求，避免无谓的 token 消耗。
- **超时**：连接超时与总超时可配置（默认连接 15s、总超时较宽松以适配长回复；流式场景用心跳/空闲超时）。
- **错误处理**：上游 4xx/5xx 原样透传状态码与响应体；网络异常返回 OpenAI 风格的错误 JSON（`{"error": {...}}`），保证客户端能识别。
- **透传的其余端点**：`GET /v1/models`、`/v1/completions`、`/v1/embeddings` 等一并透传，无需逐个特判。

### 6.2 鉴权模块

- **客户端鉴权**（代理端口）：读取 `Authorization: Bearer <key>`（兼容 `api-key` 头），与配置中的本地 Key 比对；不匹配返回 `401` + OpenAI 风格错误体。
- 本地 Key 支持网页生成/重置。
- **管理鉴权**（管理端口）：默认仅本机可访问；若对外暴露（`admin.host` 改为 `0.0.0.0`），则要求口令登录（见第 7 节 `/api/admin/login`，登录后以 Cookie/Token 保持会话）。

### 6.3 日志模块（内存优先 + 异步落盘）

**写入路径（关键：不能拖慢转发，且请求必须即时可见）**

采用**两阶段记录**，避免长流式响应把「请求原文」也拖到响应结束才显示：

```
① 收到请求（转发前）
   组装记录 status="pending" → push 到 Ring Buffer（同步 O(1)，网页立即看到请求原文）
② 响应结束 / 出错
   补充 response 字段、status 置为 "done"/"error"、填 durationMs
   → 更新 Ring Buffer 中同 id 记录（网页实时刷新为最终态）
   → writeStream.write(JSON 一行)（异步缓冲落盘，不 await）
```

- **Ring Buffer**：固定容量（默认 1000，可配置），超出即覆盖最旧记录；每条记录带自增 `seq` 便于前端增量拉取，用 `id` 关联两阶段更新。
- **落盘时机**：仅在请求**结束时写入一次**（最终态）。若进程在流式过程中异常退出，未完成的请求不会落盘（已提前说明，属可接受权衡）；如需强一致可改为「开始/完成」两行并按 id 合并，本期不做。
- **异步落盘 JSONL**：`fs.createWriteStream(path, {flags:'a'})`，每行一个 JSON 对象；进程退出时 `flush`，避免丢尾。
- **轮转**：单文件超过 `maxFileSize`（默认 64MB）时切换到 `YYYY-MM-DD.N.jsonl`；按 `maxDays`（默认 7 天）清理过期文件。
- **脱敏**：日志中的 `Authorization`、上游 APIKey **一律打码**，只记 `Bearer ***`；本地 Key 同理。这是默认行为，不提供「记录明文密钥」开关，避免误泄露。
- **历史回看**：管理端可从内存读取最新窗口，也可指定日期/文件从磁盘分页读取。

**日志记录结构（单条）**

```jsonc
{
  "seq": 1287,                       // 自增序号（前端增量拉取用）
  "id": "0f3a...",                   // uuid（两阶段更新以 id 关联）
  "status": "done",                  // pending | done | error
  "ts": "2026-10-07T02:31:11.482Z",  // 开始时间
  "durationMs": 1843,                // 总耗时（结束时有值）
  "client": { "ip": "192.168.1.20", "ua": "python-requests/2.31" },
  "request": {
    "method": "POST",
    "url": "https://api.deepseek.com/v1/chat/completions",
    "headers": { "content-type": "application/json", "authorization": "Bearer ***" },
    "body": { "model": "deepseek-chat", "messages": [/* ...原文... */], "stream": true }
  },
  "response": {
    "status": 200,
    "headers": { "content-type": "text/event-stream" },
    "body": "data: {...}\n\ndata: {...}\n\n...",   // 流式则记录拼接后的 SSE 原文
    "stream": true,
    "usage": { "prompt_tokens": 12, "completion_tokens": 88 }  // 若能解析则附带
  },
  "error": null                       // 出错时填 { message, code }
}
```

> 说明：`body` 对 JSON 请求存**解析后的对象**便于前端折叠查看，同时保留 `raw` 字面量可选；响应流式内容存拼接后的 SSE 文本，前端可分片展开。

### 6.4 实时推送（管理端）

- `GET /api/admin/logs/stream?since=<seq>`：SSE 长连接，新日志产生即推送（含 `seq`）；支持带 `since` 补偿断线期间的记录。同一条记录会先后推送两次（`pending` 与 `done`/`error`），前端按 `id` 合并更新。
- 前端默认展示最近 1000 条（内存窗口），自动滚动；可暂停、搜索、按状态码/耗时过滤。

### 6.5 Web 管理界面

单页，无构建。分为三个 tab（**上游 Provider** / **请求日志** / **本地接入**）：首页判定为「尚未配置任何 Provider → 停在 上游 Provider tab；已配置 → 停在 请求日志 tab」，并记住用户上次选择（`localStorage`）。功能：

1. **实时日志流**：滚动列表，点击展开查看。展开后**先给「摘要」卡片**——用普通用户能看懂的方式列出：发送了什么（模型、流式与否、消息条数与每条 role/内容、其它参数）、目标地址、收到了什么（HTTP 状态、耗时、finish_reason、助手回复、思考内容）、以及 token 用量（输入/输出/合计、缓存命中、思考 token）。摘要之后是**原始报文**（元信息 / 正文分块，含复制全文 / 下载）。
   渲染原则是**绝不裁剪**：短内容完整撑开显示；超长内容默认折叠为 17em 高并加渐隐遮罩，同时给出明确的「**展开全部（N 字符 · M 行）**」按钮，点击后完整撑开、不再有内层滚动。
   > 布局陷阱（曾导致“内容被截断且滚不到”）：列表 `.log-list` 是 flex 纵列容器，条目 `.log-item` 又设了 `overflow: hidden`。此时条目的自动最小尺寸会变成 0，被 flex 收缩压扁，超出部分被 `overflow: hidden` 悄悄裁掉，且父容器 `scrollHeight` 被算成等于 `clientHeight`，**连滚动条都不出现**。因此 `.log-item` 必须写 `flex: none`；历史查看面板额外放开 `max-height`。
2. **多 Provider 配置**：卡片列表展示全部 Provider，点击卡片即切换「当前启用」的一项（高亮 + 「使用中」标签），另可新增 / 编辑 / 删除。每个 Provider 含 名称、Base URL、API Key、兜底 model、是否跳过证书校验。保存后即时生效：转发模块每条请求实时读配置，切换无需重启。
   > 展开的长日志条目，其头部 `.log-head` 用 `position: sticky; top: 0` 吸附在日志滚动容器顶部——因为条目本身很高时，用户仍能随时点头部把它收起。因此 `.log-item` **不能**再设 `overflow: hidden`（否则会成为 sticky 的裁剪/参照容器而使吸顶失效），改为仅保留 `flex: none`。
3. **网页内测试（两条路径，界面上可选、结果里会标明用了哪条）**：均由「保存并测试」触发，测试结果在页面内流式渲染（含状态码与 token 用量）。
   - **直连上游**（`via=upstream`，默认）：绕过本地代理直接打上游 `/v1/chat/completions`，只用于验证 Provider 的 baseUrl / apiKey / model 是否正确；该次请求以 `admin:test(直连上游)` 记为一条日志。
   - **经本地代理**（`via=proxy`）：打本机 `http://127.0.0.1:<proxyPort>/v1/chat/completions` 并携带**本地 Key**，验证端到端链路（本地 Key 鉴权 → 转发 → 日志落库）。此时不在此处重复记日志，由代理自身记录，日志里能看到一条真实的客户端请求。
4. **本地 Key 管理**：查看/重置客户端访问 Key，一键复制示例 base_url。
5. **服务状态**：监听地址、请求计数、最近错误、日志文件列表与历史加载。

### 6.6 配置模块（配置档 / profile）

数据根目录固定为 `<cwd>/data`（可由 `LOCAL_AI_PROXY_HOME` 覆盖）——**刻意不使用系统用户目录**，以保证三系统行为一致、目录可整体搬移。

在该目录下用「配置档」隔离用户数据与开发测试数据：

| 档位 | 如何启用 | 配置文件 | 日志目录 | 用途 |
| --- | --- | --- | --- | --- |
| `user`（默认） | 不设环境变量 | `data/config.json` | `data/logs/` | 用户真实使用 |
| `test` | `LOCAL_AI_PROXY_PROFILE=test` | `data/config-test.json` | `data/logs-test/` | 开发 / 联调 / agent 验证 |

- **`test` 档永远不会写 `user` 档的 `config.json`**（`ConfigStore.#persist` 里有硬性拒绝写入的兜底）。
- `test` 档首次生成时，从 `config.json` **只读**复制一份可用的结构性配置：`proxy` 端口等结构项、`admin.host/port`、`log` 设置、`providers` 全部（**含 apiKey**，便于用真实 provider 联调）；**不复制**本地客户端 Key（测试档新生成，便于区分）与管理口令；日志目录强制为 `logs-test`。
- 启动时会醒目打印当前档位、配置文件与日志目录；状态接口也返回 `profile`，网页右下角角标在测试档会显示「· 测试档」。
- 网页修改后写回并热更新（转发模块读取最新配置）。
- 解析配置文件时会**先剥离 UTF-8 BOM**：Windows 记事本与 PowerShell 5.1 的 `Set-Content -Encoding utf8` 都会写入 BOM，而 `JSON.parse` 遇到 BOM 会直接抛错，曾导致「用户手改过配置后程序静默回退到默认配置、看起来像配置丢失」。
- 解析失败时会先把原文件备份为 `config.json.bak` 再回退默认值，**不会直接覆盖用户文件**。
- 环境变量 `LOCAL_AI_PROXY_PROFILE` 的取值会 trim + 转小写后再匹配，避免写成 `TEST` 时静默落到用户档。
- **旧结构自动迁移**：早期版本用单一 `upstream` 对象保存上游。启动读配置时若发现 `upstream`，会自动把它转为 `providers` 列表的首项、置为启用，并**幂等落盘**（移除旧字段）；已无 `upstream` 的配置不受影响。迁移后 `activeProviderId` 始终有兜底：指向不存在的 Provider 时回落到列表首项。

**配置项草案**

```jsonc
{
  "proxy": {
    "host": "0.0.0.0",
    "port": 8787,
    "apiKey": "sk-local-xxxxxxxx",
    "requireClientKey": true,
    "connectTimeoutMs": 15000,
    "requestTimeoutMs": 300000
  },
  "admin": {
    "host": "127.0.0.1",
    "port": 8788,
    "password": ""
  },
  "providers": [
    {
      "id": "p_1a2b3c4d5e6f",      // 自动生成，前端按 id 提交/切换/删除
      "name": "DeepSeek",           // 缺省时由 baseUrl 的 host 自动命名
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "sk-...",
      "model": "deepseek-chat",     // 兜底模型
      "insecureTLS": false
    }
  ],
  "activeProviderId": "p_1a2b3c4d5e6f", // 当前启用的 Provider
  "log": {
    "memorySize": 1000,
    "dir": "logs",              // 相对 HOME（默认 ./data），即 ./data/logs
    "maxFileSizeMB": 64,
    "maxDays": 7
  }
}
```

---

## 7. API 设计

### 代理端口（对客户端，OpenAI 兼容）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/chat/completions` | 转发（含流式） |
| POST | `/v1/completions` | 转发 |
| POST | `/v1/embeddings` | 转发 |
| GET | `/v1/models` | 转发（返回上游模型列表） |
| 其它 | `/v1/*` | 通用透传 |
| GET | `/health` | 健康检查（服务存活、上游是否已配置；无需 Key） |

### 管理端口（网页，默认仅本机；对外暴露时需登录）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 管理页面 |
| POST | `/api/admin/login` | 口令登录（仅当 `admin.host` 非本机时需要） |
| POST | `/api/admin/logout` | 退出登录 |
| GET | `/api/admin/config` | 读取配置（密钥打码） |
| PUT | `/api/admin/config` | 修改配置：`providers`（整体替换列表，含新增/编辑/删除）、`activeProviderId`（切换启用）、`proxy`/`log` 等；API Key 回传掩码时按 id 保留原值 |
| POST | `/api/admin/test` | 用**当前启用的 Provider** 发一次真实测试请求：`via=upstream` 直连上游 / `via=proxy` 经本地代理；支持流式返回 |
| POST | `/api/admin/keys/rotate` | 重置本地客户端 Key |
| GET | `/api/admin/logs?limit=&before=` | 内存窗口分页查询 |
| GET | `/api/admin/logs/stream?since=` | SSE 实时推送 |
| GET | `/api/admin/logs/files` | 历史日志文件列表 |
| GET | `/api/admin/logs/file?name=&offset=` | 读取历史文件分页 |
| GET | `/api/admin/status` | 运行状态统计（含 `version`、`providerCount`、`activeProviderId`、`upstreamConfigured`） |

> `GET /health`（代理端口）与 `GET /api/admin/status` 均返回 `version` 字段，供网页角落角标与外部探活使用。

---

## 8. 关键实现要点与边界情况

1. **SSE 不被缓冲**：客户端侧响应加 `no-transform` / `X-Accel-Buffering: no`；服务端逐块 flush。
2. **断开即中止上游**：`req.on('close')` → `AbortController.abort()`，省 token。
3. **大请求体保护**：设置最大请求体大小（如 32MB），超限拒绝并记录。
4. **日志内存上限**：单条日志过大时（如超长上下文）截断并标记 `truncated: true`，防止内存膨胀。
5. **背压**：写文件流的 `write()` 返回 `false` 时**不阻塞**转发——忽略返回值、交给流内部缓冲（内存 Ring Buffer 才是权威副本，文件允许滞后）。
6. **并发**：每条请求独立记录，无需加锁；`seq` 由单点递增保证有序。
7. **CORS**：代理端口对 `/v1/*` 放开 `Access-Control-Allow-Origin`（若浏览器类客户端直接调用）；管理端口默认不开放 CORS。
8. **HTTPS/HTTP 上游**：通过 baseurl 协议自动选择；支持自签证书的「跳过校验」开关（默认关闭）。
9. **IPv6/局域网**：监听 `0.0.0.0` 覆盖 IPv4；如需同时覆盖 IPv6，改为监听 `::`（Node 默认双栈）。启动时打印可用局域网地址提示。

---

## 9. 运行形态、跨平台与打包

### 9.1 两种运行形态（同一份后端）

两种形态都通过 `src/app.js` 的 `createApp()` 装配，逻辑完全一致：

| 形态 | 入口 | 说明 |
| --- | --- | --- |
| 命令行模式（无 GUI） | `src/index.js`（`npm start`） | 纯 Node，适合服务器 / 无桌面环境；无第三方运行时依赖 |
| 桌面模式（内嵌 GUI） | `electron/main.cjs` | Electron 主进程内直接启动同一套服务，再用内嵌 Chromium 窗口展示网页控制台 |

### 9.2 桌面模式（Electron）

- **内嵌 Chromium 内核**：三系统渲染完全一致，网页控制台代码零改动复用。
- **单一实例、无 daemon**：主进程内启动服务；`requestSingleInstanceLock()` 防止重复启动；`window-all-closed → app.quit()`，关闭窗口即服务与进程一并退出，**不留后台残留**（含 macOS）。
- **重复启动的提示（版本不同才弹）**：拿不到锁的新实例按 Electron 语义必须立即退出，**自己弹不出界面**，所以提示一律由**已运行的实例**发出：新实例通过 `requestSingleInstanceLock({ version })` 把版本号经 `additionalData` 传给旧实例的 `second-instance` 事件；旧实例先聚焦自己的窗口，若 `新版本 ≠ 当前版本` 再弹原生对话框（「已在运行 v旧 / 你启动的是 v新 → 退出当前实例 / 保留当前实例」），选退出则 `app.quit()`。版本相同则只聚焦窗口，不打扰。这样可避免「双击新版本却看到旧界面」却毫无提示的困惑。
  > 弹窗必须用**异步** `dialog.showMessageBox()`：backend 服务与主进程是同一个 Node 进程，若用 `showMessageBoxSync()` 会阻塞事件循环，弹窗期间 8787/8788 会整体无响应。
- **最小化**：使用操作系统原生最小化，不额外实现托盘。
- **退出保证（关窗即净退）**：关窗 → `window-all-closed` → `app.quit()` → `will-quit` 中先落盘日志、再关闭服务、最后退出。关键在于关闭服务时必须调用 `server.closeAllConnections()`：`server.close()` 只停止监听并等待既有连接自然结束，而控制台页面的 SSE 长连接会让回调永不触发，导致「端口已释放但进程残留」。此外主进程还设了退出兜底计时器，确保无论如何都能退出。
- **窗口内容**：加载 `http://127.0.0.1:<adminPort>/`；窗口标题固定为 `LocalAIProxy v<version>`（拦截 `page-title-updated`，避免被页面 `<title>` 覆盖）；外部链接交给系统浏览器。
- **端口占用**：启动服务失败时弹窗提示，并指引修改 `data/config.json`。

### 9.3 路径与环境变量约定

Electron 主进程在启动服务前注入三个环境变量，使后端在打包环境下也能正确工作：

| 环境变量 | 命令行模式默认 | 桌面模式（打包后） |
| --- | --- | --- |
| `LOCAL_AI_PROXY_HOME` | `./data` | Windows：便携 exe 同级的 `data/`（`PORTABLE_EXECUTABLE_DIR/data`）；macOS：`~/Library/Application Support/LocalAIProxy/data`（`app.getPath('userData')/data`） |
| `LOCAL_AI_PROXY_PUBLIC_DIR` | `<repo>/public` | `resources/public`（通过 `extraResources` 放在 asar 之外） |
| `LOCAL_AI_PROXY_VERSION` | 读 `package.json` | `app.getVersion()`（打包后无 package.json 可读） |
| `LOCAL_AI_PROXY_PROFILE` | 不设即 `user` 档 | 同左（环境变量天然继承；`test` 档会切到 `config-test.json` 与 `logs-test/`，窗口标题带 `[测试档]`） |

> **macOS 数据目录为何不用「app 同级」**：`PORTABLE_EXECUTABLE_DIR` 是 electron-builder Windows 便携启动器专有变量，macOS 上不存在。若回退到 `path.dirname(app.getPath('exe'))`，数据会写进 `LocalAIProxy.app/Contents/MacOS/data`——从 dmg 直接运行时该路径是只读挂载（App Translocation），配置与日志根本写不进去；拖入 `/Applications` 后覆盖安装/升级又会连数据一起丢。因此 macOS 改为系统用户数据目录，Windows 便携版的「数据随 exe 走」行为保持不变。`app.getPath('userData')` 必须在 `ready` 之后调用，故该段逻辑放在 `bootstrap()` 内执行。

### 9.4 构建与打包（逐系统构建）

后端用 **esbuild** 打成一个 CJS 文件 `dist/backend.cjs`，再交给 **electron-builder** 打包。之所以先 bundle 成 CJS，是为了规避「asar + ESM」的加载问题，并让 Electron 主进程可直接 `require`。

| 命令 | 产物 | 必须在哪个系统上执行 |
| --- | --- | --- |
| `npm run dist:win` | `releases/LocalAIProxy-<ver>-win-portable.exe`（便携版单文件） | Windows |
| `npm run dist:mac` | `releases/LocalAIProxy-<ver>-mac.dmg` | macOS |
| `npm run dist:linux` | `releases/LocalAIProxy-<ver>-linux.AppImage` / `.deb` | Linux |

- **按用户要求：仓库只提供构建脚本，不提交任何平台的二进制产物**；每个平台的产物需在对应系统上现场构建（跨平台交叉构建不可靠，macOS 尤其必须在 macOS 上构建）。
- **构建脚本显式 `--publish never`**：electron-builder 一旦检测到 CI 环境变量（如 `CI=true`）就会「隐式发布」产物到 GitHub Releases，缺少 `GH_TOKEN` 时会以失败码结束整个构建——**产物其实已经生成**，但脚本返回失败，容易误判为构建失败。本项目只产出本地安装包，不自动发布，故由 `scripts/dist.mjs` 统一传入 `--publish never`。
- **构建自动保护用户数据**：`dist:*` 实际执行的是 `scripts/dist.mjs`，它会在 electron-builder 清理 `releases/` **之前**把 `releases/data`（用户真实配置与日志）复制到**仓库之外**的临时目录，构建完成后自动恢复并逐文件校验，校验通过才删除临时备份。这样「重建 exe 会删掉用户数据」由代码兜住，不再依赖人工记忆。
- Windows 采用 **portable** 目标：双击即用，不解压、不写注册表；数据写在 exe 同级 `data/` 目录，删除该目录即彻底清除。
- 产物统一输出到 `releases/`（已加入 `.gitignore`）。**构建成功后自动清理中间产物**（`mac-arm64/`、`win-unpacked/`、`linux-unpacked/` 等中间目录，以及 `.blockmap`、`latest-*.yml`、`builder-debug.yml` 等自动更新元数据），`releases/` 只保留最终安装包（dmg / exe / AppImage / deb）与用户运行数据（`releases/data/`）。
- **国内网络提示**：Electron 本体与其打包工具（NSIS、winCodeSign 等）默认从 GitHub 下载，国内可能失败。构建前设置镜像即可：
  ```powershell
  $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
  $env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
  npm run dist:win
  ```

### 9.5 其它

- **运行时要求**：Node.js >= 20（推荐 20 LTS / 22 / 24）；桌面模式由 Electron 自带运行时，终端用户无需安装 Node。
- **路径处理**：一律使用 `node:path`，不写死分隔符。

---

## 10. 安全注意事项

- 上游 APIKey 仅存本地 `config.json`，**不写入日志**。
- 管理端默认只监听 `127.0.0.1`；对局域网开放时必须设口令。
- 日志文件可能含敏感提示词，落盘目录权限建议为当前用户私有。
- 代理端口对局域网开放时，务必保持 `requireClientKey: true`。

---

## 11. 开发里程碑

| 阶段 | 内容 | 产出 |
| --- | --- | --- |
| M1 | 项目骨架 + 配置模块 + 代理端口启动 | 能监听、能返回健康检查 |
| M2 | 转发核心（普通 + 流式透传、鉴权、错误处理） | 客户端可正常对话（含流式） |
| M3 | 日志模块（Ring Buffer + 异步 JSONL + 轮转） | 日志正确记录、不丢 |
| M4 | 管理端口 + REST API + SSE 推送 | 接口可用 |
| M5 | Web 管理界面（实时日志流 + 配置 + Key） | 网页可看可配 |
| M6 | 边界处理与联调（断开中止、大体积、跨平台验证） | 三系统验证通过 |
| M7 | 网页内「保存并测试」上游连通性 | 免命令行即可验证配置 |
| M8 | Electron 桌面壳（内嵌 Chromium、关窗即退出、单实例） | 桌面模式可用 |
| M9 | 三平台打包脚本 + Windows 便携 exe 构建验证 | `releases/` 产出可执行文件 |

---

## 12. 已确认决策 & 待确认问题

**已确认（2026-10-07）**

1. ✅ **端口模型**：双端口。代理 `0.0.0.0:8787`、管理 `127.0.0.1:8788`。
2. ✅ **默认端口号**：8787 / 8788。
3. ✅ **`GET /v1/models`**：透传上游真实模型列表。
4. ✅ **日志脱敏**：密钥一律打码，不提供明文开关。
5. ✅ **端点覆盖**：`/v1/*` 全透传（chat/completions、completions、embeddings、models 等一并支持）。
6. ✅ **日志落盘**：内存优先读取 + 异步追加 JSONL，可随时回看历史。
7. ✅ **网页内配置与测试**：新增 `POST /api/admin/test`，免命令行完成 Provider 配置与连通性验证。
8. ✅ **桌面形态**：Electron 内嵌 Chromium（三系统统一渲染）；单一实例、前台式；窗口可最小化，关窗即进程与服务全部退出，无后台残留。
9. ✅ **分发形式**：Windows 采用便携版单 exe；**仓库只提供逐系统的构建脚本，不提交二进制产物**；产物输出到 `releases/`。
10. ✅ **版本号**：标准 semver 三位，单一来源为 `package.json`，随改动自更新（见第 13 节），并在网页角落与窗口标题展示。

**已确认（2026-10-08）**

11. ✅ **多 Provider**：配置由「单一 upstream」升级为 `providers[]` + `activeProviderId`，网页可自由新增/编辑/删除并在卡片上一键切换；旧配置自动迁移，向后兼容。
12. ✅ **控制台分 tab**：拆为「上游 Provider / 请求日志 / 本地接入」三个 tab；首页按「是否已配置 Provider」判定，并用 `localStorage` 记住上次选择。
13. ✅ **日志头部吸顶**：展开的长日志条目，其头部 sticky 吸附在列表顶部，随时可点击收起。
14. ✅ **重复启动提示**：保持单实例锁不变，但旧实例在新版本启动时弹原生对话框（显示两个版本号，可一键退出当前实例），消除「双击新版却看到旧界面」的无提示困惑。
15. ✅ **换版标准顺序**：终止旧实例（macOS 额外卸载旧 dmg 卷）→ 清理旧产物 → 递增版本号 → 构建 → 校验产物内含新代码 → 启动新版本。先退进程再清理，是为避免 Windows 文件锁导致「构建中途失败、留下半清理状态」。

**待确认**

- 暂无。

---

## 13. 版本号规约

- 采用**标准 semver 三位**：`MAJOR.MINOR.PATCH`。
- **单一来源**：`package.json` 的 `version`；其它文件不得硬编码版本号。
  - 命令行模式：`src/version.js` 读取 `package.json`。
  - 桌面模式：主进程注入 `LOCAL_AI_PROXY_VERSION = app.getVersion()`。
- **自更新**：每次有效改动都必须递增版本号——破坏性变更升 MAJOR、新增功能升 MINOR、修复/文档/重构升 PATCH。
- **展示位置**：网页控制台右下角角标、Electron 窗口标题、`/health` 与 `/api/admin/status` 的 `version` 字段。
- 详细执行要求见 `AGENTS.md` 第 3 节。
