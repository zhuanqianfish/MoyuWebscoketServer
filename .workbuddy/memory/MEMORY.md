# 项目长期笔记 —— MoyuWebscoketServer

## 项目定位

ComfyUI 出图的中转站：**ComfyUI 推 base64 → Python 服务端解码落盘 → 网页实时看图 + 保存**。

## 端口约定

**单端口 8801**，三种流量共用（换端口改 `--port` + `clientExample.js` 的 `PORT`）：

| 路径 | 协议 | 用途 |
|------|------|------|
| `/` | WebSocket | ComfyUI 推送端。**与 `clientExample.js` 的 `PORT` 绑定** |
| `/web` | HTTP | 网页 UI（访问 `/` 会 302 到这里） |
| `/ws` | WebSocket | 网页客户端自己的实时通道 |
| `/api/*` `/media/*` `/download/*` | HTTP | 接口 / 图片 |

单端口的实现：`/` 路由看 `Upgrade: websocket` 头分流 —— 是则交给推送处理器，
否则 302 到 `/web`。两个 App 已合并成一个，旧的 `--ws-port`/`--http-port` 保留为隐藏兼容参数。

## 关键约定

- **协议兼容优先**：`clientExample.js` 是用户已有的 ComfyUI 节点代码，**不要求用户改它**。
  服务端做字段名容错（`image`/`images`/`data`/`image_base64`/数组/裸 base64/二进制帧），
  base64 四种写法都要吃得下（纯串、data URI、含换行、缺 padding）。
- **clientExample.js 的连接必须复用**：ComfyUI 每次跑工作流都会重新执行整个脚本，
  每次 `new WebSocket()` 会耗尽端口。已改为 `globalThis.__moyuWsManager` 单例 +
  IIFE 包裹（不包的话第二次执行会抛 `Identifier 'HOST' has already been declared`）。
- **两套名字清洗不能混用**：`safe_stem()` 是文件名用的 ASCII 白名单；
  `clean_client_name()` 是客户端显示名用的，必须保留 Unicode（中文名不能被截断）。
- **aiohttp 同一 socket 不能并发 `send_str`**：广播前必须按连接取锁
  （`Broadcaster._send_locks`），否则「有人断开」+「有人接入」同时广播会打断连接。
- **新连接先发 `hello`（含 `self_id`）再广播名单**，前端靠 `self_id` 认领自己，
  不要靠名字猜。
- **给图片打标签**：ComfyUI 侧传 `label` 字段（节点名），网页端用它当标题，比随机 ID 好认。
- **Pillow 是可选增强**，不是硬依赖。缺了也能跑，退回手写文件头解析。
- **历史是内存索引**：重启后 `/api/history` 为空，但 `saved_images/` 里的文件仍在。
  这是有意设计（不引入数据库），新推送的图片会重建索引。
- **UI 走暗色 + 撞色**（电光青 `#00e5ff` / 荧光粉 `#ff2e9a` / 紫罗兰 `#7c5cff`），
  噪点叠加避免渐变色带。图片一律 `object-fit: contain` —— 不裁切画面。
- **run.bat 不能用 Write 工具直接写**：落盘是 UTF-8+LF，cmd 双击闪退
  （LF-only 让 goto 失效；BOM 会拼进首条命令）。必须用
  `tools/gen_run_bat.py` 字节级生成（UTF-8 无 BOM + 全 CRLF），
  改启动脚本后跑 `tools/_check_bat.py` 体检 + `tools/_probe_bat.py` 真实验证。
  通用规则已记入用户级记忆（Windows 批处理编码铁律）。
- **指令路由规则**（`MoyuServer._route_command`）：消息带 `to` → 转发给目标
  （`Broadcaster.resolve` 先按 id、再按名字）；不带 `to` → 走服务端内置指令
  （`_server_commands`：ping/echo/stats/clients/history/broadcast）。
  未知指令与目标不在线都明确回 `ok:false`，不静默失败。
- **指令下发必须是平铺格式**：`{"type":"command", **cmd}`，
  顶层直接是 `name/parameter/other/from/to`，**不要套 `command` 信封**。
  接收端三种形态都认（平铺 / 旧信封 / 无 type 但有 name）。
- **推图和指令抢 `name` 字段**：`{"image":..., "name":"标签"}` 是合法推图格式。
  `_on_text` 里**必须先判 b64 再判指令**，否则推图会被误判成指令。
- **`command_log` / `command_result` 只发网页端**（`_broadcast_to_web`）——
  推送端只该收到要执行的指令，日志流进指令通道会被误解析。
