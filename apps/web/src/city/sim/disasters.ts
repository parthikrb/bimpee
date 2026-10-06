import type { Disaster } from "@bimpee/shared/city";
import type { CitySim } from "./CitySim";
import {
  EARTHQUAKE_DURATION,
  FIRE_BURN_RATE,
  FIRE_MAX_DURATION,
  FLOOD_DURATION,
  MAX_ACTIVE_DISASTERS,
  METEOR_DELAY,
  METEOR_DURATION,
  TICK,
  TORNADO_DURATION,
} from "./constants";
import { destroyRoad, refreshRoadBitsAround, removeBuilding } from "./grid";
import { recomputeDistWater } from "./fields";
import { councilEvent } from "./fate";
import { TileFlag, TileKind } from "./protocol";
import { clamp, clamp01, finite } from "./rand";
import { tileHeightOf } from "./terrain";
import type { Building, DisasterState } from "./types";

/**
 * Disasters. Fate may only use spec.disasters.allowed and run one at a time;
 * the sandbox may summon anything (MAX_ACTIVE_DISASTERS total). Every
 * disaster emits disaster_start / disaster_end plus its own events.
 */

const HEADLINES: Record<Disaster, string> = {
  earthquake: "Earthquake rattles the city",
  tornado: "Tornado touches down",
  flood: "Floodwaters rise",
  meteor: "Meteor streaks across the sky",
  fire: "Fire breaks out",
  blackout: "Blackout grips the grid",
};

export function triggerDisaster(
  sim: CitySim,
  kind: Disaster,
  rawX: number,
  rawY: number,
  rawStrength: number,
  fate: boolean,
  headline: string,
): { ok: boolean; reason: string | null } {
  if (fate) {
    if (!sim.spec.disasters.allowed.includes(kind)) return { ok: false, reason: `${kind} is not allowed in this city` };
    if (sim.disasters.some((d) => d.fate)) return { ok: false, reason: "a Fate disaster is already active" };
  }
  if (sim.disasters.length >= MAX_ACTIVE_DISASTERS) return { ok: false, reason: "too many active disasters" };
  const x = clamp(Math.round(finite(rawX, sim.size / 2)), 0, sim.size - 1) + 0.5;
  const y = clamp(Math.round(finite(rawY, sim.size / 2)), 0, sim.size - 1) + 0.5;
  const s = clamp01(finite(rawStrength, 0.5));
  const d: DisasterState = {
    id: sim.nextDisasterId++,
    kind,
    x,
    y,
    radius: 1,
    strength: s,
    t: 0,
    duration: 1,
    heading: 0,
    level: 0,
    fate,
    phase: 0,
    headline: headline || HEADLINES[kind],
  };
  let ignite: Building | null = null;
  switch (kind) {
    case "earthquake":
      d.radius = 8 + 14 * s;
      d.duration = EARTHQUAKE_DURATION;
      break;
    case "tornado":
      d.radius = 1.5 + 1.5 * s;
      d.duration = TORNADO_DURATION;
      d.heading = sim.rand.range(-Math.PI, Math.PI);
      break;
    case "flood":
      d.radius = 6 + 10 * s;
      d.duration = FLOOD_DURATION;
      break;
    case "meteor":
      d.radius = 2 + 3 * s;
      d.duration = METEOR_DURATION;
      break;
    case "fire": {
      d.radius = 3 + 5 * s;
      d.duration = FIRE_MAX_DURATION;
      const target = nearestBuilding(sim, x, y, 6);
      if (!target) return { ok: false, reason: "nothing to burn there" };
      d.x = target.x + target.size / 2;
      d.y = target.y + target.size / 2;
      ignite = target;
      break;
    }
    case "blackout":
      d.radius = sim.size;
      d.x = sim.size / 2;
      d.y = sim.size / 2;
      d.duration = sim.ticksPerDay * TICK * (0.5 + 0.5 * s);
      sim.netDirty = true;
      break;
  }
  sim.disasters.push(d);
  sim.emit({ kind: "disaster_start", disaster: kind, x: d.x, y: d.y, headline: d.headline });
  if (ignite) {
    igniteBuilding(sim, ignite);
    // stronger fires start in a few neighbours too
    const extra = Math.floor(s * 3);
    for (let k = 0; k < extra; k++) {
      const nb = nearestBuilding(sim, d.x + sim.rand.range(-3, 3), d.y + sim.rand.range(-3, 3), 3);
      if (nb && !nb.onFire) igniteBuilding(sim, nb);
    }
  }
  if (kind === "earthquake") sim.emit({ kind: "quake", x: d.x, y: d.y, radius: d.radius, strength: s });
  return { ok: true, reason: null };
}

