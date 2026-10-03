/* ==========================================================
   摸鱼图片中转站 — 前端逻辑
   WebSocket 接收广播 / 画廊渲染 / 灯箱 / 保存 / 打包下载
   ========================================================== */
'use strict';

/* ── 常量与状态 ───────────────────────────────────────── */
const MAX_CARDS = 500;          // 页面最多保留的卡片数
const MAX_LOGS = 200;      // 指令日志最多保留条数
const RECONNECT_STEPS = [800, 1600, 3000, 5000, 8000];
const LS_PAUSED = 'moyu.paused';
const LS_SOUND  = 'moyu.sound';
const LS_NAME   = 'moyu.name';
const LS_TAB    = 'moyu.tab';

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
  clients: [],        // 在线客户端列表
  selfId: '',         // 服务端分配给本窗口的 ID
  selfName: localStorage.getItem(LS_NAME) || '',
  tab: localStorage.getItem(LS_TAB) || 'cmd',  // 默认停在「指令服务器」
  targets: new Set(), // 指令目标客户端（存 name/id）
  logs: [],           // 指令日志
  unreadLogs: 0,      // 非指令页时的新日志计数
};

/* ── DOM ─────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const el = {
  gallery: $('gallery'), empty: $('empty'), emptyWs: $('emptyWs'), emptyHttp: $('emptyHttp'),
  conn: $('conn'), connText: document.querySelector('#conn .conn-text'),
  statImages: $('statImages'), statClients: $('statClients'), statSenders: $('statSenders'),
  statSize: $('statSize'), statUptime: $('statUptime'),
  viewCount: $('viewCount'),
  btnPause: $('btnPause'), btnSound: $('btnSound'), soundIcon: $('soundIcon'),
  btnSaveAll: $('btnSaveAll'), btnClear: $('btnClear'),
  btnClients: $('btnClients'), badgeClients: $('badgeClients'),
  clientsPanel: $('clientsPanel'), panelBody: $('panelBody'),
  panelCount: $('panelCount'), panelEmpty: $('panelEmpty'), panelClose: $('panelClose'),
  selfName: $('selfName'), btnRename: $('btnRename'),
  lightbox: $('lightbox'), lbImg: $('lbImg'), lbTitle: $('lbTitle'), lbTags: $('lbTags'),
  lbClose: $('lbClose'), lbPrev: $('lbPrev'), lbNext: $('lbNext'),
  toasts: $('toasts'),
  // Tab
  tabs: $('tabs'), pageCmd: $('pageCmd'), pageGallery: $('pageGallery'),
  tabCmdBadge: $('tabCmdBadge'), tabImgBadge: $('tabImgBadge'),
  // 指令面板
  cmdName: $('cmdName'), cmdParameter: $('cmdParameter'), cmdOther: $('cmdOther'),
  cmdFrom: $('cmdFrom'), targetList: $('targetList'), cmdToCount: $('cmdToCount'),
  btnSelectAll: $('btnSelectAll'), btnSelectNone: $('btnSelectNone'),
  cmdPreview: $('cmdPreview'), btnSendCmd: $('btnSendCmd'), btnExecServer: $('btnExecServer'),
  // 工作流
  btnRunCurrent: $('btnRunCurrent'), btnRunImported: $('btnRunImported'),
  btnWfImport: $('btnWfImport'), btnWfFormat: $('btnWfFormat'), btnWfClear: $('btnWfClear'),
  wfFile: $('wfFile'), wfJson: $('wfJson'), wfStatus: $('wfStatus'), wfMeta: $('wfMeta'),
  // 日志
  cmdLog: $('cmdLog'), logEmpty: $('logEmpty'), cmdLogCount: $('cmdLogCount'),
  btnClearLog: $('btnClearLog'),
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
  // 把本窗口的名字带给服务端，便于在客户端列表里区分是谁
  const q = state.selfName ? `?name=${encodeURIComponent(state.selfName)}` : '';
  const url = `${proto}//${location.host}/ws${q}`;
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
      // hello 里带 self_id，比按名字猜可靠
      if (msg.self_id) state.selfId = msg.self_id;
      if (msg.client_name) state.selfName = msg.client_name;
      if (msg.clients) applyClients(msg.clients);
      if (Array.isArray(msg.items)) {
        let added = 0;
        msg.items.forEach((it) => { if (addItem(it, false)) added += 1; });
        if (added) render();
      }
      break;

    case 'image':
      if (msg.record && addItem(msg.record, true)) render();
      applyStats(msg.stats);
      if (msg.clients) applyClients(msg.clients);
      break;

    // 有人连上/断开，或推送计数变化
    case 'clients':
      applyStats(msg.stats);
      applyClients(msg.clients);
      break;

    // 指令相关
    case 'command':
      addLog('in', msg.command, `收到指令 · from=${(msg.command.from || []).join(',') || '未知'}`);
      break;

    case 'command_result': {
      const r = msg.result || {};
      const detail = r.error
        ? r.error
        : (r.delivered !== undefined
          ? `已送达 ${r.delivered} 个：${(r.targets || []).join(',') || '无'}`
          : JSON.stringify(r).slice(0, 120));
      addLog(msg.ok ? 'out' : 'err', msg.command, detail, msg.ok);
      toast(msg.ok ? `指令已送达：${detail}` : `指令失败：${detail}`,
        msg.ok ? 'ok' : 'err', 3200);
      break;
    }

    case 'command_log': {
      const cmd = msg.command || {};
      if (msg.direction === 'exec') {
        const r = msg.result || {};
        addLog('exec', cmd, r.error || JSON.stringify(r).slice(0, 140), r.ok);
      } else {
        addLog('out', cmd, `转发 ${msg.delivered ?? 0} 个：${(msg.targets || []).join(',') || '无'}`);
      }
      break;
    }

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

/* ══════════════════════════════════════════════════════════
   Tab 切换
   ══════════════════════════════════════════════════════════ */
