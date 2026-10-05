import * as Phaser from "phaser";
import { DamageNumbers, Particles } from "../fx/pools";
import { createTextures } from "../fx/textures";
import { hexToInt, mixColor, TAU } from "../logic/math";
import type { Sim } from "../sim/Sim";
import type { FxEvent } from "../sim/types";
import { CameraRig } from "../systems/camera";
import { DEPTH, EntityRenderer } from "../systems/entityRenderer";
import { GhostSystem } from "../systems/ghosts";
import { InputSystem } from "../systems/input";
import { MapRenderer } from "../systems/mapRenderer";
import { Overlays } from "../systems/overlays";
import { WeatherSystem } from "../systems/weather";

export interface SceneContext {
  sim: Sim;
  ghosts: GhostSystemHost;
  reducedMotion: () => boolean;
}

/** Lets index.ts hand ghost updates to the scene even before it is created. */
export interface GhostSystemHost {
  latest: Parameters<GhostSystem["setPlayers"]>[0];
  version: number;
}

/**
 * The only Phaser scene. It reads input, steps the Phaser-free Sim, then
 * renders the Sim's state and drains its FX queue.
 */
export class GameScene extends Phaser.Scene {
  private sim!: Sim;
  private host!: GhostSystemHost;
  private reduced!: () => boolean;
  private mapR!: MapRenderer;
  private ents!: EntityRenderer;
  private input2!: InputSystem;
  private rig!: CameraRig;
  private weather!: WeatherSystem;
  private overlays!: Overlays;
  private ghosts!: GhostSystem;
  private particles!: Particles;
  private numbers!: DamageNumbers;
  private ui!: Phaser.GameObjects.Graphics;
  private nameLabel: Phaser.GameObjects.Text | null = null;
  private ghostVersion = -1;
  private weatherVersion = -1;
  private ready = false;
  private onResize = (size: Phaser.Structs.Size) => this.handleResize(size.width, size.height);

  constructor(private readonly ctx: SceneContext) {
    super({ key: "bimpee-game" });
  }

