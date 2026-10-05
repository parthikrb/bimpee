import { generateFallbackWorld, RunReportSchema, TelemetrySchema, WEAPONS } from "@bimpee/shared";
import { describe, expect, it } from "vitest";
import { HighlightTracker } from "./highlights";
import { buildRunReport, IntensitySampler } from "./report";
import { computeScore, gemValue } from "./scoring";
import { SpatialHash } from "./spatialHash";
import { TelemetryTracker } from "./telemetry";
import { applyUpgrade, boonWeaponUpgrade, createBuild, MAX_WEAPONS, rollUpgrades, xpToNext } from "./upgrades";
import { createWeapon, DEFAULT_MODS, effectiveCooldown, fireWeapon, orbitalLayout } from "./weapons";

const seq = (vals: number[]) => {
  let i = 0;
  return () => vals[i++ % vals.length]!;
};

describe("weapons", () => {
  it("each weapon fires sensible volleys", () => {
    for (const k of WEAPONS) {
      const w = createWeapon(k);
      const shots = fireWeapon(w, DEFAULT_MODS, 0, Math.random, 300);
      if (k === "orbitals") expect(shots).toHaveLength(0);
      else expect(shots.length).toBeGreaterThan(0);
      for (const s of shots) {
        expect(Number.isFinite(s.angle)).toBe(true);
        expect(s.damage).toBeGreaterThan(0);
      }
      expect(effectiveCooldown(w, DEFAULT_MODS)).toBeGreaterThan(0.05);
    }
  });
  it("crits multiply damage", () => {
    const w = createWeapon("blaster");
    const [s] = fireWeapon(w, { ...DEFAULT_MODS, critChance: 1, critMult: 3 }, 0, () => 0.5);
    expect(s!.crit).toBe(true);
    expect(s!.damage).toBeCloseTo(w.damage * 3);
  });
  it("NaN aim is sanitised", () => {
    const shots = fireWeapon(createWeapon("scatter"), DEFAULT_MODS, NaN, Math.random);
    for (const s of shots) expect(Number.isFinite(s.angle)).toBe(true);
  });
  it("orbital layout grows with projectiles", () => {
    const w = createWeapon("orbitals");
    const a = orbitalLayout(w, DEFAULT_MODS, 1).count;
    w.projectiles += 2;
    expect(orbitalLayout(w, DEFAULT_MODS, 1).count).toBe(a + 2);
  });
});

describe("upgrades", () => {
  const world = generateFallbackWorld(5);
  it("rolls 3 distinct options and applies each", () => {
    for (let i = 0; i < 200; i++) {
      const b = createBuild({ startingWeapon: "blaster", hpMultiplier: 1.5 });
      expect(b.maxHp).toBe(150);
      const opts = rollUpgrades(b, Math.random, 3);
      expect(opts).toHaveLength(3);
      expect(new Set(opts.map((o) => o.id)).size).toBe(3);
      for (const o of opts) expect(["common", "rare", "epic"]).toContain(o.rarity);
      expect(applyUpgrade(b, opts[0]!.id)).not.toBeNull();
    }
  });
  it("unknown ids are rejected", () => {
    const b = createBuild(world.player);
    expect(applyUpgrade(b, "nope")).toBeNull();
  });
  it("concrete upgrades change stats", () => {
    const b = createBuild({ startingWeapon: "blaster", hpMultiplier: 1 });
    const d0 = b.weapons[0]!.damage;
    applyUpgrade(b, "wdmg:blaster");
    expect(b.weapons[0]!.damage).toBeCloseTo(d0 * 1.25);
    expect(applyUpgrade(b, "maxhp")).toBe(20);
    expect(b.maxHp).toBe(120);
    applyUpgrade(b, "wnew:orbitals");
    applyUpgrade(b, "wnew:lobber");
    expect(b.weapons).toHaveLength(MAX_WEAPONS);
    // no more new-weapon offers
    for (let i = 0; i < 50; i++) expect(rollUpgrades(b, Math.random).some((o) => o.id.startsWith("wnew:"))).toBe(false);
  });
  it("hundreds of level-ups stay finite and always offer options", () => {
    const b = createBuild({ startingWeapon: "scatter", hpMultiplier: 1 });
    for (let i = 0; i < 400; i++) {
      const opts = rollUpgrades(b, Math.random);
      expect(opts.length).toBeGreaterThanOrEqual(3);
      applyUpgrade(b, opts[Math.floor(Math.random() * opts.length)]!.id);
    }
    for (const w of b.weapons) {
      expect(Number.isFinite(w.damage) && Number.isFinite(w.cooldown)).toBe(true);
      expect(effectiveCooldown(w, b.mods)).toBeGreaterThan(0.05);
    }
    expect(b.dashCooldown).toBeGreaterThanOrEqual(0.5);
  });
  it("boon weapon upgrade improves the primary weapon", () => {
    const b = createBuild({ startingWeapon: "beam", hpMultiplier: 1 });
    const d0 = b.weapons[0]!.damage;
    boonWeaponUpgrade(b, seq([0]));
    expect(b.weapons[0]!.damage).toBeGreaterThan(d0);
  });
  it("xp curve increases", () => {
    for (let l = 1; l < 40; l++) expect(xpToNext(l + 1)).toBeGreaterThanOrEqual(xpToNext(l));
    expect(xpToNext(0)).toBe(xpToNext(1));
  });
});

