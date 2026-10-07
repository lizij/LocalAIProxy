const $ = (id) => document.getElementById(id);
const logList = $('logList');
const historyView = $('historyView');

const state = {
  records: new Map(),
  dom: new Map(),
  sinceSeq: 0,
  paused: false,
  search: '',
  status: '',
  es: null,
  connecting: false,
  lastFile: null,
  lastFileOffset: 0,
};

function setStatus(ok, text) {
  const node = $('status');
  node.textContent = text || (ok ? '已连接' : '未连接');
  node.className = 'status ' + (ok ? 'ok' : 'bad');
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    showLogin('需要管理口令');
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function showLogin(msg) {
  $('loginCard').hidden = false;
  $('loginHint').textContent = msg || '';
  setStatus(false, '未登录');
}

function hideLogin() {
  $('loginCard').hidden = true;
  $('loginHint').textContent = '';
}

/* ---------- 记录渲染 ---------- */

function shortUrl(u) {
  try {
    const x = new URL(u);
    return x.pathname + (x.search || '');
  } catch {
    return u;
  }
}

function pre(text) {
  const p = document.createElement('pre');
  p.textContent = text;
  return p;
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => {
    btn.textContent = old;
  }, 1200);
}

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    flash(btn, '已复制');
  } catch {
    flash(btn, '复制失败');
  }
}

function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * 渲染单个文本块。
 * 短内容完整显示；超长内容默认折叠，并给出明确的「展开全部」入口——
 * 展开后完整撑开、不再裁剪，从根本上避免“内容看起来被截断”。
 */
function blockEl(text) {
  const box = document.createElement('div');
  box.className = 'block';

  const p = document.createElement('pre');
  p.textContent = text;

  const lines = text.split('\n').length;
  const long = text.length > 1500 || lines > 20;
  if (!long) {
    box.append(p);
    return box;
  }

  const bar = document.createElement('div');
  bar.className = 'block-bar';
  const toggle = document.createElement('button');
  const label = (clamped) =>
    clamped ? `展开全部（${text.length.toLocaleString()} 字符 · ${lines.toLocaleString()} 行）` : '收起';

  p.classList.add('clamped');
  toggle.textContent = label(true);
  toggle.onclick = () => {
    const clamped = p.classList.toggle('clamped');
    toggle.textContent = label(clamped);
  };
  bar.append(toggle);
  box.append(p, bar);
  return box;
}

/**
 * 渲染一个原文区块。
 */
function section(title, obj, name) {
  const wrap = document.createElement('div');
  wrap.className = 'sec';

  const blocks = [];
  if (obj && typeof obj.body === 'string') {
    const metaObj = { ...obj };
    delete metaObj.body;
    blocks.push({ label: 'meta', text: JSON.stringify(metaObj, null, 2) });
    blocks.push({ label: 'body', text: obj.body });
  } else {
    blocks.push({ label: '', text: JSON.stringify(obj, null, 2) });
  }

  const plain = blocks.map((b) => (b.label ? `# ${b.label}\n${b.text}` : b.text)).join('\n\n');
  const chars = blocks.reduce((n, b) => n + b.text.length, 0);
  const lines = blocks.reduce((n, b) => n + b.text.split('\n').length, 0);

  const head = document.createElement('div');
  head.className = 'sec-head';

  const h = document.createElement('div');
  h.className = 'sec-title';
  h.textContent = title;

  const meta = document.createElement('span');
  meta.className = 'sec-meta';
  meta.textContent = `${chars.toLocaleString()} 字符 · ${lines.toLocaleString()} 行`;

  const actions = document.createElement('div');
  actions.className = 'sec-actions';
  const copyBtn = document.createElement('button');
  copyBtn.textContent = '复制全文';
  copyBtn.onclick = () => copyToClipboard(plain, copyBtn);
  const dlBtn = document.createElement('button');
  dlBtn.textContent = '下载';
  dlBtn.onclick = () => downloadText(`${name || 'local-ai-proxy'}.txt`, plain);
  actions.append(copyBtn, dlBtn);

  head.append(h, meta, actions);
  wrap.append(head);

  for (const b of blocks) {
    if (b.label) {
      const lh = document.createElement('div');
      lh.className = 'sec-head';
      const lt = document.createElement('div');
      lt.className = 'sec-title small';
      lt.textContent = b.label;
      lh.append(lt);
      wrap.append(lh);
    }
    wrap.append(blockEl(b.text));
  }
  return wrap;
}

