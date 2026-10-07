import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 数据根目录（HOME）。默认 <cwd>/data，可由环境变量 LOCAL_AI_PROXY_HOME 覆盖。
 * config.json 与 logs/ 都位于该目录之下。
 */
export const HOME = process.env.LOCAL_AI_PROXY_HOME
  ? path.resolve(process.env.LOCAL_AI_PROXY_HOME)
  : path.resolve(process.cwd(), 'data');

export const CONFIG_PATH = path.join(HOME, 'config.json');

function randomKey() {
  return 'sk-local-' + crypto.randomBytes(20).toString('hex');
}

export function randomSecret(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

function defaults() {
  return {
    proxy: {
      host: '0.0.0.0',
      port: 8787,
      apiKey: randomKey(),
      requireClientKey: true,
      maxBodyBytes: 32 * 1024 * 1024,
      connectTimeoutMs: 15000,
      requestTimeoutMs: 300000,
    },
    admin: {
      host: '127.0.0.1',
      port: 8788,
      password: '',
    },
    upstream: {
      baseUrl: '',
      apiKey: '',
      model: '',
      insecureTLS: false,
    },
    log: {
      memorySize: 1000,
      dir: 'logs',
      maxFileSizeMB: 64,
      maxDays: 7,
    },
  };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, over) {
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(over || {})) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

export function maskSecret(value) {
  const s = String(value ?? '');
  if (!s) return '';
  if (s.length <= 8) return '****';
  return s.slice(0, 4) + '****' + s.slice(-4);
}

/** 日志目录绝对路径（支持相对 HOME 的相对路径）。 */
export function resolveLogDir(config) {
  const dir = config.get().log.dir || 'logs';
  return path.isAbsolute(dir) ? dir : path.join(HOME, dir);
}

export class ConfigStore {
  constructor() {
    this.file = CONFIG_PATH;
    this.data = this.#load();
  }

  #load() {
    let raw = null;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[config] 读取配置失败:', err.message);
    }

    if (raw == null) {
      const base = defaults();
      this.#persist(base);
      return base;
    }

    try {
      return deepMerge(defaults(), JSON.parse(raw));
    } catch (err) {
      const backup = this.file + '.bak';
      try {
        fs.copyFileSync(this.file, backup);
      } catch {}
      console.error(`[config] config.json 解析失败(${err.message})，已备份到 ${backup}，本次使用默认配置`);
      return defaults();
    }
  }

  #persist(data) {
    try {
      fs.mkdirSync(HOME, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error('[config] 写入配置失败:', err.message);
    }
  }

  get() {
    return this.data;
  }

  /** 对外展示用配置：上游密钥 / 管理口令打码。 */
  redacted() {
    const c = structuredClone(this.data);
    c.upstream.apiKey = maskSecret(c.upstream.apiKey);
    c.admin.password = c.admin.password ? '********' : '';
    return c;
  }

  /** 合并式更新并落盘。带 * 的字符串视为掩码，忽略之（避免把掩码覆盖回去）。 */
  update(patch) {
    const clean = structuredClone(patch || {});
    for (const [section, field] of [
      ['upstream', 'apiKey'],
      ['admin', 'password'],
      ['proxy', 'apiKey'],
    ]) {
      const sec = clean[section];
      if (isPlainObject(sec) && typeof sec[field] === 'string' && sec[field].includes('*')) {
        delete sec[field];
      }
    }
    this.data = deepMerge(this.data, clean);
    this.#persist(this.data);
    return this.data;
  }
}
