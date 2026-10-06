import { CityCommandSchema, type CityCommand, type CityDirective, type CitySpec, type CityTelemetry } from "@bimpee/shared/city";
import { FIELD_TILES_EVERY, LANDVALUE_EVERY, MAX_CATCHUP_TICKS, MILESTONES, POLLUTION_EVERY, TICK } from "./constants";
import { tickDisasters, triggerDisaster } from "./disasters";
import { dailyEconomy, updateStats } from "./economy";
import { applyDirectiveList, councilReact, dailyCouncil } from "./fate";
import { recomputeDistWater, updateLandValue, updatePollution } from "./fields";
import { goalsHud, updateGoals } from "./goals";
import {
  bulldozeRect,
  refreshRoadBitsAround,
  placeBuilding,
  placeLandmark,
  placeRoad,
  recomputeRoadDistance,
  toBuildingInfo,
  zoneRect,
  type CmdResult,
} from "./grid";
import { dailyBuildings, growthSlice } from "./growth";
import { recomputeCoverage, recomputeNetworks } from "./networks";
import type { ActiveDisaster, BuildingInfo, CityEvent, CityHud, FrameMsg, Motion, TerrainMsg, TilesMsg } from "./protocol";
import { TileKind } from "./protocol";
import { Rand, finite } from "./rand";
import { deserializeInto, serializeSim } from "./serialize";
import { FOREST_TILE_MIN, generateTerrain, tileHeightOf } from "./terrain";
import { Traffic } from "./traffic";
import { buildTelemetry, recordAction } from "./telemetry";
import { mod, type Building, type DisasterState, type GoalState, type Modifier, type MotionState } from "./types";
export { mod } from "./types";

export type { CmdResult } from "./grid";
export type Speed = 0 | 1 | 2 | 4;

/**
 * The whole city simulation: pure, deterministic for a given spec + command
 * sequence + step sequence, no DOM or Worker globals. The worker (worker.ts)
 * owns the clock and turns the drain*() outputs into protocol messages.
 *
 * Fields are public for the helper modules (grid, networks, growth, …) and
 * tests; the shell never touches them directly.
 */
export class CitySim {
  readonly spec: CitySpec;
  readonly cityId: string;
  readonly size: number;
  readonly n: number;
  /** ticks per in-game day */
  readonly ticksPerDay: number;

  // ---- terrain
  heights!: Float32Array;
  waterLevel = 0;
  forestGen!: Uint8Array;
  /** 1 where the ground is below sea level (natural water / crater lake) */
  terrainWater!: Uint8Array;
  /** BFS distance (tiles, capped 255) to water */
  distWater!: Uint8Array;

  // ---- grids
  kind!: Uint8Array;
  zone!: Uint8Array;
  flags!: Uint8Array;
  roads!: Uint8Array;
  building!: Uint32Array;
  pollution!: Float32Array;
  landValue!: Float32Array;
  /** scratch buffer for field updates */
  scratch!: Float32Array;
  roadDist!: Uint8Array;
  nearestRoad!: Int32Array;
  covFire!: Uint8Array;
  covPolice!: Uint8Array;
  covHealth!: Uint8Array;
  covEdu!: Uint8Array;
  covPark!: Uint8Array;
  covSafety!: Uint8Array;
  covResearch!: Uint8Array;
  powerComp!: Int32Array;
  waterComp!: Int32Array;
  powerSpare: number[] = [];
  waterSpare: number[] = [];
  /** growth scan order */
  perm!: Int32Array;
  growthCursor = 0;

  // ---- entities
  buildings = new Map<number, Building>();
  nextBuildingId = 1;
  traffic: Traffic;
  disasters: DisasterState[] = [];
  nextDisasterId = 1;
  disastersSurvived = 0;

  // ---- clock
  rand: Rand;
  ticks = 0;
  /** simulation seconds elapsed */
  simTime = 0;
  /** day + fraction; starts at 1 + startHour/24 */
  time = 1;
  speed: Speed = 1;
  paused = false;
  private acc = 0;

