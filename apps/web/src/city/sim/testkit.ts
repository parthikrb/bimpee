import { generateFallbackCity, type CitySpec, type Zone } from "@bimpee/shared/city";
import type { CitySim } from "./CitySim";
import { TileKind } from "./protocol";

/** Test helpers (not used at runtime). */

export function makeSpec(seed = 7, patch: (s: CitySpec) => void = () => {}): CitySpec {
  const s = generateFallbackCity(seed);
  s.terrain = { ...s.terrain, kind: "island", size: 64, waterLevel: 0.3, roughness: 0.3, forest: 0.3 };
  s.climate = { ...s.climate, dayLengthSec: 60, startHour: 8 };
  s.economy = { ...s.economy, startingFunds: 100_000 };
  patch(s);
  return s;
}

/** Find a free spot for a size x size building near (cx, cy), scanning outward. */
export function findSpot(sim: CitySim, cx: number, cy: number, size: number, ok?: (x: number, y: number) => boolean): [number, number] | null {
  for (let r = 0; r < sim.size; r++) {
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r) continue;
        if (x < 0 || y < 0 || x + size > sim.size || y + size > sim.size) continue;
        let free = true;
        for (let dy = 0; dy < size && free; dy++)
          for (let dx = 0; dx < size && free; dx++) {
            const i = (y + dy) * sim.size + x + dx;
            const k = sim.kind[i];
            if (k !== TileKind.Land && k !== TileKind.Forest) free = false;
            if (sim.zone[i]) free = false;
          }
        if (free && (!ok || ok(x, y))) return [x, y];
      }
  }
  return null;
}

/** A plausible mayor: road grid, zones, utilities, services; returns a daily hook to keep utilities ahead of demand. */
export function scriptedCity(sim: CitySim, half = 14) {
  const c = Math.floor(sim.size / 2);
  const rows = [-12, -6, 0, 6, 12].filter((d) => Math.abs(d) <= half);
  const lo = c - half;
  const hi = c + half;
  // road grid in short segments so a steep spot only loses one segment
  for (const d of rows) {
    for (let x = lo; x < hi; x += 7) sim.command({ type: "road", path: [[x, c + d], [Math.min(hi, x + 7), c + d]] });
    for (let y = lo; y < hi; y += 6) sim.command({ type: "road", path: [[c + d, y], [c + d, Math.min(hi, y + 6)]] });
  }
  // zones: block by block
  const zoneFor = (bx: number, by: number): Zone => {
    if (bx === 0 && by === 0) return "commercial";
    if (bx === rows.length - 2 && by >= rows.length - 3) return "industrial";
    if ((bx + by) % 4 === 1) return "commercial";
    return "residential";
  };
  for (let by = 0; by < rows.length - 1; by++)
    for (let bx = 0; bx < rows.length - 1; bx++) {
      const x0 = c + rows[bx]! + 1;
      const x1 = c + rows[bx + 1]! - 1;
      const y0 = c + rows[by]! + 1;
      const y1 = c + rows[by + 1]! - 1;
      sim.command({ type: "zone", zone: zoneFor(bx, by), x0, y0, x1, y1 });
    }
  const placeNear = (kind: Parameters<typeof build>[1], x: number, y: number) => build(sim, kind, x, y);
  placeNear("power_coal", hi + 2, hi - 2);
  placeNear("water_tower", lo - 1, c);
  placeNear("water_tower", hi + 1, c);
  return {
    daily() {
      if (sim.power.supply < sim.power.demand * 1.3 + 30) placeNear(sim.funds > 20000 ? "power_coal" : "power_wind", hi + 2, hi - 2);
      if (sim.water.supply < sim.water.demand * 1.3 + 30) placeNear("water_tower", lo - 1, c);
      const day = sim.day;
      if (day === 3) placeNear("park", c - 3, c - 3);
      if (day === 4) placeNear("fire_station", c + 3, c + 3);
      if (day === 5) placeNear("police", c - 3, c + 3);
      if (day === 7) placeNear("clinic", c + 3, c - 3);
      if (day === 8) placeNear("school", c - 9, c);
      if (day === 10) placeNear("park", c + 9, c);
      if (day === 12) placeNear("fire_station", c - 9, c - 9);
      if (day === 14) placeNear("police", c + 9, c + 9);
    },
  };
}

/** place a building on the nearest free spot adjacent to a road */
export function build(sim: CitySim, kind: "power_coal" | "power_wind" | "power_solar" | "water_tower" | "water_pump" | "fire_station" | "police" | "clinic" | "school" | "park", x: number, y: number) {
  const size = kind === "power_coal" || kind === "power_solar" ? 2 : 1;
  for (let attempt = 0; attempt < 6; attempt++) {
    const spot = findSpot(sim, x, y, size, (sx, sy) => {
      for (let dy = -1; dy <= size; dy++)
        for (let dx = -1; dx <= size; dx++) {
          const xx = sx + dx;
          const yy = sy + dy;
          if (xx >= 0 && yy >= 0 && xx < sim.size && yy < sim.size && sim.kind[yy * sim.size + xx] === TileKind.Road) return true;
        }
      return false;
    });
    if (!spot) return null;
    const r = sim.command({ type: "build", kind, x: spot[0], y: spot[1], rot: 0 });
    if (r.ok) return spot;
    x += 1;
  }
  return null;
}

/**
 * Flatten the map to dry land (forest removed) for rule tests; optionally
 * carve water tiles where `water(x, y)` is true. Recomputes derived fields.
 */
export function flatWorld(sim: CitySim, water: (x: number, y: number) => boolean = () => false) {
  const V = sim.size + 1;
  const hi = sim.waterLevel + 1;
  const lo = Math.max(0, sim.waterLevel - 1);
  for (let vy = 0; vy < V; vy++)
    for (let vx = 0; vx < V; vx++) {
      // a vertex is low if every tile touching it is water
      let allWater = true;
      for (const [tx, ty] of [[vx - 1, vy - 1], [vx, vy - 1], [vx - 1, vy], [vx, vy]] as const) {
        if (tx < 0 || ty < 0 || tx >= sim.size || ty >= sim.size) continue;
        if (!water(tx, ty)) allWater = false;
      }
      sim.heights[vy * V + vx] = allWater ? lo : hi;
    }
  for (let y = 0; y < sim.size; y++)
    for (let x = 0; x < sim.size; x++) {
      const i = y * sim.size + x;
      const w = water(x, y);
      sim.terrainWater[i] = w ? 1 : 0;
      sim.kind[i] = w ? TileKind.Water : TileKind.Land;
      sim.zone[i] = 0;
      sim.flags[i] = 0;
      sim.pollution[i] = 0;
    }
  sim.forestGen.fill(0);
  sim.reinitDerived();
}
