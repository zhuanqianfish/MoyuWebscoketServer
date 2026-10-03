// MOYU-JS Bridge · 路 B 指令服务器示例（Cloudflare Worker，原生 WebSocket）
// ============================================================================
// 作用：给油猴脚本提供一条独立的指令通道。脚本面板第 ⑥ 区填
//   wss://<你的worker>.workers.dev/cmd  + token，点"连接"。
// 下发指令：POST https://<你的worker>.workers.dev/push  (Header: x-token: <token>)
//   Body: {"name":"run_generate","parameter":{},"other":{}}
//   Body: {"name":"run_workflow","parameter":{"prompt":{...API格式...}},"other":{}}
//   Body: {"name":"run_workflow","parameter":{"workflow":{...UI格式...}},"other":{}}
//
// 部署：wrangler deploy，或 Dashboard → Workers → Create → 粘贴本文件。
// 环境变量：CMD_TOKEN（鉴权 token，脚本面板里填同一个；留空则不鉴权——不建议）。
//
// 注意：SESSIONS 记在单个 isolate 的内存里。个人用（一个浏览器连着）完全够用；
// 若多实例/多用户，请换成 Durable Object 集中管理连接。

const SESSIONS = new Set();

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const token = env.CMD_TOKEN || "";

    // 脚本连这里收指令
    if (url.pathname === "/cmd") {
      if (req.headers.get("Upgrade") !== "websocket")
        return new Response("需要 WebSocket 连接", { status: 400 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      SESSIONS.add(server);
      server.addEventListener("message", (ev) => {
        let m = null;
        try { m = JSON.parse(ev.data); } catch { server.close(4403, "bad json"); return; }
        // 脚本连上后第一条消息应为 {"auth":"<token>"}
        if (token && m.auth !== token) { server.close(4401, "bad token"); return; }
        try { server.send(JSON.stringify({ ok: true, hello: "moyu-cmd" })); } catch {}
      });
      const drop = () => SESSIONS.delete(server);
      server.addEventListener("close", drop);
      server.addEventListener("error", drop);
      return new Response(null, { status: 101, webSocket: client });
    }

    // 你（或你的自动化）调这里下发指令
    if (url.pathname === "/push" && req.method === "POST") {
      if (token && req.headers.get("x-token") !== token)
        return new Response("bad token", { status: 401 });
      let cmd = null;
      try { cmd = await req.json(); } catch { return new Response("bad json", { status: 400 }); }
      if (!cmd || typeof cmd.name !== "string")
        return new Response('body 需要 {"name":...,"parameter":{},"other":{}}', { status: 400 });
      const msg = JSON.stringify({
        name: cmd.name,
        parameter: cmd.parameter || {},
        other: cmd.other || {},
      });
      let n = 0;
      for (const s of [...SESSIONS]) {
        try { s.send(msg); n++; } catch { SESSIONS.delete(s); }
      }
      return Response.json({ ok: true, delivered: n });
    }

    if (url.pathname === "/moyu/ping") {
      return Response.json({ ok: true, sessions: SESSIONS.size });
    }
    return new Response("moyu-cmd: /cmd(ws) /push(http post) /moyu/ping", { status: 404 });
  },
};
