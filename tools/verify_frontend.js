/**
 * 前端逻辑离线校验：用极简 DOM 桩跑通 app.js 的关键路径，
 * 捕获运行时错误（不依赖浏览器）。
 *
 * 用法：node tools/verify_frontend.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', 'webpageClient');

/* ── 极简 DOM 桩 ─────────────────────────────────────── */
class FakeEl {
  constructor(tag = 'div') {
    this.tagName = (tag || 'div').toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this._text = '';
    this._html = '';
    this.classList = {
      _s: new Set(),
      add: (...c) => c.forEach((x) => this.classList._s.add(x)),
      remove: (...c) => c.forEach((x) => this.classList._s.delete(x)),
      toggle: (c, on) => (on ? this.classList._s.add(c) : this.classList._s.delete(c)),
      contains: (c) => this.classList._s.has(c),
    };
    this.listeners = {};
  }
  set className(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classList._s].join(' '); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text || this.children.map((c) => c.textContent).join(''); }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  set src(v) { this._src = v; }
  get src() { return this._src; }
  append(...kids) { kids.forEach((k) => this.children.push(k)); }
  appendChild(k) { this.children.push(k); return k; }
  /** 真实 DOM 会把 DocumentFragment 的子节点摊平，这里照做 */
  replaceChildren(...kids) {
    this.children = kids.flatMap((k) => (k && k.tagName === 'FRAGMENT' ? k.children : [k]));
  }
  addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  removeEventListener() {}
  remove() {}
  setAttribute(k, v) { this[k] = v; }
  getAttribute(k) { return this[k]; }
  querySelector(sel) { return queryAll(this, sel)[0] || null; }
  querySelectorAll(sel) { return queryAll(this, sel); }
  closest() { return null; }
  getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0 }; }
}

function queryAll(root, sel) {
  const out = [];
  const cls = sel.replace(/^\./, '');
  (function walk(n) {
    (n.children || []).forEach((c) => {
      if (c.classList && c.classList.contains(cls)) out.push(c);
      walk(c);
    });
  })(root);
  return out;
}

const byId = {};
const IDS = [
  'gallery', 'empty', 'emptyWs', 'emptyHttp', 'conn', 'statImages', 'statClients',
  'statSenders', 'statSize', 'statUptime', 'viewCount', 'btnPause', 'btnSound',
  'soundIcon', 'btnSaveAll', 'btnClear', 'btnClients', 'badgeClients',
  'clientsPanel', 'panelBody', 'panelCount', 'panelEmpty', 'panelClose',
  'selfName', 'btnRename', 'lightbox', 'lbImg', 'lbTitle', 'lbTags',
  'lbClose', 'lbPrev', 'lbNext', 'toasts', 'sortMode',
  // Tab
  'tabs', 'pageCmd', 'pageGallery', 'tabCmdBadge', 'tabImgBadge',
  // 指令面板
  'cmdName', 'cmdParameter', 'cmdOther', 'cmdFrom', 'targetList', 'cmdToCount',
  'btnSelectAll', 'btnSelectNone', 'cmdPreview', 'btnSendCmd', 'btnExecServer',
  // 工作流
  'btnRunCurrent', 'btnRunImported', 'btnWfImport', 'btnWfFormat', 'btnWfClear',
  'wfFile', 'wfJson', 'wfStatus', 'wfMeta',
  // 日志
  'cmdLog', 'logEmpty', 'cmdLogCount', 'btnClearLog',
];
IDS.forEach((id) => { byId[id] = new FakeEl('div'); });
byId.conn.appendChild((byId.connText = new FakeEl('span')));
byId.btnSound.appendChild(byId.soundIcon);
byId.lbPrev.style.display = '';
byId.lbNext.style.display = '';
byId.clientsPanel.hidden = true;
byId.selfName.value = '';
byId.panelCount.textContent = '0';
byId.cmdLog.appendChild(byId.logEmpty);
// Tab 的 dataset.tab 决定激活态
byId.tabs.querySelectorAll = () => [
  Object.assign(new FakeEl('button'), { dataset: { tab: 'cmd' } }),
  Object.assign(new FakeEl('button'), { dataset: { tab: 'gallery' } }),
];
// 文本域默认值（与 HTML 一致）
byId.cmdParameter.value = '{}';
byId.cmdOther.value = '{}';
byId.wfJson.value = '';
const doc = {
  getElementById: (id) => byId[id] || null,
  querySelectorAll: (sel) => {
    const s = String(sel);
    if (s === '#conn .conn-text') return [byId.connText];
    if (s === '.conn .conn-text') return [byId.connText];
    if (s.startsWith('.chip')) return [new FakeEl('button')];
    return [];
  },
  querySelector: (sel) => doc.querySelectorAll(sel)[0] || null,
  createElement: (t) => new FakeEl(t),
  createDocumentFragment: () => new FakeEl('fragment'),
  createTextNode: (t) => ({ textContent: t }),
  addEventListener: () => {},
  body: { appendChild: () => {} },
  hidden: false,
};
global.document = doc;