/* ---------- 摘要（面向普通用户，优先于原始报文阅读） ---------- */

function truncate(s, n = 600) {
  return s.length > n ? `${s.slice(0, n)} …（原文共 ${s.length.toLocaleString()} 字符）` : s;
}

function msgText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p?.type === 'text') return p.text || '';
        if (p?.type === 'image_url') return '[图片]';
        return `[${p?.type || 'part'}]`;
      })
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

/** 从原始响应里提取「人话」：回复文本、思考文本、结束原因、token 用量。 */
function extractReply(rec) {
  const resp = rec.response;
  if (!resp) return null;
  let content = '';
  let reasoning = '';
  let finish = '';
  let model = '';
  let usage = resp.usage || null;

  if (resp.stream && typeof resp.body === 'string') {
    for (const line of resp.body.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const p = t.slice(5).trim();
      if (!p || p === '[DONE]') continue;
      let obj;
      try {
        obj = JSON.parse(p);
      } catch {
        continue;
      }
      if (obj.model) model = obj.model;
      const ch = obj.choices?.[0];
      if (ch) {
        if (ch.delta?.content) content += ch.delta.content;
        if (ch.delta?.reasoning_content) reasoning += ch.delta.reasoning_content;
        if (ch.finish_reason) finish = ch.finish_reason;
      }
      if (obj.usage) usage = obj.usage;
    }
  } else if (resp.body && typeof resp.body === 'object') {
    const b = resp.body;
    model = b.model || '';
    const ch = b.choices?.[0];
    if (ch) {
      content = msgText(ch.message?.content);
      reasoning = msgText(ch.message?.reasoning_content);
      finish = ch.finish_reason || '';
    }
    usage = b.usage || usage;
  }
  return { content, reasoning, finish, model, usage };
}

function sumRow(k, v, cls) {
  const row = document.createElement('div');
  row.className = 'sum-row' + (cls ? ' ' + cls : '');
  const kk = document.createElement('span');
  kk.className = 'sum-k';
  kk.textContent = k;
  const vv = document.createElement('span');
  vv.className = 'sum-v';
  vv.textContent = v;
  row.append(kk, vv);
  return row;
}

function sumMsg(role, cls, text) {
  const row = document.createElement('div');
  row.className = 'sum-msg';
  const r = document.createElement('span');
  r.className = 'role ' + cls;
  r.textContent = role;
  const t = document.createElement('div');
  t.className = 'txt';
  t.textContent = text;
  row.append(r, t);
  return row;
}

function summaryEl(rec) {
  const box = document.createElement('div');
  box.className = 'summary';

  const title = document.createElement('div');
  title.className = 'sum-title';
  title.textContent = '摘要';
  box.append(title);

  // 发送了什么
  const reqBody = rec.request?.body;
  const msgs = Array.isArray(reqBody?.messages) ? reqBody.messages : [];
  const other = reqBody && typeof reqBody === 'object'
    ? Object.keys(reqBody).filter((k) => !['messages', 'model', 'stream'].includes(k))
    : [];
  const bits = [];
  if (reqBody?.model) bits.push(`模型 ${reqBody.model}`);
  bits.push(reqBody?.stream ? '流式' : '非流式');
  bits.push(`消息 ${msgs.length} 条`);
  if (other.length) bits.push(`其它参数 ${other.join(' / ')}`);

  box.append(sumRow('发送', bits.join(' · ')));
  box.append(sumRow('目标', `${rec.request?.method || ''} ${rec.request?.url || ''}`));
  for (const m of msgs) box.append(sumMsg(m.role || '?', m.role || '', truncate(msgText(m.content))));

  // 收到了什么
  if (rec.error) {
    box.append(sumRow('接收', `失败：${rec.error.message}`, 'bad'));
  } else if (!rec.response) {
    box.append(sumRow('接收', '等待响应…', 'dim'));
  } else {
    const reply = extractReply(rec);
    const line = `HTTP ${rec.response.status} · 耗时 ${rec.durationMs ?? '-'} ms`;
    box.append(sumRow('接收', reply.finish ? `${line} · finish_reason=${reply.finish}` : line));
    if (reply.reasoning) box.append(sumMsg('思考', 'reasoning', truncate(reply.reasoning)));
    if (reply.content) box.append(sumMsg('助手', 'assistant', truncate(reply.content)));
    if (!reply.reasoning && !reply.content) box.append(sumRow('回复', '（响应中没有文本内容）', 'dim'));

    const u = reply.usage;
    if (u) {
      const ubits = [`输入 ${u.prompt_tokens ?? '-'}`, `输出 ${u.completion_tokens ?? '-'}`, `合计 ${u.total_tokens ?? '-'}`];
      if (u.prompt_tokens_details?.cached_tokens != null) ubits.push(`缓存命中 ${u.prompt_tokens_details.cached_tokens}`);
      if (u.completion_tokens_details?.reasoning_tokens != null) ubits.push(`思考 ${u.completion_tokens_details.reasoning_tokens}`);
      box.append(sumRow('用量', ubits.join(' · ')));
    }
    if (rec.response.truncated) box.append(sumRow('提示', '原始响应过大，已截断记录', 'bad'));
  }

  return box;
}

