# -*- coding: utf-8 -*-
"""
「已连接客户端列表」功能自检。

模拟多个网页端 + 多个 ComfyUI 推送端接入，验证：
  - 客户端登记 / 注销正确
  - 推送计数累加
  - 有人连上/断开时自动广播 clients 事件
  - 名单接口 /api/clients 内容正确

用法：python tools/verify_clients.py
"""

from __future__ import annotations

import asyncio
import base64
import json
import sys
from pathlib import Path

import aiohttp

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from test_client import make_test_png  # noqa: E402

HTTP = "http://127.0.0.1:8080"
PUSH = "ws://127.0.0.1:8001"
PAGE = "ws://127.0.0.1:8080/ws"

PASS, FAIL = "\033[92m✓\033[0m", "\033[91m✗\033[0m"
results: list[tuple[bool, str, str]] = []


def check(ok: bool, label: str, extra: str = "") -> None:
    results.append((ok, label, extra))
    print(f"  {PASS if ok else FAIL} {label}" + (f"  → {extra}" if extra else ""))


async def recv_until(ws, want: str, timeout: float = 6.0, pred=None):
    """
    循环收消息直到拿到指定 type（ pong / clients / image 等噪音直接跳过）。

    pred: 可选的额外断言函数，用来跳过「过期的」同名消息。
    客户端连接期间会累积多条广播，必须等到内容满足预期的那条。
    """
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        remaining = max(0.3, deadline - loop.time())
        try:
            msg = await asyncio.wait_for(ws.receive(), timeout=remaining)
        except asyncio.TimeoutError:
            return None
        if msg.type != aiohttp.WSMsgType.TEXT:
            continue
        data = json.loads(msg.data)
        if data.get("type") != want:
            continue
        if pred is None or pred(data):
            return data
    return None


async def recv_clients(ws, pred, timeout: float = 8.0):
    """
    等待一条「客户端名单」更新。

    名单随两类消息下发，两种都要接受：
      - type=clients（有人连上/断开）
      - type=image  （推送计数变化，clients 字段同步更新）
    pred 收到的是消息的 clients 数组。
    """
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        remaining = max(0.3, deadline - loop.time())
        try:
            msg = await asyncio.wait_for(ws.receive(), timeout=remaining)
        except asyncio.TimeoutError:
            return None
        if msg.type != aiohttp.WSMsgType.TEXT:
            continue
        data = json.loads(msg.data)
        if data.get("type") not in ("clients", "image"):
            continue
        clients = data.get("clients")
        if not isinstance(clients, list):
            continue
        if pred is None or pred(clients):
            return data
    return None


def has_id(clients, cid: str) -> bool:
    """名单里是否含指定连接。"""
    return any(c.get("id") == cid for c in clients)


def lacks_id(clients, cid: str) -> bool:
    """名单里是否已不含指定连接。"""
    return not has_id(clients, cid)


def mine(clients, ids):
    """只保留本测试自己建立的连接，避免用户真实窗口的连接/断开干扰断言。"""
    return [c for c in clients if c.get("id") in ids]


