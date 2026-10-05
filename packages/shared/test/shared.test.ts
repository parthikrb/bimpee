import { describe, expect, it } from "vitest";
import {
  PacingController,
  WorldSpecSchema,
  emptyMemory,
  generateFallbackWorld,
  heuristicReflection,
  localDirector,
  memoryDigest,
  mergeReflection,
  parseDirectives,
  sanitizeWorldSpec,
  type RunReport,
  type Telemetry,
} from "../src";

const calm = { damageTaken: 0, hpFraction: 1, nearbyEnemies: 0, kills: 0, nearMisses: 0 };

describe("fallback world", () => {
  it("is valid and deterministic for every seed sampled", () => {
    for (let seed = 0; seed < 200; seed++) {
      const w = generateFallbackWorld(seed * 7919);
      expect(WorldSpecSchema.safeParse(w).success, `seed ${seed}`).toBe(true);
      expect(sanitizeWorldSpec(w)).not.toBeNull();
    }
    expect(generateFallbackWorld(42)).toEqual(generateFallbackWorld(42));
  });
});

describe("sanitizeWorldSpec", () => {
  it("clamps out-of-range numbers instead of rejecting", () => {
    const w: any = structuredClone(generateFallbackWorld(1));
    w.music.bpm = 999;
    w.enemies[0].hp = -5;
    w.enemies[0].modifiers = ["shielded", "cloaks", "explodes", "teleports"];
    w.arc[1].durationSec = 5;
    const fixed = sanitizeWorldSpec(w)!;
    expect(fixed.music.bpm).toBe(180);
    expect(fixed.enemies[0]!.hp).toBe(1);
    expect(fixed.enemies[0]!.modifiers.length).toBe(3);
    expect(fixed.arc[1]!.durationSec).toBe(30);
  });
  it("dedupes enemy ids and guarantees an act-0 enemy", () => {
    const w: any = structuredClone(generateFallbackWorld(2));
    for (const e of w.enemies) { e.id = "Same Id!"; e.unlockAct = 2; }
    const fixed = sanitizeWorldSpec(w)!;
    expect(new Set(fixed.enemies.map((e) => e.id)).size).toBe(fixed.enemies.length);
    expect(fixed.enemies.some((e) => e.unlockAct === 0)).toBe(true);
  });
  it("returns null for garbage", () => {
    expect(sanitizeWorldSpec(null)).toBeNull();
    expect(sanitizeWorldSpec({ hello: "world" })).toBeNull();
  });
});

describe("PacingController", () => {
  it("cycles build -> peak -> relax -> build under pressure", () => {
    const pc = new PacingController(generateFallbackWorld(3));
    const phases = new Set<string>();
    for (let i = 0; i < 60 * 40; i++) {
      const out = pc.update(1 / 60, { ...calm, damageTaken: i % 30 === 0 ? 0.03 : 0, nearbyEnemies: 12 });
      phases.add(out.phase);
    }
    expect([...phases].sort()).toEqual(["build", "peak", "relax"]);
  });
  it("spawns more when the player is comfortable than when relaxing", () => {
    const pc = new PacingController(generateFallbackWorld(4));
    const build = pc.update(0.016, calm);
    expect(build.phase).toBe("build");
    expect(build.spawnPerSec).toBeGreaterThan(0);
  });
  it("ramps toward an AI target and accepts spawn overrides", () => {
    const w = generateFallbackWorld(5);
    const pc = new PacingController(w);
    expect(pc.apply({ tool: "set_intensity_target", target: 1, rampSec: 2 })).toBe(true);
    for (let i = 0; i < 180; i++) pc.update(1 / 60, calm);
    expect(pc.target()).toBeCloseTo(1, 2);
    pc.apply({ tool: "adjust_spawns", rateMultiplier: 10, weights: [{ id: w.enemies[0]!.id, weight: 0 }, { id: "nope", weight: 1 }] });
    expect(pc.snapshot().spawnMultiplier).toBe(3);
    expect(pc.spawnTable().find((e) => e.id === w.enemies[0]!.id)).toBeUndefined();
    expect(pc.apply({ tool: "narrate", line: "hi", mood: "hype" })).toBe(false);
  });
  it("only offers archetypes unlocked by the current act", () => {
    const w = generateFallbackWorld(6);
    const pc = new PacingController(w);
    expect(pc.spawnTable().every((e) => w.enemies.find((x) => x.id === e.id)!.unlockAct === 0)).toBe(true);
    pc.setAct(2);
    expect(pc.spawnTable().length).toBe(w.enemies.filter((e) => e.weight > 0).length);
  });
});

const telemetry = (over: Partial<Telemetry> = {}): Telemetry => ({
  runId: "r", t: 30, act: 0, intensity: 0.3, intensityTarget: 0.4, phase: "build",
  player: { hpFraction: 1, level: 1, weapon: "blaster", accuracy: 0.5, damageTaken: 0, kills: 4, nearMisses: 0, idleRatio: 0, score: 100 },
  enemiesAlive: 10, bossActive: false, recentEvents: [], recentDirectives: [], fps: 60, players: 1,
  ...over,
});

describe("localDirector", () => {
  it("heals a dying player", () => {
    const r = localDirector(generateFallbackWorld(7), telemetry({ player: { ...telemetry().player, hpFraction: 0.1 } }));
    expect(r.directives.some((d) => d.tool === "grant_boon")).toBe(true);
    expect(parseDirectives(r.directives)).toHaveLength(r.directives.length);
  });
  it("summons the boss in act 3", () => {
    const w = generateFallbackWorld(8);
    const r = localDirector(w, telemetry({ act: 2, t: 75 + 120 + 40 }));
    expect(r.directives.some((d) => d.tool === "spawn_boss")).toBe(true);
  });
});

describe("memory", () => {
  it("merges reflections with EMA and keeps 5 recent runs", () => {
    let m = emptyMemory("u1", "Ana");
    const report: RunReport = {
      runId: "r", worldName: "W", worldSeed: 1, biome: "neon_city", outcome: "death", durationSec: 120, score: 500,
      kills: 50, level: 3, accuracy: 0.9, damageTaken: 1, killedBy: "Glitchling", bossDefeated: false,
      highlights: [], directivesUsed: [], intensityCurve: [],
    };
    for (let i = 0; i < 7; i++) m = mergeReflection(m, report, heuristicReflection(m, report));
    expect(m.runs).toBe(7);
    expect(m.recentRuns).toHaveLength(5);
    expect(m.nemesis).toBe("Glitchling");
    expect(m.skill.aim).toBeGreaterThan(0.8);
    expect(memoryDigest(m)).toContain("Ana");
  });
  it("digests a brand new player", () => {
    expect(memoryDigest(emptyMemory("u"))).toMatch(/brand new/);
  });
});

describe("parseDirectives", () => {
  it("drops invalid entries", () => {
    expect(parseDirectives([{ tool: "narrate", line: "x", mood: "hype" }, { tool: "rm_rf" }, { tool: "set_music", energy: 5, tension: 0 }])).toHaveLength(1);
  });
});