  // ---- economy & society
  funds = 0;
  taxRate = 0.09;
  incomePerDay = 0;
  expensesPerDay = 0;
  demand = { residential: 0.4, commercial: 0.15, industrial: 0.25 };
  happiness = 0.6;
  population = 0;
  comJobs = 0;
  indJobs = 0;
  unemployment = 0;
  power = { supply: 0, demand: 0, greenShare: 0 };
  water = { supply: 0, demand: 0 };
  congestion = 0;
  pollutionAvg = 0;
  weather = "clear";
  weatherDaysLeft = 0;
  modifiers: Modifier[] = [];
  approval: Record<string, number> = {};
  motions: MotionState[] = [];
  motionCounter = 0;
  goals: GoalState[] = [];
  milestoneIdx = 0;
  shake = 0;

  // ---- bookkeeping
  /** bumps on any change the renderer must see in TilesMsg */
  tilesVersion = 1;
  /** bumps when roads/buildings/zones change (network + coverage recompute) */
  topoVersion = 1;
  /** bumps when the road graph changes (path cache) */
  roadVersion = 1;
  terrainVersion = 1;
  netDirty = true;
  /** last tick a fields-only tiles bump happened */
  fieldsDirty = false;
  private lastNetTick = -999;
  private lastFieldBumpTick = 0;
  private lastHour = -1;
  private sentTilesVersion = 0;
  private sentTerrainVersion = 0;
  private telemetryDay = -1;
  private sentTelemetryDay = -1;
  events: CityEvent[] = [];
  recentEvents: string[] = [];
  recentDirectives: string[] = [];
  recentActions: string[] = [];
  dayActions = new Map<string, number>();

  constructor(spec: CitySpec, cityId: string, save?: string | null) {
    this.spec = spec;
    this.cityId = cityId;
    this.size = spec.terrain.size;
    this.n = this.size * this.size;
    this.ticksPerDay = Math.max(10, Math.round(finite(spec.climate.dayLengthSec, 180) / TICK));
    this.rand = new Rand((spec.seed * 2654435761) ^ 0xc17c17);
    this.traffic = new Traffic(this);
    this.allocGrids();
    this.initTerrain();
    if (save) {
      deserializeInto(this, save);
    } else {
      this.funds = spec.economy.startingFunds;
      this.taxRate = spec.economy.taxRate;
      this.time = 1 + finite(spec.climate.startHour, 8) / 24;
      for (const m of spec.council) this.approval[m.id] = 0;
      this.goals = spec.goals.map(() => ({ achieved: false, failed: false }));
      this.weather = defaultWeather(spec);
    }
    this.afterLoad(!!save);
  }

  static deserialize(spec: CitySpec, cityId: string, data: string): CitySim {
    return new CitySim(spec, cityId, data);
  }

  serialize(): string {
    return serializeSim(this);
  }