- **`awaiting_ack` 区分「已送达」与「客户端真回执」**：
  投递提示带 `result.awaiting_ack=true`，真回执没有该字段。
  前端日志据此分色（out 灰青 / exec 紫）。排查无响应先看这条。
- **排查指令无响应跑 `python tools/probe_command.py [id]`**：
  直接看客户端收没收到、回没回执。**先看 UA** ——
  `Mozilla/...` 是浏览器页面（油猴脚本）而非 ComfyUI 节点。
- **客户端 id 必须两边对齐**：服务端支持 `?clientId=` 自报并沿用为登记 id，
  否则「服务端按自己 id 投递 + 客户端按自报 id 过滤」= 静默丢弃。
  油猴脚本的 `to` 命中判断要「自报 id 或服务端 id 任一命中」。
- **写模拟客户端时 aiohttp `send_str` 必须 await**，
  漏 await 只有一条 RuntimeWarning 警告，回执会静默丢失（极难排查）。
- **网页是双 tab**：指令服务器（默认，`LS_TAB` 持久化）在前，推送图片在后。
  新 DOM id 必须同步加进 `tools/verify_frontend.js` 的 `IDS` 桩，否则测试炸。
- **`.card` 类名已被图片卡片占用**，指令面板那几块要用 `.panel-box` /
  `.panel-head-c` / `.panel-body-c` / `.panel-foot-c`。

## 命令

```bash
./run.sh                    # macOS/Linux（会自动探测 .venv、装依赖）
run.bat                     # Windows 双击
python server.py            # 手动启动（8801 单端口）
python server.py --host 0.0.0.0   # 局域网/手机访问
python server.py --port 9001      # 换端口（记得同步 clientExample.js）

python tools/test_client.py --count 5   # 模拟 ComfyUI 推图
python tools/verify.py                  # 后端自检 17 项
python tools/verify_clients.py          # 客户端列表自检 29 项
python tools/verify_command.py          # 指令功能自检 56 项
node tools/verify_frontend.js           # 前端自检 105 项（DOM 桩，免浏览器）
node tools/verify_ws_reuse.js           # 连接复用自检 28 项（桩 WebSocket）
node tools/shot.js 名称 [hash]          # 无头 Chrome 截图（核对 UI）
python tools/verify_bridge_client.py    # 油猴脚本链路模拟（18 项）
python tools/probe_command.py [id]      # 指令投递探针（排查客户端无响应）
```

合计 254 项自检，改完代码应全绿。

## Git

- 远程：`git@github.com:zhuanqianfish/MoyuWebscoketServer.git`（SSH，非 HTTPS）
- 主分支 `main`，首次提交 `4e6db15 first commit`
- `saved_images/`、`__pycache__`、`UI预览.png`、临时截图已由 `.gitignore` 排除
- 提交用 `git -c user.name="zhuanqianfish"` 显式指定（本地无全局 user.name 配置）
- CRLF 警告是 Windows 正常现象，不影响

## 排查指引

- 网页一直「连接中」→ 服务端窗口被关了；浏览器会自动重连，不用刷新
- ComfyUI 连不上 → 8801 被占用，换端口后记得同步改 `clientExample.js`
- 跑多次后 ComfyUI 连不上 → 检查是不是用了每次 `new WebSocket()` 的旧写法
- 手机连不上 → 必须 `--host 0.0.0.0` + 防火墙放行 8801
- 刚连上就断 → 查是否有并发 `send_str`（aiohttp 硬限制，需按连接加锁）
- 指令点了没反应 → 看指令日志 exec/err 条目；旧版 clientExample.js 不处理指令
- `verify.py` 报 `IndexError` → 历史是内存索引，被清空过；已在脚本里自动补图

## 本机环境

- 项目 `.venv`：`D:\FunProject\MoyuWebscoketServer\.venv\Scripts\python.exe`（已装 aiohttp+Pillow）
- 托管 Python：`C:\Users\fish\.workbuddy\binaries\python\envs\default\Scripts\python.exe`
- 无头截图 Chrome：`C:\Users\fish\.agent-browser\browsers\chrome-154.0.8037.92\chrome.exe`
  用 `--headless=new --screenshot=... --virtual-time-budget=8000 --window-size=W,H`
  （URL 加 `#clients` 可直接展开客户端面板）
- `agent-browser` CLI 守护进程在本机会卡住，**截图直接用上面那个 chrome.exe 更可靠**。
- 沙箱**禁止从 bash 调 `cmd.exe`**，所以 `run.bat` 只能逐条验证逻辑、无法真跑。