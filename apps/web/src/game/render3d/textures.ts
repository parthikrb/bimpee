import * as THREE from "three";
import type { Bag } from "./bag";

/** Procedural canvas textures (white masks, tinted by materials). */
export type TexKind = "glow" | "ring" | "dot" | "spark" | "smoke" | "scorch" | "puddle" | "chevron" | "disc" | "softring";

function canvas(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  if (ctx) draw(ctx, size);
  return c;
}

function radial(ctx: CanvasRenderingContext2D, s: number, stops: [number, string][]) {
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  for (const [o, c] of stops) g.addColorStop(o, c);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
}

// deterministic tiny rng for texture noise
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DRAW: Record<TexKind, (ctx: CanvasRenderingContext2D, s: number) => void> = {
  glow: (ctx, s) =>
    radial(ctx, s, [
      [0, "rgba(255,255,255,1)"],
      [0.18, "rgba(255,255,255,0.75)"],
      [0.45, "rgba(255,255,255,0.22)"],
      [1, "rgba(255,255,255,0)"],
    ]),
  dot: (ctx, s) =>
    radial(ctx, s, [
      [0, "rgba(255,255,255,1)"],
      [0.55, "rgba(255,255,255,1)"],
      [0.75, "rgba(255,255,255,0.35)"],
      [1, "rgba(255,255,255,0)"],
    ]),
  disc: (ctx, s) =>
    radial(ctx, s, [
      [0, "rgba(255,255,255,0.55)"],
      [0.8, "rgba(255,255,255,0.75)"],
      [0.92, "rgba(255,255,255,1)"],
      [1, "rgba(255,255,255,0)"],
    ]),
  ring: (ctx, s) => {
    radial(ctx, s, [
      [0, "rgba(255,255,255,0)"],
      [0.78, "rgba(255,255,255,0)"],
      [0.88, "rgba(255,255,255,1)"],
      [0.95, "rgba(255,255,255,0.6)"],
      [1, "rgba(255,255,255,0)"],
    ]);
  },
  softring: (ctx, s) => {
    radial(ctx, s, [
      [0, "rgba(255,255,255,0)"],
      [0.5, "rgba(255,255,255,0.05)"],
      [0.85, "rgba(255,255,255,0.8)"],
      [0.93, "rgba(255,255,255,0.4)"],
      [1, "rgba(255,255,255,0)"],
    ]);
  },
  spark: (ctx, s) => {
    const g = ctx.createLinearGradient(0, 0, s, 0);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.7, "rgba(255,255,255,0.9)");
    g.addColorStop(1, "rgba(255,255,255,1)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(s / 2, s / 2, s / 2, s * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();
    const v = ctx.createLinearGradient(0, 0, 0, s);
    v.addColorStop(0, "rgba(0,0,0,1)");
    v.addColorStop(0.5, "rgba(0,0,0,0)");
    v.addColorStop(1, "rgba(0,0,0,1)");
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, s, s);
  },
  smoke: (ctx, s) => {
    const r = rng(7);
    for (let i = 0; i < 14; i++) {
      const x = s * (0.3 + r() * 0.4);
      const y = s * (0.3 + r() * 0.4);
      const rr = s * (0.15 + r() * 0.2);
      const g = ctx.createRadialGradient(x, y, 0, x, y, rr);
      g.addColorStop(0, "rgba(255,255,255,0.35)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    }
  },
  scorch: (ctx, s) => {
    const r = rng(11);
    radial(ctx, s, [
      [0, "rgba(255,255,255,0.95)"],
      [0.5, "rgba(255,255,255,0.7)"],
      [1, "rgba(255,255,255,0)"],
    ]);
    ctx.globalCompositeOperation = "destination-out";
    for (let i = 0; i < 40; i++) {
      const a = r() * Math.PI * 2;
      const d = s * (0.25 + r() * 0.25);
      ctx.beginPath();
      ctx.arc(s / 2 + Math.cos(a) * d, s / 2 + Math.sin(a) * d, s * (0.03 + r() * 0.08), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0,0,0,${0.3 + r() * 0.5})`;
      ctx.fill();
    }
  },
  puddle: (ctx, s) => {
    const r = rng(5);
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    for (let i = 0; i < 9; i++) {
      const a = r() * Math.PI * 2;
      const d = s * r() * 0.16;
      ctx.beginPath();
      ctx.arc(s / 2 + Math.cos(a) * d, s / 2 + Math.sin(a) * d, s * (0.24 + r() * 0.1), 0, Math.PI * 2);
      ctx.fill();
    }
    // bright rim via shrink-and-cut
    ctx.globalCompositeOperation = "source-atop";
    radial(ctx, s, [
      [0, "rgba(255,255,255,0.5)"],
      [0.6, "rgba(255,255,255,0.65)"],
      [0.85, "rgba(255,255,255,1)"],
      [1, "rgba(255,255,255,1)"],
    ]);
  },
  chevron: (ctx, s) => {
    // arrow pointing +x (u), used for charge telegraphs along the ground
    ctx.fillStyle = "rgba(255,255,255,1)";
    for (let i = 0; i < 4; i++) {
      const x0 = s * (0.05 + i * 0.24);
      ctx.globalAlpha = 0.35 + i * 0.2;
      ctx.beginPath();
      ctx.moveTo(x0, s * 0.15);
      ctx.lineTo(x0 + s * 0.14, s * 0.5);
      ctx.lineTo(x0, s * 0.85);
      ctx.lineTo(x0 + s * 0.07, s * 0.85);
      ctx.lineTo(x0 + s * 0.21, s * 0.5);
      ctx.lineTo(x0 + s * 0.07, s * 0.15);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  },
};

/** Lazily creates and caches textures; all are owned by the bag. */
export class TextureKit {
  private readonly cache = new Map<TexKind, THREE.Texture>();
  constructor(private readonly bag: Bag) {}

  get(kind: TexKind): THREE.Texture {
    let t = this.cache.get(kind);
    if (!t) {
      const tex = new THREE.CanvasTexture(canvas(kind === "spark" || kind === "chevron" ? 128 : 128, DRAW[kind]));
      tex.colorSpace = THREE.NoColorSpace;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      if (kind === "chevron") tex.wrapS = THREE.RepeatWrapping;
      t = this.bag.track(tex);
      this.cache.set(kind, t);
    }
    return t;
  }
}

/** Text on a canvas texture (labels, damage numbers). */
export function textCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D | null } {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return { canvas: c, ctx: c.getContext("2d") };
}
