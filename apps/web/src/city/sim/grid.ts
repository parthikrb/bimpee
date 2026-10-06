import { BUILD_CATALOG, type Disaster, type Zone } from "@bimpee/shared/city";
import type { CitySim } from "./CitySim";
import {
  BRIDGE_COST_MULT,
  BULLDOZE_REFUND,
  CLEAR_FOREST_COST,
  CLEAR_RUBBLE_COST,
  MAX_BRIDGE,
  MAX_BUILD_SLOPE,
  MAX_ROAD_SLOPE,
  PUMP_WATER_REACH,
} from "./constants";
import { TileFlag, TileKind, type BuildingInfo, type BuildingType } from "./protocol";
import { hash32 } from "./rand";
import { tileSlopeOf } from "./terrain";
import { ZONE_CODE, isZonedType, type Building, type PlacedKind } from "./types";

export interface CmdResult {
  ok: boolean;
  reason: string | null;
  cost: number;
  /** tiles affected (telemetry summaries) */
  count?: number;
  /** tax change etc. */
  delta?: number;
}

const fail = (reason: string): CmdResult => ({ ok: false, reason, cost: 0 });

export const inBounds = (sim: CitySim, x: number, y: number) => x >= 0 && y >= 0 && x < sim.size && y < sim.size;

export function slopeAt(sim: CitySim, i: number) {
  return tileSlopeOf(sim.heights, sim.size, i % sim.size, (i / sim.size) | 0);
}

/** Recompute road connection bits for tile i and its four neighbours. */
export function refreshRoadBitsAround(sim: CitySim, i: number) {
  const s = sim.size;
  const x = i % s;
  const y = (i / s) | 0;
  refreshRoadBits(sim, x, y);
  if (y > 0) refreshRoadBits(sim, x, y - 1);
  if (x < s - 1) refreshRoadBits(sim, x + 1, y);
  if (y < s - 1) refreshRoadBits(sim, x, y + 1);
  if (x > 0) refreshRoadBits(sim, x - 1, y);
}

function refreshRoadBits(sim: CitySim, x: number, y: number) {
  const s = sim.size;
  const i = y * s + x;
  if (sim.kind[i] !== TileKind.Road) {
    sim.roads[i] = 0;
    return;
  }
  let b = 0;
  if (y > 0 && sim.kind[i - s] === TileKind.Road) b |= 1;
  if (x < s - 1 && sim.kind[i + 1] === TileKind.Road) b |= 2;
  if (y < s - 1 && sim.kind[i + s] === TileKind.Road) b |= 4;
  if (x > 0 && sim.kind[i - 1] === TileKind.Road) b |= 8;
  sim.roads[i] = b;
}

/** Tiles of a polyline through tile centres: straight runs, L-shaped between non-aligned points (x first). */
export function rasterizePath(path: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  const push = (x: number, y: number) => {
    const last = out[out.length - 1];
    if (!last || last[0] !== x || last[1] !== y) out.push([x, y]);
  };
  for (let k = 0; k < path.length; k++) {
    const [x1, y1] = path[k]!;
    if (k === 0) {
      push(x1, y1);
      continue;
    }
    const [x0, y0] = path[k - 1]!;
    const sx = Math.sign(x1 - x0);
    const sy = Math.sign(y1 - y0);
    let x = x0;
    let y = y0;
    while (x !== x1) {
      x += sx;
      push(x, y);
    }
    while (y !== y1) {
      y += sy;
      push(x, y);
    }
  }
  return out;
}