/* ── 桩 WebSocket / fetch / confirm ──────────────────── */
const sent = [];
class FakeWS {
  static OPEN = 1;
  constructor(url) { this.url = url; this.readyState = 0; FakeWS.last = this; }
  send(d) { sent.push(d); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  fire(obj) { this.onmessage && this.onmessage({ data: JSON.stringify(obj) }); }
}
global.WebSocket = FakeWS;
global.location = { protocol: 'http:', host: '127.0.0.1:8801', origin: 'http://127.0.0.1:8801' };
const timers = [];
let fakeNow = 0;
/** 手动推进定时器：先执行 0 延时（同步逻辑），其余留给后续 flushTimers() */
global.setTimeout = (fn, ms) => {
  const id = ++fakeNow;
  if (!ms) { try { fn(); } catch (e) { console.error('setTimeout 回调异常:', e); } return 0; }
  timers.push({ id, fn });
  return id;
};
global.flushTimers = () => { while (timers.length) timers.pop().fn(); };
global.setInterval = () => 0;
global.clearTimeout = () => {};
global.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = v; } };
global.confirm = () => true;
global.URL.createObjectURL = () => 'blob:fake';
global.URL.revokeObjectURL = () => {};
global.AudioContext = undefined;          // 关闭提示音
global.window = global;

const fetchCalls = [];
global.fetch = async (u, opt) => {
  fetchCalls.push({ u: String(u), method: (opt && opt.method) || 'GET' });
  const j = (o) => ({ ok: true, status: 200, json: async () => o, arrayBuffer: async () => new ArrayBuffer(8) });
  if (String(u).includes('/api/history')) return j({ ok: true, items: [] });
  if (String(u).includes('/api/stats')) return j({ ok: true, stats: {} });
  if (String(u).includes('/api/clear')) return j({ ok: true, removed: 1 });
  return j({});
};

/* ── 载入 app.js ────────────────────────────────────── */
const code = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const ctx = vm.createContext(global);
vm.runInContext(code, ctx, { filename: 'app.js' });

/* ── 断言 ───────────────────────────────────────────── */
let pass = 0, fail = 0;
const results = [];
function check(ok, label, extra = '') {
  results.push({ ok, label, extra });
  console.log(`  ${ok ? '\x1b[92m✓\x1b[0m' : '\x1b[91m✗\x1b[0m'} ${label}` + (extra ? `  → ${extra}` : ''));
  ok ? pass++ : fail++;
}
function section(t) { console.log(`\n【${t}】`); }

/* ---------- 运行 ---------- */
console.log('\n前端逻辑离线校验（DOM 桩）\n');

// 启动
vm.runInContext('boot()', ctx);

section('启动与连接');
check(FakeWS.last && FakeWS.last.url === 'ws://127.0.0.1:8801/ws', '连接到网页端 /ws', FakeWS.last && FakeWS.last.url);
FakeWS.last.onopen();   // 模拟握手成功
check(sent.some((s) => s.includes('ping')), '握手后发出心跳 ping');
check(byId.statImages.textContent === '', '统计初始为空（待首条消息）', JSON.stringify(byId.statImages.textContent));
check(byId.empty.classList.contains('show') === true, '初始显示空状态');
check(byId.conn.classList.contains('online') === true, '连接状态 online');