function searchTextOf(rec) {
  let respBody = '';
  if (rec.response) respBody = typeof rec.response.body === 'string' ? rec.response.body : JSON.stringify(rec.response.body || '');
  const s = [
    rec.request?.url || '',
    rec.request?.method || '',
    rec.request?.body?.model || '',
    JSON.stringify(rec.request?.body || ''),
    respBody.slice(0, 4000),
    rec.error?.message || '',
  ].join(' ');
  return s.toLowerCase();
}

function buildItem(rec) {
  const item = document.createElement('div');
  item.className = 'log-item';
  item.dataset.id = rec.id;
  item.dataset.status = rec.status;
  item._search = searchTextOf(rec);

  const head = document.createElement('div');
  head.className = 'log-head';

  const badge = document.createElement('span');
  badge.className = 'badge ' + rec.status;
  badge.textContent =
    rec.status === 'pending' ? '···' : rec.status === 'done' ? String(rec.response?.status ?? 'ok') : 'ERR';

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = new Date(rec.ts).toLocaleTimeString();

  const method = document.createElement('span');
  method.className = 'method';
  method.textContent = rec.request?.method || '';

  const url = document.createElement('span');
  url.className = 'url';
  url.textContent = shortUrl(rec.request?.url || '');

  const model = document.createElement('span');
  model.className = 'model';
  model.textContent = rec.request?.body?.model || '';

  const dur = document.createElement('span');
  dur.className = 'dur';
  dur.textContent = rec.durationMs != null ? rec.durationMs + ' ms' : '';

  head.append(badge, time, method, url, model, dur);

  const body = document.createElement('div');
  body.className = 'log-body';
  body.hidden = true;

  // 先给「人话」摘要，再给原始报文
  body.append(summaryEl(rec));
  const rawHead = document.createElement('div');
  rawHead.className = 'raw-head';
  rawHead.textContent = '原始报文（排查细节用）';
  body.append(rawHead);

  if (rec.request) body.append(section('→ 请求 (发往 Provider)', rec.request, `seq${rec.seq}-request`));
  if (rec.response) body.append(section('← 响应', rec.response, `seq${rec.seq}-response`));
  if (!rec.response && rec.status === 'pending') body.append(section('← 响应', { status: '等待中…' }, `seq${rec.seq}-response`));
  if (rec.error) body.append(section('✗ 错误', rec.error, `seq${rec.seq}-error`));

  head.addEventListener('click', () => {
    body.hidden = !body.hidden;
  });

  item.append(head, body);
  return item;
}

function applyFilterTo(node, rec) {
  const statusOk = !state.status || rec.status === state.status;
  const searchOk = !state.search || (node._search || '').includes(state.search);
  node.hidden = !(statusOk && searchOk);
}

function applyFilters() {
  for (const [id, node] of state.dom) {
    const rec = state.records.get(id);
    if (rec) applyFilterTo(node, rec);
  }
}

function updateMeta() {
  $('logMeta').textContent = `${state.records.size} 条已加载 · 最新 seq ${state.sinceSeq}`;
}

function trimDom() {
  while (logList.children.length > 1000) logList.lastElementChild.remove();
  if (state.records.size > 2000) {
    const arr = [...state.records.values()].sort((a, b) => a.seq - b.seq);
    for (const rec of arr.slice(0, state.records.size - 2000)) {
      state.records.delete(rec.id);
      state.dom.delete(rec.id);
    }
  }
}

