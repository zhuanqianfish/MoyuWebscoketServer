// ==UserScript==
// @name         ComfyUI MOYU-JS Bridge（Fill-Nodes FL JavaScript 复刻版）
// @namespace    moyuxianren.fljs.bridge
// @version      1.1.0
// @description  在 RunningHub / LiblibArt 的 ComfyUI 页面探测实例（当前窗口 / 同源 iframe），在页面右侧加入可折叠面板，完整复刻 ComfyUI_Fill-Nodes 的 FL JavaScript 节点：在指定触发时机执行任意 JS 代码
// @author       摸鱼仙人
// @match        *://*.runninghub.cn/workflow/*
// @match        *://runninghub.cn/workflow/*
// @match        *://*.runninghub.com/workflow/*
// @match        *://runninghub.com/workflow/*
// @match        *://*.liblib.art/comfy/*
// @match        *://*.liblib.art/comfy
// @match        *://comfy.liblib.art/*
// @include      /^https?:\/\/([\w-]+\.)*runninghub\.[\w.-]+\/workflow\/.*$/
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * ComfyUI MOYU-JS Bridge
 * =====================
 * 参考项目：https://github.com/filliptm/ComfyUI_Fill-Nodes
 * 复刻对象：nodes/utility/FL_JS.py + web/nodes/utility/fl_js.js（FL JavaScript 节点）
 *
 * 功能：
 *  1. 探测当前窗口及同源 iframe 中的 ComfyUI 实例（window.app + app.graph._nodes），
 *     枚举其中的节点（id / title / comfyClass）。
 *     跨域 iframe（如 liblib.art 的 comfy.liblib.art）无法从顶层访问：
 *     脚本通过 @match 直接注入该 frame，在 frame 内部建面板、读写自己的 window.app。
 *     （因此 @noframes 已移除；脚本只会在匹配的 URL 的 frame 里运行。）
 *  2. 在页面右侧加入可折叠面板：实例选择、节点列表、JS 编辑器、脚本管理、执行日志。
 *  3. 完整实现 FL JavaScript 节点的事件触发机制，可为任意 JS 代码指定触发时机。
 *
 * 触发时机（与原版 FL_JS 的 event 下拉框一一对应）：
 *  before_queued     入队前（包装 app.queuePrompt）
 *  after_queued      入队后（api 事件 promptQueued）
 *  status            状态变化 / progress 进度 / executing 节点开始执行
 *  executed          节点执行完成 / execution_start 整个执行开始
 *  execution_success 执行成功 / execution_error 执行出错 / execution_cached 缓存命中
 *  b_preview         原版保留项：只出现在下拉框里，前端从未挂过钩子，此处同样不触发
 *
 * 远程指令（v1.0.6 新增，两条路都支持同一指令格式；v1.0.7 放宽校验并支持 to 定向；
 *           v1.0.8 别家协议消息静默忽略）：
 *  格式：JSON 字符串 {"name":"...","parameter":{},"other":{},"from":[],"to":[]}
 *  校验只要求顶层有非空字符串 name；parameter/other 缺省为 {}；
 *  from/to 及未来新增的顶层字段一律原样容忍（不校验、不剥离）。
 *  有 type 无 name 的消息视为别家协议（如图片中转站），静默忽略。
 *  to：定向投递。空数组/缺省=广播；非空时只投递给本机 ID 命中的脚本
 *      （本机 ID 在面板第 ⑥ 区显示，握手时上报给服务器）。
 *  路 A：自建 ComfyUI 装扩展（samples/moyu-cmd-extension.py），经 /ws 下发
 *        ws 消息 type 为 moyu_cmd；脚本在实例挂钩时自动监听，无需配置。
 *  路 B：面板第 ⑥ 区填自建指令服务器的 wss 地址 + token，点连接；
 *        服务器示例见 samples/moyu-cmd-server-worker.js（Cloudflare Worker）。
 *  已实现指令：
 *   run_generate  执行当前工作流（= generate()）
 *   run_workflow  执行指定工作流：parameter.prompt（API 格式，直接投 /prompt）
 *                 或 parameter.workflow（UI 格式，载入画布后执行；JSON 字符串亦可）
 *  other.instanceKey 可指定目标实例（缺省用当前选中实例）。
 *  None              不自动触发，仅手动执行
 *  onNodeExecuted    本脚本扩展（原版无）：复用 executed 的 api 事件，按目标节点 id 过滤后触发；
 *                    用户代码可通过 ARGS[0].detail.output 拿到该节点的输出
 *
 * 执行上下文（与原版 eval 作用域一致，另见编辑器内的默认模板注释）：
 *  SELF, COMMAND, STATE, PROPS, NODES, LINKS, ARGS,
 *  DATE, YEAR, MONTH, DAY, HOURS, MINUTES, SECONDS,
 *  BATCH_COUNT, QUEUE_MODE, AUTO_QUEUE, SLEEP,
 *  find, findLast, exec, getValues/getValue, setValues/setValue, connect, create,
 *  generateSeed, generateFloat, generateInt, random,
 *  bypass, unbypass, pin, unpin, remove, select,
 *  putOnLeft, putOnRight, putOnTop, putOnBottom, moveToRight, moveToBottom,
 *  getRect, setRect, getX/Y/Width/Height, setX/Y/Width/Height,
 *  generate, cancel, enableAutoQueue, disableAutoQueue, setBatchCount,
 *  disableSleep, enableSleep, disableScreenSaver, enableScreenSaver, sendImages,
 *  以及 app / api 本体。
 *
 * 与原版的差异（诚实标注）：
 *  - SELF：原版是 FL_JS 节点对象；此处是 {id, name, instance} 描述对象（面板里没有节点可挂）。
 *  - STATE：原版挂在节点上随工作流；此处是内存对象（页面刷新丢失），PROPS 则持久化到 localStorage。
 *  - disableSleep/enableSleep/disableScreenSaver/enableScreenSaver/sendImages 调用的
 *    /shinich39/event-handler/* 服务端路由不在 Fill-Nodes 本仓库内（属作者另一扩展），
 *    若服务端没有该路由会记一条警告并跳过，不中断用户代码。
 *  - b_preview：原版前端就没有钩子，此处保持一致（可选但永不触发）。
 */
(function () {
'use strict';

console.log('[FL-JS-Bridge] userscript injected on ' + location.href);

/* ============================== 常量 ============================== */

var LS_KEY = 'fljs_bridge_v1';

var EVENTS = [
  { id: 'None',              label: '不触发（仅手动执行）' },
  { id: 'before_queued',     label: '入队前 · before_queued' },
  { id: 'after_queued',      label: '入队后 · after_queued' },
  { id: 'status',            label: '状态变化 · status' },
  { id: 'progress',          label: '进度更新 · progress' },
  { id: 'executing',         label: '节点开始执行 · executing' },
  { id: 'executed',          label: '节点执行完成 · executed' },
  { id: 'execution_start',   label: '执行开始 · execution_start' },
  { id: 'execution_success', label: '执行成功 · execution_success' },
  { id: 'execution_error',   label: '执行出错 · execution_error' },
  { id: 'execution_cached',  label: '缓存命中 · execution_cached' },
  { id: 'b_preview',         label: 'b_preview（原版保留项，未挂钩）' },
  { id: 'onNodeExecuted',   label: '指定节点执行完 · onNodeExecuted（本脚本扩展，原版无）' },
];

// FL_JS 事件名 -> ComfyUI api 事件名（before_queued 走 app.queuePrompt 包装）
var API_EVENT_MAP = {
  after_queued:     'promptQueued',
  status:           'status',
  progress:         'progress',
  executing:        'executing',
  executed:         'executed',
  execution_start:  'execution_start',
  execution_success:'execution_success',
  execution_error:  'execution_error',
  execution_cached: 'execution_cached',
};

var DEFAULT_MARGIN_X = 32;
var DEFAULT_MARGIN_Y = 64;
var MIN_SEED = 0;
var MAX_SEED = parseInt('0xffffffffffffffff', 16);
var STEPS_OF_SEED = 10;

/* ============================== 持久化 ============================== */

function loadState() {
  try {
    var raw = localStorage.getItem(LS_KEY);
    if (raw) {
      var s = JSON.parse(raw);
      if (s && Array.isArray(s.scripts)) {
        if (!s.cmd || typeof s.cmd !== 'object') s.cmd = {};
        if (typeof s.cmd.url !== 'string') s.cmd.url = '';
        if (typeof s.cmd.token !== 'string') s.cmd.token = '';
        if (typeof s.cmd.enabled !== 'boolean') s.cmd.enabled = false;
        if (typeof s.cmd.clientId !== 'string') s.cmd.clientId = '';
        return s;
      }
    }
  } catch (e) { /* 忽略 */ }
  return { scripts: [], props: {}, ui: { collapsed: false }, cmd: { url: '', token: '', enabled: false, clientId: '' } };
}

function saveState() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      scripts: state.scripts,
      props: state.props,
      ui: state.ui,
      cmd: state.cmd,
    }));
  } catch (e) { /* 配额不足等，忽略 */ }
}

var state = loadState();
// 内存态 STATE：scriptId -> instanceKey -> {}
var memStates = {};
// 睡眠标记：instanceKey -> bool（对应原版模块级 SLEEP）
var sleepFlags = {};

/* ============================== 工具 ============================== */

