# 项目长期笔记 —— MoyuWebscoketServer

## 项目定位

ComfyUI 出图的中转站：**ComfyUI 推 base64 → Python 服务端解码落盘 → 网页实时看图 + 保存**。

## 端口约定

| 端口 | 协议 | 用途 |
|------|------|------|
| 8001 | WebSocket | ComfyUI 推图。**与 `clientExample.js` 的 `PORT` 绑定，改端口要同步改该文件** |
| 8080 | HTTP | 网页 UI + REST。网页端 WS 在同端口 `/ws` 路径 |

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

## 命令

```bash
./run.sh                    # macOS/Linux（会自动探测 .venv、装依赖）
run.bat                     # Windows 双击
python server.py            # 手动启动（8001 + 8080）
python server.py --host 0.0.0.0   # 局域网/手机访问

python tools/test_client.py --count 5   # 模拟 ComfyUI 推图
python tools/verify.py                  # 后端自检 17 项
python tools/verify_clients.py          # 客户端列表自检 29 项
node tools/verify_frontend.js           # 前端自检 53 项（DOM 桩，免浏览器）
node tools/verify_ws_reuse.js           # 连接复用自检 28 项（桩 WebSocket）
```

合计 127 项自检，改完代码应全绿。

## Git

- 远程：`git@github.com:zhuanqianfish/MoyuWebscoketServer.git`（SSH，非 HTTPS）
- 主分支 `main`，首次提交 `4e6db15 first commit`
- `saved_images/`、`__pycache__`、`UI预览.png` 已由 `.gitignore` 排除
- 提交用 `git -c user.name="zhuanqianfish"` 显式指定（本地无全局 user.name 配置）
- CRLF 警告是 Windows 正常现象，不影响

## 排查指引

- 网页一直「连接中」→ 服务端窗口被关了；浏览器会自动重连，不用刷新
- ComfyUI 连不上 → 8001 被占用，换端口后记得同步改 `clientExample.js`
- 跑多次后 ComfyUI 连不上 → 检查是不是用了每次 `new WebSocket()` 的旧写法
- 手机连不上 → 必须 `--host 0.0.0.0` + 防火墙放行 8080
- 刚连上就断 → 查是否有并发 `send_str`（aiohttp 硬限制，需按连接加锁）

## 本机环境

- 项目 `.venv`：`D:\FunProject\MoyuWebscoketServer\.venv\Scripts\python.exe`（已装 aiohttp+Pillow）
- 托管 Python：`C:\Users\fish\.workbuddy\binaries\python\envs\default\Scripts\python.exe`
- 无头截图 Chrome：`C:\Users\fish\.agent-browser\browsers\chrome-154.0.8037.92\chrome.exe`
  用 `--headless=new --screenshot=... --virtual-time-budget=8000 --window-size=W,H`
  （URL 加 `#clients` 可直接展开客户端面板）
- `agent-browser` CLI 守护进程在本机会卡住，**截图直接用上面那个 chrome.exe 更可靠**。
- 沙箱**禁止从 bash 调 `cmd.exe`**，所以 `run.bat` 只能逐条验证逻辑、无法真跑。