function upsert(rec) {
  state.records.set(rec.id, rec);
  if (rec.seq > state.sinceSeq) state.sinceSeq = rec.seq;
  updateMeta();
  if (state.paused) return;

  const node = buildItem(rec);
  const old = state.dom.get(rec.id);
  // old 可能已被 trimDom 移出 DOM（脱离文档），此时必须重新插入，否则该记录会从列表消失。
  if (old && old.isConnected) old.replaceWith(node);
  else logList.prepend(node);
  state.dom.set(rec.id, node);
  applyFilterTo(node, rec);
  trimDom();
}

function reRenderAll() {
  logList.innerHTML = '';
  state.dom.clear();
  const arr = [...state.records.values()].sort((a, b) => b.seq - a.seq);
  for (const rec of arr) {
    const node = buildItem(rec);
    state.dom.set(rec.id, node);
    applyFilterTo(node, rec);
    logList.append(node);
  }
}

/* ---------- 实时流 ---------- */

function disconnect() {
  if (state.es) {
    state.es.close();
    state.es = null;
  }
}

function connect() {
  disconnect();
  const es = new EventSource(`/api/admin/logs/stream?since=${state.sinceSeq}`);
  state.es = es;
  es.addEventListener('record', (e) => {
    try {
      upsert(JSON.parse(e.data));
    } catch {}
  });
  es.onopen = () => setStatus(true, '已连接');
  es.onerror = () => {
    es.close();
    state.es = null;
    setStatus(false, '重连中…');
    setTimeout(() => {
      if (!state.paused) connect();
    }, 2000);
  };
}

/* ---------- 历史文件 ---------- */

async function loadFiles() {
  const { files } = await api('/api/admin/logs/files');
  const box = $('fileList');
  box.innerHTML = '';
  if (!files.length) {
    box.textContent = '暂无历史文件';
    return;
  }
  for (const f of files) {
    const b = document.createElement('button');
    b.textContent = `${f.name} (${(f.size / 1024).toFixed(1)} KB)`;
    b.onclick = () => {
      [...box.children].forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      loadFile(f.name, 0);
    };
    box.append(b);
  }
}

async function loadFile(name, offset) {
  const data = await api(
    `/api/admin/logs/file?name=${encodeURIComponent(name)}&offset=${offset}&limit=200`,
  );
  if (offset === 0) historyView.innerHTML = '';
  for (const rec of data.records) historyView.append(buildItem(rec));
  state.lastFile = name;
  state.lastFileOffset = offset + data.records.length;
  if (data.hasMore) {
    const more = document.createElement('button');
    more.textContent = '加载更早的记录';
    more.onclick = () => {
      more.remove();
      loadFile(name, state.lastFileOffset);
    };
    historyView.append(more);
  }
}

/* ---------- 配置 ---------- */

async function loadConfig() {
  const { config } = await api('/api/admin/config');
  const st = await api('/api/admin/status');
  const host = location.hostname || '127.0.0.1';
  $('baseUrlOut').value = `http://${host}:${st.proxy.port}/v1`;
  $('version').textContent = `LocalAIProxy v${st.version || '0.0.0'}${st.profile === 'test' ? ' · 测试档' : ''}`;
  $('apiKeyOut').value = config.proxy.apiKey;
  $('requireClientKey').checked = !!config.proxy.requireClientKey;
  $('upBaseUrl').value = config.upstream.baseUrl || '';
  $('upApiKey').value = config.upstream.apiKey || '';
  $('upModel').value = config.upstream.model || '';
  $('upInsecure').checked = !!config.upstream.insecureTLS;
  hideLogin();
  setStatus(true, '已连接');
  connect();
}

async function saveConfig() {
  const upstream = {
    baseUrl: $('upBaseUrl').value.trim(),
    model: $('upModel').value.trim(),
    insecureTLS: $('upInsecure').checked,
  };
  const key = $('upApiKey').value.trim();
  if (key && !key.includes('*')) upstream.apiKey = key;

  await api('/api/admin/config', {
    method: 'PUT',
    body: { upstream, proxy: { requireClientKey: $('requireClientKey').checked } },
  });
  $('saveHint').textContent = '已保存';
  setTimeout(() => ($('saveHint').textContent = ''), 2000);
  await loadConfig();
}

/* ---------- 事件绑定 ---------- */