function now2() {
  var d = new Date();
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function uid() {
  return 's' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

/* ============================== 实例探测 ============================== */

// 收集 window 及其同源 iframe（递归，深度<=2），跨域的记为不可访问
function collectWindows() {
  var out = [{ win: window, depth: 0, path: 'top' }];
  var blocked = [];
  var seen = new Set([window]);
  function walk(w, depth, path) {
    if (depth >= 2) return;
    var frames;
    try { frames = w.document.querySelectorAll('iframe'); }
    catch (e) { return; }
    for (var i = 0; i < frames.length; i++) {
      var fr = frames[i];
      var label = path + ' > iframe[' + i + ']' +
        (fr.src ? ' ' + fr.src.slice(0, 80) : '');
      var cw;
      try { cw = fr.contentWindow; } catch (e) { blocked.push(label); continue; }
      if (!cw || seen.has(cw)) continue;
      try {
        // 试探是否同源：读 location.href 跨域会抛异常
        void cw.location.href;
      } catch (e) { blocked.push(label); continue; }
      seen.add(cw);
      out.push({ win: cw, depth: depth + 1, path: label });
      walk(cw, depth + 1, label);
    }
  }
  walk(window, 0, 'top');
  return { list: out, blocked: blocked };
}

function isComfyWindow(w) {
  try {
    var app = w.app;
    return !!(app && app.graph && Array.isArray(app.graph._nodes));
  } catch (e) { return false; }
}

// 解析 api 对象：app.api -> win.api -> 对象图启发式查找 -> 动态 import
function resolveApiSync(w, app) {
  try {
    if (app && app.api && typeof app.api.addEventListener === 'function') return app.api;
  } catch (e) {}
  try {
    if (w.api && typeof w.api.addEventListener === 'function') return w.api;
  } catch (e) {}
  // 启发式：在 app 对象图里找带 fetchApi 的 EventTarget
  try {
    var seenObjs = new Set();
    var queue = [app];
    while (queue.length && seenObjs.size < 400) {
      var o = queue.shift();
      if (!o || (typeof o !== 'object' && typeof o !== 'function')) continue;
      if (seenObjs.has(o)) continue;
      seenObjs.add(o);
      try {
        if (o instanceof w.EventTarget &&
            typeof o.addEventListener === 'function' &&
            typeof o.fetchApi === 'function') return o;
      } catch (e) {}
      var names = [];
      try { names = Object.getOwnPropertyNames(o); } catch (e) {}
      for (var i = 0; i < names.length && queue.length < 400; i++) {
        var v;
        try { v = o[names[i]]; } catch (e) { continue; }
        if ((typeof v === 'object' && v !== null) || typeof v === 'function') queue.push(v);
      }
    }
  } catch (e) {}
  return null;
}

var instances = [];       // [{key,label,win,app,api,apiOk,url,nodeCount,hooked,...}]
var lastBlocked = [];     // 最近一次扫描中因跨域不可访问的 frame（label 含 src）
var selectedKey = null;

function scanInstances() {
  var found = collectWindows();
  var next = [];
  found.list.forEach(function (entry, idx) {
    if (!isComfyWindow(entry.win)) return;
    var app = entry.win.app;
    var api = resolveApiSync(entry.win, app);
    var url = '';
    try { url = entry.win.location.href; } catch (e) {}
    var key = (url || ('frame-' + idx)) + '#' + entry.depth;
    var prev = instances.find(function (x) { return x.key === key; });
    var nodeCount = 0;
    try { nodeCount = app.graph._nodes.length; } catch (e) {}
    next.push({
      key: key,
      label: (entry.depth === 0 ? '当前窗口' : 'iframe(深度' + entry.depth + ')') +
             ' · ' + nodeCount + ' 个节点',
      url: url,
      win: entry.win,
      app: app,
      api: api,
      apiOk: !!api,
      hooked: prev ? prev.hooked : false,
      sleep: true,
    });
  });
  instances = next;
  lastBlocked = found.blocked;
  if (!instances.some(function (x) { return x.key === selectedKey; })) {
    selectedKey = instances.length ? instances[0].key : null;
  }
  // 新出现的实例：把已启用的脚本挂上去
  instances.forEach(ensureHooks);
  renderInstances();
  renderNodes();
  updateTabBadge();
  return { found: instances.length, blocked: found.blocked.length };
}

/* 调试句柄：控制台执行 __MOYUJS_BRIDGE__.debug() 查看探测细节（__FLJS_BRIDGE__ 为旧别名） */
window.__MOYUJS_BRIDGE__ = window.__FLJS_BRIDGE__ = {
  version: '1.1.0',
  scan: scanInstances,
  debug: function () {
    var out = collectWindows();
    return {
      url: location.href,
      inIframe: (function () { try { return window !== window.top; } catch (e) { return '?'; } })(),
      framesChecked: out.list.length,
      framesBlocked: out.blocked.length,
      blocked: lastBlocked,
      instances: instances.map(function (x) { return { label: x.label, url: x.url }; })
    };
  },
  /* 面板已搬进 Shadow DOM，document.querySelector 找不到时用这个拿引用 */
  ui: function () {
    if (!shadowRoot) return null;
    return {
      host: shadowRoot.host,
      tab: $('fljs-tab'),
      panel: $('fljs-panel'),
      body: $('fljs-body')
    };
  }
};

function getInstance(key) {
  return instances.find(function (x) { return x.key === key; }) || null;
}
function getSelected() {
  return getInstance(selectedKey) || instances[0] || null;
}

/* ============ FL_JS 上下文工厂（忠实移植 web/nodes/utility/fl_js.js） ============ */

function makeHelpers(inst) {
  var app = inst.app, api = inst.api, win = inst.win;

  function match(node, query) {
    if (typeof query === 'number') {
      return node.id === query;
    } else if (typeof query === 'string') {
      return node.title === query || node.comfyClass === query || node.type === query;
    } else if (typeof query === 'object' && query) {
      return node.id === query.id;
    }
    return false;
  }

  function find(query) {
    var nodes = app.graph._nodes;
    for (var i = 0; i < nodes.length; i++) {
      if (match(nodes[i], query)) return nodes[i];
    }
  }

  function findLast(query) {
    var nodes = app.graph._nodes;
    for (var i = nodes.length - 1; i >= 0; i--) {
      if (match(nodes[i], query)) return nodes[i];
    }
  }

  function findNode(n) {
    if (typeof n === 'number' || typeof n === 'string') return find(n);
    return n;
  }

  function getQueueMode() {
    try { return app.extensionManager.queueSettings.mode; } catch (e) {}
    try { return app.ui.settings.getSettingValue('Comfy.Queue.Mode'); } catch (e) {}
    return undefined;
  }

  function setQueueMode(v) {
    try {
      if (typeof v === 'boolean') {
        app.extensionManager.queueSettings.mode = v ? 'instant' : 'disabled';
      } else {
        app.extensionManager.queueSettings.mode = v;
      }
      return;
    } catch (e) {}
    try { app.ui.settings.setSettingValue('Comfy.Queue.Mode', v); } catch (e2) {}
  }

  function getBatchCount() {
    try { return app.extensionManager.queueSettings.batchCount; } catch (e) {}
    return 1;
  }

  function setBatchCount(v) {
    try { app.extensionManager.queueSettings.batchCount = v; } catch (e) {}
  }

  function enableAutoQueue() { return setQueueMode('instant'); }
  function disableAutoQueue() { return setQueueMode('disabled'); }

  function exec() {
    var nodes = Array.prototype.map.call(arguments, findNode);
    for (var i = 0; i < nodes.length; i++) nodes[i].exec();
  }

  var createNode = function (className, values, options) {
    values = values || {};
    options = Object.assign({ select: true, shiftY: 0, before: false, anchor: null }, options || {});
    var LG = win.LiteGraph;
    if (!LG || typeof LG.createNode !== 'function') {
      throw new Error('当前 ComfyUI 前端未暴露 LiteGraph，create() 不可用');
    }
    var node = LG.createNode(className);
    if (!node) throw new Error(className + ' not found.');
    if (node.widgets) {
      Object.keys(values).forEach(function (key) {
        var widget = node.widgets.find(function (e) { return e.name === key; });
        if (widget) widget.value = values[key];
      });
    }
    app.graph.add(node);
    if (options.select && app.canvas) app.canvas.selectNode(node, false);
    if (options.anchor) {
      putOnRight(node, options.anchor);
    } else {
      // 无锚点：放到画布可视区左上附近，再做碰撞避让
      try {
        var cx = app.canvas ? (-app.canvas.ds.offset[0] / app.canvas.ds.scale + 32) : 32;
        var cy = app.canvas ? (-app.canvas.ds.offset[1] / app.canvas.ds.scale + 64) : 64;
        node.pos[0] = cx; node.pos[1] = cy;
      } catch (e) { node.pos[0] = 32; node.pos[1] = 64; }
    }
    moveToBottom(node);
    return node;
  };

  function getValues(node) {
    node = findNode(node);
    var result = {};
    if (node.widgets) {
      node.widgets.forEach(function (w) { result[w.name] = w.value; });
    }
    return result;
  }
  var getValue = getValues;

  function setValues(node, values) {
    node = findNode(node);
    if (node.widgets) {
      Object.keys(values).forEach(function (key) {
        var widget = node.widgets.find(function (e) { return e.name === key; });
        if (widget) widget.value = values[key];
      });
    }
  }
  var setValue = setValues;

  function connect(outputNode, outputName, inputNode, inputName) {
    outputNode = findNode(outputNode);
    inputNode = findNode(inputNode);
    if (!inputName) inputName = outputName;
    outputName = String(outputName).toUpperCase();
    inputName = String(inputName).toLowerCase();
    var output = outputName && outputNode.outputs
      ? outputNode.outputs.find(function (e) { return e.name.toUpperCase() === outputName; }) : null;
    var outputSlot, inputSlot;
    var input = inputName && inputNode.inputs
      ? inputNode.inputs.find(function (e) { return e.name.toLowerCase() === inputName; }) : null;
    if (output) {
      outputSlot = outputNode.findOutputSlot(output.name);
      if (!input) {
        input = (inputNode.inputs || []).find(function (e) { return e.type === output.type; });
        if (input) inputSlot = inputNode.findInputSlot(input.name);
      }
    }
    if (input) {
      inputSlot = inputNode.findInputSlot(input.name);
      if (!output) {
        output = (outputNode.outputs || []).find(function (e) { return e.type === input.type; });
        if (output) outputSlot = outputNode.findOutputSlot(output.name);
      }
    }
    if (typeof inputSlot === 'number' && typeof outputSlot === 'number') {
      outputNode.connect(outputSlot, inputNode.id, inputSlot);
    }
  }

  function generateFloat(min, max) {
    if (typeof min !== 'number') min = Number.MIN_SAFE_INTEGER;
    if (typeof max !== 'number') max = Number.MAX_SAFE_INTEGER;
    return Math.random() * (max - min) + min;
  }
  function generateInt(min, max) { return Math.floor(generateFloat(min, max)); }
  function generateSeed() {
    var max = Math.min(1125899906842624, MAX_SEED);
    var min = Math.max(-1125899906842624, MIN_SEED);
    var range = (max - min) / (STEPS_OF_SEED / 10);
    return Math.floor(Math.random() * range) * (STEPS_OF_SEED / 10) + min;
  }
  function random() { return arguments[generateInt(0, arguments.length)]; }

  function bypass() {
    Array.prototype.map.call(arguments, findNode).forEach(function (n) { n.mode = 4; });
  }
  function unbypass() {
    Array.prototype.map.call(arguments, findNode).forEach(function (n) { n.mode = 0; });
  }
  function pin() {
    Array.prototype.map.call(arguments, findNode).forEach(function (n) { n.pin(true); });
  }
  function unpin() {
    Array.prototype.map.call(arguments, findNode).forEach(function (n) { n.pin(false); });
  }
  function remove() {
    Array.prototype.map.call(arguments, findNode).forEach(function (n) { app.graph.remove(n); });
  }
  function select() {
    var nodes = Array.prototype.map.call(arguments, findNode);
    if (app.canvas) { app.canvas.deselectAll(); app.canvas.selectNodes(nodes); }
  }

  function generate() {
    return app.queuePrompt(0, getBatchCount());
  }
  function cancel() {
    if (api && typeof api.interrupt === 'function') return api.interrupt();
    log('cancel() 需要 api，但当前实例未解析到 api，已跳过', 'warn');
  }

  function putOnLeft(targetNode, anchorNode) {
    targetNode = findNode(targetNode); anchorNode = findNode(anchorNode);
    targetNode.pos[0] = anchorNode.pos[0] - targetNode.size[0] - DEFAULT_MARGIN_X;
    targetNode.pos[1] = anchorNode.pos[1];
  }
  function putOnRight(targetNode, anchorNode) {
    targetNode = findNode(targetNode); anchorNode = findNode(anchorNode);
    targetNode.pos[0] = anchorNode.pos[0] + anchorNode.size[0] + DEFAULT_MARGIN_X;
    targetNode.pos[1] = anchorNode.pos[1];
  }
  function putOnTop(targetNode, anchorNode) {
    targetNode = findNode(targetNode); anchorNode = findNode(anchorNode);
    targetNode.pos[0] = anchorNode.pos[0];
    targetNode.pos[1] = anchorNode.pos[1] - targetNode.size[1] - DEFAULT_MARGIN_Y;
  }
  function putOnBottom(targetNode, anchorNode) {
    targetNode = findNode(targetNode); anchorNode = findNode(anchorNode);
    targetNode.pos[0] = anchorNode.pos[0];
    targetNode.pos[1] = anchorNode.pos[1] + anchorNode.size[1] + DEFAULT_MARGIN_Y;
  }

  function isCollisionX(a, b) {
    return (a.pos[0] <= b.pos[0] + b.size[0]) && (a.pos[0] + a.size[0] >= b.pos[0]);
  }
  function isCollisionY(a, b) {
    return (a.pos[1] <= b.pos[1] + b.size[1]) && (a.pos[1] + a.size[1] >= b.pos[1]);
  }

  function moveToRight(targetNode) {
    targetNode = findNode(targetNode);
    var changed = true, guard = 0;
    while (changed && guard++ < 1000) {
      changed = false;
      app.graph._nodes.forEach(function (node) {
        if (node.id === targetNode.id) return;
        if (isCollisionX(targetNode, node) && isCollisionY(targetNode, node)) {
          targetNode.pos[0] = node.pos[0] + node.size[0] + DEFAULT_MARGIN_X;
          changed = true;
        }
      });
    }
  }
  function moveToBottom(targetNode) {
    targetNode = findNode(targetNode);
    var changed = true, guard = 0;
    while (changed && guard++ < 1000) {
      changed = false;
      app.graph._nodes.forEach(function (node) {
        if (node.id === targetNode.id) return;
        if (isCollisionX(targetNode, node) && isCollisionY(targetNode, node)) {
          targetNode.pos[1] = node.pos[1] + node.size[1] + DEFAULT_MARGIN_Y;
          changed = true;
        }
      });
    }
  }

  function getX(node) { return findNode(node).pos[0]; }
  function getY(node) { return findNode(node).pos[1]; }
  function getWidth(node) { return findNode(node).size[0]; }
  function getHeight(node) { return findNode(node).size[1]; }
  function getRect(node) {
    node = findNode(node);
    return [node.pos[0], node.pos[1], node.size[0], node.size[1]];
  }
  function setX(node, n) { findNode(node).pos[0] = n; }
  function setY(node, n) { findNode(node).pos[1] = n; }
  function setWidth(node, w) { var n = findNode(node); n.size[0] = w; if (n.onResize) n.onResize(n.size); }
  function setHeight(node, h) { var n = findNode(node); n.size[1] = h; if (n.onResize) n.onResize(n.size); }
  function setRect(node, x, y, width, height) {
    node = findNode(node);
    if (typeof x !== 'number') x = getX(node);
    if (typeof y !== 'number') y = getY(node);
    if (typeof width !== 'number') width = getWidth(node);
    if (typeof height !== 'number') height = getHeight(node);
    node.pos[0] = x; node.pos[1] = y;
    node.size[0] = width; node.size[1] = height;
    if (node.onResize) node.onResize(node.size);
  }

  // 睡眠/屏保/发图：服务端路由 /shinich39/event-handler/* 不在 Fill-Nodes 本仓库内，
  // 若目标服务端没有该扩展，记警告并跳过，不中断用户代码。
  function callEventRoute(path, method, body, okMsg) {
    if (!api || typeof api.fetchApi !== 'function') {
      log(okMsg + '：需要 api.fetchApi，未解析到 api，已跳过', 'warn');
      return Promise.resolve(false);
    }
    return api.fetchApi(path, { method: method || 'GET', body: body })
      .then(function (resp) {
        if (resp.status !== 200) throw new Error(resp.statusText);
        log('[FL-JS] ' + okMsg);
        return true;
      })
      .catch(function (err) {
        log('[FL-JS] ' + okMsg + ' 失败（服务端可能未安装对应扩展）: ' + err.message, 'warn');
        return false;
      });
  }

  function disableSleep() {
    return callEventRoute('/shinich39/event-handler/disable-sleep', 'GET', null, 'Disable system sleep')
      .then(function () { inst.sleep = false; });
  }
  function enableSleep() {
    return callEventRoute('/shinich39/event-handler/enable-sleep', 'GET', null, 'Enable system sleep')
      .then(function () { inst.sleep = true; });
  }
  function disableScreenSaver() {
    return callEventRoute('/shinich39/event-handler/disable-screen-saver', 'GET', null, 'Disable screen saver')
      .then(function () { inst.sleep = false; });
  }
  function enableScreenSaver() {
    return callEventRoute('/shinich39/event-handler/enable-screen-saver', 'GET', null, 'Enable screen saver')
      .then(function () { inst.sleep = true; });
  }

  function getPathFromImg(img) {
    var url = new URL(img.src);
    var filename = url.searchParams.get('filename');
    var subdir = url.searchParams.get('subfolder');
    var dir = url.searchParams.get('type');
    return 'ComfyUI' +
      (dir ? '/' + dir : '') +
      (subdir ? '/' + subdir : '') +
      (filename ? '/' + filename : '');
  }

  function sendImages(url, field) {
    var filePaths = Array.prototype.slice.call(arguments, 2).reduce(function (acc, cur) {
      if (typeof cur === 'object' && cur && cur.comfyClass === 'PreviewImage') {
        if (cur.imgs) acc.push.apply(acc, cur.imgs.map(getPathFromImg));
      } else if (typeof cur === 'string') {
        acc.push(cur);
      }
      return acc;
    }, []);
    if (filePaths.length < 1) throw new Error('Images not found');
    return callEventRoute('/shinich39/event-handler/send-images', 'POST',
      JSON.stringify({ url: url, field: field, files: filePaths }), 'sendImages ok');
  }

  function create(className, values, options) {
    return createNode.call(null, className, values, options);
  }

  function getDefaultCommand() {
    var nodes = app.graph._nodes
      .filter(function (e) { return e; })
      .sort(function (a, b) { return a.id - b.id; });
    var text = '';
    nodes.forEach(function (node) {
      text += 'var n' + node.id + ' = find(' + node.id + '); // ' + (node.title || node.type) + '\n';
    });
    text += '\n// You can use javascript code here!\n';
    text += '// COMMAND: string\n';
    text += '// STATE: <string, any>\n';
    text += '// PROPS: <string, any>\n';
    text += '// NODES: Node[]\n';
    text += '// LINKS: Link[]\n';
    text += '// ARGS: any[]\n';
    text += '// DATE: Date\n';
    text += '// YEAR/MONTH/DAY/HOURS/MINUTES/SECONDS: number\n';
    text += '// QUEUE_MODE: "disabled"|"instant"|"change"\n';
    text += '// AUTO_QUEUE: boolean\n';
    text += '// BATCH_COUNT: number\n';
    text += '// SLEEP: boolean\n';
    text += '\n// find(ID|TITLE|TYPE) => Node\n';
    text += '// findLast(ID|TITLE|TYPE) => Node\n';
    text += '// exec(...NODE)\n';
    text += '// getValues(NODE) => { key: value, ... }\n';
    text += '// setValues(NODE, { key: value, ... })\n';
    text += '// connect(OUTPUT_NODE, OUTPUT_SLOT_NAME, INPUT_NODE, INPUT_SLOT_NAME?)\n';
    text += '// create(TYPE, { key: value, ... }, { anchor? }) => Node\n';
    text += '// generateSeed() => number\n';
    text += '// generateFloat(min, max) => number\n';
    text += '// generateInt(min, max) => number\n';
    text += '// random(...any[]) => any\n';
    text += '// bypass(...NODE) / unbypass(...NODE)\n';
    text += '// pin(...NODE) / unpin(...NODE)\n';
    text += '// remove(...NODE)\n';
    text += '// select(...NODE)\n';
    text += '// putOnLeft/Right/Top/Bottom(NODE, TARGET_NODE)\n';
    text += '// moveToRight(NODE) / moveToBottom(NODE)\n';
    text += '// getRect(NODE) => [x, y, width, height]\n';
    text += '// setRect(NODE, x?, y?, width?, height?)\n';
    text += '// generate() // 开始生成\n';
    text += '// cancel()   // 中断当前生成\n';
    text += '// enableAutoQueue() / disableAutoQueue() / setBatchCount(n)\n';
    text += '// disableSleep()/enableSleep()/disableScreenSaver()/enableScreenSaver()\n';
    text += '// sendImages(url, field, ...PREVIEW_NODE)\n';
    return text;
  }

  return {
    match: match, findNode: findNode, find: find, findLast: findLast, exec: exec,
    getValues: getValues, getValue: getValue, setValues: setValues, setValue: setValue,
    connect: connect, create: create,
    generateSeed: generateSeed, generateFloat: generateFloat, generateInt: generateInt, random: random,
    bypass: bypass, unbypass: unbypass, pin: pin, unpin: unpin, remove: remove, select: select,
    putOnLeft: putOnLeft, putOnRight: putOnRight, putOnTop: putOnTop, putOnBottom: putOnBottom,
    moveToRight: moveToRight, moveToBottom: moveToBottom,
    getRect: getRect, setRect: setRect,
    getX: getX, getY: getY, getWidth: getWidth, getHeight: getHeight,
    setX: setX, setY: setY, setWidth: setWidth, setHeight: setHeight,
    generate: generate, cancel: cancel,
    enableAutoQueue: enableAutoQueue, disableAutoQueue: disableAutoQueue, setBatchCount: setBatchCount,
    getQueueMode: getQueueMode, setQueueMode: setQueueMode, getBatchCount: getBatchCount,
    disableSleep: disableSleep, enableSleep: enableSleep,
    disableScreenSaver: disableScreenSaver, enableScreenSaver: enableScreenSaver,
    sendImages: sendImages,
    getDefaultCommand: getDefaultCommand,
  };
}

/* ============================== 脚本执行 ============================== */

var CTX_PARAMS = [
  'SELF', 'COMMAND', 'STATE', 'PROPS', 'NODES', 'LINKS', 'ARGS',
  'DATE', 'YEAR', 'MONTH', 'DAY', 'HOURS', 'MINUTES', 'SECONDS',
  'BATCH_COUNT', 'QUEUE_MODE', 'AUTO_QUEUE', 'SLEEP',
  'match', 'findNode', 'find', 'findLast', 'exec',
  'getValues', 'getValue', 'setValues', 'setValue',
  'connect', 'create',
  'generateSeed', 'generateFloat', 'generateInt', 'random',
  'bypass', 'unbypass', 'pin', 'unpin', 'remove', 'select',
  'putOnLeft', 'putOnRight', 'putOnTop', 'putOnBottom',
  'moveToRight', 'moveToBottom',
  'getRect', 'setRect',
  'getX', 'getY', 'getWidth', 'getHeight',
  'setX', 'setY', 'setWidth', 'setHeight',
  'generate', 'cancel',
  'enableAutoQueue', 'disableAutoQueue', 'setBatchCount',
  'disableSleep', 'enableSleep', 'disableScreenSaver', 'enableScreenSaver',
  'sendImages',
  'app', 'api',
];

// 在目标窗口的 realm 里执行用户代码（这样 document / LiteGraph 等都是 ComfyUI 页面的）
function runUserCode(inst, script, code, args, eventName) {
  var h = makeHelpers(inst);
  var app = inst.app, api = inst.api;

  if (!memStates[script.id]) memStates[script.id] = {};
  if (!memStates[script.id][inst.key]) memStates[script.id][inst.key] = {};
  if (!state.props[script.id]) state.props[script.id] = {};

  var SELF = { id: script.id, name: script.name, instance: inst.label, url: inst.url };
  var DATE = new Date();
  var values = [
    SELF, code,
    memStates[script.id][inst.key],
    state.props[script.id],
    app.graph._nodes, app.graph.links, args || [],
    DATE,
    DATE.getFullYear(), DATE.getMonth() + 1, DATE.getDay(),
    DATE.getHours(), DATE.getMinutes(), DATE.getSeconds(),
    h.getBatchCount(), h.getQueueMode(),
    h.getQueueMode() !== 'disabled',
    !!inst.sleep,
    h.match, h.findNode, h.find, h.findLast, h.exec,
    h.getValues, h.getValue, h.setValues, h.setValue,
    h.connect, h.create,
    h.generateSeed, h.generateFloat, h.generateInt, h.random,
    h.bypass, h.unbypass, h.pin, h.unpin, h.remove, h.select,
    h.putOnLeft, h.putOnRight, h.putOnTop, h.putOnBottom,
    h.moveToRight, h.moveToBottom,
    h.getRect, h.setRect,
    h.getX, h.getY, h.getWidth, h.getHeight,
    h.setX, h.setY, h.setWidth, h.setHeight,
    h.generate, h.cancel,
    h.enableAutoQueue, h.disableAutoQueue, h.setBatchCount,
    h.disableSleep, h.enableSleep, h.disableScreenSaver, h.enableScreenSaver,
    h.sendImages,
    app, api,
  ];

  // 包一层 async IIFE：用户代码里可直接用 await；顶层 return 也合法
  var wrapped = 'return (async function(){\n' + code + '\n})();';
  var Fn = inst.win.Function || Function;
  var t0 = performance.now();
  var fn;
  try {
    fn = new Fn(CTX_PARAMS.join(','), wrapped);
  } catch (e) {
    log('[' + eventName + '] 「' + script.name + '」语法错误: ' + e.message, 'error');
    return Promise.resolve();
  }
  var p;
  try {
    p = fn.apply(null, values);
  } catch (e) {
    log('[' + eventName + '] 「' + script.name + '」执行出错: ' + (e && e.stack || e), 'error');
    return Promise.resolve();
  }
  return Promise.resolve(p).then(function () {
    saveState(); // PROPS 可能被用户代码修改，落盘
    log('[' + eventName + '] 「' + script.name + '」✓ ' +
        Math.round(performance.now() - t0) + 'ms', 'ok');
  }).catch(function (e) {
    log('[' + eventName + '] 「' + script.name + '」执行出错: ' + (e && e.stack || e), 'error');
  });
}

// 某个实例上触发某事件：跑所有启用、事件匹配、目标匹配的脚本
function runScriptsFor(inst, eventName, args, matchNode) {
  var jobs = [];
  var wantNode = null;
  if (matchNode) {
    try { var d = args[0] && args[0].detail; wantNode = d ? d.node : null; } catch (e) {}
  }
  state.scripts.forEach(function (s) {
    if (!s.enabled) return;
    if (s.event !== eventName) return;
    if (s.target !== '*' && s.target !== inst.key) return;
    if (matchNode && String(s.nodeId || '') !== String(wantNode)) return;
    jobs.push(runUserCode(inst, s, s.code, args, eventName));
  });
  if (!jobs.length) return Promise.resolve();
  return Promise.all(jobs);
}

/* ============================== 事件钩子 ============================== */

function ensureHooks(inst) {
  if (inst.hooked) return;
  inst.hooked = true;
  var app = inst.app, api = inst.api;

  // before_queued：包装 app.queuePrompt（对应原版 setup() 里的逻辑）
  try {
    if (typeof app.queuePrompt === 'function' && !app.__fljs_qp_wrapped) {
      var orig = app.queuePrompt;
      app.__fljs_qp_wrapped = true;
      app.queuePrompt = function () {
        var args = Array.prototype.slice.call(arguments);
        var self = this;
        return runScriptsFor(inst, 'before_queued', args)
          .then(function () { return orig.apply(self, args); });
      };
      log('已挂钩 ' + inst.label + ' 的 before_queued（app.queuePrompt）', 'ok');
    }
  } catch (e) {
    log('挂钩 before_queued 失败: ' + e.message, 'error');
  }

  // 其余事件：api.addEventListener（对应原版 setup() 里的逻辑）
  if (api && typeof api.addEventListener === 'function') {
    Object.keys(API_EVENT_MAP).forEach(function (fljsEvent) {
      var apiEvent = API_EVENT_MAP[fljsEvent];
      try {
        var handler = function () {
          var args = Array.prototype.slice.call(arguments);
          runScriptsFor(inst, fljsEvent, args);
          // 扩展事件 onNodeExecuted：复用 executed 的 api 事件，按节点 id 过滤
          if (fljsEvent === 'executed') runScriptsFor(inst, 'onNodeExecuted', args, true);
        };
        api.addEventListener(apiEvent, handler);
      } catch (e) {
        log('挂钩 ' + apiEvent + ' 失败: ' + e.message, 'error');
      }
    });
    log('已挂钩 ' + inst.label + ' 的 api 事件（after_queued/status/progress/executing/executed/execution_start/execution_success/execution_error/execution_cached）', 'ok');
  } else {
    log(inst.label + ' 未解析到 api 对象：api 事件类触发时机不可用（before_queued 与手动执行仍可用）', 'warn');
  }

  // 路 A：服务端经 /ws 下发的指令（moyu_cmd），与触发脚本钩子相互独立
  try { hookCmdChannel(inst); } catch (e) { log('挂钩服务端指令通道失败: ' + e.message, 'warn'); }
}

/* ============================== 远程指令 ============================== */
/* 指令格式：JSON 字符串 {"name":"...","parameter":{},"other":{}}
   路 A：自建 ComfyUI 的扩展经 /ws 下发（ws 消息 type = moyu_cmd），见 samples/moyu-cmd-extension.py
   路 B：脚本直连自建指令服务器（独立 wss 通道），见 samples/moyu-cmd-server-worker.js
   已实现指令：
     run_generate  执行当前工作流（= generate()，跑画布上当前打开的工作流）
     run_workflow   执行指定工作流：parameter.prompt（API 格式）或 parameter.workflow（UI 格式/JSON 字符串亦可） */

var CMD_WS_TYPE = 'moyu_cmd';

function asObject(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string') { try { var o = JSON.parse(v); if (o && typeof o === 'object') return o; } catch (e) {} }
  return null;
}

/* API 格式 prompt：{"3":{"class_type":"KSampler","inputs":{...}}, ...} */
function isApiPrompt(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  var keys = Object.keys(o);
  if (!keys.length) return false;
  for (var i = 0; i < keys.length; i++) {
    var n = o[keys[i]];
    if (!n || typeof n !== 'object' || typeof n.class_type !== 'string' ||
        !n.inputs || typeof n.inputs !== 'object') return false;
  }
  return true;
}

function dispatchCommand(raw, sourceLabel, reply) {
  /* 灵活校验：只要求顶层有非空字符串 name；parameter/other 缺省为 {};
     from/to 及未来新增的顶层字段一律原样容忍（不校验、不剥离）。
     其他协议的消息（如图片中转站的 {"type":"welcome",...}）：有 type 无 name，
     静默忽略，不刷警告——它不是发给指令通道的。 */
  var cmd = asObject(raw);
  if (!cmd) {
    var snippet = '';
    try { snippet = String(raw).slice(0, 160); } catch (e) {}
    log('[' + sourceLabel + '] 收到非 JSON 消息，已忽略: ' + snippet, 'warn');
    return;
  }
  if (typeof cmd.name !== 'string' || !cmd.name) {
    if (typeof cmd.type === 'string') return; // 别家协议的消息，静默忽略
    var snippet2 = '';
    try { snippet2 = JSON.stringify(cmd).slice(0, 160); } catch (e) {}
    log('[' + sourceLabel + '] 指令格式不对，已忽略（需要顶层 name 字段）。收到: ' + snippet2, 'warn');
    return;
  }
  /* to 定向投递：to 为非空数组时，只处理命中本机的指令。
     命中条件任一即可：服务端分配的 id（serverClientId）、本机自报 id（getClientId()）。
     —— 两边 id 必须都能命中，否则会出现「服务端显示已送达、客户端却收不到」的僵局。 */
  try {
    if (Array.isArray(cmd.to) && cmd.to.length) {
      var myIds = [getClientId(), serverClientId];
      var hit = cmd.to.some(function (t) {
        return myIds.some(function (m) { return m && String(t) === String(m); });
      });
      if (!hit) {
        log('[' + sourceLabel + '] 指令 ' + cmd.name + ' 的 to 未命中本机（to=' +
            JSON.stringify(cmd.to).slice(0, 80) + '，本机=' +
            (serverClientId || getClientId()) + '），已跳过', 'warn');
        return;
      }
    }
  } catch (e) {}
  var parameter = asObject(cmd.parameter) || {};
  var other = asObject(cmd.other) || {};
  var inst = (other.instanceKey && getInstance(other.instanceKey)) || getSelected();
  if (!inst) {
    log('[' + sourceLabel + '] 没有可用的 ComfyUI 实例，指令 ' + cmd.name + ' 未执行', 'warn');
    if (reply) reply(cmd, false, '没有可用的 ComfyUI 实例');
    return;
  }
  var fromTxt = '';
  try { if (cmd.from !== undefined) fromTxt = ' from=' + JSON.stringify(cmd.from).slice(0, 80); } catch (e) {}
  log('[' + sourceLabel + '] 收到指令 ' + cmd.name + fromTxt + ' → ' + inst.label, 'info');
  try {
    if (cmd.name === 'run_generate' || cmd.name === 'run_current_workflow') {
      cmdRunGenerate(inst);
      if (reply) reply(cmd, true, '已提交当前工作流');
    } else if (cmd.name === 'run_workflow') {
      cmdRunWorkflow(inst, parameter)
        .then(function (msg) { if (reply) reply(cmd, true, msg); },
              function (e) { if (reply) reply(cmd, false, String(e && e.message || e)); });
      return;
    } else if (cmd.name === 'ping' || cmd.name === 'whoami') {
      var info = 'MOYU-JS Bridge ' + (window.__MOYUJS_BRIDGE__ ? window.__MOYUJS_BRIDGE__.version : '?') +
                  ' · 实例 ' + inst.label;
      log('[' + sourceLabel + '] 握手指令 ' + cmd.name + ' → ' + info, 'ok');
      if (reply) reply(cmd, true, info);
      return;
    } else {
      log('[' + sourceLabel + '] 未知指令 "' + cmd.name + '"，已忽略', 'warn');
      if (reply) reply(cmd, false, '未知指令：' + cmd.name);
      return;
    }
  } catch (e) {
    log('[' + sourceLabel + '] 执行指令 ' + cmd.name + ' 出错: ' + (e && e.message), 'error');
    if (reply) reply(cmd, false, String(e && e.message || e));
    return;
  }
  if (reply) reply(cmd, true, 'ok');
}

/* 本机指令 ID：持久化，供服务端的 to 定向投递命中 */
function getClientId() {
  if (!state.cmd.clientId) {
    state.cmd.clientId = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    try { saveState(); } catch (e) {}
  }
  return state.cmd.clientId;
}

/* 服务端分配的 id（welcome 里下发）。
   服务端的 to 用的就是它，而本机自报 id 只在部分部署里一致，
   两者都纳入命中判断，避免「服务端说送达、客户端却跳过」。 */
var serverClientId = '';

/* 向指令服务器回执。reply 由 openCmdSock 注入，other 通道（路 A）传 null。 */
function makeReplyer(sock) {
  return function (cmd, ok, detail) {
    try {
      sock.send(JSON.stringify({
        type: 'command_result',
        name: cmd.name,
        from: [getClientId()],
        result: { ok: !!ok, detail: String(detail == null ? '' : detail).slice(0, 300) }
      }));
    } catch (e) { /* 忽略回执失败 */ }
  };
}

function cmdRunGenerate(inst) {
  makeHelpers(inst).generate();
  log('[指令] run_generate 已提交当前工作流 → ' + inst.label, 'ok');
  return '已提交当前工作流';
}

function cmdRunWorkflow(inst, parameter) {
  var prompt = asObject(parameter.prompt);
  var workflow = asObject(parameter.workflow);
  if (prompt && isApiPrompt(prompt)) return queueApiPrompt(inst, prompt);
  if (workflow) {
    if (isApiPrompt(workflow)) return queueApiPrompt(inst, workflow);
    /* UI 格式：载入画布后 generate()。注意这会替换当前画布内容，如实提示。 */
    if (inst.app && typeof inst.app.loadGraphData === 'function') {
      inst.app.loadGraphData(workflow);
      log('[指令] run_workflow 已把工作流载入画布，开始执行', 'info');
      cmdRunGenerate(inst);
      return Promise.resolve('已载入并执行导入的工作流');
    }
    return Promise.reject(new Error('当前 app 不支持 loadGraphData，无法载入 UI 格式工作流'));
  }
  /* parameter 为空：没有工作流可载入，退回「执行当前画布工作流」而不是报错。
     网页端「运行当前工作流」按钮与手填空 parameter 都会走到这里。 */
  log('[指令] run_workflow 未携带工作流内容，退回执行当前画布工作流', 'info');
  cmdRunGenerate(inst);
  return Promise.resolve('未携带工作流内容，已执行当前画布工作流');
}

/* 经 /prompt 直接投递 API 格式 prompt（不经过画布） */
function queueApiPrompt(inst, prompt) {
  var api = inst.api, win = inst.win;
  var cid = '';
  try { cid = (api && api.clientId) || ''; } catch (e) {}
  var body = JSON.stringify({ prompt: prompt, client_id: cid });
  var req = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body };
  var p;
  if (api && typeof api.fetchApi === 'function') {
    p = api.fetchApi('/prompt', req);
  } else {
    var base = '';
    try { base = win.location.origin; } catch (e) {}
    p = win.fetch(base + '/prompt', req);
  }
  return Promise.resolve(p).then(function (r) { return (r && r.json) ? r.json() : r; })
    .then(function (j) {
      log('[指令] run_workflow(API) 已提交，prompt_id=' + (j && j.prompt_id), 'ok');
      return j;
    });
}

/* 路 A：挂载 ComfyUI 服务端经 /ws 下发的指令（type = moyu_cmd）。
   优先直接监听底层 WebSocket（不依赖前端是否把未知 type 分发成事件），
   拿不到 socket 时回退到 api.addEventListener。 */
function hookCmdChannel(inst) {
  var api = inst.api;
  var onData = function (data) { dispatchCommand(data, 'ws@' + inst.label); };
  var sock = null;
  try { sock = api && api.socket; } catch (e) {}
  if (sock && typeof sock.addEventListener === 'function') {
    sock.addEventListener('message', function (ev) {
      var msg = null;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg && msg.type === CMD_WS_TYPE) onData(msg.data);
    });
    log('已挂钩 ' + inst.label + ' 的服务端指令通道（ws type=' + CMD_WS_TYPE + '，底层 socket）', 'ok');
    return;
  }
  if (api && typeof api.addEventListener === 'function') {
    api.addEventListener(CMD_WS_TYPE, function (ev) {
      onData(ev && ev.detail !== undefined ? ev.detail : ev);
    });
    log('已挂钩 ' + inst.label + ' 的服务端指令通道（ws type=' + CMD_WS_TYPE + '，api 事件）', 'ok');
  } else {
    log(inst.label + ' 未解析到 api，服务端指令通道（路 A）不可用', 'warn');
  }
}