function nearestBuilding(sim: CitySim, x: number, y: number, maxR: number): Building | null {
  let best: Building | null = null;
  let bd = maxR * maxR;
  for (const b of sim.buildings.values()) {
    const dx = b.x + b.size / 2 - x;
    const dy = b.y + b.size / 2 - y;
    const d = dx * dx + dy * dy;
    if (d <= bd && b.type !== "park") {
      bd = d;
      best = b;
    }
  }
  return best;
}

export function igniteBuilding(sim: CitySim, b: Building) {
  if (b.onFire || !sim.buildings.has(b.id)) return;
  b.onFire = true;
  setFireFlag(sim, b, true);
  sim.emit({ kind: "fire_started", x: b.x, y: b.y });
  if (b.type.startsWith("power_")) sim.netDirty = true;
}

function setFireFlag(sim: CitySim, b: Building, on: boolean) {
  for (let dy = 0; dy < b.size; dy++)
    for (let dx = 0; dx < b.size; dx++) {
      const i = (b.y + dy) * sim.size + b.x + dx;
      sim.flags[i] = on ? sim.flags[i]! | TileFlag.OnFire : sim.flags[i]! & ~TileFlag.OnFire;
    }
  sim.markTiles();
}

function extinguish(sim: CitySim, b: Building) {
  if (!b.onFire) return;
  b.onFire = false;
  setFireFlag(sim, b, false);
  sim.emit({ kind: "fire_out", x: b.x, y: b.y });
  sim.netDirty = true;
}

/** Apply damage; collapses into rubble at >= 1. Safety landmarks halve it nearby. */
export function damageBuilding(sim: CitySim, b: Building, amount: number, cause: Disaster): boolean {
  if (!sim.buildings.has(b.id) || amount <= 0) return false;
  const i = b.y * sim.size + b.x;
  if (sim.covSafety[i]) amount *= 0.5;
  b.damage += finite(amount, 0);
  if (b.damage >= 1) {
    b.damage = 1;
    b.onFire = false;
    removeBuilding(sim, b, cause, true);
    councilEvent(sim, "collapse");
    return true;
  }
  sim.markTiles();
  return false;
}

/** buildings with any tile within r of (x,y) — collected into a reusable array */
const hitBuf: Building[] = [];
function buildingsInRadius(sim: CitySim, x: number, y: number, r: number): Building[] {
  hitBuf.length = 0;
  const s = sim.size;
  const x0 = Math.max(0, Math.floor(x - r));
  const x1 = Math.min(s - 1, Math.floor(x + r));
  const y0 = Math.max(0, Math.floor(y - r));
  const y1 = Math.min(s - 1, Math.floor(y + r));
  const r2 = r * r;
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++) {
      const id = sim.building[ty * s + tx]!;
      if (!id) continue;
      const dx = tx + 0.5 - x;
      const dy = ty + 0.5 - y;
      if (dx * dx + dy * dy > r2) continue;
      const b = sim.buildings.get(id - 1);
      if (b && !hitBuf.includes(b)) hitBuf.push(b);
    }
  return hitBuf.slice();
}

