import {
  createRng,
  PacingController,
  type Directive,
  type PacingOutput,
  type Rng,
  type RunReport,
  type WorldSpec,
} from "@bimpee/shared";
import { Bus, type GameEvent, type GameEventKind, type GameOptions, type GameToShell, type HudState, type UpgradeOption } from "../contract";
import { FlowField } from "../logic/flowfield";
import { HighlightTracker } from "../logic/highlights";
import { circleFree, generateMap, resolveCircle, type GameMap } from "../logic/mapgen";
import { clamp, dist2, finiteOr, hashString, hexToInt, segPointDist2, TAU } from "../logic/math";
import { buildRunReport, IntensitySampler } from "../logic/report";
import { computeScore, gemValue } from "../logic/scoring";
import { SpatialHash } from "../logic/spatialHash";
import { TelemetryTracker } from "../logic/telemetry";
import { applyUpgrade, createBuild, rollUpgrades, xpToNext, type PlayerBuild } from "../logic/upgrades";
import { effectiveCooldown, fireWeapon, orbitalLayout, WEAPON_INFO, weaponRange, type Shot } from "../logic/weapons";
import { applyDirective } from "./directives";
import { updateBoss, updateEnemy } from "./enemyAI";
import type {
  ArchRuntime,
  BossState,
  Chest,
  EBullet,
  Enemy,
  FxEvent,
  Gem,
  Hazard,
  PBullet,
  PlayerState,
  Shrine,
  SimInput,
  ThemeState,
} from "./types";

export const MAX_ENEMIES = 400;
/** regular spawns stop here so boss / rival / event spawns always fit */
export const MAX_REGULAR = 360;
export const MAX_PBULLETS = 600;
export const MAX_EBULLETS = 600;
export const MAX_GEMS = 400;
export const MAX_HAZARDS = 160;
export { BASE_ENEMY_SPEED } from "./constants";
export const TELEMETRY_EVERY = 15;
const HUD_EVERY = 0.25;
const PLAYER_STATE_EVERY = 0.1;
const DASH_SPEED = 820;
const DASH_TIME = 0.17;
const MAX_FX = 900;

export interface SimConfig extends GameOptions {
  /** gameplay rng seed override (tests) */
  rngSeed?: number;
}

/**
 * The whole game simulation, independent of any renderer. The 3D view feeds
 * it input + real dt and renders its state; tests drive it headless.
 * It owns the GameToShell bus cadence (hud/pacing/player_state/telemetry).
 */
export class Sim {
  readonly out = new Bus<GameToShell>();
  readonly world: WorldSpec;
  readonly opts: SimConfig;
  readonly map: GameMap;
  readonly flow: FlowField;
  readonly pacing: PacingController;
  readonly rng: Rng;
  readonly rand: () => number;
  readonly hash: SpatialHash;
  readonly archetypes: ArchRuntime[];
  readonly archById = new Map<string, ArchRuntime>();
  readonly build: PlayerBuild;
  readonly player: PlayerState;
  readonly telemetry = new TelemetryTracker();
  readonly highlights = new HighlightTracker();
  readonly curve = new IntensitySampler();
  readonly actStarts: number[];
  readonly runLength: number;
  readonly players: number;

  enemies: Enemy[] = [];
  pBullets: PBullet[] = [];
  eBullets: EBullet[] = [];
  gems: Gem[] = [];
  hazards: Hazard[] = [];
  chests: Chest[] = [];
  shrines: Shrine[] = [];
  fx: FxEvent[] = [];

  // clocks
  /** run clock (includes startOffsetSec) */
  t: number;
  /** seconds actually played */
  played = 0;
  realClock = 0;
  orbitT = 0;
  act = 0;

  // flags
  started = false;
  shellPaused = false;
  upgradeOffer: UpgradeOption[] | null = null;
  pendingLevels = 0;
  ended = false;
  endEmitted = false;
  pendingEnd: { report: RunReport; at: number } | null = null;
  outcome: RunReport["outcome"] | null = null;
  hitstop = 0;
  slowmoT = 0;
  slowmoScale = 1;
  /** test hook */
  invulnerable = false;

  // pacing
  lastPacing: PacingOutput;
  spawnAcc = 0;

  // combat state
  boss: BossState | null = null;
  bossSpawned = false;
  bossDefeated = false;
  rival: Enemy | null = null;
  enemyCount = 0;
  regularCount = 0;
  uidSeq = 1;
  autoTarget: Enemy | null = null;

  // events
  theme: ThemeState;
  blackoutT = 0;
  blackoutMinHp = 1;
  timeSlowT = 0;
  meteor: { t: number; every: number; acc: number; strength: number } | null = null;

  // stats
  kills = 0;
  eliteKills = 0;
  bossKills = 0;
  totalDamageFrac = 0;
  killedBy: string | null = null;
  directivesUsed: string[] = [];
  fps = 60;
  lastView = { w: 1280, h: 720 };

  // per-frame counters for pacing
  frameDamage = 0;
  frameKills = 0;
  frameNearMisses = 0;

  // cadence
  private hudAcc = 0;
  private stateAcc = 0;
  private telemetryAcc = 0;
  private lastHitEventT = -99;
  private lastNearDeathT = -99;
  private lastDashFx = 0;

  private readonly tmp = { x: 0, y: 0 };

  constructor(opts: SimConfig) {
    this.opts = opts;
    this.world = opts.world;
    this.players = Math.max(1, Math.round(finiteOr(opts.players, 1)));
    this.map = generateMap(this.world);
    this.flow = new FlowField(this.map);
    this.pacing = new PacingController(this.world, { players: this.players });
    this.rng = createRng(opts.rngSeed ?? (hashString(opts.runId) ^ this.world.seed) >>> 0);
    this.rand = this.rng.next;
    this.hash = new SpatialHash(this.map.width, this.map.height, 96, MAX_ENEMIES);
    this.archetypes = this.world.enemies.map((e) => ({
      id: e.id,
      name: e.name,
      base: e.base,
      hp: e.hp,
      speed: e.speed,
      size: e.size,
      color: hexToInt(e.color),
      modifiers: new Set(e.modifiers),
      weight: e.weight,
      unlockAct: e.unlockAct,
      synthetic: false,
    }));
    for (const a of this.archetypes) this.archById.set(a.id, a);
    this.build = createBuild(this.world.player);
    this.player = {
      x: this.map.spawnX,
      y: this.map.spawnY,
      vx: 0,
      vy: 0,
      r: 14,
      hp: this.build.maxHp,
      maxHp: this.build.maxHp,
      alive: true,
      facing: -Math.PI / 2,
      iframes: 1.5,
      dashT: 0,
      dashCd: 0,
      dashDirX: 0,
      dashDirY: 0,
      shieldHits: 0,
      level: 1,
      xp: 0,
      xpToNext: xpToNext(1),
      moving: false,
      hurtFlash: 0,
    };
    this.actStarts = [];
    let acc = 0;
    for (const a of this.world.arc) {
      this.actStarts.push(acc);
      acc += a.durationSec;
    }
    this.runLength = acc;
    this.t = Math.max(0, finiteOr(opts.startOffsetSec ?? 0, 0));
    this.act = this.actAt(this.t);
    this.pacing.setAct(this.act);
    this.theme = {
      weather: this.world.theme.weather,
      fog: this.world.theme.fog,
      tint: null,
      version: 0,
    };
    this.lastPacing = this.pacing.update(0, { damageTaken: 0, hpFraction: 1, nearbyEnemies: 0, kills: 0, nearMisses: 0 });
    this.flow.update(this.player.x, this.player.y);
  }

