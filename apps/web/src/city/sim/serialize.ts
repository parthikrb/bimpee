import type { CitySim } from "./CitySim";
import { SAVE_VERSION } from "./constants";
import { TileKind } from "./protocol";
import { finite } from "./rand";
import { TYPE_CODES, type Building, type DisasterState, type GoalState, type Modifier, type MotionState } from "./types";

/**
 * Save format: base64(UTF-8(JSON)). Grids are base64 of their raw bytes,
 * buildings are compact number tuples. Cars and caches are not saved
 * (traffic respawns). Derived data (road bits, coverage, land value,
 * distances) is recomputed on load; utility flags are restored verbatim so
 * serialize(deserialize(s)) === s.
 */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_REV = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64_REV[B64.charCodeAt(i)] = i;

export function bytesToB64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = "";
  const n = bytes.length;
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    chunk += B64[(v >> 18) & 63]! + B64[(v >> 12) & 63]! + B64[(v >> 6) & 63]! + B64[v & 63]!;
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = "";
    }
  }
  if (i < n) {
    const a = bytes[i]!;
    const b = i + 1 < n ? bytes[i + 1]! : 0;
    const v = (a << 16) | (b << 8);
    chunk += B64[(v >> 18) & 63]! + B64[(v >> 12) & 63]! + (i + 1 < n ? B64[(v >> 6) & 63]! : "=") + "=";
  }
  parts.push(chunk);
  return parts.join("");
}

export function b64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64_REV[clean.charCodeAt(i)]!;
    if (v < 0) throw new Error("bad base64");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
    }
  }
  return out.subarray(0, o);
}

