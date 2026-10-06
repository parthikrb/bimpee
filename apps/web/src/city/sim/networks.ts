import { BUILD_CATALOG } from "@bimpee/shared/city";
import type { CitySim } from "./CitySim";
import { LANDMARK_EFFECT_RADIUS, LANDMARK_UTIL_DEMAND, LANDMARK_UTILITY_OUTPUT, SERVICE_UTIL_DEMAND, UTIL_DEMAND } from "./constants";
import { queueBuf } from "./grid";
import { TileFlag, TileKind } from "./protocol";
import { isPowerProducer, isWaterProducer, isZonedType, type Building } from "./types";

/**
 * Power and water networks. Utilities flow through roads, zoned lots and
 * buildings (4-connected). Each connected component pools its producers'
 * output; consumers are served nearest-first (BFS distance from producers),
 * so in a shortage the farthest ones go dark. Recomputed when the topology,
 * producer state or the hour (solar) changes, never every tick.
 */

let distBuf: Int32Array | null = null;

const conductive = (sim: CitySim, i: number) => {
  const k = sim.kind[i]!;
  return k === TileKind.Road || k === TileKind.Building || (sim.zone[i]! > 0 && k !== TileKind.Water);
};

export function producerOnline(sim: CitySim, b: Building): boolean {
  return b.offlineUntil <= sim.simTime && b.damage < 1 && !b.onFire && !isFlooded(sim, b);
}

function isFlooded(sim: CitySim, b: Building): boolean {
  for (let dy = 0; dy < b.size; dy++)
    for (let dx = 0; dx < b.size; dx++) if (sim.flags[(b.y + dy) * sim.size + b.x + dx]! & TileFlag.Flooded) return true;
  return false;
}

export function powerOutput(sim: CitySim, b: Building): number {
  if (!producerOnline(sim, b)) return 0;
  const blackout = sim.disasters.some((d) => d.kind === "blackout");
  if (blackout) return 0;
  if (b.type === "landmark") {
    const lm = sim.spec.landmarks.find((l) => l.id === b.landmarkId);
    return lm?.effect === "power" ? LANDMARK_UTILITY_OUTPUT : 0;
  }
  const base = BUILD_CATALOG[b.type as "power_coal"]?.power ?? 0;
  const health = 1 - Math.min(0.9, b.damage);
  if (b.type === "power_solar") {
    const h = sim.hour;
    const sun = h >= 6 && h <= 20 ? Math.sin(((h - 6) / 14) * Math.PI) * 0.8 + 0.2 : 0.1;
    const cloud = sim.weather === "rain" || sim.weather === "storm" || sim.weather === "fog" || sim.weather === "snow" ? 0.5 : sim.weather === "heatwave" ? 1.1 : 1;
    return base * sun * cloud * health;
  }
  if (b.type === "power_wind") {
    const w = sim.weather === "storm" ? 1.5 : sim.weather === "heatwave" ? 0.6 : sim.weather === "fog" ? 0.8 : 1;
    return base * w * health;
  }
  return base * health;
}

export function waterOutput(sim: CitySim, b: Building): number {
  if (!producerOnline(sim, b)) return 0;
  if (b.type === "landmark") {
    const lm = sim.spec.landmarks.find((l) => l.id === b.landmarkId);
    return lm?.effect === "water" ? LANDMARK_UTILITY_OUTPUT : 0;
  }
  const base = BUILD_CATALOG[b.type as "water_tower"]?.water ?? 0;
  const drought = sim.weather === "heatwave" ? 0.8 : 1;
  return base * drought * (1 - Math.min(0.9, b.damage));
}

/** [power, water] a building consumes */
export function utilDemand(sim: CitySim, b: Building): [number, number] {
  if (b.abandoned) return [0, 0];
  if (isZonedType(b.type)) {
    const d = UTIL_DEMAND[b.type];
    const heat = sim.weather === "heatwave" ? 1.15 : sim.weather === "snow" ? 1.1 : 1;
    return [d[0] * b.level * heat, d[1] * b.level];
  }
  if (b.type === "landmark") return [LANDMARK_UTIL_DEMAND[0], LANDMARK_UTIL_DEMAND[1]];
  if (b.type === "park" || isPowerProducer(b.type) || isWaterProducer(b.type)) return [0, 0];
  return [SERVICE_UTIL_DEMAND[0], SERVICE_UTIL_DEMAND[1]];
}

