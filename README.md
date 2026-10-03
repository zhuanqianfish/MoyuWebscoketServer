# 摸鱼图片中转站（Moyu WebSocket Server）

一个 Python 写的 WebSocket 图片中转服务：**ComfyUI 出图 → 服务端接收 → 网页实时看图 → 一键保存**，
外加一套**指令服务器**，可在网页上向指定客户端下发 JSON 指令（含运行工作流）。

```
ComfyUI (clientExample.js)                Python 服务端                 网页客户端
   base64 图片  ────ws://8801────▶  解码 / 落盘 / 建索引  ──ws──▶  实时上墙
                                        │                    ──▶   点开放大
                                        │                    ──▶   指令服务器（下发指令）
                                        └── saved_images/    ──▶   下载 / 打包 ZIP
```

---

## 快速开始

**Windows**：双击 `run.bat`

**macOS / Linux**：

```bash
chmod +x run.sh && ./run.sh
```

两个脚本都会自动探测 Python、检查 `aiohttp` 依赖（缺了自动装）、提示端口占用，然后启动服务并打开浏览器。已有 `.venv` 会优先使用。

也可以手动启动：

```bash
pip install -r requirements.txt
python server.py --open-browser
```

跑通整条链路（不用开 ComfyUI）：

```bash
python tools/test_client.py --count 5 --interval 1
```

自检（共 236 项）：

```bash
python tools/verify.py            # 后端 17 项：HTTP + WebSocket + 落盘一致性
python tools/verify_clients.py    # 客户端列表 29 项：登记/注销/计数/广播
python tools/verify_command.py    # 指令功能 56 项：转发/服务端执行/工作流指令
node tools/verify_frontend.js     # 前端 105 项：渲染/排序/灯箱/客户端面板/Tab/指令面板
node tools/verify_ws_reuse.js     # 连接复用 28 项：重连/排队/心跳（ComfyUI 场景）
```

---

## 端口说明

**单端口 8801**，三种流量共用（换端口只需改 `--port` 和 `clientExample.js` 的 `PORT`）：

| 路径 | 协议 | 用途 |
|------|------|------|
| `/` | WebSocket | ComfyUI 推送端（`clientExample.js` 连这里） |
| `/web` | HTTP | 网页 UI（浏览器直接打开；访问 `/` 会自动跳转过来） |
| `/ws` | WebSocket | 网页客户端自己的实时通道 |
| `/api/*` `/media/*` `/download/*` | HTTP | 接口、图片读取与下载 |

> 旧版的 `--ws-port` / `--http-port` 已合并为 `--port`，仍传入只会提示被忽略。

---

## ComfyUI 侧接入

`clientExample.js` 原样可用 —— 服务端兼容它的报文格式：

```js
const payload = JSON.stringify({ image: base64Data });
new WebSocket('ws://127.0.0.1:8001').send(payload);
```

### 连接复用（重要）

**反复运行工作流时不要每次 `new WebSocket()`。** 否则每次执行都要重新握手，
连接频繁创建/关闭还会累积 TIME_WAIT，容易耗尽本地端口，失败噪音也会掩盖真正的错误。

本仓库的 `clientExample.js` 已改成把连接挂在 `globalThis` 上做单例复用：

- 连接已就绪 → 直接 `send`，零握手开销
- 正在连接 → 消息排队，`open` 后自动补发（不丢图）
- 异常断开 → 按 1s/2s/4s/8s/15s 退避自动重连
- 20s 心跳保活

```js
// 脚本区域（可安全重复执行）
moyuSend(base64Data, '可选标签');   // 发图，自动复用连接
moyuStatus();                        // { state:'OPEN', reusedConnection:true, ... }
moyuDisconnect();                    // 一般不需要，除非想主动断开
```

服务端接受的情况比标准用法更宽松：

| 你发什么 | 服务端行为 |
|----------|-----------|
| `{"image": "<base64>"}` | ✅ 标准用法 |
| `{"image": "...", "label": "人像"}` | ✅ 带标签，网页端会显示 nicer 的名字 |
| `{"images": [...]}` / `{"data": ...}` / `{"image_base64": ...}` | ✅ 字段名容错 |
| `["<base64>"]`（数组） | ✅ 取第一个 |
| 裸 base64（不带 JSON） | ✅ |
| `data:image/png;base64,xxx` | ✅ 自动剥离 data URI 前缀 |
| 含换行/空格的 base64 | ✅ 自动清理并补 padding |
| **二进制帧**（原始图片字节） | ✅ 直接落盘 |
| `{"type":"ping"}` | ✅ 回 `pong` |

推送成功会收到回执：

```json
{"type":"ack","ok":true,"filename":"20261003-我的图-a1b2.png","size":173995}
```

---

## 指令服务器

