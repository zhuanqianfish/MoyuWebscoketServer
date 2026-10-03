/* ==========================================================
   摸鱼图片中转站 — 前端逻辑
   WebSocket 接收广播 / 画廊渲染 / 灯箱 / 保存 / 打包下载
   ========================================================== */
'use strict';

/* ── 常量与状态 ───────────────────────────────────────── */
const MAX_CARDS = 500;          // 页面最多保留的卡片数
const RECONNECT_STEPS = [800, 1600, 3000, 5000, 8000];
const LS_PAUSED = 'moyu.paused';
const LS_SOUND  = 'moyu.sound';

const state = {
  items: [],          // 全部图片记录（新→旧）
  seen: new Set(),    // 去重
  paused: localStorage.getItem(LS_PAUSED) === '1',
  sound: localStorage.getItem(LS_SOUND) !== '0',
  filter: 'all',
  sort: 'new',
  liveOnly: [],       // 「仅新图」模式下本次会话新收到的
  lbIndex: -1,
  ws: null,
  retry: 0,
  freshCount: 0,
};

/* ── DOM ─────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const el = {
  gallery: $('gallery'), empty: $('empty'), emptyWs: $('emptyWs'), emptyHttp: $('emptyHttp'),
  conn: $('conn'), connText: document.querySelector('#conn .conn-text'),
  statImages: $('statImages'), statClients: $('statClients'),
  statSize: $('statSize'), statUptime: $('statUptime'),
  viewCount: $('viewCount'),
  btnPause: $('btnPause'), btnSound: $('btnSound'), soundIcon: $('soundIcon'),
  btnSaveAll: $('btnSaveAll'), btnClear: $('btnClear'),
  lightbox: $('lightbox'), lbImg: $('lbImg'), lbTitle: $('lbTitle'), lbTags: $('lbTags'),
  lbClose: $('lbClose'), lbPrev: $('lbPrev'), lbNext: $('lbNext'),
  toasts: $('toasts'),
};

/* ── 工具函数 ────────────────────────────────────────── */
function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

function fmtUptime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, kind = 'info', ttl = 3600) {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = msg;
  el.toasts.appendChild(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 300);
  }, ttl);
}

/* 短促提示音（WebAudio 合成，无需外部文件） */
function ding() {
  if (!state.sound) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = ding._ctx || (ding._ctx = new Ctx());
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.09);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.24);
  } catch { /* 静默失败，提示音非关键 */ }
}