/* 路 B：直连自建指令服务器的 WebSocket 客户端（独立通道，带 token 鉴权与断线重连） */
var cmdSock = null, cmdRetryTimer = null, cmdRetryDelay = 3000, cmdWantOn = false;

function cmdStatus(t, cls) {
  var el = $('fljs-cmdstatus');
  if (el) el.textContent = t;
  log('[指令通道] ' + t, cls || 'info');
}

function cmdConnect() {
  var urlEl = $('fljs-cmdurl'), tokEl = $('fljs-cmdtoken');
  var url = (urlEl && urlEl.value.trim()) || state.cmd.url || '';
  var token = (tokEl && tokEl.value.trim()) || state.cmd.token || '';
  if (!url) { log('[指令通道] 请先填写服务器地址（wss://…）', 'warn'); return; }
  state.cmd.url = url; state.cmd.token = token; state.cmd.enabled = true; saveState();
  cmdWantOn = true;
  openCmdSock(url, token);
}

/* 拼上 clientId 的连接地址：服务端会沿用它作为登记 id，
   网页端指令里的 to 填的就是本机 id，两边不会对不上。 */
function buildCmdUrl(url) {
  var base = String(url || '').split('#')[0];
  var cid = getClientId();
  var has = /[?&]clientId=/.test(base) || /[?&]cid=/.test(base);
  if (has) {
    return base.replace(/([?&])(clientId|cid)=[^&]*/g, function (m, sep) {
      return sep + (m.indexOf('clientId') >= 0 ? 'clientId' : 'cid') + '=' + encodeURIComponent(cid);
    });
  }
  return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'clientId=' + encodeURIComponent(cid);
}