网页第一个 tab（默认打开）就是**指令服务器**，第二个 tab 是推送图片。

### 指令格式

```json
{
  "name": "run_workflow",
  "parameter": { "workflow": { "last_node_id": 3, "nodes": [] } },
  "other": { "source": "imported" },
  "from": ["server"],
  "to": ["客户端id或名字"]
}
```

| 字段 | 说明 |
|------|------|
| `name` | 指令名，决定客户端做什么 |
| `parameter` | 指令参数（JSON 对象） |
| `other` | 透传字段，服务端不解释 |
| `from` | 发送方。本服务器发出时固定为 `["server"]` |
| `to` | 接收方。填客户端 **id 或名字**（名字可匹配多个）；**留空 = 由服务端执行** |

> **指令是平铺的** —— 顶层直接就是上面这些字段，不会再包一层 `command`。
> 接收端三种形态都认：平铺、`{"type":"command","command":{...}}` 信封、
> 以及没有 `type` 但有 `name` 的裸指令。
> 另：`{"image": "<base64>", "name": "标签"}` 仍然是合法的推图格式，
> 服务端会优先当图片处理 —— `name` 不会误触发指令。
>
> 指令日志 / 执行回执只发到网页端，推送端只会收到真正要执行的指令。

### 路由规则

| 情况 | 行为 |
|------|------|
| 网页端发出、`to` 非空 | 转发给选中的客户端，回执送达数量 |
| 网页端发出、`to` 为空（点「仅服务端执行」） | 服务端执行内置指令 |
| 客户端发来、`to` 非空 | 转发给指定客户端 |
| 客户端发来、**无 `to`** | 视为请求服务端执行内置指令 |
| 目标不在线 / 未知指令 | 回执 `ok:false` 并说明原因（不会静默失败） |

### 服务端内置指令

不带 `to` 的指令会命中这些处理器：

| 指令 | 作用 |
|------|------|
| `ping` | 连通性测试，返回 `pong` 与时间戳 |
| `echo` | 原样返回 `parameter` / `other`，用于验证链路 |
| `stats` | 返回统计信息 |
| `clients` | 返回在线客户端列表 |
| `history` | 返回历史图片（`parameter.limit` 控制条数） |
| `broadcast` | 把 `parameter.payload` 广播给所有客户端（调试用） |

要加自己的服务端指令，在 `MoyuServer._server_commands` 里注册即可。

### 客户端侧指令

`clientExample.js` 内置处理两个工作流指令：

| 指令名 | 行为 |
|--------|------|
| `run_current_workflow` | 执行客户端当前画布上的工作流 |
| `run_workflow` | 先载入 `parameter.workflow`，再执行 |

自定义指令：

```js
globalThis.moyuCommandRegistry['my_cmd'] = (param, cmd) => {
  console.log('收到自定义指令', param);
  return '执行完成';   // 返回值会作为回执发回网页端
};
```

客户端执行完会发 `command_result`，网页端指令日志里能看到结果。

### 工作流区

- **导入 JSON 文件** 或直接粘贴 ComfyUI 工作流，实时显示节点数与体积
- **▶ 运行当前工作流** —— 让选中客户端执行它自己画布上的工作流（不传 JSON）
- **⏬ 运行导入的工作流** —— 把面板里的 JSON 一并下发，客户端载入后执行
- 格式错误会即时标红并阻止发送

> 两个按钮都要求先在「to」里勾选目标客户端。

> 建议：把 `label` 设成 ComfyUI 节点名（如 `"TextEncodeQwenImageEditPlus"`），
> 网页端会用它当图片标题，也方便在客户端列表里区分是谁在推图。

---

## 网页客户端功能

打开 `http://127.0.0.1:8801/web`，两个 tab：

**Tab 1 · 指令服务器**（默认）

- **发送指令** —— 填 name / parameter / other，`from` 固定 `server`，在「to」里多选目标客户端，附 JSON 实时预览
- **仅服务端执行** —— 清空 `to` 直接让服务端执行内置指令
- **工作流** —— 导入/粘贴 JSON，显示节点数与体积；一键让选中客户端运行当前工作流或导入的工作流
- **指令日志** —— 记录发出/转发/执行/回执，非指令页时 tab 上有未读角标

**Tab 2 · 推送图片**