function forTiles(sim: CitySim, x: number, y: number, r: number, fn: (i: number, d: number) => void) {
  const s = sim.size;
  const x0 = Math.max(0, Math.floor(x - r));
  const x1 = Math.min(s - 1, Math.floor(x + r));
  const y0 = Math.max(0, Math.floor(y - r));
  const y1 = Math.min(s - 1, Math.floor(y + r));
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++) {
      const dx = tx + 0.5 - x;
      const dy = ty + 0.5 - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= r) fn(ty * s + tx, d);
    }
}

export function tickDisasters(sim: CitySim, dt: number) {
  let shake = 0;
  const everySecond = sim.ticks % 10 === 0;
  for (let k = 0; k < sim.disasters.length; k++) {
    const d = sim.disasters[k]!;
    d.t += dt;
    switch (d.kind) {
      case "earthquake":
        shake = Math.max(shake, quake(sim, d));
        break;
      case "tornado":
        tornado(sim, d, dt);
        break;
      case "flood":
        if (everySecond) flood(sim, d);
        break;
      case "meteor":
        meteor(sim, d);
        break;
      case "fire":
        break;
      case "blackout":
        break;
    }
  }
  if (everySecond) fires(sim);
  sim.shake = shake;
  // retire finished disasters
  for (let k = sim.disasters.length - 1; k >= 0; k--) {
    const d = sim.disasters[k]!;
    let done = d.t >= d.duration;
    if (d.kind === "fire" && d.t > 2) {
      let burning = false;
      for (const b of sim.buildings.values())
        if (b.onFire) {
          burning = true;
          break;
        }
      if (!burning) done = true;
      if (done) for (const b of sim.buildings.values()) if (b.onFire) extinguish(sim, b);
    }
    if (!done) continue;
    sim.disasters.splice(k, 1);
    endDisaster(sim, d);
  }
}

function endDisaster(sim: CitySim, d: DisasterState) {
  if (d.kind === "flood") clearFlood(sim, d);
  if (d.kind === "blackout" || d.kind === "flood") sim.netDirty = true;
  sim.disastersSurvived++;
  sim.emit({ kind: "disaster_end", disaster: d.kind });
}

function quake(sim: CitySim, d: DisasterState): number {
  if (d.phase === 0 && d.t >= 2.5) {
    d.phase = 1;
    for (const b of buildingsInRadius(sim, d.x, d.y, d.radius)) {
      const dx = b.x + b.size / 2 - d.x;
      const dy = b.y + b.size / 2 - d.y;
      const falloff = 1 - Math.min(1, Math.sqrt(dx * dx + dy * dy) / d.radius);
      const resist = b.type === "landmark" ? 0.5 : b.level === 3 ? 0.85 : 1;
      const dmg = falloff * d.strength * sim.rand.range(0.5, 1.7) * resist;
      const collapsed = damageBuilding(sim, b, dmg, "earthquake");
      if (!collapsed && dmg > 0.3 && sim.rand.chance(0.12 * d.strength)) igniteBuilding(sim, b);
    }
    if (d.strength > 0.6) {
      const crack: number[] = [];
      forTiles(sim, d.x, d.y, d.radius * 0.5, (i) => {
        if (sim.kind[i] === TileKind.Road && sim.rand.chance(0.12 * d.strength)) crack.push(i);
      });
      for (const i of crack) destroyRoad(sim, i);
      if (crack.length) sim.markRoads();
    }
  }
  const env = Math.min(1, d.t / 1.5) * Math.min(1, Math.max(0, d.duration - d.t) / 2);
  return clamp01(env * (0.3 + 0.7 * d.strength));
}