/* ── WebSocket ───────────────────────────────────────── */
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/ws`;
  el.emptyWs.textContent = url;
  el.emptyHttp.textContent = location.origin;

  setConn('connecting', '连接中…');

  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }
  state.ws = ws;

  ws.onopen = () => {
    state.retry = 0;
    setConn('online', '已连接');
    // 请求一次历史（服务端也会主动推 hello，保留这条作为兜底）
    ws.send(JSON.stringify({ type: 'ping' }));
  };

  ws.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    handleMessage(msg);
  };

  ws.onerror = () => setConn('offline', '连接出错');

  ws.onclose = () => {
    setConn('offline', '已断开');
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  const wait = RECONNECT_STEPS[Math.min(state.retry, RECONNECT_STEPS.length - 1)];
  state.retry += 1;
  setTimeout(connect, wait);
}

function setConn(status, text) {
  el.conn.classList.remove('online', 'offline');
  if (status === 'online') el.conn.classList.add('online');
  else if (status === 'offline') el.conn.classList.add('offline');
  el.connText.textContent = text;
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'hello':
    case 'welcome':
      applyStats(msg.stats);
      if (Array.isArray(msg.items)) {
        let added = 0;
        msg.items.forEach((it) => { if (addItem(it, false)) added += 1; });
        if (added) render();
      }
      break;

    case 'image':
      if (msg.record && addItem(msg.record, true)) render();
      applyStats(msg.stats);
      break;

    case 'removed':
      removeItem(msg.id);
      applyStats(msg.stats);
      break;

    case 'cleared':
      state.items = [];
      state.seen.clear();
      state.liveOnly = [];
      render();
      applyStats(msg.stats);
      break;

    case 'stats':
    case 'ack':
      applyStats(msg.stats);
      break;

    case 'error':
      toast(`服务端：${msg.message || '未知错误'}`, 'err');
      break;
  }
}

/* ── 数据 ────────────────────────────────────────────── */
function addItem(rec, isNew) {
  if (!rec || !rec.id || state.seen.has(rec.id)) return false;
  state.seen.add(rec.id);

  const item = {
    ...rec,
    url: rec.url || `/media/${rec.id}`,
    download_url: rec.download_url || `/download/${rec.id}`,
    isNew: Boolean(isNew),
  };

  state.items.unshift(item);
  if (isNew) {
    state.liveOnly.unshift(item);
    state.freshCount += 1;
    if (!state.paused) {
      toast(`收到 ${item.label || '新图片'}`, 'ok', 2400);
      ding();
    }
  }

  if (state.items.length > MAX_CARDS) {
    const dropped = state.items.splice(MAX_CARDS);
    dropped.forEach((d) => state.seen.delete(d.id));
  }
  return true;
}

function removeItem(id) {
  state.items = state.items.filter((i) => i.id !== id);
  state.liveOnly = state.liveOnly.filter((i) => i.id !== id);
  state.seen.delete(id);
  render();
}

function applyStats(s) {
  if (!s) return;
  el.statImages.textContent = s.images ?? 0;
  el.statClients.textContent = s.clients ?? 0;
  el.statSize.textContent = fmtSize(s.bytes);
  el.statUptime.textContent = fmtUptime(s.uptime);
}

/* ── 渲染 ────────────────────────────────────────────── */
function visibleItems() {
  let list = state.filter === 'live' ? state.liveOnly.slice() : state.items.slice();
  if (state.sort === 'new') list.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  else if (state.sort === 'old') list.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  else if (state.sort === 'big') list.sort((a, b) => (b.size || 0) - (a.size || 0));
  return list;
}

function render() {
  const list = visibleItems();

  el.viewCount.textContent = `${list.length} 张`;
  el.empty.classList.toggle('show', list.length === 0);
  el.gallery.style.display = list.length === 0 ? 'none' : '';

  // 文档片段批量插入，避免逐个 append 造成的多次重排
  const frag = document.createDocumentFragment();
  const freshCards = [];
  list.forEach((item, idx) => {
    const card = buildCard(item, idx);
    if (item.isNew && state.freshCount <= 12) freshCards.push(card);
    frag.appendChild(card);
  });

  el.gallery.replaceChildren(frag);
  el.btnSaveAll.disabled = list.length === 0;
  el.btnClear.disabled = state.items.length === 0;

  // 新图入场后闪一下描边，方便在大量图片里一眼定位
  freshCards.forEach((c) => {
    c.style.outline = '2px solid var(--accent-2)';
    c.style.outlineOffset = '2px';
    setTimeout(() => { c.style.outline = 'none'; }, 900);
  });
  state.freshCount = 0;
}

function buildCard(item, index) {
  const card = document.createElement('figure');
  card.className = 'card';
  card.dataset.id = item.id;
  card.dataset.index = String(index);

  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = item.label || item.filename || '图片';
  img.addEventListener('load', () => img.classList.add('loaded'));
  img.addEventListener('error', () => {
    img.classList.add('loaded');
    img.replaceWith(Object.assign(document.createElement('div'), {
      className: 'empty',
      textContent: '图片不可用',
      style: 'display:grid;place-items:center;height:232px;font-size:12px;color:var(--text-mute)',
    }));
  });
  if (item.url) img.src = item.url;
  card.appendChild(img);

  if (item.isNew) {
    const flag = document.createElement('span');
    flag.className = 'flag';
    flag.textContent = 'NEW';
    card.appendChild(flag);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(
    iconBtn('⬇', '保存图片', (e) => { e.stopPropagation(); saveOne(item.id); }),
    iconBtn('🔗', '在新标签页打开原图', (e) => { e.stopPropagation(); window.open(item.url, '_blank', 'noopener'); }),
    iconBtn('✕', '删除', (e) => { e.stopPropagation(); deleteOne(item.id); }, 'del'),
  );
  card.appendChild(actions);

  const info = document.createElement('figcaption');
  info.className = 'info';
  info.innerHTML =
    `<span class="fname" title="${escapeHtml(item.filename || '')}">${escapeHtml(item.label || item.filename || item.id)}</span>` +
    `<span class="fsize">${item.width ? `${item.width}×${item.height} · ` : ''}${fmtSize(item.size)}</span>`;
  card.appendChild(info);

  card.addEventListener('click', () => openLightbox(Number(card.dataset.index)));
  return card;
}

function iconBtn(glyph, title, onClick, extra = '') {
  const b = document.createElement('button');
  b.className = `icon-btn ${extra}`.trim();
  b.textContent = glyph;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

/* ── 保存 / 删除 ──────────────────────────────────────── */
async function saveOne(id) {
  const item = state.items.find((i) => i.id === id);
  try {
    const res = await fetch(`/download/${id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await saveBlob(await res.blob(), (item && item.filename) || `moyu-${id}.png`);
    toast('图片已保存到下载目录', 'ok', 2200);
  } catch (err) {
    toast(`保存失败：${err.message}`, 'err');
  }
}

