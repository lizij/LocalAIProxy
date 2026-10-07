import crypto from 'node:crypto';

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function extractToken(req) {
  const auth = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(auth));
  if (m) return m[1].trim();
  const apiKey = req.headers['api-key'];
  if (apiKey) return String(apiKey).trim();
  return auth ? String(auth).trim() : '';
}

/** 校验客户端带来的本地 Key。返回 true 表示放行。 */
export function checkClientKey(req, config) {
  const cfg = config.get();
  if (!cfg.proxy.requireClientKey) return true;
  const expected = cfg.proxy.apiKey || '';
  if (!expected) return true;
  const token = extractToken(req);
  return token.length > 0 && safeEqual(token, expected);
}
