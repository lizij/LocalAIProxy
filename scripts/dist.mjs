// 构建包装脚本：在 electron-builder 清理产物目录 releases/ 之前，
// 先把用户运行数据（releases/data：config.json 里的真实上游 Key + 日志）
// 挪到**仓库之外**，构建完成后再自动挪回并逐文件校验。
//
// 目的：由代码保证「npm run dist:* 永不丢用户数据」，不再依赖人工记得备份。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'releases', 'data');
const backupDir = path.join(os.tmpdir(), `lap-userdata-${Date.now()}`);

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}`))));
    child.on('error', reject);
  });
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

/** 递归清单（相对路径:字节数），用于校验恢复是否完整。 */
function manifest(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) manifest(p, base, out);
    else if (entry.isFile()) out.push(`${path.relative(base, p)}:${fs.statSync(p).size}`);
  }
  return out.sort();
}

const target = process.argv[2];
const ebArgs = [];
if (target === 'win') ebArgs.push('--win', '--x64');
else if (target === 'mac') ebArgs.push('--mac');
else if (target === 'linux') ebArgs.push('--linux');

const ebBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');

let backedUp = false;
try {
  if (fs.existsSync(dataDir)) {
    copyDir(dataDir, backupDir);
    backedUp = true;
    console.log(`[dist] 已把运行数据备份到仓库之外：${backupDir}`);
  } else {
    console.log('[dist] 未发现 releases/data，无需备份');
  }

  await run(process.execPath, [path.join(root, 'scripts', 'build-backend.mjs')]);
  await run(ebBin, ebArgs, { shell: process.platform === 'win32' });

  if (backedUp) {
    copyDir(backupDir, dataDir);
    console.log('[dist] 已把运行数据恢复到 releases/data');
  }
} catch (err) {
  console.error('[dist] 构建失败：', err.message);
  if (backedUp && !fs.existsSync(dataDir)) {
    try {
      copyDir(backupDir, dataDir);
      console.error('[dist] 已尽力恢复运行数据');
    } catch (e2) {
      console.error('[dist] 恢复失败：', e2.message);
    }
  }
  process.exitCode = 1;
} finally {
  if (backedUp) {
    const want = manifest(backupDir).join('|');
    const got = manifest(dataDir).join('|');
    if (want === got) {
      fs.rmSync(backupDir, { recursive: true, force: true });
      console.log('[dist] 恢复已逐文件校验通过，临时备份已清理');
    } else {
      console.error(`[dist] ⚠ 恢复校验未通过，请手工检查。临时备份保留在：${backupDir}`);
      process.exitCode = 1;
    }
  }
}
