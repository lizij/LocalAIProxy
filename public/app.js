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

function section(title, obj) {
  const wrap = document.createElement('div');
  wrap.className = 'sec';
  const h = document.createElement('div');
  h.className = 'sec-title';
  h.textContent = title;
  wrap.append(h);

  if (obj && typeof obj.body === 'string') {
    const meta = { ...obj };
    delete meta.body;
    wrap.append(pre(JSON.stringify(meta, null, 2)));
    const bh = document.createElement('div');
    bh.className = 'sec-title small';
    bh.textContent = 'body';
    wrap.append(bh);
    wrap.append(pre(obj.body));
  } else {
    wrap.append(pre(JSON.stringify(obj, null, 2)));
  }
  return wrap;
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
  if (rec.request) body.append(section('→ 请求 (发往 Provider)', rec.request));
  if (rec.response) body.append(section('← 响应', rec.response));
  if (!rec.response && rec.status === 'pending') body.append(section('← 响应', { status: '等待中…' }));
  if (rec.error) body.append(section('✗ 错误', rec.error));

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
  $('version').textContent = `LocalAIProxy v${st.version || '0.0.0'}`;
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
  const box = $('testBox');
  const out = $('testOutput');
  const meta = $('testMeta');

  box.hidden = false;
  out.textContent = '';
  meta.textContent = '测试中…';
  $('testHint').textContent = '';

  try {
    const res = await fetch('/api/admin/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, stream }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      meta.textContent = '✗ ' + (data.error || `HTTP ${res.status}`);
      if (data.detail) out.textContent = data.detail;
      $('testHint').textContent = '失败';
      return;
    }

    if (!stream) {
      const data = await res.json();
      meta.textContent =
        `✓ HTTP ${data.status} · model=${data.model}` +
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
    meta.textContent = `✓ 流式完成 · model=${model}` + (usage ? ` · tokens=${usage.total_tokens ?? '-'}` : '');
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