function switchTab(name) {
  state.tab = name;
  localStorage.setItem(LS_TAB, name);

  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  el.pageCmd.hidden = name !== 'cmd';
  el.pageGallery.hidden = name !== 'gallery';

  if (name === 'cmd') {
    state.unreadLogs = 0;
    el.tabCmdBadge.hidden = true;
  }
  if (name === 'gallery') {
    render();
  }
}

/* ══════════════════════════════════════════════════════════
   指令构造与发送
   ══════════════════════════════════════════════════════════ */

/** 解析可能为 JSON 字符串的输入框内容；失败返回 null */
function parseJsonField(text, fallback) {
  const raw = (text || '').trim();
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { value: v };
  } catch {
    return null;
  }
}

/** 构造符合协议格式的指令对象 */
function buildCommand(overrides = {}) {
  const parameter = parseJsonField(el.cmdParameter.value, {});
  const other = parseJsonField(el.cmdOther.value, {});
  if (parameter === null || other === null) return null;

  const name = (el.cmdName.value || '').trim();
  const to = Array.from(state.targets);

  return {
    name,
    parameter: { ...parameter, ...(overrides.parameter || {}) },
    other,
    from: ['server'],
    to,
  };
}

/** 刷新 JSON 预览；输入非法时标红 */
function refreshPreview() {
  const cmd = buildCommand();
  const pBad = parseJsonField(el.cmdParameter.value, {}) === null;
  const oBad = parseJsonField(el.cmdOther.value, {}) === null;
  el.cmdParameter.classList.toggle('bad', pBad);
  el.cmdOther.classList.toggle('bad', oBad);

  if (!cmd) {
    el.cmdPreview.textContent = '// parameter / other 不是合法 JSON 对象';
    return;
  }
  el.cmdPreview.textContent = JSON.stringify(cmd, null, 2);
}

function sendCommand(cmd) {
  if (!cmd) {
    toast('指令内容不合法（parameter / other 需为 JSON 对象）', 'err');
    return;
  }
  if (!cmd.name) {
    toast('请填写指令名', 'warn');
    return;
  }
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    // 平铺发送：顶层就是 name/parameter/other/from/to，
    // 只挂一个 type 供接收端快速筛选，不套 command 信封
    state.ws.send(JSON.stringify({ type: 'command', ...cmd }));
  } else {
    toast('未连接到服务端', 'err');
  }
}

function sendCurrentCommand() {
  const cmd = buildCommand();
  if (!cmd) { refreshPreview(); toast('指令内容不合法', 'err'); return; }
  if (!cmd.name) { toast('请填写指令名', 'warn'); el.cmdName.focus(); return; }
  if (!cmd.to.length) { toast('请先在下方选择目标客户端', 'warn'); return; }
  sendCommand(cmd);
}

