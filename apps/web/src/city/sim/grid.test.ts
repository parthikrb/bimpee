import { BUILD_CATALOG } from "@bimpee/shared/city";
import { describe, expect, it } from "vitest";
import { CitySim } from "./CitySim";
import { BRIDGE_COST_MULT, MAX_BRIDGE } from "./constants";
import { rasterizePath } from "./grid";
import { TileFlag, TileKind } from "./protocol";
import { flatWorld, makeSpec } from "./testkit";

/** flat 64x64 world with a vertical river at x in [30, 30 + width) */
function river(width = 3) {
  const sim = new CitySim(makeSpec(3), "g");
  flatWorld(sim, (x) => x >= 30 && x < 30 + width);
  return sim;
}
const idx = (sim: CitySim, x: number, y: number) => y * sim.size + x;

describe("roads", () => {
  it("rasterizes straight and L segments", () => {
    expect(rasterizePath([[0, 0], [3, 0]])).toEqual([[0, 0], [1, 0], [2, 0], [3, 0]]);
    expect(rasterizePath([[0, 0], [2, 2]])).toEqual([[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]]);
    expect(rasterizePath([[5, 5], [5, 5]])).toEqual([[5, 5]]);
  });

  it("charges per new tile, sets connection bits, ignores existing road", () => {
    const sim = river();
    const f0 = sim.funds;
    const r = sim.command({ type: "road", path: [[10, 10], [14, 10]] });
    expect(r).toMatchObject({ ok: true, cost: 5 * BUILD_CATALOG.road.cost });
    expect(sim.funds).toBe(f0 - 50);
    expect(sim.roads[idx(sim, 10, 10)]).toBe(2); // east
    expect(sim.roads[idx(sim, 12, 10)]).toBe(2 | 8);
    const r2 = sim.command({ type: "road", path: [[12, 8], [12, 12]] });
    expect(r2.cost).toBe(4 * BUILD_CATALOG.road.cost); // crossing tile is free
    expect(sim.roads[idx(sim, 12, 10)]).toBe(1 | 2 | 4 | 8);
    expect(sim.command({ type: "road", path: [[10, 10], [14, 10]] }).ok).toBe(false);
  });

  it("refuses steep ground and out-of-map paths", () => {
    const sim = river();
    const V = sim.size + 1;
    sim.heights[20 * V + 20] = sim.heights[20 * V + 20]! + 3; // a spike at the corner of tile (20,20)
    const r = sim.command({ type: "road", path: [[15, 20], [25, 20]] });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/steep/);
    expect(sim.kind[idx(sim, 15, 20)]).toBe(TileKind.Land); // atomic
    expect(sim.command({ type: "road", path: [[60, 5], [70, 5]] }).ok).toBe(false);
    expect(sim.command({ type: "road", path: [[-1, 5], [3, 5]] }).ok).toBe(false);
  });

  it("bridges water at 5x cost, up to MAX_BRIDGE tiles, ending on land", () => {
    const sim = river(3);
    const r = sim.command({ type: "road", path: [[28, 10], [34, 10]] });
    expect(r.ok).toBe(true);
    expect(r.cost).toBe(4 * 10 + 3 * 10 * BRIDGE_COST_MULT);
    expect(sim.kind[idx(sim, 31, 10)]).toBe(TileKind.Road);
    expect(sim.command({ type: "road", path: [[28, 12], [31, 12]] }).reason).toMatch(/end on land/);
    const wide = river(MAX_BRIDGE + 1);
    expect(wide.command({ type: "road", path: [[28, 10], [42, 10]] }).reason).toMatch(/bridge/);
    const ok = river(MAX_BRIDGE);
    expect(ok.command({ type: "road", path: [[28, 10], [41, 10]] }).ok).toBe(true);
    // bulldozing a bridge restores water
    sim.command({ type: "bulldoze", x0: 31, y0: 10, x1: 31, y1: 10 });
    expect(sim.kind[idx(sim, 31, 10)]).toBe(TileKind.Water);
  });

  it("needs funds", () => {
    const sim = river();
    sim.funds = 15;
    expect(sim.command({ type: "road", path: [[1, 1], [5, 1]] }).reason).toMatch(/funds/);
    expect(sim.funds).toBe(15);
  });

  it("forest costs extra and is cleared", () => {
    const sim = river();
    sim.kind[idx(sim, 6, 6)] = TileKind.Forest;
    expect(sim.command({ type: "road", path: [[5, 6], [7, 6]] }).cost).toBe(32);
    expect(sim.kind[idx(sim, 6, 6)]).toBe(TileKind.Road);
  });
});

