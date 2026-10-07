import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { randomSecret, PROFILE } from '../config.js';
import { listLogFiles, readLogFile } from '../log/reader.js';
import { safeEqual } from '../proxy/auth.js';
import { json, readJson } from './http.js';
import { handleTest } from './test.js';
import { VERSION } from '../version.js';

// 静态页面目录：Electron 打包后 public 位于 resources 下（非 asar 内），由主进程注入环境变量。
// 注意：本文件会被 esbuild 打包成 CJS，此时 import.meta.url 不可用，故必须容错兜底。
function resolveModuleDir() {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

let PUBLIC_DIR = process.env.LOCAL_AI_PROXY_PUBLIC_DIR || '';
if (!PUBLIC_DIR) {
  PUBLIC_DIR = path.resolve(resolveModuleDir(), '../../public');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const STATIC_WHITELIST = new Set(['/index.html', '/app.js', '/style.css']);

function isLocalHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.statusCode = 404;
      return res.end('Not found');
    }
    res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  });
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers['cookie'];
  if (!raw) return out;
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function createAdminServer(ctx) {
  const cfg0 = ctx.config.get();
  const localOnly = isLocalHost(cfg0.admin.host);
  let password = cfg0.admin.password;
  if (!localOnly && !password) {
    password = crypto.randomBytes(9).toString('base64url');
    console.warn(`[admin] 管理端口绑定在 ${cfg0.admin.host} 但未设置口令，已生成临时口令：${password}`);
  }
  const sessions = new Set();

  function authed(req) {
    if (localOnly || !password) return true;
    const token = parseCookies(req).lap_session;
    return !!token && sessions.has(token);
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const pathname = url.pathname;

      if (req.method === 'GET' && pathname === '/') return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
      if (req.method === 'GET' && STATIC_WHITELIST.has(pathname)) {
        return serveFile(res, path.join(PUBLIC_DIR, pathname.slice(1)));
      }

      if (req.method === 'POST' && pathname === '/api/admin/login') {
        const body = await readJson(req);
        if (password && body.password && safeEqual(body.password, password)) {
          const token = crypto.randomBytes(24).toString('hex');
          sessions.add(token);
          res.setHeader('set-cookie', `lap_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
          return json(res, 200, { ok: true });
        }
        return json(res, 401, { error: '口令不正确' });
      }

      if (req.method === 'POST' && pathname === '/api/admin/logout') {
        const token = parseCookies(req).lap_session;
        if (token) sessions.delete(token);
        res.setHeader('set-cookie', 'lap_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return json(res, 200, { ok: true });
      }

      if (!pathname.startsWith('/api/admin/')) {
        return json(res, 404, { error: 'not found' });
      }

      if (!authed(req)) return json(res, 401, { error: 'unauthorized' });

      // 读取配置（密钥打码）
      if (req.method === 'GET' && pathname === '/api/admin/config') {
        return json(res, 200, { config: ctx.config.redacted() });
      }

      // 更新配置
      if (req.method === 'PUT' && pathname === '/api/admin/config') {
        const body = await readJson(req);
        ctx.config.update(body);
        return json(res, 200, { ok: true, config: ctx.config.redacted() });
      }

      // 重置本地客户端 Key
      if (req.method === 'POST' && pathname === '/api/admin/keys/rotate') {
        const apiKey = 'sk-local-' + randomSecret(20);
        ctx.config.update({ proxy: { apiKey } });
        return json(res, 200, { ok: true, apiKey });
      }

      // 用当前上游配置做一次真实测试请求
      if (req.method === 'POST' && pathname === '/api/admin/test') {
        return handleTest(req, res, ctx);
      }

      // 内存窗口分页查询
      if (req.method === 'GET' && pathname === '/api/admin/logs') {
        const limit = Number(url.searchParams.get('limit')) || 200;
        const before = url.searchParams.get('before');
        return json(res, 200, ctx.logs.list({ limit, before }));
      }

      // SSE 实时推送
      if (req.method === 'GET' && pathname === '/api/admin/logs/stream') {
        const since = Number(url.searchParams.get('since')) || 0;
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        const send = (rec) => res.write(`event: record\ndata: ${JSON.stringify(rec)}\n\n`);
        const backlog = since > 0 ? ctx.logs.since(since) : ctx.logs.list({ limit: ctx.config.get().log.memorySize }).records;
        for (const rec of backlog) send(rec);
        const unsub = ctx.logs.subscribe(send);
        const ping = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {}
        }, 20000);
        // 用 res 的 close 作为连接结束信号（req 的 close 在请求体读完后可能提前触发，语义不如 res 明确）。
        res.on('close', () => {
          clearInterval(ping);
          unsub();
        });
        return;
      }

      // 历史日志文件列表
      if (req.method === 'GET' && pathname === '/api/admin/logs/files') {
        return json(res, 200, { files: listLogFiles(ctx.logs.dir) });
      }

      // 读取历史日志文件
      if (req.method === 'GET' && pathname === '/api/admin/logs/file') {
        const name = url.searchParams.get('name') || '';
        const offset = Number(url.searchParams.get('offset')) || 0;
        const limit = Number(url.searchParams.get('limit')) || 200;
        try {
          return json(res, 200, readLogFile(ctx.logs.dir, name, { offset, limit }));
        } catch (err) {
          return json(res, err.code === 'NOT_FOUND' ? 404 : 400, { error: err.message });
        }
      }

      // 运行状态
      if (req.method === 'GET' && pathname === '/api/admin/status') {
        const cfg = ctx.config.get();
        return json(res, 200, {
          version: VERSION,
          profile: PROFILE,
          startedAt: ctx.startedAt,
          uptimeSeconds: Math.round(process.uptime()),
          upstreamConfigured: !!cfg.upstream.baseUrl,
          memoryCount: ctx.logs.buffer.length,
          memoryCapacity: ctx.logs.maxMemory,
          maxSeq: ctx.logs.seq,
          proxy: { host: cfg.proxy.host, port: cfg.proxy.port },
          admin: { host: cfg.admin.host, port: cfg.admin.port },
        });
      }

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      console.error('[admin] 处理请求出错:', err.message);
      if (!res.headersSent) json(res, 500, { error: err.message });
    }
  });
}
