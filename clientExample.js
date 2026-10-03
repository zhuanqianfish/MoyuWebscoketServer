/**
 * ComfyUI → Moyu 图片中转站（Python WebSocket 服务端）
 * ====================================================
 *
 * 把节点里的 base64 图片推到本地 Python 服务端，由服务端转发给网页客户端显示 / 保存。
 *
 * 【本版本解决的核心问题】
 *   原版每次运行都 `new WebSocket(wsUrl)`，发完立刻 `ws.close()`。
 *   ComfyUI 每跑一次工作流就执行一遍本脚本，于是：
 *     - 连接被反复创建 / 关闭，TIME_WAIT 累积，极易耗尽本地端口
 *     - 每次都要重新握手（TCP + WebSocket 升级），慢且不稳
 *     - 大量 "连接失败" 噪音，掩盖真正的错误
 *
 *   现在改成：把连接挂在 globalThis 上做单例复用。
 *     - 连接已就绪 → 直接 send，零握手开销
 *     - 正在连接 → 排队等 open 后再发
 *     - 已断开   → 自动重建（带退避重试）
 *   连接不再主动关闭，保持长连接，由服务端心跳维持。
 *
 * 【整个脚本包在 IIFE 里】
 *   这样重复执行不会因为 `const HOST` 之类重复声明而抛
 *   "Identifier has already been declared"。
 *   需要对外暴露的函数会挂到 globalThis 上（见文件末尾）。
 *
 * 【ComfyUI 使用说明】
 *   本脚本应放在能重复执行的位置（如「执行某个节点前后」的自定义节点、
 *   或提示词节点的脚本区域）。反复运行不会重复建连接。
 *
 * 【手动调用】
 *   moyuSend(base64Data, '可选标签')
 */

