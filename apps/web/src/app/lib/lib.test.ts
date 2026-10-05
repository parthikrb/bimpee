import { describe, expect, it } from "vitest";
import { generateFallbackWorld } from "@bimpee/shared";
import { normalizeRoomCode, randomRoomCode, uuid } from "./ids";
import { contrast, legibleOn } from "./palette";
import { fmtClock } from "./format";
import { describeDirective } from "../director/describe";
import { sanitizeName } from "../api/identity";
import { sanitizeReport } from "../run/session";

describe("ids", () => {
  it("normalizes room codes", () => {
    expect(normalizeRoomCode("  Neon Fox 42 ")).toBe("neon-fox-42");
    expect(normalizeRoomCode("a!")).toBeNull();
    expect(normalizeRoomCode("x".repeat(40))).toHaveLength(24);
    expect(normalizeRoomCode(randomRoomCode())).not.toBeNull();
  });
  it("makes uuids", () => {
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("palette", () => {
  it("lightens dark accents until legible", () => {
    const fixed = legibleOn("#3a0050", "#120634");
    expect(contrast(fixed, "#120634")).toBeGreaterThanOrEqual(4.5);
    expect(legibleOn("#00f0ff", "#120634")).toBe("#00f0ff");
  });
});

describe("format + describe", () => {
  it("formats clocks", () => {
    expect(fmtClock(0)).toBe("0:00");
    expect(fmtClock(125.7)).toBe("2:05");
  });
  it("summarizes directives", () => {
    expect(describeDirective({ tool: "set_intensity_target", target: 0.7, rampSec: 8 })).toBe("target → 0.7 over 8s");
    expect(describeDirective({ tool: "adjust_spawns", rateMultiplier: 1.5, weights: [] })).toBe("rate ×1.5");
    expect(describeDirective({ tool: "set_music", energy: 1, tension: 0.25 })).toBe("energy 1 · tension 0.25");
  });
});

describe("identity", () => {
  it("sanitizes display names", () => {
    expect(sanitizeName("  Neo\u0000   Moth  ")).toBe("Neo Moth");
    expect(sanitizeName("x".repeat(40))).toHaveLength(24);
  });
});

describe("sanitizeReport", () => {
  it("coerces a sloppy game report into the API schema", () => {
    const w = generateFallbackWorld(1);
    const r = sanitizeReport({
      runId: "r",
      worldName: w.name,
      worldSeed: 1.5,
      biome: w.theme.biome,
      outcome: "death",
      durationSec: Number.NaN,
      score: 10.6,
      kills: -1,
      level: 0,
      accuracy: 1.3,
      damageTaken: -2,
      killedBy: null,
      bossDefeated: false,
      highlights: Array.from({ length: 30 }, (_, i) => `h${i}`),
      directivesUsed: [],
      intensityCurve: Array.from({ length: 500 }, () => 2),
    });
    expect(r).toMatchObject({ durationSec: 0, score: 11, kills: 0, level: 1, accuracy: 1, damageTaken: 0, worldSeed: 2 });
    expect(r.highlights).toHaveLength(20);
    expect(r.intensityCurve.length).toBeLessThanOrEqual(240);
    expect(Math.max(...r.intensityCurve)).toBe(1);
  });
});