export function placeRoad(sim: CitySim, path: [number, number][]): CmdResult {
  if (path.length < 2) return fail("a road needs at least two points");
  for (const [x, y] of path) if (!inBounds(sim, x, y)) return fail("road leaves the map");
  const tiles = rasterizePath(path);
  if (tiles.length > 1024) return fail("road too long");
  const s = sim.size;
  let cost = 0;
  let bridgeRun = 0;
  let count = 0;
  const first = tiles[0]!;
  const last = tiles[tiles.length - 1]!;
  if (sim.kind[first[1] * s + first[0]] === TileKind.Water || sim.kind[last[1] * s + last[0]] === TileKind.Water) {
    return fail("roads must start and end on land");
  }
  for (const [x, y] of tiles) {
    const i = y * s + x;
    const k = sim.kind[i]!;
    if (k === TileKind.Road) {
      bridgeRun = sim.terrainWater[i] ? bridgeRun + 1 : 0;
      if (bridgeRun > MAX_BRIDGE) return fail(`bridge longer than ${MAX_BRIDGE} tiles`);
      continue;
    }
    if (k === TileKind.Building) return fail(`blocked by a building at ${x},${y}`);
    if (sim.flags[i]! & TileFlag.Rubble) return fail(`rubble at ${x},${y}: bulldoze it first`);
    if (k === TileKind.Water) {
      bridgeRun++;
      if (bridgeRun > MAX_BRIDGE) return fail(`bridge longer than ${MAX_BRIDGE} tiles`);
      cost += BUILD_CATALOG.road.cost * BRIDGE_COST_MULT;
    } else {
      bridgeRun = 0;
      if (slopeAt(sim, i) > MAX_ROAD_SLOPE) return fail(`too steep at ${x},${y}`);
      cost += BUILD_CATALOG.road.cost;
      if (k === TileKind.Forest) cost += CLEAR_FOREST_COST;
    }
    count++;
  }
  if (count === 0) return fail("road already there");
  if (cost > sim.funds) return fail("not enough funds");
  for (const [x, y] of tiles) {
    const i = y * s + x;
    if (sim.kind[i] === TileKind.Road) continue;
    sim.kind[i] = TileKind.Road;
    sim.zone[i] = 0;
    sim.flags[i] = sim.flags[i]! & ~(TileFlag.OnFire | TileFlag.Rubble);
  }
  for (const [x, y] of tiles) refreshRoadBitsAround(sim, y * s + x);
  sim.markRoads();
  return { ok: true, reason: null, cost, count };
}

const normRect = (sim: CitySim, x0: number, y0: number, x1: number, y1: number) => {
  const lx = Math.max(0, Math.min(x0, x1));
  const hx = Math.min(sim.size - 1, Math.max(x0, x1));
  const ly = Math.max(0, Math.min(y0, y1));
  const hy = Math.min(sim.size - 1, Math.max(y0, y1));
  return { lx, hx, ly, hy };
};

export function zoneRect(sim: CitySim, zone: Zone | null, x0: number, y0: number, x1: number, y1: number): CmdResult {
  const { lx, hx, ly, hy } = normRect(sim, x0, y0, x1, y1);
  if (lx > hx || ly > hy) return fail("outside the map");
  if ((hx - lx + 1) * (hy - ly + 1) > 64 * 64) return fail("area too large");
  const code = zone ? ZONE_CODE[zone] : 0;
  const s = sim.size;
  let count = 0;
  for (let y = ly; y <= hy; y++) {
    for (let x = lx; x <= hx; x++) {
      const i = y * s + x;
      const k = sim.kind[i]!;
      if (k === TileKind.Water || k === TileKind.Road) continue;
      if (k === TileKind.Building) {
        const b = sim.buildingAt(x, y);
        if (!b || !isZonedType(b.type)) continue; // player buildings keep their tiles
        if (sim.zone[i] === code) continue;
        removeBuilding(sim, b, null, false);
      }
      if (code && slopeAt(sim, i) > MAX_BUILD_SLOPE * 1.5) continue;
      if (sim.zone[i] !== code) {
        sim.zone[i] = code;
        count++;
      }
    }
  }
  if (!count) return fail(zone ? "nothing zonable here" : "nothing to un-zone");
  sim.markTopo();
  return { ok: true, reason: null, cost: 0, count };
}

export function bulldozeRect(sim: CitySim, x0: number, y0: number, x1: number, y1: number): CmdResult {
  const { lx, hx, ly, hy } = normRect(sim, x0, y0, x1, y1);
  if (lx > hx || ly > hy) return fail("outside the map");
  if ((hx - lx + 1) * (hy - ly + 1) > 64 * 64) return fail("area too large");
  const s = sim.size;
  let cost = 0;
  let count = 0;
  const seen = new Set<number>();
  // pass 1: price it
  for (let y = ly; y <= hy; y++) {
    for (let x = lx; x <= hx; x++) {
      const i = y * s + x;
      const k = sim.kind[i]!;
      if (k === TileKind.Building) {
        const b = sim.buildingAt(x, y);
        if (b && !seen.has(b.id)) {
          seen.add(b.id);
          cost -= b.cost * BULLDOZE_REFUND;
          count++;
        }
      } else if (k === TileKind.Road) {
        cost -= BUILD_CATALOG.road.cost * (sim.terrainWater[i] ? BRIDGE_COST_MULT : 1) * BULLDOZE_REFUND;
        count++;
      } else if (k === TileKind.Forest) {
        cost += CLEAR_FOREST_COST;
        count++;
      } else if (sim.flags[i]! & TileFlag.Rubble) {
        cost += CLEAR_RUBBLE_COST;
        count++;
      } else if (sim.zone[i]) {
        count++;
      }
    }
  }
  if (!count) return fail("nothing to bulldoze");
  if (cost > 0 && cost > sim.funds) return fail("not enough funds");
  let roadsChanged = false;
  for (const id of seen) {
    const b = sim.buildings.get(id);
    if (b) removeBuilding(sim, b, "bulldoze", false);
  }
  for (let y = ly; y <= hy; y++) {
    for (let x = lx; x <= hx; x++) {
      const i = y * s + x;
      const k = sim.kind[i]!;
      if (k === TileKind.Road) {
        sim.kind[i] = sim.terrainWater[i] ? TileKind.Water : TileKind.Land;
        roadsChanged = true;
      } else if (k === TileKind.Forest) {
        sim.kind[i] = TileKind.Land;
      }
      sim.flags[i] = sim.flags[i]! & ~(TileFlag.Rubble | TileFlag.OnFire);
      sim.zone[i] = 0;
    }
  }
  if (roadsChanged) {
    for (let y = Math.max(0, ly - 1); y <= Math.min(s - 1, hy + 1); y++)
      for (let x = Math.max(0, lx - 1); x <= Math.min(s - 1, hx + 1); x++) refreshRoadBitsAround(sim, y * s + x);
    sim.markRoads();
  } else sim.markTopo();
  return { ok: true, reason: null, cost: Math.round(cost), count };
}

