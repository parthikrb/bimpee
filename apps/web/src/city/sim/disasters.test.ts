import type { Disaster } from "@bimpee/shared/city";
import { describe, expect, it } from "vitest";
import { CitySim } from "./CitySim";
import { addBuilding } from "./grid";
import { recomputeNetworks } from "./networks";
import type { CityEvent } from "./protocol";
import { TileFlag, TileKind } from "./protocol";
import { flatWorld, makeSpec } from "./testkit";

/** flat world, sea strip on the west (x < 6), dense powered block of res buildings in [20,44)^2 */
function dense(seed = 21, opts: { fireStations?: boolean } = {}) {
  const sim = new CitySim(makeSpec(seed), "d");
  flatWorld(sim, (x) => x < 6);
  sim.funds = 1e6;
  sim.command({ type: "road", path: [[19, 19], [44, 19], [44, 44], [19, 44], [19, 19]] });
  sim.command({ type: "build", kind: "power_coal", x: 45, y: 20, rot: 0 });
  sim.command({ type: "build", kind: "power_coal", x: 45, y: 22, rot: 0 });
  sim.command({ type: "build", kind: "water_pump", x: 7, y: 19, rot: 0 });
  sim.command({ type: "road", path: [[7, 20], [19, 20]] });
  if (opts.fireStations) for (const [x, y] of [[25, 18], [38, 18], [25, 45], [38, 45], [18, 30], [45, 32]]) sim.command({ type: "build", kind: "fire_station", x: x!, y: y!, rot: 0 });
  for (let y = 20; y < 44; y++) for (let x = 20; x < 44; x++) addBuilding(sim, { type: "res", x, y, size: 1, rot: 0, level: 1, cost: 0 });
  recomputeNetworks(sim);
  sim.events = [];
  return sim;
}

function runUntilQuiet(sim: CitySim, maxTicks = 4000) {
  const events: CityEvent[] = [];
  let k = 0;
  for (; k < maxTicks; k++) {
    sim.tick();
    events.push(...sim.events);
    sim.events = [];
    if (sim.disasters.length === 0) break;
  }
  return { events, ticks: k };
}
const count = (sim: CitySim) => sim.buildings.size;