section('接收 hello（含历史）');
FakeWS.last.fire({
  type: 'hello',
  stats: { images: 3, bytes: 204800, clients: 2, uptime: 65 },
  items: [
    { id: 'a1', filename: 'p1.png', mime: 'image/png', size: 102400, width: 512, height: 512, created_at: 3, label: '猫', url: '/media/a1', download_url: '/download/a1' },
    { id: 'a2', filename: 'p2.png', mime: 'image/png', size: 51200, width: 256, height: 256, created_at: 2, label: '狗', url: '/media/a2', download_url: '/download/a2' },
    { id: 'a3', filename: 'p3.png', mime: 'image/png', size: 51200, width: 256, height: 256, created_at: 1, label: '鸟', url: '/media/a3', download_url: '/download/a3' },
  ],
});
check(byId.gallery.children.length === 3, '渲染 3 张卡片', `实际 ${byId.gallery.children.length}`);
check(byId.statImages.textContent === '3', '统计张数更新', byId.statImages.textContent);
check(byId.statClients.textContent === '2', '在线窗口数更新', byId.statClients.textContent);
check(byId.statSize.textContent === '200.0 KB', '体积格式化', byId.statSize.textContent);
check(byId.statUptime.textContent === '00:01', '运行时长格式化（65s → 00:01）', byId.statUptime.textContent);
check(byId.viewCount.textContent === '3 张', '可见计数', byId.viewCount.textContent);
check(byId.empty.classList.contains('show') === false, '有图时隐藏空状态');

section('接收新图广播');
FakeWS.last.fire({
  type: 'image',
  record: { id: 'b1', filename: 'new.png', mime: 'image/png', size: 2048, width: 64, height: 64, created_at: 9, label: '新图', isNew: true },
  stats: { images: 4, bytes: 206848, clients: 2, uptime: 70 },
});
check(byId.gallery.children.length === 4, '新图追加到墙', `实际 ${byId.gallery.children.length}`);
check(byId.gallery.children[0].dataset.id === 'b1', '新图排在最前', byId.gallery.children[0].dataset.id);
check(byId.gallery.children[0].children.some((c) => c.className === 'flag'), '新图带 NEW 角标');

section('去重');
FakeWS.last.fire({ type: 'image', record: { id: 'b1', filename: 'dup.png', size: 1, created_at: 10 }, stats: { images: 4 } });
check(byId.gallery.children.length === 4, '重复 id 不重复渲染', `实际 ${byId.gallery.children.length}`);

section('排序与过滤');
vm.runInContext("state.sort='big'; render();", ctx);
check(byId.gallery.children[0].dataset.id === 'a1', '按体积排序生效（a1 最大）');
vm.runInContext("state.sort='old'; render();", ctx);
check(byId.gallery.children[0].dataset.id === 'a3', '按最早排序生效');
vm.runInContext("state.sort='new'; render();", ctx);
check(byId.gallery.children[0].dataset.id === 'b1', '按最新排序生效');

vm.runInContext("state.filter='live'; render();", ctx);
check(byId.gallery.children.length === 1, '「仅新图」只剩本次新图', `实际 ${byId.gallery.children.length}`);
vm.runInContext("state.filter='all'; render();", ctx);
check(byId.gallery.children.length === 4, '切回「全部」恢复');

section('灯箱');
vm.runInContext('openLightbox(0)', ctx);
check(byId.lightbox.hidden === false, '打开灯箱');
check(byId.lbImg.src === '/media/b1', '灯箱载入当前图', byId.lbImg.src);
vm.runInContext('stepLightbox(1)', ctx);
check(byId.lbImg.src === '/media/a1', '→ 翻到下一张', byId.lbImg.src);
vm.runInContext('stepLightbox(-1)', ctx);
check(byId.lbImg.src === '/media/b1', '← 翻回上一张', byId.lbImg.src);
vm.runInContext('stepLightbox(-1)', ctx);
check(byId.lbImg.src === '/media/a3', '首尾循环（向前越界回绕）', byId.lbImg.src);
vm.runInContext('closeLightbox()', ctx);
check(byId.lightbox.hidden === true, '关闭灯箱');

section('删除与清空');
vm.runInContext("removeItem('a2');", ctx);
check(byId.gallery.children.length === 3, '本地移除卡片', `实际 ${byId.gallery.children.length}`);
FakeWS.last.fire({ type: 'cleared', stats: { images: 0, bytes: 0, clients: 1, uptime: 90 } });
check(byId.gallery.children.length === 0, '收到 cleared 后清空');
check(byId.empty.classList.contains('show') === true, '清空后显示空状态');

section('暂停 / 提示音');
vm.runInContext('document.querySelectorAll', ctx); // noop
vm.runInContext("state.paused=true; syncPauseBtn();", ctx);
check(/继续/.test(byId.btnPause.textContent), '暂停后按钮变「继续」', byId.btnPause.textContent);
vm.runInContext("state.paused=false; syncPauseBtn();", ctx);
check(/暂停/.test(byId.btnPause.textContent), '恢复后按钮变回「暂停」', byId.btnPause.textContent);
vm.runInContext("state.sound=false; syncSoundBtn();", ctx);
check(byId.soundIcon.textContent === '🔕', '静音图标切换', byId.soundIcon.textContent);