describe("zoning, building, bulldozing", () => {
  it("zones land only; null un-zones; player buildings are kept", () => {
    const sim = river();
    sim.command({ type: "road", path: [[20, 5], [20, 15]] });
    sim.command({ type: "build", kind: "park", x: 22, y: 8, rot: 0 });
    const r = sim.command({ type: "zone", zone: "residential", x0: 18, y0: 5, x1: 32, y1: 9 });
    expect(r.ok).toBe(true);
    expect(sim.zone[idx(sim, 19, 5)]).toBe(1);
    expect(sim.zone[idx(sim, 20, 5)]).toBe(0); // road
    expect(sim.zone[idx(sim, 30, 5)]).toBe(0); // water
    expect(sim.zone[idx(sim, 22, 8)]).toBe(0); // park
    expect(sim.kind[idx(sim, 22, 8)]).toBe(TileKind.Building);
    expect(sim.command({ type: "zone", zone: null, x0: 18, y0: 5, x1: 19, y1: 9 }).ok).toBe(true);
    expect(sim.zone[idx(sim, 19, 5)]).toBe(0);
    expect(sim.command({ type: "zone", zone: "industrial", x0: 30, y0: 0, x1: 32, y1: 3 }).ok).toBe(false);
  });

  it("places catalog buildings with cost, footprint, and refunds 25% on bulldoze", () => {
    const sim = river();
    const f0 = sim.funds;
    const r = sim.command({ type: "build", kind: "power_coal", x: 5, y: 5, rot: 1 });
    expect(r).toMatchObject({ ok: true, cost: BUILD_CATALOG.power_coal.cost });
    expect(sim.funds).toBe(f0 - 4000);
    const b = sim.buildingAt(6, 6)!;
    expect(b.type).toBe("power_coal");
    expect(b.size).toBe(2);
    expect(b.rot).toBe(1);
    expect(sim.command({ type: "build", kind: "park", x: 6, y: 6, rot: 0 }).ok).toBe(false);
    expect(sim.command({ type: "build", kind: "power_coal", x: 63, y: 5, rot: 0 }).ok).toBe(false); // off the edge
    expect(sim.command({ type: "build", kind: "park", x: 31, y: 5, rot: 0 }).ok).toBe(false); // water
    const d = sim.command({ type: "bulldoze", x0: 6, y0: 6, x1: 6, y1: 6 });
    expect(d).toMatchObject({ ok: true, cost: -1000 });
    expect(sim.funds).toBe(f0 - 3000);
    expect(sim.buildingAt(5, 5)).toBeNull();
    expect(sim.events.some((e) => e.kind === "collapse" && e.cause === "bulldoze")).toBe(true);
    expect(sim.command({ type: "bulldoze", x0: 6, y0: 6, x1: 6, y1: 6 }).ok).toBe(false);
  });

  it("water pumps need water nearby", () => {
    const sim = river();
    expect(sim.command({ type: "build", kind: "water_pump", x: 10, y: 10, rot: 0 }).ok).toBe(false);
    expect(sim.command({ type: "build", kind: "water_pump", x: 29, y: 10, rot: 0 }).ok).toBe(true);
  });

  it("bulldoze clears rubble, roads (refund) and forest; handles reversed/out-of-map rects", () => {
    const sim = river();
    sim.command({ type: "road", path: [[2, 2], [5, 2]] });
    sim.flags[idx(sim, 2, 4)] = TileFlag.Rubble;
    sim.kind[idx(sim, 3, 4)] = TileKind.Forest;
    const r = sim.command({ type: "bulldoze", x0: 70, y0: 70, x1: -5, y1: -5 });
    expect(r.ok).toBe(true);
    expect(sim.kind[idx(sim, 2, 2)]).toBe(TileKind.Land);
    expect(sim.flags[idx(sim, 2, 4)]! & TileFlag.Rubble).toBe(0);
    expect(sim.kind[idx(sim, 3, 4)]).toBe(TileKind.Land);
    expect(sim.roads.every((b) => b === 0)).toBe(true);
  });

  it("landmarks: once each, known ids only", () => {
    const sim = river();
    const id = sim.spec.landmarks[0]!.id;
    expect(sim.command({ type: "landmark", id: "nope", x: 10, y: 10 }).ok).toBe(false);
    const r = sim.command({ type: "landmark", id, x: 10, y: 10 });
    expect(r).toMatchObject({ ok: true, cost: sim.spec.landmarks[0]!.cost });
    expect(sim.buildingAt(10, 10)!.landmarkId).toBe(id);
    expect(sim.command({ type: "landmark", id, x: 14, y: 14 }).reason).toMatch(/already/);
    expect(sim.events.some((e) => e.kind === "built")).toBe(true);
  });

  it("rejects malformed commands without throwing", () => {
    const sim = river();
    expect(sim.command({ type: "road", path: [[1, 1]] } as never).ok).toBe(false);
    expect(sim.command({ type: "nope" } as never).ok).toBe(false);
    expect(sim.command(null as never).ok).toBe(false);
    expect(sim.command({ type: "build", kind: "park", x: 1.5, y: 1, rot: 0 } as never).ok).toBe(false);
  });

  it("tax and speed commands", () => {
    const sim = river();
    expect(sim.command({ type: "tax", rate: 0.15 }).ok).toBe(true);
    expect(sim.taxRate).toBe(0.15);
    expect(sim.command({ type: "tax", rate: 0.5 }).ok).toBe(false);
    sim.command({ type: "speed", speed: 0 });
    expect(sim.step(1)).toBe(0);
    sim.command({ type: "speed", speed: 4 });
    expect(sim.step(0.1)).toBe(4);
    expect(sim.step(100)).toBe(40); // catch-up capped
  });
});