  // -------------------------------------------------------------------------
  // Commands from the shell

  applyDirectives(list: Directive[]) {
    if (!Array.isArray(list)) return;
    for (const d of list) {
      let res: { ok: boolean; note?: string };
      try {
        res = applyDirective(this, d);
      } catch (err) {
        res = { ok: false, note: `error: ${(err as Error)?.message ?? "unknown"}` };
      }
      if (d && typeof d === "object" && "tool" in d) {
        this.telemetry.addDirective(d.tool);
        this.directivesUsed.push(d.tool);
        if (this.directivesUsed.length > 60) this.directivesUsed.shift();
      }
      this.out.emit("directive_applied", { directive: d, ok: res.ok, ...(res.note ? { note: res.note } : {}) });
    }
  }

  pickUpgrade(id: string) {
    const offer = this.upgradeOffer;
    if (!offer) return;
    let chosen = offer.find((o) => o.id === id);
    if (!chosen) {
      console.warn(`[bimpee] unknown upgrade id "${id}", taking first option`);
      chosen = offer[0]!;
    }
    const heal = applyUpgrade(this.build, chosen.id) ?? 0;
    this.player.maxHp = this.build.maxHp;
    this.player.hp = Math.min(this.player.maxHp, this.player.hp + heal);
    this.upgradeOffer = null;
    this.pendingLevels = Math.max(0, this.pendingLevels - 1);
    this.player.iframes = Math.max(this.player.iframes, 0.8);
    this.fx.length < MAX_FX && this.fx.push({ t: "ring", x: this.player.x, y: this.player.y, r: 160, color: hexToInt(this.world.theme.palette.accent) });
    if (this.pendingLevels > 0) this.openOffer();
  }

  pause() {
    this.shellPaused = true;
  }
  resume() {
    this.shellPaused = false;
  }
  quit() {
    if (!this.ended) this.endRun("quit", 0);
    this.flushEnd();
  }
  setFps(fps: number) {
    if (Number.isFinite(fps)) this.fps = clamp(fps, 0, 240);
  }

  get paused() {
    return this.shellPaused || !!this.upgradeOffer;
  }

  // -------------------------------------------------------------------------
  // Main loop

  step(realDtIn: number, input: SimInput) {
    const realDt = clamp(finiteOr(realDtIn, 0), 0, 0.1);
    this.realClock += realDt;
    if (input.viewW > 0 && input.viewH > 0) {
      this.lastView.w = input.viewW;
      this.lastView.h = input.viewH;
    }
    if (!this.started) {
      this.started = true;
      this.event("run_start", `Run started in ${this.world.name} (${this.world.arc[this.act]?.name ?? "Act 1"})`);
    }
    if (this.pendingEnd && this.realClock >= this.pendingEnd.at) this.flushEnd();
    if (this.endEmitted) return;
    this.cadence(realDt);
    if (this.paused) return;
    if (this.hitstop > 0) {
      this.hitstop -= realDt;
      return;
    }
    let scale = 1;
    if (this.slowmoT > 0) {
      this.slowmoT -= realDt;
      scale = this.slowmoScale;
    }
    // Substep long frames so nothing tunnels; drop time beyond 3 substeps.
    let remaining = Math.min(realDt, 0.1) * scale;
    let n = 0;
    while (remaining > 1e-6 && n < 3) {
      const dt = Math.min(remaining, 1 / 30);
      this.simulate(dt, input);
      remaining -= dt;
      n++;
      if (this.paused) break;
    }
  }

  private cadence(realDt: number) {
    this.hudAcc += realDt;
    this.stateAcc += realDt;
    if (this.hudAcc >= HUD_EVERY) {
      this.hudAcc = 0;
      this.out.emit("hud", this.hud());
      this.out.emit("pacing", this.lastPacing);
    }
    if (this.stateAcc >= PLAYER_STATE_EVERY) {
      this.stateAcc = 0;
      this.emitPlayerState();
    }
  }

  private emitPlayerState() {
    const p = this.player;
    this.out.emit("player_state", {
      x: Math.round(p.x),
      y: Math.round(p.y),
      hp: clamp(p.hp / Math.max(1, p.maxHp), 0, 1),
      score: this.score(),
      alive: p.alive,
    });
  }

  hud(): HudState {
    const p = this.player;
    const b = this.boss;
    return {
      t: Math.round(this.t * 10) / 10,
      act: this.act,
      actName: this.world.arc[this.act]?.name ?? "",
      hp: Math.max(0, Math.ceil(p.hp)),
      maxHp: Math.round(p.maxHp),
      level: p.level,
      xp: Math.floor(p.xp),
      xpToNext: p.xpToNext,
      score: this.score(),
      kills: this.kills,
      weapon: this.weaponLabel(),
      bossHp: b ? clamp(b.e.hp / Math.max(1, b.e.maxHp), 0, 1) : null,
      bossName: b ? b.name : null,
    };
  }

  weaponLabel() {
    return this.build.weapons.map((w) => WEAPON_INFO[w.kind].name).join(" + ");
  }

  score() {
    return computeScore({ kills: this.kills, eliteKills: this.eliteKills, bossKills: this.bossKills, timeSec: this.played });
  }

  actAt(t: number) {
    let a = 0;
    for (let i = 0; i < this.actStarts.length; i++) if (t >= this.actStarts[i]!) a = i;
    return Math.min(2, a);
  }