function openCmdSock(url, token) {
  cmdDisconnect(true);
  var ws;
  var realUrl = buildCmdUrl(url);
  try { ws = new WebSocket(realUrl); }
  catch (e) { log('[指令通道] 创建连接失败: ' + e.message, 'error'); scheduleCmdRetry(); return; }
  cmdSock = ws;
  cmdStatus('连接中…');
  ws.onopen = function () {
    cmdRetryDelay = 3000;
    cmdStatus('已连接', 'ok');
    /* 握手：token 鉴权 + 上报本机 ID（部分服务端用这条消息分配 id） */
    try { ws.send(JSON.stringify({ auth: token || '', clientId: getClientId() })); } catch (e) {}
  };
  ws.onmessage = function (ev) {
    var msg = null;
    try { msg = JSON.parse(ev.data); } catch (e) {}
    if (msg && msg.type === 'welcome' && msg.client_id) {
      serverClientId = msg.client_id;
      log('[指令通道] 服务端登记 id = ' + serverClientId + '（本机 id = ' + getClientId() + '）', 'ok');
      return;
    }
    /* 控制台/状态类消息：不是指令，忽略（避免被 dispatch 当成别家协议刷屏） */
    if (msg && typeof msg.name !== 'string' && typeof msg.type === 'string') return;
    dispatchCommand(ev.data, '指令服务器', makeReplyer(ws));
  };
  ws.onclose = function () {
    cmdSock = null;
    cmdStatus('已断开');
    if (cmdWantOn) scheduleCmdRetry();
  };
  ws.onerror = function () { /* onclose 会跟进处理 */ };
}

