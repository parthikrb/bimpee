import {
  BOON_KINDS,
  EVENT_KINDS,
  generateFallbackWorld,
  RunReportSchema,
  TelemetrySchema,
  type Directive,
  type RunReport,
  type Telemetry,
  type WorldSpec,
} from "@bimpee/shared";
import { describe, expect, it } from "vitest";
import { Bus, type GameEvent, type ShellToGame } from "../contract";
import { connectCommands } from "./commands";
import { Sim } from "./Sim";
import type { SimInput } from "./types";

const DT = 1 / 60;

function makeWorld(seed: number, patch: (w: WorldSpec) => void = () => {}): WorldSpec {
  const w = generateFallbackWorld(seed);
  patch(w);
  return w;
}

/** Dumb kiting bot: runs away from the nearest enemy, strafing, dashing when crowded. */
function botInput(sim: Sim, frame: number): SimInput {
  const p = sim.player;
  let nx = 0;
  let ny = 0;
  let close = 0;
  for (const e of sim.enemies) {
    if (!e.active) continue;
    const dx = p.x - e.x;
    const dy = p.y - e.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < 300 * 300) {
      const d = Math.sqrt(d2) || 1;
      nx += dx / d / d;
      ny += dy / d / d;
      if (d < 80) close++;
    }
  }
  const ang = Math.atan2(ny, nx) + Math.sin(frame / 90) * 0.9;
  const moving = nx !== 0 || ny !== 0;
  // drift back toward the centre when nothing is around
  const cx = sim.map.spawnX - p.x;
  const cy = sim.map.spawnY - p.y;
  return {
    moveX: moving ? Math.cos(ang) : Math.sign(cx) * 0.3,
    moveY: moving ? Math.sin(ang) : Math.sign(cy) * 0.3,
    aim: null,
    aimDist: 300,
    firing: false,
    dash: close >= 2 && frame % 20 === 0,
    viewW: 1600,
    viewH: 900,
  };
}

function record(sim: Sim) {
  const rec = {
    telemetry: [] as Telemetry[],
    runEnd: [] as RunReport[],
    events: [] as GameEvent[],
    hud: 0,
    pacing: 0,
    state: 0,
    offers: 0,
    applied: [] as { tool: string; ok: boolean; note?: string }[],
    banners: [] as string[],
  };
  sim.out.on("telemetry", (t) => rec.telemetry.push(t));
  sim.out.on("run_end", (r) => rec.runEnd.push(r));
  sim.out.on("event", (e) => rec.events.push(e));
  sim.out.on("hud", () => rec.hud++);
  sim.out.on("pacing", () => rec.pacing++);
  sim.out.on("player_state", (s) => {
    rec.state++;
    expect(Number.isFinite(s.x) && Number.isFinite(s.y)).toBe(true);
  });
  sim.out.on("banner", (b) => rec.banners.push(b.text));
  sim.out.on("directive_applied", (d) => rec.applied.push({ tool: d.directive.tool, ok: d.ok, note: d.note }));
  return rec;
}

function assertSane(sim: Sim) {
  const p = sim.player;
  expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.hp)).toBe(true);
  let alive = 0;
  for (const e of sim.enemies) {
    if (!e.active) continue;
    alive++;
    if (!(Number.isFinite(e.x) && Number.isFinite(e.y) && Number.isFinite(e.hp))) throw new Error(`NaN enemy ${e.arch.base}`);
  }
  expect(alive).toBe(sim.enemyCount);
  for (const b of sim.pBullets) if (b.active && !(Number.isFinite(b.x) && Number.isFinite(b.y))) throw new Error("NaN bullet");
}

