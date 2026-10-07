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
| 请求可见 | 网页实时滚动展示最近 1000 条请求/响应原文，支持搜索、状态过滤、展开与历史回看 |
| 日志不丢 | 内存优先读取 + 异步追加 JSONL 落盘，按天/按大小轮转，支持按日期回看 |
| 免命令行验证 | 网页内填好上游后点「保存并测试」，直接向上游发一次真实请求并流式渲染结果 |
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

1. 打开网页控制台：`http://127.0.0.1:8788`
2. 在「**② 上游 Provider**」填写：

   | 字段 | 示例 |
   | --- | --- |
   | Base URL | `https://api.deepseek.com` |
   | API Key | 你在该 Provider 申请的 Key |
   | Model（兜底） | `deepseek-chat` |

3. 点「**保存并测试**」：会真实请求一次上游并流式渲染回复，成功即配置完成
4. 在「**③ 请求日志**」实时观察每次请求/响应原文（密钥已打码）
5. 把 AI 工具的入口指向本代理，例如：

   ```bash
   OPENAI_BASE_URL=http://127.0.0.1:8787/v1
   OPENAI_API_KEY=<网页「① 本地接入信息」里的 sk-local-...>
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

配置保存在数据目录下的 `config.json`，**首次启动自动生成**，也可直接在网页上修改（上游相关配置保存后即时生效）。

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
| `upstream.baseUrl` | 空 | 上游 Provider 的 Base URL |
| `upstream.apiKey` | 空 | 上游 Provider 的 Key |
| `upstream.model` | 空 | 兜底模型（仅当请求未携带 `model` 时使用） |
| `upstream.insecureTLS` | `false` | 跳过上游证书校验（仅自签证书场景） |
| `log.memorySize` | 1000 | 内存中保留的日志条数（网页滚动窗口） |
| `log.dir` | `logs` | 日志目录（相对数据目录） |
| `log.maxFileSizeMB` | 64 | 单个日志文件上限，超过即轮转 |
| `log.maxDays` | 7 | 日志保留天数 |

### 数据目录

| 运行方式 | 数据目录 |
| --- | --- |
| 桌面端（便携版） | exe 同级的 `data/` 目录 |
| 命令行模式 | 当前工作目录下的 `data/` |

可用环境变量 `LOCAL_AI_PROXY_HOME` 覆盖。**数据目录里含上游密钥与请求日志，请勿提交到仓库。**

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
npm start            # 命令行模式
npm run dev:desktop  # 本地开发桌面端
npm run build:backend # 只把后端打成 dist/backend.cjs
```

**国内网络**：Electron 及其打包工具默认从 GitHub 下载，可能失败，先设置镜像：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run dist:win
```

若 `npm install` 中断导致 `node_modules/electron/dist` 缺失，单独补跑：`node node_modules/electron/install.js`。

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
