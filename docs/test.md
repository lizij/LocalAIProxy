# 测试与发布

> 测试怎么跑、发布（换版）怎么做。**换版标准顺序的权威出处就是本文件**；构建细节见 [docs/build.md](build.md)，代码约束与版本号规约见 [docs/contributing.md](contributing.md)。

---

## 1. 铁律：一律走测试档

`npm run start:test`（或设 `LOCAL_AI_PROXY_PROFILE=test`）读写 `data/config-test.json` 与 `data/logs-test/`，**绝不读取或改动用户的 `data/config.json`**。任何验证、联调、截图、接口调用，都必须走测试档。

> `src/config.js` 里已硬性禁止 test 档写入 `config.json`、并强制 test 档日志目录为 `logs-test`。**不要移除这两处保护**，也不要把测试数据写进用户的 `logs/`。

---

## 2. 动配置前：先确认端口是谁在跑

若 8787 / 8788 已被别的实例占用，你发往 `/api/admin/*` 的请求会打到**别人的实例**（曾因此把用户的真实上游配置覆盖成测试值）。先确认端口空闲，或只用测试档自己启动的实例。

---

## 3. 网页内测试（两条路径）

网页「保存并测试」针对**当前启用的 Provider** 发一次真实请求，结果在页面内流式渲染（含状态码与 token 用量）：

| 路径 | 含义 | 用途 |
| --- | --- | --- |
| **直连上游**（`via=upstream`，默认） | 绕过本地代理，按同一套 URL 拼接规则直接请求上游 | 只验证 Provider 的 Base URL / API Key / Model 是否正确 |
| **经本地代理**（`via=proxy`） | 打本机 `http://127.0.0.1:<proxyPort>/v1/chat/completions` 并携带本地 Key | 验证端到端链路：本地 Key 鉴权 → 转发 → 日志落库 |

不确定用哪个时：先「直连上游」确认 Provider 没问题，再「经本地代理」确认真实客户端调用也能通。

---

## 4. 端到端自测（推荐：mock 上游）

不消耗真实 Provider 额度、也不碰用户配置，做法：

1. 起一个**本地 mock 上游**（`node:http`），记录收到的 `method / url / headers`，并返回你需要的响应（SSE / JSON / gzip 均可）。
2. 用**临时 HOME** + 自定义端口启动后端：

   ```bash
   LOCAL_AI_PROXY_HOME=/tmp/lap-test-home LOCAL_AI_PROXY_PUBLIC_DIR=<repo>/public node src/index.js
   ```

   （临时 HOME 里的 `config.json` 把 `providers[0].baseUrl` 指向 mock，端口避开 8787 / 8788。）
3. 覆盖这些检查点：
   - `/health` 返回 `version`；错误 Key → 401；缺 Key → 401；非 `/v1` 路径 → 404；
   - 非流式 JSON 正常；
   - **流式 SSE**：`content-type: text/event-stream`、含 `[DONE]` 与 `usage`、响应未被压缩；
   - `GET /v1/models` 透传；
   - **上游 gzip 被正确解压，且 `content-encoding` 被剥掉**；
   - 转发的 `Authorization` 是**上游 Key**（客户端本地 Key 不转发）；
   - 日志确实记录，且**不落库明文 Key**。

---

## 5. 桌面端验证

- `npm run dev:desktop` 能打开窗口，页面正常加载（不 404）。
- **关窗即退出**：关闭窗口后进程完全退出，任务管理器中无残留。
- **单实例**：旧实例在跑时启动新版本，旧窗口弹原生提示（显示两个版本号，可一键退出当前实例）；版本相同则只聚焦窗口，不打扰。
  > 实现要点（勿改成同步版）：必须用**异步** `dialog.showMessageBox()`——backend 与主进程是同一个 Node 进程，用 `showMessageBoxSync()` 会阻塞事件循环，弹窗期间 8787 / 8788 会整体无响应。

---

## 6. 换版标准顺序（三系统统一）

1. **终止旧实例**：结束正在运行的 `LocalAIProxy.app` / `LocalAIProxy.exe` 进程；macOS 若用户是「挂载 dmg 直接双击运行」，还需卸载旧的 `/Volumes/LocalAIProxy *` 卷。
2. **清理旧产物**：只删**旧版本**产物与中间目录、元数据；**当前版本产物必须保留**（用户靠它双击运行）；`releases/data` 不能手工删。
3. **递增版本号**（`package.json`，规则见 [docs/contributing.md](contributing.md) §1）。
4. **构建**（见 [docs/build.md](build.md)）。
5. **校验产物内含新代码**（见 [docs/build.md](build.md) §6）。
6. **启动 / 提示用户启动新版本**。

> **走 CI 发布时**：第 4~6 步由 `.github/workflows/release.yml` 自动完成——推 `v*` tag 触发三平台构建，产物挂到草稿 Release 待人工 Publish；本地只需完成第 1~3 步。详见 [docs/build.md](build.md) §8。

> 为什么先退进程再清理：Windows 上正在运行的 exe / 被占用的 `win-unpacked/` 会触发文件锁，导致删除或覆盖失败；若等到**构建中途**才失败，会留下「清了一半」的中间状态，比事先退出更糟。macOS 虽允许删除运行中的 app 文件，但为流程一致与后续启动（单实例锁 + 端口）顺畅，同样按此顺序执行。这些收尾动作（杀进程、卸卷、删旧产物）代理应自行完成，不要推给用户。

---

## 7. 改动后的自检清单

- [ ] 已按 [docs/contributing.md](contributing.md) §1 的版本号规约递增 `package.json` 的 `version`。
- [ ] 已同步更新对应文档（见 `AGENTS.md` 的「文档路由 / 维护」）。
- [ ] `node --check` 能通过所有 JS 文件（或直接启动无报错）。
- [ ] `npm start` 可用：`/health` 与 `/api/admin/status` 正常返回，且 `status.version` 为新版本号。
- [ ] 改动涉及界面时，网页控制台右下角版本角标显示正确。
- [ ] 改动涉及桌面壳时，`npm run dev:desktop` 能打开窗口；关窗后进程完全退出（无残留）。
- [ ] 未引入运行时第三方依赖。