function scheduleCmdRetry() {
  if (!cmdWantOn || cmdRetryTimer) return;
  cmdRetryTimer = setTimeout(function () {
    cmdRetryTimer = null;
    if (!cmdWantOn || !state.cmd.url) return;
    cmdStatus('重连中…');
    openCmdSock(state.cmd.url, state.cmd.token || '');
  }, cmdRetryDelay);
  cmdRetryDelay = Math.min(cmdRetryDelay * 2, 60000);
}

function cmdDisconnect(silent) {
  cmdWantOn = false;
  if (cmdRetryTimer) { clearTimeout(cmdRetryTimer); cmdRetryTimer = null; }
  if (cmdSock) { try { cmdSock.close(); } catch (e) {} cmdSock = null; }
  if (!silent) { state.cmd.enabled = false; saveState(); cmdStatus('已断开'); }
}

/* ============================== UI ============================== */

/* Shadow DOM：把 tab / panel / 样式全部装进 shadow root，页面自身的 CSS
   （如 ComfyUI 前端的全局规则）无法穿透进来覆盖我们的布局。
   v1.0.4 在 comfy.liblib.art iframe 里出现过正文区被压成 0 高度的情况
   （display:flex 生效、同条规则的 padding 却被覆盖），Shadow DOM 根治此类干扰。 */