describe("Sim headless run", () => {
  it("survives a full 6+ minute run: telemetry valid, boss auto-spawns, quit ends once", () => {
    const world = makeWorld(1234, (w) => {
      w.enemies.forEach((e, i) => (e.modifiers = [(["shielded", "explodes", "teleports", "regenerates", "leaves_trail", "fast_bullets", "cloaks"] as const)[i % 7]!]));
      w.enemies[1]!.base = "splitter";
      if (w.enemies[2]) w.enemies[2].base = "charger";
    });
    const sim = new Sim({ world, runId: "test-run", players: 2, playerName: "bot", rngSeed: 7 });
    sim.invulnerable = true;
    const inn = new Bus<ShellToGame>();
    const off = connectCommands(sim, inn);
    const rec = record(sim);
    sim.out.on("upgrade_offer", (opts) => {
      rec.offers++;
      expect(opts).toHaveLength(3);
      inn.emit("pick_upgrade", opts[rec.offers % 3]!.id);
    });

    const frames = Math.ceil((sim.runLength + 30) / DT);
    let maxEnemies = 0;
    for (let f = 0; f < frames; f++) {
      sim.step(DT, botInput(sim, f));
      maxEnemies = Math.max(maxEnemies, sim.enemyCount);
      if (f % 300 === 0) assertSane(sim);
      sim.fx.length = 0; // renderer would drain these
    }
    assertSane(sim);

    // invulnerable bot: the run is either still going or won
    if (sim.ended) expect(sim.outcome).toBe("victory");
    expect(sim.bossSpawned).toBe(true);
    const bossEv = rec.events.find((e) => e.kind === "boss_spawn")!;
    expect(bossEv.t).toBeLessThanOrEqual(sim.actStarts[2]! + 45 + 1);
    expect(rec.events.filter((e) => e.kind === "act_change")).toHaveLength(2);
    expect(rec.events[0]!.kind).toBe("run_start");
    expect(sim.kills).toBeGreaterThan(50);
    expect(rec.offers).toBeGreaterThan(3);
    expect(maxEnemies).toBeLessThanOrEqual(400);

    // cadence: ~4Hz hud, ~10Hz player_state, ~15s telemetry
    const endAt = rec.runEnd.length ? sim.pendingEnd!.at : Infinity;
    const secs = Math.min(frames * DT, endAt);
    expect(rec.hud).toBeGreaterThan(secs * 3);
    expect(rec.pacing).toBe(rec.hud);
    expect(rec.state).toBeGreaterThan(secs * 8);
    expect(rec.telemetry.length).toBeGreaterThanOrEqual(Math.floor(sim.played / 15) - 1);
    for (const t of rec.telemetry) expect(TelemetrySchema.safeParse(t).success).toBe(true);
    expect(rec.telemetry.some((t) => t.bossActive)).toBe(true);
    expect(rec.telemetry.at(-1)!.players).toBe(2);

    inn.emit("quit");
    inn.emit("quit");
    for (let f = 0; f < 200; f++) sim.step(DT, botInput(sim, f));
    expect(rec.runEnd).toHaveLength(1);
    const r = rec.runEnd[0]!;
    expect(RunReportSchema.safeParse(r).success).toBe(true);
    expect(r.outcome).toBe(sim.bossDefeated ? "victory" : "quit");
    expect(r.intensityCurve.length).toBeGreaterThan(60);
    off();
  });

  it("victory: boss defeat emits boss_defeated, victory and exactly one run_end", () => {
    const sim = new Sim({ world: makeWorld(77), runId: "v", players: 1, playerName: "p", rngSeed: 1 });
    sim.invulnerable = true;
    const rec = record(sim);
    sim.step(DT, botInput(sim, 0));
    sim.applyDirectives([{ tool: "spawn_boss", announce: "Here it comes" }]);
    sim.applyDirectives([{ tool: "spawn_boss", announce: "again" }]);
    expect(rec.applied.map((a) => a.ok)).toEqual([true, false]);
    expect(rec.applied[1]!.note).toMatch(/already/);
    expect(sim.hud().bossName).toBe(sim.world.boss.name);
    // run a while so boss patterns execute
    for (let f = 0; f < 60 * 20; f++) {
      sim.step(DT, botInput(sim, f));
      sim.fx.length = 0;
    }
    assertSane(sim);
    const boss = sim.boss!;
    expect(boss).toBeTruthy();
    expect(sim.hud().bossHp).toBeGreaterThan(0);
    // bring it through its phases
    for (let i = 0; i < 400 && sim.boss; i++) sim.damageEnemy(boss.e, boss.e.maxHp / 50, false, 0, 0, true);
    expect(sim.boss).toBeNull();
    const kinds = rec.events.map((e) => e.kind);
    expect(kinds).toContain("boss_defeated");
    expect(kinds).toContain("victory");
    if (sim.world.boss.phases > 1) expect(kinds).toContain("boss_phase");
    for (let f = 0; f < 60 * 5; f++) sim.step(DT, botInput(sim, f));
    sim.quit();
    expect(rec.runEnd).toHaveLength(1);
    expect(rec.runEnd[0]!.outcome).toBe("victory");
    expect(rec.runEnd[0]!.bossDefeated).toBe(true);
    expect(rec.runEnd[0]!.score).toBeGreaterThanOrEqual(1000);
    expect(RunReportSchema.safeParse(rec.runEnd[0]).success).toBe(true);
  });

  it("death: emits death and one run_end with killedBy", () => {
    const sim = new Sim({ world: makeWorld(9), runId: "d", players: 1, playerName: "p", rngSeed: 2 });
    const rec = record(sim);
    sim.step(DT, botInput(sim, 0));
    sim.player.iframes = 0;
    sim.hurtPlayer(1e6, "Test Spike");
    sim.hurtPlayer(1e6, "Again");
    for (let f = 0; f < 60 * 4; f++) sim.step(DT, botInput(sim, f));
    sim.quit();
    expect(rec.events.filter((e) => e.kind === "death")).toHaveLength(1);
    expect(rec.runEnd).toHaveLength(1);
    expect(rec.runEnd[0]!.outcome).toBe("death");
    expect(rec.runEnd[0]!.killedBy).toBe("Test Spike");
  });

  it("applies every directive type and reports invalid ones", () => {
    const sim = new Sim({ world: makeWorld(31), runId: "dir", players: 1, playerName: "p", rngSeed: 3 });
    sim.invulnerable = true;
    const rec = record(sim);
    sim.out.on("upgrade_offer", (o) => sim.pickUpgrade(o[0]!.id));
    for (let f = 0; f < 60 * 5; f++) sim.step(DT, botInput(sim, f));
    const ds: Directive[] = [
      { tool: "set_intensity_target", target: 0.8, rampSec: 5 },
      { tool: "adjust_spawns", rateMultiplier: 2, weights: [{ id: sim.world.enemies[0]!.id, weight: 1 }] },
      { tool: "set_music", energy: 0.5, tension: 0.5 },
      { tool: "narrate", line: "hi", mood: "hype" },
      { tool: "shift_biome", weather: "snow", fog: 0.7, tint: "#3366ff", announce: "Winter" },
      { tool: "mutate_enemies", archetypeId: sim.world.enemies[0]!.id, addModifier: "shielded", speedMultiplier: 1.5 },
      { tool: "mutate_enemies", archetypeId: "does_not_exist", addModifier: "cloaks", speedMultiplier: 1 },
      ...EVENT_KINDS.map((kind) => ({ tool: "inject_event" as const, kind, strength: 0.7, announce: kind })),
      ...BOON_KINDS.map((kind) => ({ tool: "grant_boon" as const, kind, announce: "" })),
      { tool: "inject_event", kind: "mirror_rival", strength: 0.5, announce: "again" },
    ];
    sim.applyDirectives(ds);
    expect(rec.applied).toHaveLength(ds.length);
    const byIdx = rec.applied;
    expect(byIdx[3]).toMatchObject({ ok: true, note: "shell" });
    expect(byIdx[6]!.ok).toBe(false);
    expect(byIdx.at(-1)!.ok).toBe(false); // second rival
    const failed = byIdx.filter((a) => !a.ok);
    expect(failed).toHaveLength(2);
    expect(sim.theme.weather).toBe("snow");
    expect(sim.blackoutT).toBeGreaterThan(0);
    expect(sim.chests.length + sim.shrines.length).toBe(2);
    expect(rec.events.filter((e) => e.kind === "event_started")).toHaveLength(EVENT_KINDS.length);
    expect(rec.events.filter((e) => e.kind === "boon")).toHaveLength(BOON_KINDS.length);
    for (let f = 0; f < 60 * 25; f++) {
      sim.step(DT, botInput(sim, f));
      if (f % 120 === 0) assertSane(sim);
      sim.fx.length = 0;
    }
    assertSane(sim);
    expect(sim.blackoutT).toBe(0);
    expect(sim.highlights.list.some((h) => h.startsWith("Survived blackout"))).toBe(true);
    // telemetry mentions the directives
    sim.emitTelemetry();
  });

  it("level-up pauses the simulation until pick_upgrade; shell pause works", () => {
    const sim = new Sim({ world: makeWorld(5), runId: "lvl", players: 1, playerName: "p", rngSeed: 4 });
    sim.invulnerable = true;
    const inn = new Bus<ShellToGame>();
    connectCommands(sim, inn);
    let offer: string[] = [];
    sim.out.on("upgrade_offer", (o) => (offer = o.map((x) => x.id)));
    sim.step(DT, botInput(sim, 0));
    sim.gainXp(sim.player.xpToNext * 3 + 50); // several levels at once
    sim.step(DT, botInput(sim, 1));
    expect(offer).toHaveLength(3);
    const t0 = sim.t;
    for (let f = 0; f < 60; f++) sim.step(DT, botInput(sim, f));
    expect(sim.t).toBe(t0);
    let picks = 0;
    while (sim.upgradeOffer && picks < 20) {
      inn.emit("pick_upgrade", offer[0]!);
      picks++;
    }
    expect(picks).toBeGreaterThanOrEqual(3);
    sim.step(DT, botInput(sim, 0));
    expect(sim.t).toBeGreaterThan(t0);
    inn.emit("pause");
    const t1 = sim.t;
    sim.step(DT, botInput(sim, 0));
    expect(sim.t).toBe(t1);
    inn.emit("resume");
    sim.step(DT, botInput(sim, 0));
    expect(sim.t).toBeGreaterThan(t1);
  });

  it("startOffsetSec skips ahead in the arc (late joiners)", () => {
    const world = makeWorld(8);
    const offset = world.arc[0]!.durationSec + world.arc[1]!.durationSec + 50;
    const sim = new Sim({ world, runId: "late", players: 3, playerName: "p", rngSeed: 5, startOffsetSec: offset });
    sim.invulnerable = true;
    sim.step(DT, botInput(sim, 0));
    expect(sim.act).toBe(2);
    expect(sim.bossSpawned).toBe(true);
    expect(sim.hud().t).toBeGreaterThanOrEqual(offset);
  });

  it("several random worlds run 90s without NaNs (non-invulnerable)", () => {
    for (let seed = 100; seed < 106; seed++) {
      const sim = new Sim({ world: makeWorld(seed), runId: `r${seed}`, players: 1, playerName: "p", rngSeed: seed });
      const rec = record(sim);
      sim.out.on("upgrade_offer", (o) => sim.pickUpgrade(o[0]!.id));
      for (let f = 0; f < 60 * 90 && !sim.endEmitted; f++) {
        sim.step(DT, botInput(sim, f));
        sim.fx.length = 0;
      }
      assertSane(sim);
      sim.quit();
      expect(rec.runEnd).toHaveLength(1);
      expect(RunReportSchema.safeParse(rec.runEnd[0]).success).toBe(true);
    }
  });
});
