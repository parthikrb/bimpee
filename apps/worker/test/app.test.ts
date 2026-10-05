import { describe, expect, it } from "vitest";
import {
  DirectorResponseSchema,
  HealthResponseSchema,
  LeaderboardResponseSchema,
  PlayerMemorySchema,
  RunResultSchema,
  WorldResponseSchema,
} from "@bimpee/shared";
import { createApp, type Deps } from "../src/app";
import { MockAiService } from "../src/ai/mock";
import type { AiService } from "../src/ai/types";
import { GuestAuth, SupabaseAuth } from "../src/auth";
import { loadConfig } from "../src/config";
import { MemoryLimiter } from "../src/limiter";
import { InMemoryRepo } from "../src/memory/inMemory";
import { report, telemetry, world } from "./helpers";

const GUEST = "0b0e5b8e-6a51-4c3e-9a8e-3f1f2f0c9d11";
const TOKEN = "valid-token-0123456789abcdef";
const USER = "6f9e2f0c-1a2b-4c3d-8e9f-0a1b2c3d4e5f";

function setup(over: Partial<Deps> = {}, env: Record<string, string> = {}) {
  const config = loadConfig(env);
  const deps: Deps = { ai: new MockAiService(config.models), memory: new InMemoryRepo(), auth: new GuestAuth(), config, ...over };
  const app = createApp(deps);
  const req = (path: string, init: RequestInit & { json?: unknown } = {}, headers: Record<string, string> = { "x-bimpee-guest": GUEST }) =>
    app.request(path, {
      ...init,
      headers: { "content-type": "application/json", ...headers, ...(init.headers as Record<string, string>) },
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    });
  return { app, deps, req };
}

/** Parses an SSE body into its data payloads. */
async function sse(res: Response) {
  const text = await res.text();
  const events = text.split("\n\n").filter(Boolean);
  for (const e of events) expect(e.startsWith("data: ")).toBe(true);
  return events.map((e) => JSON.parse(e.slice("data: ".length)));
}

