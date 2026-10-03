# -*- coding: utf-8 -*-
"""
端到端链路自检脚本：验证 HTTP 接口 + WebSocket 广播是否全部正常。

用法：python tools/verify.py [http://127.0.0.1:8801]
"""

from __future__ import annotations

import asyncio
import base64
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

import aiohttp

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from test_client import make_test_png  # noqa: E402

PASS, FAIL = "\033[92m✓\033[0m", "\033[91m✗\033[0m"
results: list[tuple[bool, str]] = []


def check(ok: bool, label: str, extra: str = "") -> None:
    results.append((ok, label))
    print(f"  {PASS if ok else FAIL} {label}" + (f"  → {extra}" if extra else ""))


async def main(base: str) -> int:
    parts = urlsplit(base)
    scheme = "wss" if parts.scheme == "https" else "ws"
    host = parts.hostname or "127.0.0.1"
    port = parts.port or 8801
    ws_url = f"{scheme}://{host}:{port}/"          # 推送端（根路径）
    push_url = f"{scheme}://{host}:{port}/ws"       # 网页端

    print(f"\n检查目标：{base}\n")
    print(f"  推送地址 {ws_url}\n  网页地址 {push_url}\n")

    async with aiohttp.ClientSession() as s:
        # ---------- 准备：确保至少有 1 张图（历史是内存索引，重启后为空）----------
        async with s.get(f"{base}/api/history?limit=1") as r:
            if not (await r.json()).get("items"):
                print("历史为空，先推送 1 张测试图…")
                async with s.ws_connect(ws_url) as w:
                    await w.send_str(json.dumps({
                        "image": base64.b64encode(make_test_png(64, 64, seed=0)).decode(),
                        "label": "verify-setup",
                    }))
                    await asyncio.sleep(0.5)

        # ---------- HTTP ----------
        print("【HTTP 接口】")
        for path, label in [
            ("/", "首页 index.html"),
            ("/static/style.css", "样式表"),
            ("/static/app.js", "前端脚本"),
        ]:
            async with s.get(base + path) as r:
                check(r.status == 200, label, f"HTTP {r.status}")

        async with s.get(base + "/api/stats") as r:
            d = await r.json()
            check(r.status == 200 and d.get("ok"), "统计接口 /api/stats", json.dumps(d.get("stats", {}), ensure_ascii=False))
            stats = d.get("stats", {})

        async with s.get(base + "/api/history?limit=5") as r:
            hist = await r.json()
            items = hist.get("items", [])
            check(r.status == 200 and bool(items), f"历史接口 /api/history（{len(items)} 条）")

        if items:
            it = items[0]
            print(f"\n  最新记录：")
            for k in ("id", "filename", "mime", "size", "width", "height", "url"):
                print(f"    {k:12}= {it[k]}")

            async with s.get(base + it["url"]) as r:
                body = await r.read()
                ok = r.status == 200 and r.content_type.startswith("image/")
                check(ok, "读取图片 /media/{id}", f"HTTP {r.status} {r.content_type} {len(body)}B")
                check(body[:8] == b"\x89PNG\r\n\x1a\n", "PNG 魔数校验（文件真实可解码）")

            async with s.get(base + it["download_url"]) as r:
                disp = r.headers.get("Content-Disposition", "")
                await r.read()
                check(r.status == 200 and "attachment" in disp, "下载接口 /download/{id}", disp or "(无头)")

        # ---------- WebSocket ----------
        print("\n【WebSocket 实时推送】")
        async with s.ws_connect(push_url) as ws:
            hello = await asyncio.wait_for(ws.receive(), timeout=5)
            d = json.loads(hello.data)
            check(d.get("type") == "hello", "网页端连接收到 hello", f"携带 {len(d.get('items', []))} 条历史")

        # 起一个"网页客户端"，再从推送端发图，验证广播
        async with s.ws_connect(push_url) as viewer:
            await viewer.receive()  # hello

            async with s.ws_connect(ws_url) as sender:
                png = make_test_png(320, 240, seed=99)
                await sender.send_str(json.dumps({
                    "image": base64.b64encode(png).decode(),
                    "label": "verify-test",
                }))

                # 发送端依次收到 welcome、ack，这里循环直到拿到 ack
                ack = None
                for _ in range(4):
                    msg = await asyncio.wait_for(sender.receive(), timeout=6)
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        continue
                    d = json.loads(msg.data)
                    if d.get("type") == "ack":
                        ack = d
                        break
                check(
                    ack is not None and ack.get("ok"),
                    "发送端收到 ack 回执",
                    (ack or {}).get("filename", "未收到"),
                )

                # 观看端收广播
                got = None
                deadline = asyncio.get_event_loop().time() + 6
                while asyncio.get_event_loop().time() < deadline:
                    msg = await asyncio.wait_for(viewer.receive(), timeout=3)
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        continue
                    d = json.loads(msg.data)
                    if d.get("type") == "image":
                        got = d
                        break
                    if d.get("type") == "pong":
                        continue
                check(got is not None, "网页端收到 image 广播")
                if got:
                    rec = got["record"]
                    check(rec.get("label") == "verify-test", "广播携带正确标签", str(rec.get("label")))
                    check(rec.get("width") == 320 and rec.get("height") == 240,
                          "图片尺寸识别正确", f"{rec.get('width')}x{rec.get('height')}")
                    check(rec.get("size") == len(png), "字节大小一致", f"{rec.get('size')}B")

                    async with s.get(base + rec["url"]) as r:
                        b = await r.read()
                        check(r.status == 200 and b == png, "广播出去的图片可原样取回")

        # ---------- 清理 ----------
        print("\n【清理接口】")
        async with s.delete(base + f"/api/history/{items[0]['id']}") as r:
            d = await r.json()
            check(r.status == 200 and d.get("ok"), "删除单张 /api/history/{id}")

        async with s.post(base + "/api/clear") as r:
            d = await r.json()
            check(r.status == 200 and d.get("ok"), "清空历史 /api/clear", f"删除 {d.get('removed')} 张")

    ok = sum(1 for r, _ in results if r)
    total = len(results)
    print(f"\n{'=' * 46}\n结果：{ok}/{total} 项通过\n{'=' * 46}")
    return 0 if ok == total else 1


if __name__ == "__main__":
    base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8801"
    raise SystemExit(asyncio.run(main(base.rstrip("/"))))