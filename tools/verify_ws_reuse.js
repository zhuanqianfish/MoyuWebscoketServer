/**
 * clientExample.js 的 WebSocket 复用逻辑离线测试。
 *
 * 用桩 WebSocket 模拟 ComfyUI 反复执行脚本的场景，验证：
 *   - 连接只建一次（复用）
 *   - 连接中排队不丢消息
 *   - 异常断开能退避重连
 *   - 主动 close(1000) 不触发重连
 *   - 心跳按间隔发出
 *
 * 用法：node tools/verify_ws_reuse.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'clientExample.js');

/* ── 桩 WebSocket ───────────────────────────────────── */
let created = [];        // 统计实际 new 了多少次
class FakeWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWS.CONNECTING;
    this.sent = [];
    this.onopen = this.onmessage = this.onerror = this.onclose = null;
    created.push(this);
    FakeWS.last = this;
  }
  send(d) {
    if (this.readyState !== FakeWS.OPEN) throw new Error('not open');
    this.sent.push(d);
  }
  close(code = 1000) {
    if (this.readyState === FakeWS.CLOSED) return;
    this.readyState = FakeWS.CLOSED;
    this.onclose && this.onclose({ code });
  }
  /* 测试辅助 */
  _open() { this.readyState = FakeWS.OPEN; this.onopen && this.onopen(); }
  _deliver(obj) { this.onmessage && this.onmessage({ data: JSON.stringify(obj) }); }
  _drop(code = 1006) { this.readyState = FakeWS.CLOSED; this.onclose && this.onclose({ code }); }
}
FakeWS.last = null;

/* ── 桩 ComfyUI 环境 ────────────────────────────────── */
function fakeNode() {
  return { widgets: [{ inputEl: { value: '' } }] };
}
const nodes = {};
function find(id) {
  if (!nodes[id]) nodes[id] = fakeNode();
  return nodes[id];
}

/* ── 桩定时器（手动推进） ────────────────────────────── */
const timeouts = [];
let intervals = [];
function setTimeoutStub(fn, ms) {
  const t = { fn, ms, id: timeouts.length };
  timeouts.push(t);
  return t.id;
}
function advance(ms) {
  // 按 ms 从小到大触发到期定时器
  timeouts.sort((a, b) => a.ms - b.ms);
  const due = timeouts.filter((t) => t.ms <= ms);
  timeouts.length = 0;
  due.forEach((t) => t.fn());
}
function clearTimeoutStub(id) {
  const i = timeouts.findIndex((t) => t.id === id);
  if (i >= 0) timeouts.splice(i, 1);
}

const sandbox = {
  WebSocket: FakeWS,
  console: { log: () => {}, warn: () => {}, error: () => {} },
  globalThis: null,
  find,
  setTimeout: setTimeoutStub,
  clearTimeout: clearTimeoutStub,
  setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
  clearInterval: (id) => { intervals[id - 1] = null; },
  JSON, Math, Date, String, Number, Object, Array, encodeURIComponent, Error, Boolean,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'clientExample.js' });