  private simulate(dt: number, input: SimInput) {
    this.t += dt;
    this.played += dt;
    this.orbitT += dt;
    this.frameDamage = 0;
    this.frameKills = 0;
    this.frameNearMisses = 0;

    // Acts
    const act = this.actAt(this.t);
    if (act !== this.act) {
      this.act = act;
      this.pacing.setAct(act);
      const a = this.world.arc[act];
      this.event("act_change", `Act ${act + 1}: ${a?.name ?? ""}`);
    }

    if (this.player.alive) this.updatePlayer(dt, input);
    this.flow.update(this.player.x, this.player.y);

    // Spatial hash
    this.hash.clear();
    for (const e of this.enemies) if (e.active) this.hash.insert(e.idx, e.x, e.y);

    if (this.player.alive && !this.ended) this.spawnTick(dt, input);

    const slow = this.timeSlowT > 0 ? 0.5 : 1;
    for (const e of this.enemies) {
      if (!e.active) continue;
      if (e.isBoss) updateBoss(this, e, dt * slow);
      else updateEnemy(this, e, dt * slow);
    }

    if (this.player.alive) this.updateWeapons(dt, input);
    this.updatePBullets(dt);
    this.updateEBullets(dt * slow);
    this.updateHazards(dt);
    this.updateGems(dt);
    this.updatePickups(dt);
    this.updateEvents(dt);

    // Pacing (fast-layer director)
    const p = this.player;
    let nearby = 0;
    if (p.alive) {
      this.hash.query(p.x, p.y, 250, (i) => {
        const e = this.enemies[i]!;
        if (e.active && dist2(e.x, e.y, p.x, p.y) < 250 * 250) nearby++;
      });
    }
    this.lastPacing = this.pacing.update(dt, {
      damageTaken: this.frameDamage,
      hpFraction: clamp(p.hp / Math.max(1, p.maxHp), 0, 1),
      nearbyEnemies: nearby,
      kills: this.frameKills,
      nearMisses: this.frameNearMisses,
    });

    // Telemetry
    this.telemetry.sample(dt, p.moving);
    this.telemetryAcc += dt;
    if (this.telemetryAcc >= TELEMETRY_EVERY) {
      this.telemetryAcc -= TELEMETRY_EVERY;
      this.emitTelemetry();
    }
    this.curve.update(dt, this.lastPacing.intensity);
    if (p.alive) this.highlights.onHp(p.hp / Math.max(1, p.maxHp));

    // The game never depends on the AI for its boss.
    if (!this.bossSpawned && !this.ended && this.act >= 2 && this.t >= (this.actStarts[2] ?? 0) + 45) {
      this.spawnBoss(`${this.world.boss.name} awakens`);
    }

    if (this.pendingLevels > 0 && !this.upgradeOffer && p.alive && !this.ended) this.openOffer();
  }

  emitTelemetry() {
    const p = this.player;
    const tel = this.telemetry.flush({
      runId: this.opts.runId,
      t: this.t,
      act: this.act,
      intensity: this.lastPacing.intensity,
      intensityTarget: this.lastPacing.target,
      phase: this.lastPacing.phase,
      hpFraction: p.hp / Math.max(1, p.maxHp),
      level: p.level,
      weapon: this.weaponLabel(),
      score: this.score(),
      enemiesAlive: this.enemyCount,
      bossActive: !!this.boss,
      fps: this.fps,
      players: this.players,
    });
    if (tel) this.out.emit("telemetry", tel);
  }

  // -------------------------------------------------------------------------
  // Player