function tornado(sim: CitySim, d: DisasterState, dt: number) {
  d.heading += sim.rand.range(-1, 1) * dt * 1.2;
  const speed = 1.4 + d.strength;
  let nx = d.x + Math.cos(d.heading) * speed * dt;
  let ny = d.y + Math.sin(d.heading) * speed * dt;
  const s = sim.size;
  if (nx < 0.5 || nx > s - 0.5) {
    d.heading = Math.PI - d.heading;
    nx = clamp(nx, 0.5, s - 0.5);
  }
  if (ny < 0.5 || ny > s - 0.5) {
    d.heading = -d.heading;
    ny = clamp(ny, 0.5, s - 0.5);
  }
  d.x = nx;
  d.y = ny;
  for (const b of buildingsInRadius(sim, d.x, d.y, d.radius)) damageBuilding(sim, b, 0.9 * d.strength * dt * sim.rand.range(0.6, 1.4), "tornado");
  let roads = false;
  forTiles(sim, d.x, d.y, d.radius, (i) => {
    const k = sim.kind[i];
    if (k === TileKind.Forest) {
      sim.kind[i] = TileKind.Land;
      sim.markTiles();
    } else if (k === TileKind.Road && sim.rand.chance(0.04 * d.strength)) {
      destroyRoad(sim, i);
      roads = true;
    }
  });
  if (roads) sim.markRoads();
}

function flood(sim: CitySim, d: DisasterState) {
  const peak = 0.6 + 1.4 * d.strength;
  d.level = peak * Math.min(1, d.t / 10) * Math.min(1, Math.max(0, d.duration - d.t) / 10);
  const s = sim.size;
  // base: sea level if water is near, else the lowest ground in the area
  let nearWater = false;
  let lowest = Infinity;
  forTiles(sim, d.x, d.y, d.radius, (i) => {
    if (sim.terrainWater[i]) nearWater = true;
    const h = tileHeightOf(sim.heights, s, i % s, (i / s) | 0);
    if (h < lowest) lowest = h;
  });
  const base = nearWater ? sim.waterLevel : lowest;
  let changed = false;
  forTiles(sim, d.x, d.y, d.radius, (i) => {
    if (sim.terrainWater[i]) return;
    const h = tileHeightOf(sim.heights, s, i % s, (i / s) | 0);
    const wet = h < base + d.level;
    const was = (sim.flags[i]! & TileFlag.Flooded) !== 0;
    if (wet !== was) {
      sim.flags[i] = wet ? sim.flags[i]! | TileFlag.Flooded : sim.flags[i]! & ~TileFlag.Flooded;
      changed = true;
    }
  });
  if (changed) {
    sim.markTiles();
    sim.netDirty = true;
  }
  for (const b of buildingsInRadius(sim, d.x, d.y, d.radius)) {
    if (!(sim.flags[b.y * s + b.x]! & TileFlag.Flooded)) continue;
    b.floodT += 1;
    if (b.onFire) extinguish(sim, b);
    if (b.floodT > 3) damageBuilding(sim, b, 0.04 * d.strength + 0.01, "flood");
  }
}

function clearFlood(sim: CitySim, d: DisasterState) {
  forTiles(sim, d.x, d.y, d.radius + 1, (i) => {
    sim.flags[i] = sim.flags[i]! & ~TileFlag.Flooded;
  });
  for (const b of sim.buildings.values()) b.floodT = 0;
  sim.markTiles();
}