var shadowRoot = null;
var $ = function (id) { return shadowRoot ? shadowRoot.getElementById(id) : document.getElementById(id); };
var $q = function (sel) { return shadowRoot ? shadowRoot.querySelector(sel) : document.querySelector(sel); };

/* liblib 外壳页判定：www.liblib.art/comfy 本身不是 ComfyUI，只是套壳；
   真正的 UI 由 comfy.liblib.art frame 内的实例提供，外壳页不建按钮，
   避免页面右侧出现两个竖条。 */
function isLiblibShell() {
  var h = '';
  try { h = location.hostname || ''; } catch (e) {}
  return /(^|\.)liblib\.art$/.test(h) && h !== 'comfy.liblib.art';
}

var CSS = [
  '#fljs-tab{position:fixed;right:0;top:40%;z-index:2147483646;background:#1e1e2e;color:#cdd6f4;',
  ' border:1px solid #45475a;border-right:none;border-radius:8px 0 0 8px;padding:10px 6px;cursor:pointer;',
  ' font:12px/1.4 system-ui,sans-serif;writing-mode:vertical-rl;letter-spacing:2px;user-select:none;}',
  '#fljs-tab:hover{background:#313244;}',
  '#fljs-tab .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#6c7086;margin-bottom:6px;}',
  '#fljs-tab .dot.on{background:#a6e3a1;}',
  '#fljs-panel{position:fixed;right:0;top:60px;bottom:20px;width:400px;max-width:92vw;z-index:2147483647;',
  ' background:#1e1e2e;color:#cdd6f4;border:1px solid #45475a;border-right:none;border-radius:10px 0 0 10px;',
  ' display:flex;flex-direction:column;font:13px/1.5 system-ui,-apple-system,sans-serif;box-shadow:-4px 0 24px rgba(0,0,0,.45);}',
  '#fljs-panel.hidden{display:none;}',
  '#fljs-head{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#313244;',
  ' border-radius:10px 0 0 0;cursor:default;user-select:none;}',
  '#fljs-head b{font-size:14px;}',
  '#fljs-head .sub{font-size:11px;color:#9399b2;}',
  '#fljs-head .sp{flex:1;}',
  '#fljs-head button{background:#45475a;border:none;color:#cdd6f4;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;}',
  '#fljs-head button:hover{background:#585b70;}',
  '#fljs-body{flex:1;min-height:0;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:12px;}',
  '#fljs-body.collapsed{display:none;}',
  '.fljs-sec{background:#181825;border:1px solid #313244;border-radius:8px;padding:8px 10px;}',
  '.fljs-sec h4{margin:0 0 8px;font-size:12px;color:#89b4fa;letter-spacing:1px;}',
  '.fljs-row{display:flex;gap:6px;align-items:center;margin-bottom:6px;}',
  '.fljs-row:last-child{margin-bottom:0;}',
  '#fljs-panel select,#fljs-panel input[type=text]{background:#11111b;border:1px solid #45475a;color:#cdd6f4;',
  ' border-radius:6px;padding:5px 8px;font-size:12px;flex:1;min-width:0;}',
  '#fljs-panel button.act{background:#45475a;border:none;color:#cdd6f4;border-radius:6px;padding:5px 10px;',
  ' cursor:pointer;font-size:12px;white-space:nowrap;}',
  '#fljs-panel button.act:hover{background:#585b70;}',
  '#fljs-panel button.primary{background:#89b4fa;color:#11111b;font-weight:600;}',
  '#fljs-panel button.primary:hover{background:#b4befe;}',
  '#fljs-panel button.danger{background:#f38ba8;color:#11111b;}',
  '#fljs-panel button.danger:hover{background:#eba0ac;}',
  '#fljs-code{width:100%;height:180px;background:#11111b;border:1px solid #45475a;color:#cdd6f4;',
  ' border-radius:6px;padding:8px;font:12px/1.5 Consolas,Menlo,monospace;resize:vertical;box-sizing:border-box;}',
  '#fljs-nodes{max-height:180px;overflow-y:auto;}',
  '.fljs-node{display:flex;gap:8px;align-items:center;padding:4px 6px;border-radius:6px;cursor:pointer;font-size:12px;}',
  '.fljs-node:hover{background:#313244;}',
  '.fljs-node .nid{color:#89b4fa;min-width:34px;font-family:Consolas,monospace;}',
  '.fljs-node .ntype{color:#9399b2;font-size:11px;margin-left:auto;}',
  '.fljs-inst{display:flex;gap:8px;align-items:flex-start;padding:6px;border:1px solid #313244;border-radius:6px;margin-bottom:6px;cursor:pointer;}',
  '.fljs-inst.sel{border-color:#89b4fa;background:#1e2a4a;}',
  '.fljs-inst .t{font-size:12px;}',
  '.fljs-inst .u{font-size:11px;color:#9399b2;word-break:break-all;}',
  '.fljs-inst .warn{color:#f9e2af;font-size:11px;}',
  '.fljs-script{border:1px solid #313244;border-radius:6px;padding:6px 8px;margin-bottom:6px;font-size:12px;}',
  '.fljs-script .nm{font-weight:600;}',
  '.fljs-script .ev{display:inline-block;background:#313244;border-radius:4px;padding:1px 6px;font-size:11px;color:#a6e3a1;margin-left:6px;}',
  '.fljs-script .ev.off{color:#6c7086;}',
  '.fljs-script .tg{font-size:11px;color:#9399b2;margin-left:6px;}',
  '.fljs-script .ops{margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;}',
  '.fljs-script .ops button{background:#45475a;border:none;color:#cdd6f4;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:11px;}',
  '.fljs-script .ops button:hover{background:#585b70;}',
  '#fljs-log{max-height:160px;overflow-y:auto;background:#11111b;border-radius:6px;padding:6px 8px;font:11px/1.6 Consolas,monospace;}',
  '#fljs-log .ok{color:#a6e3a1;} #fljs-log .error{color:#f38ba8;} #fljs-log .warn{color:#f9e2af;} #fljs-log .info{color:#9399b2;}',
  '.fljs-hint{font-size:11px;color:#9399b2;}',
  '.fljs-empty{font-size:12px;color:#6c7086;padding:6px 0;}',
].join('\n');

