# -*- coding: utf-8 -*-
"""
Moyu WebSocket Server
=====================

一个用 Python (aiohttp) 实现的 WebSocket 服务端，用于接收类似
``clientExample.js`` 中 ComfyUI 节点发来的 base64 图片，并将其：

1. 解码为真实图片文件并落盘到 ``saved_images/``；
2. 通过 WebSocket 广播给所有已连接的网页客户端（webPageClient）；
3. 同时提供 HTTP 服务，供用户浏览历史图片、查看大图、下载/批量保存。

启动::

    python server.py

默认端口：

* ``8801`` —— 单端口同时承载两种流量：
    - WebSocket 推送：``ws://127.0.0.1:8801/``（ComfyUI 推图）
    - 网页查看：``http://127.0.0.1:8801/web``（浏览器访问 ``/`` 会自动跳转）
  网页客户端自身的 WebSocket 在 ``/ws`` 路径，与推送端同端口互不干扰。

常用参数::

    python server.py --port 8801 --host 0.0.0.0
    python server.py --save-dir D:/Pictures/moyu --no-save
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import contextlib
import json
import mimetypes
import os
import re
import signal
import struct
import sys
import time
import uuid
from dataclasses import dataclass, asdict, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    from aiohttp import WSMsgType, web
except ImportError:  # pragma: no cover - 依赖缺失时给出友好提示
    sys.stderr.write(
        "[错误] 缺少依赖 aiohttp，请先执行：pip install -r requirements.txt\n"
    )
    raise

try:  # Pillow 仅用于读取图片尺寸，属可选依赖
    from PIL import Image  # type: ignore

    HAS_PILLOW = True
except Exception:  # pragma: no cover
    HAS_PILLOW = False


APP_NAME = "摸鱼图片中转站"
VERSION = "1.0.0"

# 单条消息上限（base64 图片可能较大，默认 64MB）
DEFAULT_MAX_MSG_SIZE = 64 * 1024 * 1024

# 内存中保留的历史记录条数上限
DEFAULT_HISTORY_LIMIT = 500

# 浏览器可访问的图片 URL 前缀
MEDIA_PREFIX = "/media/"

# 图片魔数 -> mimetype，用于不依赖 Pillow 也能识别格式
_MAGIC = [
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"BM", "image/bmp"),
]

# 用于生成安全文件名的 slug
_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


# --------------------------------------------------------------------------- #
# 图片工具
# --------------------------------------------------------------------------- #
def sniff_mime(data: bytes) -> str:
    """通过魔数嗅探图片类型，失败时退回 webp/jpeg 猜测。"""
    for magic, mime in _MAGIC:
        if data.startswith(magic):
            return mime
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if len(data) >= 2 and data[:2] == b"\x00\x00" and data[2:3] == b"\x01":
        return "image/x-icon"
    return "image/jpeg"


def extension_for(mime: str) -> str:
    """mimetype -> 扩展名（不依赖 mimetypes 的系统配置）。"""
    return {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "image/bmp": ".bmp",
        "image/x-icon": ".ico",
    }.get(mime, ".jpg")


def decode_base64_image(raw: str) -> bytes:
    """
    解析 base64 字符串，兼容以下几种常见写法：

    * ``iVBORw0KGgo...``                     纯 base64
    * ``data:image/png;base64, iVBOR...``    data URI
    * 含换行/空白的 base64（自动剔除）
    """
    if not isinstance(raw, str):
        raise ValueError("base64 数据必须是字符串")

    text = raw.strip()
    if not text:
        raise ValueError("base64 数据为空")

    # 去掉 data URI 前缀
    if text.startswith("data:"):
        _, _, text = text.partition(",")
        text = text.strip()

    # 剔除所有空白字符（ComfyUI 某些节点会插入换行）
    text = re.sub(r"\s+", "", text)

    # 补齐 padding
    pad = len(text) % 4
    if pad:
        text += "=" * (4 - pad)

    try:
        return base64.b64decode(text, validate=False)
    except (binascii.Error, ValueError) as exc:
        raise ValueError(f"base64 解码失败: {exc}") from exc


def probe_size(data: bytes, mime: str) -> tuple[Optional[int], Optional[int]]:
    """尽力读取图片宽高；失败返回 (None, None)，不影响主流程。"""
    if HAS_PILLOW:
        try:
            import io

            with Image.open(io.BytesIO(data)) as im:
                return int(im.width), int(im.height)
        except Exception:
            pass

    # 无 Pillow 时的纯解析兜底
    try:
        if mime == "image/png" and len(data) >= 24 and data[12:16] == b"IHDR":
            w, h = struct.unpack(">II", data[16:24])
            return int(w), int(h)
        if mime == "image/gif" and len(data) >= 10:
            w, h = struct.unpack("<HH", data[6:10])
            return int(w), int(h)
        if mime == "image/bmp" and len(data) >= 26:
            w, h = struct.unpack("<ii", data[18:26])
            return abs(w), abs(h)
    except Exception:
        pass
    return None, None


def safe_stem(name: Optional[str], fallback: str) -> str:
    """把任意标题清洗成安全的文件名主干。"""
    if not name:
        return fallback
    stem = _SAFE_NAME.sub("_", str(name)).strip("._-")
    return stem[:60] or fallback


# 客户端名允许中日韩等 Unicode 字母，只剔除控制字符和路径分隔符
_UNSAFE_CHARS = re.compile(r"[\x00-\x1f\x7f<>:\"/\\|?*]+")


def clean_client_name(name: Optional[str], fallback: str, limit: int = 24) -> str:
    """
    清洗客户端显示名。

    与 safe_stem 的区别：**保留 Unicode**（中文名必须能正常显示），
    只剔除控制字符、路径分隔符等危险字符。
    """
    if not name:
        return fallback
    text = _UNSAFE_CHARS.sub("", str(name)).strip()
    text = re.sub(r"\s+", " ", text)
    return text[:limit] or fallback


def json_dumps(obj: Any) -> str:
    """
    统一的 JSON 序列化：保留中文 + 自动展开 dataclass。

    dataclass（ImageRecord）直接透传会抛 TypeError，统一在这里兜住。
    """
    return json.dumps(obj, ensure_ascii=False, default=_json_default)


def _json_default(obj: Any) -> Any:
    if hasattr(obj, "to_dict"):
        return obj.to_dict()
    if hasattr(obj, "__dict__"):
        return obj.__dict__
    return str(obj)


def json_response(data: Dict[str, Any], status: int = 200) -> web.Response:
    """构造 JSON 响应（避免各处重复写 dumps 回调）。"""
    return web.Response(
        text=json_dumps(data),
        status=status,
        content_type="application/json",
        charset="utf-8",
    )


# --------------------------------------------------------------------------- #
# 数据模型
# --------------------------------------------------------------------------- #
@dataclass
class ImageRecord:
    """一张已落盘的图片的元信息。"""

    id: str
    filename: str
    mime: str
    size: int
    width: Optional[int]
    height: Optional[int]
    created_at: float
    created_at_text: str
    source: str = "comfyui"
    label: str = ""
    url: str = ""
    download_url: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class ServerConfig:
    """运行期配置。"""

    host: str = "127.0.0.1"
    port: int = 8801  # 单端口：/ 推送 WS · /web 网页 · /ws 网页端 WS
    save_dir: Path = field(default_factory=lambda: Path(__file__).parent / "saved_images")
    auto_save: bool = True
    history_limit: int = DEFAULT_HISTORY_LIMIT
    max_msg_size: int = DEFAULT_MAX_MSG_SIZE
    open_browser: bool = False
    log_level: str = "info"


# --------------------------------------------------------------------------- #
# 图片仓库：落盘 + 历史管理
# --------------------------------------------------------------------------- #
class ImageStore:
    """负责图片落盘、索引维护与历史裁剪。"""

    def __init__(self, cfg: ServerConfig) -> None:
        self.cfg = cfg
        self._records: List[ImageRecord] = []
        self._by_id: Dict[str, ImageRecord] = {}
        self._lock = asyncio.Lock()
        self._bytes_on_disk = 0

        if cfg.auto_save:
            self.cfg.save_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------ 属性 ------------------------------ #
    @property
    def enabled(self) -> bool:
        return self.cfg.auto_save

    @property
    def total_bytes(self) -> int:
        return self._bytes_on_disk

    @property
    def count(self) -> int:
        return len(self._records)

    def records(self) -> List[ImageRecord]:
        """按时间倒序返回历史（最新在前）。"""
        return list(reversed(self._records))

    def get(self, image_id: str) -> Optional[ImageRecord]:
        return self._by_id.get(image_id)

    def path_of(self, rec: ImageRecord) -> Path:
        return self.cfg.save_dir / rec.filename

    # ------------------------------ 写入 ------------------------------ #
    async def add(
        self,
        data: bytes,
        *,
        source: str = "comfyui",
        label: str = "",
    ) -> ImageRecord:
        """把图片字节写入磁盘并登记到历史。"""
        if not self.enabled:
            raise RuntimeError("服务器未启用落盘（--no-save）")

        mime = sniff_mime(data)
        width, height = probe_size(data, mime)

        async with self._lock:
            image_id = uuid.uuid4().hex[:12]
            now = datetime.now()
            stamp = now.strftime("%Y%m%d-%H%M%S")
            short = uuid.uuid4().hex[:4]
            stem = safe_stem(label, stamp)
            filename = f"{now.strftime('%Y%m%d')}-{stem}-{short}{extension_for(mime)}"

            path = self.cfg.save_dir / filename
            # 极小概率重名时追加序号
            counter = 1
            while path.exists():
                filename = (
                    f"{now.strftime('%Y%m%d')}-{stem}-{short}-{counter}"
                    f"{extension_for(mime)}"
                )
                path = self.cfg.save_dir / filename
                counter += 1

            # 写入磁盘（放到线程池，避免阻塞事件循环）
            await asyncio.to_thread(path.write_bytes, data)

            rec = ImageRecord(
                id=image_id,
                filename=filename,
                mime=mime,
                size=len(data),
                width=width,
                height=height,
                created_at=now.timestamp(),
                created_at_text=now.strftime("%Y-%m-%d %H:%M:%S"),
                source=source,
                label=label or stem,
                url=f"{MEDIA_PREFIX}{image_id}",
                download_url=f"/download/{image_id}",
            )

            self._records.append(rec)
            self._by_id[image_id] = rec
            self._bytes_on_disk += len(data)
            await self._trim_locked()

        return rec

    async def _trim_locked(self) -> None:
        """裁剪历史：只保留最近 history_limit 条，并删除对应文件。"""
        limit = max(1, self.cfg.history_limit)
        while len(self._records) > limit:
            old = self._records.pop(0)
            self._by_id.pop(old.id, None)
            self._bytes_on_disk = max(0, self._bytes_on_disk - old.size)
            if self.enabled:
                with contextlib.suppress(OSError):
                    await asyncio.to_thread(self.path_of(old).unlink)

    async def delete(self, image_id: str) -> bool:
        async with self._lock:
            rec = self._by_id.pop(image_id, None)
            if rec is None:
                return False
            try:
                self._records.remove(rec)
            except ValueError:
                pass
            self._bytes_on_disk = max(0, self._bytes_on_disk - rec.size)
            if self.enabled:
                with contextlib.suppress(OSError):
                    await asyncio.to_thread(self.path_of(rec).unlink)
            return True

    async def clear(self) -> int:
        async with self._lock:
            count = len(self._records)
            records = list(self._records)
            self._records.clear()
            self._by_id.clear()
            self._bytes_on_disk = 0
            if self.enabled:
                for rec in records:
                    with contextlib.suppress(OSError):
                        await asyncio.to_thread(self.path_of(rec).unlink)
            return count


# --------------------------------------------------------------------------- #
# 广播中心 + 在线客户端登记
# --------------------------------------------------------------------------- #
@dataclass
class ClientInfo:
    """一个已连接的客户端（网页端或 ComfyUI 推送端）。"""

    id: str
    name: str
    kind: str  # "web"=网页端  "sender"=ComfyUI 推送端
    ip: str
    user_agent: str = ""
    connected_at: float = 0.0
    connected_at_text: str = ""
    sent: int = 0  # 该客户端推送的图片数（仅 sender）

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["connected_seconds"] = int(time.time() - self.connected_at)
        return d


class Broadcaster:
    """
    维护网页客户端连接池并广播 JSON 消息。

    同时承担「在线客户端登记簿」的职责：记录每个连接的名称 / IP / 连接时间，
    供网页端展示「当前已连接的客户端列表」。
    """

    def __init__(self) -> None:
        self._clients: Dict[web.WebSocketResponse, ClientInfo] = {}
        # 每个连接一把发送锁：aiohttp 不允许对同一个 socket 并发 send_str，
        # 而「有人断开」与「有人接入」会同时触发广播，必须串行化。
        self._send_locks: Dict[web.WebSocketResponse, asyncio.Lock] = {}
        self._lock = asyncio.Lock()

    def _lock_for(self, ws: web.WebSocketResponse) -> asyncio.Lock:
        """取（并惰性创建）某连接的发送锁。"""
        lock = self._send_locks.get(ws)
        if lock is None:
            lock = self._send_locks[ws] = asyncio.Lock()
        return lock

    @property
    def count(self) -> int:
        """网页端连接数（保持与前端「在线窗口」语义一致）。"""
        return len(self._clients)

    def snapshot(self, kind: Optional[str] = None) -> List[Dict[str, Any]]:
        """返回在线客户端列表，按连接时间倒序（最新在前）。"""
        items = [
            info.to_dict()
            for info in self._clients.values()
            if kind is None or info.kind == kind
        ]
        items.sort(key=lambda d: d.get("connected_at", 0), reverse=True)
        return items

    def find(self, name: str) -> Optional[ClientInfo]:
        """按名称查客户端（同名取最早连接的那个）。"""
        hits = [i for i in self._clients.values() if i.name == name]
        return min(hits, key=lambda i: i.connected_at) if hits else None

    def count_send(self) -> int:
        return sum(1 for i in self._clients.values() if i.kind == "sender")

    def resolve(self, keys: List[str]) -> List[web.WebSocketResponse]:
        """
        按 id 或名字解析目标连接（指令路由用）。

        先按 id 精确匹配，未命中的再按名字匹配 —— 名字可匹配多个连接
        （如两台都叫 ComfyUI 的机器），id 永远唯一，优先用。
        """
        wanted = [str(k).strip() for k in keys if str(k).strip()]
        if not wanted:
            return []
        by_id: Dict[str, web.WebSocketResponse] = {
            info.id: ws for ws, info in self._clients.items() if info.id in wanted
        }
        remaining = [k for k in wanted if k not in by_id]
        out = list(by_id.values())
        for ws, info in self._clients.items():
            if info.name in remaining and ws not in out:
                out.append(ws)
        return out

    async def add(
        self,
        ws: web.WebSocketResponse,
        info: ClientInfo,
    ) -> ClientInfo:
        async with self._lock:
            self._clients[ws] = info
            self._send_locks.setdefault(ws, asyncio.Lock())
        return info

    async def remove(self, ws: web.WebSocketResponse) -> Optional[ClientInfo]:
        async with self._lock:
            self._send_locks.pop(ws, None)
            return self._clients.pop(ws, None)

    def bump_sent(self, ws: web.WebSocketResponse) -> None:
        """累加该客户端的推送计数（热路径，不加锁 —— 单事件循环内足够）。"""
        info = self._clients.get(ws)
        if info is not None:
            info.sent += 1

    async def send(self, ws: web.WebSocketResponse, payload: Dict[str, Any]) -> bool:
        """单播（带锁，避免与广播并发写同一个 socket）。"""
        text = json_dumps(payload)
        async with self._lock_for(ws):
            try:
                await ws.send_str(text)
                return True
            except Exception:
                return False

    async def broadcast(self, payload: Dict[str, Any]) -> int:
        """广播给所有客户端，返回成功送达的连接数。"""
        async with self._lock:
            targets = list(self._clients)
        if not targets:
            return 0

        text = json_dumps(payload)

        async def one(ws: web.WebSocketResponse) -> bool:
            async with self._lock_for(ws):
                try:
                    await ws.send_str(text)
                    return True
                except Exception:
                    return False

        results = await asyncio.gather(*(one(ws) for ws in targets), return_exceptions=True)
        alive: List[web.WebSocketResponse] = []
        ok = 0
        for ws, res in zip(targets, results):
            if isinstance(res, Exception) or res is not True:
                continue
            ok += 1
            alive.append(ws)

        if len(alive) != len(targets):
            async with self._lock:
                for ws in targets:
                    if ws not in alive:
                        self._clients.pop(ws, None)
                        self._send_locks.pop(ws, None)
        return ok

    async def broadcast_clients(self) -> None:
        """广播最新的客户端列表（有人连上/断开时调用）。"""
        await self.broadcast(
            {
                "type": "clients",
                "clients": self.snapshot(),
                "stats": self.stats_payload(),
            }
        )

    def stats_payload(self) -> Dict[str, Any]:
        return {
            "web_clients": self.count,
            "sender_clients": self.count_send(),
            "total_clients": len(self._clients),
        }


# --------------------------------------------------------------------------- #
# 应用组装
# --------------------------------------------------------------------------- #
class MoyuServer:
    def __init__(self, cfg: ServerConfig) -> None:
        self.cfg = cfg
        self.store = ImageStore(cfg)
        self.hub = Broadcaster()
        self.started_at = time.time()
        self._apps: List[web.Application] = []

    # --------------------------- 日志工具 --------------------------- #
    def log(self, msg: str, level: str = "info") -> None:
        prefix = {"info": "[服务端]", "warn": "[警告]", "error": "[错误]"}.get(level, "[信息]")
        print(f"{prefix} {msg}", flush=True)

    # --------------------------- WebSocket --------------------------- #
    async def ws_handler(self, request: web.Request) -> web.StreamResponse:
        """接收 ComfyUI 推送的 base64 图片。"""
        ws = web.WebSocketResponse(
            heartbeat=30,
            max_msg_size=self.cfg.max_msg_size,
            compress=False,
        )
        await ws.prepare(request)

        peer = request.remote or "unknown"

        # 允许推送端在 URL 上带 name / client 标识自己：ws://host:8801?client=ComfyUI-01
        raw_name = (request.query.get("client") or request.query.get("name") or "").strip()
        name = clean_client_name(raw_name, f"ComfyUI-{uuid.uuid4().hex[:4]}")

        # 同名连接视为重连顶替，旧连接登记移除，避免列表出现重复条目
        stale = self.hub.find(name)
        info = ClientInfo(
            id=uuid.uuid4().hex[:8],
            name=name,
            kind="sender",
            ip=peer,
            user_agent=request.headers.get("User-Agent", "")[:120],
            connected_at=time.time(),
            connected_at_text=datetime.now().strftime("%H:%M:%S"),
        )
        await self.hub.add(ws, info)
        if stale is not None:
            self.log(f"检测到同名客户端「{name}」重连，顶替旧登记", "warn")
        await self.hub.broadcast_clients()

        self.log(f"ComfyUI 客户端已连接：{name}（{peer}）")

        stats = self._stats_payload()
        await self.hub.send(
            ws,
            {
                "type": "welcome",
                "app": APP_NAME,
                "version": VERSION,
                "client_id": info.id,
                "client_name": info.name,
                "reused": stale is not None,
                "stats": stats,
            },
        )

        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    await self._on_text(ws, msg.data, peer)
                elif msg.type == WSMsgType.BINARY:
                    # 兼容直接推送原始图片字节的用法
                    await self._on_binary(ws, msg.data, peer)
                elif msg.type == WSMsgType.ERROR:
                    self.log(f"连接异常：{ws.exception()}", "warn")
                    break
        finally:
            gone = await self.hub.remove(ws)
            await self.hub.broadcast_clients()
            self.log(f"ComfyUI 客户端断开：{(gone or info).name}（{peer}）")

        return ws

    async def _on_text(self, ws: web.WebSocketResponse, raw: str, peer: str) -> None:
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            # 允许直接发送裸 base64（不带 JSON）
            with contextlib.suppress(ValueError):
                await self._ingest_base64(ws, raw, peer)
                return
            await self.hub.send(
                ws, {"type": "error", "message": "消息不是合法 JSON，且不是有效 base64"}
            )
            return

        if not isinstance(payload, dict):
            await self.hub.send(ws, {"type": "error", "message": "消息必须是 JSON 对象"})
            return

        # 心跳
        if payload.get("type") == "ping":
            await self.hub.send(ws, {"type": "pong", "ts": time.time()})
            return

        # 指令消息：转发给指定客户端，或在服务端执行
        if payload.get("type") in ("command", "command_result"):
            await self._route_command(ws, payload)
            return

        b64 = (
            payload.get("image")
            or payload.get("images")
            or payload.get("data")
            or payload.get("image_base64")
        )
        if isinstance(b64, list):
            b64 = b64[0] if b64 else None
        if not b64:
            await self.hub.send(ws, {"type": "error", "message": "缺少 image 字段"})
            return

        label = str(payload.get("label") or payload.get("name") or "")
        await self._ingest_base64(ws, b64, peer, label=label)

    async def _on_binary(
        self, ws: web.WebSocketResponse, data: bytes, peer: str
    ) -> None:
        try:
            await self._publish(ws, data, peer, label="")
        except Exception as exc:
            await self.hub.send(ws, {"type": "error", "message": str(exc)})

    async def _ingest_base64(
        self,
        ws: web.WebSocketResponse,
        b64: str,
        peer: str,
        *,
        label: str = "",
    ) -> None:
        try:
            data = decode_base64_image(b64)
            await self._publish(ws, data, peer, label=label)
        except Exception as exc:
            self.log(f"处理来自 {peer} 的消息失败：{exc}", "warn")
            await self.hub.send(ws, {"type": "error", "message": str(exc)})

    async def _publish(
        self,
        ws: web.WebSocketResponse,
        data: bytes,
        peer: str,
        *,
        label: str,
    ) -> None:
        """落盘 -> 记录 -> 广播 -> 回执。"""
        if not data:
            raise ValueError("图片数据为空")

        rec: Optional[ImageRecord] = None
        save_note = "仅转发（未落盘）"
        if self.store.enabled:
            rec = await self.store.add(data, source=peer, label=label)
            save_note = f"已保存 {rec.filename}"

        dims = (
            f"{rec.width}x{rec.height}" if rec and rec.width else sniff_mime(data)
        )
        self.log(f"收到图片（{len(data) / 1024:.1f} KB, {dims}）— {save_note}")

        self.hub.bump_sent(ws)

        # 广播给网页客户端（附带最新客户端列表，保证计数同步）
        await self.hub.broadcast(
            {
                "type": "image",
                "record": rec.to_dict() if rec else self._virtual_record(data).to_dict(),
                "stats": self._stats_payload(),
                "clients": self.hub.snapshot(),
            }
        )

        # 回执给发送方
        await self.hub.send(
            ws,
            {
                "type": "ack",
                "ok": True,
                "id": rec.id if rec else None,
                "filename": rec.filename if rec else None,
                "size": len(data),
                "stats": self._stats_payload(),
            },
        )

    def _virtual_record(self, data: bytes) -> ImageRecord:
        """未开启落盘时构造一个仅用于展示的记录。"""
        mime = sniff_mime(data)
        width, height = probe_size(data, mime)
        now = datetime.now()
        image_id = uuid.uuid4().hex[:12]
        return ImageRecord(
            id=image_id,
            filename="",
            mime=mime,
            size=len(data),
            width=width,
            height=height,
            created_at=now.timestamp(),
            created_at_text=now.strftime("%Y-%m-%d %H:%M:%S"),
            source="preview",
            label="预览",
            url="",
            download_url="",
        )

    # ------------------------------ HTTP ------------------------------ #
    def _web_root(self) -> Path:
        return Path(__file__).parent / "webpageClient"

    def _stats_payload(self) -> Dict[str, Any]:
        stats = {
            "images": self.store.count,
            "bytes": self.store.total_bytes,
            "clients": self.hub.count,  # 网页端连接数（保持与前端「在线窗口」一致）
            "saving": self.store.enabled,
            "save_dir": str(self.cfg.save_dir) if self.store.enabled else "",
            "uptime": int(time.time() - self.started_at),
            "version": VERSION,
        }
        stats.update(self.hub.stats_payload())
        return stats

    # --------------------------- 指令路由 --------------------------- #
    @staticmethod
    def normalize_command(raw: Any) -> Dict[str, Any]:
        """
        把指令规范成统一结构::

            {"name": str, "parameter": {}, "other": {}, "from": [...], "to": [...]}

        容错：from/to 允许字符串或数组；parameter/other 允许字符串（尝试解析 JSON）。
        """
        cmd: Dict[str, Any] = {
            "name": "",
            "parameter": {},
            "other": {},
            "from": [],
            "to": [],
        }
        if not isinstance(raw, dict):
            if isinstance(raw, str) and raw.strip():
                with contextlib.suppress(json.JSONDecodeError):
                    raw = json.loads(raw)
            if not isinstance(raw, dict):
                cmd["name"] = str(raw or "")[:120]
                return cmd

        cmd["name"] = str(raw.get("name") or "")[:120]

        for key in ("parameter", "other"):
            val = raw.get(key)
            if isinstance(val, str):
                with contextlib.suppress(json.JSONDecodeError):
                    val = json.loads(val)
            if val is None:
                val = {}
            if not isinstance(val, dict):
                val = {"value": val}
            cmd[key] = val

        for key in ("from", "to"):
            val = raw.get(key)
            if val is None or val == "":
                cmd[key] = []
            elif isinstance(val, str):
                cmd[key] = [val]
            elif isinstance(val, (list, tuple)):
                cmd[key] = [str(v) for v in val if str(v).strip()]
            else:
                cmd[key] = [str(val)]

        return cmd

    async def _route_command(
        self, sender: web.WebSocketResponse, payload: Dict[str, Any]
    ) -> None:
        """
        指令路由。

        * ``command_result`` —— 客户端回执，仅记录日志并转发给网页端展示
        * ``command``：
            - 带 ``to`` → 转发给指定客户端（to 可填 id 或名字）
            - 不带 ``to`` → 在服务端执行（内置指令 / 可扩展处理器）
        """
        sender_info = self.hub._clients.get(sender)

        if payload.get("type") == "command_result":
            # 客户端回执：补上 ok 字段后转发给所有网页端（用于日志着色）
            result = payload.get("result")
            ok = bool(result.get("ok")) if isinstance(result, dict) else bool(payload.get("ok"))
            frm = payload.get("from")
            await self.hub.broadcast(
                {
                    "type": "command_result",
                    "command": payload.get("command"),
                    "result": result,
                    "ok": ok,
                    "from": frm[0] if isinstance(frm, list) and frm else frm,
                }
            )
            return

        cmd = self.normalize_command(payload.get("command", payload))

        # from 缺省时用发送者名字补上（本服务器发出时前端会显式给 "server"）
        if not cmd["from"]:
            if sender_info is not None:
                cmd["from"] = [sender_info.id]
            else:
                cmd["from"] = ["server"]

        targets = cmd["to"]
        if targets:
            await self._forward_command(sender, cmd, targets)
        else:
            await self._exec_server_command(sender, cmd)

    async def _forward_command(
        self,
        sender: web.WebSocketResponse,
        cmd: Dict[str, Any],
        targets: List[str],
    ) -> None:
        """把指令转发给指定客户端。"""
        sockets = self.hub.resolve(targets)
        if not sockets:
            await self.hub.send(
                sender,
                {
                    "type": "command_result",
                    "ok": False,
                    "command": cmd,
                    "result": {"error": f"目标客户端不在线：{targets}"},
                },
            )
            self.log(f"指令「{cmd['name'] or '(无名)'}」目标不在线：{targets}", "warn")
            return

        frame = {"type": "command", "command": cmd}
        delivered = 0
        for ws in sockets:
            if await self.hub.send(ws, frame):
                delivered += 1

        names = [
            self.hub._clients[ws].name
            for ws in sockets
            if ws in self.hub._clients
        ]
        self.log(
            f"指令「{cmd['name'] or '(无名)'}」已转发给 {delivered} 个客户端：{names}"
        )
        # 回执给发送方（含实际送达名单），并同步一份给所有网页端做日志展示
        await self.hub.send(
            sender,
            {
                "type": "command_result",
                "ok": True,
                "command": cmd,
                "result": {"delivered": delivered, "targets": names},
            },
        )
        await self.hub.broadcast(
            {
                "type": "command_log",
                "direction": "out",
                "command": cmd,
                "delivered": delivered,
                "targets": names,
            }
        )

    async def _exec_server_command(
        self, sender: web.WebSocketResponse, cmd: Dict[str, Any]
    ) -> None:
        """
        在服务端执行指令（消息不带 ``to`` 时）。

        内置指令见 ``_SERVER_COMMANDS``；未注册的指令名会回一个明确的错误，
        避免静默失败。执行结果回给发送方并广播给网页端日志。
        """
        name = cmd["name"].strip()
        handler = self._server_commands.get(name)
        if handler is None:
            result: Dict[str, Any] = {
                "ok": False,
                "error": f"未知服务端指令：{name or '(空)'}",
                "available": sorted(self._server_commands),
            }
            self.log(f"未知服务端指令：{name!r}", "warn")
        else:
            try:
                result = await handler(cmd)
                result = {"ok": True, **result}
                self.log(f"服务端指令「{name}」执行完成")
            except Exception as exc:  # 指令异常不应拖垮连接
                result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
                self.log(f"服务端指令「{name}」执行出错：{exc}", "error")

        await self.hub.send(
            sender,
            {"type": "command_result", "ok": bool(result.get("ok")), "command": cmd, "result": result},
        )
        await self.hub.broadcast(
            {
                "type": "command_log",
                "direction": "exec",
                "command": cmd,
                "result": result,
            }
        )

    # --------------------------- 内置服务端指令 --------------------------- #
    async def _cmd_ping(self, cmd: Dict[str, Any]) -> Dict[str, Any]:
        return {"pong": True, "ts": time.time()}

    async def _cmd_echo(self, cmd: Dict[str, Any]) -> Dict[str, Any]:
        return {"echo": cmd["parameter"], "other": cmd["other"]}

    async def _cmd_stats(self, cmd: Dict[str, Any]) -> Dict[str, Any]:
        return {"stats": self._stats_payload()}

    async def _cmd_clients(self, cmd: Dict[str, Any]) -> Dict[str, Any]:
        return {"clients": self.hub.snapshot()}

    async def _cmd_history(self, cmd: Dict[str, Any]) -> Dict[str, Any]:
        try:
            limit = int(cmd["parameter"].get("limit", 20))
        except (TypeError, ValueError):
            limit = 20
        limit = max(1, min(limit, self.cfg.history_limit))
        return {
            "items": [r.to_dict() for r in self.store.records()[:limit]],
            "stats": self._stats_payload(),
        }

    async def _cmd_broadcast(self, cmd: Dict[str, Any]) -> Dict[str, Any]:
        """把任意 payload 广播给所有客户端（调试用）。"""
        payload = cmd["parameter"].get("payload")
        if not isinstance(payload, dict):
            return {"error": "parameter.payload 必须是 JSON 对象"}
        n = await self.hub.broadcast(payload)
        return {"delivered": n}

    @property
    def _server_commands(self) -> Dict[str, Any]:
        return {
            "ping": self._cmd_ping,
            "echo": self._cmd_echo,
            "stats": self._cmd_stats,
            "clients": self._cmd_clients,
            "history": self._cmd_history,
            "broadcast": self._cmd_broadcast,
        }

    async def http_index(self, request: web.Request) -> web.StreamResponse:
        index = self._web_root() / "index.html"
        if not index.exists():
            return web.Response(
                status=404,
                text="未找到 webpageClient/index.html，请确认目录完整。",
                content_type="text/plain; charset=utf-8",
            )
        return web.FileResponse(index, headers={"Cache-Control": "no-cache"})

    async def api_history(self, request: web.Request) -> web.Response:
        try:
            limit = int(request.query.get("limit", "200"))
        except ValueError:
            limit = 200
        limit = max(1, min(limit, self.cfg.history_limit))
        items = [r.to_dict() for r in self.store.records()[:limit]]
        return json_response(
            {
                "ok": True,
                "items": items,
                "stats": self._stats_payload(),
                "clients": self.hub.snapshot(),
            }
        )

    async def api_stats(self, request: web.Request) -> web.Response:
        return json_response(
            {"ok": True, "stats": self._stats_payload(), "clients": self.hub.snapshot()}
        )

    async def api_clients(self, request: web.Request) -> web.Response:
        """已连接客户端列表（网页端面板的兜底轮询接口）。"""
        return json_response(
            {
                "ok": True,
                "clients": self.hub.snapshot(),
                "stats": self._stats_payload(),
            }
        )

    async def serve_media(self, request: web.Request) -> web.StreamResponse:
        rec = self.store.get(request.match_info["image_id"])
        if rec is None or not rec.filename:
            return web.Response(status=404, text="图片不存在或已被清理")
        path = self.store.path_of(rec)
        if not path.exists():
            return web.Response(status=404, text="文件已丢失")
        return web.FileResponse(
            path,
            headers={
                "Content-Type": rec.mime,
                "Cache-Control": "public, max-age=31536000, immutable",
            },
        )

    async def download_one(self, request: web.Request) -> web.StreamResponse:
        rec = self.store.get(request.match_info["image_id"])
        if rec is None or not rec.filename:
            return web.Response(status=404, text="图片不存在或已被清理")
        path = self.store.path_of(rec)
        if not path.exists():
            return web.Response(status=404, text="文件已丢失")
        return web.FileResponse(
            path,
            headers={"Content-Disposition": f'attachment; filename="{rec.filename}"'},
        )

    async def api_delete(self, request: web.Request) -> web.Response:
        ok = await self.store.delete(request.match_info["image_id"])
        if not ok:
            return json_response({"ok": False, "message": "图片不存在"}, status=404)
        await self.hub.broadcast(
            {"type": "removed", "id": request.match_info["image_id"], "stats": self._stats_payload()}
        )
        return json_response({"ok": True, "stats": self._stats_payload()})

    async def api_clear(self, request: web.Request) -> web.Response:
        count = await self.store.clear()
        await self.hub.broadcast({"type": "cleared", "stats": self._stats_payload()})
        return json_response({"ok": True, "removed": count, "stats": self._stats_payload()})

    async def ws_page(self, request: web.Request) -> web.StreamResponse:
        """网页客户端专用 WebSocket：只接收广播。"""
        ws = web.WebSocketResponse(heartbeat=30, max_msg_size=self.cfg.max_msg_size)
        await ws.prepare(request)

        peer = request.remote or "unknown"
        raw_name = (request.query.get("name") or "").strip()
        name = clean_client_name(raw_name, f"网页-{uuid.uuid4().hex[:4]}")

        info = ClientInfo(
            id=uuid.uuid4().hex[:8],
            name=name,
            kind="web",
            ip=peer,
            user_agent=request.headers.get("User-Agent", "")[:120],
            connected_at=time.time(),
            connected_at_text=datetime.now().strftime("%H:%M:%S"),
        )
        await self.hub.add(ws, info)
        self.log(f"网页客户端已连接：{name}（{peer}，当前 {self.hub.count} 个）")

        # 先给本窗口发 hello（含自己的 id），再广播名单给所有人（含自己）
        await self.hub.send(
            ws,
            {
                "type": "hello",
                "app": APP_NAME,
                "version": VERSION,
                "stats": self._stats_payload(),
                "clients": self.hub.snapshot(),
                "self_id": info.id,
                "items": [r.to_dict() for r in self.store.records()],
            },
        )
        await self.hub.broadcast_clients()

        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    with contextlib.suppress(json.JSONDecodeError):
                        data = json.loads(msg.data)
                        if not isinstance(data, dict):
                            continue
                        if data.get("type") == "ping":
                            await self.hub.send(ws, {"type": "pong", "ts": time.time()})
                        elif data.get("type") in ("command", "command_result"):
                            await self._route_command(ws, data)
                elif msg.type == WSMsgType.ERROR:
                    break
        finally:
            gone = await self.hub.remove(ws)
            await self.hub.broadcast_clients()
            self.log(f"网页客户端断开：{(gone or info).name}（剩余 {self.hub.count} 个）")

        return ws

    def build_http_app(self) -> web.Application:
        app = web.Application()

        # 根路径双职责：WebSocket 升级 = 推送端（clientExample.js 连 ws://host:port/）；
        # 普通浏览器请求 = 302 到 /web
        app.router.add_get("/", self.root_route)
        app.router.add_get("/web", self.http_index)
        app.router.add_get("/api/history", self.api_history)
        app.router.add_get("/api/stats", self.api_stats)
        app.router.add_get("/api/clients", self.api_clients)
        app.router.add_post("/api/clear", self.api_clear)
        app.router.add_delete("/api/history/{image_id}", self.api_delete)
        app.router.add_get(MEDIA_PREFIX + "{image_id}", self.serve_media)
        app.router.add_get("/download/{image_id}", self.download_one)

        # 网页客户端自身的 WebSocket
        app.router.add_get("/ws", self.ws_page)

        # 静态资源（css / js）
        static_dir = self._web_root()
        if static_dir.exists():
            app.router.add_static("/static/", path=static_dir, show_index=False)

        # 其余请求回落到 index.html（前端单页）
        async def spa_fallback(request: web.Request) -> web.StreamResponse:
            if request.path.startswith(("/api/", "/media/", "/download/", "/ws", "/static/")):
                return web.Response(status=404, text="Not Found")
            return await self.http_index(request)

        app.router.add_route("GET", "/{tail:.*}", spa_fallback)
        return app

    async def root_route(self, request: web.Request) -> web.StreamResponse:
        """
        根路径双职责（单端口 8801 的关键）：

        * ``Upgrade: websocket`` 头 → 交给推送端处理器（clientExample.js 连根路径）
        * 普通浏览器请求 → 302 跳转到 /web
        """
        if request.headers.get("Upgrade", "").lower() == "websocket":
            return await self.ws_handler(request)
        raise web.HTTPFound("/web")

    # ----------------------------- 启动 ----------------------------- #
    async def run(self) -> None:
        app = self.build_http_app()
        self._apps = [app]

        runners: List[web.AppRunner] = []
        try:
            runner = web.AppRunner(app, access_log=None)
            await runner.setup()
            site = web.TCPSite(runner, self.cfg.host, self.cfg.port, reuse_address=True)
            await site.start()
            runners.append(runner)
            self.log(
                f"服务已启动：http://{self.cfg.host}:{self.cfg.port}/web"
                f"（推送 ws://{self.cfg.host}:{self.cfg.port}/）"
            )

            if self.store.enabled:
                self.log(f"图片保存目录：{self.cfg.save_dir}")
            else:
                self.log("图片落盘已关闭（--no-save），仅实时转发")

            self._print_banner()

            if self.cfg.open_browser:
                import webbrowser

                webbrowser.open(
                    f"http://{_local_host(self.cfg.host)}:{self.cfg.port}/web"
                )

            stop = asyncio.Event()
            loop = asyncio.get_running_loop()
            for sig in (signal.SIGINT, signal.SIGTERM):
                with contextlib.suppress(NotImplementedError):
                    loop.add_signal_handler(sig, stop.set)

            await stop.wait()
        finally:
            for runner in runners:
                with contextlib.suppress(Exception):
                    await runner.cleanup()

    def _print_banner(self) -> None:
        host = _local_host(self.cfg.host)
        print("", flush=True)
        print("  ╔══════════════════════════════════════════════╗", flush=True)
        print(f"  ║   {APP_NAME}  v{VERSION:<28} ║", flush=True)
        print("  ╚══════════════════════════════════════════════╝", flush=True)
        print(f"    网页查看   : http://{host}:{self.cfg.port}/web", flush=True)
        print(f"    推送地址   : ws://{host}:{self.cfg.port}/", flush=True)
        print(f"    局域网访问 : 把 {host} 换成本机内网 IP", flush=True)
        print("    按 Ctrl+C 停止服务", flush=True)
        print("", flush=True)


def _local_host(host: str) -> str:
    """0.0.0.0 展示时换成 127.0.0.1，方便直接点开。"""
    return "127.0.0.1" if host in ("0.0.0.0", "::", "") else host


# --------------------------------------------------------------------------- #
# 入口
# --------------------------------------------------------------------------- #
def parse_args(argv: Optional[List[str]] = None) -> ServerConfig:
    base = Path(__file__).parent
    parser = argparse.ArgumentParser(
        description="Moyu WebSocket Server —— 接收 ComfyUI base64 图片并转发给网页客户端",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--host", default="127.0.0.1", help="监听地址，局域网访问用 0.0.0.0")
    parser.add_argument(
        "--port",
        type=int,
        default=8801,
        help="服务端口（推送 ws://host:port/ 与网页 http://host:port/web 共用）",
    )
    # 旧版双端口参数：保留兼容但不再生效（已合并为单端口）
    parser.add_argument("--ws-port", type=int, default=None, help=argparse.SUPPRESS)
    parser.add_argument("--http-port", type=int, default=None, help=argparse.SUPPRESS)
    parser.add_argument(
        "--save-dir", default=str(base / "saved_images"), help="图片保存目录"
    )
    parser.add_argument(
        "--no-save", action="store_true", help="不落盘，仅实时转发（无法保存图片）"
    )
    parser.add_argument(
        "--history-limit", type=int, default=DEFAULT_HISTORY_LIMIT, help="保留的历史图片数"
    )
    parser.add_argument(
        "--max-msg-size",
        type=int,
        default=DEFAULT_MAX_MSG_SIZE,
        help="单条 WebSocket 消息上限（字节）",
    )
    parser.add_argument("--open-browser", action="store_true", help="启动后自动打开网页")
    args = parser.parse_args(argv)

    if args.ws_port is not None or args.http_port is not None:
        print(
            "[提示] 旧版 --ws-port / --http-port 已合并为单端口 --port，本次忽略。",
            flush=True,
        )

    return ServerConfig(
        host=args.host,
        port=max(1, args.port),
        save_dir=Path(args.save_dir).expanduser().resolve(),
        auto_save=not args.no_save,
        history_limit=max(1, args.history_limit),
        max_msg_size=max(1024, args.max_msg_size),
        open_browser=args.open_browser,
    )


def main(argv: Optional[List[str]] = None) -> int:
    cfg = parse_args(argv)
    if not HAS_PILLOW:
        print(
            "[提示] 未安装 Pillow，图片尺寸读取将使用内置解析（功能不受影响）。",
            flush=True,
        )
    server = MoyuServer(cfg)
    try:
        asyncio.run(server.run())
    except KeyboardInterrupt:
        print("\n[服务端] 已停止。", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())