  create() {
    this.sim = this.ctx.sim;
    this.host = this.ctx.ghosts;
    this.reduced = this.ctx.reducedMotion;
    const sim = this.sim;
    const world = sim.world;
    const pal = world.theme.palette;

    createTextures(this);
    const cam = this.cameras.main;
    cam.setBackgroundColor(pal.background);
    cam.roundPixels = false;

    this.mapR = new MapRenderer(this, sim.map, pal, world.seed);
    this.ents = new EntityRenderer(this, sim, world.theme.bloom);
    this.particles = new Particles(this, DEPTH.particles, 700);
    this.numbers = new DamageNumbers(this, DEPTH.numbers, 48);
    this.ghosts = new GhostSystem(this);
    this.input2 = new InputSystem(this);
    this.rig = new CameraRig(cam, sim.map, sim.player.x, sim.player.y, this.reduced);
    this.overlays = new Overlays(this, world);
    this.weather = new WeatherSystem(this, sim.theme.weather, this.reduced);
    this.weatherVersion = sim.theme.version;
    this.ui = this.add.graphics().setDepth(DEPTH.ui);
    if (sim.players > 1 && sim.opts.playerName) {
      this.nameLabel = this.add
        .text(sim.player.x, sim.player.y - 32, sim.opts.playerName.slice(0, 24), {
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          fontSize: "13px",
          color: pal.player,
          stroke: "#000000",
          strokeThickness: 3,
        })
        .setOrigin(0.5)
        .setDepth(DEPTH.player + 1);
    }

    this.handleResize(this.scale.width, this.scale.height);
    this.scale.on(Phaser.Scale.Events.RESIZE, this.onResize);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown());
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.teardown());
    this.ready = true;
  }

  private handleResize(w: number, h: number) {
    if (!this.rig || !(w > 0 && h > 0)) return;
    this.cameras.main.setSize(w, h);
    this.rig.resize(w, h);
  }

  override update(_time: number, deltaMs: number) {
    if (!this.ready) return;
    const sim = this.sim;
    const realDt = Math.min(0.1, Math.max(0, (Number.isFinite(deltaMs) ? deltaMs : 16) / 1000));

    const input = this.input2.read(this.rig.center, this.rig.zoom, sim.player, this.rig.viewW, this.rig.viewH);
    sim.setFps(this.game.loop.actualFps);
    sim.step(realDt, input);

    // visual time: frozen-ish during hit-stop, slowed during slow-mo, still animating when paused
    const visDt = sim.paused ? realDt * 0.15 : sim.hitstop > 0 ? realDt * 0.05 : sim.slowmoT > 0 ? realDt * sim.slowmoScale : realDt;

    this.drainFx();
    const p = sim.player;
    this.rig.update(realDt, p.x, p.y, p.vx, p.vy, p.facing);
    const cx = this.rig.center.x;
    const cy = this.rig.center.y;
    const vw = this.rig.viewW;
    const vh = this.rig.viewH;

    this.ents.render(visDt);
    this.particles.update(visDt);
    this.numbers.update(visDt);

    if (this.host.version !== this.ghostVersion) {
      this.ghostVersion = this.host.version;
      this.ghosts.setPlayers(this.host.latest);
    }
    this.ghosts.update(realDt);
    this.nameLabel?.setPosition(p.x, p.y - 32).setVisible(p.alive);

    if (sim.theme.version !== this.weatherVersion) {
      this.weatherVersion = sim.theme.version;
      this.weather.set(sim.theme.weather, cx, cy, vw, vh);
      this.overlays.flashColor(sim.theme.tint ?? 0xffffff, 0.25);
    }
    this.weather.update(realDt, cx, cy, vw, vh);
    this.overlays.update(realDt, sim, cx, cy, vw, vh, this.reduced());
    this.drawUi(cx, cy);
  }

  /** Crosshair + virtual joystick (world space, drawn from screen coords). */
  private drawUi(cx: number, cy: number) {
    const g = this.ui;
    g.clear();
    const z = this.rig.zoom;
    const toWorld = (sx: number, sy: number) => ({ x: cx + (sx - this.scale.width / 2) / z, y: cy + (sy - this.scale.height / 2) / z });
    const accent = hexToInt(this.sim.world.theme.palette.accent);
    if (this.input2.manualAim && this.sim.player.alive) {
      const m = toWorld(this.input2.mouse.x, this.input2.mouse.y);
      g.lineStyle(2 / z, accent, 0.85);
      g.strokeCircle(m.x, m.y, 10 / z);
      g.lineBetween(m.x - 16 / z, m.y, m.x - 6 / z, m.y);
      g.lineBetween(m.x + 6 / z, m.y, m.x + 16 / z, m.y);
      g.lineBetween(m.x, m.y - 16 / z, m.x, m.y - 6 / z);
      g.lineBetween(m.x, m.y + 6 / z, m.x, m.y + 16 / z);
    }
    const st = this.input2.stick;
    if (st) {
      const o = toWorld(st.ox, st.oy);
      const dx = st.x - st.ox;
      const dy = st.y - st.oy;
      const l = Math.hypot(dx, dy);
      const m = Math.min(l, 60);
      const k = l > 0 ? m / l : 0;
      const knob = toWorld(st.ox + dx * k, st.oy + dy * k);
      g.fillStyle(0xffffff, 0.08);
      g.fillCircle(o.x, o.y, 60 / z);
      g.lineStyle(2 / z, 0xffffff, 0.3);
      g.strokeCircle(o.x, o.y, 60 / z);
      g.fillStyle(accent, 0.55);
      g.fillCircle(knob.x, knob.y, 24 / z);
    }
  }

  private drainFx() {
    const fx = this.sim.fx;
    const reduced = this.reduced();
    const pal = this.sim.world.theme.palette;
    const playerColor = hexToInt(pal.player);
    const n = Math.min(fx.length, 600);
    for (let i = 0; i < n; i++) this.playFx(fx[i]!, reduced, playerColor);
    fx.length = 0;
  }

  private playFx(f: FxEvent, reduced: boolean, playerColor: number) {
    const P = this.particles;
    switch (f.t) {
      case "burst": {
        const count = Math.min(80, Math.round(f.count * (reduced ? 0.5 : 1)));
        for (let i = 0; i < count; i++) {
          const a = Math.random() * TAU;
          const s = f.speed * (0.3 + Math.random() * 0.9);
          P.spawn({
            key: i % 3 === 0 ? "dot" : "spark",
            x: f.x,
            y: f.y,
            vx: Math.cos(a) * s,
            vy: Math.sin(a) * s,
            life: 0.25 + Math.random() * 0.4,
            scale0: (i % 3 === 0 ? 0.5 : 0.7) * f.size,
            scale1: 0,
            color: i % 4 === 0 ? 0xffffff : f.color,
            drag: 4,
            faceVel: i % 3 !== 0,
          });
        }
        break;
      }
      case "ring":
        P.spawn({ key: "ring", x: f.x, y: f.y, life: 0.45, scale0: 0.1, scale1: f.r / 56, color: f.color, alpha: 0.9, drag: 0 });
        break;
      case "dmg":
        this.numbers.spawn(f.x, f.y, f.amount, f.crit);
        break;
      case "shake":
        this.rig.shake(f.amount, f.dur);
        break;
      case "flash":
        this.overlays.flashColor(f.color, reduced ? f.alpha * 0.4 : f.alpha);
        break;
      case "lance":
        this.ents.addLance(f.x1, f.y1, f.x2, f.y2, f.width, f.color);
        for (let i = 0; i < 6; i++) {
          const k = Math.random();
          P.spawn({ key: "dot", x: f.x1 + (f.x2 - f.x1) * k, y: f.y1 + (f.y2 - f.y1) * k, vx: (Math.random() - 0.5) * 80, vy: (Math.random() - 0.5) * 80, life: 0.3, scale0: 0.35, color: f.color });
        }
        break;
      case "afterimage":
        P.spawn({ key: "player", x: f.x, y: f.y, life: 0.25, scale0: 0.62, scale1: 0.5, rotation: f.angle, color: playerColor, alpha: 0.5, drag: 0 });
        break;
      case "muzzle":
        P.spawn({ key: "glow", x: f.x, y: f.y, life: 0.08, scale0: 0.35, scale1: 0.1, color: mixColor(f.color, 0xffffff, 0.5), alpha: 0.9, drag: 0 });
        break;
      case "teleport":
        P.spawn({ key: "ring", x: f.x, y: f.y, life: 0.35, scale0: 0.9, scale1: 0.05, color: f.color, drag: 0 });
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * TAU;
          P.spawn({ key: "spark", x: f.x, y: f.y, vx: Math.cos(a) * 160, vy: Math.sin(a) * 160, life: 0.3, scale0: 0.6, color: f.color, faceVel: true });
        }
        break;
      case "pickup":
        P.spawn({ key: "dot", x: f.x, y: f.y, life: 0.2, scale0: 0.6, scale1: 0, color: f.color, drag: 0 });
        break;
      case "shield":
        P.spawn({ key: "ring", x: f.x, y: f.y, life: 0.25, scale0: f.r / 56, scale1: (f.r * 1.4) / 56, color: 0x9fe8ff, drag: 0 });
        break;
    }
  }

  private torn = false;
  private teardown() {
    if (this.torn) return;
    this.torn = true;
    this.ready = false;
    this.scale.off(Phaser.Scale.Events.RESIZE, this.onResize);
    this.input2?.destroy();
    this.weather?.destroy();
    this.overlays?.destroy();
    this.ghosts?.destroy();
    this.ents?.destroy();
    this.particles?.destroy();
    this.numbers?.destroy();
    this.mapR?.destroy();
    this.nameLabel?.destroy();
    this.nameLabel = null;
  }
}
