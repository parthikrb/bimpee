import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NarrateChunk, NarrateRequest } from "@bimpee/shared";
import type { SubtitleLine } from "../store/run";
import { world } from "../test/fixtures";
import { crossedMilestone, NarrationGate } from "./gate";
import { Narrator, type NarratorDeps } from "./narrator";

describe("NarrationGate", () => {
  it("enforces a minimum gap for ordinary triggers", () => {
    const g = new NarrationGate(10_000);
    expect(g.decide("act_change", 0, false)).toBe("start");
    g.started(0);
    expect(g.decide("near_death", 5_000, false)).toBe("drop");
    expect(g.decide("near_death", 10_000, false)).toBe("start");
  });

  it("lets priority triggers bypass the gap", () => {
    const g = new NarrationGate(10_000);
    g.started(0);
    for (const t of ["death", "victory", "boss_spawn", "boss_defeated"] as const) expect(g.decide(t, 1, false)).toBe("start");
  });

  it("drops ordinary triggers while streaming, interrupts for priority ones", () => {
    const g = new NarrationGate();
    expect(g.decide("milestone", 1e9, true)).toBe("drop");
    expect(g.decide("death", 1e9, true)).toBe("interrupt");
  });

  it("detects kill milestones once", () => {
    expect(crossedMilestone(24, 25)).toBe(25);
    expect(crossedMilestone(25, 26)).toBeNull();
    expect(crossedMilestone(70, 160)).toBe(150);
  });
});

/** A controllable fake narrate stream. */
function controlledStream() {
  const streams: { req: NarrateRequest; signal: AbortSignal; push: (c: NarrateChunk) => void; end: () => void; fail: () => void }[] = [];
  const stream = (req: NarrateRequest, signal: AbortSignal): AsyncIterable<NarrateChunk> => {
    const queue: NarrateChunk[] = [];
    let wake: (() => void) | null = null;
    let ended = false;
    let failed = false;
    const notify = () => {
      wake?.();
      wake = null;
    };
    streams.push({
      req,
      signal,
      push: (c) => {
        queue.push(c);
        notify();
      },
      end: () => {
        ended = true;
        notify();
      },
      fail: () => {
        failed = true;
        notify();
      },
    });
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (failed) throw new Error("stream failed");
          if (queue.length) {
            yield queue.shift()!;
            continue;
          }
          if (ended || signal.aborted) return;
          await new Promise<void>((r) => (wake = r));
        }
      },
    };
  };
  return { stream, streams };
}

function setup(over: Partial<NarratorDeps> = {}) {
  let line: SubtitleLine | null = null;
  const spoken: string[] = [];
  let now = 1_000_000;
  const s = controlledStream();
  const n = new Narrator({
    world,
    stream: s.stream,
    online: () => true,
    setLine: (fn) => (line = fn(line)),
    onLineDone: (t) => spoken.push(t),
    now: () => now,
    rand: () => 0,
    ...over,
  });
  return { n, get line() { return line; }, spoken, streams: s.streams, advance: (ms: number) => (now += ms) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("Narrator", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it("streams a line chunk by chunk and finalizes it", async () => {
    const t = setup();
    t.n.onGameEvent({ kind: "run_start", t: 0, text: "Run begins" });
    expect(t.streams[0]!.req.trigger).toBe("run_start");
    expect(t.line).toMatchObject({ text: "", done: false });
    t.streams[0]!.push({ text: "Welcome, " });
    await tick();
    expect(t.line?.text).toBe("Welcome, ");
    t.streams[0]!.push({ text: "hero." });
    t.streams[0]!.push({ done: true });
    await tick();
    expect(t.line).toMatchObject({ text: "Welcome, hero.", done: true });
    expect(t.spoken).toEqual(["Welcome, hero."]);
    expect(t.n.streaming).toBe(false);
  });

  it("drops ordinary events while streaming and within the gap", async () => {
    const t = setup();
    t.n.onGameEvent({ kind: "act_change", t: 60, text: "The Swell" });
    expect(t.n.trigger("near_death", "low")).toBe("drop");
    t.streams[0]!.push({ done: true });
    t.streams[0]!.end();
    await tick();
    t.advance(3_000);
    expect(t.n.trigger("near_death", "low")).toBe("drop");
    t.advance(8_000);
    expect(t.n.trigger("near_death", "low")).toBe("start");
  });

  it("lets death interrupt a streaming line", async () => {
    const t = setup();
    t.n.onGameEvent({ kind: "act_change", t: 60, text: "The Swell" });
    const first = t.streams[0]!;
    first.push({ text: "Act two" });
    await tick();
    t.n.onGameEvent({ kind: "death", t: 61, text: "killed by Glitchling" });
    expect(first.signal.aborted).toBe(true);
    expect(t.streams[1]!.req.trigger).toBe("death");
    t.streams[1]!.push({ text: "Gone." });
    t.streams[1]!.push({ done: true });
    await tick();
    expect(t.line?.text).toBe("Gone.");
  });

  it("falls back to a canned line if the stream errors before any text", async () => {
    const t = setup();
    t.n.trigger("victory", "won");
    t.streams[0]!.fail();
    await tick();
    expect(t.line?.done).toBe(true);
    expect(t.line?.text).toContain(world.name);
  });

  it("uses canned lines when offline, without calling the API", () => {
    const t = setup({ online: () => false });
    t.n.onGameEvent({ kind: "boss_spawn", t: 200, text: "boss" });
    expect(t.streams).toHaveLength(0);
    expect(t.line?.text).toContain(world.boss.name);
    expect(t.line?.source).toBe("canned");
  });

  it("narrates kill milestones", () => {
    const t = setup({ online: () => false });
    for (let i = 0; i < 25; i++) t.n.onGameEvent({ kind: "kill", t: i, text: "kill" });
    expect(t.line?.text).toContain("25");
  });

  it("queues director lines behind the current line", async () => {
    vi.useFakeTimers();
    const t = setup({ online: () => false, now: () => Date.now() });
    t.n.sayDirect("First", "hype");
    expect(t.line?.text).toBe("First");
    t.n.sayDirect("Second", "warn");
    expect(t.line?.text).toBe("First");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.line).toMatchObject({ text: "Second", source: "director", mood: "warn" });
  });

  it("does nothing after dispose", async () => {
    const t = setup();
    t.n.onGameEvent({ kind: "run_start", t: 0, text: "x" });
    const s = t.streams[0]!;
    t.n.dispose();
    expect(s.signal.aborted).toBe(true);
    t.n.onGameEvent({ kind: "death", t: 1, text: "x" });
    expect(t.streams).toHaveLength(1);
  });
});
