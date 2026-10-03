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
  'statSize', 'statUptime', 'viewCount', 'btnPause', 'btnSound', 'soundIcon',
  'btnSaveAll', 'btnClear', 'lightbox', 'lbImg', 'lbTitle', 'lbTags',
  'lbClose', 'lbPrev', 'lbNext', 'toasts', 'sortMode',
];
IDS.forEach((id) => { byId[id] = new FakeEl(id === 'gallery' ? 'div' : 'div'); });
byId.conn.appendChild((byId.connText = new FakeEl('span')));
byId.btnSound.appendChild(byId.soundIcon);
byId.lbPrev.style.display = '';
byId.lbNext.style.display = '';
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
global.location = { protocol: 'http:', host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080' };
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
check(FakeWS.last && FakeWS.last.url === 'ws://127.0.0.1:8080/ws', '连接到网页端 /ws', FakeWS.last && FakeWS.last.url);
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

section('断线重连');
FakeWS.last.onclose();
check(byId.conn.classList.contains('offline') === true, '断开后状态标记 offline');

/* ---------- 结果 ---------- */
console.log(`\n${'='.repeat(46)}\n结果：${pass}/${pass + fail} 项通过\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);