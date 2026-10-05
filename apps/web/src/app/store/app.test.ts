import { describe, expect, it } from "vitest";
import { generateFallbackWorld, type RunReport } from "@bimpee/shared";
import { createAppStore, type ForgedWorld } from "./app";

const forged = (seed = 1): ForgedWorld => ({ world: generateFallbackWorld(seed), source: "claude", model: "m", latencyMs: 5 });
const report = (runId: string): RunReport => ({
  runId,
  worldName: "W",
  worldSeed: 1,
  biome: "neon_city",
  outcome: "death",
  durationSec: 100,
  score: 10,
  kills: 1,
  level: 1,
  accuracy: 0.5,
  damageTaken: 1,
  killedBy: null,
  bossDefeated: false,
  highlights: [],
  directivesUsed: [],
  intensityCurve: [],
});

describe("app store state machine", () => {
  it("title -> forge -> play -> results -> title", () => {
    const s = createAppStore();
    expect(s.getState().screen).toBe("title");
    const id = s.getState().beginForge({ kind: "solo" }, "spooky");
    expect(s.getState()).toMatchObject({ screen: "forge", wish: "spooky", forge: { status: "loading" } });
    expect(s.getState().forgeResolved(id, forged())).toBe(true);
    expect(s.getState().forge?.status).toBe("ready");
    expect(s.getState().startRun("run_1", { players: 1, startOffsetSec: 0 })).toBe(true);
    expect(s.getState()).toMatchObject({ screen: "play", run: { runId: "run_1" } });
    expect(s.getState().endRun(report("run_1"))).toBe(true);
    expect(s.getState()).toMatchObject({ screen: "results", results: { runId: "run_1", reflection: null } });
    expect(s.getState().reflectionResolved("run_1", { summary: "s", epitaph: "e", bestScore: 10, rank: null, source: "local" })).toBe(true);
    expect(s.getState().results?.reflection?.summary).toBe("s");
    s.getState().toTitle({ focusWish: true });
    expect(s.getState()).toMatchObject({ screen: "title", forge: null, run: null, focusWishNonce: 1 });
  });

  it("ignores a world that arrives after the player left the forge", () => {
    const s = createAppStore();
    const id = s.getState().beginForge({ kind: "solo" });
    s.getState().toTitle();
    expect(s.getState().forgeResolved(id, forged())).toBe(false);
    expect(s.getState().screen).toBe("title");
  });

  it("ignores a stale forge after a newer one started", () => {
    const s = createAppStore();
    const a = s.getState().beginForge({ kind: "solo" });
    const b = s.getState().beginForge({ kind: "room", roomId: "abc", daily: false });
    expect(s.getState().forgeResolved(a, forged(1))).toBe(false);
    expect(s.getState().forgeResolved(b, forged(2))).toBe(true);
    expect(s.getState().forge?.forged?.world.seed).toBe(2);
    expect(s.getState().forgeResolved(b, forged(3))).toBe(false); // already ready
  });

  it("refuses to start without a ready world", () => {
    const s = createAppStore();
    expect(s.getState().startRun("r", { players: 1, startOffsetSec: 0 })).toBe(false);
    s.getState().beginForge({ kind: "solo" });
    expect(s.getState().startRun("r", { players: 1, startOffsetSec: 0 })).toBe(false);
  });

  it("drops run ends and reflections for other runs", () => {
    const s = createAppStore();
    const id = s.getState().beginForge({ kind: "solo" });
    s.getState().forgeResolved(id, forged());
    s.getState().startRun("run_new", { players: 2, startOffsetSec: -5 });
    expect(s.getState().run).toMatchObject({ players: 2, startOffsetSec: 0 });
    expect(s.getState().endRun(report("run_old"))).toBe(false);
    s.getState().endRun(report("run_new"));
    expect(s.getState().reflectionResolved("run_old", { summary: "", epitaph: "", bestScore: 0, rank: null, source: "local" })).toBe(false);
  });

  it("shows a prefetched world instantly", () => {
    const s = createAppStore();
    s.getState().showForged({ kind: "solo" }, forged(9));
    expect(s.getState()).toMatchObject({ screen: "forge", forge: { status: "ready" } });
    expect(s.getState().startRun("r", { players: 1, startOffsetSec: 0 })).toBe(true);
  });

  it("caps the wish length", () => {
    const s = createAppStore();
    s.getState().setWish("x".repeat(500));
    expect(s.getState().wish).toHaveLength(200);
  });
});