document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.onclick = async () => {
    const input = $(btn.dataset.copy);
    try {
      await navigator.clipboard.writeText(input.value);
      const old = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => (btn.textContent = old), 1200);
    } catch {}
  };
});

$('loginBtn').onclick = async () => {
  try {
    await api('/api/admin/login', { method: 'POST', body: { password: $('password').value } });
    $('password').value = '';
    await loadConfig();
  } catch (err) {
    $('loginHint').textContent = err.message;
  }
};

$('password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('loginBtn').click();
});

$('saveConfig').onclick = () => saveConfig().catch((e) => ($('saveHint').textContent = e.message));

$('rotateKey').onclick = async () => {
  if (!confirm('重置后所有客户端需要更新 Key，确定继续？')) return;
  const { apiKey } = await api('/api/admin/keys/rotate', { method: 'POST' });
  $('apiKeyOut').value = apiKey;
};

$('pauseBtn').onclick = () => {
  state.paused = !state.paused;
  $('pauseBtn').textContent = state.paused ? '继续' : '暂停';
  if (state.paused) disconnect();
  else {
    reRenderAll();
    connect();
  }
};

$('clearBtn').onclick = () => {
  logList.innerHTML = '';
  state.dom.clear();
  state.records.clear();
  updateMeta();
};

$('search').addEventListener('input', (e) => {
  state.search = e.target.value.trim().toLowerCase();
  applyFilters();
});

$('statusFilter').addEventListener('change', (e) => {
  state.status = e.target.value;
  applyFilters();
});

$('historyBtn').onclick = async () => {
  const card = $('historyCard');
  card.hidden = !card.hidden;
  if (!card.hidden) await loadFiles();
};

/* ---------- 上游测试 ---------- */

async function runTest() {
  const prompt = $('testPrompt').value.trim();
  const stream = $('testStream').checked;
  const via = $('testVia').value;
  const viaLabel = via === 'proxy' ? '经本地代理' : '直连上游';
  const box = $('testBox');
  const out = $('testOutput');
  const meta = $('testMeta');

  box.hidden = false;
  out.textContent = '';
  meta.textContent = `测试中…（${viaLabel}）`;
  $('testHint').textContent = '';

  try {
    const res = await fetch('/api/admin/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, stream, via }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      meta.textContent = `✗ ${viaLabel} · ` + (data.error || `HTTP ${res.status}`);
      if (data.detail) out.textContent = data.detail;
      $('testHint').textContent = '失败';
      return;
    }

    if (!stream) {
      const data = await res.json();
      meta.textContent =
        `✓ ${viaLabel} · HTTP ${data.status} · model=${data.model}` +
        (data.usage ? ` · tokens=${data.usage.total_tokens ?? '-'}` : '');
      out.textContent = data.content || JSON.stringify(data.raw, null, 2);
      $('testHint').textContent = '成功';
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let text = '';
    let usage = null;
    let model = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const p = t.slice(5).trim();
        if (!p || p === '[DONE]') continue;
        let obj;
        try {
          obj = JSON.parse(p);
        } catch {
          continue;
        }
        if (obj.model) model = obj.model;
        const delta = obj.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          out.textContent = text;
        }
        if (obj.usage) usage = obj.usage;
      }
    }
    meta.textContent = `✓ ${viaLabel} · 流式完成 · model=${model}` + (usage ? ` · tokens=${usage.total_tokens ?? '-'}` : '');
    $('testHint').textContent = '成功';
  } catch (err) {
    meta.textContent = '✗ ' + err.message;
    $('testHint').textContent = '失败';
  }
}

$('testBtn').onclick = async () => {
  $('testHint').textContent = '保存配置…';
  const upstream = {
    baseUrl: $('upBaseUrl').value.trim(),
    model: $('upModel').value.trim(),
    insecureTLS: $('upInsecure').checked,
  };
  const key = $('upApiKey').value.trim();
  if (key && !key.includes('*')) upstream.apiKey = key;
  try {
    await api('/api/admin/config', {
      method: 'PUT',
      body: { upstream, proxy: { requireClientKey: $('requireClientKey').checked } },
    });
  } catch (err) {
    $('testHint').textContent = '保存失败: ' + err.message;
    return;
  }
  await runTest();
};

$('testPrompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('testBtn').click();
});

/* ---------- 启动 ---------- */
loadConfig().catch((err) => {
  if (err.message !== 'unauthorized') setStatus(false, err.message);
});
