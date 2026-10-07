import os from 'node:os';
import { createApp } from './app.js';
import { VERSION } from './version.js';

const app = createApp();

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

let cfg;
try {
  cfg = await app.start();
} catch (err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`启动失败：端口被占用 ${err.address}:${err.port}，请修改 data/config.json 后重试。`);
  } else {
    console.error('启动失败:', err.message);
  }
  process.exit(1);
}

console.log('');
console.log(`LocalAIProxy v${VERSION} 已启动（命令行模式）`);
console.log(`  数据目录      : ${app.home}`);
console.log(`  代理(OpenAI)  : http://127.0.0.1:${cfg.proxy.port}/v1   (监听 ${cfg.proxy.host}:${cfg.proxy.port})`);
for (const ip of lanAddresses()) {
  console.log(`                  http://${ip}:${cfg.proxy.port}/v1   (局域网)`);
}
console.log(`  客户端 API Key: ${cfg.proxy.apiKey}`);
console.log(`  上游 Provider : ${cfg.upstream.baseUrl || '未配置（请打开管理页设置）'}`);
console.log(`  管理页面      : http://127.0.0.1:${cfg.admin.port}`);
console.log('');

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n收到 ${signal}，正在退出…`);
  await app.stop();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