  private allocGrids() {
    const n = this.n;
    this.kind = new Uint8Array(n);
    this.zone = new Uint8Array(n);
    this.flags = new Uint8Array(n);
    this.roads = new Uint8Array(n);
    this.building = new Uint32Array(n);
    this.pollution = new Float32Array(n);
    this.landValue = new Float32Array(n);
    this.scratch = new Float32Array(n);
    this.roadDist = new Uint8Array(n);
    this.nearestRoad = new Int32Array(n);
    this.covFire = new Uint8Array(n);
    this.covPolice = new Uint8Array(n);
    this.covHealth = new Uint8Array(n);
    this.covEdu = new Uint8Array(n);
    this.covPark = new Uint8Array(n);
    this.covSafety = new Uint8Array(n);
    this.covResearch = new Uint8Array(n);
    this.powerComp = new Int32Array(n);
    this.waterComp = new Int32Array(n);
    this.terrainWater = new Uint8Array(n);
    this.distWater = new Uint8Array(n);
    // deterministic scan order for growth
    this.perm = new Int32Array(n);
    for (let i = 0; i < n; i++) this.perm[i] = i;
    const r = new Rand(this.spec.seed ^ 0x9e37);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(r.next() * (i + 1));
      const t = this.perm[i]!;
      this.perm[i] = this.perm[j]!;
      this.perm[j] = t;
    }
  }

  private initTerrain() {
    const t = generateTerrain(this.spec);
    this.heights = t.heights;
    this.waterLevel = t.waterLevel;
    this.forestGen = t.forest;
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        const i = y * this.size + x;
        if (tileHeightOf(this.heights, this.size, x, y) < this.waterLevel) {
          this.terrainWater[i] = 1;
          this.kind[i] = TileKind.Water;
        } else {
          this.kind[i] = this.forestGen[i]! >= FOREST_TILE_MIN ? TileKind.Forest : TileKind.Land;
        }
      }
    }
  }

  /** derived state after construction or load */
  private afterLoad(loaded: boolean) {
    for (let i = 0; i < this.n; i++) this.roads[i] = 0;
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) refreshRoadBitsAround(this, y * this.size + x);
    recomputeDistWater(this);
    recomputeRoadDistance(this);
    if (loaded) {
      // derived network state (components, spare capacity) without disturbing the saved flags
      const flags = new Uint8Array(this.flags);
      const served = [...this.buildings.values()].map((b) => [b.powered, b.watered] as const);
      const keep = {
        h: this.happiness,
        d: { ...this.demand },
        c: this.congestion,
        st: [this.population, this.comJobs, this.indJobs, this.unemployment, this.incomePerDay, this.expensesPerDay, this.pollutionAvg] as const,
      };
      recomputeNetworks(this);
      this.flags.set(flags);
      let k = 0;
      for (const b of this.buildings.values()) {
        const v = served[k++]!;
        b.powered = v[0];
        b.watered = v[1];
      }
      recomputeCoverage(this);
      updateLandValue(this);
      updateStats(this);
      this.happiness = keep.h;
      this.demand = keep.d;
      this.congestion = keep.c;
      [this.population, this.comJobs, this.indJobs, this.unemployment, this.incomePerDay, this.expensesPerDay, this.pollutionAvg] = keep.st;
    } else {
      recomputeNetworks(this);
      for (let k = 0; k < 30; k++) updatePollution(this);
      updateLandValue(this);
      updateStats(this);
    }
    this.netDirty = loaded;
    this.lastHour = Math.floor(this.hour);
    this.telemetryDay = this.day;
  }

  /** recompute everything derived from the grids (tests, tools) */
  reinitDerived() {
    this.afterLoad(false);
    this.markRoads();
    this.terrainVersion++;
  }

  // ---- clock ---------------------------------------------------------------

  get day(): number {
    return Math.floor(this.time);
  }
  get hour(): number {
    return (this.time - Math.floor(this.time)) * 24;
  }

  /** Advance by real seconds (scaled by speed). Returns ticks run. */
  step(dtSeconds: number): number {
    if (this.paused || this.speed === 0) return 0;
    const dt = finite(dtSeconds, 0);
    if (dt <= 0) return 0;
    this.acc += dt * this.speed;
    let ran = 0;
    while (this.acc >= TICK - 1e-9 && ran < MAX_CATCHUP_TICKS) {
      this.tick();
      this.acc -= TICK;
      ran++;
    }
    if (ran >= MAX_CATCHUP_TICKS) this.acc = 0; // drop the backlog instead of spiralling
    return ran;
  }

  /** Run exactly n fixed ticks (tests, headless). */
  advance(ticks: number) {
    for (let k = 0; k < ticks; k++) this.tick();
  }

  tick() {
    this.ticks++;
    this.simTime += TICK;
    const prevDay = this.day;
    this.time += 1 / this.ticksPerDay;
    const hour = Math.floor(this.hour);
    if (hour !== this.lastHour) {
      this.lastHour = hour;
      this.netDirty = true; // solar output follows the sun
    }
    if (this.netDirty && this.ticks - this.lastNetTick >= 5) {
      this.lastNetTick = this.ticks;
      recomputeNetworks(this);
    }
    growthSlice(this);
    this.traffic.tick(TICK);
    tickDisasters(this, TICK);
    if (this.ticks % POLLUTION_EVERY === 0) updatePollution(this);
    if (this.ticks % LANDVALUE_EVERY === 0) {
      updateLandValue(this);
      this.fieldsDirty = true;
    }
    if (this.ticks % 10 === 0) updateStats(this);
    if (this.fieldsDirty && this.ticks - this.lastFieldBumpTick >= FIELD_TILES_EVERY) {
      this.fieldsDirty = false;
      this.lastFieldBumpTick = this.ticks;
      this.tilesVersion++;
    }
    if (this.day > prevDay) this.daily();
  }

  private daily() {
    updateStats(this);
    dailyBuildings(this);
    dailyEconomy(this);
    dailyCouncil(this);
    updateGoals(this);
    this.checkMilestones();
    // weather
    if (this.weatherDaysLeft > 0) this.weatherDaysLeft--;
    if (this.weatherDaysLeft <= 0) this.weather = rollWeather(this);
    // aggregate yesterday's player actions for telemetry
    for (const [k, v] of this.dayActions) this.recentActions.push(k.replace("#", String(v)));
    this.dayActions.clear();
    if (this.recentActions.length > 10) this.recentActions.splice(0, this.recentActions.length - 10);
    this.telemetryDay = this.day;
    this.tilesVersion++; // occupants / levels changed
  }

  private checkMilestones() {
    while (this.milestoneIdx < MILESTONES.length && this.population >= MILESTONES[this.milestoneIdx]!) {
      const m = MILESTONES[this.milestoneIdx]!;
      this.emit({ kind: "milestone", text: `${this.spec.name} reaches ${m.toLocaleString("en-US")} citizens` });
      this.milestoneIdx++;
    }
  }

  // ---- events ---------------------------------------------------------------

  emit(e: CityEvent) {
    if (this.events.length < 400) this.events.push(e);
    const text = eventText(e);
    if (text) {
      this.recentEvents.push(text);
      if (this.recentEvents.length > 10) this.recentEvents.shift();
    }
  }

  markTiles() {
    this.tilesVersion++;
  }
  markTopo() {
    this.tilesVersion++;
    this.topoVersion++;
    this.netDirty = true;
  }
  markRoads() {
    this.roadVersion++;
    this.markTopo();
    recomputeRoadDistance(this);
  }

  // ---- input -----------------------------------------------------------------

  command(raw: CityCommand): CmdResult {
    const parsed = CityCommandSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: "invalid command", cost: 0 };
    const cmd = parsed.data;
    let r: CmdResult;
    try {
      r = this.runCommand(cmd);
    } catch (err) {
      r = { ok: false, reason: `internal error: ${(err as Error)?.message ?? String(err)}`, cost: 0 };
    }
    if (r.ok) {
      this.funds -= r.cost;
      councilReact(this, cmd, r);
    }
    return r;
  }

  private runCommand(cmd: CityCommand): CmdResult {
    switch (cmd.type) {
      case "road": {
        const r = placeRoad(this, cmd.path);
        if (r.ok && r.count) recordAction(this, `built # road tiles`, r.count);
        return r;
      }
      case "zone": {
        const r = zoneRect(this, cmd.zone, cmd.x0, cmd.y0, cmd.x1, cmd.y1);
        if (r.ok && r.count) recordAction(this, cmd.zone ? `zoned # ${cmd.zone} tiles` : "un-zoned # tiles", r.count);
        return r;
      }
      case "bulldoze": {
        const r = bulldozeRect(this, cmd.x0, cmd.y0, cmd.x1, cmd.y1);
        if (r.ok && r.count) recordAction(this, "bulldozed # tiles", r.count);
        return r;
      }
      case "build": {
        if (cmd.kind === "road") return placeRoad(this, [[cmd.x, cmd.y], [cmd.x, cmd.y]]);
        const r = placeBuilding(this, cmd.kind, cmd.x, cmd.y, cmd.rot);
        if (r.ok) recordAction(this, `built # ${cmd.kind.replace("_", " ")}`, 1);
        return r;
      }
      case "landmark": {
        const r = placeLandmark(this, cmd.id, cmd.x, cmd.y);
        if (r.ok) recordAction(this, `built landmark ${cmd.id}`, 1);
        return r;
      }
      case "tax": {
        const rate = Math.round(Math.min(0.2, Math.max(0, cmd.rate)) * 1000) / 1000;
        const prev = this.taxRate;
        this.taxRate = rate;
        recordAction(this, `set tax to ${(rate * 100).toFixed(1)}% (was ${(prev * 100).toFixed(1)}%)`, 1);
        return { ok: true, reason: null, cost: 0, delta: rate - prev };
      }
      case "speed":
        this.speed = cmd.speed;
        return { ok: true, reason: null, cost: 0 };
      case "motion_vote":
        return voteMotion(this, cmd.motionId, cmd.option);
      case "sandbox_disaster": {
        const d = triggerDisaster(this, cmd.kind, cmd.x, cmd.y, cmd.strength, false, "");
        if (!d.ok) return { ok: false, reason: d.reason, cost: 0 };
        recordAction(this, `summoned a ${cmd.kind}`, 1);
        return { ok: true, reason: null, cost: 0 };
      }
    }
  }

  applyDirectives(list: CityDirective[] | unknown[]) {
    applyDirectiveList(this, Array.isArray(list) ? list : []);
  }

  // ---- outputs -------------------------------------------------------------

  getTerrainMsg(): TerrainMsg {
    this.sentTerrainVersion = this.terrainVersion;
    return {
      type: "terrain",
      size: this.size,
      heights: new Float32Array(this.heights),
      waterLevel: this.waterLevel,
      forest: new Uint8Array(this.forestGen),
    };
  }
  /** terrain message if heights changed since the last one (meteor crater) */
  drainTerrain(): TerrainMsg | null {
    return this.terrainVersion !== this.sentTerrainVersion ? this.getTerrainMsg() : null;
  }

  /** Fresh copies (safe to transfer). */
  getTilesMsg(): TilesMsg {
    this.sentTilesVersion = this.tilesVersion;
    const n = this.n;
    const pol = new Uint8Array(n);
    const lv = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      pol[i] = Math.round(Math.min(1, Math.max(0, this.pollution[i]!)) * 255);
      lv[i] = Math.round(Math.min(1, Math.max(0, this.landValue[i]!)) * 255);
    }
    const buildings: BuildingInfo[] = [];
    for (const b of this.buildings.values()) buildings.push(toBuildingInfo(b));
    return {
      type: "tiles",
      version: this.tilesVersion,
      kind: new Uint8Array(this.kind),
      zone: new Uint8Array(this.zone),
      flags: new Uint8Array(this.flags),
      roads: new Uint8Array(this.roads),
      building: new Uint32Array(this.building),
      pollution: pol,
      landValue: lv,
      buildings,
    };
  }
  drainTiles(): TilesMsg | null {
    return this.tilesVersion !== this.sentTilesVersion ? this.getTilesMsg() : null;
  }

  activeDisasters(): ActiveDisaster[] {
    return this.disasters.map((d) => ({
      id: d.id,
      kind: d.kind,
      x: d.x,
      y: d.y,
      radius: d.radius,
      strength: d.strength,
      t: d.t,
      duration: d.duration,
      heading: d.heading,
      level: d.level,
    }));
  }

  /** frame message; drains pending events */
  drainFrame(): FrameMsg {
    const events = this.events;
    this.events = [];
    return {
      type: "frame",
      day: this.day,
      hour: this.hour,
      weather: this.weather,
      shake: this.shake,
      cars: this.traffic.snapshot(),
      disasters: this.activeDisasters(),
      events,
    };
  }

  getHud(): CityHud {
    const motions: Motion[] = this.motions.map((m) => ({
      id: m.id,
      memberId: m.memberId,
      title: m.title,
      pitch: m.pitch,
      options: m.options.map((o) => ({ label: o.label })),
      expiresDay: m.expiresDay,
    }));
    return {
      day: this.day,
      hour: this.hour,
      speed: this.speed,
      funds: Math.round(this.funds),
      incomePerDay: Math.round(this.incomePerDay),
      expensesPerDay: Math.round(this.expensesPerDay),
      population: this.population,
      happiness: this.happiness,
      taxRate: this.taxRate,
      demand: { ...this.demand },
      power: { supply: this.power.supply, demand: this.power.demand },
      water: { ...this.water },
      weather: this.weather,
      goals: goalsHud(this),
      motions,
    };
  }

  getTelemetry(): CityTelemetry {
    return buildTelemetry(this);
  }
  /** telemetry once per in-game day (null if already sent for this day) */
  drainTelemetry(): CityTelemetry | null {
    if (this.telemetryDay === this.sentTelemetryDay) return null;
    this.sentTelemetryDay = this.telemetryDay;
    return this.getTelemetry();
  }

  /** for serialization */
  getAcc() {
    return this.acc;
  }
  setAcc(v: number) {
    this.acc = finite(v, 0);
  }

  buildingAt(x: number, y: number): Building | null {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return null;
    const id = this.building[y * this.size + x]!;
    return id ? (this.buildings.get(id - 1) ?? null) : null;
  }
}

