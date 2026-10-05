import * as Phaser from "phaser";

/**
 * Immediate-mode image pool: call begin() each frame, take() per thing drawn,
 * end() hides whatever was not used. Images are created lazily and reused.
 */
export class ImagePool {
  private readonly items: Phaser.GameObjects.Image[] = [];
  private cursor = 0;
  private lastUsed = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly depth: number,
    private readonly blend: Phaser.BlendModes = Phaser.BlendModes.NORMAL,
    private readonly cap = 2000,
  ) {}

  begin() {
    this.cursor = 0;
  }

  take(key: string, x: number, y: number): Phaser.GameObjects.Image | null {
    if (this.cursor >= this.cap) return null;
    let img = this.items[this.cursor];
    if (!img) {
      img = this.scene.add.image(x, y, key);
      img.setDepth(this.depth);
      if (this.blend !== Phaser.BlendModes.NORMAL) img.setBlendMode(this.blend);
      this.items.push(img);
    } else if (img.texture.key !== key) {
      img.setTexture(key);
    }
    this.cursor++;
    img.setPosition(x, y);
    img.setVisible(true);
    img.setAlpha(1);
    img.setRotation(0);
    img.setScale(1);
    img.setTintMode(Phaser.TintModes.MULTIPLY);
    img.setTint(0xffffff);
    return img;
  }

  end() {
    for (let i = this.cursor; i < this.lastUsed; i++) this.items[i]!.setVisible(false);
    this.lastUsed = this.cursor;
  }

  destroy() {
    for (const i of this.items) i.destroy();
    this.items.length = 0;
  }
}

interface Particle {
  img: Phaser.GameObjects.Image;
  active: boolean;
  vx: number;
  vy: number;
  life: number;
  max: number;
  s0: number;
  s1: number;
  a0: number;
  drag: number;
  spin: number;
  faceVel: boolean;
}

export interface ParticleSpec {
  key: string;
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  life: number;
  scale0?: number;
  scale1?: number;
  alpha?: number;
  color?: number;
  rotation?: number;
  drag?: number;
  spin?: number;
  faceVel?: boolean;
  /** additive (default) or normal */
  additive?: boolean;
}

/** Pooled, allocation-free particle system on top of Images. */
export class Particles {
  private readonly list: Particle[] = [];
  private next = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly depth: number,
    private readonly cap = 700,
  ) {}

  spawn(s: ParticleSpec) {
    let p: Particle | undefined;
    if (this.list.length < this.cap) {
      const img = this.scene.add.image(s.x, s.y, s.key).setDepth(this.depth);
      p = { img, active: false, vx: 0, vy: 0, life: 0, max: 1, s0: 1, s1: 0, a0: 1, drag: 0, spin: 0, faceVel: false };
      this.list.push(p);
    } else {
      // recycle round-robin (oldest-ish)
      p = this.list[this.next]!;
      this.next = (this.next + 1) % this.list.length;
    }
    const img = p.img;
    if (img.texture.key !== s.key) img.setTexture(s.key);
    img.setBlendMode(s.additive === false ? Phaser.BlendModes.NORMAL : Phaser.BlendModes.ADD);
    img.setPosition(s.x, s.y);
    img.setVisible(true);
    img.setTintMode(Phaser.TintModes.MULTIPLY);
    img.setTint(s.color ?? 0xffffff);
    img.setRotation(s.rotation ?? 0);
    p.active = true;
    p.vx = s.vx ?? 0;
    p.vy = s.vy ?? 0;
    p.life = p.max = Math.max(0.01, s.life);
    p.s0 = s.scale0 ?? 1;
    p.s1 = s.scale1 ?? 0;
    p.a0 = s.alpha ?? 1;
    p.drag = s.drag ?? 3;
    p.spin = s.spin ?? 0;
    p.faceVel = !!s.faceVel;
    img.setScale(p.s0);
    img.setAlpha(p.a0);
  }

  update(dt: number) {
    for (const p of this.list) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        p.img.setVisible(false);
        continue;
      }
      const k = 1 - p.life / p.max;
      const drag = Math.exp(-p.drag * dt);
      p.vx *= drag;
      p.vy *= drag;
      const img = p.img;
      img.x += p.vx * dt;
      img.y += p.vy * dt;
      img.setScale(p.s0 + (p.s1 - p.s0) * k);
      img.setAlpha(p.a0 * (1 - k * k));
      if (p.faceVel) img.setRotation(Math.atan2(p.vy, p.vx));
      else if (p.spin) img.rotation += p.spin * dt;
    }
  }

  destroy() {
    for (const p of this.list) p.img.destroy();
    this.list.length = 0;
  }
}

/** Pooled floating damage numbers. */
export class DamageNumbers {
  private readonly items: { t: Phaser.GameObjects.Text; life: number; vy: number; active: boolean }[] = [];
  private next = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly depth: number,
    private readonly cap = 48,
  ) {}

  spawn(x: number, y: number, amount: number, crit: boolean) {
    let it = this.items.find((i) => !i.active);
    if (!it) {
      if (this.items.length < this.cap) {
        const t = this.scene.add
          .text(x, y, "", {
            fontFamily: "ui-monospace, Menlo, Consolas, monospace",
            fontSize: "16px",
            fontStyle: "bold",
            color: "#ffffff",
            stroke: "#000000",
            strokeThickness: 4,
          })
          .setOrigin(0.5)
          .setDepth(this.depth);
        it = { t, life: 0, vy: 0, active: false };
        this.items.push(it);
      } else {
        it = this.items[this.next]!;
        this.next = (this.next + 1) % this.items.length;
      }
    }
    const v = amount >= 10 ? Math.round(amount) : Math.round(amount * 10) / 10;
    it.t.setText(crit ? `${v}!` : `${v}`);
    it.t.setColor(crit ? "#ffd84a" : "#ffffff");
    it.t.setScale(crit ? 1.35 : 1);
    it.t.setPosition(x + (Math.random() - 0.5) * 16, y);
    it.t.setVisible(true);
    it.t.setAlpha(1);
    it.life = 0.75;
    it.vy = -70;
    it.active = true;
  }

  update(dt: number) {
    for (const it of this.items) {
      if (!it.active) continue;
      it.life -= dt;
      if (it.life <= 0) {
        it.active = false;
        it.t.setVisible(false);
        continue;
      }
      it.t.y += it.vy * dt;
      it.vy *= Math.exp(-3 * dt);
      it.t.setAlpha(Math.min(1, it.life / 0.3));
    }
  }

  destroy() {
    for (const it of this.items) it.t.destroy();
    this.items.length = 0;
  }
}