/** 不填 to —— 由服务端执行内置指令 */
function sendServerCommand() {
  const cmd = buildCommand();
  if (!cmd) { refreshPreview(); toast('指令内容不合法', 'err'); return; }
  if (!cmd.name) { toast('请填写指令名', 'warn'); el.cmdName.focus(); return; }
  cmd.to = [];
  sendCommand(cmd);
}

/* ── 目标客户端多选 ─────────────────────────────────── */
function renderTargets() {
  // 只有「别人」可以被当指令目标
  const others = state.clients.filter((c) => c.id !== state.selfId);
  el.cmdToCount.textContent = others.length
    ? `已选 ${state.targets.size} / ${others.length}`
    : '暂无其他客户端在线';

  if (!others.length) {
    el.targetList.replaceChildren(div('target-empty', '暂无其他客户端在线'));
    return;
  }

  const frag = document.createDocumentFragment();
  others.forEach((c) => {
    const label = document.createElement('label');
    label.className = `target kind-${c.kind}`;

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = state.targets.has(c.id) || state.targets.has(c.name);
    box.addEventListener('change', () => {
      // 用 id 存，名字只作展示；id 更稳（名字可能重复）
      if (box.checked) state.targets.add(c.id);
      else state.targets.delete(c.id);
      renderTargets();
      refreshPreview();
    });

    const ico = span('target-ico', c.kind === 'sender' ? '🖥' : '🖼');
    const name = span('target-name', c.name);
    const meta = span('target-meta', `${c.ip || '?'} · 已推 ${c.sent ?? 0}`);

    label.append(box, ico, name, meta);
    frag.appendChild(label);
  });
  el.targetList.replaceChildren(frag);
}

function selectAllTargets() {
  state.targets = new Set(
    state.clients.filter((c) => c.id !== state.selfId).map((c) => c.id)
  );
  renderTargets();
  refreshPreview();
}

function clearTargets() {
  state.targets.clear();
  renderTargets();
  refreshPreview();
}

/* ══════════════════════════════════════════════════════════
   工作流导入 / 展示
   ══════════════════════════════════════════════════════════ */
function readWorkflow() {
  const text = el.wfJson.value.trim();
  if (!text) return { obj: null, error: null };
  try {
    return { obj: JSON.parse(text), error: null };
  } catch (e) {
    return { obj: null, error: e.message };
  }
}

function updateWorkflowStatus() {
  const { obj, error } = readWorkflow();
  const raw = el.wfJson.value;
  el.wfJson.classList.toggle('bad', Boolean(error));

  if (!raw.trim()) {
    el.wfStatus.textContent = '未导入';
    el.wfStatus.className = 'card-hint';
    el.wfMeta.textContent = '—';
    return { obj: null, valid: false };
  }
  if (error) {
    el.wfStatus.textContent = 'JSON 格式错误';
    el.wfStatus.className = 'card-hint bad';
    el.wfMeta.textContent = error.slice(0, 80);
    return { obj: null, valid: false };
  }

  // ComfyUI 工作流有两种形态：graph（含 nodes）和 API prompt（纯节点映射）
  let kind = 'JSON';
  let count = Object.keys(obj || {}).length;
  if (obj && Array.isArray(obj.nodes)) {
    kind = '工作流';
    count = obj.nodes.length;
  } else if (obj && obj.last_node_id !== undefined) {
    kind = '工作流';
  }

  el.wfStatus.textContent = `${kind} · ${count} 项`;
  el.wfStatus.className = 'card-hint ok';
  el.wfMeta.textContent = `${fmtSize(new Blob([raw]).size)}`;
  return { obj, valid: true };
}

function importWorkflowFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    el.wfJson.value = String(reader.result || '');
    const { valid } = updateWorkflowStatus();
    if (valid) toast(`已导入 ${file.name}`, 'ok');
    else toast('导入的文件不是合法 JSON', 'err');
  };
  reader.onerror = () => toast('文件读取失败', 'err');
  reader.readAsText(file);
}

function formatWorkflow() {
  const { obj, error } = readWorkflow();
  if (error) { toast('JSON 格式错误，无法格式化', 'err'); return; }
  if (!obj) { toast('内容为空', 'warn'); return; }
  el.wfJson.value = JSON.stringify(obj, null, 2);
  updateWorkflowStatus();
}