function meteor(sim: CitySim, d: DisasterState) {
  if (d.phase !== 0 || d.t < METEOR_DELAY) return;
  d.phase = 1;
  const r = d.radius;
  sim.emit({ kind: "meteor_impact", x: d.x, y: d.y, radius: r });
  for (const b of buildingsInRadius(sim, d.x, d.y, r)) damageBuilding(sim, b, 2, "meteor");
  for (const b of buildingsInRadius(sim, d.x, d.y, r * 1.6)) {
    if (damageBuilding(sim, b, 0.5 * d.strength, "meteor")) continue;
    if (sim.rand.chance(0.35)) igniteBuilding(sim, b);
  }
  let roads = false;
  forTiles(sim, d.x, d.y, r, (i) => {
    if (sim.kind[i] === TileKind.Road) {
      sim.kind[i] = sim.terrainWater[i] ? TileKind.Water : TileKind.Land;
      roads = true;
    }
    if (sim.kind[i] === TileKind.Forest) sim.kind[i] = TileKind.Land;
    if (!sim.terrainWater[i]) sim.flags[i] = sim.flags[i]! | TileFlag.Rubble;
  });
  // crater
  const V = sim.size + 1;
  const depth = 1 + 2 * d.strength;
  const R = r * 1.3;
  for (let vy = Math.max(0, Math.floor(d.y - R)); vy <= Math.min(V - 1, Math.ceil(d.y + R)); vy++)
    for (let vx = Math.max(0, Math.floor(d.x - R)); vx <= Math.min(V - 1, Math.ceil(d.x + R)); vx++) {
      const dist = Math.sqrt((vx - d.x) ** 2 + (vy - d.y) ** 2);
      const q = dist / r;
      const k = vy * V + vx;
      if (q < 1) sim.heights[k] = Math.max(0, sim.heights[k]! - depth * (1 - q * q));
      else if (dist < R) sim.heights[k] = sim.heights[k]! + 0.3 * d.strength * (1 - (dist - r) / (R - r));
    }
  // tiles that sank below the sea become a crater lake
  const s = sim.size;
  forTiles(sim, d.x, d.y, R + 1, (i) => {
    const h = tileHeightOf(sim.heights, s, i % s, (i / s) | 0);
    if (h < sim.waterLevel && !sim.terrainWater[i] && sim.kind[i] !== TileKind.Building) {
      sim.terrainWater[i] = 1;
      sim.kind[i] = TileKind.Water;
      sim.zone[i] = 0;
      sim.flags[i] = 0;
    }
  });
  forTiles(sim, d.x, d.y, R + 2, (i) => refreshRoadBitsAround(sim, i));
  recomputeDistWater(sim);
  sim.terrainVersion++;
  if (roads) sim.markRoads();
  else sim.markTopo();
}

/** Once per sim second: burning, spreading, fire stations putting fires out. */
function fires(sim: CitySim) {
  let any = false;
  for (const b of sim.buildings.values())
    if (b.onFire) {
      any = true;
      break;
    }
  if (!any) return;
  const w = sim.weather;
  const weatherMult = w === "heatwave" ? 1.8 : w === "rain" ? 0.4 : w === "storm" ? 0.6 : w === "snow" ? 0.5 : 1;
  const climateMult = sim.spec.climate.kind === "arid" ? 1.3 : sim.spec.climate.kind === "arctic" ? 0.7 : 1;
  const s = sim.size;
  const burning: Building[] = [];
  for (const b of sim.buildings.values()) if (b.onFire) burning.push(b);
  for (const b of burning) {
    if (!sim.buildings.has(b.id) || !b.onFire) continue;
    const i = b.y * s + b.x;
    const cov = sim.covFire[i]!;
    const putOut = cov ? 0.1 * Math.min(3, cov) : 0.008;
    if (sim.rand.chance(putOut + (w === "rain" || w === "storm" ? 0.08 : 0))) {
      extinguish(sim, b);
      continue;
    }
    if (damageBuilding(sim, b, FIRE_BURN_RATE * (cov ? 0.6 : 1), "fire")) continue;
    // spread to 8-neighbours of the footprint
    for (let y = b.y - 1; y <= b.y + b.size; y++)
      for (let x = b.x - 1; x <= b.x + b.size; x++) {
        if (x < 0 || y < 0 || x >= s || y >= s) continue;
        const id = sim.building[y * s + x]!;
        if (!id || id === b.id + 1) continue;
        const nb = sim.buildings.get(id - 1);
        if (!nb || nb.onFire || nb.type === "park") continue;
        const p = 0.05 * (sim.covFire[y * s + x] ? 0.4 : 1.6) * weatherMult * climateMult;
        if (sim.rand.chance(p)) igniteBuilding(sim, nb);
      }
  }
}
