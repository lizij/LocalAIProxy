// 以「测试档」启动命令行模式：
//   - 读写 data/config-test.json
//   - 日志写入 data/logs-test/
//   - **不会读取或改动用户的 data/config.json**
// 复用同一个 CLI 入口（src/index.js），避免出现第二份启动逻辑。
process.env.LOCAL_AI_PROXY_PROFILE = 'test';
await import('../src/index.js');
