# MOYU-JS Bridge · 路 A 服务端示例（仅自建 ComfyUI 可用）
# ============================================================
# 作用：让 ComfyUI 服务端能经 /ws 向装了 MOYU-JS Bridge 油猴脚本的浏览器下发指令。
# 脚本收到 ws 消息 {"type":"moyu_cmd","data":{"name":...,"parameter":{},"other":{}}}
# 后会自动分发执行，无需在脚本面板里做任何配置。
#
# 安装：把本文件放进 ComfyUI/custom_nodes/moyu_cmd/__init__.py（新建同名文件夹），重启 ComfyUI。
#
# 下发指令（任选其一）：
#   1) HTTP：POST http://127.0.0.1:8188/moyu/cmd
#      Body: {"name":"run_generate","parameter":{},"other":{}}
#      Body: {"name":"run_workflow","parameter":{"prompt":{...API格式...}},"other":{}}
#   2) Python 里直接调：
#      from server import PromptServer
#      PromptServer.instance.send_sync("moyu_cmd",
#          {"name": "run_generate", "parameter": {}, "other": {}})
#
# 注意：LiblibArt / RunningHub 是别人的服务器，装不上扩展——那种场景请用路 B
# （脚本直连自建指令服务器，见 ../samples/moyu-cmd-server-worker.js）。

from aiohttp import web
from server import PromptServer

WS_TYPE = "moyu_cmd"


def push_command(name, parameter=None, other=None):
    """经 /ws 向所有连接的客户端广播一条指令。"""
    PromptServer.instance.send_sync(WS_TYPE, {
        "name": name,
        "parameter": parameter or {},
        "other": other or {},
    })


@PromptServer.instance.routes.post("/moyu/cmd")
async def moyu_cmd(request):
    try:
        cmd = await request.json()
    except Exception:
        return web.Response(status=400, text="body 必须是 JSON")
    if not isinstance(cmd, dict) or not cmd.get("name"):
        return web.Response(status=400, text='需要 {"name":...,"parameter":{},"other":{}}')
    push_command(cmd.get("name"), cmd.get("parameter"), cmd.get("other"))
    return web.json_response({"ok": True, "pushed": cmd.get("name")})


@PromptServer.instance.routes.get("/moyu/ping")
async def moyu_ping(request):
    return web.json_response({"ok": True, "ws_type": WS_TYPE})


# ComfyUI custom_nodes 规范（本扩展不提供节点，仅注册路由）
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
