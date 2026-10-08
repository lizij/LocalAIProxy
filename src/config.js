import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 数据根目录（HOME）。默认 <cwd>/data，可由环境变量 LOCAL_AI_PROXY_HOME 覆盖。
 * 刻意不使用系统用户目录（%APPDATA% 等），以保证三系统行为一致、目录可整体搬移。
 */
export const HOME = process.env.LOCAL_AI_PROXY_HOME
  ? path.resolve(process.env.LOCAL_AI_PROXY_HOME)
  : path.resolve(process.cwd(), 'data');

/**
 * 配置档（profile）：
 * - 'user'（默认）：用户的真实使用，读写 data/config.json 与 data/logs/
 * - 'test'        ：开发 / 联调 / agent 验证用，读写 data/config-test.json 与 data/logs-test/
 *
 * 由环境变量 LOCAL_AI_PROXY_PROFILE=test 切换。不设即 user 档，避免被误触。
 * 设计要点：**test 档永远不会写 user 档的 config.json**，用户真实数据只读不写。
 */
export const PROFILE =
  String(process.env.LOCAL_AI_PROXY_PROFILE || '').trim().toLowerCase() === 'test' ? 'test' : 'user';
export const IS_TEST = PROFILE === 'test';

/** 用户档配置文件：test 档只读它做种子化，绝不写入。 */
export const USER_CONFIG_PATH = path.join(HOME, 'config.json');

/** 当前档位实际使用的配置文件。 */
export const CONFIG_PATH = path.join(HOME, IS_TEST ? 'config-test.json' : 'config.json');

/** test 档专用日志目录，避免把测试记录混进用户日志。 */
export const TEST_LOG_DIR = 'logs-test';

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
    // 上游 Provider 列表（可配置多个）+ 当前启用的 Provider id。
    // 代理转发时始终使用 activeProviderId 指向的那个（找不到则回落到列表首项）。
    providers: [],
    activeProviderId: '',
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

/**
 * 读取并解析 JSON 配置文件。
 * 必须剥掉 UTF-8 BOM：Windows 记事本与 PowerShell 5.1 的 `Set-Content -Encoding utf8`
 * 都会写入 BOM（EF BB BF），而 JSON.parse 遇到 BOM 会直接抛错——
 * 曾导致「用户手改过配置文件后，程序静默回退到默认配置、像丢配置一样」。
 */
