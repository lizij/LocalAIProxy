// 把后端（src/app.js 及其依赖）打包成单个 CJS 文件 dist/backend.cjs。
// 目的：Electron 打包后文件位于 app.asar 内，CJS 单文件可规避 asar + ESM 的加载问题。
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [path.join(root, 'src', 'app.js')],
  outfile: path.join(root, 'dist', 'backend.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  // 源码里 import.meta.url 的使用点已做容错兜底（打包后靠环境变量注入路径），此警告可安全忽略。
  logOverride: { 'import-meta': 'silent' },
  logLevel: 'info',
});

console.log('[build] dist/backend.cjs 已生成');
