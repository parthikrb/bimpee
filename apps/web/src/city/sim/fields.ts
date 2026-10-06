import type { CitySim } from "./CitySim";
import { queueBuf } from "./grid";
import { TileKind } from "./protocol";
import { clamp01 } from "./rand";
import { tileHeightOf } from "./terrain";

/**
 * Scalar fields over the grid: pollution (sources + cheap 4-neighbour blur),
 * land value, and the distance to water used by land value and floods.
 */

/** BFS distance to natural water, capped at 255. */
export function recomputeDistWater(sim: CitySim) {
  const n = sim.n;
  const s = sim.size;
  const d = sim.distWater;
  d.fill(255);
  const q = queueBuf(sim);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) if (sim.terrainWater[i]) ((d[i] = 0), (q[tail++] = i));
  while (head < tail) {
    const i = q[head++]!;
    const v = d[i]! + 1;
    if (v > 254) continue;
    const x = i % s;
    if (i >= s && d[i - s]! > v) ((d[i - s] = v), (q[tail++] = i - s));
    if (x < s - 1 && d[i + 1]! > v) ((d[i + 1] = v), (q[tail++] = i + 1));
    if (i + s < n && d[i + s]! > v) ((d[i + s] = v), (q[tail++] = i + s));
    if (x > 0 && d[i - 1]! > v) ((d[i - 1] = v), (q[tail++] = i - 1));
  }
}

let srcBuf: Float32Array | null = null;

/** One diffusion step. Steady state ~ 8x the per-step source. */
export function updatePollution(sim: CitySim) {
  const n = sim.n;
  const s = sim.size;
  if (!srcBuf || srcBuf.length !== n) srcBuf = new Float32Array(n);
  const src = srcBuf;
  src.fill(0);
  for (const b of sim.buildings.values()) {
    let p = 0;
    if (b.type === "ind" && !b.abandoned) p = 0.035 * b.level;
    else if (b.type === "power_coal" && b.damage < 1 && b.offlineUntil <= sim.simTime) p = 0.12;
    else if (b.type === "com" && !b.abandoned) p = 0.004 * b.level;
    if (!p) continue;
    for (let dy = 0; dy < b.size; dy++) for (let dx = 0; dx < b.size; dx++) src[(b.y + dy) * s + b.x + dx]! += p;
  }
  const occ = sim.traffic.occ;
  const p = sim.pollution;
  const out = sim.scratch;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = i % s;
    const c = p[i]!;
    const up = i >= s ? p[i - s]! : c;
    const dn = i + s < n ? p[i + s]! : c;
    const lf = x > 0 ? p[i - 1]! : c;
    const rt = x < s - 1 ? p[i + 1]! : c;
    const avg = (up + dn + lf + rt) * 0.25;
    let decay = 0.88;
    if (sim.covPark[i]) decay = 0.8;
    if (sim.kind[i] === TileKind.Forest) decay = 0.78;
    if (sim.weather === "rain" || sim.weather === "storm") decay -= 0.04;
    let v = (c * 0.45 + avg * 0.55) * decay + src[i]! + occ[i]! * 0.004;
    if (v > 1.5) v = 1.5;
    out[i] = v;
    sum += v > 1 ? 1 : v;
  }
  p.set(out);
  sim.pollutionAvg = sum / n;
}

export function updateLandValue(sim: CitySim) {
  const n = sim.n;
  const s = sim.size;
  const wl = sim.waterLevel;
  let tech = 0;
  for (const m of sim.modifiers) tech += m.landValue;
  for (let i = 0; i < n; i++) {
    if (sim.terrainWater[i] && sim.kind[i] !== TileKind.Road) {
      sim.landValue[i] = 0;
      continue;
    }
    const dw = sim.distWater[i]!;
    let v = 0.28;
    v += dw <= 2 ? 0.16 : dw <= 5 ? 0.1 : dw <= 9 ? 0.04 : 0;
    const h = tileHeightOf(sim.heights, s, i % s, (i / s) | 0) - wl;
    v += Math.min(0.08, Math.max(0, h) * 0.02);
    v += Math.min(2, sim.covPark[i]!) * 0.07;
    if (sim.covFire[i]) v += 0.04;
    if (sim.covPolice[i]) v += 0.05;
    if (sim.covHealth[i]) v += 0.05;
    if (sim.covEdu[i]) v += 0.05;
    if (sim.covResearch[i]) v += 0.12;
    if (sim.kind[i] === TileKind.Forest) v += 0.03;
    v -= Math.min(1, sim.pollution[i]!) * 0.55;
    v += tech;
    sim.landValue[i] = clamp01(v);
  }
}