describe("disasters", () => {
  const kinds: Disaster[] = ["earthquake", "tornado", "flood", "meteor", "fire", "blackout"];
  for (const kind of kinds) {
    it(`${kind}: start/end events, ends, finite state`, () => {
      const sim = dense();
      const r = sim.command({ type: "sandbox_disaster", kind, x: 32, y: 32, strength: 1 });
      expect(r.ok).toBe(true);
      expect(sim.events[0]).toMatchObject({ kind: "disaster_start", disaster: kind });
      const ad = sim.activeDisasters()[0]!;
      expect(ad.kind).toBe(kind);
      const { events } = runUntilQuiet(sim);
      expect(sim.disasters.length).toBe(0);
      expect(events.some((e) => e.kind === "disaster_end" && e.disaster === kind)).toBe(true);
      expect(sim.disastersSurvived).toBe(1);
      expect(sim.shake).toBe(0);
      for (const b of sim.buildings.values()) expect(Number.isFinite(b.damage)).toBe(true);
    });
  }

  it("earthquake shakes, damages by distance and collapses into rubble", () => {
    const sim = dense();
    sim.command({ type: "sandbox_disaster", kind: "earthquake", x: 32, y: 32, strength: 1 });
    let maxShake = 0;
    const events: CityEvent[] = [];
    for (let k = 0; k < 100; k++) {
      sim.tick();
      const f = sim.drainFrame();
      maxShake = Math.max(maxShake, f.shake);
      events.push(...f.events);
    }
    expect(maxShake).toBeGreaterThan(0.8);
    const collapses = events.filter((e) => e.kind === "collapse" && e.cause === "earthquake");
    expect(collapses.length).toBeGreaterThan(5);
    const c = collapses[0] as Extract<CityEvent, { kind: "collapse" }>;
    expect(sim.flags[c.y * sim.size + c.x]! & TileFlag.Rubble).toBeTruthy();
    // closer to the epicentre = more destruction
    const near = collapses.filter((e) => Math.hypot((e as { x: number }).x + 0.5 - 32.5, (e as { y: number }).y + 0.5 - 32.5) < 6).length;
    const far = collapses.filter((e) => Math.hypot((e as { x: number }).x + 0.5 - 32.5, (e as { y: number }).y + 0.5 - 32.5) > 14).length;
    expect(near).toBeGreaterThan(far);
    // rubble blocks roads and growth until bulldozed
    expect(sim.command({ type: "road", path: [[c.x, c.y], [c.x, c.y]] }).ok).toBe(false);
    expect(sim.command({ type: "bulldoze", x0: c.x, y0: c.y, x1: c.x, y1: c.y }).ok).toBe(true);
    expect(sim.flags[c.y * sim.size + c.x]! & TileFlag.Rubble).toBe(0);
  });

  it("weak earthquake far away leaves the town standing", () => {
    const sim = dense();
    const before = count(sim);
    sim.command({ type: "sandbox_disaster", kind: "earthquake", x: 60, y: 60, strength: 0.1 });
    runUntilQuiet(sim);
    expect(count(sim)).toBe(before);
  });

  it("tornado moves and wrecks buildings along its path", () => {
    const sim = dense();
    const before = count(sim);
    sim.command({ type: "sandbox_disaster", kind: "tornado", x: 32, y: 32, strength: 1 });
    const start = { x: sim.disasters[0]!.x, y: sim.disasters[0]!.y };
    for (let k = 0; k < 50; k++) sim.tick();
    const d = sim.disasters[0]!;
    expect(Math.hypot(d.x - start.x, d.y - start.y)).toBeGreaterThan(3);
    const { events } = runUntilQuiet(sim);
    expect(count(sim)).toBeLessThan(before);
    expect(events.some((e) => e.kind === "collapse" && e.cause === "tornado")).toBe(true);
  });

  it("flood raises water near the sea, floods low land, takes producers offline, then recedes", () => {
    const sim = dense();
    sim.command({ type: "sandbox_disaster", kind: "flood", x: 8, y: 20, strength: 1 });
    for (let k = 0; k < 150; k++) sim.tick();
    expect(sim.disasters[0]!.level).toBeGreaterThan(1);
    let flooded = 0;
    for (let i = 0; i < sim.n; i++) if (sim.flags[i]! & TileFlag.Flooded) flooded++;
    expect(flooded).toBeGreaterThan(20);
    expect(sim.water.supply).toBe(0); // pump under water
    runUntilQuiet(sim);
    for (let i = 0; i < sim.n; i++) expect(sim.flags[i]! & TileFlag.Flooded).toBe(0);
    sim.advance(10);
    expect(sim.water.supply).toBeGreaterThan(0);
  });

  it("meteor: impact event after a delay, crater lowers terrain and re-emits it", () => {
    const sim = dense();
    sim.drainTerrain(); // mark sent
    sim.getTerrainMsg();
    expect(sim.drainTerrain()).toBeNull();
    const V = sim.size + 1;
    const h0 = sim.heights[32 * V + 32]!;
    sim.command({ type: "sandbox_disaster", kind: "meteor", x: 32, y: 32, strength: 1 });
    const events: CityEvent[] = [];
    for (let k = 0; k < 20; k++) {
      sim.tick();
      events.push(...sim.events);
      sim.events = [];
    }
    expect(events.some((e) => e.kind === "meteor_impact")).toBe(false); // still falling
    for (let k = 0; k < 20; k++) {
      sim.tick();
      events.push(...sim.events);
      sim.events = [];
    }
    expect(events.find((e) => e.kind === "meteor_impact")).toMatchObject({ x: 32.5, y: 32.5 });
    expect(events.filter((e) => e.kind === "collapse" && e.cause === "meteor").length).toBeGreaterThan(10);
    expect(sim.heights[32 * V + 32]!).toBeLessThan(h0 - 2);
    const t = sim.drainTerrain()!;
    expect(t).not.toBeNull();
    expect(t.heights[32 * V + 32]).toBeCloseTo(sim.heights[32 * V + 32]!);
    // deep crater fills with water
    expect(sim.kind[32 * sim.size + 32]).toBe(TileKind.Water);
    expect(sim.buildingAt(32, 32)).toBeNull();
  });

  it("fire spreads less where fire stations cover it", () => {
    const burned = (stations: boolean) => {
      let total = 0;
      for (const seed of [1, 2, 3, 4]) {
        const sim = dense(seed, { fireStations: stations });
        sim.weather = "clear";
        sim.weatherDaysLeft = 99;
        const before = count(sim);
        sim.command({ type: "sandbox_disaster", kind: "fire", x: 32, y: 32, strength: 1 });
        const { events } = runUntilQuiet(sim);
        expect(events.some((e) => e.kind === "fire_started")).toBe(true);
        total += before - count(sim);
      }
      return total;
    };
    const without = burned(false);
    const withStations = burned(true);
    expect(without).toBeGreaterThan(withStations);
  });

  it("fire on an empty spot is refused; Fate obeys allowed list and one-at-a-time; coords clamp", () => {
    const sim = dense();
    expect(sim.command({ type: "sandbox_disaster", kind: "fire", x: 60, y: 2, strength: 1 }).ok).toBe(false);
    sim.spec.disasters.allowed = ["tornado", "earthquake"];
    sim.applyDirectives([{ tool: "trigger_disaster", kind: "meteor", x: 3, y: 3, strength: 1, headline: "x" }]);
    expect(sim.disasters.length).toBe(0);
    sim.applyDirectives([
      { tool: "trigger_disaster", kind: "tornado", x: -50, y: 999, strength: 0.5, headline: "Twister!" },
      { tool: "trigger_disaster", kind: "earthquake", x: 3, y: 3, strength: 1, headline: "x" },
    ]);
    expect(sim.disasters.length).toBe(1);
    expect(sim.disasters[0]!.x).toBe(0.5);
    expect(sim.disasters[0]!.y).toBe(sim.size - 0.5);
    expect(sim.events.find((e) => e.kind === "disaster_start")).toMatchObject({ headline: "Twister!" });
    // sandbox can stack
    expect(sim.command({ type: "sandbox_disaster", kind: "meteor", x: 5, y: 5, strength: 0.2 }).ok).toBe(true);
    expect(sim.getTelemetry().activeDisasters).toEqual(["tornado", "meteor"]);
  });
});