  private updatePlayer(dt: number, input: SimInput) {
    const p = this.player;
    const b = this.build;
    p.iframes = Math.max(0, p.iframes - dt);
    p.dashCd = Math.max(0, p.dashCd - dt);
    p.hurtFlash = Math.max(0, p.hurtFlash - dt);
    if (b.regen > 0) p.hp = Math.min(p.maxHp, p.hp + b.regen * dt);

    let mx = finiteOr(input.moveX, 0);
    let my = finiteOr(input.moveY, 0);
    const ml = Math.hypot(mx, my);
    if (ml > 1) {
      mx /= ml;
      my /= ml;
    }
    p.moving = ml > 0.1;

    if (input.dash && p.dashCd <= 0 && p.dashT <= 0) {
      let dx = mx;
      let dy = my;
      if (!p.moving) {
        dx = Math.cos(p.facing);
        dy = Math.sin(p.facing);
      }
      const l = Math.hypot(dx, dy) || 1;
      p.dashDirX = dx / l;
      p.dashDirY = dy / l;
      p.dashT = DASH_TIME;
      p.dashCd = b.dashCooldown;
      p.iframes = Math.max(p.iframes, 0.3);
      this.pushFx({ t: "burst", x: p.x, y: p.y, color: hexToInt(this.world.theme.palette.player), count: 10, speed: 160, size: 1 });
    }

    if (p.dashT > 0) {
      p.dashT -= dt;
      p.vx = p.dashDirX * DASH_SPEED;
      p.vy = p.dashDirY * DASH_SPEED;
      this.lastDashFx -= dt;
      if (this.lastDashFx <= 0) {
        this.lastDashFx = 0.03;
        this.pushFx({ t: "afterimage", x: p.x, y: p.y, angle: p.facing });
      }
    } else {
      const k = 1 - Math.exp(-16 * dt);
      p.vx += (mx * b.moveSpeed - p.vx) * k;
      p.vy += (my * b.moveSpeed - p.vy) * k;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    resolveCircle(this.map, p, p.r);
  }

  private nearestEnemy(range: number): Enemy | null {
    const p = this.player;
    let best: Enemy | null = null;
    let bd = range * range;
    for (const e of this.enemies) {
      if (!e.active || e.spawnT > 0.3 || e.alpha < 0.3) continue;
      const d = dist2(e.x, e.y, p.x, p.y);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  private updateWeapons(dt: number, input: SimInput) {
    const p = this.player;
    const m = this.build.mods;
    const manual = input.aim !== null && Number.isFinite(input.aim);
    let target: Enemy | null = null;
    if (manual) {
      p.facing = input.aim as number;
    } else {
      target = this.nearestEnemy(640);
      if (target) p.facing = Math.atan2(target.y - p.y, target.x - p.x);
      else if (p.moving) p.facing = Math.atan2(p.vy, p.vx);
    }
    this.autoTarget = target;
    const targetDist = target ? Math.sqrt(dist2(target.x, target.y, p.x, p.y)) : manual ? finiteOr(input.aimDist, 300) : 300;

    for (const w of this.build.weapons) {
      if (w.kind === "orbitals") {
        this.updateOrbitals(w);
        continue;
      }
      w.timer -= dt;
      if (w.timer > 0) continue;
      const wantFire = manual ? input.firing : !!target && targetDist <= weaponRange(w, m) + 40;
      if (!wantFire) {
        w.timer = 0;
        continue;
      }
      w.timer = effectiveCooldown(w, m);
      const shots = fireWeapon(w, m, p.facing, this.rand, targetDist);
      for (const s of shots) this.spawnShot(s);
      if (shots.length) {
        this.pushFx({ t: "muzzle", x: p.x + Math.cos(p.facing) * 18, y: p.y + Math.sin(p.facing) * 18, angle: p.facing, color: hexToInt(this.world.theme.palette.player) });
      }
    }
  }

  private updateOrbitals(w: PlayerBuild["weapons"][number]) {
    const p = this.player;
    const lay = orbitalLayout(w, this.build.mods, this.orbitT);
    const cd = effectiveCooldown(w, this.build.mods);
    for (let i = 0; i < lay.count; i++) {
      const a = lay.angle0 + (i * TAU) / lay.count;
      const bx = p.x + Math.cos(a) * lay.radius;
      const by = p.y + Math.sin(a) * lay.radius;
      this.hash.query(bx, by, lay.bladeRadius + 100, (idx) => {
        const e = this.enemies[idx]!;
        if (!e.active || e.orbHit > 0) return;
        const rr = e.r + lay.bladeRadius;
        if (dist2(e.x, e.y, bx, by) > rr * rr) return;
        e.orbHit = cd;
        const crit = this.rand() < this.build.mods.critChance;
        const dmg = lay.damage * (crit ? this.build.mods.critMult : 1);
        const dx = e.x - p.x;
        const dy = e.y - p.y;
        const l = Math.hypot(dx, dy) || 1;
        this.damageEnemy(e, dmg, crit, (dx / l) * 220, (dy / l) * 220, true);
      });
    }
  }

  private spawnShot(s: Shot) {
    const p = this.player;
    const cos = Math.cos(s.angle);
    const sin = Math.sin(s.angle);
    if (s.kind === "lance") {
      this.telemetry.addShot();
      // Raycast against walls.
      let len = s.reach;
      for (let d = 16; d <= s.reach; d += 16) {
        if (this.isWall(p.x + cos * d, p.y + sin * d)) {
          len = d;
          break;
        }
      }
      const x2 = p.x + cos * len;
      const y2 = p.y + sin * len;
      let hitAny = false;
      const pad = s.radius + 100;
      this.hash.queryRect(Math.min(p.x, x2) - pad, Math.min(p.y, y2) - pad, Math.max(p.x, x2) + pad, Math.max(p.y, y2) + pad, (idx) => {
        const e = this.enemies[idx]!;
        if (!e.active) return;
        const rr = e.r + s.radius;
        if (segPointDist2(p.x, p.y, x2, y2, e.x, e.y) > rr * rr) return;
        hitAny = true;
        this.damageEnemy(e, s.damage, s.crit, cos * 160, sin * 160, false);
      });
      if (hitAny) this.telemetry.addHit();
      this.pushFx({ t: "lance", x1: p.x, y1: p.y, x2, y2, width: s.radius * 2, color: hexToInt(this.world.theme.palette.player) });
      return;
    }
    const b = this.alloc(this.pBullets, MAX_PBULLETS, newPBullet);
    if (!b) return;
    this.telemetry.addShot();
    b.kind = s.kind === "lob" ? "lob" : "bolt";
    b.x = b.sx = p.x + cos * 16;
    b.y = b.sy = p.y + sin * 16;
    b.r = s.radius;
    b.dmg = s.damage;
    b.crit = s.crit;
    b.pierce = s.pierce;
    b.life = b.maxLife = s.life;
    b.hits.length = 0;
    b.counted = false;
    b.angle = s.angle;
    b.area = s.reach;
    if (b.kind === "lob") {
      let tx = p.x + cos * s.distance;
      let ty = p.y + sin * s.distance;
      tx = clamp(tx, 20, this.map.width - 20);
      ty = clamp(ty, 20, this.map.height - 20);
      b.tx = tx;
      b.ty = ty;
      b.vx = b.vy = 0;
    } else {
      b.vx = cos * s.speed;
      b.vy = sin * s.speed;
    }
  }

  isWall(x: number, y: number) {
    const m = this.map;
    const c = Math.floor(x / m.tile);
    const r = Math.floor(y / m.tile);
    if (c < 0 || r < 0 || c >= m.cols || r >= m.rows) return true;
    return m.solid[r * m.cols + c] === 1;
  }

  // -------------------------------------------------------------------------
  // Projectiles

  private updatePBullets(dt: number) {
    for (const b of this.pBullets) {
      if (!b.active) continue;
      b.life -= dt;
      if (b.kind === "lob") {
        const k = clamp(1 - b.life / b.maxLife, 0, 1);
        b.x = b.sx + (b.tx - b.sx) * k;
        b.y = b.sy + (b.ty - b.sy) * k;
        if (b.life <= 0) {
          b.active = false;
          this.explodeLob(b);
        }
        continue;
      }
      const px = b.x;
      const py = b.y;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.life <= 0 || this.isWall(b.x, b.y)) {
        if (b.life > 0) this.pushFx({ t: "burst", x: b.x, y: b.y, color: hexToInt(this.world.theme.palette.wall), count: 3, speed: 90, size: 0.6 });
        b.active = false;
        continue;
      }
      // Swept hit test along the segment travelled this step.
      const pad = b.r + 100;
      this.hash.queryRect(Math.min(px, b.x) - pad, Math.min(py, b.y) - pad, Math.max(px, b.x) + pad, Math.max(py, b.y) + pad, (idx) => {
        if (!b.active) return true;
        const e = this.enemies[idx]!;
        if (!e.active || b.hits.includes(e.uid)) return;
        const rr = e.r + b.r;
        if (segPointDist2(px, py, b.x, b.y, e.x, e.y) > rr * rr) return;
        b.hits.push(e.uid);
        if (!b.counted) {
          b.counted = true;
          this.telemetry.addHit();
        }
        const l = Math.hypot(b.vx, b.vy) || 1;
        this.damageEnemy(e, b.dmg, b.crit, (b.vx / l) * 140, (b.vy / l) * 140, false);
        if (b.pierce <= 0) {
          b.active = false;
          return true;
        }
        b.pierce--;
        return;
      });
    }
  }

  private explodeLob(b: PBullet) {
    const r = b.area;
    let hitAny = false;
    this.hash.query(b.x, b.y, r + 100, (idx) => {
      const e = this.enemies[idx]!;
      if (!e.active) return;
      const rr = r + e.r;
      if (dist2(e.x, e.y, b.x, b.y) > rr * rr) return;
      hitAny = true;
      const dx = e.x - b.x;
      const dy = e.y - b.y;
      const l = Math.hypot(dx, dy) || 1;
      this.damageEnemy(e, b.dmg, b.crit, (dx / l) * 260, (dy / l) * 260, false);
    });
    if (hitAny) this.telemetry.addHit();
    const c = hexToInt(this.world.theme.palette.accent);
    this.pushFx({ t: "burst", x: b.x, y: b.y, color: c, count: 14, speed: 260, size: 1.2 });
    this.pushFx({ t: "ring", x: b.x, y: b.y, r, color: c });
    this.shake(0.12, 0.12);
  }

  private updateEBullets(dt: number) {
    const p = this.player;
    for (const b of this.eBullets) {
      if (!b.active) continue;
      b.life -= dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.life <= 0 || this.isWall(b.x, b.y)) {
        b.active = false;
        continue;
      }
      if (!p.alive) continue;
      const d2 = dist2(b.x, b.y, p.x, p.y);
      const hitR = p.r + b.r - 3;
      if (d2 < hitR * hitR) {
        if (p.iframes <= 0 || p.shieldHits > 0) {
          b.active = false;
          this.hurtPlayer(b.dmg, b.src);
        } else if (p.dashT > 0 && !b.near) {
          b.near = true;
          this.frameNearMisses++;
          this.telemetry.addNearMiss();
        }
        continue;
      }
      if (!b.near && d2 < (p.r + 34) ** 2) {
        b.near = true;
        this.frameNearMisses++;
        this.telemetry.addNearMiss();
      }
    }
  }

  fireEnemyBullet(x: number, y: number, angle: number, speed: number, dmg: number, src: string, color: number, r = 6) {
    const b = this.alloc(this.eBullets, MAX_EBULLETS, newEBullet);
    if (!b) return;
    b.x = x;
    b.y = y;
    b.vx = Math.cos(angle) * speed;
    b.vy = Math.sin(angle) * speed;
    b.r = r;
    b.dmg = dmg;
    b.life = 5;
    b.near = false;
    b.src = src;
    b.color = color;
  }

  // -------------------------------------------------------------------------
  // Hazards, gems, pickups

  addHazard(kind: Hazard["kind"], x: number, y: number, r: number, dur: number, dmg: number, src: string, color: number, hitsEnemies = false) {
    const h = this.alloc(this.hazards, MAX_HAZARDS, newHazard);
    if (!h) return;
    h.kind = kind;
    h.x = x;
    h.y = y;
    h.r = r;
    h.t = 0;
    h.dur = dur;
    h.dmg = dmg;
    h.src = src;
    h.color = color;
    h.hitsEnemies = hitsEnemies;
  }

  private updateHazards(dt: number) {
    const p = this.player;
    for (const h of this.hazards) {
      if (!h.active) continue;
      h.t += dt;
      if (h.kind === "puddle") {
        if (h.t >= h.dur) h.active = false;
        else if (p.alive && dist2(h.x, h.y, p.x, p.y) < (h.r + p.r * 0.5) ** 2) this.hurtPlayer(h.dmg, h.src);
        continue;
      }
      if (h.t < h.dur) continue;
      h.active = false;
      if (p.alive && dist2(h.x, h.y, p.x, p.y) < (h.r + p.r) ** 2) this.hurtPlayer(h.dmg, h.src);
      if (h.hitsEnemies) {
        this.hash.query(h.x, h.y, h.r + 100, (idx) => {
          const e = this.enemies[idx]!;
          if (!e.active || e.isBoss) return;
          if (dist2(e.x, e.y, h.x, h.y) < (h.r + e.r) ** 2) this.damageEnemy(e, h.dmg * 0.6, false, 0, 0, true);
        });
      }
      this.pushFx({ t: "burst", x: h.x, y: h.y, color: h.color, count: 18, speed: 300, size: 1.4 });
      this.pushFx({ t: "ring", x: h.x, y: h.y, r: h.r, color: h.color });
      const d = Math.sqrt(dist2(h.x, h.y, p.x, p.y));
      if (d < 700) this.shake(0.25 * (1 - d / 700), 0.2);
    }
  }

  dropGem(x: number, y: number, value: number, scatter = 0) {
    let g = this.alloc(this.gems, MAX_GEMS, newGem);
    if (!g) {
      // Pool full: merge into an existing gem so no XP is lost.
      for (const og of this.gems) {
        if (og.active) {
          og.value += value;
          return;
        }
      }
      return;
    }
    const a = this.rand() * TAU;
    g.x = x;
    g.y = y;
    g.vx = Math.cos(a) * scatter;
    g.vy = Math.sin(a) * scatter;
    g.value = value;
    g.mag = false;
    g.speed = 0;
    g.age = 0;
  }

  private updateGems(dt: number) {
    const p = this.player;
    const magR = this.build.magnet;
    for (const g of this.gems) {
      if (!g.active) continue;
      g.age += dt;
      if (!p.alive) continue;
      const dx = p.x - g.x;
      const dy = p.y - g.y;
      const d2 = dx * dx + dy * dy;
      if (!g.mag && d2 < magR * magR) g.mag = true;
      if (g.mag) {
        g.speed = Math.min(1100, g.speed + 1900 * dt);
        const d = Math.sqrt(d2) || 1;
        g.x += (dx / d) * g.speed * dt;
        g.y += (dy / d) * g.speed * dt;
      } else if (g.vx || g.vy) {
        g.x += g.vx * dt;
        g.y += g.vy * dt;
        const k = Math.exp(-5 * dt);
        g.vx *= k;
        g.vy *= k;
        if (Math.abs(g.vx) + Math.abs(g.vy) < 2) g.vx = g.vy = 0;
      }
      if (d2 < (p.r + 12) ** 2) {
        g.active = false;
        this.gainXp(g.value);
        this.pushFx({ t: "pickup", x: g.x, y: g.y, color: hexToInt(this.world.theme.palette.accent) });
      }
    }
  }

  gainXp(v: number) {
    const p = this.player;
    p.xp += v;
    while (p.xp >= p.xpToNext) {
      p.xp -= p.xpToNext;
      p.level++;
      p.xpToNext = xpToNext(p.level);
      this.pendingLevels++;
      this.event("level_up", `Reached level ${p.level}`);
      this.highlights.onLevel(p.level);
    }
  }

  private openOffer() {
    const options = rollUpgrades(this.build, this.rand, 3);
    if (!options.length) {
      this.pendingLevels = 0;
      return;
    }
    this.upgradeOffer = options;
    this.out.emit("upgrade_offer", options);
  }

  private updatePickups(dt: number) {
    const p = this.player;
    for (const c of this.chests) {
      if (!c.active) continue;
      c.age += dt;
      if (p.alive && dist2(c.x, c.y, p.x, p.y) < (p.r + 26) ** 2) {
        c.active = false;
        const n = 10;
        for (let i = 0; i < n; i++) this.dropGem(c.x, c.y, Math.max(1, Math.round(c.value / n)), 260);
        p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.25);
        this.pushFx({ t: "burst", x: c.x, y: c.y, color: hexToInt(this.world.theme.palette.glow), count: 30, speed: 340, size: 1.4 });
        this.pushFx({ t: "ring", x: c.x, y: c.y, r: 140, color: hexToInt(this.world.theme.palette.accent) });
        this.out.emit("banner", { text: "Treasure claimed!", tone: "boon" });
      }
    }
    if (this.chests.some((c) => !c.active)) this.chests = this.chests.filter((c) => c.active);
    for (const s of this.shrines) {
      if (!s.active) continue;
      s.age += dt;
      s.life -= dt;
      if (s.life <= 0 || s.pool <= 0) {
        s.active = false;
        continue;
      }
      if (p.alive && dist2(s.x, s.y, p.x, p.y) < s.r * s.r && p.hp < p.maxHp) {
        const h = Math.min(s.pool, 12 * dt, p.maxHp - p.hp);
        p.hp += h;
        s.pool -= h;
      }
    }
    if (this.shrines.some((s) => !s.active)) this.shrines = this.shrines.filter((s) => s.active);
  }

