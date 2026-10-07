import { ConfigStore, HOME } from './config.js';
import { LogStore } from './log/store.js';
import { createProxyServer } from './proxy/server.js';
import { createAdminServer } from './admin/server.js';

/**
 * 应用装配：把配置、日志、两个 HTTP 服务组装成一个可启动/停止的实例。
 * 命令行入口(src/index.js)与 Electron 主进程(electron/main.cjs)共用同一份装配逻辑。
 */
export function createApp() {
  const config = new ConfigStore();
  const logs = new LogStore(config);
  const ctx = { config, logs, startedAt: new Date().toISOString() };
  const proxyServer = createProxyServer(ctx);
  const adminServer = createAdminServer(ctx);

  function listen(server, port, host) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  }

  async function start() {
    const cfg = config.get();
    await listen(proxyServer, cfg.proxy.port, cfg.proxy.host);
    await listen(adminServer, cfg.admin.port, cfg.admin.host);
    return config.get();
  }

  async function stop() {
    try {
      await logs.close();
    } catch {}

    // 注意：server.close() 只停止监听，并等待既有连接自然结束；
    // 若仍有 SSE / keep-alive 连接挂在那里，回调永远不会触发。
    // 因此必须主动关闭存量连接，并对整体关闭加超时兜底，保证关窗时能立即退出。
    const servers = [proxyServer, adminServer];
    const closed = servers.map((server) => new Promise((resolve) => server.close(() => resolve())));
    for (const server of servers) {
      try {
        server.closeAllConnections?.();
      } catch {}
    }
    await Promise.race([Promise.allSettled(closed), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }

  return { config, logs, ctx, proxyServer, adminServer, home: HOME, start, stop };
}