async def main() -> int:
    print(f"\n客户端列表功能自检 —— {HTTP}\n")

    async with aiohttp.ClientSession() as s:
        # ---------- 1. 基线 ----------
        # 注意：不能假设起始为 0 —— 用户可能正开着网页（预览面板、真实浏览器）。
        # 一律用「只看我自己的连接」的方式断言，避免外部连接抖动干扰。
        print("【基线状态】")
        async with s.get(f"{HTTP}/api/clients") as r:
            d = await r.json()
        check(r.status == 200 and d.get("ok"), "/api/clients 可访问")
        base_total = len(d["clients"])
        check(
            d["stats"]["total_clients"] == base_total,
            "total_clients 与名单长度一致",
            f"total={base_total}",
        )

        # ---------- 2. 网页端 A ----------
        print("\n【网页端 A 接入】")
        webA = await s.ws_connect(f"{PAGE}?name=窗口A")
        helloA = await recv_until(webA, "hello")
        check(helloA is not None, "A 收到 hello（并发发送锁修复后应正常）")
        if helloA is None:
            print("  服务端异常，提前退出")
            return 1

        idA = helloA.get("self_id")
        myids = {idA}

        check(bool(idA), "hello 带 self_id", idA)
        check(idA in [c["id"] for c in helloA["clients"]], "self_id 在名单中")
        check(
            len(helloA["clients"]) == base_total + 1,
            "hello 名单比基线多 1（自己）",
            f"{len(helloA['clients'])} vs 基线 {base_total}",
        )

        meA = next((c for c in helloA["clients"] if c.get("id") == idA), None)
        check(meA is not None, "能按 self_id 找到自己")
        if meA:
            check(meA["name"] == "窗口A", "中文名完整保留（未被截成 A）", repr(meA["name"]))
            check(meA["kind"] == "web", "类型标记为 web", meA["kind"])
            check("connected_seconds" in meA, "含在线时长字段")

        # ---------- 3. 网页端 B ----------
        print("\n【网页端 B 接入 → A 应收到 clients 广播】")
        webB = await s.ws_connect(f"{PAGE}?name=窗口B")
        helloB = await recv_until(webB, "hello")
        idB = helloB.get("self_id") if helloB else None
        myids.add(idB)
        check(helloB is not None and bool(idB), "B 收到 hello 并拿到 self_id", str(idB))

        # 等到「真正包含 B」的那条广播（A 之前可能积压着过期的名单）
        evtA = await recv_clients(webA, lambda cs: has_id(cs, idB))
        check(evtA is not None, "A 收到含 B 的名单更新")
        if evtA is None:
            print("  未等到 B 上线广播，提前退出")
            return 1
        only_mine = mine(evtA["clients"], myids)
        names = sorted(c["name"] for c in only_mine)
        check(names == ["窗口A", "窗口B"], "我自己的两条连接都在名单里", str(names))
        check(
            evtA["stats"]["web_clients"] >= 2,
            "web_clients ≥ 2",
            str(evtA["stats"]["web_clients"]),
        )

        # ---------- 4. ComfyUI 推送端 ----------
        print("\n【ComfyUI 推送端接入】")
        sender = await s.ws_connect(f"{PUSH}?client=ComfyUI-主控")
        await recv_until(sender, "welcome")

        # 等到含推送端的名单（推送端 welcome 不含 self_id，用名字判定）
        evtA = await recv_clients(
            webA, lambda cs: any(c.get("name") == "ComfyUI-主控" for c in cs)
        )
        check(evtA is not None, "A 收到推送端上线的广播")
        if evtA is None:
            print("  未等到推送端广播，提前退出")
            return 1
        # 通过名字定位本测试的推送端（welcome 不返回 self_id）
        mine_sender = [c for c in evtA["clients"] if c["name"] == "ComfyUI-主控"]
        check(len(mine_sender) == 1, "找到本测试的推送端（中文名保留）", str(len(mine_sender)))
        if mine_sender:
            idS = mine_sender[0]["id"]
            myids.add(idS)
            check(mine_sender[0]["kind"] == "sender", "类型标记为 sender", mine_sender[0]["kind"])
            check(mine_sender[0]["sent"] == 0, "初始推送计数为 0", str(mine_sender[0]["sent"]))

        # ---------- 5. 推图，计数应累加 ----------
        print("\n【推送图片 → 计数累加】")
        for i in range(3):
            png = make_test_png(160, 120, seed=i)
            await sender.send_str(json.dumps({
                "image": base64.b64encode(png).decode(),
                "label": f"cli-test-{i}",
            }))
            await recv_until(sender, "ack")

        # 等到「推送端计数已达 3」的那条名单
        evtA = await recv_clients(
            webA,
            lambda cs: any(
                c.get("name") == "ComfyUI-主控" and c.get("sent") == 3 for c in cs
            ),
        )
        check(evtA is not None, "A 收到计数更新事件")
        mine_sender = [c for c in evtA["clients"] if c["name"] == "ComfyUI-主控"] if evtA else []
        check(
            bool(mine_sender) and mine_sender[0]["sent"] == 3,
            "推送计数累加到 3",
            str(mine_sender[0]["sent"]) if mine_sender else "未达 3",
        )

        # ---------- 6. REST 名单 ----------
        print("\n【REST /api/clients】")
        async with s.get(f"{HTTP}/api/clients") as r:
            d = await r.json()
        only_mine = mine(d["clients"], myids)
        check(len(only_mine) == 3, "我的 3 个连接都在 REST 名单里", str(len(only_mine)))
        st = d["stats"]
        check(st["web_clients"] >= 2, "web_clients ≥ 2", str(st["web_clients"]))
        check(st["sender_clients"] >= 1, "sender_clients ≥ 1", str(st["sender_clients"]))
        check(st["total_clients"] >= 3, "total_clients ≥ 3", str(st["total_clients"]))
        times = [c["connected_at"] for c in d["clients"]]
        check(times == sorted(times, reverse=True), "按连接时间倒序")

        # ---------- 7. 断开通知 ----------
        print("\n【B 断开 → A 应收到名单更新】")
        await webB.close()
        evtA = await recv_clients(webA, lambda cs: lacks_id(cs, idB))
        check(evtA is not None, "A 收到 B 断开的广播")
        names = [c["name"] for c in evtA["clients"]]
        check("窗口B" not in names, "B 已从名单移除", str(names))
        check(
            len(mine(evtA["clients"], myids)) == 2,
            "我的连接剩 2 条（A + 推送端）",
            str(len(mine(evtA["clients"], myids))),
        )

        # ---------- 8. 清理还原 ----------
        await webA.close()
        await sender.close()
        await asyncio.sleep(0.8)

        async with s.get(f"{HTTP}/api/clients") as r:
            d = await r.json()
        check(
            len(mine(d["clients"], myids)) == 0,
            "全部断开后我的连接已清空",
            f"残留 {len(mine(d['clients'], myids))}",
        )

    ok = sum(1 for r, _, _ in results if r)
    total = len(results)
    print(f"\n{'=' * 50}\n结果：{ok}/{total} 项通过\n{'=' * 50}")
    return 0 if ok == total else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))