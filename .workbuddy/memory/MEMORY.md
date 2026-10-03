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
- **给图片打标签**：ComfyUI 侧传 `label` 字段（节点名），网页端用它当标题，比随机 ID 好认。
- **Pillow 是可选增强**，不是硬依赖。缺了也能跑，退回手写文件头解析。
- **历史是内存索引**：重启后 `/api/history` 为空，但 `saved_images/` 里的文件仍在。
  这是有意设计（不引入数据库），新推送的图片会重建索引。
- **UI 走暗色 + 撞色**（电光青 `#00e5ff` / 荧光粉 `#ff2e9a` / 紫罗兰 `#7c5cff`），
  噪点叠加避免渐变色带。图片一律 `object-fit: contain` —— 不裁切画面。

## 命令

```bash
python server.py                          # 启动（8001 + 8080）
python server.py --host 0.0.0.0           # 局域网/手机访问
python tools/test_client.py --count 5     # 模拟 ComfyUI 推图
python tools/verify.py                    # 后端自检 17 项
node tools/verify_frontend.js             # 前端自检 35 项（DOM 桩，免浏览器）
```

## 排查指引

- 网页一直「连接中」→ 服务端窗口被关了；浏览器会自动重连，不用刷新
- ComfyUI 连不上 → 8001 被占用，换端口后记得同步改 `clientExample.js`
- 手机连不上 → 必须 `--host 0.0.0.0` + 防火墙放行 8080

## 本机环境

- Python 环境：`C:\Users\fish\.workbuddy\binaries\python\envs\default\Scripts\python.exe`
  （已装 aiohttp + Pillow；项目本身只要求 aiohttp）
- 无头截图 Chrome：`C:\Users\fish\.agent-browser\browsers\chrome-154.0.8037.92\chrome.exe`
  用 `--headless=new --screenshot=... --virtual-time-budget=8000 --window-size=W,H`
- `agent-browser` CLI 守护进程在本机会卡住（open 超过 4 分钟无响应），
  **截图直接用上面那个 chrome.exe 更可靠**。