const enc = (a: Uint8Array | Float32Array) => bytesToB64(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
function decInto(s: string, target: Uint8Array | Float32Array, name: string) {
  const bytes = b64ToBytes(s);
  if (bytes.byteLength !== target.byteLength) throw new Error(`save: ${name} has the wrong size`);
  new Uint8Array(target.buffer, target.byteOffset, target.byteLength).set(bytes);
}

interface SaveV1 {
  v: number;
  seed: number;
  size: number;
  time: number;
  ticks: number;
  simTime: number;
  acc: number;
  speed: number;
  rand: number;
  funds: number;
  taxRate: number;
  demand: [number, number, number];
  happiness: number;
  congestion: number;
  /** cached aggregates: population, comJobs, indJobs, unemployment, income, expenses, pollutionAvg */
  stats: number[];
  weather: string;
  weatherDaysLeft: number;
  modifiers: Modifier[];
  approval: Record<string, number>;
  motions: MotionState[];
  motionCounter: number;
  goals: GoalState[];
  milestoneIdx: number;
  disasters: DisasterState[];
  nextDisasterId: number;
  disastersSurvived: number;
  nextBuildingId: number;
  growthCursor: number;
  terrainVersion: number;
  recentEvents: string[];
  recentDirectives: string[];
  recentActions: string[];
  dayActions: [string, number][];
  heights: string;
  terrainWater: string;
  kind: string;
  zone: string;
  flags: string;
  pollution: string;
  /** [id, type, x, y, size, rot, level, variant, damage, bits, landmarkIdx, occupants, noPower, noWater, abandonedDays, floodT, offlineUntil, cost] */
  buildings: number[][];
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function fromUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

export function serializeSim(sim: CitySim): string {
  const lmIds = sim.spec.landmarks.map((l) => l.id);
  const buildings: number[][] = [];
  for (const b of sim.buildings.values()) {
    const bits = (b.onFire ? 1 : 0) | (b.powered ? 2 : 0) | (b.watered ? 4 : 0) | (b.abandoned ? 8 : 0);
    buildings.push([
      b.id,
      TYPE_CODES.indexOf(b.type),
      b.x,
      b.y,
      b.size,
      b.rot,
      b.level,
      b.variant,
      b.damage,
      bits,
      b.landmarkId ? lmIds.indexOf(b.landmarkId) : -1,
      b.occupants,
      b.noPowerDays,
      b.noWaterDays,
      b.abandonedDays,
      b.floodT,
      b.offlineUntil,
      b.cost,
    ]);
  }
  const save: SaveV1 = {
    v: SAVE_VERSION,
    seed: sim.spec.seed,
    size: sim.size,
    time: sim.time,
    ticks: sim.ticks,
    simTime: sim.simTime,
    acc: sim.getAcc(),
    speed: sim.speed,
    rand: sim.rand.state,
    funds: sim.funds,
    taxRate: sim.taxRate,
    demand: [sim.demand.residential, sim.demand.commercial, sim.demand.industrial],
    happiness: sim.happiness,
    congestion: sim.congestion,
    stats: [sim.population, sim.comJobs, sim.indJobs, sim.unemployment, sim.incomePerDay, sim.expensesPerDay, sim.pollutionAvg],
    weather: sim.weather,
    weatherDaysLeft: sim.weatherDaysLeft,
    modifiers: sim.modifiers,
    approval: sim.approval,
    motions: sim.motions,
    motionCounter: sim.motionCounter,
    goals: sim.goals,
    milestoneIdx: sim.milestoneIdx,
    disasters: sim.disasters,
    nextDisasterId: sim.nextDisasterId,
    disastersSurvived: sim.disastersSurvived,
    nextBuildingId: sim.nextBuildingId,
    growthCursor: sim.growthCursor,
    terrainVersion: sim.terrainVersion,
    recentEvents: sim.recentEvents,
    recentDirectives: sim.recentDirectives,
    recentActions: sim.recentActions,
    dayActions: [...sim.dayActions.entries()],
    heights: enc(sim.heights),
    terrainWater: enc(sim.terrainWater),
    kind: enc(sim.kind),
    zone: enc(sim.zone),
    flags: enc(sim.flags),
    pollution: enc(sim.pollution),
    buildings,
  };
  return bytesToB64(utf8(JSON.stringify(save)));
}

/** Restore state into a freshly constructed sim (terrain already generated). Throws on a bad save. */
export function deserializeInto(sim: CitySim, data: string) {
  const s = JSON.parse(fromUtf8(b64ToBytes(data))) as SaveV1;
  if (!s || s.v !== SAVE_VERSION) throw new Error(`save: unsupported version ${s?.v}`);
  if (s.size !== sim.size) throw new Error("save: map size does not match the spec");
  sim.time = finite(s.time, 1);
  sim.ticks = s.ticks | 0;
  sim.simTime = finite(s.simTime, 0);
  sim.setAcc(s.acc);
  sim.speed = ([0, 1, 2, 4] as const).includes(s.speed as 0) ? (s.speed as 0 | 1 | 2 | 4) : 1;
  sim.rand.state = s.rand >>> 0;
  sim.funds = finite(s.funds, 0);
  sim.taxRate = finite(s.taxRate, 0.09);
  sim.demand = { residential: finite(s.demand[0]), commercial: finite(s.demand[1]), industrial: finite(s.demand[2]) };
  sim.happiness = finite(s.happiness, 0.5);
  sim.congestion = finite(s.congestion, 0);
  const st = Array.isArray(s.stats) ? s.stats : [];
  sim.population = finite(st[0] ?? 0);
  sim.comJobs = finite(st[1] ?? 0);
  sim.indJobs = finite(st[2] ?? 0);
  sim.unemployment = finite(st[3] ?? 0);
  sim.incomePerDay = finite(st[4] ?? 0);
  sim.expensesPerDay = finite(st[5] ?? 0);
  sim.pollutionAvg = finite(st[6] ?? 0);
  sim.weather = String(s.weather ?? "clear");
  sim.weatherDaysLeft = s.weatherDaysLeft | 0;
  sim.modifiers = Array.isArray(s.modifiers) ? s.modifiers : [];
  sim.approval = s.approval ?? {};
  for (const m of sim.spec.council) if (sim.approval[m.id] === undefined) sim.approval[m.id] = 0;
  sim.motions = Array.isArray(s.motions) ? s.motions : [];
  sim.motionCounter = s.motionCounter | 0;
  sim.goals = Array.isArray(s.goals) ? s.goals : sim.spec.goals.map(() => ({ achieved: false, failed: false }));
  sim.milestoneIdx = s.milestoneIdx | 0;
  sim.disasters = Array.isArray(s.disasters) ? s.disasters : [];
  sim.nextDisasterId = s.nextDisasterId || 1;
  sim.disastersSurvived = s.disastersSurvived | 0;
  sim.nextBuildingId = s.nextBuildingId || 1;
  sim.growthCursor = (s.growthCursor | 0) % sim.n;
  sim.terrainVersion = s.terrainVersion || 1;
  sim.recentEvents = s.recentEvents ?? [];
  sim.recentDirectives = s.recentDirectives ?? [];
  sim.recentActions = s.recentActions ?? [];
  sim.dayActions = new Map(s.dayActions ?? []);
  decInto(s.heights, sim.heights, "heights");
  decInto(s.terrainWater, sim.terrainWater, "terrainWater");
  decInto(s.kind, sim.kind, "kind");
  decInto(s.zone, sim.zone, "zone");
  decInto(s.flags, sim.flags, "flags");
  decInto(s.pollution, sim.pollution, "pollution");
  sim.buildings.clear();
  sim.building.fill(0);
  const lmIds = sim.spec.landmarks.map((l) => l.id);
  for (const t of s.buildings) {
    const type = TYPE_CODES[t[1]!];
    if (!type) continue;
    const bits = t[9]!;
    const b: Building = {
      id: t[0]!,
      type,
      x: t[2]!,
      y: t[3]!,
      size: t[4]!,
      rot: t[5]!,
      level: t[6]!,
      variant: t[7]!,
      damage: t[8]!,
      onFire: (bits & 1) !== 0,
      powered: (bits & 2) !== 0,
      watered: (bits & 4) !== 0,
      abandoned: (bits & 8) !== 0,
      landmarkId: t[10]! >= 0 ? (lmIds[t[10]!] ?? null) : null,
      occupants: t[11]!,
      noPowerDays: t[12]!,
      noWaterDays: t[13]!,
      abandonedDays: t[14]!,
      floodT: t[15]!,
      offlineUntil: t[16]!,
      cost: t[17]!,
    };
    if (b.x < 0 || b.y < 0 || b.x + b.size > sim.size || b.y + b.size > sim.size) continue;
    sim.buildings.set(b.id, b);
    for (let dy = 0; dy < b.size; dy++)
      for (let dx = 0; dx < b.size; dx++) {
        const i = (b.y + dy) * sim.size + b.x + dx;
        sim.building[i] = b.id + 1;
        sim.kind[i] = TileKind.Building;
      }
  }
  // stray Building tiles without a building (corrupt save) become land
  for (let i = 0; i < sim.n; i++) if (sim.kind[i] === TileKind.Building && !sim.building[i]) sim.kind[i] = TileKind.Land;
}