- **实时上墙** —— ComfyUI 一出图立刻出现，带 `NEW` 角标和入场动画，无需刷新
- **图片墙** —— 自适应网格，懒加载；可按「最新 / 最早 / 体积」排序
- **仅看新图** —— 过滤出本次会话期间收到的图
- **灯箱查看** —— 点任意图放大，`←/→` 翻页、`Esc` 关闭
- **保存图片** —— 悬停卡片点 `⬇` 单张下载
- **打包保存** —— `⬇ 打包保存` 把当前可见图片打成 ZIP（浏览器本地生成，不占服务端内存）
- **删除 / 清空** —— 同步删掉服务器上的文件
- **状态栏** —— 已收张数、网页窗口数、推送端数、占用空间、运行时长
- **在线客户端列表** —— 点顶栏 `👥` 展开：谁在线、IP、连接时间、在线时长；推送端还显示已推图片数。自己的窗口标「我」，面板底部可改名
- **连接状态** —— 断线自动重连（退避 0.8s → 8s），顶部圆点实时反映
- **新图提示** —— Toast 通知 + WebAudio 合成提示音（可关）

客户端名单在有人连上/断开、以及推送计数变化时自动实时更新。

---

## 命令行参数

```bash
python server.py [选项]
```

| 参数 | 默认 | 说明 |
|------|------|------|
| `--host` | `127.0.0.1` | 监听地址。**局域网访问/手机看图改 `0.0.0.0`** |
| `--port` | `8801` | 服务端口（推送 `/`、网页 `/web`、网页端 WS `/ws` 共用） |
| `--save-dir` | `./saved_images` | 图片保存目录 |
| `--no-save` | 关 | 不落盘，只实时转发（此时无法保存图片） |
| `--history-limit` | `500` | 保留多少张，超出自动删最旧的**及其文件** |
| `--max-msg-size` | `64MB` | 单条消息上限 |
| `--open-browser` | 关 | 启动后自动开网页 |

常用组合：

```bash
# 局域网 / 手机同看
python server.py --host 0.0.0.0
# → 手机浏览器打开 http://<你电脑内网IP>:8801/web

# 存到 D 盘且只留最近 100 张
python server.py --save-dir D:/Pictures/moyu --history-limit 100
```

---

## HTTP 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 网页 UI |
| GET | `/api/history?limit=200` | 历史图片列表（元数据） |
| GET | `/api/stats` | 统计信息 |
| GET | `/api/clients` | 在线客户端列表 |
| GET | `/media/{id}` | 图片内容（带长缓存） |
| GET | `/download/{id}` | 下载图片（`Content-Disposition: attachment`） |
| DELETE | `/api/history/{id}` | 删除单张（连文件一起删） |
| POST | `/api/clear` | 清空全部历史 |
| WS | `/ws` | 网页端实时推送 |
| WS | `:8001` | ComfyUI 推送端（可用 `?client=名字` 自报身份） |

`stats` 字段：`images` / `bytes` / `clients`（网页窗口） / `web_clients` /
`sender_clients`（推送端） / `total_clients` / `uptime` / `saving` / `save_dir`。

---

## 项目结构

```
MoyuWebscoketServer/
├── server.py               # 服务端主体（WS 收图 + HTTP 服务 + 图片仓库 + 客户端登记）
├── run.bat                 # Windows 一键启动（探测 Python / 装依赖 / 查端口）
├── run.sh                  # macOS / Linux 一键启动
├── requirements.txt
├── clientExample.js        # ComfyUI 侧示例（连接复用 + 指令处理）
├── 开发说明.txt
├── webpageClient/          # 网页客户端
│   ├── index.html          #   结构（指令服务器 tab + 推送图片 tab + 客户端面板）
│   ├── style.css           #   暗色 + 撞色 UI
│   └── app.js              #   WS 接收 / Tab / 指令面板 / 画廊 / 灯箱 / ZIP
├── tools/
│   ├── test_client.py       # 模拟 ComfyUI 推图（含纯代码生成测试图）
│   ├── verify.py            # 后端端到端自检（17 项）
│   ├── verify_clients.py    # 客户端列表自检（29 项）
│   ├── verify_command.py    # 指令功能自检（56 项）
│   ├── verify_frontend.js   # 前端逻辑离线校验（105 项，DOM 桩）
│   ├── verify_ws_reuse.js   # 连接复用逻辑测试（28 项，桩 WebSocket）
│   ├── gen_run_bat.py       # 字节级生成 run.bat（UTF-8 无 BOM + 全 CRLF）
│   └── shot.js              # 无头 Chrome 截图（开发期核对 UI）
└── saved_images/           # 图片落盘目录（自动创建）
```

---

## 实现要点

**单端口靠请求头分流** —— `/` 上带 `Upgrade: websocket` 的走推送通道，
普通浏览器请求则 302 到 `/web`。两个 App 合并成一个，端口冲突问题从根上消失。

**指令路由先看 `to`** —— 有 `to` 就是转发（按 id 精确匹配，未命中再按名字），
没有就是请求服务端执行。未知指令 / 目标不在线都明确回执 `ok:false`，
不会静默失败；指令异常也只影响这一条，不会拖垮连接。