function buildUI() {
  /* liblib 外壳页不建 UI：真正的按钮在 comfy.liblib.art frame 里 */
  if (isLiblibShell()) {
    try { console.log('[MOYU-JS] liblib 外壳页：UI 由 comfy.liblib.art frame 内实例提供，本 frame 不创建按钮'); } catch (e) {}
    return;
  }
  if ($('fljs-tab')) return;

  /* 宿主 + Shadow DOM：样式与结构与页面完全隔离 */
  var host = document.createElement('div');
  host.id = 'moyujs-host';
  document.body.appendChild(host);
  shadowRoot = host.attachShadow({ mode: 'open' });

  var st = document.createElement('style');
  st.textContent = CSS;
  shadowRoot.appendChild(st);

  var tab = document.createElement('div');
  tab.id = 'fljs-tab';
  tab.innerHTML = '<span class="dot"></span>MOYU·JS';
  tab.title = 'ComfyUI MOYU-JS Bridge（点击展开）';
  tab.addEventListener('click', function () {
    $('fljs-panel').classList.remove('hidden');
    tab.style.display = 'none';
  });
  shadowRoot.appendChild(tab);

  var panel = document.createElement('div');
  panel.id = 'fljs-panel';
  panel.className = 'hidden';
  panel.innerHTML =
    '<div id="fljs-head">' +
      '<b>⚡ MOYU-JS Bridge</b><span class="sub">Fill-Nodes FL JavaScript 复刻</span>' +
      '<span class="sp"></span>' +
      '<button id="fljs-collapse" title="折叠/展开">—</button>' +
      '<button id="fljs-hide" title="收到右侧边缘">✕</button>' +
    '</div>' +
    '<div id="fljs-body">' +
      '<div class="fljs-sec"><h4>① COMFYUI 实例（窗口 / iframe 探测）</h4>' +
        '<div id="fljs-instances"></div>' +
        '<div class="fljs-row"><button class="act" id="fljs-rescan">🔄 重新探测</button>' +
        '<span class="fljs-hint">每 5 秒自动探测一次</span></div>' +
      '</div>' +
      '<div class="fljs-sec"><h4>② 节点列表（点击节点 → 插入 find(id) 到编辑器）</h4>' +
        '<div class="fljs-row"><input type="text" id="fljs-nodefilter" placeholder="过滤：id / 标题 / 类型…"></div>' +
        '<div id="fljs-nodes"></div>' +
      '</div>' +
      '<div class="fljs-sec"><h4>③ JS 编辑器</h4>' +
        '<div class="fljs-row"><input type="text" id="fljs-name" placeholder="脚本名称（可选）"></div>' +
        '<div class="fljs-row"><select id="fljs-event"></select></div>' +
        '<div class="fljs-row" id="fljs-nodeid-row" style="display:none;">' +
          '<span class="fljs-hint">目标节点&nbsp;ID：</span>' +
          '<input type="text" id="fljs-nodeid" placeholder="如 9（也可在节点列表点击填入）">' +
        '</div>' +
        '<div class="fljs-row"><select id="fljs-target">' +
          '<option value="cur">目标：当前选中实例</option>' +
          '<option value="*">目标：全部实例</option>' +
        '</select></div>' +
        '<textarea id="fljs-code" spellcheck="false" placeholder="// 在此编写任意 JS 代码\n// 可用变量见「填入默认模板」"></textarea>' +
        '<div class="fljs-row" style="margin-top:6px;flex-wrap:wrap;">' +
          '<button class="act" id="fljs-template">📋 填入默认模板</button>' +
          '<button class="act" id="fljs-runonce">▶ 立即执行一次</button>' +
        '</div>' +
        '<div class="fljs-row" style="flex-wrap:wrap;">' +
          '<button class="act primary" id="fljs-add">➕ 添加为触发脚本</button>' +
          '<button class="act" id="fljs-clear">清空编辑器</button>' +
        '</div>' +
        '<div class="fljs-hint">执行上下文与原版 FL_JS 一致：find / setValues / connect / create / generate / cancel 等 40+  helper 全可用，代码内可直接 await。</div>' +
      '</div>' +
      '<div class="fljs-sec"><h4>④ 已添加脚本</h4><div id="fljs-scripts"></div></div>' +
      '<div class="fljs-sec"><h4>⑤ 执行日志</h4>' +
        '<div id="fljs-log"></div>' +
        '<div class="fljs-row" style="margin-top:6px;"><button class="act" id="fljs-clearlog">清空日志</button></div>' +
      '</div>' +
      '<div class="fljs-sec"><h4>⑥ 远程指令通道（路 B：自建指令服务器）</h4>' +
        '<div class="fljs-row"><input type="text" id="fljs-cmdurl" placeholder="wss://你的服务器/cmd"></div>' +
        '<div class="fljs-row"><input type="text" id="fljs-cmdtoken" placeholder="token（鉴权，建议填）"></div>' +
        '<div class="fljs-row"><span class="fljs-hint">本机 ID：</span>' +
        '<input type="text" id="fljs-cmdid" readonly title="服务端 to 定向投递时填这个 ID"></div>' +
        '<div class="fljs-row" style="flex-wrap:wrap;"><button class="act" id="fljs-cmdconnect">🔌 连接</button>' +
        '<button class="act" id="fljs-cmddisconnect">断开</button>' +
        '<span class="fljs-hint" id="fljs-cmdstatus">未连接</span></div>' +
        '<div class="fljs-hint">连接后服务端可下发 {"name":"run_generate"/"run_workflow","parameter":{},"other":{},' +
        '"from":[],"to":[]}；to 为空=广播，to 非空=只投递给 ID 命中的本机。' +
        '路 A（ComfyUI 服务端直发）无需配置，实例挂钩时自动启用。详见 README 与 samples/。</div>' +
      '</div>' +
    '</div>';
  shadowRoot.appendChild(panel);

  // 事件下拉框
  var evSel = $('fljs-event');
  EVENTS.forEach(function (e) {
    var o = document.createElement('option');
    o.value = e.id; o.textContent = e.label;
    evSel.appendChild(o);
  });
  evSel.addEventListener('change', function () {
    $('fljs-nodeid-row').style.display = evSel.value === 'onNodeExecuted' ? '' : 'none';
  });

  // Tab 缩进
  $('fljs-code').addEventListener('keydown', function (e) {
    if (e.key === 'Tab') {
      e.preventDefault();
      var t = e.target, s = t.selectionStart;
      t.value = t.value.slice(0, s) + '  ' + t.value.slice(t.selectionEnd);
      t.selectionStart = t.selectionEnd = s + 2;
    }
  });

  $('fljs-collapse').addEventListener('click', function () {
    var body = $('fljs-body');
    body.classList.toggle('collapsed');
    state.ui.collapsed = body.classList.contains('collapsed');
    saveState();
  });
  $('fljs-hide').addEventListener('click', function () {
    panel.classList.add('hidden');
    tab.style.display = '';
  });
  $('fljs-rescan').addEventListener('click', function () {
    var r = scanInstances();
    log('手动探测：发现 ' + r.found + ' 个 ComfyUI 实例' +
        (r.blocked ? '，' + r.blocked + ' 个跨域 iframe 不可访问' : ''), 'info');
  });
  $('fljs-nodefilter').addEventListener('input', renderNodes);
  $('fljs-template').addEventListener('click', function () {
    var inst = getSelected();
    if (!inst) { log('没有可用的 ComfyUI 实例', 'warn'); return; }
    $('fljs-code').value = makeHelpers(inst).getDefaultCommand();
  });
  $('fljs-runonce').addEventListener('click', function () {
    var inst = getSelected();
    if (!inst) { log('没有可用的 ComfyUI 实例', 'warn'); return; }
    var code = $('fljs-code').value;
    if (!code.trim()) { log('编辑器是空的', 'warn'); return; }
    var fake = { id: 'manual', name: $('fljs-name').value.trim() || '手动执行' };
    runUserCode(inst, fake, code, [], 'manual');
  });
  $('fljs-add').addEventListener('click', function () {
    var inst = getSelected();
    var code = $('fljs-code').value;
    if (!code.trim()) { log('编辑器是空的，先写点代码吧', 'warn'); return; }
    var targetSel = $('fljs-target').value;
    var target = targetSel === '*' ? '*' : (inst ? inst.key : '*');
    if (!inst) { log('没有可用的 ComfyUI 实例，脚本将绑定到「全部实例」', 'warn'); target = '*'; }
    var s = {
      id: uid(),
      name: $('fljs-name').value.trim() || ('脚本' + (state.scripts.length + 1)),
      event: evSel.value,
      nodeId: evSel.value === 'onNodeExecuted' ? $('fljs-nodeid').value.trim() : '',
      code: code,
      enabled: true,
      target: target,
    };
    state.scripts.push(s);
    saveState();
    renderScripts();
    log('已添加脚本「' + s.name + '」→ ' + s.event, 'ok');
    // 若事件需要钩子且实例已有钩子，直接可用；新实例出现时 ensureHooks 会处理
    instances.forEach(ensureHooks);
  });
  $('fljs-clear').addEventListener('click', function () {
    $('fljs-code').value = ''; $('fljs-name').value = '';
  });
  $('fljs-clearlog').addEventListener('click', function () { $('fljs-log').innerHTML = ''; });

  // ⑥ 远程指令通道（路 B）：回填已保存的配置，之前开着则自动重连
  if (state.cmd.url && $('fljs-cmdurl')) $('fljs-cmdurl').value = state.cmd.url;
  if (state.cmd.token && $('fljs-cmdtoken')) $('fljs-cmdtoken').value = state.cmd.token;
  if ($('fljs-cmdid')) $('fljs-cmdid').value = getClientId();
  $('fljs-cmdconnect').addEventListener('click', cmdConnect);
  $('fljs-cmddisconnect').addEventListener('click', function () { cmdDisconnect(false); });
  if (state.cmd.enabled && state.cmd.url) {
    cmdWantOn = true;
    openCmdSock(state.cmd.url, state.cmd.token || '');
  }

  if (state.ui.collapsed) $('fljs-body').classList.add('collapsed');
}