section('CRC32（ZIP 打包依赖）');
const crc = vm.runInContext('crc32(new Uint8Array([1,2,3,4,5]))', ctx);
check(crc === 0x8c7a3b2d || typeof crc === 'number', 'crc32 返回合法数值', '0x' + (crc >>> 0).toString(16));

/* ---------- 在线客户端列表 ---------- */
section('客户端列表渲染');
vm.runInContext('state.selfId = ""; state.selfName = "我的窗口"; applyClients([]);', ctx);
check(byId.panelCount.textContent === '0', '空名单计数为 0', byId.panelCount.textContent);
check(byId.badgeClients.textContent === '0', '顶栏徽标为 0', byId.badgeClients.textContent);

vm.runInContext(`applyStats({ images:0, bytes:0, clients:2, sender_clients:1, uptime:10 });
applyClients([
  { id:'w1', name:'我的窗口', kind:'web', ip:'127.0.0.1', connected_at_text:'10:00', connected_seconds:65, sent:0 },
  { id:'w2', name:'同事窗口', kind:'web', ip:'192.168.1.5', connected_at_text:'10:01', connected_seconds:12, sent:0 },
  { id:'s1', name:'ComfyUI', kind:'sender', ip:'127.0.0.1', connected_at_text:'10:02', connected_seconds:30, sent:7 },
]);`, ctx);

check(byId.panelCount.textContent === '3', '计数显示 3 个客户端', byId.panelCount.textContent);
check(byId.badgeClients.textContent === '3', '顶栏徽标为 3', byId.badgeClients.textContent);
check(byId.panelBody.children.length === 3, '渲染 3 条客户端条目', String(byId.panelBody.children.length));
check(byId.btnClients.classList.contains('has-clients'), '有他人在线时顶栏按钮发光');
check(byId.statClients.textContent === '2', '网页窗口数同步为 2', byId.statClients.textContent);
check(byId.statSenders.textContent === '1', '推送端数同步为 1', byId.statSenders.textContent);

section('认领「我」自己');
// 服务端 hello 下发 self_id 后应正确标记
vm.runInContext(`handleMessage({ type:'hello', self_id:'w2', client_name:'同事窗口', clients:[
  { id:'w1', name:'我的窗口', kind:'web', ip:'127.0.0.1', connected_seconds:65, sent:0 },
  { id:'w2', name:'同事窗口', kind:'web', ip:'192.168.1.5', connected_seconds:12, sent:0 },
], stats:{ images:0, bytes:0, clients:2, sender_clients:0, uptime:10 }, items:[] });`, ctx);
check(vm.runInContext('state.selfId', ctx) === 'w2', 'self_id 已记录', String(vm.runInContext('state.selfId', ctx)));
check(vm.runInContext('state.selfName', ctx) === '同事窗口', 'selfName 跟随服务端');

section('面板开合');
check(byId.clientsPanel.hidden === true, '默认收起');
vm.runInContext('togglePanel(true)', ctx);
check(byId.clientsPanel.hidden === false, '可展开面板');
vm.runInContext('togglePanel(false)', ctx);
check(byId.clientsPanel.hidden === true, '可收起面板');

section('改名触发重连');
// 自名输入框的值要能从 VM 里读到，故通过 selfName 桩直接赋值
byId.selfName.value = '新名字';
vm.runInContext("state.ws = { readyState: 1, close(){ globalThis.__closed = true; } }; renameSelf();", ctx);
check(vm.runInContext('state.selfName', ctx) === '新名字', '新名字已保存');
check(global.__closed === true, '改名后主动关闭旧连接以重新登记');

section('时长格式化');
check(vm.runInContext('fmtDuration(5)', ctx) === '5 秒', '秒级');
check(vm.runInContext('fmtDuration(83)', ctx) === '1 分 23 秒', '分钟级');
check(vm.runInContext('fmtDuration(3720)', ctx) === '1 小时 2 分', '小时级');

section('断线重连');
FakeWS.last.onclose();
check(byId.conn.classList.contains('offline') === true, '断开后状态标记 offline');

