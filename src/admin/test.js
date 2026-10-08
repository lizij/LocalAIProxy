import { maskSecret, activeProvider } from '../config.js';
import { buildUpstreamUrl, extractUsage } from '../proxy/forward.js';
import { json, readJson } from './http.js';

const DEFAULT_PROMPT = '你好，请用一句话介绍你自己。';
const MAX_CAPTURE = 1024 * 1024;
const TEST_TIMEOUT_MS = 60000;

/**
 * 管理端「网页测试」：用已保存的配置发一次真实 chat/completions 请求。
 *
 * 支持两条路径（由 body.via 决定，接口会把实际使用的路径回传给前端展示）：
 * - 'upstream'（默认）：**直连上游**，绕过本地代理，只验证 Provider 配置本身是否正确；
 * - 'proxy'：**经本地代理**，打 http://127.0.0.1:<proxyPort>/v1/chat/completions，
 *   验证端到端链路（本地 Key 鉴权 → 转发 → 日志落库）。此时不在此处重复记日志，
 *   由代理自身记录，日志里能看到一条真实的客户端请求。
 *
 * 返回形式：非流式回 JSON（内容 + usage + 原始响应）；流式把上游 SSE 原文透传给浏览器。
 */
export async function handleTest(req, res, ctx) {
  const cfg = ctx.config.get();
  const provider = activeProvider(cfg);
  if (!provider || !provider.baseUrl) {
    return json(res, 400, { ok: false, error: '上游 Provider 未配置：请先添加一个 Provider 并填写 Base URL 与 API Key。' });
  }

  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return json(res, 400, { ok: false, error: err.message });
  }

  const via = body.via === 'proxy' ? 'proxy' : 'upstream';
  const useProxy = via === 'proxy';

  const prompt = (body.prompt && String(body.prompt).trim()) || DEFAULT_PROMPT;
  const model = (body.model && String(body.model).trim()) || provider.model || '';
  const stream = !!body.stream;
  if (!model) {
    return json(res, 400, { ok: false, error: '未指定 model：请在该 Provider 的「Model（兜底）」字段填写，或填写测试用模型。' });
  }

  const headers = { 'content-type': 'application/json' };
  let url;
  if (useProxy) {
    url = `http://127.0.0.1:${cfg.proxy.port}/v1/chat/completions`;
    headers.authorization = `Bearer ${cfg.proxy.apiKey}`;
  } else {
    url = buildUpstreamUrl(provider.baseUrl, '/v1/chat/completions');
    if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  }
  const payload = { model, messages: [{ role: 'user', content: prompt }], stream };

  const started = Date.now();
  const rec = useProxy
    ? null
    : ctx.logs.start({
        client: { ip: 'admin:test(直连上游)', ua: 'LocalAIProxy Console' },
        request: {
          method: 'POST',
          url,
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + maskSecret(provider.apiKey) },
          body: payload,
        },
      });
  const logFinish = (payloadLog) => {
    if (rec) ctx.logs.finish(rec.id, payloadLog);
  };

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
      logFinish({
        durationMs: Date.now() - started,
        response: { status: upstream.status, headers: respHeaders, stream: false, truncated: false, body: parsed ?? text, usage: parsed?.usage ?? null },
      });
      return json(res, upstream.ok ? 200 : 502, {
        ok: upstream.ok,
        via,
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
      logFinish({
        durationMs: Date.now() - started,
        response: { status: upstream.status, headers: respHeaders, stream: true, truncated: false, body: text, usage: null },
      });
      return json(res, 502, { ok: false, via, status: upstream.status, error: `上游返回 ${upstream.status}`, detail: text.slice(0, 2000) });
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-lap-via': via,
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
    logFinish({
      durationMs: Date.now() - started,
      response: { status: upstream.status, headers: respHeaders, stream: true, truncated: false, body: assembled, usage: extractUsage(assembled, true) },
    });
  } catch (err) {
    clearTimeout(timer);
    done = true;
    const message = err?.message || String(err);
    logFinish({ durationMs: Date.now() - started, error: { name: err?.name || 'Error', message } });
    if (!res.headersSent) return json(res, 502, { ok: false, via, error: `测试失败: ${message}` });
    try {
      res.end();
    } catch {}
  }
}
