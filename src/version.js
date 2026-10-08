import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 版本号单一来源：package.json 的 version 字段。
 * - 命令行模式：直接读取 package.json
 * - Electron 打包后：主进程通过 app.getVersion() 注入 LOCAL_AI_PROXY_VERSION
 *
 * 版本号为标准 semver 三位（MAJOR.MINOR.PATCH），由 docs/contributing.md 的规约要求随改动自更新。
 */
function readFromPackageJson() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(fs.readFileSync(path.resolve(here, '..', 'package.json'), 'utf8')).version || '';
  } catch {
    return '';
  }
}

export const VERSION = process.env.LOCAL_AI_PROXY_VERSION || readFromPackageJson() || '0.0.0';