/** null if the footprint can take a building, else the reason */
export function footprintProblem(sim: CitySim, x: number, y: number, size: number): string | null {
  if (!inBounds(sim, x, y) || !inBounds(sim, x + size - 1, y + size - 1)) return "outside the map";
  const s = sim.size;
  const V = s + 1;
  let lo = Infinity;
  let hi = -Infinity;
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const i = (y + dy) * s + x + dx;
      const k = sim.kind[i]!;
      if (k === TileKind.Water) return "can't build on water";
      if (k === TileKind.Road) return "a road is in the way";
      if (k === TileKind.Building) return "something is already built here";
      if (sim.flags[i]! & TileFlag.Rubble) return "clear the rubble first";
    }
  }
  for (let dy = 0; dy <= size; dy++) {
    for (let dx = 0; dx <= size; dx++) {
      const h = sim.heights[(y + dy) * V + x + dx]!;
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
  }
  if (hi - lo > MAX_BUILD_SLOPE * (size === 1 ? 1 : 1 + 0.35 * (size - 1))) return "ground too steep";
  return null;
}

function nearWater(sim: CitySim, x: number, y: number, size: number, reach: number): boolean {
  for (let yy = y - reach; yy < y + size + reach; yy++)
    for (let xx = x - reach; xx < x + size + reach; xx++)
      if (inBounds(sim, xx, yy) && sim.terrainWater[yy * sim.size + xx]) return true;
  return false;
}

export function placeBuilding(sim: CitySim, kind: PlacedKind, x: number, y: number, rot: number): CmdResult {
  const cat = BUILD_CATALOG[kind];
  if (!cat) return fail("unknown building");
  const problem = footprintProblem(sim, x, y, cat.size);
  if (problem) return fail(problem);
  if (kind === "water_pump" && !nearWater(sim, x, y, cat.size, PUMP_WATER_REACH)) return fail("a water pump must be next to water");
  if (cat.cost > sim.funds) return fail("not enough funds");
  addBuilding(sim, { type: kind, x, y, size: cat.size, rot: rot & 3, level: 1, cost: cat.cost });
  sim.emit({ kind: "built", what: cat.name, x, y });
  return { ok: true, reason: null, cost: cat.cost };
}

export function placeLandmark(sim: CitySim, id: string, x: number, y: number): CmdResult {
  const lm = sim.spec.landmarks.find((l) => l.id === id);
  if (!lm) return fail("unknown landmark");
  for (const b of sim.buildings.values()) if (b.landmarkId === id) return fail("already built");
  const problem = footprintProblem(sim, x, y, lm.footprint);
  if (problem) return fail(problem);
  if (lm.cost > sim.funds) return fail("not enough funds");
  addBuilding(sim, { type: "landmark", x, y, size: lm.footprint, rot: 0, level: 1, cost: lm.cost, landmarkId: id });
  sim.emit({ kind: "built", what: lm.name, x, y });
  return { ok: true, reason: null, cost: lm.cost };
}

