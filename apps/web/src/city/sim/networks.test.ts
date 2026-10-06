import { CityTelemetrySchema } from "@bimpee/shared/city";
import { describe, expect, it } from "vitest";
import { CitySim } from "./CitySim";
import { addBuilding } from "./grid";
import { recomputeNetworks } from "./networks";
import { TileFlag } from "./protocol";
import { flatWorld, makeSpec } from "./testkit";

function world() {
  const sim = new CitySim(makeSpec(4), "n");
  flatWorld(sim);
  return sim;
}
const runDays = (sim: CitySim, d: number) => sim.advance(sim.ticksPerDay * d);

describe("power & water networks", () => {
  it("propagates through roads, zones and adjacent buildings; disconnected stays dark", () => {
    const sim = world();
    sim.command({ type: "build", kind: "power_wind", x: 10, y: 9, rot: 0 });
    sim.command({ type: "road", path: [[10, 10], [20, 10]] });
    const near = addBuilding(sim, { type: "res", x: 20, y: 11, size: 1, rot: 0, level: 1, cost: 0 });
    const chained = addBuilding(sim, { type: "res", x: 20, y: 12, size: 1, rot: 0, level: 1, cost: 0 }); // via neighbour building
    const far = addBuilding(sim, { type: "res", x: 40, y: 40, size: 1, rot: 0, level: 1, cost: 0 });
    recomputeNetworks(sim);
    expect(near.powered).toBe(true);
    expect(chained.powered).toBe(true);
    expect(far.powered).toBe(false);
    expect(sim.flags[10 * sim.size + 15]! & TileFlag.Powered).toBeTruthy();
    expect(sim.flags[40 * sim.size + 40]! & TileFlag.Powered).toBe(0);
    expect(sim.power.supply).toBe(60);
    expect(sim.power.greenShare).toBe(1);
  });

  it("in a shortage the farthest consumers go dark", () => {
    const sim = world();
    sim.command({ type: "build", kind: "water_tower", x: 9, y: 10, rot: 0 }); // 120 water
    sim.command({ type: "road", path: [[10, 10], [60, 10]] });
    const bs = [];
    for (let x = 11; x < 60; x++) bs.push(addBuilding(sim, { type: "ind", x, y: 11, size: 1, rot: 0, level: 3, cost: 0 })); // 9 water each
    recomputeNetworks(sim);
    expect(sim.water.demand).toBeGreaterThan(sim.water.supply);
    const served = bs.filter((b) => b.watered).length;
    expect(served).toBe(Math.floor(120 / 9));
    expect(bs[0]!.watered).toBe(true);
    expect(bs[bs.length - 1]!.watered).toBe(false);
  });

  it("coal counts as non-green; blackout zeroes supply until it ends", () => {
    const sim = world();
    sim.command({ type: "build", kind: "power_coal", x: 10, y: 10, rot: 0 });
    sim.command({ type: "build", kind: "power_wind", x: 12, y: 10, rot: 0 });
    recomputeNetworks(sim);
    expect(sim.power.greenShare).toBeCloseTo(60 / 460, 2);
    sim.command({ type: "sandbox_disaster", kind: "blackout", x: 5, y: 5, strength: 0 });
    sim.advance(10);
    expect(sim.power.supply).toBe(0);
    runDays(sim, 1);
    expect(sim.disasters.length).toBe(0);
    sim.advance(10);
    expect(sim.power.supply).toBeGreaterThan(0);
  });
});

describe("zoning growth", () => {
  function town(power: boolean, water: boolean) {
    const sim = world();
    sim.command({ type: "road", path: [[20, 20], [40, 20]] });
    if (power) sim.command({ type: "build", kind: "power_coal", x: 18, y: 19, rot: 0 });
    if (water) sim.command({ type: "build", kind: "water_tower", x: 41, y: 20, rot: 0 });
    sim.command({ type: "zone", zone: "residential", x0: 20, y0: 21, x1: 40, y1: 23 });
    sim.command({ type: "zone", zone: "commercial", x0: 20, y0: 17, x1: 30, y1: 19 });
    sim.command({ type: "zone", zone: "industrial", x0: 31, y0: 17, x1: 40, y1: 19 });
    return sim;
  }

  it("grows only with both power and water", () => {
    const none = town(false, false);
    const pOnly = town(true, false);
    const both = town(true, true);
    for (const s of [none, pOnly, both]) runDays(s, 6);
    const zoned = (s: CitySim) => [...s.buildings.values()].filter((b) => b.type === "res" || b.type === "com" || b.type === "ind").length;
    expect(zoned(none)).toBe(0);
    expect(zoned(pOnly)).toBe(0);
    expect(zoned(both)).toBeGreaterThan(10);
    expect(both.population).toBeGreaterThan(50);
    // grown buildings face the road and get a variant
    const b = [...both.buildings.values()].find((x) => x.type === "res" && x.y === 21)!;
    expect(b.rot).toBe(0);
    expect(b.variant).toBeGreaterThanOrEqual(0);
  });

  it("buildings are abandoned after losing utilities, then demolished", () => {
    const sim = town(true, true);
    runDays(sim, 6);
    const grown = [...sim.buildings.values()].filter((b) => b.type === "res").length;
    expect(grown).toBeGreaterThan(0);
    const tower = [...sim.buildings.values()].find((b) => b.type === "water_tower")!;
    sim.command({ type: "bulldoze", x0: tower.x, y0: tower.y, x1: tower.x, y1: tower.y });
    runDays(sim, 5);
    expect([...sim.buildings.values()].filter((b) => b.type === "res" && b.abandoned).length).toBeGreaterThan(0);
    expect(sim.population).toBe(0);
    sim.events = [];
    runDays(sim, 10);
    expect(sim.events.some((e) => e.kind === "collapse" && e.cause === "abandon")).toBe(true);
  });
});

describe("economy", () => {
  it("applies the daily ledger at rollover and goes into debt", () => {
    const sim = world();
    sim.command({ type: "build", kind: "power_coal", x: 10, y: 10, rot: 0 });
    sim.command({ type: "build", kind: "fire_station", x: 13, y: 10, rot: 0 });
    sim.advance(sim.ticksPerDay - Math.round((sim.time % 1) * sim.ticksPerDay) - 2);
    const before = sim.funds;
    const exp = sim.expensesPerDay;
    expect(exp).toBe(Math.round((40 + 20) * (0.8 + 0.4 * sim.spec.economy.difficulty)));
    sim.advance(4);
    expect(sim.funds).toBe(before - exp); // nobody pays tax yet
    sim.funds = 100;
    runDays(sim, 3);
    expect(sim.funds).toBeLessThan(0);
    expect(sim.events.some((e) => e.kind === "economy" && /debt/.test(e.text))).toBe(true);
    expect(CityTelemetrySchema.safeParse(sim.getTelemetry()).success).toBe(true);
    // in debt: interest grows expenses, construction refused
    sim.funds = -5000;
    sim.advance(20);
    expect(sim.expensesPerDay).toBe(exp + 50);
    expect(sim.command({ type: "build", kind: "park", x: 30, y: 30, rot: 0 }).reason).toMatch(/funds/);
  });

  it("high taxes damp demand", () => {
    const lo = world();
    const hi = world();
    lo.command({ type: "tax", rate: 0 });
    hi.command({ type: "tax", rate: 0.2 });
    lo.advance(300);
    hi.advance(300);
    expect(lo.demand.residential).toBeGreaterThan(hi.demand.residential + 0.3);
    expect(hi.demand.commercial).toBeLessThan(0);
  });
});