/* ── 断言 ───────────────────────────────────────────── */
let pass = 0, fail = 0;
function check(ok, label, extra = '') {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '\x1b[92m✓\x1b[0m' : '\x1b[91m✗\x1b[0m'} ${label}` + (extra ? `  → ${extra}` : ''));
}
const section = (t) => console.log(`\n【${t}】`);
const B64 = 'iVBORw0KGgoAAAANSUhEUg==';

console.log('\nclientExample.js —— WebSocket 复用逻辑测试\n');

/* ===================================================== */
section('场景 1：连续 5 次运行，复用同一个连接');
created = [];
// 第 1 次
vm.runInContext(`moyuSend('${B64}', 'img1')`, sandbox);
check(created.length === 1, '首次运行创建 1 个连接', `created=${created.length}`);
check(created[0].readyState === FakeWS.CONNECTING, '连接处于 CONNECTING');

created[0]._open();
check(created[0].sent.length === 1, '连接就绪后补发排队消息', `sent=${created[0].sent.length}`);

// 后 4 次（模拟 ComfyUI 反复执行）
for (let i = 2; i <= 5; i++) {
  vm.runInContext(`moyuSend('${B64}', 'img${i}')`, sandbox);
}
check(created.length === 1, '后续 4 次运行未新建连接（关键优化点）', `created=${created.length}`);
check(created[0].sent.length === 5, '5 张图全部通过同一连接发出', `sent=${created[0].sent.length}`);

const payloads = created[0].sent.map((s) => JSON.parse(s));
check(payloads.every((p) => p.image === B64), '每条 payload 含 image');
check(payloads.map((p) => p.label).join(',') === 'img1,img2,img3,img4,img5', '标签逐条正确');

section('URL 带客户端标识');
check(created[0].url.includes('client=ComfyUI'), 'URL 含 client=ComfyUI', created[0].url);

/* ===================================================== */
section('场景 2：ack 回执解析');
created[0]._deliver({ type: 'ack', ok: true, filename: 'a.png', size: 2048 });
check(true, 'ack 消息可被处理（未抛异常）');

section('场景 3：异常断开 → 退避重连');
created[0]._drop(1006);   // 异常关闭
check(created.length === 1, '断开瞬间不立即新建（先退避）');
check(timeouts.length > 0, '已排入重连定时器');

advance(1100);           // 超过第一个退避档 1000ms
check(created.length === 2, '退避到期后建立新连接', `created=${created.length}`);
check(created[1].readyState === FakeWS.CONNECTING, '新连接进入 CONNECTING');

section('场景 4：重连期间消息排队不丢');
vm.runInContext(`moyuSend('${B64}', 'during-reconnect')`, sandbox);
check(created.length === 2, '重连中不重复建连接', `created=${created.length}`);
const mgrInfo = vm.runInContext('moyuStatus()', sandbox);
check(mgrInfo.queued === 1, '消息进入队列', `queued=${mgrInfo.queued}`);

created[1]._open();
check(created[1].sent.length === 1, '新连接就绪后自动补发', `sent=${created[1].sent.length}`);
check(JSON.parse(created[1].sent[0]).label === 'during-reconnect', '补发的正是那条消息');

section('场景 5：主动 close(1000) 不触发重连');
const before = created.length;
vm.runInContext('moyuDisconnect()', sandbox);
const timeoutsAfter = timeouts.length;
advance(20000);          // 给足重连时间
check(created.length === before, '主动断开后没有重连', `created=${created.length}`);
check(vm.runInContext('moyuStatus().state', sandbox) === 'CLOSED', '状态为 CLOSED');

section('场景 6：心跳保活');
intervals = [];
created = [];
vm.runInContext(`moyuSend('${B64}', 'hb')`, sandbox);
created[0]._open();
const live = intervals.filter(Boolean);
check(live.length === 1, '连接就绪后启动 1 个心跳', `intervals=${live.length}`);
check(live[0].ms === 20000, '心跳间隔 20s', `${live[0].ms}ms`);
live[0].fn();           // 手动触发一次心跳
check(JSON.parse(created[0].sent[created[0].sent.length - 1]).type === 'ping', '心跳发出 ping');

section('场景 7：空数据跳过');
const n0 = created.length;
vm.runInContext("moyuSend('', 'x')", sandbox);
vm.runInContext('moyuSend(null, "x")', sandbox);
check(created.length === n0, '空 base64 不触发建连/发送');

section('场景 8：脚本被重新执行（ComfyUI 真实场景）');
// ComfyUI 每次跑工作流都会把整个脚本重新执行一遍。
// 关键：globalThis 上的管理器必须存活，连接不能重建。
// 先彻底断开，制造一个干净的起点
vm.runInContext('moyuDisconnect()', sandbox);
vm.runInContext("globalThis['__moyuWsManager'].retrying = false;", sandbox);

created = [];
vm.runInContext(`moyuSend('${B64}', 'exec-1')`, sandbox);
const firstWs = created[0];
firstWs._open();

// 模拟 ComfyUI 再次执行整个脚本
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'clientExample.js' });
vm.runInContext(`moyuSend('${B64}', 'exec-2')`, sandbox);
vm.runInContext(`moyuSend('${B64}', 'exec-3')`, sandbox);

check(created.length === 1, '脚本重跑 3 次仍只建 1 个连接', `created=${created.length}`);
check(created[0] === firstWs, '复用的是同一个 WebSocket 实例');
check(firstWs.sent.length === 3, '3 次执行的消息都走同一连接', `sent=${firstWs.sent.length}`);

section('场景 9：URL 变更时丢弃旧连接');
// 直接篡改管理器上的 url，模拟用户改了端口
vm.runInContext("globalThis.__moyuWsManager.url = 'ws://127.0.0.1:9999';", sandbox);
const cntBefore = created.length;
vm.runInContext(`moyuSend('${B64}', 'newurl')`, sandbox);
check(created.length === cntBefore + 1, 'URL 不匹配时新建连接', `created=${created.length}`);
check(created[created.length - 1].url.includes(':8001'), '按脚本里的 URL 重建', created[created.length - 1].url);

/* ===================================================== */
console.log(`\n${'='.repeat(50)}`);
console.log(`结果：${pass}/${pass + fail} 项通过`);
console.log(`实际创建连接数总计：${created.length}（场景内多次 send 应显著少于 send 次数）`);
console.log(`${'='.repeat(50)}`);
process.exit(fail ? 1 : 0);