import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveLogDir } from '../config.js';

function pad(n) {
  return String(n).padStart(2, '0');
}

function dayKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 日志核心：内存 Ring Buffer（供网页即时读取/实时推送）+ 异步 JSONL 落盘（可回看）。
 *
 * 两阶段记录：
 *   start()  -> 收到请求时立即入内存（status=pending），网页马上能看到请求原文
 *   finish() -> 响应结束/出错时更新内存记录，并把最终态追加落盘
 */
export class LogStore {
  constructor(config) {
    this.config = config;
    this.buffer = [];
    this.byId = new Map();
    this.seq = 0;
    this.listeners = new Set();

    this.stream = null;
    this.day = null;
    this.index = 0;
    this.streamBytes = 0;
    this.file = null;
  }

  get dir() {
    return resolveLogDir(this.config);
  }

  get maxMemory() {
    const n = Number(this.config.get().log.memorySize);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1000;
  }

  get maxBytes() {
    const mb = Number(this.config.get().log.maxFileSizeMB) || 64;
    return mb * 1024 * 1024;
  }

  start({ client, request }) {
    this.seq += 1;
    const rec = {
      seq: this.seq,
      id: crypto.randomUUID(),
      status: 'pending',
      ts: new Date().toISOString(),
      durationMs: null,
      client: client || {},
      request: request || null,
      response: null,
      error: null,
    };
    this.buffer.push(rec);
    this.byId.set(rec.id, rec);
    while (this.buffer.length > this.maxMemory) {
      const oldest = this.buffer.shift();
      this.byId.delete(oldest.id);
    }
    this.#notify(rec);
    return rec;
  }

  finish(id, { response = null, error = null, durationMs = null } = {}) {
    const rec = this.byId.get(id);
    if (!rec) return null;
    rec.status = error ? 'error' : 'done';
    rec.durationMs = durationMs;
    if (response) rec.response = response;
    rec.error = error;
    this.#notify(rec);
    this.#append(rec);
    return rec;
  }

  /** 内存窗口分页查询（返回最后 limit 条，seq 升序）。 */
  list({ limit = 200, before = null } = {}) {
    let arr = this.buffer;
    if (before != null) arr = arr.filter((r) => r.seq < Number(before));
    const n = Math.max(0, Math.min(Number(limit) || 200, this.maxMemory));
    const records = arr.slice(Math.max(0, arr.length - n));
    return {
      records,
      size: this.buffer.length,
      capacity: this.maxMemory,
      minSeq: this.buffer.length ? this.buffer[0].seq : 0,
      maxSeq: this.seq,
      hasMore: arr.length > records.length,
    };
  }

  /** seq 大于给定值的记录（用于 SSE 断线补偿）。 */
  since(seq) {
    const s = Number(seq) || 0;
    return this.buffer.filter((r) => r.seq > s);
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #notify(rec) {
    for (const fn of this.listeners) {
      try {
        fn(rec);
      } catch (err) {
        console.error('[log] listener error:', err.message);
      }
    }
  }

  #append(rec) {
    try {
      this.#ensureStream();
      const line = JSON.stringify(rec) + '\n';
      this.stream.write(line);
      this.streamBytes += Buffer.byteLength(line);
    } catch (err) {
      console.error('[log] 落盘失败:', err.message);
    }
  }

  #ensureStream() {
    const day = dayKey(new Date());
    fs.mkdirSync(this.dir, { recursive: true });

    if (!this.stream) {
      this.#openStream(day, 0);
      return;
    }
    if (this.day !== day) {
      this.#openStream(day, 0);
      this.#cleanupOld();
      return;
    }
    if (this.streamBytes >= this.maxBytes) {
      this.#openStream(day, this.index + 1);
    }
  }

  #openStream(day, index) {
    if (this.stream) {
      try {
        this.stream.end();
      } catch {}
    }
    const name = index === 0 ? `${day}.jsonl` : `${day}.${index}.jsonl`;
    const file = path.join(this.dir, name);
    this.stream = fs.createWriteStream(file, { flags: 'a' });
    this.stream.on('error', (err) => console.error('[log] 写流错误:', err.message));
    this.day = day;
    this.index = index;
    this.file = file;
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {}
    this.streamBytes = size;
  }

  #cleanupOld() {
    const maxDays = Number(this.config.get().log.maxDays) || 7;
    const cutoff = Date.now() - maxDays * 86400000;
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const m = /^(\d{4}-\d{2}-\d{2})(\.\d+)?\.jsonl$/.exec(name);
      if (!m) continue;
      const t = Date.parse(`${m[1]}T00:00:00`);
      if (Number.isFinite(t) && t < cutoff) {
        try {
          fs.unlinkSync(path.join(this.dir, name));
        } catch {}
      }
    }
  }

  async close() {
    if (!this.stream) return;
    await new Promise((resolve) => this.stream.end(resolve));
    this.stream = null;
  }
}