  private updateEvents(dt: number) {
    const p = this.player;
    if (this.timeSlowT > 0) this.timeSlowT = Math.max(0, this.timeSlowT - dt);
    if (this.blackoutT > 0) {
      this.blackoutT -= dt;
      this.blackoutMinHp = Math.min(this.blackoutMinHp, p.hp / Math.max(1, p.maxHp));
      if (this.blackoutT <= 0) {
        this.blackoutT = 0;
        if (p.alive) {
          this.highlights.onBlackoutSurvived(this.blackoutMinHp);
          this.out.emit("banner", { text: "The lights return", tone: "info" });
        }
      }
    }
    const m = this.meteor;
    if (m) {
      m.t -= dt;
      m.acc += dt;
      while (m.acc >= m.every) {
        m.acc -= m.every;
        const a = this.rand() * TAU;
        const d = this.rand() * 300;
        const lead = 0.6;
        const x = clamp(p.x + p.vx * lead + Math.cos(a) * d, 40, this.map.width - 40);
        const y = clamp(p.y + p.vy * lead + Math.sin(a) * d, 40, this.map.height - 40);
        this.addHazard("meteor", x, y, 64, 1.3, 16, "meteor shower", 0xff7a2a, true);
      }
      if (m.t <= 0) {
        this.meteor = null;
        if (p.alive) this.highlights.onEventSurvived("meteor_shower", p.hp / Math.max(1, p.maxHp));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Spawning

  spawnRingRadius(input: { viewW: number; viewH: number }) {
    const half = Math.hypot(finiteOr(input.viewW, 1280), finiteOr(input.viewH, 720)) / 2;
    return clamp(half + 60, 420, 1400);
  }

  private spawnTick(dt: number, input: SimInput) {
    const pc = this.lastPacing;
    const rate = pc.spawnPerSec * (this.boss ? 0.45 : 1);
    this.spawnAcc += Math.max(0, finiteOr(rate, 0)) * dt;
    const cap = Math.min(MAX_REGULAR, Math.max(0, Math.round(pc.maxAlive)) * (this.boss ? 0.6 : 1));
    if (this.spawnAcc > 6) this.spawnAcc = 6;
    const ring = this.spawnRingRadius(input);
    while (this.spawnAcc >= 1) {
      if (this.regularCount >= cap) {
        this.spawnAcc = Math.min(this.spawnAcc, 1);
        break;
      }
      this.spawnAcc -= 1;
      const arch = this.pickArchetype();
      if (!arch) break;
      const pos = this.findSpawnPos(ring, ring + 260, arch.size * 12 * 1.3, 14);
      if (!pos) continue;
      this.spawnEnemy(arch, pos.x, pos.y, { elite: this.rand() < pc.eliteChance });
    }
  }

  pickArchetype(): ArchRuntime | null {
    const table = this.pacing.spawnTable();
    let total = 0;
    for (const t of table) total += t.weight;
    if (total <= 0) {
      return this.archetypes.find((a) => a.unlockAct <= this.act) ?? this.archetypes[0] ?? null;
    }
    let roll = this.rand() * total;
    for (const t of table) {
      roll -= t.weight;
      if (roll <= 0) return this.archById.get(t.id) ?? null;
    }
    return this.archById.get(table[table.length - 1]!.id) ?? null;
  }

  /** Random open, reachable position at distance [minR, maxR] from the player. */
  findSpawnPos(minR: number, maxR: number, radius: number, tries: number, cx = this.player.x, cy = this.player.y) {
    for (let i = 0; i < tries; i++) {
      const a = this.rand() * TAU;
      const d = minR + this.rand() * Math.max(0, maxR - minR);
      const x = cx + Math.cos(a) * d;
      const y = cy + Math.sin(a) * d;
      if (circleFree(this.map, x, y, radius) && this.flow.distanceAt(x, y) >= 0) return { x, y };
    }
    return null;
  }

  spawnEnemy(
    arch: ArchRuntime,
    x: number,
    y: number,
    o: { elite?: boolean; splitGen?: number; sizeMul?: number; hpMul?: number; tide?: boolean; rival?: boolean; boss?: boolean; spawnT?: number } = {},
  ): Enemy | null {
    const special = !!(o.boss || o.rival);
    if (!special && this.enemyCount >= MAX_ENEMIES - 4) return null;
    const e = this.alloc(this.enemies, MAX_ENEMIES, newEnemy);
    if (!e) return null;
    const elite = !!o.elite;
    const hpScale = special ? 1 : 1 + this.act * 0.3 + (this.player.level - 1) * 0.045;
    e.uid = this.uidSeq++;
    e.arch = arch;
    e.x = x;
    e.y = y;
    e.vx = e.vy = e.kx = e.ky = 0;
    e.r = o.boss ? 15 * arch.size : 12 * arch.size * (o.sizeMul ?? 1) * (elite ? 1.25 : 1);
    e.maxHp = e.hp = Math.max(1, arch.hp * hpScale * (o.hpMul ?? 1) * (elite ? 3 : 1));
    e.elite = elite;
    e.isBoss = !!o.boss;
    e.rival = !!o.rival;
    e.tide = !!o.tide;
    e.splitGen = o.splitGen ?? 0;
    e.state = 0;
    e.stateT = 0;
    e.cd = 0.8 + this.rand() * 1.5;
    e.cd2 = 2 + this.rand() * 2;
    e.ang = Math.atan2(y - this.player.y, x - this.player.x);
    e.renderAng = e.ang + Math.PI;
    e.dirX = e.dirY = 0;
    e.shield = arch.modifiers.has("shielded") ? (elite ? 3 : 2) : 0;
    e.shieldRegen = 0;
    e.flash = 0;
    e.spawnT = o.spawnT ?? 0.35;
    e.alpha = 1;
    e.cloakT = this.rand() * 4;
    e.trailT = 0.3;
    e.teleT = 3 + this.rand() * 3;
    e.orbHit = 0;
    e.lifeT = 0;
    e.contact = o.boss ? 18 : (arch.base === "tank" ? 11 : arch.base === "swarmer" ? 5 : 8) * (elite ? 1.4 : 1);
    e.kbResist = o.boss ? 1 : arch.base === "tank" ? 0.85 : elite ? 0.5 : 0;
    this.enemyCount++;
    if (!special) this.regularCount++;
    return e;
  }

  releaseEnemy(e: Enemy) {
    if (!e.active) return;
    e.active = false;
    this.enemyCount = Math.max(0, this.enemyCount - 1);
    if (!e.isBoss && !e.rival) this.regularCount = Math.max(0, this.regularCount - 1);
    if (this.autoTarget === e) this.autoTarget = null;
  }

  spawnBoss(announce: string): { ok: boolean; note?: string } {
    if (this.bossDefeated) return { ok: false, note: "boss already defeated" };
    if (this.boss || this.bossSpawned) return { ok: false, note: "boss already active" };
    if (this.ended) return { ok: false, note: "run ended" };
    const spec = this.world.boss;
    const arch: ArchRuntime = {
      id: "__boss",
      name: spec.name,
      base: spec.base,
      hp: spec.hp * (1 + (this.players - 1) * 0.5),
      speed: spec.base === "tank" ? 0.55 : 0.75,
      size: spec.size,
      color: hexToInt(spec.color),
      modifiers: new Set(),
      weight: 0,
      unlockAct: 0,
      synthetic: true,
    };
    const r = 15 * spec.size;
    let pos = this.findSpawnPos(380, 560, r, 30) ?? this.findSpawnPos(250, 700, r * 0.6, 40);
    if (!pos) pos = { x: this.player.x, y: this.player.y - 300 };
    const e = this.spawnEnemy(arch, pos.x, pos.y, { boss: true, spawnT: 1.2 });
    if (!e) return { ok: false, note: "no free enemy slot" };
    resolveCircle(this.map, e, e.r * 0.5);
    this.bossSpawned = true;
    this.boss = {
      e,
      name: spec.name,
      phase: 1,
      phases: clamp(Math.round(spec.phases), 1, 3),
      sigCd: 3,
      sigActive: 0,
      sigStep: 0,
      secondaryCd: 4,
      laser: null,
      spiralAngle: 0,
      chargesLeft: 0,
      spawnedAt: this.t,
    };
    this.event("boss_spawn", `${spec.name} has arrived`);
    this.out.emit("banner", { text: announce || `${spec.name} awakens`, tone: "danger" });
    if (spec.taunt) this.out.emit("banner", { text: `${spec.name}: "${spec.taunt}"`, tone: "danger" });
    this.shake(0.6, 0.8);
    this.pushFx({ t: "ring", x: e.x, y: e.y, r: 260, color: arch.color });
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Damage

  damageEnemy(e: Enemy, rawDmg: number, crit: boolean, kx: number, ky: number, quiet: boolean) {
    if (!e.active) return;
    let dmg = finiteOr(rawDmg, 0);
    if (dmg <= 0) return;
    if (e.shield > 0) {
      e.shield--;
      e.shieldRegen = 4;
      dmg *= 0.2;
      this.pushFx({ t: "shield", x: e.x, y: e.y, r: e.r + 6 });
    }
    e.hp -= dmg;
    e.flash = 0.08;
    if (!e.isBoss) {
      const k = 1 - e.kbResist;
      e.kx += kx * k;
      e.ky += ky * k;
    }
    if (!quiet || crit || dmg >= 3) this.pushFx({ t: "dmg", x: e.x, y: e.y - e.r, amount: dmg, crit });
    if (e.hp <= 0) this.killEnemy(e);
    else if (e.isBoss && this.boss) this.checkBossPhase();
  }

  private checkBossPhase() {
    const b = this.boss;
    if (!b) return;
    const frac = b.e.hp / Math.max(1, b.e.maxHp);
    const phase = clamp(1 + Math.floor((1 - frac) * b.phases), 1, b.phases);
    if (phase > b.phase) {
      b.phase = phase;
      b.sigCd = Math.min(b.sigCd, 1.2);
      this.event("boss_phase", `${b.name} enters phase ${phase}`);
      this.out.emit("banner", { text: `${b.name} grows furious (phase ${phase})`, tone: "danger" });
      this.shake(0.5, 0.5);
      this.pushFx({ t: "ring", x: b.e.x, y: b.e.y, r: 320, color: b.e.arch.color });
      // punctuation burst
      const n = 10 + phase * 4;
      for (let i = 0; i < n; i++) this.fireEnemyBullet(b.e.x, b.e.y, (i / n) * TAU, 170, 8, b.name, b.e.arch.color, 7);
    }
  }

  killEnemy(e: Enemy) {
    if (!e.active) return;
    const arch = e.arch;
    this.releaseEnemy(e);
    if (e.isBoss) {
      this.onBossDefeated(e);
      return;
    }
    this.kills++;
    this.frameKills++;
    this.telemetry.addKill();
    this.highlights.onKills(this.kills);
    const loot = this.lastPacing.lootMultiplier;
    if (!e.tide || this.rand() < 0.5) this.dropGem(e.x, e.y, gemValue(arch.hp, e.elite, loot) * (e.rival ? 12 : 1), e.elite ? 80 : 0);
    if (e.elite) {
      this.eliteKills++;
      this.highlights.onEliteKills(this.eliteKills);
      this.hitstop = Math.max(this.hitstop, 0.06);
      this.shake(0.3, 0.2);
      this.event("elite_kill", `Elite ${arch.name} destroyed`);
    } else if (this.kills % 25 === 0) {
      this.event("kill", `${this.kills} kills`);
    }
    if (e.rival) {
      this.rival = null;
      this.highlights.onRivalKilled();
      this.hitstop = Math.max(this.hitstop, 0.1);
      this.out.emit("banner", { text: "Mirror rival shattered", tone: "boon" });
    }
    if (arch.modifiers.has("explodes")) {
      this.addHazard("blast", e.x, e.y, 70 + e.r, 0.6, 12, `${arch.name} explosion`, 0xff5533, false);
    }
    if (arch.base === "splitter" && e.splitGen < 2 && !e.tide) {
      for (let i = 0; i < 2; i++) {
        const a = this.rand() * TAU;
        const c = this.spawnEnemy(arch, e.x + Math.cos(a) * e.r, e.y + Math.sin(a) * e.r, {
          splitGen: e.splitGen + 1,
          sizeMul: Math.pow(0.65, e.splitGen + 1),
          hpMul: Math.pow(0.45, e.splitGen + 1),
          spawnT: 0.05,
        });
        if (c) {
          c.kx = Math.cos(a) * 260;
          c.ky = Math.sin(a) * 260;
        }
      }
    }
    this.pushFx({ t: "burst", x: e.x, y: e.y, color: arch.color, count: e.elite ? 26 : 10, speed: e.elite ? 320 : 220, size: Math.min(2, e.r / 14) });
    if (e.elite) this.pushFx({ t: "ring", x: e.x, y: e.y, r: e.r * 3, color: arch.color });
  }

  private onBossDefeated(e: Enemy) {
    const b = this.boss;
    const name = b?.name ?? this.world.boss.name;
    const fight = b ? this.t - b.spawnedAt : 0;
    this.boss = null;
    this.bossDefeated = true;
    this.bossKills = 1;
    this.kills++;
    this.highlights.onBossKilled(name, this.player.hp / Math.max(1, this.player.maxHp), fight);
    this.hitstop = 0.18;
    this.slowmoT = 1.6;
    this.slowmoScale = 0.3;
    this.shake(1, 1.2);
    const c = e.arch.color;
    this.pushFx({ t: "burst", x: e.x, y: e.y, color: c, count: 80, speed: 520, size: 2.2 });
    this.pushFx({ t: "ring", x: e.x, y: e.y, r: 520, color: c });
    this.pushFx({ t: "flash", color: 0xffffff, alpha: 0.6 });
    for (const b2 of this.eBullets) b2.active = false;
    for (const o of this.enemies) {
      if (!o.active) continue;
      this.pushFx({ t: "burst", x: o.x, y: o.y, color: o.arch.color, count: 6, speed: 200, size: 1 });
      this.releaseEnemy(o);
    }
    this.rival = null;
    for (let i = 0; i < 12; i++) this.dropGem(e.x, e.y, 5, 300);
    this.event("boss_defeated", `${name} defeated`);
    this.out.emit("banner", { text: `${name} has fallen!`, tone: "boon" });
    // A bullet still in flight can finish the boss after the player died: that run stays a death.
    if (this.ended) return;
    this.event("victory", `Victory in ${this.world.name}`);
    this.endRun("victory", 2.6);
  }

  hurtPlayer(rawAmount: number, source: string) {
    const p = this.player;
    if (!p.alive || this.ended) return;
    if (p.iframes > 0) return;
    if (p.shieldHits > 0) {
      p.shieldHits--;
      p.iframes = 0.5;
      this.pushFx({ t: "shield", x: p.x, y: p.y, r: p.r + 12 });
      this.shake(0.1, 0.1);
      return;
    }
    if (this.invulnerable) {
      p.iframes = 0.6;
      return;
    }
    const amount = Math.max(0, finiteOr(rawAmount, 0) * this.build.armor);
    if (amount <= 0) return;
    p.hp -= amount;
    const frac = amount / Math.max(1, p.maxHp);
    this.frameDamage += frac;
    this.totalDamageFrac += frac;
    this.telemetry.addDamage(frac);
    p.iframes = 0.6;
    p.hurtFlash = 0.25;
    this.killedBy = source;
    this.shake(0.25 + frac * 2, 0.22);
    this.pushFx({ t: "flash", color: 0xff2040, alpha: 0.25 + frac });
    this.pushFx({ t: "burst", x: p.x, y: p.y, color: 0xff4060, count: 8, speed: 200, size: 1 });
    const hpFrac = Math.max(0, p.hp) / Math.max(1, p.maxHp);
    if (this.t - this.lastHitEventT >= 1) {
      this.lastHitEventT = this.t;
      this.event("player_hit", `Hit by ${source} (${Math.round(hpFrac * 100)}% hp)`);
    }
    if (p.hp > 0 && hpFrac < 0.2 && this.t - this.lastNearDeathT >= 20) {
      this.lastNearDeathT = this.t;
      this.event("near_death", `Near death at ${Math.round(hpFrac * 100)}% hp`);
    }
    if (p.hp <= 0) {
      p.hp = 0;
      p.alive = false;
      p.vx = p.vy = 0;
      this.slowmoT = 1.4;
      this.slowmoScale = 0.25;
      this.shake(0.8, 0.6);
      this.pushFx({ t: "burst", x: p.x, y: p.y, color: hexToInt(this.world.theme.palette.player), count: 60, speed: 420, size: 1.8 });
      this.pushFx({ t: "ring", x: p.x, y: p.y, r: 300, color: 0xff2040 });
      this.event("death", `Killed by ${source}`);
      this.emitPlayerState();
      this.endRun("death", 1.8);
    }
  }

  // -------------------------------------------------------------------------
  // Run end

  endRun(outcome: RunReport["outcome"], delayReal: number) {
    if (this.ended) return;
    this.ended = true;
    this.outcome = outcome;
    const report = buildRunReport({
      runId: this.opts.runId,
      worldName: this.world.name,
      worldSeed: this.world.seed,
      biome: this.world.theme.biome,
      outcome,
      durationSec: this.played,
      score: this.score(),
      kills: this.kills,
      level: this.player.level,
      accuracy: this.telemetry.accuracy,
      damageTaken: this.totalDamageFrac,
      killedBy: outcome === "death" ? this.killedBy : null,
      bossDefeated: this.bossDefeated,
      highlights: [...this.highlights.list],
      directivesUsed: [...this.directivesUsed],
      intensityCurve: [...this.curve.values],
    });
    this.upgradeOffer = null;
    this.pendingLevels = 0;
    this.pendingEnd = { report, at: this.realClock + Math.max(0, delayReal) };
  }

  flushEnd() {
    if (this.endEmitted || !this.pendingEnd) return;
    this.endEmitted = true;
    this.out.emit("run_end", this.pendingEnd.report);
  }

  // -------------------------------------------------------------------------
  // Helpers

  event(kind: GameEventKind, text: string) {
    const ev: GameEvent = { kind, t: Math.round(this.t * 10) / 10, text };
    this.telemetry.addEvent(text);
    this.out.emit("event", ev);
  }

  pushFx(f: FxEvent) {
    if (this.fx.length < MAX_FX) this.fx.push(f);
  }

  shake(amount: number, dur: number) {
    this.pushFx({ t: "shake", amount, dur });
  }

  alloc<T extends { active: boolean }>(arr: T[], cap: number, make: (i: number) => T): T | null {
    for (let i = 0; i < arr.length; i++) {
      const o = arr[i]!;
      if (!o.active) {
        o.active = true;
        return o;
      }
    }
    if (arr.length >= cap) return null;
    const o = make(arr.length);
    o.active = true;
    arr.push(o);
    return o;
  }

  /** Steering towards the player around walls (flow field), written into `out`. */
  seekDir(x: number, y: number, out: { x: number; y: number }) {
    const p = this.player;
    const dx = p.x - x;
    const dy = p.y - y;
    const d = Math.hypot(dx, dy) || 1;
    const fd = this.flow.distanceAt(x, y);
    if (fd >= 0 && fd <= 2) {
      out.x = dx / d;
      out.y = dy / d;
      return d;
    }
    if (this.flow.directionAt(x, y, this.tmp) && (this.tmp.x || this.tmp.y)) {
      out.x = this.tmp.x;
      out.y = this.tmp.y;
    } else {
      out.x = dx / d;
      out.y = dy / d;
    }
    return d;
  }
}

function newEnemy(i: number): Enemy {
  return {
    active: false,
    idx: i,
    uid: 0,
    arch: null as unknown as ArchRuntime,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    kx: 0,
    ky: 0,
    r: 10,
    hp: 1,
    maxHp: 1,
    elite: false,
    isBoss: false,
    rival: false,
    tide: false,
    splitGen: 0,
    state: 0,
    stateT: 0,
    cd: 0,
    cd2: 0,
    ang: 0,
    dirX: 0,
    dirY: 0,
    shield: 0,
    shieldRegen: 0,
    flash: 0,
    spawnT: 0,
    alpha: 1,
    cloakT: 0,
    trailT: 0,
    teleT: 0,
    orbHit: 0,
    lifeT: 0,
    contact: 0,
    kbResist: 0,
    renderAng: 0,
  };
}

function newPBullet(): PBullet {
  return { active: false, kind: "bolt", x: 0, y: 0, vx: 0, vy: 0, r: 4, dmg: 1, crit: false, pierce: 0, life: 0, maxLife: 1, hits: [], counted: false, sx: 0, sy: 0, tx: 0, ty: 0, area: 0, angle: 0 };
}

function newEBullet(): EBullet {
  return { active: false, x: 0, y: 0, vx: 0, vy: 0, r: 6, dmg: 1, life: 0, near: false, src: "", color: 0xffffff };
}

function newGem(): Gem {
  return { active: false, x: 0, y: 0, vx: 0, vy: 0, value: 1, mag: false, speed: 0, age: 0 };
}

function newHazard(): Hazard {
  return { active: false, kind: "puddle", x: 0, y: 0, r: 10, t: 0, dur: 1, dmg: 0, src: "", color: 0xffffff, hitsEnemies: false };
}