function voteMotion(sim: CitySim, motionId: string, option: number): CmdResult {
  const idx = sim.motions.findIndex((m) => m.id === motionId);
  if (idx < 0) return { ok: false, reason: "no such motion", cost: 0 };
  const m = sim.motions[idx]!;
  const opt = m.options[option];
  if (!opt) return { ok: false, reason: "no such option", cost: 0 };
  sim.motions.splice(idx, 1);
  const e = opt.effect;
  // funds effect goes through the command cost so the ledger shows it
  const cost = -finite(e.funds, 0);
  if (e.happiness) {
    sim.modifiers.push(mod("motion", { happiness: e.happiness, daysLeft: 5 }));
  }
  if (sim.approval[m.memberId] !== undefined) {
    sim.approval[m.memberId] = Math.max(-1, Math.min(1, sim.approval[m.memberId]! + finite(e.approval, 0)));
  }
  if (e.demand !== "none") {
    const boost = { residential: 0, commercial: 0, industrial: 0 };
    boost[e.demand] = 0.25;
    sim.modifiers.push(mod("motion", { res: boost.residential, com: boost.commercial, ind: boost.industrial, daysLeft: 5 }));
  }
  recordAction(sim, `voted "${opt.label}" on "${m.title}"`, 1);
  sim.emit({ kind: "news", headline: `Council: ${m.title}`, body: `The mayor chose "${opt.label}".` });
  return { ok: true, reason: null, cost };
}


