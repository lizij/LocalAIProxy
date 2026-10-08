import { maskSecret, activeProvider } from '../config.js';

// 逐跳头（不能转发）
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

// 响应侧同样需要剔除（undici 已自动解压，长度也不再有效）
const RESPONSE_STRIP = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

const MAX_BODY_LOG = 256 * 1024; // 单条请求体记录上限
const MAX_RESP_CAPTURE = 1024 * 1024; // 单条响应体记录上限

let tlsFlag = null;
function applyTlsFlag(insecure) {
  const want = insecure ? '0' : '1';
  if (tlsFlag === want) return;
  tlsFlag = want;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = want;
  if (insecure) {
    console.warn('[proxy] 已开启 insecureTLS：跳过上游证书校验（存在中间人风险）');
  }
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

/** 拼接上游完整 URL，自动避免 basePath 与请求路径重复（如 base 已含 /v1）。 */
export function buildUpstreamUrl(baseUrl, originalUrl) {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const qi = originalUrl.indexOf('?');
  const pathOnly = qi === -1 ? originalUrl : originalUrl.slice(0, qi);
  const query = qi === -1 ? '' : originalUrl.slice(qi + 1);

  let tail = pathOnly;
  if (basePath && (pathOnly === basePath || pathOnly.startsWith(basePath + '/'))) {
    tail = pathOnly.slice(basePath.length);
  }
  let full = base.origin + basePath + tail;
  if (query) full += '?' + query;
  return full;
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        const err = new Error('请求体过大');
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function buildForwardHeaders(req, provider) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    if (lk === 'authorization' || lk === 'api-key') continue; // 用上游 Key 覆盖
    out[k] = v;
  }
  if (provider.apiKey) out.authorization = `Bearer ${provider.apiKey}`;
  return out;
}

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === 'authorization' || lk === 'api-key') out[lk] = 'Bearer ' + maskSecret(String(v).replace(/^Bearer\s+/i, ''));
    else out[lk] = v;
  }
  return out;
}

function contentTypeOf(headers) {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'content-type') return String(v);
  }
  return '';
}

function parseBodyForLog(buf, contentType) {
  if (!buf || buf.length === 0) return null;
  const text = buf.toString('utf8');
  if (/json/i.test(contentType) || /^\s*[{[]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {}
  }
  return text.length > MAX_BODY_LOG ? text.slice(0, MAX_BODY_LOG) + '... [truncated]' : text;
}

function formatResponseBody(text, contentType, isStream) {
  if (isStream) return text; // 保留 SSE 原文，前端分片展示
  if (/json/i.test(contentType)) {
    try {
      return JSON.parse(text);
    } catch {}
  }
  return text;
}

export function extractUsage(text, isStream) {
  try {
    if (isStream) {
      let usage = null;
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const obj = JSON.parse(payload);
          if (obj && obj.usage) usage = obj.usage;
        } catch {}
      }
      return usage;
    }
    const obj = JSON.parse(text);
    return obj && obj.usage ? obj.usage : null;
  } catch {
    return null;
  }
}

function headersToObject(headers) {
  const out = {};
  for (const [k, v] of headers) out[k] = v;
  return out;
}

export function sendError(res, status, code, message) {
  if (res.headersSent) {
    try {
      res.end();
    } catch {}
    return;
  }
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: { message, type: 'local_ai_proxy_error', code } }));
}

export async function proxyRequest(req, res, ctx) {
  const cfg = ctx.config.get();
  const started = Date.now();

  const provider = activeProvider(cfg);
  if (!provider || !provider.baseUrl) {
    return sendError(res, 503, 'upstream_not_configured', '上游 Provider 未配置，请打开管理页添加并启用一个 Provider。');
  }

  applyTlsFlag(!!provider.insecureTLS);

  const maxBody = Number(cfg.proxy.maxBodyBytes) || 32 * 1024 * 1024;
  let bodyBuf;
  try {
    bodyBuf = await readBody(req, maxBody);
  } catch (err) {
    return sendError(res, err.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, err.code || 'bad_request', err.message);
  }

  const upstreamUrl = buildUpstreamUrl(provider.baseUrl, req.url || '/');
  const forwardHeaders = buildForwardHeaders(req, provider);

  const rec = ctx.logs.start({
    client: { ip: clientIp(req), ua: req.headers['user-agent'] || '' },
    request: {
      method: req.method,
      url: upstreamUrl,
      headers: redactHeaders(forwardHeaders),
      body: parseBodyForLog(bodyBuf, contentTypeOf(forwardHeaders)),
    },
  });

  const ac = new AbortController();
  let done = false;
  let connectTimer = setTimeout(() => ac.abort(new Error('连接上游超时')), Number(cfg.proxy.connectTimeoutMs) || 15000);
  let idleTimer = null;

  res.on('close', () => {
    if (!done) ac.abort(new Error('客户端已断开'));
  });

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method: req.method,
      headers: forwardHeaders,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : bodyBuf.length ? bodyBuf : undefined,
      signal: ac.signal,
      redirect: 'manual',
    });
    clearTimeout(connectTimer);
    connectTimer = null;

    const ct = upstreamRes.headers.get('content-type') || '';
    const isStream = ct.includes('text/event-stream');

    res.statusCode = upstreamRes.status;
    for (const [k, v] of upstreamRes.headers) {
      if (RESPONSE_STRIP.has(k.toLowerCase())) continue;
      try {
        res.setHeader(k, v);
      } catch {}
    }
    if (isStream) {
      res.setHeader('cache-control', 'no-cache, no-transform');
      res.setHeader('connection', 'keep-alive');
      res.setHeader('x-accel-buffering', 'no');
    }
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const touchIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ac.abort(new Error('上游空闲超时')), Number(cfg.proxy.requestTimeoutMs) || 300000);
    };
    touchIdle();

    const captured = [];
    let capturedBytes = 0;
    let truncated = false;

    if (upstreamRes.body) {
      for await (const chunk of upstreamRes.body) {
        touchIdle();
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        res.write(buf);
        if (capturedBytes < MAX_RESP_CAPTURE) {
          const room = MAX_RESP_CAPTURE - capturedBytes;
          if (buf.length > room) {
            captured.push(buf.subarray(0, room));
            capturedBytes += room;
            truncated = true;
          } else {
            captured.push(buf);
            capturedBytes += buf.length;
          }
        } else {
          truncated = true;
        }
      }
    }

    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    done = true;
    res.end();

    const text = Buffer.concat(captured).toString('utf8');
    ctx.logs.finish(rec.id, {
      durationMs: Date.now() - started,
      response: {
        status: upstreamRes.status,
        headers: headersToObject(upstreamRes.headers),
        stream: isStream,
        truncated,
        body: formatResponseBody(text, ct, isStream),
        usage: extractUsage(text, isStream),
      },
    });
  } catch (err) {
    clearTimeout(connectTimer);
    if (idleTimer) clearTimeout(idleTimer);
    done = true;
    const message = err?.message || String(err);
    ctx.logs.finish(rec.id, {
      durationMs: Date.now() - started,
      error: { name: err?.name || 'Error', message },
    });
    sendError(res, 502, 'upstream_error', `转发失败: ${message}`);
  }
}
