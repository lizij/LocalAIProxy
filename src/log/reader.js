import fs from 'node:fs';
import path from 'node:path';

const FILE_RE = /^\d{4}-\d{2}-\d{2}(\.\d+)?\.jsonl$/;

/** 列出历史日志文件（最新在前）。 */
export function listLogFiles(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!FILE_RE.test(name)) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      out.push({ name, size: st.size, mtime: st.mtime.toISOString() });
    } catch {}
  }
  out.sort((a, b) => (a.name < b.name ? 1 : -1));
  return out;
}

/**
 * 读取历史文件的分页切片。
 * offset 表示“从文件末尾往回跳过多少行”，limit 为本次返回行数。
 */
export function readLogFile(dir, name, { offset = 0, limit = 200 } = {}) {
  if (!FILE_RE.test(String(name))) {
    const err = new Error('非法的日志文件名');
    err.code = 'INVALID_NAME';
    throw err;
  }
  const file = path.join(dir, name);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    const err = new Error('日志文件不存在');
    err.code = 'NOT_FOUND';
    throw err;
  }

  const lines = text.split('\n').filter((l) => l.trim());
  const total = lines.length;
  const n = Math.max(1, Math.min(Number(limit) || 200, 2000));
  const off = Math.max(0, Number(offset) || 0);
  const end = Math.max(0, total - off);
  const start = Math.max(0, end - n);

  const records = [];
  for (const line of lines.slice(start, end)) {
    try {
      records.push(JSON.parse(line));
    } catch {}
  }

  return {
    name,
    records,
    total,
    offset: off,
    limit: n,
    hasMore: start > 0,
  };
}