describe("scoring", () => {
  it("follows the formula", () => {
    expect(computeScore({ kills: 10, eliteKills: 2, bossKills: 1, timeSec: 100.7 })).toBe(100 + 100 + 1000 + 200);
    expect(computeScore({ kills: NaN, eliteKills: -1, bossKills: 0, timeSec: Infinity })).toBe(0);
    expect(gemValue(5, false, 1)).toBeGreaterThanOrEqual(1);
    expect(gemValue(5, true, 1)).toBeGreaterThan(gemValue(5, false, 1));
    expect(gemValue(5, false, NaN)).toBeGreaterThanOrEqual(1);
  });
});

describe("telemetry", () => {
  const ctx = {
    runId: "r1",
    t: 15,
    act: 0,
    intensity: 0.4,
    intensityTarget: 0.5,
    phase: "build" as const,
    hpFraction: 0.8,
    level: 3,
    weapon: "Blaster",
    score: 120,
    enemiesAlive: 12,
    bossActive: false,
    fps: 60,
    players: 1,
  };
  it("builds schema-valid telemetry and resets counters", () => {
    const t = new TelemetryTracker();
    t.sample(10, true);
    t.sample(5, false);
    t.addDamage(0.2);
    t.addKill(7);
    t.addShot(10);
    t.addHit(6);
    t.addNearMiss(3);
    for (let i = 0; i < 30; i++) t.addEvent(`event ${i}`);
    for (let i = 0; i < 30; i++) t.addDirective("narrate");
    const tel = t.flush(ctx)!;
    expect(TelemetrySchema.safeParse(tel).success).toBe(true);
    expect(tel.player.kills).toBe(7);
    expect(tel.player.accuracy).toBeCloseTo(0.6);
    expect(tel.player.idleRatio).toBeCloseTo(1 / 3, 1);
    expect(tel.recentEvents).toHaveLength(12);
    expect(tel.recentDirectives).toHaveLength(8);
    const again = t.flush(ctx)!;
    expect(again.player.kills).toBe(0);
    expect(again.player.damageTaken).toBe(0);
  });
  it("survives garbage input", () => {
    const t = new TelemetryTracker();
    const tel = t.flush({ ...ctx, t: NaN, act: 7, intensity: 5, hpFraction: -2, level: 0, fps: 1000, players: 0, score: -5, enemiesAlive: NaN });
    expect(tel).not.toBeNull();
    expect(TelemetrySchema.safeParse(tel).success).toBe(true);
  });
});

describe("report", () => {
  it("intensity sampler caps at 240 by compaction", () => {
    const s = new IntensitySampler();
    for (let i = 0; i < 3000 * 60; i++) s.update(1 / 60, (i % 600) / 600);
    expect(s.values.length).toBeLessThan(240);
    expect(s.values.length).toBeGreaterThan(100);
    for (const v of s.values) expect(v).toBeGreaterThanOrEqual(0);
  });
  it("builds a schema-valid report", () => {
    const h = new HighlightTracker();
    for (let i = 0; i < 40; i++) h.add(`moment ${i}`);
    expect(h.list).toHaveLength(20);
    const r = buildRunReport({
      runId: "x",
      worldName: "W",
      worldSeed: 3,
      biome: "neon_city",
      outcome: "death",
      durationSec: 123.456,
      score: 1234.5,
      kills: 50,
      level: 0,
      accuracy: 1.4,
      damageTaken: 2.5,
      killedBy: "Glitchling",
      bossDefeated: false,
      highlights: h.list,
      directivesUsed: Array.from({ length: 90 }, () => "narrate"),
      intensityCurve: [0.1, 2, -1],
    });
    expect(RunReportSchema.safeParse(r).success).toBe(true);
    expect(r.level).toBe(1);
    expect(r.directivesUsed).toHaveLength(60);
  });
  it("highlight hooks", () => {
    const h = new HighlightTracker();
    h.onKills(100);
    h.onKills(101);
    h.onHp(0.05);
    h.onHp(0.6);
    h.onBlackoutSurvived(0.123);
    h.onBossKilled("Big Bad", 0.03, 40);
    expect(h.list).toEqual(["100 kills", "Clawed back from 5% hp", "Survived blackout at 12% hp", "Killed Big Bad with 3% hp left"]);
  });
});

describe("SpatialHash", () => {
  it("finds inserted items", () => {
    const h = new SpatialHash(1000, 1000, 100, 50);
    h.insert(3, 150, 150);
    h.insert(4, 900, 900);
    h.insert(5, -50, 2000); // clamped into edge cells
    const found: number[] = [];
    h.query(160, 160, 30, (i) => void found.push(i));
    expect(found).toEqual([3]);
    const all: number[] = [];
    h.queryRect(-100, -100, 2000, 2000, (i) => void all.push(i));
    expect(all.sort()).toEqual([3, 4, 5]);
    h.clear();
    const none: number[] = [];
    h.query(150, 150, 50, (i) => void none.push(i));
    expect(none).toEqual([]);
  });
});
