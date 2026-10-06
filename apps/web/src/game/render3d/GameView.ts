import * as THREE from "three";
import type { RoomPlayer } from "@bimpee/shared";
import type { Sim } from "../sim/Sim";
import type { Enemy, FxEvent, SimInput } from "../sim/types";
import { aimAssist, rayPlaneY, type AimResult } from "./aim";
import { Bag } from "./bag";
import { CameraRig, CROSSHAIR_NDC_Y } from "./cameraRig";
import { cameraRelativeMove } from "./controls";
import { S, SHOT_H, spawnViewForRing } from "./coords";
import { BossModel, BulletLayer, EnemyLayer, HazardLayer, PickupLayer, PlayerModel, type LayerCtx } from "./entities";
import { Environment, WALL_MAX } from "./environment";
import { Draw, Fx, PK } from "./fx";
import { GhostLayer } from "./ghosts";
import { edgeIndicator, rearThreat, type EdgePoint } from "./indicators";
import { type Intents, InputController } from "./input";
import { DamageNumbers, NameLabel } from "./labels";
import { segmentBlockedT } from "./occlusion";
import { Overlay, type Arrow, type OverlayFrame } from "./overlay";
import { intColor } from "./palette";
import { PostFx } from "./postfx";
import { QUALITY_LEVELS, QualityGovernor } from "./quality";
import { TextureKit } from "./textures";
import { WeatherLayer } from "./weather";

/** Enemies spawn on this ring (sim px): beyond what reads clearly through the fog. */
export const SPAWN_RING_PX = 1000;
const SPAWN_VIEW = spawnViewForRing(SPAWN_RING_PX);
const ASSIST = { cone: 0.13, maxDist: 820, strength: 0.6 };

export interface ViewOptions {
  reducedMotion: () => boolean;
  /** starting quality level (0 = best) */
  quality?: number;
  /** never step quality down (dev screenshots) */
  lockQuality?: boolean;
}

const v3 = new THREE.Vector3();
const v4 = new THREE.Vector4();
const vp = new THREE.Matrix4();
const col = new THREE.Color();

/**
 * The 3D renderer for a running Sim: owns the WebGL renderer, scene, camera
 * rig, input, post-processing and every visual layer. Throws from the
 * constructor when WebGL is unavailable (the caller then runs headless).
 */
export class GameView {
  readonly renderer: THREE.WebGLRenderer;
  private readonly bag = new Bag();
  private readonly scene = new THREE.Scene();
  private readonly env: Environment;
  private readonly draw: Draw;
  private readonly fx: Fx;
  private readonly enemies: EnemyLayer;
  private readonly player: PlayerModel;
  private readonly boss: BossModel;
  private readonly bullets: BulletLayer;
  private readonly pickups: PickupLayer;
  private readonly hazards: HazardLayer;
  private readonly ghosts: GhostLayer;
  private readonly numbers: DamageNumbers;
  private readonly weather: WeatherLayer;
  private readonly rig: CameraRig;
  private readonly post: PostFx;
  private readonly overlay: Overlay;
  readonly input: InputController;
  private readonly governor: QualityGovernor;
  private readonly spot: THREE.SpotLight;
  private nameLabel: NameLabel | null = null;
  private readonly ro: ResizeObserver | null = null;
  private readonly offs: (() => void)[] = [];
  private readonly intents: Intents = { moveX: 0, moveY: 0, dash: false, firing: false, yaw: 0, pitch: 0, locked: false, touch: false, cursor: null, autoFire: false };
  private readonly simInput: SimInput = { moveX: 0, moveY: 0, aim: null, aimDist: 300, firing: false, dash: false, viewW: SPAWN_VIEW.viewW, viewH: SPAWN_VIEW.viewH };
  private readonly move = { x: 0, y: 0 };
  private readonly assist: AimResult = { angle: 0, dist: 0, target: -1 };
  private readonly arrows: Arrow[] = Array.from({ length: 16 }, () => ({ x: 0, y: 0, angle: 0, color: "#fff", size: 10, alpha: 1 }));
  private readonly edge: EdgePoint = { x: 0, y: 0, angle: 0 };
  private readonly playerColor: THREE.Color;
  private readonly accentCss: string;
  private w = 1;
  private h = 1;
  private dpr = 1;
  private time = 0;
  private themeVersion: number;
  private lost = false;
  private disposed = false;
  private occ = 0;
  private slow = 0;
  private danger = 0;
  private blackout = 0;
  private aimTarget = -1;
  private aimManual = false;
  private readonly near: Enemy[] = [];