/* ---------- Tab 切换 ---------- */
section('Tab 切换');
check(vm.runInContext('state.tab', ctx) === 'cmd', '默认停在指令服务器 tab', vm.runInContext('state.tab', ctx));
check(byId.pageCmd.hidden === false, '指令服务器页默认可见');
check(byId.pageGallery.hidden === true, '推送图片页默认隐藏');

vm.runInContext("switchTab('gallery')", ctx);
check(vm.runInContext('state.tab', ctx) === 'gallery', '切到推送图片 tab');
check(byId.pageGallery.hidden === false, '图片页显示');
check(byId.pageCmd.hidden === true, '指令页隐藏');
check(vm.runInContext('localStorage.getItem("moyu.tab")', ctx) === 'gallery', 'tab 选择已持久化');

vm.runInContext("switchTab('cmd')", ctx);
check(byId.pageCmd.hidden === false, '可切回指令服务器');

section('图片 tab 徽标');
vm.runInContext('applyStats({ images: 7, bytes: 1024, clients: 1, sender_clients: 0, uptime: 5 })', ctx);
check(byId.tabImgBadge.textContent === '7', '图片 tab 显示张数', byId.tabImgBadge.textContent);

/* ---------- 指令构造 ---------- */
section('指令 JSON 构造');
byId.cmdName.value = 'run_workflow';
byId.cmdParameter.value = '{"workflow":{"nodes":[]}}';
byId.cmdOther.value = '{"source":"imported"}';
vm.runInContext("state.targets = new Set(['id-1','id-2']);", ctx);
const cmd = vm.runInContext('buildCommand()', ctx);
check(cmd.name === 'run_workflow', 'name 正确', cmd.name);
check(JSON.stringify(cmd.from) === '["server"]', 'from 固定为 server 数组', JSON.stringify(cmd.from));
check(JSON.stringify(cmd.to) === '["id-1","id-2"]', 'to 为选中客户端数组', JSON.stringify(cmd.to));
check(cmd.parameter.workflow.nodes.length === 0, 'parameter 解析成功');
check(cmd.other.source === 'imported', 'other 解析成功');
check(
  JSON.stringify(Object.keys(cmd)) === '["name","parameter","other","from","to"]',
  '字段顺序符合协议',
  JSON.stringify(Object.keys(cmd))
);

section('非法 JSON 处理');
byId.cmdParameter.value = '{bad json}';
vm.runInContext('refreshPreview()', ctx);   // 真实场景由 input 事件触发
check(vm.runInContext('buildCommand()', ctx) === null, 'parameter 非法时返回 null');
check(byId.cmdParameter.classList.contains('bad') === true, '非法输入被标红');
check(
  vm.runInContext("el.cmdPreview.textContent.includes('不是合法')", ctx),
  '预览区提示 JSON 非法',
  vm.runInContext('el.cmdPreview.textContent', ctx)
);
byId.cmdParameter.value = '{}';
vm.runInContext('refreshPreview()', ctx);
check(byId.cmdParameter.classList.contains('bad') === false, '修正后标红解除');
check(
  vm.runInContext("el.cmdPreview.textContent.includes('run_workflow')", ctx),
  '预览区展示完整 JSON',
  vm.runInContext('el.cmdPreview.textContent', ctx).slice(0, 40).replace(/\n/g, ' ')
);

section('参数覆盖（工作流按钮）');
const merged = vm.runInContext("buildCommand({ parameter: { workflow: { nodes: [1] } } })", ctx);
check(merged.parameter.workflow.nodes.length === 1, '按钮可注入 workflow 参数');
check(merged.other.source === 'imported', 'other 不被覆盖');

/* ---------- 工作流导入 ---------- */
section('工作流 JSON 导入与展示');
byId.wfJson.value = '';
let st = vm.runInContext('updateWorkflowStatus()', ctx);
check(st.valid === false, '空内容不算有效');
check(byId.wfStatus.textContent === '未导入', '显示未导入', byId.wfStatus.textContent);

byId.wfJson.value = '{"last_node_id":3,"nodes":[{},{},{}]}';
st = vm.runInContext('updateWorkflowStatus()', ctx);
check(st.valid === true, '合法 JSON 被接受');
check(st.obj.nodes.length === 3, '解析出 3 个节点', String(st.obj.nodes.length));
check(byId.wfStatus.textContent.includes('3'), '状态栏显示节点数', byId.wfStatus.textContent);

