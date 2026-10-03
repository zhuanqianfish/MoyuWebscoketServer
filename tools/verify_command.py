# -*- coding: utf-8 -*-
"""
指令服务器功能自检。

覆盖：
  - 指令结构规范化（from/to/parameter/other 容错）
  - 带 to → 转发给指定客户端（按 id / 按名字）
  - 不带 to → 服务端执行内置指令
  - 未知指令 → 明确报错而不是静默
  - 目标不在线 → 回执报错
  - 客户端回执 command_result 转发
  - 两个工作流按钮下发的指令格式

用法：python tools/verify_command.py
"""

from __future__ import annotations

import asyncio
import base64
import json
import sys
from pathlib import Path

import aiohttp

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server as S  # noqa: E402
from test_client import make_test_png  # noqa: E402

HTTP = "http://127.0.0.1:8801"
PAGE = "ws://127.0.0.1:8801/ws"
PUSH = "ws://127.0.0.1:8801/"

PASS, FAIL = "\033[92m✓\033[0m", "\033[91m✗\033[0m"
results: list[tuple[bool, str, str]] = []


def check(ok: bool, label: str, extra: str = "") -> None:
    results.append((ok, label, extra))
    print(f"  {PASS if ok else FAIL} {label}" + (f"  → {extra}" if extra else ""))


def section(t: str) -> None:
    print(f"\n【{t}】")


async def recv_until(ws, want: str, timeout: float = 6.0, pred=None):
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
        data = json.loads(msg.data)
        if data.get("type") != want:
            continue
        if pred is None or pred(data):
            return data
    return None