function clearWorkflow() {
  el.wfJson.value = '';
  updateWorkflowStatus();
}

/* ── 两个运行按钮 ───────────────────────────────────── */
function runCurrentWorkflow() {
  if (!state.targets.size) { toast('请先选择目标客户端', 'warn'); return; }
  const cmd = {
    name: 'run_current_workflow',
    parameter: {},
    other: { source: 'current', by: state.selfName || 'server' },
    from: ['server'],
    to: Array.from(state.targets),
  };
  sendCommand(cmd);
  switchTab('cmd');
}

function runImportedWorkflow() {
  if (!state.targets.size) { toast('请先选择目标客户端', 'warn'); return; }
  const { obj, valid } = updateWorkflowStatus();
  if (!valid) { toast('请先导入合法的工作流 JSON', 'warn'); return; }

  const cmd = {
    name: 'run_workflow',
    parameter: { workflow: obj },
    other: { source: 'imported', by: state.selfName || 'server' },
    from: ['server'],
    to: Array.from(state.targets),
  };
  sendCommand(cmd);
  switchTab('cmd');
}

/* ══════════════════════════════════════════════════════════
   指令日志
   ══════════════════════════════════════════════════════════ */
function addLog(dir, cmd, desc, ok) {
  const item = {
    dir,
    name: (cmd && cmd.name) || '(无名)',
    desc: desc || '',
    ok: ok !== false,
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
  };
  state.logs.unshift(item);
  if (state.logs.length > MAX_LOGS) state.logs.length = MAX_LOGS;
  renderLogs();

  if (state.tab !== 'cmd') {
    state.unreadLogs += 1;
    el.tabCmdBadge.textContent = state.unreadLogs;
    el.tabCmdBadge.hidden = false;
  }
}

function renderLogs() {
  el.cmdLogCount.textContent = `${state.logs.length} 条`;
  if (!state.logs.length) {
    el.cmdLog.replaceChildren(el.logEmpty);
    el.logEmpty.hidden = false;
    return;
  }
  const frag = document.createDocumentFragment();
  state.logs.forEach((l) => {
    const row = document.createElement('div');
    row.className = `log-item ${l.dir} ${l.ok ? 'ok' : 'err'}`;

    const d = span('log-dir', l.dir.toUpperCase());
    const body = div('log-body');
    body.append(div('log-title', l.name), div('log-desc', l.desc));
    row.append(d, body, span('log-time', l.time));
    frag.appendChild(row);
  });
  el.cmdLog.replaceChildren(frag);
}

function clearLogs() {
  state.logs = [];
  renderLogs();
}

/* 小工具：造元素 */
function div(cls, text) {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = text;
  return d;
}
function span(cls, text) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
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
  el.statClients.textContent = s.clients ?? s.web_clients ?? 0;
  el.statSenders.textContent = s.sender_clients ?? 0;
  el.statSize.textContent = fmtSize(s.bytes);
  el.statUptime.textContent = fmtUptime(s.uptime);
  el.tabImgBadge.textContent = s.images ?? 0;
}

/* ── 在线客户端列表 ──────────────────────────────────── */
function applyClients(list) {
  if (!Array.isArray(list)) return;
  state.clients = list;

  // 兜底：若尚未从 hello 拿到 self_id，按名字认领
  if (!state.selfId) {
    const mine = list.find((c) => c.kind === 'web' && c.name === state.selfName);
    if (mine) state.selfId = mine.id;
  }

  const others = list.length - 1;
  el.badgeClients.textContent = list.length;
  el.btnClients.classList.toggle('has-clients', others > 0);

  renderClients();
  renderTargets();   // 指令目标列表跟着客户端列表走
  refreshPreview();
}

