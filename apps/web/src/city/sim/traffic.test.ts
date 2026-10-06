import { describe, expect, it } from "vitest";
import { CitySim } from "./CitySim";
import { carCap } from "./constants";
import { addBuilding } from "./grid";
import { recomputeNetworks } from "./networks";
import { TileKind } from "./protocol";
import { flatWorld, makeSpec } from "./testkit";

function roadsWorld() {
  const sim = new CitySim(makeSpec(9), "t");
  flatWorld(sim);
  // a ring plus a cross street
  sim.command({ type: "road", path: [[10, 10], [50, 10], [50, 50], [10, 50], [10, 10]] });
  sim.command({ type: "road", path: [[30, 10], [30, 50]] });
  return sim;
}

describe("traffic", () => {
  it("A* finds a contiguous road path and fails across a gap", () => {
    const sim = roadsWorld();
    const s = sim.size;
    const p = sim.traffic.astar(10 * s + 10, 50 * s + 50)!;
    expect(p).not.toBeNull();
    expect(p.length).toBe(81); // manhattan 80 + 1
    for (let k = 0; k < p.length; k++) {
      expect(sim.kind[p[k]!]).toBe(TileKind.Road);
      if (k) {
        const a = p[k - 1]!;
        const b = p[k]!;
        expect(Math.abs((a % s) - (b % s)) + Math.abs(((a / s) | 0) - ((b / s) | 0))).toBe(1);
      }
    }
    sim.command({ type: "road", path: [[55, 55], [60, 55]] });
    expect(sim.traffic.astar(10 * s + 10, 55 * s + 60)).toBeNull();
  });

  function populated() {
    const sim = roadsWorld();
    for (let x = 11; x < 50; x++) {
      addBuilding(sim, { type: "res", x, y: 11, size: 1, rot: 0, level: 3, cost: 0 }).occupants = 110;
      addBuilding(sim, { type: "com", x, y: 49, size: 1, rot: 0, level: 3, cost: 0 }).occupants = 60;
    }
    sim.population = 39 * 110;
    return sim;
  }

  it("spawns cars toward jobs, respects the cap, snapshot is finite and well-formed", () => {
    const sim = populated();
    let maxCars = 0;
    for (let k = 0; k < 600; k++) {
      sim.population = 39 * 110;
      sim.traffic.tick(0.1);
      maxCars = Math.max(maxCars, sim.traffic.count);
    }
    expect(maxCars).toBeGreaterThan(20);
    expect(maxCars).toBeLessThanOrEqual(carCap(sim.size));
    const snap = sim.traffic.snapshot();
    expect(snap.length).toBe(sim.traffic.count * 4);
    for (let i = 0; i < snap.length; i += 4) {
      expect(Number.isFinite(snap[i]!) && Number.isFinite(snap[i + 1]!) && Number.isFinite(snap[i + 2]!)).toBe(true);
      expect(snap[i]!).toBeGreaterThanOrEqual(0);
      expect(snap[i]!).toBeLessThanOrEqual(sim.size);
      expect([0, 1, 2, 3, 4]).toContain(snap[i + 3]);
    }
    // occupancy bookkeeping matches the number of cars
    expect(sim.traffic.occ.reduce((a, b) => a + b, 0)).toBe(sim.traffic.count);
    // snapshot buffers are fresh every call (safe to transfer)
    expect(sim.traffic.snapshot().buffer).not.toBe(snap.buffer);
  });

  it("two-way traffic uses opposite lanes", () => {
    const sim = roadsWorld();
    const s = sim.size;
    const t = sim.traffic as unknown as { add(p: Int32Array, k: number): void };
    t.add(sim.traffic.astar(20 * s + 30, 40 * s + 30)!, 0); // southbound
    t.add(sim.traffic.astar(40 * s + 30, 20 * s + 30)!, 0); // northbound
    for (let k = 0; k < 20; k++) sim.traffic.tick(0.1);
    const snap = sim.traffic.snapshot();
    expect(snap[0]).not.toBeCloseTo(snap[4]!, 1); // different x offsets
    expect(Math.abs(Math.abs(snap[0]! - snap[4]!) - 0.4)).toBeLessThan(0.05);
  });

  it("cars on a removed road disappear; congestion stays in 0..1", () => {
    const sim = populated();
    for (let k = 0; k < 300; k++) {
      sim.population = 39 * 110;
      sim.traffic.tick(0.1);
    }
    expect(sim.traffic.count).toBeGreaterThan(0);
    sim.command({ type: "bulldoze", x0: 0, y0: 0, x1: 63, y1: 63 });
    sim.traffic.tick(0.1);
    expect(sim.traffic.count).toBe(0);
    expect(sim.traffic.occ.every((v) => v === 0)).toBe(true);
    expect(sim.traffic.congestion()).toBeGreaterThanOrEqual(0);
    expect(sim.traffic.congestion()).toBeLessThanOrEqual(1);
    recomputeNetworks(sim);
  });
});
