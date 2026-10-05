import { routePartykitRequest } from "partyserver";
import { ROOM_ID_RE } from "@bimpee/shared";
import { createApp } from "./app";
import { isOriginAllowed, type Env } from "./config";
import { getDeps } from "./deps";

export { WorldRoom } from "./room/worldRoom";

let app: ReturnType<typeof createApp> | null = null;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/parties/")) {
      const res = await routePartykitRequest(request, env, {
        onBeforeConnect: async (req, lobby) => {
          if (!ROOM_ID_RE.test(lobby.name)) return new Response("invalid room id", { status: 400 });
          const deps = getDeps(env);
          // Browsers always send Origin on websocket upgrades; refuse foreign sites.
          const origin = req.headers.get("origin");
          if (origin && !isOriginAllowed(deps.config, origin)) return new Response("origin not allowed", { status: 403 });
          // Rooms are unauthenticated and a fresh room id costs a world generation: cap connects per client IP.
          const ip = req.headers.get("cf-connecting-ip");
          if (ip && deps.limiter && !(await deps.limiter.limit(`ws:${ip}`))) return new Response("too many connections, slow down", { status: 429 });
        },
        onBeforeRequest: () => new Response("websocket only", { status: 426 }),
      });
      return res ?? new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
    }
    app ??= createApp(getDeps(env));
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