function renderClients() {
  const list = state.clients;
  el.panelCount.textContent = list.length;
  el.panelEmpty.style.display = list.length ? 'none' : '';

  const frag = document.createDocumentFragment();
  list.forEach((c) => {
    const isSelf = c.id && c.id === state.selfId;
    const row = document.createElement('div');
    row.className = `cli ${c.kind}${isSelf ? ' self' : ''}`;

    const avatar = document.createElement('div');
    avatar.className = 'cli-avatar';
    avatar.textContent = c.kind === 'sender' ? '🖥' : '🖼';
    row.appendChild(avatar);

    const main = document.createElement('div');
    main.className = 'cli-main';

    const nameRow = document.createElement('div');
    nameRow.className = 'cli-name';
    nameRow.append(escapeText(c.name || '未命名'));
    if (isSelf) nameRow.appendChild(tag('我', 'web'));
    else nameRow.appendChild(tag(c.kind === 'sender' ? '推送端' : '网页端', c.kind));
    main.appendChild(nameRow);

    const meta = document.createElement('div');
    meta.className = 'cli-meta';
    const secs = c.connected_seconds ?? 0;
    meta.textContent = `${c.ip || '?'} · ${c.connected_at_text || ''} · 在线 ${fmtDuration(secs)}`;
    main.appendChild(meta);

    row.appendChild(main);

    if (c.kind === 'sender') {
      const sent = document.createElement('div');
      sent.className = 'cli-sent';
      const b = document.createElement('b');
      b.textContent = c.sent ?? 0;
      const sp = document.createElement('span');
      sp.textContent = '已推送';
      sent.append(b, sp);
      row.appendChild(sent);
    }

    frag.appendChild(row);
  });

  el.panelBody.replaceChildren(frag);
}

function tag(text, kind) {
  const s = document.createElement('span');
  s.className = `cli-tag ${kind}`;
  s.textContent = text;
  return s;
}

function escapeText(t) {
  return document.createTextNode(String(t ?? ''));
}

/** 秒数 → 「1分23秒」这类可读时长 */
function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  const h = Math.floor(s / 3600);
  return `${h} 小时 ${Math.floor((s % 3600) / 60)} 分`;
}

function togglePanel(force) {
  const show = force !== undefined ? force : el.clientsPanel.hidden;
  el.clientsPanel.hidden = !show;
  if (show) renderClients();
}

/** 改名 = 存本地 + 重连（名字走 URL query，服务端据此登记） */
function renameSelf() {
  const name = el.selfName.value.trim().slice(0, 24);
  if (!name) { toast('名字不能为空', 'warn', 2000); return; }
  state.selfName = name;
  localStorage.setItem(LS_NAME, name);
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.close();
  else connect();
  toast(`已改名为「${name}」`, 'ok', 2000);
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

  // 客户端面板
  el.btnClients.addEventListener('click', () => togglePanel());
  el.panelClose.addEventListener('click', () => togglePanel(false));
  el.btnRename.addEventListener('click', renameSelf);
  el.selfName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') renameSelf();
  });

  // Tab 切换
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => switchTab(t.dataset.tab));
  });

  // 指令面板
  el.btnSendCmd.addEventListener('click', sendCurrentCommand);
  el.btnExecServer.addEventListener('click', sendServerCommand);
  el.btnSelectAll.addEventListener('click', selectAllTargets);
  el.btnSelectNone.addEventListener('click', clearTargets);
  [el.cmdName, el.cmdParameter, el.cmdOther].forEach((n) => {
    n.addEventListener('input', refreshPreview);
  });
  el.btnClearLog.addEventListener('click', clearLogs);

  // 工作流
  el.btnRunCurrent.addEventListener('click', runCurrentWorkflow);
  el.btnRunImported.addEventListener('click', runImportedWorkflow);
  el.btnWfImport.addEventListener('click', () => el.wfFile.click());
  el.wfFile.addEventListener('change', () => {
    const f = el.wfFile.files && el.wfFile.files[0];
    if (f) importWorkflowFile(f);
    el.wfFile.value = '';
  });
  el.btnWfFormat.addEventListener('click', formatWorkflow);
  el.btnWfClear.addEventListener('click', clearWorkflow);
  el.wfJson.addEventListener('input', updateWorkflowStatus);

  // 面板开合状态写进地址 hash，刷新后保持
  if (location.hash === '#clients') togglePanel(true);

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
        if (d && d.clients) applyClients(d.clients);
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
  el.selfName.value = state.selfName;
  switchTab(state.tab === 'gallery' ? 'gallery' : 'cmd');
  renderTargets();
  refreshPreview();
  updateWorkflowStatus();
  renderLogs();
  render();
  connect();

  // 历史统计定时刷新（客户端数会随其他窗口开关变化）
  setInterval(() => {
    if (document.hidden) return;
    fetch('/api/stats').then((r) => r.json()).then((d) => {
      if (d && d.stats) applyStats(d.stats);
      if (d && d.clients) applyClients(d.clients);
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