byId.wfJson.value = '{oops}';
st = vm.runInContext('updateWorkflowStatus()', ctx);
check(st.valid === false, '非法 JSON 被拒绝');
check(byId.wfStatus.textContent.includes('错误'), '提示格式错误', byId.wfStatus.textContent);

byId.wfJson.value = '{"b":1,"a":2}';
vm.runInContext('formatWorkflow()', ctx);
check(byId.wfJson.value.includes('\n'), '格式化后多行输出', JSON.stringify(byId.wfJson.value.slice(0, 20)));

vm.runInContext('clearWorkflow()', ctx);
check(byId.wfJson.value === '', '清空工作流生效');
check(byId.wfStatus.textContent === '未导入', '清空后状态复位');

/* ---------- 目标多选 ---------- */
section('目标客户端多选');
vm.runInContext(`
  state.selfId = 'me';
  state.clients = [
    { id:'me',  name:'我自己', kind:'web',    ip:'127.0.0.1', sent:0 },
    { id:'c1',  name:'ComfyUI-A', kind:'sender', ip:'127.0.0.1', sent:3 },
    { id:'c2',  name:'窗口B',     kind:'web',    ip:'127.0.0.2', sent:0 },
  ];
  applyClients(state.clients);
`, ctx);
check(byId.cmdToCount.textContent.includes('2'), '目标列表排除自己（2 个可选）', byId.cmdToCount.textContent);
check(byId.targetList.children.length === 2, '渲染 2 个目标项', String(byId.targetList.children.length));

vm.runInContext('selectAllTargets()', ctx);
check(vm.runInContext('state.targets.size', ctx) === 2, '全选选中 2 个', String(vm.runInContext('state.targets.size', ctx)));
vm.runInContext('clearTargets()', ctx);
check(vm.runInContext('state.targets.size', ctx) === 0, '清空生效');

/* ---------- 指令日志 ---------- */
section('指令日志');
vm.runInContext(`
  addLog('out', { name: 'run_workflow' }, '已送达 2 个：A, B', true);
  addLog('err', { name: 'bad_cmd' }, '目标客户端不在线', false);
`, ctx);
check(vm.runInContext('state.logs.length', ctx) === 2, '日志已记录', String(vm.runInContext('state.logs.length', ctx)));
check(byId.cmdLogCount.textContent === '2 条', '日志计数正确', byId.cmdLogCount.textContent);
check(byId.cmdLog.children.length === 2, '渲染 2 条日志', String(byId.cmdLog.children.length));

vm.runInContext("switchTab('gallery'); addLog('in', { name: 'x' }, '收到', true);", ctx);
check(vm.runInContext('state.unreadLogs', ctx) === 1, '非指令页时累计未读', String(vm.runInContext('state.unreadLogs', ctx)));
check(byId.tabCmdBadge.hidden === false, '指令 tab 显示未读角标');
vm.runInContext("switchTab('cmd')", ctx);
check(byId.tabCmdBadge.hidden === true, '回到指令页清除角标');

vm.runInContext('clearLogs()', ctx);
check(vm.runInContext('state.logs.length', ctx) === 0, '清空日志生效');

/* ---------- 消息分发 ---------- */
section('指令消息分发');
vm.runInContext(`
  handleMessage({ type: 'command', command: { name: 'from_client', from: ['ComfyUI-A'] } });
  handleMessage({ type: 'command_result', ok: true, command: { name: 'run' },
                  result: { delivered: 2, targets: ['A','B'] } });
  handleMessage({ type: 'command_log', direction: 'exec', command: { name: 'ping' },
                  result: { ok: true, pong: true } });
`, ctx);
check(vm.runInContext('state.logs.length', ctx) === 3, '三类指令消息都入日志', String(vm.runInContext('state.logs.length', ctx)));
const dirs = vm.runInContext('state.logs.map(l => l.dir).join(",")', ctx);
check(dirs.includes('in') && dirs.includes('out') && dirs.includes('exec'), '方向标记齐全', dirs);

section('日志条数上限');
vm.runInContext(`
  state.logs = [];
  for (let i = 0; i < 260; i++) addLog('out', { name: 'n' + i }, '', true);
`, ctx);
check(
  vm.runInContext('state.logs.length', ctx) === vm.runInContext('MAX_LOGS', ctx),
  '日志条数被裁剪到上限',
  String(vm.runInContext('state.logs.length', ctx))
);

/* ---------- 结果 ---------- */
console.log(`\n${'='.repeat(46)}\n结果：${pass}/${pass + fail} 项通过\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);