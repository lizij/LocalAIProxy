# AGENTS.md

本文件是本仓库的 **AI agent / 开发者协作入口**。**改本仓库前先读本文件，再按「文档路由」进入对应文档**；本文件只做入口与路由，不重复细节。

---

## 1. 项目简介

- LocalAIProxy：一个 **OpenAI 协议兼容的本地 AI 转发代理**。对外暴露一个本地 BaseURL + APIKey（代理端口 `0.0.0.0:8787`），把请求**原样透传**到用户配置的任意公开 Provider（多 Provider 可一键切换 + `model` 原样透传，代理不做补全）。
- 提供网页控制台（管理端口 `127.0.0.1:8788`）实时查看**发往 Provider 的请求原文与收到的响应原文**。
- 通过 **Electron** 封装成桌面应用：一个窗口 + 内嵌 Chromium，窗口即服务，**关窗即退出，无后台残留**。
- 技术栈：Node.js >= 20，**运行时零第三方依赖**（`src/`、`public/` 只用 `node:*` 与浏览器原生 API），`node:http` 手写路由；跨 Windows / macOS / Linux。
- 设计与实现细节见 [docs/design.md](docs/design.md)。

---

## 2. 关键事实（速览）

- **端口**：代理 `8787`（`0.0.0.0`，需客户端 Key）／管理 `8788`（`127.0.0.1`，默认仅本机）。
- **版本号单一来源**：`package.json` 的 `version`，禁止在其他文件手写。
- **数据目录**：命令行 = `<cwd>/data`；Windows 便携版 = exe 同级 `data/`；macOS = `~/Library/Application Support/LocalAIProxy/data`；**Linux 未验证**。
- **开发 / 测试 / 验证一律走 test 档**：`npm run start:test`（`LOCAL_AI_PROXY_PROFILE=test`）读写 `data/config-test.json` 与 `data/logs-test/`，**绝不读写用户的 `data/config.json`**。

---

## 3. 命令速查

| 目的 | 命令 |
| --- | --- |
| 命令行模式启动（无 GUI） | `npm start` |
| **测试档启动（不碰用户 config.json）** | `npm run start:test` |
| 本地开发桌面应用 | `npm run dev:desktop` |
| 只打包后端为 `dist/backend.cjs` | `npm run build:backend` |
| 打包当前系统的安装产物 | `npm run dist`（或 `dist:win` / `dist:mac` / `dist:linux`） |

> 构建 / 镜像 / 产物命名与校验的完整说明见 [docs/build.md](docs/build.md)。

---

## 4. 文档路由

| 我要做什么 | 看哪个文件 |
| --- | --- |
| 了解产品 / 安装 / 使用 / 配置 | [README.md](README.md) |
| 改架构、模块、API、配置结构、目录结构 | [docs/design.md](docs/design.md) |
| 跑测试 / 换版发布顺序 | [docs/test.md](docs/test.md) |
| 构建打包 / 国内镜像 / 产物校验 | [docs/build.md](docs/build.md) |
| 版本号规约 / 代码约束 / Git 提交与推送 | [docs/contributing.md](docs/contributing.md) |

---

## 5. 红线（简版）

1. 提交前不泄露密钥；**不提交** `data/`、`node_modules/`、`dist/`、`releases/`。
2. 不引入运行时第三方依赖（`src/`、`public/`）。
3. 不删 `src/config.js` 里 test 档的两处保护（禁止写 `config.json`、日志强制 `logs-test`）。
4. 关服必须调用 `server.closeAllConnections()`；不改「关窗即退出」「单实例」语义。
5. 日志中的密钥一律打码；管理端口默认只监听 `127.0.0.1`。
6. 不跳过版本号递增。

> 红线完整说明、**代码约束 11 条**、以及 Git 提交 / 推送与脱敏规范，全部见 [docs/contributing.md](docs/contributing.md)。

---

## 6. 文档维护规约

- 重要改动（新增 / 变更功能、接口、配置项、构建方式、架构）**必须同步更新对应文档**：设计 → [docs/design.md](docs/design.md)；构建 → [docs/build.md](docs/build.md)；测试 / 发布 → [docs/test.md](docs/test.md)；协作规约 → [docs/contributing.md](docs/contributing.md)。
- 新增管理端 API 端点 → 更新 [docs/design.md](docs/design.md) §7 接口表。
- 新增 / 删除源码文件 → 更新 [docs/design.md](docs/design.md) §5 目录结构。
- 只维护顶层 `README.md` / `AGENTS.md` 与上述 4 份 `docs/*`，**不要另起新文档**。