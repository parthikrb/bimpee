import type { CitySim } from "./CitySim";
import {
  ABANDON_DAYS,
  DEMOLISH_ABANDONED_DAYS,
  GROWTH_CHANCE,
  GROWTH_PASSES_PER_DAY,
  LEVELUP_CHANCE,
  MAX_BUILD_SLOPE,
  OCCUPANTS,
  ROAD_REACH,
  UTIL_DEMAND,
} from "./constants";
import { igniteBuilding } from "./disasters";
import { addBuilding, removeBuilding, slopeAt } from "./grid";
import { TileFlag, TileKind } from "./protocol";
import { ZONE_TYPE, isZonedType, type Building } from "./types";

/**
 * Zoned growth. Each tick scans a slice of the grid (in a fixed seeded
 * order) so every tile is visited GROWTH_PASSES_PER_DAY times a day:
 * empty lots near a utility-served road may sprout a building, existing
 * buildings may densify. Abandonment / occupancy run once a day.
 */

const zoneDemand = (sim: CitySim, t: "res" | "com" | "ind") =>
  t === "res" ? sim.demand.residential : t === "com" ? sim.demand.commercial : sim.demand.industrial;

export function growthSlice(sim: CitySim) {
  const n = sim.n;
  const slice = Math.max(1, Math.ceil((n * GROWTH_PASSES_PER_DAY) / sim.ticksPerDay));
  for (let k = 0; k < slice; k++) {
    const i = sim.perm[sim.growthCursor]!;
    sim.growthCursor = (sim.growthCursor + 1) % n;
    visitTile(sim, i);
  }
}

/** rot facing the nearest road: 0 north (y-1), 1 east, 2 south, 3 west */
function facing(sim: CitySim, i: number): number {
  const r = sim.nearestRoad[i]!;
  if (r < 0) return 2;
  const s = sim.size;
  const dx = (r % s) - (i % s);
  const dy = ((r / s) | 0) - ((i / s) | 0);
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 1 : 3;
  return dy < 0 ? 0 : 2;
}

export function targetLevel(sim: CitySim, b: Building): number {
  const i = b.y * sim.size + b.x;
  const lv = sim.landValue[i]!;
  const services = (sim.covFire[i] ? 1 : 0) + (sim.covPolice[i] ? 1 : 0) + (sim.covHealth[i] || sim.covEdu[i] ? 1 : 0);
  let lvl = 1;
  if (lv >= 0.38 && sim.population >= 120) lvl = 2;
  if (lvl === 2 && lv >= 0.55 && sim.population >= 900 && services >= 2) lvl = 3;
  return lvl;
}

function visitTile(sim: CitySim, i: number) {
  const z = sim.zone[i]!;
  if (!z) return;
  const kind = sim.kind[i]!;
  const t = ZONE_TYPE[z]!;
  if (kind === TileKind.Building) {
    const id = sim.building[i]!;
    const b = id ? sim.buildings.get(id - 1) : undefined;
    if (b && isZonedType(b.type) && b.y * sim.size + b.x === i) maybeLevelUp(sim, b);
    return;
  }
  if (kind !== TileKind.Land && kind !== TileKind.Forest) return;
  if (sim.flags[i]! & (TileFlag.Rubble | TileFlag.Flooded | TileFlag.OnFire)) return;
  if (sim.roadDist[i]! > ROAD_REACH) return;
  const d = zoneDemand(sim, t);
  if (d <= 0.02) return;
  const pc = sim.powerComp[i]!;
  const wc = sim.waterComp[i]!;
  if (pc < 0 || wc < 0) return;
  const [pd, wd] = UTIL_DEMAND[t];
  if ((sim.powerSpare[pc] ?? 0) < pd || (sim.waterSpare[wc] ?? 0) < wd) return;
  if (slopeAt(sim, i) > MAX_BUILD_SLOPE) return;
  const p = (GROWTH_CHANCE * d * (0.5 + sim.landValue[i]!)) / GROWTH_PASSES_PER_DAY;
  if (!sim.rand.chance(p)) return;
  const s = sim.size;
  const b = addBuilding(sim, { type: t, x: i % s, y: (i / s) | 0, size: 1, rot: facing(sim, i), level: 1, cost: 0 });
  b.occupants = Math.round(OCCUPANTS[t][0] * 0.3);
  // reserve capacity until the next network solve
  sim.powerSpare[pc]! -= pd;
  sim.waterSpare[wc]! -= wd;
}

