# -*- coding: utf-8 -*-
"""
模拟 ComfyUI 客户端 —— 端到端联调脚本。

用法::

    # 发送本地图片
    python tools/test_client.py photo.png photo2.jpg

    # 不带参数则生成一张彩色测试图并发送
    python tools/test_client.py

    # 连续发送 5 张（验证实时推送）
    python tools/test_client.py --count 5 --interval 1.5

    # 发送到自定义地址
    python tools/test_client.py --host 192.168.1.10 --port 8001
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import io
import json
import math
import random
import struct
import sys
import time
import zlib
from pathlib import Path

try:
    import aiohttp
except ImportError:
    sys.stderr.write("[错误] 需要 aiohttp：pip install -r requirements.txt\n")
    raise


# --------------------------------------------------------------------------- #
# 生成一张纯代码绘制的测试图（不依赖任何外部文件）
# --------------------------------------------------------------------------- #
def make_test_png(width: int = 768, height: int = 512, seed: int = 0) -> bytes:
    """生成渐变 + 网格 + 随机光斑的 PNG 字节流（手写 PNG 编码器，免依赖）。"""
    rnd = random.Random(seed)
    cx, cy = rnd.uniform(0.2, 0.8) * width, rnd.uniform(0.2, 0.8) * height

    rows = bytearray()
    for y in range(height):
        rows.append(0)  # filter type 0
        for x in range(width):
            # 双色渐变底
            t = (x / width) * 0.55 + (y / height) * 0.45
            r = int(18 + t * 70)
            g = int(14 + (1 - t) * 60)
            b = int(40 + t * 130)

            # 中心光斑
            d = math.hypot(x - cx, y - cy) / (width * 0.42)
            glow = max(0.0, 1.0 - d) ** 2
            r = min(255, int(r + glow * 235))
            g = min(255, int(g + glow * 120))
            b = min(255, int(b + glow * 90))

            # 网格线
            if x % 64 < 2 or y % 64 < 2:
                r, g, b = min(255, r + 26), min(255, g + 30), min(255, b + 40)

            rows += bytes((r, g, b))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8bit truecolor
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(rows), 6))
        + chunk(b"IEND", b"")
    )


def load_image_bytes(path: Path) -> bytes:
    """优先用 Pillow 转换格式；失败则直接读原始字节。"""
    data = path.read_bytes()
    try:
        from PIL import Image  # type: ignore

        with Image.open(io.BytesIO(data)) as im:
            im.load()
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGB")
            out = io.BytesIO()
            im.save(out, format="PNG")
            return out.getvalue()
    except Exception:
        return data


# --------------------------------------------------------------------------- #
# 发送
# --------------------------------------------------------------------------- #
async def send_once(
    session: aiohttp.ClientSession, url: str, payload: bytes, label: str
) -> bool:
    b64 = base64.b64encode(payload).decode("ascii")
    body = json.dumps({"image": b64, "label": label})

    try:
        async with session.ws_connect(url, timeout=10) as ws:
            await ws.send_str(body)

            # 等服务端回执
            deadline = time.time() + 5
            while time.time() < deadline:
                try:
                    msg = await asyncio.wait_for(ws.receive(), timeout=5)
                except asyncio.TimeoutError:
                    break
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                data = json.loads(msg.data)
                if data.get("type") == "ack" and data.get("ok"):
                    print(
                        f"  ✅ 服务端已接收并落盘：{data.get('filename')} "
                        f"({len(payload) / 1024:.1f} KB)"
                    )
                    return True
                if data.get("type") == "error":
                    print(f"  ❌ 服务端报错：{data.get('message')}")
                    return False
            print("  ⚠️  未收到回执（服务端可能未启用落盘或超时）")
            return False
    except Exception as exc:
        print(f"  ❌ 连接失败：{exc}")
        return False


async def main() -> int:
    parser = argparse.ArgumentParser(description="模拟 ComfyUI 推送 base64 图片")
    parser.add_argument("images", nargs="*", help="要发送的图片文件")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--count", type=int, default=1, help="无图片参数时生成多少张")
    parser.add_argument("--interval", type=float, default=1.0, help="发送间隔（秒）")
    parser.add_argument("--width", type=int, default=768)
    parser.add_argument("--height", type=int, default=512)
    args = parser.parse_args()

    url = f"ws://{args.host}:{args.port}"
    print(f"→ 推送地址：{url}\n")

    ok_count = 0

    async with aiohttp.ClientSession() as session:
        if args.images:
            for p in args.images:
                path = Path(p)
                if not path.exists():
                    print(f"  ⚠️ 文件不存在：{path}")
                    continue
                data = load_image_bytes(path)
                print(f"→ 发送 {path.name}")
                if await send_once(session, url, data, path.stem):
                    ok_count += 1
        else:
            for i in range(max(1, args.count)):
                data = make_test_png(args.width, args.height, seed=i)
                print(f"→ 发送测试图 #{i + 1}")
                if await send_once(session, url, data, f"test-{i + 1}"):
                    ok_count += 1
                if i + 1 < args.count:
                    await asyncio.sleep(args.interval)

    print(f"\n完成：成功 {ok_count} 张")
    print(f"现在打开 http://{args.host}:8080 查看图片")
    return 0 if ok_count else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))