interface NetResult {
  supply: number;
  demand: number;
}

function solveNetwork(
  sim: CitySim,
  comp: Int32Array,
  spareOut: number[],
  isProducer: (b: Building) => number,
  demandOf: (b: Building) => number,
  setServed: (b: Building, v: boolean) => void,
  flag: number,
): NetResult {
  const n = sim.n;
  const s = sim.size;
  if (!distBuf || distBuf.length !== n) distBuf = new Int32Array(n);
  const dist = distBuf;
  const q = queueBuf(sim);
  // 1) components
  comp.fill(-1);
  let nComp = 0;
  for (let i = 0; i < n; i++) {
    if (comp[i] !== -1 || !conductive(sim, i)) continue;
    let head = 0;
    let tail = 0;
    q[tail++] = i;
    comp[i] = nComp;
    while (head < tail) {
      const j = q[head++]!;
      const x = j % s;
      if (j >= s && comp[j - s] === -1 && conductive(sim, j - s)) ((comp[j - s] = nComp), (q[tail++] = j - s));
      if (x < s - 1 && comp[j + 1] === -1 && conductive(sim, j + 1)) ((comp[j + 1] = nComp), (q[tail++] = j + 1));
      if (j + s < n && comp[j + s] === -1 && conductive(sim, j + s)) ((comp[j + s] = nComp), (q[tail++] = j + s));
      if (x > 0 && comp[j - 1] === -1 && conductive(sim, j - 1)) ((comp[j - 1] = nComp), (q[tail++] = j - 1));
    }
    nComp++;
  }
  const spare = new Array<number>(nComp).fill(0);
  // 2) producers + multi-source BFS distance
  dist.fill(-1);
  let head = 0;
  let tail = 0;
  let supply = 0;
  for (const b of sim.buildings.values()) {
    const out = isProducer(b);
    if (out <= 0) continue;
    supply += out;
    const c = comp[b.y * s + b.x]!;
    if (c >= 0) spare[c]! += out;
    for (let dy = 0; dy < b.size; dy++)
      for (let dx = 0; dx < b.size; dx++) {
        const i = (b.y + dy) * s + b.x + dx;
        if (dist[i] === -1) ((dist[i] = 0), (q[tail++] = i));
      }
  }
  while (head < tail) {
    const j = q[head++]!;
    const d = dist[j]! + 1;
    const x = j % s;
    if (j >= s && dist[j - s] === -1 && conductive(sim, j - s)) ((dist[j - s] = d), (q[tail++] = j - s));
    if (x < s - 1 && dist[j + 1] === -1 && conductive(sim, j + 1)) ((dist[j + 1] = d), (q[tail++] = j + 1));
    if (j + s < n && dist[j + s] === -1 && conductive(sim, j + s)) ((dist[j + s] = d), (q[tail++] = j + s));
    if (x > 0 && dist[j - 1] === -1 && conductive(sim, j - 1)) ((dist[j - 1] = d), (q[tail++] = j - 1));
  }
  // 3) consumers nearest-first
  const consumers: { b: Building; d: number; dem: number }[] = [];
  let demand = 0;
  for (const b of sim.buildings.values()) {
    let best = -1;
    for (let dy = 0; dy < b.size; dy++)
      for (let dx = 0; dx < b.size; dx++) {
        const v = dist[(b.y + dy) * s + b.x + dx]!;
        if (v >= 0 && (best < 0 || v < best)) best = v;
      }
    const dem = demandOf(b);
    demand += dem;
    if (best < 0) {
      setServed(b, false);
      continue;
    }
    consumers.push({ b, d: best, dem });
  }
  consumers.sort((a, z) => a.d - z.d || a.b.id - z.b.id);
  for (const c of consumers) {
    const k = comp[c.b.y * s + c.b.x]!;
    const left = spare[k] ?? -1;
    if (c.dem === 0) {
      setServed(c.b, left >= 0); // abandoned / zero-demand: reachable and not in a shortage
      continue;
    }
    if (left >= c.dem) {
      spare[k] = left - c.dem;
      setServed(c.b, true);
    } else {
      spare[k] = -1; // exhausted: everything farther goes dark
      setServed(c.b, false);
    }
  }
  spareOut.length = 0;
  for (let k = 0; k < nComp; k++) spareOut.push(Math.max(0, spare[k]!));
  // 4) tile flags
  for (let i = 0; i < n; i++) {
    let f = sim.flags[i]! & ~flag;
    const c = comp[i]!;
    if (c >= 0 && sim.kind[i] !== TileKind.Building && dist[i]! >= 0 && spareOut[c]! > 0) f |= flag;
    sim.flags[i] = f;
  }
  for (const b of sim.buildings.values()) {
    const served = flag === TileFlag.Powered ? b.powered : b.watered;
    if (!served) continue;
    for (let dy = 0; dy < b.size; dy++)
      for (let dx = 0; dx < b.size; dx++) {
        const i = (b.y + dy) * s + b.x + dx;
        sim.flags[i] = sim.flags[i]! | flag;
      }
  }
  return { supply, demand };
}