function readJsonFile(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function deepMerge(base, over) {
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(over || {})) {
    // undefined / null 一律跳过：避免用户配置里写了个 null 就把整段结构覆盖掉并引发崩溃
    if (v === undefined || v === null) continue;
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

/** 只挑出有值的字段，避免把 undefined 覆盖掉默认值。 */
function pickDefined(src, keys) {
  const out = {};
  if (!isPlainObject(src)) return out;
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

function newProviderId() {
  return 'p_' + crypto.randomBytes(6).toString('hex');
}

/** 由 baseUrl 推断一个可读的 Provider 名称（自动命名用）。 */
function nameFromBaseUrl(baseUrl) {
  try {
    return new URL(String(baseUrl)).host || 'Provider';
  } catch {
    return 'Provider';
  }
}

/**
 * 归一化单个 Provider。
 * API Key 里含 `*` 视为「掩码未改动」，沿用 prev 的原值（前端回传打码值时不会覆盖真实 Key）。
 */
function normalizeProvider(raw, prev) {
  const p = isPlainObject(raw) ? raw : {};
  const baseUrl = String(p.baseUrl ?? '').trim();
  const key = typeof p.apiKey === 'string' ? p.apiKey : '';
  return {
    id: String(p.id ?? '').trim() || (prev && prev.id) || newProviderId(),
    name: String(p.name ?? '').trim() || (prev && prev.name) || nameFromBaseUrl(baseUrl),
    baseUrl,
    apiKey: key.includes('*') ? (prev && typeof prev.apiKey === 'string' ? prev.apiKey : '') : key,
    model: String(p.model ?? '').trim(),
    insecureTLS: !!p.insecureTLS,
  };
}

/**
 * 归一化整份配置：
 * - 兼容早期「单一 upstream 对象」结构，自动迁移为 providers 列表的首项（幂等）；
 * - 保证 activeProviderId 始终指向一个真实存在的 Provider。
 */
function normalizeConfig(cfg) {
  if (!Array.isArray(cfg.providers)) cfg.providers = [];

  const legacy = cfg.upstream;
  if (isPlainObject(legacy) && (legacy.baseUrl || legacy.apiKey || legacy.model)) {
    const dup = cfg.providers.some((p) => p && p.baseUrl === legacy.baseUrl && p.apiKey === legacy.apiKey);
    if (!dup) {
      const p = normalizeProvider(legacy);
      cfg.providers.unshift(p);
      if (!cfg.activeProviderId) cfg.activeProviderId = p.id;
    }
  }
  delete cfg.upstream;

  if (typeof cfg.activeProviderId !== 'string') cfg.activeProviderId = '';
  if (!cfg.providers.some((p) => p && p.id === cfg.activeProviderId)) {
    cfg.activeProviderId = cfg.providers[0]?.id || '';
  }
  return cfg;
}

/** 当前生效的上游 Provider（id 匹配不到时回落到列表首项）。 */
export function activeProvider(cfg) {
  const list = Array.isArray(cfg?.providers) ? cfg.providers : [];
  return list.find((p) => p && p.id === cfg.activeProviderId) || list[0] || null;
}

/**
 * test 档首次生成配置时，从用户档「只读」复制一份可用的结构性配置，
 * 省去每次联调重新填端口/上游信息。**绝不写用户档。**
 *
 * 复制：proxy 端口等结构项、admin.host/port、log 设置、providers 全部（含 apiKey，便于用真实 provider 联调）
 * 不复制：本地客户端 Key（test 档新生成，两档一眼可分辨）、管理口令
 * 强制：日志目录固定为 logs-test
 */
function seedTestConfig() {
  const out = defaults();
  let user = null;
  try {
    user = readJsonFile(USER_CONFIG_PATH);
  } catch {
    return { config: out, seeded: false }; // 用户档不存在或不可解析：直接用默认值
  }

  // 把用户档归一化（含旧 upstream → providers 迁移），再复制可联调的 Provider 信息
  const u = normalizeConfig(deepMerge(defaults(), user));

  out.proxy = {
    ...out.proxy,
    ...pickDefined(user.proxy, ['host', 'port', 'requireClientKey', 'maxBodyBytes', 'connectTimeoutMs', 'requestTimeoutMs']),
    apiKey: randomKey(),
  };
  out.admin = {
    ...out.admin,
    ...pickDefined(user.admin, ['host', 'port']),
    password: '',
  };
  out.providers = (u.providers || []).map((p) => ({ ...p }));
  out.activeProviderId = u.activeProviderId || out.providers[0]?.id || '';
  out.log = {
    ...out.log,
    ...pickDefined(user.log, ['memorySize', 'maxFileSizeMB', 'maxDays']),
    dir: TEST_LOG_DIR,
  };
  return { config: out, seeded: true };
}

export function maskSecret(value) {
  const s = String(value ?? '');
  if (!s) return '';
  if (s.length <= 8) return '****';
  return s.slice(0, 4) + '****' + s.slice(-4);
}

/** 日志目录绝对路径（支持相对 HOME 的相对路径）。test 档强制独立目录。 */
export function resolveLogDir(config) {
  const dir = IS_TEST ? TEST_LOG_DIR : config.get().log.dir || 'logs';
  return path.isAbsolute(dir) ? dir : path.join(HOME, dir);
}

export class ConfigStore {
  constructor() {
    this.file = CONFIG_PATH;
    this.data = this.#load();
  }

  #load() {
    if (!fs.existsSync(this.file)) {
      let base = defaults();
      let seeded = false;
      if (IS_TEST) {
        const r = seedTestConfig();
        base = r.config;
        seeded = r.seeded;
      }
      this.#persist(base);
      if (IS_TEST) {
        console.log(
          seeded
            ? `[config] 已生成测试档 ${path.basename(this.file)}（从 ${path.basename(USER_CONFIG_PATH)} 只读复制结构项，未改动后者）`
            : `[config] 已生成测试档 ${path.basename(this.file)}（未找到可用的 ${path.basename(USER_CONFIG_PATH)}，改用默认值）`,
        );
      }
      return base;
    }

    try {
      const raw = readJsonFile(this.file);
      const hadLegacy = isPlainObject(raw.upstream);
      const parsed = normalizeConfig(deepMerge(defaults(), raw));
      if (IS_TEST) parsed.log.dir = TEST_LOG_DIR; // 双保险：测试档日志永远独立
      if (hadLegacy) {
        this.#persist(parsed); // 迁移结果落盘：旧 upstream 结构被移除，改为 providers 列表
        console.log('[config] 检测到旧版单上游配置，已自动迁移为 providers 列表');
      }
      return parsed;
    } catch (err) {
      const backup = this.file + '.bak';
      try {
        fs.copyFileSync(this.file, backup);
      } catch {}
      console.error(`[config] ${path.basename(this.file)} 解析失败(${err.message})，已备份到 ${path.basename(backup)}，本次使用默认配置`);
      return IS_TEST ? seedTestConfig().config : defaults();
    }
  }

  #persist(data) {
    try {
      // 兜底：test 档绝不写用户档配置文件
      if (IS_TEST && path.resolve(this.file) === path.resolve(USER_CONFIG_PATH)) {
        console.error('[config] 拒绝写入用户档配置（test 档只能写 config-test.json）');
        return;
      }
      fs.mkdirSync(HOME, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error('[config] 写入配置失败:', err.message);
    }
  }

  get() {
    return this.data;
  }

  /** 当前档位信息，用于启动打印与状态接口。 */
  profileInfo() {
    return { profile: PROFILE, configFile: path.basename(this.file), logDir: resolveLogDir(this) };
  }

  /** 对外展示用配置：各 Provider 密钥 / 管理口令打码。 */
  redacted() {
    const c = structuredClone(this.data);
    for (const p of c.providers || []) p.apiKey = maskSecret(p.apiKey);
    c.admin.password = c.admin.password ? '********' : '';
    return c;
  }

  /** 合并式更新并落盘。带 * 的字符串视为掩码，忽略之（避免把掩码覆盖回去）。 */
  update(patch) {
    const clean = structuredClone(patch || {});
    for (const [section, field] of [
      ['admin', 'password'],
      ['proxy', 'apiKey'],
    ]) {
      const sec = clean[section];
      if (isPlainObject(sec) && typeof sec[field] === 'string' && sec[field].includes('*')) {
        delete sec[field];
      }
    }
    // Provider 列表整体替换：逐个归一化，并按 id 还原被掩码覆盖的 apiKey。
    if (Array.isArray(clean.providers)) {
      const prevById = new Map((this.data.providers || []).map((p) => [p.id, p]));
      clean.providers = clean.providers
        .filter((p) => isPlainObject(p))
        .map((p) => normalizeProvider(p, prevById.get(String(p.id ?? '').trim())));
    }
    this.data = deepMerge(this.data, clean);
    // activeProviderId 兜底：必须指向一个真实存在的 Provider
    const list = this.data.providers || [];
    if (!list.some((p) => p.id === this.data.activeProviderId)) {
      this.data.activeProviderId = list[0]?.id || '';
    }
    if (IS_TEST) this.data.log.dir = TEST_LOG_DIR;
    this.#persist(this.data);
    return this.data;
  }
}
