import * as Phaser from "phaser";
import type { Weather } from "@bimpee/shared";
import { DEPTH } from "./entityRenderer";

interface Drop {
  img: Phaser.GameObjects.Image;
  x: number;
  y: number;
  vx: number;
  vy: number;
  phase: number;
  s: number;
}

interface Kit {
  key: string;
  count: number;
  color: number;
  alpha: number;
  additive: boolean;
  init(d: Drop, r: () => number): void;
  step(d: Drop, dt: number, t: number, r: () => number): void;
}

const KITS: Record<Exclude<Weather, "none">, Kit> = {
  rain: {
    key: "w_rain",
    count: 170,
    color: 0xa8c8ff,
    alpha: 0.45,
    additive: false,
    init: (d, r) => ((d.vx = -90), (d.vy = 900 + r() * 300), (d.s = 0.7 + r() * 0.6)),
    step: () => {},
  },
  snow: {
    key: "dot",
    count: 140,
    color: 0xffffff,
    alpha: 0.75,
    additive: false,
    init: (d, r) => ((d.vx = -20 + r() * 40), (d.vy = 40 + r() * 50), (d.s = 0.12 + r() * 0.22)),
    step: (d, dt, t) => (d.x += Math.sin(t * 1.3 + d.phase) * 25 * dt),
  },
  embers: {
    key: "dot",
    count: 90,
    color: 0xff8a3a,
    alpha: 0.9,
    additive: true,
    init: (d, r) => ((d.vx = -15 + r() * 30), (d.vy = -(30 + r() * 60)), (d.s = 0.08 + r() * 0.14)),
    step: (d, dt, t) => {
      d.x += Math.sin(t * 2 + d.phase) * 30 * dt;
      d.img.setAlpha(0.5 + 0.5 * Math.sin(t * 8 + d.phase * 5));
    },
  },
  spores: {
    key: "dot",
    count: 80,
    color: 0xc8ff6a,
    alpha: 0.6,
    additive: true,
    init: (d, r) => ((d.vx = -10 + r() * 20), (d.vy = -8 + r() * 16), (d.s = 0.1 + r() * 0.25)),
    step: (d, dt, t) => {
      d.x += Math.sin(t * 0.7 + d.phase) * 18 * dt;
      d.y += Math.cos(t * 0.5 + d.phase) * 14 * dt;
    },
  },
  sandstorm: {
    key: "w_streak",
    count: 160,
    color: 0xe8c48a,
    alpha: 0.4,
    additive: false,
    init: (d, r) => ((d.vx = 700 + r() * 400), (d.vy = 60 + r() * 60), (d.s = 0.6 + r() * 1.2)),
    step: () => {},
  },
  bubbles: {
    key: "w_bubble",
    count: 70,
    color: 0xbff6ff,
    alpha: 0.55,
    additive: false,
    init: (d, r) => ((d.vx = 0), (d.vy = -(40 + r() * 70)), (d.s = 0.4 + r() * 0.9)),
    step: (d, dt, t) => (d.x += Math.sin(t * 2 + d.phase) * 30 * dt),
  },
  static: {
    key: "w_static",
    count: 70,
    color: 0xffffff,
    alpha: 0.5,
    additive: true,
    init: (d, r) => ((d.vx = 0), (d.vy = 0), (d.s = 0.5 + r() * 2)),
    step: (d, _dt, _t, r) => {
      if (r() < 0.08) {
        d.x += (r() - 0.5) * 600;
        d.y += (r() - 0.5) * 600;
      }
      d.img.setAlpha(r() < 0.5 ? 0 : 0.3 + r() * 0.5);
    },
  },
};

/** Camera-following weather particles (world space, wrapped around the view). */
export class WeatherSystem {
  private drops: Drop[] = [];
  private kind: Weather = "none";
  private fading: Drop[] = [];
  private fadeT = 0;
  private time = 0;
  private readonly rand = Math.random;
  private readonly haze: Phaser.GameObjects.Image;

  constructor(
    private readonly scene: Phaser.Scene,
    initial: Weather,
    private readonly reducedMotion: () => boolean,
  ) {
    this.haze = scene.add.image(0, 0, "white").setDepth(DEPTH.weather - 1).setAlpha(0).setVisible(false);
    this.set(initial, 0, 0, 1000, 1000);
  }

  set(kind: Weather, cx: number, cy: number, w: number, h: number) {
    if (kind === this.kind && this.drops.length) return;
    for (const d of this.fading) d.img.destroy();
    this.fading = this.drops;
    this.fadeT = 1.5;
    this.drops = [];
    this.kind = kind;
    if (kind === "none") return;
    const kit = KITS[kind];
    const n = Math.round(kit.count * (this.reducedMotion() ? 0.5 : 1));
    for (let i = 0; i < n; i++) {
      const img = this.scene.add.image(0, 0, kit.key).setDepth(DEPTH.weather).setTint(kit.color).setAlpha(0);
      if (kit.additive) img.setBlendMode(Phaser.BlendModes.ADD);
      const d: Drop = { img, x: cx + (this.rand() - 0.5) * w, y: cy + (this.rand() - 0.5) * h, vx: 0, vy: 0, phase: this.rand() * 10, s: 1 };
      kit.init(d, this.rand);
      img.setScale(d.s);
      if (kind === "rain" || kind === "sandstorm") img.setRotation(Math.atan2(d.vy, d.vx) - (kind === "rain" ? Math.PI / 2 : 0));
      this.drops.push(d);
    }
  }

  update(dt: number, cx: number, cy: number, w: number, h: number) {
    this.time += dt;
    const kit = this.kind === "none" ? null : KITS[this.kind];
    const hw = w / 2 + 40;
    const hh = h / 2 + 40;
    const fadeIn = Math.min(1, 1.5 - Math.max(0, this.fadeT));
    if (kit) {
      for (const d of this.drops) {
        d.x += d.vx * dt;
        d.y += d.vy * dt;
        kit.step(d, dt, this.time, this.rand);
        // wrap around the view rectangle
        if (d.x < cx - hw) d.x += hw * 2;
        else if (d.x > cx + hw) d.x -= hw * 2;
        if (d.y < cy - hh) d.y += hh * 2;
        else if (d.y > cy + hh) d.y -= hh * 2;
        d.img.setPosition(d.x, d.y);
        if (this.kind !== "embers" && this.kind !== "static") d.img.setAlpha(kit.alpha * fadeIn);
      }
    }
    if (this.fadeT > 0) {
      this.fadeT -= dt;
      const a = Math.max(0, this.fadeT / 1.5);
      for (const d of this.fading) {
        d.x += d.vx * dt;
        d.y += d.vy * dt;
        d.img.setPosition(d.x, d.y).setAlpha(d.img.alpha * a);
      }
      if (this.fadeT <= 0) {
        for (const d of this.fading) d.img.destroy();
        this.fading = [];
      }
    }
    // sandstorm / static haze
    const hazeA = this.kind === "sandstorm" ? 0.16 : this.kind === "static" ? 0.04 + Math.random() * 0.04 : 0;
    this.haze.setVisible(hazeA > 0);
    if (hazeA > 0) {
      this.haze.setPosition(cx, cy).setDisplaySize(w * 1.2, h * 1.2).setTint(this.kind === "sandstorm" ? 0xd9a441 : 0xffffff).setAlpha(hazeA * fadeIn);
    }
  }

  destroy() {
    for (const d of this.drops) d.img.destroy();
    for (const d of this.fading) d.img.destroy();
    this.drops = [];
    this.fading = [];
    this.haze.destroy();
  }
}
