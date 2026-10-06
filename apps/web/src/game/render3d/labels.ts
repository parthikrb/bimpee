import * as THREE from "three";
import type { Bag } from "./bag";
import { textCanvas } from "./textures";

interface Num {
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  tex: THREE.CanvasTexture;
  ctx: CanvasRenderingContext2D | null;
  life: number;
  vy: number;
  base: number;
}

/** Pooled floating damage numbers (canvas text sprites). */
export class DamageNumbers {
  private readonly items: Num[] = [];
  private next = 0;

  constructor(bag: Bag, scene: THREE.Object3D, cap = 40) {
    for (let i = 0; i < cap; i++) {
      const { canvas, ctx } = textCanvas(128, 64);
      const tex = bag.track(new THREE.CanvasTexture(canvas));
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = bag.track(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, fog: false }));
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.renderOrder = 30;
      scene.add(sprite);
      this.items.push({ sprite, mat, tex, ctx, life: 0, vy: 0, base: 1 });
    }
  }

  spawn(x: number, y: number, z: number, amount: number, crit: boolean) {
    if (!this.items.length || !Number.isFinite(amount)) return;
    let it = this.items.find((i) => i.life <= 0);
    if (!it) {
      it = this.items[this.next]!;
      this.next = (this.next + 1) % this.items.length;
    }
    const v = amount >= 10 ? Math.round(amount) : Math.round(amount * 10) / 10;
    const ctx = it.ctx;
    if (ctx) {
      ctx.clearRect(0, 0, 128, 64);
      ctx.font = `900 ${crit ? 46 : 40}px ui-monospace, Menlo, Consolas, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";
      ctx.lineWidth = 9;
      ctx.strokeStyle = "rgba(0,0,0,0.9)";
      const s = crit ? `${v}!` : `${v}`;
      ctx.strokeText(s, 64, 34);
      ctx.fillStyle = crit ? "#ffd84a" : "#ffffff";
      ctx.fillText(s, 64, 34);
      it.tex.needsUpdate = true;
    }
    it.base = crit ? 1.35 : 0.95;
    it.sprite.position.set(x + (Math.random() - 0.5) * 0.5, y, z + (Math.random() - 0.5) * 0.5);
    it.sprite.scale.set(it.base * 2, it.base, 1);
    it.sprite.visible = true;
    it.mat.opacity = 1;
    it.life = 0.8;
    it.vy = 3.2;
  }

  update(dt: number) {
    for (const it of this.items) {
      if (it.life <= 0) continue;
      it.life -= dt;
      if (it.life <= 0) {
        it.sprite.visible = false;
        continue;
      }
      it.sprite.position.y += it.vy * dt;
      it.vy *= Math.exp(-3 * dt);
      it.mat.opacity = Math.min(1, it.life / 0.3);
      const pop = 1 + Math.max(0, it.life - 0.65) * 3;
      it.sprite.scale.set(it.base * 2 * pop, it.base * pop, 1);
    }
  }
}

/** A text label sprite (player names). */
export class NameLabel {
  readonly sprite: THREE.Sprite;
  private readonly tex: THREE.CanvasTexture;
  private readonly mat: THREE.SpriteMaterial;
  private text = "";

  constructor(
    text: string,
    private readonly color: string,
  ) {
    const { canvas } = textCanvas(256, 64);
    this.tex = new THREE.CanvasTexture(canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mat = new THREE.SpriteMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false, fog: false });
    this.sprite = new THREE.Sprite(this.mat);
    this.sprite.scale.set(3.2, 0.8, 1);
    this.sprite.renderOrder = 25;
    this.set(text);
  }

  set(text: string) {
    const t = String(text ?? "").slice(0, 24);
    if (t === this.text) return;
    this.text = t;
    const c = this.tex.image as HTMLCanvasElement;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, 256, 64);
    ctx.font = "700 30px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 7;
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.strokeText(t, 128, 34);
    ctx.fillStyle = this.color;
    ctx.fillText(t, 128, 34);
    this.tex.needsUpdate = true;
  }

  set opacity(v: number) {
    this.mat.opacity = v;
  }

  dispose() {
    this.sprite.removeFromParent();
    this.tex.dispose();
    this.mat.dispose();
  }
}
