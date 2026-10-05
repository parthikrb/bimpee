import { afterEach, describe, expect, it, vi } from "vitest";
import { generateFallbackWorld } from "@bimpee/shared";
import { createApiClient } from "./client";
import { ApiError } from "./http";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function client(fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const api = createApiClient({
    baseUrl: "http://x",
    fetch: ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return fetchImpl(url, init);
    }) as typeof fetch,
    headers: async () => ({ "x-bimpee-guest": "g-1", "x-bimpee-name": "Neo%20Moth" }),
  });
  return { api, calls };
}

const health = { ok: true, ai: true, memory: false, models: { world: "w", director: "d", narrator: "n" } };

afterEach(() => vi.useRealTimers());

describe("api client", () => {
  it("parses a valid health response and sends identity headers", async () => {
    const { api, calls } = client(async () => json(health));
    await expect(api.health()).resolves.toEqual(health);
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(calls[0]!.url).toBe("http://x/api/health");
    expect(h["x-bimpee-guest"]).toBe("g-1");
    expect(h["x-bimpee-name"]).toBe("Neo%20Moth");
  });

  it("rejects a response with the wrong shape as a parse error", async () => {
    const { api } = client(async () => json({ ok: true }));
    await expect(api.health()).rejects.toMatchObject({ kind: "parse" });
  });

  it("maps non-2xx to http errors with status", async () => {
    const { api } = client(async () => new Response("nope", { status: 503 }));
    const err = await api.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ kind: "http", status: 503 });
  });

  it("maps fetch failures to network errors", async () => {
    const { api } = client(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(api.health()).rejects.toMatchObject({ kind: "network" });
  });

  it("times out the director call at 9s", async () => {
    vi.useFakeTimers();
    const { api } = client(
      (_url, init) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
        }),
    );
    const world = generateFallbackWorld(1);
    const p = api.director({ world, telemetry: {} as never }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(8_999);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await p).toMatchObject({ kind: "timeout" });
  });

  it("distinguishes caller aborts from timeouts", async () => {
    const { api } = client(
      (_url, init) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
        }),
    );
    const ctrl = new AbortController();
    const p = api.memory(ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ kind: "aborted" });
  });

  it("posts the world request and validates the world spec", async () => {
    const world = generateFallbackWorld(42);
    const { api, calls } = client(async () => json({ world, source: "claude", model: "m", latencyMs: 12 }));
    const r = await api.world({ wish: "spooky" });
    expect(r.world.name).toBe(world.name);
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ wish: "spooky" });
  });

  it("streams narration over SSE", async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: {"text":"The "}\n\n'));
        c.enqueue(enc.encode('data: {"text":"end."}\n\ndata: {"done":true}\n\n'));
        c.close();
      },
    });
    const { api, calls } = client(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
    const chunks = [];
    for await (const c of api.narrate({ world: generateFallbackWorld(3), trigger: "death", context: "x" })) chunks.push(c);
    expect(chunks).toEqual([{ text: "The " }, { text: "end." }, { done: true }]);
    expect((calls[0]!.init.headers as Record<string, string>).accept).toBe("text/event-stream");
  });

  it("narrate throws on connect failure", async () => {
    const { api } = client(async () => new Response("x", { status: 500 }));
    const it = api.narrate({ world: generateFallbackWorld(3), trigger: "death", context: "x" });
    await expect(it.next()).rejects.toMatchObject({ kind: "http" });
  });
});