**图片落盘用线程池** —— `write_bytes` 丢进 `asyncio.to_thread`，
不让磁盘 IO 阻塞事件循环，否则大图批量推送时会卡住整个广播。

**每个连接一把发送锁** —— aiohttp 不允许对同一个 socket 并发 `send_str`。
「有人断开」和「有人接入」会同时触发广播，必须按连接串行化，
否则连接会被直接打断（客户端表现为刚连上就断）。

**文件名安全化** —— 标签里的路径分隔符、特殊字符统一过滤，
日期 + 短随机串避免重名，重名再自动加序号。

**客户端名保留 Unicode** —— 文件名走 ASCII 白名单清洗，
但客户端显示名只剔除控制字符和路径分隔符，中文名必须原样显示。

**格式识别不靠扩展名** —— 直接读文件头魔数判 PNG/JPEG/GIF/BMP/WEBP，
ComfyUI 给什么格式就存什么格式。

**run.bat 必须字节级生成** —— 批处理要求 CRLF 换行且不能带 BOM，
Write 工具落盘的 UTF-8+LF 会让 `cmd.exe` 双击闪退，
所以改启动脚本一律走 `tools/gen_run_bat.py`。

**尺寸读取双通道** —— 有 Pillow 就用 Pillow，没有就退回手写 PNG/GIF/BMP 头解析，
所以 Pillow 只是可选增强，不是硬依赖。

**历史裁剪联动删文件** —— 超过 `--history-limit` 时，
内存索引和磁盘文件一起清理，不会留下孤儿文件。

**浏览器端 ZIP** —— 用 File System Access API 在本地打包（store 模式手写 ZIP 头），
服务端不需要为打包占内存。不支持的浏览器则退回逐张下载。

---

## 常见问题

**Q：网页一直显示「连接中」**
A：确认服务端窗口没被 Ctrl+C 掉。浏览器会自动重连，服务端起来后无需刷新。

**Q：ComfyUI 报「WebSocket 连接失败」**
A：8801 端口被占用。换个端口：`python server.py --port 9001`，
然后同步改 `clientExample.js` 里的 `PORT`。

**Q：图片不落盘**
A：检查是否加了 `--no-save`；另外服务端是**内存索引**，
重启后历史列表为空但**磁盘文件还在** —— 新推送的图片会重新建立索引。

**Q：手机连不上**
A：服务默认只听 `127.0.0.1`，必须 `--host 0.0.0.0`；
还要确认 Windows 防火墙放行了 8801。

**Q：能同时开多个网页窗口吗**
A：可以，多个窗口都会收到广播。点顶栏 `👥` 能看到所有在线客户端，
自己的窗口标「我」，面板底部可以给自己改名。

**Q：ComfyUI 跑了很多次之后连不上 / 报连接失败**
A：多半是旧写法每次 `new WebSocket()` 导致的端口耗尽。
改用本仓库的 `clientExample.js`（已做连接复用），或至少自己加个连接缓存。

**Q：客户端列表里没有 ComfyUI**
A：推送端要连 8801 端口才能被登记。如果用 `?client=名字` 自报身份，
名字会显示在列表里；不传则自动生成 `ComfyUI-xxxx`。

**Q：点了「运行工作流」客户端没反应**
A：看指令日志 —— 两条日志能定位卡在哪：
- `已送达 N 个：xxx · 等待回执…` → 服务端投递成功，**客户端还没回执**
- 什么都没有 → 指令没发出去（检查 `to` 里的 id 是否在线）

若一直停在「等待回执」，说明客户端收到了但没处理。跑探针确认：

```bash
python tools/probe_command.py            # 探测所有推送端
python tools/probe_command.py <客户端id>  # 只探测指定客户端
```

探针会明确告诉你是「没收到」还是「收到了没回执」。常见原因：
① ComfyUI 侧没有加载本仓库的 `clientExample.js`（旧脚本不处理指令）；
② 客户端没重新加载最新脚本；
③ 客户端把消息路由到了别处。
**快速验证**：发一条 `name=whoami` 的指令，会回执的客户端就说明通道已通。

> 客户端 UA 显示 `Mozilla/...` 通常意味着它是浏览器里的页面（油猴脚本等），
> 而不是 ComfyUI 节点 —— 这类客户端需要自己实现指令处理与回执。

**Q：指令发出去提示「未知服务端指令」**
A：没填 `to` 时才会走服务端执行。可用指令见上文「服务端内置指令」
（含 `ping` / `whoami` / `echo` / `stats` / `clients` / `history` / `broadcast`），
或点「发送指令」（填了 `to`）把指令转发给客户端执行。

**Q：run.bat 双击后闪退**
A：多为 Python 没装到 PATH。装 Python 3.8+ 时记得勾选 "Add Python to PATH"，
或在命令行里执行 `run.bat` 看具体报错。