function defaultWeather(spec: CitySpec): string {
  if (spec.climate.kind === "arctic" || (spec.climate.season === "winter" && spec.climate.kind !== "tropical" && spec.climate.kind !== "arid")) return "snow";
  return "clear";
}

const WEATHER_TABLE: Record<string, [string, number][]> = {
  temperate: [["clear", 5], ["rain", 3], ["fog", 1], ["storm", 1]],
  tropical: [["clear", 4], ["rain", 4], ["storm", 2]],
  arid: [["clear", 7], ["heatwave", 3], ["storm", 0.5]],
  arctic: [["snow", 5], ["clear", 3], ["fog", 2], ["storm", 1]],
  volcanic: [["clear", 4], ["fog", 3], ["rain", 2], ["heatwave", 1]],
};

function rollWeather(sim: CitySim): string {
  const table = [...(WEATHER_TABLE[sim.spec.climate.kind] ?? WEATHER_TABLE.temperate!)];
  const season = sim.spec.climate.season;
  if (season === "winter" && sim.spec.climate.kind !== "tropical") table.push(["snow", 4]);
  if (season === "summer") table.push(["heatwave", 1.5]);
  if (season === "autumn") table.push(["rain", 2], ["fog", 1]);
  let total = 0;
  for (const [, w] of table) total += w;
  let r = sim.rand.next() * total;
  for (const [k, w] of table) {
    r -= w;
    if (r <= 0) return k;
  }
  return "clear";
}

export function eventText(e: CityEvent): string | null {
  switch (e.kind) {
    case "collapse":
      return e.cause === "bulldoze" ? null : `${e.type} building collapsed (${e.cause}) at ${e.x},${e.y}`;
    case "meteor_impact":
      return `meteor impact at ${e.x},${e.y}`;
    case "quake":
      return `earthquake strength ${e.strength.toFixed(2)} at ${Math.round(e.x)},${Math.round(e.y)}`;
    case "fire_started":
      return `fire broke out at ${e.x},${e.y}`;
    case "fire_out":
      return null;
    case "disaster_start":
      return e.headline || `${e.disaster} started`;
    case "disaster_end":
      return `${e.disaster} ended`;
    case "built":
      return `built ${e.what}`;
    case "milestone":
      return e.text;
    case "economy":
      return e.text;
    case "news":
      return `news: ${e.headline}`;
    case "visitor":
      return `visitor: ${e.text}`;
    case "goal":
      return `${e.achieved ? "goal achieved" : "goal failed"}: ${e.text}`;
  }
}
