import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localDirector, type DirectorResponse } from "@bimpee/shared";
import { deferred, remoteResponse, telemetry, world } from "../test/fixtures";
import { DirectorLoop, type DirectorLoopDeps, type DirectorResult } from "./directorLoop";

function setup(over: Partial<DirectorLoopDeps> = {}) {
  const results: DirectorResult[] = [];
  const pending: ReturnType<typeof deferred<DirectorResponse>>[] = [];
  const signals: AbortSignal[] = [];
  const fetchDirector = vi.fn((_req, signal: AbortSignal) => {
    const d = deferred<DirectorResponse>();
    pending.push(d);
    signals.push(signal);
    return d.promise;
  });
  const loop = new DirectorLoop({
    world,
    runId: "run_a",
    mode: "solo",
    fetchDirector,
    localDirector,
    online: () => true,
    onResult: (r) => results.push(r),
    timeoutMs: 9000,
    ...over,
  });
  return { loop, results, pending, signals, fetchDirector };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("DirectorLoop (solo)", () => {
  it("applies a remote response", async () => {
    const { loop, results, pending } = setup();
    loop.onTelemetry(telemetry());
    pending[0]!.resolve(remoteResponse);
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ source: "claude", model: "claude-test", t: 15 });
    expect(loop.busy).toBe(false);
  });

  it("never has more than one request in flight", async () => {
    const { loop, fetchDirector, pending, results } = setup();
    loop.onTelemetry(telemetry("run_a", 15));
    loop.onTelemetry(telemetry("run_a", 30));
    loop.onTelemetry(telemetry("run_a", 45));
    expect(fetchDirector).toHaveBeenCalledTimes(1);
    expect(loop.snapshot()).toMatchObject({ inFlight: true, requests: 1, dropped: 2 });
    pending[0]!.resolve(remoteResponse);
    await vi.advanceTimersByTimeAsync(0);
    loop.onTelemetry(telemetry("run_a", 60));
    expect(fetchDirector).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(1);
  });

  it("falls back to the local director on timeout and ignores the late answer", async () => {
    const { loop, results, pending, signals } = setup();
    loop.onTelemetry(telemetry());
    await vi.advanceTimersByTimeAsync(8999);
    expect(results).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ source: "fallback", model: "local" });
    expect(results[0]!.note).toMatch(/timed out/);
    expect(signals[0]!.aborted).toBe(true);
    expect(loop.snapshot()).toMatchObject({ inFlight: false, fallbacks: 1 });
    // The slow answer finally lands: dropped.
    pending[0]!.resolve(remoteResponse);
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toHaveLength(1);
  });

  it("falls back to the local director on error", async () => {
    const { loop, results, pending } = setup();
    loop.onTelemetry(telemetry());
    pending[0]!.reject(new Error("503"));
    await vi.advanceTimersByTimeAsync(0);
    expect(results[0]).toMatchObject({ source: "fallback", note: "503" });
    expect(loop.busy).toBe(false);
  });

  it("handles a fetcher that throws synchronously", async () => {
    const { loop, results } = setup({
      fetchDirector: () => {
        throw new Error("sync boom");
      },
    });
    loop.onTelemetry(telemetry());
    await vi.advanceTimersByTimeAsync(0);
    expect(results[0]).toMatchObject({ source: "fallback" });
  });

  it("goes straight to the local director when offline", () => {
    const { loop, results, fetchDirector } = setup({ online: () => false });
    loop.onTelemetry(telemetry());
    expect(fetchDirector).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ source: "local", model: "local" });
  });

  it("drops telemetry from another run", () => {
    const { loop, fetchDirector } = setup();
    loop.onTelemetry(telemetry("run_old"));
    expect(fetchDirector).not.toHaveBeenCalled();
    expect(loop.snapshot().dropped).toBe(1);
  });

  it("drops responses that arrive after dispose (stale run)", async () => {
    const { loop, results, pending, signals } = setup();
    loop.onTelemetry(telemetry());
    loop.dispose();
    expect(signals[0]!.aborted).toBe(true);
    pending[0]!.resolve(remoteResponse);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(results).toHaveLength(0);
    loop.onTelemetry(telemetry());
    expect(results).toHaveLength(0);
  });

  it("labels a server-side local answer as local", async () => {
    const { loop, results, pending } = setup();
    loop.onTelemetry(telemetry());
    pending[0]!.resolve({ ...remoteResponse, model: "local" });
    await vi.advanceTimersByTimeAsync(0);
    expect(results[0]!.source).toBe("local");
  });
});

describe("DirectorLoop (room)", () => {
  it("routes telemetry to the room instead of the API", () => {
    const sent: unknown[] = [];
    const { loop, fetchDirector, results } = setup({
      mode: "room",
      sendToRoom: (t) => {
        sent.push(t);
        return true;
      },
    });
    loop.onTelemetry(telemetry("run_a", 20));
    loop.onTelemetry(telemetry("run_a", 35));
    expect(fetchDirector).not.toHaveBeenCalled();
    expect(sent).toHaveLength(2);
    expect(results).toHaveLength(0);
  });

  it("decides locally for a tick when the room socket is down", () => {
    const { loop, fetchDirector, results } = setup({ mode: "room", sendToRoom: () => false });
    loop.onTelemetry(telemetry("run_a", 20));
    expect(fetchDirector).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ source: "fallback", model: "local" });
  });

  it("applies directives broadcast by the room, stamped with the last telemetry time", () => {
    const { loop, results } = setup({ mode: "room", sendToRoom: () => undefined });
    loop.onTelemetry(telemetry("run_a", 42));
    loop.onRoomDirectives({ directives: remoteResponse.directives, reasoning: "group", model: "claude-room" });
    expect(results[0]).toMatchObject({ source: "room", model: "claude-room", t: 42, reasoning: "group" });
    loop.dispose();
    loop.onRoomDirectives({ directives: [], reasoning: "", model: "x" });
    expect(results).toHaveLength(1);
  });
});

it("reports stats on every change", async () => {
  vi.useRealTimers();
  const stats: unknown[] = [];
  const { loop, pending } = setup({ onStats: (s) => stats.push(s) });
  loop.onTelemetry(telemetry());
  pending[0]!.resolve(remoteResponse);
  await flush();
  expect(stats.at(0)).toMatchObject({ inFlight: true, requests: 1 });
  expect(stats.at(-1)).toMatchObject({ inFlight: false });
});