export function recomputeNetworks(sim: CitySim) {
  sim.netDirty = false;
  const p = solveNetwork(
    sim,
    sim.powerComp,
    sim.powerSpare,
    (b) => (isPowerProducer(b.type) || b.type === "landmark" ? powerOutput(sim, b) : 0),
    (b) => utilDemand(sim, b)[0],
    (b, v) => (b.powered = v || (isPowerProducer(b.type) && powerOutput(sim, b) > 0)),
    TileFlag.Powered,
  );
  let green = 0;
  let total = 0;
  for (const b of sim.buildings.values()) {
    if (!isPowerProducer(b.type) && b.type !== "landmark") continue;
    const o = powerOutput(sim, b);
    total += o;
    if (b.type === "power_wind" || b.type === "power_solar") green += o;
  }
  sim.power = { supply: Math.round(p.supply), demand: Math.round(p.demand), greenShare: total > 0 ? Math.min(1, green / total) : 0 };
  const w = solveNetwork(
    sim,
    sim.waterComp,
    sim.waterSpare,
    (b) => (isWaterProducer(b.type) || b.type === "landmark" ? waterOutput(sim, b) : 0),
    (b) => utilDemand(sim, b)[1],
    (b, v) => (b.watered = v || (isWaterProducer(b.type) && waterOutput(sim, b) > 0)),
    TileFlag.Watered,
  );
  sim.water = { supply: Math.round(w.supply), demand: Math.round(w.demand) };
  recomputeCoverage(sim);
  sim.markTiles();
}

function stamp(sim: CitySim, arr: Uint8Array, cx: number, cy: number, r: number) {
  const s = sim.size;
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(s - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(s - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      if (dx * dx + dy * dy > r2) continue;
      const i = y * s + x;
      if (arr[i]! < 255) arr[i]!++;
    }
  }
}

/** Service coverage counts (functional = powered, parks always). */
export function recomputeCoverage(sim: CitySim) {
  sim.covFire.fill(0);
  sim.covPolice.fill(0);
  sim.covHealth.fill(0);
  sim.covEdu.fill(0);
  sim.covPark.fill(0);
  sim.covSafety.fill(0);
  sim.covResearch.fill(0);
  for (const b of sim.buildings.values()) {
    const cx = b.x + b.size / 2;
    const cy = b.y + b.size / 2;
    if (b.damage >= 1) continue;
    if (b.type === "landmark") {
      const lm = sim.spec.landmarks.find((l) => l.id === b.landmarkId);
      if (lm?.effect === "safety") stamp(sim, sim.covSafety, cx, cy, LANDMARK_EFFECT_RADIUS);
      if (lm?.effect === "research") stamp(sim, sim.covResearch, cx, cy, LANDMARK_EFFECT_RADIUS);
      continue;
    }
    const cat = BUILD_CATALOG[b.type as "park"];
    if (!cat?.radius) continue;
    if (b.type !== "park" && !b.powered) continue;
    const arr =
      b.type === "fire_station"
        ? sim.covFire
        : b.type === "police"
          ? sim.covPolice
          : b.type === "clinic"
            ? sim.covHealth
            : b.type === "school"
              ? sim.covEdu
              : sim.covPark;
    stamp(sim, arr, cx, cy, cat.radius);
  }
}
