import http from 'node:http';
import { checkClientKey } from './auth.js';
import { proxyRequest, sendError } from './forward.js';
import { VERSION } from '../version.js';
import { PROFILE } from '../config.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
};

export function createProxyServer(ctx) {
  return http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }

    const pathname = (req.url || '').split('?')[0];

    if (pathname === '/health') {
      const cfg = ctx.config.get();
      res.setHeader('content-type', 'application/json; charset=utf-8');
      return res.end(
        JSON.stringify({
          status: 'ok',
          version: VERSION,
          profile: PROFILE,
          upstreamConfigured: !!cfg.upstream.baseUrl,
          uptimeSeconds: Math.round(process.uptime()),
        }),
      );
    }

    if (!pathname.startsWith('/v1/')) {
      return sendError(res, 404, 'not_found', '仅代理 /v1/* 接口');
    }

    if (!checkClientKey(req, ctx.config)) {
      return sendError(res, 401, 'invalid_api_key', 'API Key 无效或缺失');
    }

    await proxyRequest(req, res, ctx);
  });
}