function maybeLevelUp(sim: CitySim, b: Building) {
  if (b.abandoned || !b.powered || !b.watered || b.damage > 0.3 || b.onFire || b.level >= 3) return;
  const t = b.type as "res" | "com" | "ind";
  if (zoneDemand(sim, t) < 0.08) return;
  if (targetLevel(sim, b) <= b.level) return;
  const i = b.y * sim.size + b.x;
  const [pd, wd] = UTIL_DEMAND[t];
  const pc = sim.powerComp[i]!;
  const wc = sim.waterComp[i]!;
  if (pc < 0 || wc < 0 || (sim.powerSpare[pc] ?? 0) < pd || (sim.waterSpare[wc] ?? 0) < wd) return;
  if (!sim.rand.chance(LEVELUP_CHANCE / GROWTH_PASSES_PER_DAY)) return;
  b.level++;
  sim.powerSpare[pc]! -= pd;
  sim.waterSpare[wc]! -= wd;
  sim.markTopo();
}

/** Once a day: utilities bookkeeping, abandonment, occupancy, repairs, accidental fires. */
export function dailyBuildings(sim: CitySim) {
  const toDemolish: Building[] = [];
  for (const b of sim.buildings.values()) {
    if (b.damage > 0 && b.damage < 1 && !b.onFire) b.damage = Math.max(0, b.damage - 0.12);
    if (!isZonedType(b.type)) {
      b.occupants = b.type === "landmark" || b.type === "park" ? 0 : b.powered ? 12 : 0;
      continue;
    }
    const t = b.type;
    const i = b.y * sim.size + b.x;
    b.noPowerDays = b.powered ? 0 : b.noPowerDays + 1;
    b.noWaterDays = b.watered ? 0 : b.noWaterDays + 1;
    const d = zoneDemand(sim, t);
    if (!b.abandoned) {
      let abandon = b.noPowerDays >= ABANDON_DAYS || b.noWaterDays >= ABANDON_DAYS;
      if (!abandon && t === "res" && sim.pollution[i]! > 0.85) abandon = sim.rand.chance(0.15);
      if (!abandon && d < -0.4 && sim.landValue[i]! < 0.3) abandon = sim.rand.chance(0.1);
      if (!abandon && sim.happiness < 0.2 && t === "res") abandon = sim.rand.chance(0.08);
      if (abandon) {
        b.abandoned = true;
        b.abandonedDays = 0;
        b.occupants = 0;
        sim.netDirty = true;
        sim.markTiles();
        continue;
      }
      const max = OCCUPANTS[t][b.level - 1]!;
      const fill = t === "res" ? 0.55 + 0.45 * sim.happiness : Math.min(1, Math.max(0.35, 0.65 + d * 0.4));
      const target = max * fill * (1 - Math.min(0.9, b.damage));
      b.occupants = Math.max(0, Math.round(b.occupants + (target - b.occupants) * 0.4));
      // accidental fires where nobody watches
      if (t === "ind" && !sim.covFire[i] && sim.rand.chance(0.002)) igniteBuilding(sim, b);
    } else {
      b.abandonedDays++;
      if (b.powered && b.watered && d > 0.05 && sim.rand.chance(0.4)) {
        b.abandoned = false;
        b.noPowerDays = 0;
        b.noWaterDays = 0;
        sim.netDirty = true;
        sim.markTiles();
      } else if (b.abandonedDays >= DEMOLISH_ABANDONED_DAYS) toDemolish.push(b);
    }
  }
  for (const b of toDemolish) removeBuilding(sim, b, "abandon", false);
}
