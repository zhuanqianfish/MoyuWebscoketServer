# -*- coding: utf-8 -*-
"""
指令投递探针 —— 排查「客户端已连接但指令无响应」。

以只读方式观察：另开一个网页端连接，向指定客户端发一条 echo 指令，
然后如实打印该客户端「有没有收到」「有没有回执」。

用法：
    python tools/probe_command.py                # 探测所有推送端
    python tools/probe_command.py <id>           # 探测指定 id
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import aiohttp

HTTP = "http://127.0.0.1:8801"
PAGE = "ws://127.0.0.1:8801/ws"


async def recv(ws, want, timeout=2.5, pred=None):
    """
    收消息直到拿到指定 type 且满足 pred。

    注意：连接上会先来 clients / command_log 等广播，
    必须跳过而不是丢弃，否则会把后续消息读错位。
    """
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        left = max(0.3, deadline - loop.time())
        try:
            msg = await asyncio.wait_for(ws.receive(), timeout=left)
        except asyncio.TimeoutError:
            return None
        if msg.type != aiohttp.WSMsgType.TEXT:
            continue
        d = json.loads(msg.data)
        if d.get("type") != want:
            continue
        if pred is None or pred(d):
            return d
    return None


def is_real_ack(d):
    """真正的客户端回执（排除「已送达」这种投递提示）"""
    return not (d.get("result") or {}).get("awaiting_ack")


async def main() -> int:
    target = sys.argv[1] if len(sys.argv) > 1 else None
    async with aiohttp.ClientSession() as s:
        async with s.get(f"{HTTP}/api/clients") as r:
            clients = (await r.json())["clients"]

        senders = [c for c in clients if c["kind"] == "sender"]
        if not senders:
            print("没有推送端在线。")
            return 1

        print("推送端列表：")
        for c in senders:
            mark = "  ← 指定" if target == c["id"] else ""
            print(f"  id={c['id']}  {c['name']:16} 已推 {c['sent']:3d} 张  "
                  f"UA={c['user_agent'][:40]}{mark}")

        if target:
            picked = [c for c in senders if c["id"] == target]
            if not picked:
                print(f"\n指定的 id {target} 不在在线列表里。")
                return 1
        else:
            picked = senders

        for c in picked:
            print(f"\n=== 探测 {c['name']}（id={c['id']}）===")
            web = await s.ws_connect(f"{PAGE}?name=探针")
            await recv(web, "hello")

            probe_cmd = {
                "name": "echo",
                "parameter": {"probe": "hello-from-probe"},
                "other": {},
                "from": ["server"],
                "to": [c["id"]],
            }
            await web.send_str(json.dumps({"type": "command", **probe_cmd}))

            # 第一条 command_result 是「已送达」提示（awaiting_ack），
            # 后面才是客户端真正的回执 —— 要区分开
            delivered = await recv(
                web, "command_result", timeout=4,
                pred=lambda d: (d.get("result") or {}).get("delivered") is not None
                or not d.get("ok"),
            )
            if delivered is None:
                print("  ✗ 服务端没有回执，指令可能没发出去")
                await web.close()
                continue

            r = delivered.get("result", {})
            print(f"  服务端投递: ok={delivered.get('ok')} "
                  f"delivered={r.get('delivered')} targets={r.get('targets')}")

            if not delivered.get("ok"):
                print(f"  ✗ 投递失败：{r.get('error')}")
                await web.close()
                continue

            # 等客户端真正的回执
            ack = await recv(web, "command_result", timeout=8, pred=is_real_ack)
            if ack is None:
                print("  ✗ 客户端没有回执 → 指令已送达，但客户端未处理/未回传")
                print("     可能原因：")
                print("       1. 客户端脚本没有实现指令处理（只处理推图）")
                print("       2. 客户端没重新加载最新脚本")
                print("       3. 客户端把消息路由到了别处")
                print("     验证：让客户端对 name=whoami 或 name=echo 回一条 command_result")
            else:
                print(f"  ✓ 客户端已回执: "
                      f"{json.dumps(ack.get('result'), ensure_ascii=False)[:160]}")

            await web.close()
            await asyncio.sleep(0.3)

    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