  constructor(
    private readonly parent: HTMLElement,
    private readonly sim: Sim,
    private readonly opts: ViewOptions,
  ) {
    const reduced = opts.reducedMotion;
    this.governor = new QualityGovernor(opts.quality ?? 0);
    this.governor.locked = !!opts.lockQuality;
    const q = this.governor.current;
    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance", alpha: false, stencil: false, depth: true });
    this.renderer = renderer;
    try {
      this.dpr = Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, q.dprCap);
      renderer.setPixelRatio(this.dpr);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.shadowMap.enabled = q.shadows;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      const cv = renderer.domElement;
      Object.assign(cv.style, { position: "absolute", inset: "0", width: "100%", height: "100%", display: "block", touchAction: "none", outline: "none" });
      cv.tabIndex = -1;
      parent.appendChild(cv);
      const onLost = (e: Event) => {
        e.preventDefault();
        this.lost = true;
      };
      const onRestored = () => {
        this.lost = false;
        this.resize();
      };
      cv.addEventListener("webglcontextlost", onLost);
      cv.addEventListener("webglcontextrestored", onRestored);
      this.offs.push(() => {
        cv.removeEventListener("webglcontextlost", onLost);
        cv.removeEventListener("webglcontextrestored", onRestored);
      });

      const world = sim.world;
      this.env = new Environment(world, sim.map, this.bag, { shadows: q.shadows, shadowSize: q.shadowSize });
      this.scene.add(this.env.group);
      this.scene.fog = this.env.fog;
      this.playerColor = this.env.pal.player.clone();
      this.accentCss = world.theme.palette.accent;
      const tex = new TextureKit(this.bag);
      this.draw = new Draw(this.bag, tex, this.scene, q.particles);
      this.fx = new Fx(this.bag, this.draw, this.scene, Math.round(2400 * q.particles));
      this.fx.quality = q.particles * (reduced() ? 0.6 : 1);
      const ctx: LayerCtx = { sim, draw: this.draw, fx: this.fx, pal: this.env.pal, bag: this.bag, scene: this.scene };
      this.hazards = new HazardLayer(ctx);
      this.pickups = new PickupLayer(ctx);
      this.enemies = new EnemyLayer(ctx);
      this.boss = new BossModel(ctx);
      this.player = new PlayerModel(ctx);
      this.bullets = new BulletLayer(ctx);
      this.fx.initAfterimages(this.player.geometry, this.scene);
      this.ghosts = new GhostLayer(this.scene, this.player.geometry);
      this.numbers = new DamageNumbers(this.bag, this.scene);
      if (sim.players > 1 && sim.opts.playerName) {
        this.nameLabel = new NameLabel(sim.opts.playerName, world.theme.palette.player);
        this.scene.add(this.nameLabel.sprite);
      }
      this.weather = new WeatherLayer(this.bag, this.scene, this.fx, q.particles, reduced);
      this.weather.set(sim.theme.weather);
      this.themeVersion = sim.theme.version;
      this.spot = new THREE.SpotLight(0xfff2e0, 0, 34, 0.55, 0.65, 1.1);
      this.scene.add(this.spot, this.spot.target);

      const p = sim.player;
      this.rig = new CameraRig(sim.map, WALL_MAX + 0.15, p.x * S, p.y * S);
      this.post = new PostFx(renderer, this.scene, this.rig.camera, {
        bloom: world.theme.bloom,
        vignette: world.theme.vignette,
        crt: world.theme.crt,
        bloomScale: q.bloomScale,
        exposure: this.env.style.exposure,
      });
      this.post.setStatic(sim.theme.weather === "static");
      this.overlay = new Overlay(parent);
      this.input = new InputController(cv, () => !this.sim.paused && !this.sim.ended && this.sim.player.alive);

      if (typeof ResizeObserver !== "undefined") {
        this.ro = new ResizeObserver(() => this.resize());
        this.ro.observe(parent);
      }
      const onWin = () => this.resize();
      window.addEventListener("resize", onWin);
      this.offs.push(() => window.removeEventListener("resize", onWin));
      this.resize();
    } catch (err) {
      // partial construction: free whatever exists, then let the caller go headless
      this.dispose();
      throw err;
    }
  }

  private resize() {
    if (this.disposed) return;
    const w = Math.max(1, Math.floor(this.parent.clientWidth || window.innerWidth || 800));
    const h = Math.max(1, Math.floor(this.parent.clientHeight || window.innerHeight || 600));
    this.w = w;
    this.h = h;
    const cap = this.governor.current.dprCap;
    this.dpr = Math.min(window.devicePixelRatio || 1, cap);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(w, h, false);
    this.post.setSize(w, h);
    this.rig.resize(w, h);
    this.overlay.resize(w, h, this.dpr);
    this.input.dashButton.x = w - 92;
    this.input.dashButton.y = h - 190;
  }

  private applyQuality() {
    const q = this.governor.current;
    const shadowsChanged = this.renderer.shadowMap.enabled !== q.shadows;
    this.renderer.shadowMap.enabled = q.shadows;
    this.env.setShadows(q.shadows, q.shadowSize);
    if (shadowsChanged) {
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(m)) m.forEach((x) => (x.needsUpdate = true));
        else if (m) m.needsUpdate = true;
      });
    }
    this.post.setBloomScale(q.bloomScale);
    this.fx.quality = q.particles * (this.opts.reducedMotion() ? 0.6 : 1);
    this.weather.setParticleScale(q.particles);
    this.resize();
  }

  setGhosts(list: RoomPlayer[]) {
    this.ghosts.setPlayers(list);
  }

  releasePointer() {
    this.input.releaseLock();
  }

  /** Reads devices and turns them into this frame's SimInput (camera-relative). */
  readInput(dt: number): SimInput {
    const sim = this.sim;
    const it = this.input.consume(dt, this.intents);
    const out = this.simInput;
    const p = sim.player;
    if (!sim.paused && p.alive) {
      this.rig.yaw += it.yaw;
      this.rig.pitch = Math.max(0.34, Math.min(0.74, this.rig.pitch + it.pitch * 0.6));
    }
    cameraRelativeMove(it.moveX, it.moveY, this.rig.yaw, this.move);
    out.moveX = this.move.x;
    out.moveY = this.move.y;
    out.dash = it.dash;
    out.aim = null;
    out.aimDist = 300;
    out.firing = false;
    this.aimTarget = -1;
    this.aimManual = false;
    if (!it.touch && (it.locked || it.cursor)) {
      const ndcX = it.locked ? 0 : (it.cursor!.x / this.w) * 2 - 1;
      const ndcY = it.locked ? CROSSHAIR_NDC_Y : -((it.cursor!.y / this.h) * 2 - 1);
      const cam = this.rig.camera;
      v3.set(ndcX, ndcY, 0.5).unproject(cam).sub(cam.position).normalize();
      const t = rayPlaneY(cam.position.y, v3.y, SHOT_H);
      let gx: number;
      let gz: number;
      if (t < 0 || t > 90) {
        const hl = Math.hypot(v3.x, v3.z) || 1;
        gx = cam.position.x + (v3.x / hl) * 60;
        gz = cam.position.z + (v3.z / hl) * 60;
      } else {
        gx = cam.position.x + v3.x * t;
        gz = cam.position.z + v3.z * t;
      }
      const sx = gx / S;
      const sy = gz / S;
      const raw = Math.atan2(sy - p.y, sx - p.x);
      const rawDist = Math.hypot(sx - p.x, sy - p.y);
      if (Number.isFinite(raw)) {
        aimAssist(p.x, p.y, raw, rawDist, sim.enemies, ASSIST, this.assist);
        out.aim = this.assist.angle;
        out.aimDist = Math.max(40, this.assist.dist);
        this.aimTarget = this.assist.target;
        this.aimManual = true;
      }
      out.firing = it.firing;
    }
    return out;
  }

  /** Renders one frame. `visDt` is the animation dt (0 while paused). */
  frame(realDt: number, visDt: number) {
    if (this.disposed) return;
    const sim = this.sim;
    const reduced = this.opts.reducedMotion();
    if (this.governor.sample(realDt)) this.applyQuality();
    this.time += visDt;
    const t = this.time;

    // director: biome shift / weather
    if (sim.theme.version !== this.themeVersion) {
      this.themeVersion = sim.theme.version;
      this.env.shiftTheme(sim.theme.tint, sim.theme.fog);
      this.weather.set(sim.theme.weather);
      this.post.setStatic(sim.theme.weather === "static");
      this.post.flashColor(intColor(sim.theme.tint ?? 0xffffff, col), reduced ? 0.1 : 0.3);
      if (!reduced) this.rig.shake(0.25, 0.4, reduced);
    }

    this.draw.begin();
    this.fx.beginFrame(t);
    this.drainFx(reduced);

    const p = sim.player;
    const bo = sim.blackoutT > 0 ? 1 : 0;
    this.blackout += (bo - this.blackout) * Math.min(1, realDt * (bo ? 3 : 1.5));
    const wf = this.weather.fogInfo();
    this.env.update(visDt, { blackout: this.blackout, weatherFog: wf.mul, weatherFogColor: wf.color });

    this.hazards.update(visDt, t);
    this.pickups.update(visDt, t);
    this.enemies.update(visDt, t);
    this.boss.update(visDt, t);
    this.player.update(visDt, t, reduced);
    this.bullets.update(visDt, t);
    this.fx.update(visDt);
    this.numbers.update(visDt);
    this.ghosts.update(realDt, t);
    if (this.nameLabel) {
      this.nameLabel.sprite.visible = p.alive;
      this.nameLabel.sprite.position.set(p.x * S, 2.3, p.y * S);
    }

    // camera
    this.rig.update(realDt, {
      x: p.x * S,
      z: p.y * S,
      vx: p.vx * S,
      vz: p.vy * S,
      alive: p.alive,
      dashing: p.dashT > 0,
      intensity: sim.lastPacing?.intensity ?? 0,
      reduced,
      yaw: 0,
      pitch: 0,
    });
    const cam = this.rig.camera;
    this.env.setFocus(p.x * S, p.y * S);
    this.weather.update(visDt, this.rig.target, (this.h * this.dpr) / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)), 1 - this.blackout * 0.75);

    // blackout: a hard spotlight cone on the player
    this.spot.intensity = this.blackout * 60;
    this.spot.position.set(p.x * S - 1.5, 10, p.y * S + 1.5);
    this.spot.target.position.set(p.x * S, 0, p.y * S);
    this.spot.target.updateMatrixWorld();

    // see-through walls around the player when occluded
    const blocked = p.alive && segmentBlockedT(sim.map, cam.position.x / S, cam.position.z / S, cam.position.y, p.x, p.y, this.player.pos.y, WALL_MAX) < 1;
    this.occ += ((blocked ? 1 : 0) - this.occ) * Math.min(1, realDt * 8);
    const ou = this.env.occ;
    v3.copy(this.player.pos).project(cam);
    ou.uOccCenter.value.set((v3.x * 0.5 + 0.5) * this.w * this.dpr, (v3.y * 0.5 + 0.5) * this.h * this.dpr);
    ou.uOccRadius.value = Math.max(70, Math.min(320, this.h * this.dpr * 0.13));
    v3.copy(this.player.pos).applyMatrix4(cam.matrixWorldInverse);
    ou.uOccDepth.value = -v3.z;
    ou.uOccStrength.value = this.occ;

    // post
    const hpFrac = p.hp / Math.max(1, p.maxHp);
    const low = p.alive && hpFrac < 0.3 ? (0.3 - hpFrac) * 1.4 * (0.6 + 0.4 * Math.sin(this.time * 6)) : 0;
    this.slow += ((sim.timeSlowT > 0 ? 1 : 0) - this.slow) * Math.min(1, realDt * 3);
    const threat = p.alive ? rearThreat(p.x, p.y, this.rig.yaw, sim.enemies, 260) : 0;
    this.danger += (threat - this.danger) * Math.min(1, realDt * 4);
    const tint = this.env.tint;
    this.post.update(realDt, { tint: tint.color, tintAmt: tint.amount, slow: this.slow, hurt: Math.min(0.9, Math.max(low, p.hurtFlash * 2.5)), danger: this.danger, blackout: this.blackout, reduced });

    this.draw.end();
    this.drawOverlay();
    if (!this.lost) this.post.render(realDt);
  }

  private drawOverlay() {
    const sim = this.sim;
    const p = sim.player;
    const it = this.intents;
    const playing = p.alive && !sim.paused && !sim.ended;
    const cam = this.rig.camera;
    vp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    let n = 0;
    const W = this.w;
    const H = this.h;
    const push = (x: number, y: number, z: number, color: string, size: number, alpha: number) => {
      if (n >= this.arrows.length) return;
      v4.set(x, y, z, 1).applyMatrix4(vp);
      if (!edgeIndicator(v4.x, v4.y, v4.w, W, H, 34, this.edge)) return;
      const a = this.arrows[n++]!;
      a.x = this.edge.x;
      a.y = this.edge.y;
      a.angle = this.edge.angle;
      a.color = color;
      a.size = size;
      a.alpha = alpha;
    };
    if (playing) {
      const b = sim.boss;
      if (b && b.e.active) push(b.e.x * S, 1.5, b.e.y * S, "#ff3355", 16, 1);
      if (sim.rival?.active) push(sim.rival.x * S, 1, sim.rival.y * S, "#ff3366", 13, 1);
      for (const c of sim.chests) if (c.active) push(c.x * S, 1, c.y * S, "#ffc23a", 12, 0.95);
      for (const s of sim.shrines) if (s.active) push(s.x * S, 1, s.y * S, "#7dffb0", 12, 0.9);
      // the closest off-screen enemies (bounded, so a crowd behind is a few arrows, not a fence)
      const R2 = 420 * 420;
      let picked = 0;
      this.near.length = 0;
      for (const e of sim.enemies) {
        if (!e.active || e.isBoss || e.rival || e.spawnT > 0.2 || e.alpha < 0.3) continue;
        const dx = e.x - p.x;
        const dy = e.y - p.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > R2) continue;
        this.near.push(e);
      }
      this.near.sort((a, b) => (a.x - p.x) ** 2 + (a.y - p.y) ** 2 - ((b.x - p.x) ** 2 + (b.y - p.y) ** 2));
      for (const e of this.near) {
        if (picked >= 6 || n >= this.arrows.length) break;
        const before = n;
        const k = 1 - Math.hypot(e.x - p.x, e.y - p.y) / 420;
        push(e.x * S, 0.8, e.y * S, e.elite ? "#ffd84a" : "#ff6a5a", 7 + k * 5, 0.35 + k * 0.55);
        if (n > before) picked++;
      }
    }
    let lockOn: { x: number; y: number } | null = null;
    if (playing && this.aimManual && this.aimTarget >= 0) {
      const e = sim.enemies[this.aimTarget];
      if (e && e.active) {
        v3.set(e.x * S, e.r * S * 1.1, e.y * S).project(cam);
        if (v3.z < 1) lockOn = { x: (v3.x * 0.5 + 0.5) * W, y: (-v3.y * 0.5 + 0.5) * H };
      }
    }
    const dashReady = 1 - p.dashCd / Math.max(0.01, sim.build.dashCooldown);
    const crossY = (-CROSSHAIR_NDC_Y * 0.5 + 0.5) * H;
    const frame: OverlayFrame = {
      w: W,
      h: H,
      showCrosshair: playing && !it.touch && (it.locked || !!it.cursor),
      cross: it.locked || !it.cursor ? { x: W / 2, y: crossY } : { x: it.cursor.x, y: it.cursor.y },
      accent: this.accentCss,
      dashReady,
      lockOn,
      hint: playing && !it.touch && !it.locked ? "Click to aim · WASD move · Space dash · F auto-fire · Q/E turn" : null,
      autoFire: it.autoFire,
      touch: playing && it.touch,
      stick: this.input.stick,
      dashButton: this.input.dashButton,
      arrows: this.arrows,
      arrowCount: n,
    };
    this.overlay.draw(frame);
  }

  private drainFx(reduced: boolean) {
    const list = this.sim.fx;
    const n = Math.min(list.length, 600);
    for (let i = 0; i < n; i++) this.playFx(list[i]!, reduced);
    list.length = 0;
  }

  private playFx(f: FxEvent, reduced: boolean) {
    const fx = this.fx;
    switch (f.t) {
      case "burst": {
        intColor(f.color, col);
        const debris = f.count >= 10 && f.color !== 0xff4060 ? Math.min(10, Math.round(f.count / 3)) : 0;
        fx.burst(f.x * S, 0.7, f.y * S, col, Math.min(80, f.count), f.speed * S * 1.2, Math.max(0.6, f.size), reduced ? Math.round(debris / 2) : debris);
        if (f.count >= 10) fx.spawn({ kind: PK.glow, x: f.x * S, y: 0.8, z: f.y * S, life: 0.25, s0: 1.5 * f.size, s1: 4 * f.size, r: col.r * 3, g: col.g * 3, b: col.b * 3, drag: 0 });
        break;
      }
      case "ring":
        fx.ring(f.x * S, f.y * S, f.r * S, intColor(f.color, col), 0.5, 0.1, 2.2);
        break;
      case "dmg":
        this.numbers.spawn(f.x * S, 1.6, f.y * S, f.amount, f.crit);
        break;
      case "shake":
        this.rig.shake(f.amount, f.dur, reduced);
        break;
      case "flash":
        intColor(f.color, col);
        this.post.flashColor(col, f.alpha * 0.55);
        if (f.color === 0xff2040) this.post.hit(0.4 + f.alpha);
        break;
      case "lance": {
        intColor(f.color, col);
        const w = Math.max(0.08, f.width * S * 0.22);
        fx.lance(f.x1 * S, SHOT_H, f.y1 * S, f.x2 * S, SHOT_H, f.y2 * S, w, col, 0.22);
        for (let i = 0; i < 6; i++) {
          const k = Math.random();
          fx.spawn({ kind: PK.spark, x: (f.x1 + (f.x2 - f.x1) * k) * S, y: SHOT_H, z: (f.y1 + (f.y2 - f.y1) * k) * S, vx: (Math.random() - 0.5) * 6, vy: Math.random() * 4, vz: (Math.random() - 0.5) * 6, life: 0.3, s0: 0.08, r: col.r * 3, g: col.g * 3, b: col.b * 3, grav: -10 });
        }
        break;
      }
      case "afterimage":
        col.copy(this.playerColor).multiplyScalar(1.6);
        fx.afterimage(f.x * S, this.player.pos.y, f.y * S, -f.angle, this.player.bankAngle, col);
        break;
      case "muzzle": {
        intColor(f.color, col);
        fx.spawn({ kind: PK.glow, x: f.x * S, y: SHOT_H, z: f.y * S, life: 0.07, s0: 1.1, s1: 0.4, r: col.r * 3, g: col.g * 3, b: col.b * 3, drag: 0 });
        break;
      }
      case "teleport": {
        intColor(f.color, col);
        fx.ring(f.x * S, f.y * S, 1.6, col, 0.35, 1, 2.5);
        fx.lance(f.x * S, 0, f.y * S, f.x * S, 7, f.y * S, 0.35, col, 0.3);
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2;
          fx.spawn({ kind: PK.spark, x: f.x * S, y: 0.6, z: f.y * S, vx: Math.cos(a) * 6, vy: 1 + Math.random() * 3, vz: Math.sin(a) * 6, life: 0.35, s0: 0.1, r: col.r * 3, g: col.g * 3, b: col.b * 3 });
        }
        break;
      }
      case "pickup":
        intColor(f.color, col);
        fx.spawn({ kind: PK.glow, x: f.x * S, y: 0.8, z: f.y * S, vy: 1.5, life: 0.25, s0: 0.7, s1: 0, r: col.r * 2.5, g: col.g * 2.5, b: col.b * 2.5, drag: 0 });
        break;
      case "shield":
        col.setRGB(0.62, 0.9, 1);
        fx.ring(f.x * S, f.y * S, f.r * S * 1.6, col, 0.3, 0.6, 2.2);
        fx.spawn({ kind: PK.glow, x: f.x * S, y: 0.8, z: f.y * S, life: 0.2, s0: f.r * S * 3, s1: f.r * S * 4, r: 0.6, g: 1.2, b: 1.8, drag: 0 });
        break;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.input?.destroy();
    } catch {
      /* ignore */
    }
    this.ro?.disconnect();
    for (const f of this.offs) f();
    this.offs.length = 0;
    try {
      this.weather?.dispose();
      this.ghosts?.dispose();
      this.nameLabel?.dispose();
      this.post?.dispose();
    } catch {
      /* keep tearing down */
    }
    this.bag.dispose();
    // safety net for anything created outside the bag
    this.scene.traverse((o) => {
      if ((o as THREE.Light).isLight) (o as THREE.Light).dispose();
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m?.dispose?.();
    });
    this.scene.clear();
    try {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
    } catch {
      /* ignore */
    }
    this.renderer.domElement.remove();
    this.overlay?.dispose();
  }
}