export function addBuilding(
  sim: CitySim,
  p: { type: BuildingType; x: number; y: number; size: number; rot: number; level: number; cost: number; landmarkId?: string | null },
): Building {
  const id = sim.nextBuildingId++;
  const b: Building = {
    id,
    type: p.type,
    x: p.x,
    y: p.y,
    size: p.size,
    rot: p.rot,
    level: p.level,
    variant: hash32(id, sim.spec.seed) % 16,
    damage: 0,
    onFire: false,
    powered: false,
    watered: false,
    abandoned: false,
    landmarkId: p.landmarkId ?? null,
    occupants: 0,
    noPowerDays: 0,
    noWaterDays: 0,
    abandonedDays: 0,
    floodT: 0,
    offlineUntil: 0,
    cost: p.cost,
  };
  sim.buildings.set(id, b);
  const zoned = isZonedType(p.type);
  for (let dy = 0; dy < p.size; dy++) {
    for (let dx = 0; dx < p.size; dx++) {
      const i = (p.y + dy) * sim.size + p.x + dx;
      sim.kind[i] = TileKind.Building;
      sim.building[i] = id + 1;
      if (!zoned) sim.zone[i] = 0;
      sim.flags[i] = sim.flags[i]! & ~(TileFlag.Rubble | TileFlag.OnFire);
    }
  }
  sim.markTopo();
  return b;
}

/**
 * Remove a building. `cause` emits a collapse event (renderer debris);
 * `rubble` leaves Rubble-flagged land until bulldozed.
 */
export function removeBuilding(sim: CitySim, b: Building, cause: Disaster | "bulldoze" | "abandon" | null, rubble: boolean) {
  if (!sim.buildings.has(b.id)) return;
  sim.buildings.delete(b.id);
  for (let dy = 0; dy < b.size; dy++) {
    for (let dx = 0; dx < b.size; dx++) {
      const i = (b.y + dy) * sim.size + b.x + dx;
      if (sim.building[i] !== b.id + 1) continue;
      sim.building[i] = 0;
      sim.kind[i] = TileKind.Land;
      let f = sim.flags[i]! & ~(TileFlag.OnFire | TileFlag.Powered | TileFlag.Watered);
      if (rubble) f |= TileFlag.Rubble;
      sim.flags[i] = f;
    }
  }
  if (cause) sim.emit({ kind: "collapse", buildingId: b.id, type: b.type, x: b.x, y: b.y, size: b.size, cause });
  sim.markTopo();
}

/** Destroy a road tile (disasters). */
export function destroyRoad(sim: CitySim, i: number) {
  if (sim.kind[i] !== TileKind.Road) return;
  sim.kind[i] = sim.terrainWater[i] ? TileKind.Water : TileKind.Land;
  if (!sim.terrainWater[i]) sim.flags[i] = sim.flags[i]! | TileFlag.Rubble;
  refreshRoadBitsAround(sim, i);
  sim.roadVersion++;
  sim.markTopo();
}

/** BFS from road tiles: roadDist (steps, capped 255) and the nearest road tile index. */
export function recomputeRoadDistance(sim: CitySim) {
  const n = sim.n;
  const s = sim.size;
  const dist = sim.roadDist;
  const near = sim.nearestRoad;
  dist.fill(255);
  near.fill(-1);
  const q = queueBuf(sim);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) {
    if (sim.kind[i] === TileKind.Road) {
      dist[i] = 0;
      near[i] = i;
      q[tail++] = i;
    }
  }
  while (head < tail) {
    const i = q[head++]!;
    const d = dist[i]!;
    if (d >= 6) continue;
    const x = i % s;
    const tryN = (j: number) => {
      if (dist[j]! > d + 1 && sim.kind[j] !== TileKind.Water) {
        dist[j] = d + 1;
        near[j] = near[i]!;
        q[tail++] = j;
      }
    };
    if (i >= s) tryN(i - s);
    if (x < s - 1) tryN(i + 1);
    if (i + s < n) tryN(i + s);
    if (x > 0) tryN(i - 1);
  }
}

const queues = new WeakMap<CitySim, Int32Array>();
/** shared BFS queue (size n) per sim */
export function queueBuf(sim: CitySim): Int32Array {
  let q = queues.get(sim);
  if (!q) {
    q = new Int32Array(sim.n);
    queues.set(sim, q);
  }
  return q;
}

export function toBuildingInfo(b: Building): BuildingInfo {
  return {
    id: b.id,
    type: b.type,
    x: b.x,
    y: b.y,
    size: b.size,
    rot: b.rot,
    level: b.level,
    variant: b.variant,
    damage: Math.min(1, Math.max(0, b.damage)),
    onFire: b.onFire,
    powered: b.powered,
    watered: b.watered,
    abandoned: b.abandoned,
    landmarkId: b.landmarkId,
    occupants: Math.round(b.occupants),
  };
}
