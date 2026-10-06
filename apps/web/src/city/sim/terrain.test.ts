import { TERRAINS } from "@bimpee/shared/city";
import { describe, expect, it } from "vitest";
import { CitySim } from "./CitySim";
import { MAX_ROAD_SLOPE } from "./constants";
import { TileKind } from "./protocol";
import { generateTerrain, tileHeightOf, tileSlopeOf } from "./terrain";
import { makeSpec } from "./testkit";

describe("terrain", () => {
  for (const kind of TERRAINS) {
    for (const size of [48, 64, 80] as const) {
      it(`${kind} ${size}: deterministic, finite, buildable flat dry centre`, () => {
        for (const seed of [1, 99, 123456]) {
          const spec = makeSpec(seed, (s) => {
            s.terrain = { kind, size, waterLevel: 0.6, roughness: 0.9, forest: 0.8 };
          });
          const a = generateTerrain(spec);
          const b = generateTerrain(spec);
          expect(a.heights.length).toBe((size + 1) ** 2);
          expect(a.forest.length).toBe(size * size);
          expect(Array.from(a.heights)).toEqual(Array.from(b.heights));
          expect(Array.from(a.forest)).toEqual(Array.from(b.forest));
          expect(a.heights.every((h) => Number.isFinite(h) && h >= 0)).toBe(true);
          const c = Math.floor(size / 2);
          for (let y = c - 4; y <= c + 4; y++)
            for (let x = c - 4; x <= c + 4; x++) {
              expect(tileHeightOf(a.heights, size, x, y)).toBeGreaterThan(a.waterLevel);
              expect(tileSlopeOf(a.heights, size, x, y)).toBeLessThanOrEqual(MAX_ROAD_SLOPE);
              expect(a.forest[y * size + x]).toBe(0);
            }
        }
      });
    }
  }

  it("different seeds give different maps; island edges are sea", () => {
    const a = generateTerrain(makeSpec(1));
    const b = generateTerrain(makeSpec(2));
    expect(Array.from(a.heights)).not.toEqual(Array.from(b.heights));
    let water = 0;
    let edge = 0;
    for (let k = 0; k < 64; k++)
      for (const [x, y] of [[k, 0], [k, 63], [0, k], [63, k]] as const) {
        edge++;
        if (tileHeightOf(a.heights, 64, x, y) < a.waterLevel) water++;
      }
    expect(water / edge).toBeGreaterThan(0.9);
  });

  it("waterLevel raises the sea; forest seeds Forest tiles", () => {
    const frac = (wl: number) => {
      const t = generateTerrain(makeSpec(5, (s) => (s.terrain = { ...s.terrain, kind: "coastal", waterLevel: wl })));
      let w = 0;
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (tileHeightOf(t.heights, 64, x, y) < t.waterLevel) w++;
      return w / 4096;
    };
    expect(frac(0.9)).toBeGreaterThan(frac(0.1));
    const sim = new CitySim(makeSpec(5, (s) => (s.terrain = { ...s.terrain, forest: 0.9 })), "t");
    expect(sim.kind.some((k) => k === TileKind.Forest)).toBe(true);
    const bare = new CitySim(makeSpec(5, (s) => (s.terrain = { ...s.terrain, forest: 0 })), "t");
    expect(bare.kind.some((k) => k === TileKind.Forest)).toBe(false);
    for (let i = 0; i < sim.n; i++) expect(sim.kind[i] === TileKind.Water).toBe(sim.terrainWater[i] === 1);
  });
});