(function () {
'use strict';

// ===================== 连接配置 =====================
const HOST = '127.0.0.1';
const PORT = 8001;

// 客户端标识：服务端会在网页端「已连接客户端」列表里显示这个名字
const CLIENT_NAME = 'ComfyUI';

// 心跳间隔（毫秒）。服务端 30s 无消息会判定超时，这里留足余量
const HEARTBEAT_MS = 20000;

// 重连退避序列（毫秒）
const RETRY_STEPS = [1000, 2000, 4000, 8000, 15000];

// 全局键名。挂到 globalThis 是因为 ComfyUI 每次都会重新执行本脚本，
// 只有 globalThis 上的属性能跨次执行存活。
const KEY = '__moyuWsManager';

// ===================== 连接管理器（单例） =====================

/**
 * 读取（或首次创建）全局连接管理器。
 * 整个模块共用一个实例，跨脚本执行复用。
 */
function getManager() {
    let mgr = globalThis[KEY];
    if (mgr && mgr.url === buildUrl()) {
        return mgr;
    }

    // URL 变了（用户改了端口）→ 丢弃旧连接，用新 URL 重建
    if (mgr) {
        try { mgr.ws && mgr.ws.close(); } catch (e) { /* 忽略 */ }
    }

    mgr = {
        url: buildUrl(),
        ws: null,
        opened: false,
        retry: 0,
        timer: null,
        heartbeat: null,
        queue: [],       // 等待连接就绪时排队的消息
        retrying: false, // 是否正在退避等待重连
    };
    globalThis[KEY] = mgr;
    return mgr;
}

function buildUrl() {
    return `ws://${HOST}:${PORT}?client=${encodeURIComponent(CLIENT_NAME)}`;
}

/**
 * 拿到一个可用的 WebSocket：能复用就复用，否则建新的。
 * @returns {WebSocket}
 */
function ensureSocket() {
    const mgr = getManager();

    // 1) 已连接 —— 直接复用，这正是本脚本要做的优化
    if (mgr.ws && mgr.ws.readyState === WebSocket.OPEN) {
        mgr.retry = 0;
        return mgr.ws;
    }

    // 2) 正在连接 —— 复用这个即将就绪的连接
    if (mgr.ws && mgr.ws.readyState === WebSocket.CONNECTING) {
        return mgr.ws;
    }

    // 3) 已关闭或不存在 —— 新建
    return openSocket(mgr);
}

function openSocket(mgr) {
    clearTimeout(mgr.timer);
    mgr.timer = null;

    let ws;
    try {
        ws = new WebSocket(mgr.url);
    } catch (err) {
        console.warn('[WebSocket] 创建连接失败：', err);
        scheduleRetry(mgr);
        return null;
    }

    mgr.ws = ws;

    ws.onopen = function () {
        mgr.opened = true;
        mgr.retry = 0;
        console.log(`[WebSocket] 已连接 ${mgr.url}`);

        // 把连接期间排队的消息一次性发出去
        const pending = mgr.queue.splice(0, mgr.queue.length);
        pending.forEach((msg) => safeSend(ws, msg));

        startHeartbeat(mgr);
    };

    ws.onmessage = function (evt) {
        let data;
        try {
            data = JSON.parse(evt.data);
        } catch (e) {
            return;
        }

        if (data.type === 'ack' && data.ok) {
            console.log(`[WebSocket] ✅ 服务端已接收：${data.filename}（${formatSize(data.size)}）`);
        } else if (data.type === 'error') {
            console.error('[WebSocket] ❌ 服务端报错：', data.message);
        } else if (data.type === 'welcome') {
            // 服务端告诉我们这是一个「同名顶替」的旧连接（复用检测）
            if (data.reused) {
                console.log('[WebSocket] 已顶替同名旧连接');
            }
        }
    };

    ws.onerror = function () {
        // onerror 之后一定会有 onclose，重连逻辑统一放在 onclose
        console.warn('[WebSocket] 连接出错');
    };

    ws.onclose = function (evt) {
        mgr.opened = false;
        stopHeartbeat(mgr);
        mgr.ws = null;
        // 非主动关闭（1000）视为异常断开 → 退避重连
        if (evt.code !== 1000) {
            scheduleRetry(mgr);
        }
    };

    return ws;
}

/** 退避重连，避免服务端没起来时疯狂重试刷屏 */
function scheduleRetry(mgr) {
    if (mgr.retrying) return;
    mgr.retrying = true;

    const wait = RETRY_STEPS[Math.min(mgr.retry, RETRY_STEPS.length - 1)];
    mgr.retry += 1;
    console.warn(`[WebSocket] 连接已断开，${wait / 1000}s 后重连（第 ${mgr.retry} 次）`);

    mgr.timer = setTimeout(function () {
        mgr.retrying = false;
        mgr.timer = null;
        // 若期间已有新连接，放弃本次重连
        if (!mgr.ws || mgr.ws.readyState === WebSocket.CLOSED) {
            openSocket(mgr);
        }
    }, wait);
}

/** 心跳：既保活，也及时发现服务端已死 */
function startHeartbeat(mgr) {
    stopHeartbeat(mgr);
    mgr.heartbeat = setInterval(function () {
        if (mgr.ws && mgr.ws.readyState === WebSocket.OPEN) {
            safeSend(mgr.ws, JSON.stringify({ type: 'ping' }));
        } else {
            stopHeartbeat(mgr);
        }
    }, HEARTBEAT_MS);
}

function stopHeartbeat(mgr) {
    if (mgr.heartbeat) {
        clearInterval(mgr.heartbeat);
        mgr.heartbeat = null;
    }
}

function safeSend(ws, payload) {
    try {
        ws.send(payload);
        return true;
    } catch (err) {
        console.warn('[WebSocket] 发送失败：', err);
        return false;
    }
}

function formatSize(n) {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
}

// ===================== 对外发送接口 =====================

/**
 * 发送 base64 图片。连接不存在时自动建立并排队，不会丢图。
 *
 * @param {string} base64Data  图片 base64（纯串或 data URI 都行）
 * @param {string} label       可选标签，会作为网页端显示的图片标题
 * @returns {boolean} 是否已交付出发送（不代表服务端已落盘）
 */
function moyuSend(base64Data, label) {
    if (!base64Data || String(base64Data).trim() === '') {
        console.log('[WebSocket] 无 Base64 数据，跳过发送');
        return false;
    }

    const mgr = getManager();
    const payload = JSON.stringify({
        image: base64Data,
        label: label || '',
    });

    const ws = ensureSocket();
    if (!ws) {
        // 连创建都失败了，排进队列，等重连成功后自动补发
        mgr.queue.push(payload);
        return false;
    }

    if (ws.readyState === WebSocket.OPEN) {
        return safeSend(ws, payload);
    }

    // CONNECTING：等 onopen 里 flush 队列
    mgr.queue.push(payload);
    console.log('[WebSocket] 连接建立中，已排队等待发送');
    return false;
}

// ===================== ComfyUI 节点索引 =====================
// 保留原脚本里 find() 出来的节点引用，按需取用。
var n7 = find(7); // CLIP Text Encode (Prompt)
var n101 = find(101); // TextEncodeQwenImageEditPlus
var n103 = find(103); // Load Image
var n104 = find(104); // LayerUtility: ImageScaleByAspectRatio V2
var n118 = find(118); // Load LoRA
var n119 = find(119); // Load CLIP
var n120 = find(120); // Load Diffusion Model
var n121 = find(121); // Load VAE
var n123 = find(123); // Empty Latent Image
var n124 = find(124); // ModelSamplingAuraFlow
var n125 = find(125); // KSampler
var n126 = find(126); // VAE Decode
var n127 = find(127); // Preview Image
var n131 = find(131); // LayerUtility: Image Reel
var n132 = find(132); // LayerUtility: Image Reel Composit
var n142 = find(142); // Load Diffusion Model
var n167 = find(167); // Show Any
var n168 = find(168); // Show Any
var n169 = find(169); // Upscale Image By
var n170 = find(170); // 🔧 Image Resize
var n171 = find(171); // 🔧 Get Image Size
var n172 = find(172); // TTP_Image_Assy
var n173 = find(173); // SeedVR2 (Down)Load DiT Model
var n174 = find(174); // SeedVR2 (Down)Load VAE Model
var n175 = find(175); // Note
var n176 = find(176); // 🔧 Image Resize
var n177 = find(177); // Show Any
var n178 = find(178); // Show Any
var n179 = find(179); // 🔧 Get Image Size
var n180 = find(180); // TTP_Image_Tile_Batch
var n181 = find(181); // TTP_Tile_image_size
var n182 = find(182); // Upscale Image By
var n183 = find(183); // Clean VRAM Used
var n184 = find(184); // 高质量图片压缩
var n185 = find(185); // SeedVR2 Video Upscaler (v2.5.15)
var n188 = find(188); // Save Image
var n189 = find(189); // Save Image
var n191 = find(191); // Preview Image
var n192 = find(192); // Float
var n193 = find(193); // Image Comparer (rgthree)
var n195 = find(195); // 鸭鸭图 SuperSecureMediaProtection媒体内容保护 编码V1.2
var n196 = find(196); // Save Image
var n197 = find(197); // Load Image
var n198 = find(198); // PlaySound 🐍
var n199 = find(199); // Image To Base64
var n200 = find(200); // Save Text
var n201 = find(201); // PlaySound 🐍
var n204 = find(204); // EasySeed
var n205 = find(205); // LATENT WebSocket Sender @ vrch.ai
var n206 = find(206); // PlaySound 🐍
var n208 = find(208); // PlaySound 🐍

// ===================== ComfyUI 原有逻辑 =====================
// ↓↓↓ 按实际情况修改 ↓↓↓
var base64Data = n208.widgets[0].inputEl.value;  // 从哪个节点读 base64

// 想让网页端显示一个好认的标题，就填节点名，例如 'TextEncodeQwenImageEditPlus'
var imageLabel = 'Image To Base64';

// 执行发送（内部自动复用连接，不会每次都 new WebSocket）
moyuSend(base64Data, imageLabel);

// ===================== 额外工具（按需使用） =====================

/**
 * 手动发送指定节点的 base64。
 * 例如：moyuSendFrom(find(199).widgets[0].inputEl.value, '我的出图')
 */
function moyuSendFrom(base64Data, label) {
    return moyuSend(base64Data, label);
}

/** 关闭长连接（一般不需要，除非想主动断开） */
function moyuDisconnect() {
    const mgr = globalThis[KEY];
    if (!mgr) return;
    clearTimeout(mgr.timer);
    stopHeartbeat(mgr);
    if (mgr.ws) {
        // 用 1000 正常关闭码，onclose 里不会触发重连
        mgr.ws.close(1000, 'client disconnect');
    }
    mgr.ws = null;
    mgr.opened = false;
    console.log('[WebSocket] 已主动断开');
}

/** 查看当前连接状态（调试用） */
function moyuStatus() {
    const mgr = globalThis[KEY];
    if (!mgr) return { state: '未初始化' };
    const states = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
    return {
        state: states[mgr.ws ? mgr.ws.readyState : 3],
        url: mgr.url,
        queued: mgr.queue.length,
        retries: mgr.retry,
        reusedConnection: Boolean(mgr.opened),
    };
}

// ===================== 导出到全局 =====================
// 挂到 globalThis，这样重复执行本脚本不会重复声明，
// 同时其他脚本区域也能直接调用 moyuSend(...)
Object.assign(globalThis, {
    moyuSend,
    moyuSendFrom,
    moyuDisconnect,
    moyuStatus,
});

})();