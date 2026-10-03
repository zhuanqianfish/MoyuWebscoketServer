# -*- coding: utf-8 -*-
"""
模拟 ComfyUI-JS-Bridge 油猴脚本的连接受理行为，验证端到端指令链路。

复刻脚本的关键逻辑：
  1. 连接时 URL 带 clientId（服务端沿用为登记 id）
  2. 读 welcome 取服务端 id
  3. 控制台消息（type 无 name）静默忽略
  4. 指令按 to 命中本机（自报 id 或服务端 id 任一命中即执行）
  5. 执行后必须发 command_result 回执

用法：python tools/verify_bridge_client.py
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import aiohttp

HTTP = "http://127.0.0.1:8801"
PAGE = "ws://127.0.0.1:8801/ws"
SELF_ID = "cselftest1234"          # 模拟脚本 localStorage 里的稳定 clientId

PASS, FAIL = "\033[92m✓\033[0m", "\033[91m✗\033[0m"
results: list[tuple[bool, str, str]] = []


def check(ok: bool, label: str, extra: str = "") -> None:
    results.append((ok, label, extra))
    print(f"  {PASS if ok else FAIL} {label}" + (f"  → {extra}" if extra else ""))


def section(t: str) -> None:
    print(f"\n【{t}】")


async def recv(ws, want, timeout=5.0, pred=None):
    """
    循环收消息直到命中 —— 跳过不匹配的，而不是读一条就返回。

    带缓冲：读到的不匹配消息先存起来，下次调用先翻缓冲。
    不这样做的话，先到的 clients 广播会被后续带 pred 的 recv 吃掉，
    导致「明明收到过却说没收到」——排查时极具误导性。
    """
    buf = getattr(ws, "_moyu_buf", None)
    if buf is None:
        buf = []
        try:
            ws._moyu_buf = buf
        except Exception:
            pass

    def take():
        for i, d in enumerate(buf):
            if d.get("type") == want and (pred is None or pred(d)):
                return buf.pop(i)
        return None

    hit = take()
    if hit is not None:
        return hit

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
        if d.get("type") == want and (pred is None or pred(d)):
            return d
        buf.append(d)
    return None


class BridgeSim:
    """模拟油猴脚本的 WS 客户端行为。"""

    def __init__(self, url: str, token: str = "", client_id: str = SELF_ID):
        self.base = url
        self.token = token
        self.client_id = client_id
        self.server_client_id = ""
        self.ws = None
        self.session = None
        self._task = None
        self.executed: list[tuple[str, dict]] = []   # (name, parameter)
        self.replies: list[str] = []                 # 尝试回执的指令名
        self.send_errors: list[str] = []             # 回执发送失败的原因
        self.pump_errors: list[str] = []             # 接收循环异常

    def build_url(self) -> str:
        base = self.base.split("#")[0]
        import re
        if re.search(r"[?&](clientId|cid)=", base):
            return re.sub(r"([?&])(clientId|cid)=[^&]*",
                          lambda m: f"{m.group(1)}{m.group(2)}={self.client_id}", base)
        return f"{base}{'&' if '?' in base else '?'}clientId={self.client_id}"

    async def connect(self) -> None:
        self.session = aiohttp.ClientSession()
        self.ws = await self.session.ws_connect(self.build_url())
        # 读 welcome，取服务端 id
        for _ in range(5):
            m = await recv(self.ws, "welcome", timeout=5)
            if m:
                self.server_client_id = m.get("client_id", "")
                break
        # 后台持续收消息 —— 真实脚本靠 onmessage 常驻，模拟器也必须这样
        self._task = asyncio.create_task(self._pump())

    async def _pump(self) -> None:
        """常驻接收循环，等价于脚本的 ws.onmessage。"""
        try:
            async for msg in self.ws:
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                try:
                    await self.handle(json.loads(msg.data))
                except Exception as e:
                    self.pump_errors.append(str(e))
        except asyncio.CancelledError:
            raise
        except Exception as e:
            # 捕获：连接被服务端顶替/关闭时 async for 会抛错，
            # 这类异常要能看到，否则「不回执」会变成无头案
            self.pump_errors.append(f"{type(e).__name__}: {e}")

    async def close(self) -> None:
        if self._task:
            self._task.cancel()
        if self.ws:
            await self.ws.close()
        if self.session:
            await self.session.close()

    async def handle(self, d: dict) -> None:
        """复刻脚本的 onmessage 分发逻辑。"""
        if d.get("type") == "welcome" and d.get("client_id"):
            self.server_client_id = d["client_id"]
            return
        # 控制台/状态类消息：type 是字符串但没有 name → 静默忽略
        if isinstance(d.get("type"), str) and not isinstance(d.get("name"), str):
            return
        name = d.get("name")
        if not isinstance(name, str) or not name:
            return
        # to 定向：自报 id 或服务端 id 任一命中即执行
        to = d.get("to")
        if isinstance(to, list) and to:
            mine = {self.client_id, self.server_client_id}
            if not any(str(t) in mine for t in to):
                return          # 未命中 → 静默跳过（这是旧版卡住的地方）
        param = d.get("parameter") if isinstance(d.get("parameter"), dict) else {}
        self.executed.append((name, param))
        # 回执（旧版完全没有这一步 → 网页端永远等不到）
        self.replies.append(name)
        try:
            await self.ws.send_str(json.dumps({
                "type": "command_result",
                "name": name,
                "from": [self.client_id],
                "result": {"ok": True, "detail": f"模拟执行 {name}"},
            }))
        except Exception as e:
            self.send_errors.append(f"{name}: {e}")


async def main() -> int:
    print(f"\n油猴脚本（ComfyUI-JS-Bridge）链路模拟 —— {HTTP}\n")

    bridge = BridgeSim(f"{PAGE.replace('/ws', '')}/")
    await bridge.connect()

    section("连接与 id 对齐")
    async with aiohttp.ClientSession() as s:
        async with s.get(f"{HTTP}/api/clients") as r:
            clients = (await r.json())["clients"]

    entry = next((c for c in clients if c["id"] == SELF_ID), None)
    check(entry is not None, "服务端沿用了脚本自报的 clientId", SELF_ID)
    if entry:
        check(entry["kind"] == "sender", "登记为推送端", entry["kind"])
        check(bridge.server_client_id == SELF_ID,
              "welcome 回显的 id 与自报一致",
              f"welcome={bridge.server_client_id}")
    check(bool(bridge.server_client_id), "脚本拿到了服务端 id", bridge.server_client_id)

    section("指令执行与回执")
    web_session = aiohttp.ClientSession()
    web = await web_session.ws_connect(f"{PAGE}?name=控制台")
    await recv(web, "hello")

    # 用户实际发的那条：parameter 为空
    cmd = {
        "name": "run_workflow",
        "parameter": {},
        "other": {},
        "from": ["server"],
        "to": [SELF_ID],
    }
    await web.send_str(json.dumps({"type": "command", **cmd}))

    delivered = await recv(
        web, "command_result",
        pred=lambda d: (d.get("result") or {}).get("delivered") is not None,
    )
    check(delivered is not None and delivered.get("ok"), "服务端投递成功",
          str(delivered and delivered.get("result")))

    ack = await recv(web, "command_result",
                     pred=lambda d: not (d.get("result") or {}).get("awaiting_ack"),
                     timeout=8)
    check(ack is not None, "客户端回了 command_result（旧版缺这一步）",
          f"已回执={bridge.replies} 发送错误={bridge.send_errors} "
          f"pump错误={bridge.pump_errors}")
    if ack:
        check(ack.get("ok") is True, "回执标记成功")
        detail = (ack.get("result") or {}).get("detail", "")
        check("run_workflow" in str(detail), "回执内容含指令名", str(detail))
        check((ack.get("command") or {}).get("name") == "run_workflow",
              "回执带上了指令名（网页端据此显示）",
              str(ack.get("command")))
        check(bridge.executed and bridge.executed[-1][0] == "run_workflow",
              "脚本确实执行了该指令", str(bridge.executed))

    section("to 定向：命中服务端 id 也能执行")
    bridge.executed.clear()
    await web.send_str(json.dumps({
        "type": "command", "name": "run_generate", "parameter": {},
        "other": {}, "from": ["server"], "to": [bridge.server_client_id or SELF_ID],
    }))
    ack = await recv(web, "command_result",
                     pred=lambda d: not (d.get("result") or {}).get("awaiting_ack"),
                     timeout=8)
    check(ack is not None, "按服务端 id 投递也能收到回执")
    check(any(n == "run_generate" for n, _ in bridge.executed), "run_generate 已执行",
          str([n for n, _ in bridge.executed]))

    section("to 定向：不命中本机则跳过")
    bridge.executed.clear()
    await web.send_str(json.dumps({
        "type": "command", "name": "run_generate", "parameter": {},
        "other": {}, "from": ["server"], "to": ["别人的id123"],
    }))
    await asyncio.sleep(1.2)
    check(not bridge.executed, "非本机指令被正确跳过", str(bridge.executed))

    section("控制台消息不误触发")
    bridge.executed.clear()
    await web.send_str(json.dumps({
        "type": "command_log", "direction": "out",
        "command": {"name": "log_only"}, "delivered": 1, "targets": ["x"],
    }))
    await asyncio.sleep(1.0)
    check(not bridge.executed, "command_log 没有被当成指令执行", str(bridge.executed))

    section("ping / whoami 握手指令")
    for name in ("ping", "whoami"):
        bridge.executed.clear()
        await web.send_str(json.dumps({
            "type": "command", "name": name, "parameter": {},
            "other": {}, "from": ["server"], "to": [SELF_ID],
        }))
        ack = await recv(
            web, "command_result",
            pred=lambda d, n=name: (
                not (d.get("result") or {}).get("awaiting_ack")
                and (d.get("command") or {}).get("name") == n
            ),
            timeout=8,
        )
        check(ack is not None, f"{name} 收到回执", str(ack and (ack.get("result") or {})))
        check(any(n == name for n, _ in bridge.executed), f"{name} 已执行",
              str([n for n, _ in bridge.executed]))

    await web.close()
    await web_session.close()
    await bridge.close()

    ok = sum(1 for r, _, _ in results if r)
    total = len(results)
    print(f"\n{'=' * 50}\n结果：{ok}/{total} 项通过\n{'=' * 50}")
    return 0 if ok == total else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
