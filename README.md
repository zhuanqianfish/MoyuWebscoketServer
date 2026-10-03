# 摸鱼图片中转站（Moyu WebSocket Server）

一个 Python 写的 WebSocket 图片中转服务：**ComfyUI 出图 → 服务端接收 → 网页实时看图 → 一键保存**。

```
ComfyUI (clientExample.js)                Python 服务端                 网页客户端
   base64 图片  ────ws://8001────▶  解码 / 落盘 / 建索引  ──ws──▶  实时上墙
                                        │                    ──▶   点开放大
                                        └── saved_images/    ──▶   下载 / 打包 ZIP
```

---

## 快速开始

```bash
# 1. 装依赖
pip install -r requirements.txt

# 2. 启动服务
python server.py

# 3. 浏览器打开
#    http://127.0.0.1:8080
```

跑通整条链路（不用开 ComfyUI）：

```bash
python tools/test_client.py --count 5 --interval 1
```

自检全部接口：

```bash
python tools/verify.py            # 后端 17 项：HTTP + WebSocket + 落盘一致性
node tools/verify_frontend.js     # 前端 35 项：渲染 / 排序 / 灯箱 / 去重（DOM 桩，无需浏览器）
```

---

## 端口说明

| 端口 | 协议 | 用途 |
|------|------|------|
| **8001** | WebSocket | ComfyUI 推图（与 `clientExample.js` 里的 `PORT` 一致，不用改） |
| **8080** | HTTP | 网页 UI + 历史图片读取 / 下载接口 |

网页客户端的 WebSocket 复用了 8080 端口的 `/ws` 路径，不需要额外端口。

---

## ComfyUI 侧接入

`clientExample.js` 原样可用 —— 服务端兼容它的报文格式：

```js
const payload = JSON.stringify({ image: base64Data });
new WebSocket('ws://127.0.0.1:8001').send(payload);
```

服务端实际接受的情况比这更宽松：

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

> 建议：把 `label` 设成 ComfyUI 节点名（如 `"Image To Base64"`），
> 网页端会用它当图片标题，比一串随机 ID 好认得多。

---

## 网页客户端功能

打开 `http://127.0.0.1:8080`：

- **实时上墙** —— ComfyUI 一出图立刻出现，带 `NEW` 角标和入场动画，无需刷新
- **图片墙** —— 自适应网格，懒加载；可按「最新 / 最早 / 体积」排序
- **仅看新图** —— 过滤出本次会话期间收到的图
- **灯箱查看** —— 点任意图放大，`←/→` 翻页、`Esc` 关闭
- **保存图片** —— 悬停卡片点 `⬇` 单张下载
- **打包保存** —— `⬇ 打包保存` 把当前可见图片打成 ZIP（浏览器本地生成，不占服务端内存）
- **删除 / 清空** —— 同步删掉服务器上的文件
- **状态栏** —— 已收张数、在线窗口数、占用空间、运行时长
- **连接状态** —— 断线自动重连（退避 0.8s → 8s），顶部圆点实时反映
- **新图提示** —— Toast 通知 + WebAudio 合成提示音（可关）

---

## 命令行参数

```bash
python server.py [选项]
```

| 参数 | 默认 | 说明 |
|------|------|------|
| `--host` | `127.0.0.1` | 监听地址。**局域网访问/手机看图改 `0.0.0.0`** |
| `--ws-port` | `8001` | WebSocket 端口 |
| `--http-port` | `8080` | 网页端口 |
| `--save-dir` | `./saved_images` | 图片保存目录 |
| `--no-save` | 关 | 不落盘，只实时转发（此时无法保存图片） |
| `--history-limit` | `500` | 保留多少张，超出自动删最旧的**及其文件** |
| `--max-msg-size` | `64MB` | 单条消息上限 |
| `--open-browser` | 关 | 启动后自动开网页 |

常用组合：

```bash
# 局域网 / 手机同看
python server.py --host 0.0.0.0
# → 手机浏览器打开 http://<你电脑内网IP>:8080

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
| GET | `/media/{id}` | 图片内容（带长缓存） |
| GET | `/download/{id}` | 下载图片（`Content-Disposition: attachment`） |
| DELETE | `/api/history/{id}` | 删除单张（连文件一起删） |
| POST | `/api/clear` | 清空全部历史 |
| WS | `/ws` | 网页端实时推送 |

---

## 项目结构

```
MoyuWebscoketServer/
├── server.py               # 服务端主体（WS 收图 + HTTP 服务 + 图片仓库）
├── requirements.txt
├── clientExample.js        # ComfyUI 侧原始示例（未改动）
├── 开发说明.txt
├── webpageClient/          # 网页客户端
│   ├── index.html          #   结构
│   ├── style.css           #   暗色 + 撞色 UI
│   └── app.js              #   WS 接收 / 画廊 / 灯箱 / ZIP 打包
├── tools/
│   ├── test_client.py      # 模拟 ComfyUI 推图（含纯代码生成测试图）
│   ├── verify.py           # 后端端到端自检（17 项）
│   └── verify_frontend.js  # 前端逻辑离线校验（35 项，DOM 桩）
└── saved_images/           # 图片落盘目录（自动创建）
```

---

## 实现要点

**图片落盘用线程池** —— `write_bytes` 丢进 `asyncio.to_thread`，
不让磁盘 IO 阻塞事件循环，否则大图批量推送时会卡住整个广播。

**文件名安全化** —— 标签里的路径分隔符、特殊字符统一过滤，
日期 + 短随机串避免重名，重名再自动加序号。

**格式识别不靠扩展名** —— 直接读文件头魔数判 PNG/JPEG/GIF/BMP/WEBP，
ComfyUI 给什么格式就存什么格式。

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
A：8001 端口被占用。换个端口：`python server.py --ws-port 9001`，
然后同步改 `clientExample.js` 里的 `PORT`。

**Q：图片不落盘**
A：检查是否加了 `--no-save`；另外服务端是**内存索引**，
重启后历史列表为空但**磁盘文件还在** —— 新推送的图片会重新建立索引。

**Q：手机连不上**
A：服务默认只听 `127.0.0.1`，必须 `--host 0.0.0.0`；
还要确认 Windows 防火墙放行了 8080。

**Q：能同时开多个网页窗口吗**
A：可以，多个窗口都会收到广播，顶部「在线窗口」会同步计数。