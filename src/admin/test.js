import { maskSecret } from '../config.js';
import { buildUpstreamUrl, extractUsage } from '../proxy/forward.js';
import { json, readJson } from './http.js';

const DEFAULT_PROMPT = '你好，请用一句话介绍你自己。';
const MAX_CAPTURE = 1024 * 1024;
const TEST_TIMEOUT_MS = 60000;

/**
 * 管理端「网页测试」：用已保存的上游配置直连上游发一次真实 chat/completions 请求。
 * - 非流式：返回 JSON（内容 + usage + 原始响应）
 * - 流式：把上游 SSE 原文直接透传给浏览器，前端逐块渲染
 * 同时记录到日志，便于在「请求日志」里回看。
 */
export async function handleTest(req, res, ctx) {
  const cfg = ctx.config.get();
  if (!cfg.upstream.baseUrl) {
    return json(res, 400, { ok: false, error: '上游 Provider 未配置：请先填写 Base URL 与 API Key 并保存。' });
  }

  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return json(res, 400, { ok: false, error: err.message });
  }

  const prompt = (body.prompt && String(body.prompt).trim()) || DEFAULT_PROMPT;
  const model = (body.model && String(body.model).trim()) || cfg.upstream.model || '';
  const stream = !!body.stream;
  if (!model) {
    return json(res, 400, { ok: false, error: '未指定 model：请在「Model（兜底）」字段填写，或填写测试用模型。' });
  }

  const url = buildUpstreamUrl(cfg.upstream.baseUrl, '/v1/chat/completions');
  const headers = { 'content-type': 'application/json' };
  if (cfg.upstream.apiKey) headers.authorization = `Bearer ${cfg.upstream.apiKey}`;
  const payload = { model, messages: [{ role: 'user', content: prompt }], stream };

  const started = Date.now();
  const rec = ctx.logs.start({
    client: { ip: 'admin:test', ua: 'LocalAIProxy Console' },
    request: {
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + maskSecret(cfg.upstream.apiKey) },
      body: payload,
    },
  });

  const ac = new AbortController();
  let done = false;
  const timer = setTimeout(() => ac.abort(new Error('测试超时')), TEST_TIMEOUT_MS);
  res.on('close', () => {
    if (!done) ac.abort(new Error('客户端已断开'));
  });

  try {
    const upstream = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ac.signal });
    const respHeaders = Object.fromEntries(upstream.headers);

    if (!stream) {
      const text = await upstream.text();
      clearTimeout(timer);
      done = true;
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {}
      ctx.logs.finish(rec.id, {
        durationMs: Date.now() - started,
        response: { status: upstream.status, headers: respHeaders, stream: false, truncated: false, body: parsed ?? text, usage: parsed?.usage ?? null },
      });
      return json(res, upstream.ok ? 200 : 502, {
        ok: upstream.ok,
        status: upstream.status,
        model,
        content: parsed?.choices?.[0]?.message?.content ?? '',
        usage: parsed?.usage ?? null,
        raw: parsed ?? text,
        error: upstream.ok ? undefined : `上游返回 ${upstream.status}`,
      });
    }

    if (!upstream.ok) {
      const text = await upstream.text();
      clearTimeout(timer);
      done = true;
      ctx.logs.finish(rec.id, {
        durationMs: Date.now() - started,
        response: { status: upstream.status, headers: respHeaders, stream: true, truncated: false, body: text, usage: null },
      });
      return json(res, 502, { ok: false, status: upstream.status, error: `上游返回 ${upstream.status}`, detail: text.slice(0, 2000) });
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const chunks = [];
    let captured = 0;
    if (upstream.body) {
      for await (const chunk of upstream.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        res.write(buf);
        if (captured < MAX_CAPTURE) {
          const room = MAX_CAPTURE - captured;
          const take = buf.length > room ? buf.subarray(0, room) : buf;
          chunks.push(take);
          captured += take.length;
        }
      }
    }
    clearTimeout(timer);
    done = true;
    res.end();

    const assembled = Buffer.concat(chunks).toString('utf8');
    ctx.logs.finish(rec.id, {
      durationMs: Date.now() - started,
      response: { status: upstream.status, headers: respHeaders, stream: true, truncated: false, body: assembled, usage: extractUsage(assembled, true) },
    });
  } catch (err) {
    clearTimeout(timer);
    done = true;
    const message = err?.message || String(err);
    ctx.logs.finish(rec.id, { durationMs: Date.now() - started, error: { name: err?.name || 'Error', message } });
    if (!res.headersSent) return json(res, 502, { ok: false, error: `测试失败: ${message}` });
    try {
      res.end();
    } catch {}
  }
}