async def main() -> int:
    print(f"\n指令服务器自检 —— {HTTP}\n")

    # ---------- 1. 规范化（纯函数，无需服务） ----------
    section("指令结构规范化")
    n = S.MoyuServer.normalize_command
    c = n({"name": "run", "parameter": {"a": 1}, "other": {}, "from": "server", "to": ["x", "y"]})
    check(c["name"] == "run", "name 透传", c["name"])
    check(c["from"] == ["server"], "字符串 from 归一为数组", str(c["from"]))
    check(c["to"] == ["x", "y"], "to 数组保留", str(c["to"]))
    check(c["parameter"] == {"a": 1}, "parameter 保持对象")

    c = n({"name": "a", "parameter": '{"k":1}'})
    check(c["parameter"] == {"k": 1}, "字符串 parameter 自动解析 JSON", str(c["parameter"]))

    c = n({"name": "a", "to": "solo"})
    check(c["to"] == ["solo"], "单个字符串 to 归一为数组", str(c["to"]))

    c = n({"name": "a", "parameter": "[1,2]"})
    check(c["parameter"] == {"value": [1, 2]}, "数组 parameter 包进 value", str(c["parameter"]))

    c = n({"name": "a"})
    check(c["to"] == [] and c["from"] == [], "缺省 from/to 为空数组（→ 服务端执行）")

    # ---------- 2. 真实链路 ----------
    async with aiohttp.ClientSession() as s:
        section("网页端 + 推送端接入")
        web = await s.ws_connect(f"{PAGE}?name=控制台")
        hello = await recv_until(web, "hello")
        check(hello is not None, "网页端收到 hello")
        my_id = hello.get("self_id") if hello else None

        snd = await s.ws_connect(f"{PUSH}?client=ComfyUI-测试")
        await recv_until(snd, "welcome")

        async with s.get(f"{HTTP}/api/clients") as r:
            d = await r.json()
        ids = {c["name"]: c["id"] for c in d["clients"]}
        check("ComfyUI-测试" in ids, "推送端已登记", str(list(ids)))
        sender_id = ids.get("ComfyUI-测试")

        # ---------- 3. 带 to → 转发 ----------
        section("带 to：转发给指定客户端")
        cmd = {
            "name": "run_workflow",
            "parameter": {"workflow": {"nodes": []}},
            "other": {"source": "imported"},
            "from": ["server"],
            "to": [sender_id],
        }
        await web.send_str(json.dumps({"type": "command", "command": cmd}))

        got = await recv_until(snd, "command")
        check(got is not None, "推送端收到指令")
        if got:
            g = got  # 平铺：指令字段直接在顶层
            check(g["name"] == "run_workflow", "name 一致", g["name"])
            check(g["from"] == ["server"], "from 为 server", str(g["from"]))
            check(g["parameter"] == {"workflow": {"nodes": []}}, "parameter 原样送达")
            check(g["other"] == {"source": "imported"}, "other 原样送达")

        ack = await recv_until(web, "command_result")
        check(ack is not None, "发送方收到回执")
        check(ack and ack["ok"] is True, "回执标记成功", str(ack and ack["ok"]))
        check(
            ack and ack["result"].get("delivered") == 1,
            "回执含送达数量",
            str(ack and ack["result"]),
        )

        # ---------- 4. 按名字寻址 ----------
        section("按名字寻址（to 填名字而非 id）")
        await web.send_str(json.dumps({
            "type": "command",
            "command": {"name": "ping_client", "from": ["server"], "to": ["ComfyUI-测试"]},
        }))
        got = await recv_until(snd, "command")
        check(got is not None, "按名字也能送达", got.get("name", "") if got else "")
        await recv_until(web, "command_result")

        # ---------- 5. 不带 to → 服务端执行 ----------
        section("不带 to：服务端执行内置指令")
        await web.send_str(json.dumps({
            "type": "command",
            "command": {"name": "ping", "parameter": {}, "from": ["web窗口"]},
        }))
        res = await recv_until(web, "command_result")
        check(res is not None, "服务端执行后回执")
        check(res and res["ok"] is True, "执行成功", str(res and res["result"]))
        check(res and res["result"].get("pong") is True, "返回 pong", str(res and res["result"]))

        for name, key in (("stats", "stats"), ("clients", "clients")):
            await web.send_str(json.dumps({
                "type": "command",
                "command": {"name": name, "from": ["web窗口"]},
            }))
            r2 = await recv_until(web, "command_result")
            check(r2 and r2["ok"] and key in r2["result"], f"内置指令 {name} 可用",
                  str(r2 and list(r2["result"].keys())))

        # ---------- 6. 未知指令 ----------
        section("未知指令")
        await web.send_str(json.dumps({
            "type": "command",
            "command": {"name": "根本不存在的指令", "from": ["web窗口"]},
        }))
        res = await recv_until(web, "command_result")
        check(res is not None, "未知指令有回执")
        check(res and res["ok"] is False, "标记为失败", str(res and res["ok"]))
        check(res and "error" in res["result"], "回执含 error 字段")
        check(
            res and "available" in res["result"],
            "回执列出可用指令（便于排查）",
            str(res and res["result"].get("available")),
        )

        # ---------- 7. 目标不在线 ----------
        section("目标客户端不在线")
        await web.send_str(json.dumps({
            "type": "command",
            "command": {"name": "x", "from": ["server"], "to": ["查无此客户端"]},
        }))
        res = await recv_until(web, "command_result")
        check(res is not None, "不在线时有回执")
        check(res and res["ok"] is False, "标记为失败")

        # ---------- 8. 客户端回执转发 ----------
        section("客户端执行回执 → 转发给网页端")
        await snd.send_str(json.dumps({
            "type": "command_result",
            "command": {"name": "run_current_workflow"},
            "from": ["ComfyUI-测试"],
            "result": {"ok": True, "detail": "已执行当前工作流"},
        }))
        res = await recv_until(web, "command_result")
        check(res is not None, "网页端收到客户端回执")
        check(
            res and res["result"].get("detail") == "已执行当前工作流",
            "回执内容透传",
            str(res and res["result"]),
        )

        # ---------- 9. 客户端发指令给网页端 ----------
        section("客户端 → 网页端 转发")
        await snd.send_str(json.dumps({
            "type": "command",
            "command": {
                "name": "hello_page",
                "parameter": {"text": "hi"},
                "from": ["ComfyUI-测试"],
                "to": [my_id],
            },
        }))
        got = await recv_until(web, "command")
        check(got is not None, "网页端收到客户端发来的指令")
        check(got and got["name"] == "hello_page", "指令名正确")
        check(
            got and got["from"] == ["ComfyUI-测试"],
            "from 标明了来源客户端",
            str(got and got["from"]),
        )

        # ---------- 10. 无 to 的客户端消息 → 服务端执行 ----------
        section("客户端发无 to 指令 → 服务端执行")
        # 先排空上一节可能残留的回执，避免读到旧消息
        while await recv_until(snd, "command_result", timeout=0.4):
            pass
        await snd.send_str(json.dumps({
            "type": "command",
            "command": {"name": "echo", "parameter": {"k": 1}, "from": ["ComfyUI-测试"]},
        }))
        res = await recv_until(snd, "command_result")
        check(res is not None, "执行结果回给发起客户端")
        check(
            bool(res) and res.get("ok") and res["result"].get("echo") == {"k": 1},
            "echo 原样返回参数",
            str(res and res["result"]),
        )

        # ---------- 11. 协议形态：顶层有 name，无信封 ---------- #
        section("协议形态检查（顶层 name，无 command 信封）")
        await web.send_str(json.dumps({
            "name": "flat_cmd",
            "parameter": {"a": 1},
            "other": {},
            "from": ["server"],
            "to": [sender_id],
        }))
        got = await recv_until(snd, "command")
        check(got is not None, "平铺格式的指令能被识别并送达")
        check(got and "command" not in got, "下发时没有 command 信封",
              str(list(got.keys())) if got else "")
        check(got and got.get("name") == "flat_cmd", "顶层直接有 name", str(got and got.get("name")))
        check(
            got and got.get("from") == ["server"] and got.get("to") == [sender_id],
            "from/to 也在顶层",
            f"from={got and got.get('from')} to={got and got.get('to')}",
        )
        check(got and got.get("parameter") == {"a": 1}, "parameter 在顶层且原样送达")
        check(got and got.get("type") == "command", "附带 type 供快速筛选")

        # ---------- 12. 向后兼容：仍接受旧信封格式 ---------- #
        section("兼容旧信封格式")
        await web.send_str(json.dumps({
            "type": "command",
            "command": {"name": "legacy", "from": ["server"], "to": [sender_id]},
        }))
        got = await recv_until(snd, "command")
        check(got is not None, "旧信封格式仍可用")
        check(got and got.get("name") == "legacy", "信封内指令被正确取出")

        # ---------- 13. 推送端不该收到控制台日志 ---------- #
        section("日志隔离（推送端不收 command_log）")
        while await recv_until(snd, "command_log", timeout=0.4):
            pass
        await web.send_str(json.dumps({
            "name": "log_probe",
            "from": ["server"],
            "to": [sender_id],
        }))
        await recv_until(snd, "command")
        await recv_until(web, "command_result")
        leaked = await recv_until(snd, "command_log", timeout=2.0)
        check(leaked is None, "推送端收不到 command_log 日志",
              "泄漏: " + str(leaked) if leaked else "干净")
        got = await recv_until(
            web, "command_log",
            pred=lambda d: d.get("command", {}).get("name") == "log_probe",
        )
        check(got is not None, "网页端能收到对应指令的 command_log")

        # ---------- 14. 推图与指令不冲突（name 可当图片标签）---------- #
        section("推图与指令共存（name 当标签不误判）")

        async with s.get(f"{HTTP}/api/history?limit=200") as r:
            before = len((await r.json())["items"])
        # 这条同时有 image 和 name —— 必须按推图处理，不能当成指令
        await snd.send_str(json.dumps({
            "image": base64.b64encode(make_test_png(80, 60, seed=7)).decode(),
            "name": "这是图片标签不是指令",
        }))
        await asyncio.sleep(1.2)
        async with s.get(f"{HTTP}/api/history?limit=200") as r:
            after = len((await r.json())["items"])
        check(after == before + 1, "带 name 的推图被正确当作图片收下",
              f"{before} → {after}")
        # 不应产生任何指令回执/错误
        stray = await recv_until(snd, "command_result", timeout=1.2)
        check(stray is None, "推图没有误触发指令执行", str(stray) if stray else "无")

        # ---------- 15. 前端两个按钮的指令格式 ---------- #
        section("工作流按钮下发的指令格式")
        cur = {
            "name": "run_current_workflow",
            "parameter": {},
            "other": {"source": "current", "by": "控制台"},
            "from": ["server"],
            "to": [sender_id],
        }
        await web.send_str(json.dumps({"type": "command", **cur}))
        got = await recv_until(snd, "command")
        check(got is not None, "「运行当前工作流」指令送达")
        check(got and got["name"] == "run_current_workflow", "指令名符合约定")
        check(got and got["parameter"] == {}, "不携带工作流 JSON")
        check(got and got["other"].get("source") == "current", "other 标记来源")

        imp = {
            "name": "run_workflow",
            "parameter": {"workflow": {"last_node_id": 3, "nodes": [{}, {}, {}]}},
            "other": {"source": "imported", "by": "控制台"},
            "from": ["server"],
            "to": [sender_id],
        }
        await web.send_str(json.dumps({"type": "command", **imp}))
        got = await recv_until(snd, "command")
        check(got is not None, "「运行导入的工作流」指令送达")
        check(got and got["parameter"]["workflow"]["nodes"], "携带了工作流内容")
        check(got and got["other"].get("source") == "imported", "other 标记来源")

        # ---------- 清理 ----------
        await web.close()
        await snd.close()
        await asyncio.sleep(0.5)

    ok = sum(1 for r, _, _ in results if r)
    total = len(results)
    print(f"\n{'=' * 50}\n结果：{ok}/{total} 项通过\n{'=' * 50}")
    return 0 if ok == total else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))