/**
 * 触发浏览器下载。
 * 用 a[download] + blob URL，Safari/Chrome 均可用，且不受跨域限制影响。
 */
function saveBlob(blob, filename) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'image.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => { URL.revokeObjectURL(url); resolve(); }, 1500);
  });
}

async function deleteOne(id) {
  try {
    const res = await fetch(`/api/history/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toast('已删除', 'ok', 1800);
  } catch (err) {
    toast(`删除失败：${err.message}`, 'err');
  }
}

async function saveAll() {
  const list = visibleItems();
  if (!list.length) return;

  if (list.length === 1) { await saveOne(list[0].id); return; }

  if (!window.showSaveFilePicker) {
    toast(`浏览器不支持打包保存，将逐张下载 ${list.length} 张`, 'warn');
    for (const item of list) {
      await saveOne(item.id);
      await new Promise((r) => setTimeout(r, 220));
    }
    return;
  }

  let handle;
  try {
    handle = await window.showSaveFilePicker({
      suggestedName: `moyu-images-${Date.now()}.zip`,
      types: [{ description: 'ZIP 压缩包', accept: { 'application/zip': ['.zip'] } }],
    });
  } catch { return; }  // 用户取消

  toast(`正在打包 ${list.length} 张图片…`, 'info', 4000);
  const writer = await handle.createWritable();

  // ZIP 本地头/中央目录结构（store 模式，不压缩，PNG/JPG 本身已压缩）
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  const u16 = (n) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];

  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    let bytes;
    try {
      const res = await fetch(`/download/${item.id}`);
      if (!res.ok) continue;
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch { continue; }

    const name = enc.encode(item.filename || `image-${i}.png`);
    const crc = crc32(bytes);

    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(bytes.length), ...u32(bytes.length),
      ...u16(name.length), ...u16(0),
    ]);
    parts.push(local, name, bytes);

    central.push(new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(bytes.length), ...u32(bytes.length),
      ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset), ...name,
    ]));

    offset += local.length + name.length + bytes.length;
    await writer.write(parts.pop());  // 逐块写，避免占内存
  }

  let cdSize = 0;
  for (const c of central) { parts.push(c); cdSize += c.length; }

  const eocd = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(central.length), ...u16(central.length),
    ...u32(cdSize), ...u32(offset), ...u16(0),
  ]);
  parts.push(eocd);

  for (const p of parts) await writer.write(p);
  await writer.close();
  toast(`已打包保存 ${central.length} 张图片`, 'ok');
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* ── 清空 ────────────────────────────────────────────── */
async function clearAll() {
  if (!confirm('确定清空全部历史图片？服务器上的文件也会被删除，且不可恢复。')) return;
  try {
    const res = await fetch('/api/clear', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toast('已清空', 'ok');
  } catch (err) {
    toast(`清空失败：${err.message}`, 'err');
  }
}

/* ── 灯箱 ────────────────────────────────────────────── */
function openLightbox(index) {
  const list = visibleItems();
  if (!list.length) return;
  state.lbIndex = index;
  el.lightbox.hidden = false;
  paintLightbox(list);
}

function paintLightbox(list = visibleItems()) {
  const item = list[state.lbIndex];
  if (!item) { closeLightbox(); return; }

  el.lbImg.src = item.url;
  el.lbTitle.textContent = item.filename || item.label || item.id;

  const tags = [
    item.created_at_text || new Date((item.created_at || 0) * 1000).toLocaleString(),
    item.width ? `${item.width}×${item.height}` : '',
    fmtSize(item.size),
    (item.mime || '').toUpperCase(),
  ].filter(Boolean);
  el.lbTags.innerHTML = tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('');

  const multi = list.length > 1;
  el.lbPrev.style.display = multi ? '' : 'none';
  el.lbNext.style.display = multi ? '' : 'none';
}

function stepLightbox(delta) {
  const list = visibleItems();
  if (!list.length) return;
  state.lbIndex = (state.lbIndex + delta + list.length) % list.length;
  paintLightbox(list);
}

function closeLightbox() {
  el.lightbox.hidden = true;
  el.lbImg.src = '';
  state.lbIndex = -1;
}

/* ── 事件绑定 ────────────────────────────────────────── */
function bind() {
  // 过滤器
  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      state.filter = chip.dataset.filter;
      render();
    });
  });

  el.sortMode = $('sortMode');
  el.sortMode.addEventListener('change', () => { state.sort = el.sortMode.value; render(); });

  // 暂停接收
  el.btnPause.addEventListener('click', () => {
    state.paused = !state.paused;
    localStorage.setItem(LS_PAUSED, state.paused ? '1' : '0');
    syncPauseBtn();
    toast(state.paused ? '已暂停自动展示' : '已恢复接收', 'info', 2000);
  });

  // 提示音
  el.btnSound.addEventListener('click', () => {
    state.sound = !state.sound;
    localStorage.setItem(LS_SOUND, state.sound ? '1' : '0');
    syncSoundBtn();
    if (state.sound) ding();
  });

  el.btnSaveAll.addEventListener('click', saveAll);
  el.btnClear.addEventListener('click', clearAll);

  // 灯箱
  el.lbClose.addEventListener('click', closeLightbox);
  el.lbPrev.addEventListener('click', (e) => { e.stopPropagation(); stepLightbox(-1); });
  el.lbNext.addEventListener('click', (e) => { e.stopPropagation(); stepLightbox(1); });
  el.lightbox.addEventListener('click', (e) => { if (e.target === el.lightbox) closeLightbox(); });

  // 键盘
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.lightbox.hidden) { closeLightbox(); return; }
    if (el.lightbox.hidden) return;
    if (e.key === 'ArrowLeft')  { e.preventDefault(); stepLightbox(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); stepLightbox(1); }
  });

  // 后台标签页回到前台时补拉一次历史
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'ping' }));
      fetch('/api/history?limit=200').then((r) => r.json()).then((d) => {
        if (d && Array.isArray(d.items)) {
          let added = 0;
          d.items.forEach((it) => { if (addItem(it, false)) added += 1; });
          if (added) { render(); toast(`补齐了 ${added} 张图片`, 'info', 2200); }
        }
      }).catch(() => {});
    }
  });
}

function syncPauseBtn() {
  el.btnPause.textContent = state.paused ? '▶ 继续接收' : '⏸ 暂停接收';
  el.btnPause.classList.toggle('paused', state.paused);
}

function syncSoundBtn() {
  el.soundIcon.textContent = state.sound ? '🔔' : '🔕';
  el.btnSound.classList.toggle('off', !state.sound);
}

/* ── 启动 ────────────────────────────────────────────── */
function boot() {
  bind();
  syncPauseBtn();
  syncSoundBtn();
  render();
  connect();

  // 历史统计定时刷新（客户端数会随其他窗口开关变化）
  setInterval(() => {
    if (document.hidden) return;
    fetch('/api/stats').then((r) => r.json()).then((d) => {
      if (d && d.stats) applyStats(d.stats);
    }).catch(() => {});
  }, 5000);

  // 心跳，保活 + 顺带刷新统计
  setInterval(() => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 25000);
}

document.addEventListener('DOMContentLoaded', boot);