describe("guest (mock) mode", () => {
  it("health reports mock + in-memory", async () => {
    const { req } = setup();
    const res = await req("/api/health", {}, {});
    const body = HealthResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ ok: true, ai: false, memory: false });
  });

  it("requires a valid guest uuid", async () => {
    const { req } = setup();
    expect((await req("/api/memory", {}, {})).status).toBe(401);
    expect((await req("/api/memory", {}, { "x-bimpee-guest": "not-a-uuid" })).status).toBe(401);
    const ok = await req("/api/memory");
    expect(ok.status).toBe(200);
    expect(PlayerMemorySchema.parse(await ok.json()).userId).toBe(GUEST);
  });

  it("applies and sanitizes the display name header", async () => {
    const { req } = setup();
    const res = await req("/api/memory", {}, { "x-bimpee-guest": GUEST, "x-bimpee-name": "<b>Zed</b> the Great and Powerful Wizard" });
    const m = PlayerMemorySchema.parse(await res.json());
    expect(m.displayName).toBe("bZedb the Great and Powe");
    expect(m.displayName.length).toBeLessThanOrEqual(24);
  });

  it("POST /api/world validates and returns a world", async () => {
    const { req } = setup();
    expect((await req("/api/world", { method: "POST", json: { seed: -1 } })).status).toBe(400);
    expect((await req("/api/world", { method: "POST", body: "{nope" })).status).toBe(400);
    const res = await req("/api/world", { method: "POST", json: { seed: 9, wish: "underwater" } });
    expect(res.status).toBe(200);
    const body = WorldResponseSchema.parse(await res.json());
    expect(body.world.seed).toBe(9);
    expect(body.source).toBe("fallback");
  });

  it("400 carries a message", async () => {
    const { req } = setup();
    const res = await req("/api/director", { method: "POST", json: { world, telemetry: { nope: 1 } } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/invalid request/);
  });

  it("POST /api/director returns directives", async () => {
    const { req } = setup();
    const res = await req("/api/director", { method: "POST", json: { world, telemetry: telemetry({}, { hpFraction: 0.1 }) } });
    expect(res.status).toBe(200);
    const body = DirectorResponseSchema.parse(await res.json());
    expect(body.model).toBe("local");
    expect(body.directives.some((d) => d.tool === "grant_boon")).toBe(true);
  });

  it("POST /api/narrate streams SSE chunks and ends with done", async () => {
    const { req } = setup();
    const res = await req("/api/narrate", { method: "POST", json: { world, trigger: "boss_spawn", context: "boss arrives" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const chunks = await sse(res);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.at(-1)).toEqual({ done: true });
    expect(chunks.slice(0, -1).every((c) => typeof c.text === "string")).toBe(true);
  });

  it("narration errors become an {error} chunk followed by done", async () => {
    const broken: AiService = {
      ...new MockAiService(loadConfig({}).models),
      enabled: true,
      models: loadConfig({}).models,
      generateWorld: async () => {
        throw new Error("x");
      },
      director: async () => {
        throw new Error("x");
      },
      reflect: async () => {
        throw new Error("x");
      },
      // eslint-disable-next-line require-yield
      narrate: async function* () {
        throw new Error("upstream exploded with sk-ant-secret");
      },
    };
    const { req } = setup({ ai: broken });
    const chunks = await sse(await req("/api/narrate", { method: "POST", json: { world, trigger: "death", context: "" } }));
    expect(chunks).toEqual([{ error: "narration unavailable" }, { done: true }]);
  });

  it("POST /api/runs reflects, stores, ranks and is idempotent", async () => {
    const { req } = setup();
    const res = await req("/api/runs", { method: "POST", json: report({ score: 500 }) });
    expect(res.status).toBe(200);
    const body = RunResultSchema.parse(await res.json());
    expect(body.bestScore).toBe(500);
    expect(body.rank).toBe(1);
    expect((await req("/api/runs", { method: "POST", json: report({ score: 500 }) })).status).toBe(409);

    const mem = PlayerMemorySchema.parse(await (await req("/api/memory")).json());
    expect(mem.runs).toBe(1);
    expect(mem.recentRuns[0]!.worldName).toBe("Neon Undertow");

    const lb = LeaderboardResponseSchema.parse(await (await req("/api/leaderboard?scope=daily", {}, {})).json());
    expect(lb.entries).toHaveLength(1);
    expect((await req("/api/leaderboard?scope=weekly", {}, {})).status).toBe(400);
  });

  it("POST /api/runs bounds client-reported text and numbers before storing them", async () => {
    const { req } = setup();
    const res = await req("/api/runs", {
      method: "POST",
      json: report({ runId: "run_bounded", score: 9e15, worldName: `<b>${"W".repeat(5000)}`}),
    });
    expect(res.status).toBe(200);
    expect(RunResultSchema.parse(await res.json()).bestScore).toBe(2_147_483_647);
    const lb = LeaderboardResponseSchema.parse(await (await req("/api/leaderboard?scope=all", {}, {})).json());
    expect(lb.entries[0]!.worldName.length).toBeLessThanOrEqual(60);
    expect(lb.entries[0]!.worldName).not.toContain("<");
    expect((await req("/api/runs", { method: "POST", json: report({ runId: "r".repeat(65) }) })).status).toBe(400);
  });

  it("rejects oversized bodies", async () => {
    const { req } = setup();
    const res = await req("/api/narrate", { method: "POST", body: JSON.stringify({ pad: "x".repeat(64 * 1024) }) });
    expect(res.status).toBe(413);
  });

  it("rate limits AI routes per user with 429 JSON", async () => {
    const { req } = setup({ limiter: new MemoryLimiter(2, 60_000) });
    for (let i = 0; i < 2; i++) expect((await req("/api/world", { method: "POST", json: {} })).status).toBe(200);
    const res = await req("/api/world", { method: "POST", json: {} });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toMatch(/rate limited/);
  });

  it("CORS: allows the dev origin, not arbitrary ones", async () => {
    const { req } = setup();
    const ok = await req("/api/health", { method: "OPTIONS" }, { origin: "http://localhost:5173", "access-control-request-method": "POST" });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const bad = await req("/api/health", {}, { origin: "https://evil.example" });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("returns JSON 404s and hides internal errors", async () => {
    const repo = new InMemoryRepo();
    repo.getMemory = async () => {
      throw new Error("db password=hunter2");
    };
    const { req } = setup({ memory: repo });
    expect((await req("/api/nope")).status).toBe(404);
    const res = await req("/api/memory");
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("hunter2");
  });
});

describe("supabase auth mode", () => {
  const env = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service", ALLOWED_ORIGINS: "https://bimpee.example" };
  const auth = new SupabaseAuth(async (token) => (token === TOKEN ? { id: USER } : null));

  it("401 without a bearer token, and the guest header is rejected", async () => {
    const { req } = setup({ auth }, env);
    expect((await req("/api/memory", {}, {})).status).toBe(401);
    const guest = await req("/api/memory", {}, { "x-bimpee-guest": GUEST });
    expect(guest.status).toBe(401);
    expect(((await guest.json()) as { error: string }).error).toMatch(/guest mode is disabled/);
    expect((await req("/api/memory", {}, { authorization: "Bearer wrong-token-0123456789" })).status).toBe(401);
  });

  it("accepts a valid bearer token", async () => {
    const { req } = setup({ auth }, env);
    const res = await req("/api/memory", {}, { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { userId: string }).userId).toBe(USER);
  });

  it("does not allow localhost origins in production config", async () => {
    const { req } = setup({ auth }, env);
    const res = await req("/api/health", {}, { origin: "http://localhost:5173" });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const prod = await req("/api/health", {}, { origin: "https://bimpee.example" });
    expect(prod.headers.get("access-control-allow-origin")).toBe("https://bimpee.example");
  });
});