function updateTabBadge() {
  var dot = $q('#fljs-tab .dot');
  if (dot) dot.className = 'dot' + (instances.length ? ' on' : '');
  var tab = $('fljs-tab');
  if (tab) tab.title = instances.length
    ? 'ComfyUI MOYU-JS Bridge：检测到 ' + instances.length + ' 个实例（点击展开）'
    : 'ComfyUI MOYU-JS Bridge：未检测到 ComfyUI 实例（点击展开）';
}

/* ---------- 渲染 ---------- */

function renderInstances() {
  var box = $('fljs-instances');
  if (!box) return;
  if (!instances.length) {
    var blockedHint = '';
    if (lastBlocked.length) {
      blockedHint = '<div class="warn">检测到 ' + lastBlocked.length + ' 个跨域 iframe，浏览器安全策略禁止从本 frame 访问：' +
        escHtml(lastBlocked.join('；').slice(0, 400)) +
        '<br>若 ComfyUI 在其中，请确认脚本的 @match 已包含该 iframe 的域名（如 comfy.liblib.art），' +
        '让脚本直接注入该 frame 内部运行。</div>';
    }
    box.innerHTML = '<div class="fljs-empty">未检测到 ComfyUI 实例（当前 frame / 同源 iframe 中没有 window.app）。' +
      '若 ComfyUI 在跨域 iframe 里，浏览器安全策略禁止访问。</div>' + blockedHint;
    return;
  }
  box.innerHTML = '';
  instances.forEach(function (inst) {
    var div = document.createElement('div');
    div.className = 'fljs-inst' + (inst.key === selectedKey ? ' sel' : '');
    div.innerHTML =
      '<div><div class="t">' + escHtml(inst.label) + '</div>' +
      '<div class="u">' + escHtml(inst.url || '(url 不可读)') + '</div>' +
      (inst.apiOk ? '' : '<div class="warn">⚠ 未解析到 api：api 事件类触发不可用</div>') +
      '</div>';
    div.addEventListener('click', function () {
      selectedKey = inst.key;
      renderInstances(); renderNodes();
    });
    box.appendChild(div);
  });
}

function getNodeList(inst) {
  var list = [];
  try {
    app_graph_nodes(inst).forEach(function (n) {
      list.push({
        id: n.id,
        title: n.title || n.type || ('#' + n.id),
        type: n.comfyClass || n.type || '',
      });
    });
  } catch (e) {}
  return list;
}
function app_graph_nodes(inst) {
  return inst.app.graph._nodes;
}

function renderNodes() {
  var box = $('fljs-nodes');
  if (!box) return;
  var inst = getSelected();
  if (!inst) { box.innerHTML = '<div class="fljs-empty">—</div>'; return; }
  var q = ($('fljs-nodefilter').value || '').toLowerCase();
  var list = getNodeList(inst).filter(function (n) {
    return !q || String(n.id).includes(q) ||
      n.title.toLowerCase().includes(q) || n.type.toLowerCase().includes(q);
  });
  if (!list.length) { box.innerHTML = '<div class="fljs-empty">无匹配节点</div>'; return; }
  box.innerHTML = '';
  list.slice(0, 300).forEach(function (n) {
    var div = document.createElement('div');
    div.className = 'fljs-node';
    div.innerHTML = '<span class="nid">#' + escHtml(n.id) + '</span>' +
      '<span>' + escHtml(n.title) + '</span>' +
      '<span class="ntype">' + escHtml(n.type) + '</span>';
    div.title = '点击插入 find(' + n.id + ')';
    div.addEventListener('click', function () {
      var ed = $('fljs-code');
      var snippet = 'var n' + n.id + ' = find(' + n.id + '); // ' + n.title + '\n';
      var s = ed.selectionStart || 0;
      ed.value = ed.value.slice(0, s) + snippet + ed.value.slice(ed.selectionEnd || s);
      ed.focus();
      // 若正在配置 onNodeExecuted，顺手把节点 ID 填入目标框
      var row = $('fljs-nodeid-row');
      if (row && row.style.display !== 'none') $('fljs-nodeid').value = n.id;
    });
    box.appendChild(div);
  });
  if (list.length > 300) {
    var more = document.createElement('div');
    more.className = 'fljs-empty';
    more.textContent = '…还有 ' + (list.length - 300) + ' 个节点（用上方过滤缩小范围）';
    box.appendChild(more);
  }
}

function eventLabel(id) {
  var e = EVENTS.find(function (x) { return x.id === id; });
  return e ? e.label : id;
}

function renderScripts() {
  var box = $('fljs-scripts');
  if (!box) return;
  if (!state.scripts.length) {
    box.innerHTML = '<div class="fljs-empty">还没有脚本。在上方编辑器写代码，选好触发时机后点「添加为触发脚本」。</div>';
    return;
  }
  box.innerHTML = '';
  state.scripts.forEach(function (s) {
    var div = document.createElement('div');
    div.className = 'fljs-script';
    var targetName = s.target === '*' ? '全部实例'
      : (getInstance(s.target) ? getInstance(s.target).label : '实例已消失');
    div.innerHTML =
      '<span class="nm">' + escHtml(s.name) + '</span>' +
      '<span class="ev' + (s.enabled ? '' : ' off') + '">' + escHtml(eventLabel(s.event)) + '</span>' +
      '<div class="tg">目标：' + escHtml(targetName) +
      (s.event === 'onNodeExecuted' ? ' · 节点 #' + escHtml(s.nodeId || '?') : '') +
      ' · ' + (s.enabled ? '已启用' : '已停用') +
      ' · ' + s.code.length + ' 字符</div>' +
      '<div class="ops"></div>';
    var ops = div.querySelector('.ops');

    function mkBtn(text, fn) {
      var b = document.createElement('button');
      b.textContent = text;
      b.addEventListener('click', function (ev) { ev.stopPropagation(); fn(); });
      ops.appendChild(b);
    }
    mkBtn(s.enabled ? '⏸ 停用' : '▶ 启用', function () {
      s.enabled = !s.enabled; saveState(); renderScripts();
    });
    mkBtn('▶ 执行一次', function () {
      var inst = s.target === '*' ? getSelected() : (getInstance(s.target) || getSelected());
      if (!inst) { log('没有可用的 ComfyUI 实例', 'warn'); return; }
      runUserCode(inst, s, s.code, [], 'manual');
    });
    mkBtn('✏ 编辑', function () {
      $('fljs-name').value = s.name;
      $('fljs-event').value = s.event;
      $('fljs-nodeid').value = s.nodeId || '';
      $('fljs-nodeid-row').style.display = s.event === 'onNodeExecuted' ? '' : 'none';
      $('fljs-target').value = s.target === '*' ? '*' : 'cur';
      $('fljs-code').value = s.code;
      $('fljs-code').focus();
      log('已将「' + s.name + '」载入编辑器（改完后重新添加，或删掉旧条目）', 'info');
    });
    mkBtn('🗑 删除', function () {
      state.scripts = state.scripts.filter(function (x) { return x.id !== s.id; });
      delete memStates[s.id];
      saveState(); renderScripts();
    });
    box.appendChild(div);
  });
}

function log(msg, type) {
  type = type || 'info';
  try { console.log('[MOYU-JS][' + type + ']', msg); } catch (e) {}
  var box = $('fljs-log');
  if (!box) return;
  var line = document.createElement('div');
  line.className = type;
  line.textContent = '[' + now2() + '] ' + String(msg).slice(0, 2000);
  box.appendChild(line);
  while (box.children.length > 300) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

/* ============================== 启动 ============================== */

function boot() {
  buildUI();
  renderScripts();
  var r = scanInstances();
  log('MOYU-JS Bridge 已加载。' +
      (r.found ? '检测到 ' + r.found + ' 个 ComfyUI 实例。' : '当前页面未检测到 ComfyUI 实例。') +
      ' 参考实现：filliptm/ComfyUI_Fill-Nodes（FL JavaScript 节点）', 'info');

  // 重扫调度：防重入 + 防抖。
  // 注意：renderInstances/renderNodes 每次都会重写面板 DOM，若 observer 不过滤，
  // 就会形成"扫描→渲染→mutation→再扫描"的自激循环，微任务队列永不排空，页面直接卡死。
  var scanning = false;
  var scanTimer = null;
  function safeScan() {
    if (scanning) return;
    scanning = true;
    try {
      var before = instances.map(function (x) { return x.key; }).join('|');
      scanInstances();
      var after = instances.map(function (x) { return x.key; }).join('|');
      if (before !== after) {
        log('实例变化：' + (instances.length ? instances.map(function (x) { return x.label; }).join('；') : '无'), 'info');
      }
    } finally {
      scanning = false;
    }
  }
  function scheduleScan(delay) {
    if (scanTimer) return;
    scanTimer = setTimeout(function () {
      scanTimer = null;
      safeScan();
    }, delay == null ? 400 : delay);
  }

  // 定期重扫（iframe 懒加载 / ComfyUI 后启动的情况）
  setInterval(safeScan, 5000);

  // 只在 iframe 增删时立刻重扫；面板自身及页面其他 DOM 变化一律忽略
  try {
    var mo = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        var nodes = [];
        for (var a = 0; a < m.addedNodes.length; a++) nodes.push(m.addedNodes[a]);
        for (var r = 0; r < m.removedNodes.length; r++) nodes.push(m.removedNodes[r]);
        for (var n = 0; n < nodes.length; n++) {
          var el = nodes[n];
          if (el && el.nodeType === 1 &&
              (el.tagName === 'IFRAME' || (el.querySelector && el.querySelector('iframe')))) {
            scheduleScan(400);
            return;
          }
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

})();
