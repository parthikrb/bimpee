import type * as Phaser from "phaser";
import { createRng, type Palette } from "@bimpee/shared";
import { canvasTexture } from "../fx/textures";
import type { GameMap } from "../logic/mapgen";
import { hexToInt, intToHex, mixColor } from "../logic/math";

const CHUNK = 1024;

/**
 * Bakes the static map (floor pattern, pools, walls with glowing edges) into
 * a few large canvas textures, so the whole level costs a handful of draws.
 */
export class MapRenderer {
  private readonly images: Phaser.GameObjects.Image[] = [];
  private readonly keys: string[] = [];

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly map: GameMap,
    private readonly palette: Palette,
    private readonly seed: number,
  ) {
    this.bake();
  }

  private bake() {
    const m = this.map;
    const cx = Math.ceil(m.width / CHUNK);
    const cy = Math.ceil(m.height / CHUNK);
    for (let j = 0; j < cy; j++)
      for (let i = 0; i < cx; i++) {
        const x0 = i * CHUNK;
        const y0 = j * CHUNK;
        // 2px overlap with the next chunk hides sampling seams between chunk images
        const w = Math.min(CHUNK + 2, m.width - x0);
        const h = Math.min(CHUNK + 2, m.height - y0);
        const key = `map_${i}_${j}`;
        const ok = canvasTexture(this.scene, key, w, h, (ctx) => this.drawChunk(ctx, x0, y0, w, h));
        if (!ok) continue;
        this.keys.push(key);
        const img = this.scene.add.image(x0, y0, key).setOrigin(0, 0).setDepth(0);
        this.images.push(img);
      }
  }

  private drawChunk(ctx: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number) {
    const m = this.map;
    const T = m.tile;
    const p = this.palette;
    const bg = hexToInt(p.background);
    const floor = hexToInt(p.floor);
    const wall = hexToInt(p.wall);
    const glow = hexToInt(p.glow);
    const accent = hexToInt(p.accent);
    ctx.save();
    ctx.translate(-x0, -y0);

    // floor
    ctx.fillStyle = p.floor;
    ctx.fillRect(x0, y0, w, h);

    // noise speckles (deterministic per chunk)
    const rng = createRng((this.seed ^ (x0 * 73856093) ^ (y0 * 19349663)) >>> 0);
    const light = intToHex(mixColor(floor, 0xffffff, 0.12));
    const dark = intToHex(mixColor(floor, bg, 0.6));
    for (let i = 0; i < (w * h) / 900; i++) {
      ctx.globalAlpha = 0.15 + rng.next() * 0.25;
      ctx.fillStyle = rng.next() < 0.5 ? light : dark;
      const s = 1 + rng.next() * 3;
      ctx.fillRect(x0 + rng.next() * w, y0 + rng.next() * h, s, s);
    }
    // soft blotches
    for (let i = 0; i < (w * h) / 60000; i++) {
      const bx = x0 + rng.next() * w;
      const by = y0 + rng.next() * h;
      const r = 60 + rng.next() * 160;
      const g = ctx.createRadialGradient(bx, by, 0, bx, by, r);
      g.addColorStop(0, rng.next() < 0.5 ? light : dark);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = g;
      ctx.fillRect(bx - r, by - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;

    // grid
    ctx.strokeStyle = intToHex(mixColor(floor, accent, 0.25));
    ctx.globalAlpha = 0.18;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.floor(x0 / T) * T; x <= x0 + w; x += T) {
      ctx.moveTo(x + 0.5, y0);
      ctx.lineTo(x + 0.5, y0 + h);
    }
    for (let y = Math.floor(y0 / T) * T; y <= y0 + h; y += T) {
      ctx.moveTo(x0, y + 0.5);
      ctx.lineTo(x0 + w, y + 0.5);
    }
    ctx.stroke();
    // grid dots at intersections
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = intToHex(mixColor(floor, accent, 0.4));
    for (let x = Math.floor(x0 / T) * T; x <= x0 + w; x += T * 2)
      for (let y = Math.floor(y0 / T) * T; y <= y0 + h; y += T * 2) ctx.fillRect(x - 1, y - 1, 3, 3);
    ctx.globalAlpha = 1;

    const c0 = Math.max(0, Math.floor(x0 / T) - 1);
    const c1 = Math.min(m.cols - 1, Math.ceil((x0 + w) / T) + 1);
    const r0 = Math.max(0, Math.floor(y0 / T) - 1);
    const r1 = Math.min(m.rows - 1, Math.ceil((y0 + h) / T) + 1);
    const solid = (c: number, r: number) => c < 0 || r < 0 || c >= m.cols || r >= m.rows || m.solid[r * m.cols + c] === 1;

    // pools (decorative dark water)
    const poolDeep = intToHex(mixColor(bg, 0x000000, 0.35));
    const poolEdge = intToHex(mixColor(bg, glow, 0.25));
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        if (!m.pool[r * m.cols + c]) continue;
        const px = c * T + T / 2;
        const py = r * T + T / 2;
        ctx.fillStyle = poolEdge;
        ctx.beginPath();
        ctx.arc(px, py, T * 0.78, 0, Math.PI * 2);
        ctx.fill();
      }
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        if (!m.pool[r * m.cols + c]) continue;
        const px = c * T + T / 2;
        const py = r * T + T / 2;
        ctx.fillStyle = poolDeep;
        ctx.beginPath();
        ctx.arc(px, py, T * 0.68, 0, Math.PI * 2);
        ctx.fill();
      }
    // ripples
    ctx.strokeStyle = intToHex(mixColor(bg, glow, 0.45));
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 1.5;
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        if (!m.pool[r * m.cols + c] || (c * 7 + r * 13) % 5) continue;
        ctx.beginPath();
        ctx.ellipse(c * T + T / 2, r * T + T / 2, 14, 6, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    ctx.globalAlpha = 1;

    // wall shadows on the floor
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) if (solid(c, r)) ctx.fillRect(c * T + 8, r * T + 10, T, T);

    // wall bodies
    const body = intToHex(mixColor(wall, bg, 0.72));
    const top = intToHex(mixColor(wall, bg, 0.55));
    const I = 7; // bevel inset, only on sides that face open floor (merged wall tops)
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        if (!solid(c, r)) continue;
        ctx.fillStyle = body;
        ctx.fillRect(c * T, r * T, T, T);
      }
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        if (!solid(c, r)) continue;
        const l = solid(c - 1, r) ? 0 : I;
        const rr = solid(c + 1, r) ? 0 : I;
        const tp = solid(c, r - 1) ? 0 : I;
        const b = solid(c, r + 1) ? 0 : I;
        ctx.fillStyle = top;
        ctx.fillRect(c * T + l, r * T + tp, T - l - rr, T - tp - b);
      }
    // inner hatch for deep wall
    ctx.strokeStyle = intToHex(mixColor(wall, bg, 0.6));
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        if (!solid(c, r)) continue;
        if (solid(c - 1, r) && solid(c + 1, r) && solid(c, r - 1) && solid(c, r + 1)) {
          ctx.moveTo(c * T + 10, r * T + T - 10);
          ctx.lineTo(c * T + T - 10, r * T + 10);
        }
      }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // glowing edges where wall meets floor
    ctx.save();
    ctx.shadowColor = p.glow;
    ctx.shadowBlur = 14;
    ctx.strokeStyle = p.wall;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        if (!solid(c, r)) continue;
        const x = c * T;
        const y = r * T;
        if (!solid(c, r - 1)) (ctx.moveTo(x, y + 1.5), ctx.lineTo(x + T, y + 1.5));
        if (!solid(c, r + 1)) (ctx.moveTo(x, y + T - 1.5), ctx.lineTo(x + T, y + T - 1.5));
        if (!solid(c - 1, r)) (ctx.moveTo(x + 1.5, y), ctx.lineTo(x + 1.5, y + T));
        if (!solid(c + 1, r)) (ctx.moveTo(x + T - 1.5, y), ctx.lineTo(x + T - 1.5, y + T));
      }
    ctx.stroke();
    ctx.stroke();
    ctx.restore();

    ctx.restore();
  }

  destroy() {
    for (const i of this.images) i.destroy();
    for (const k of this.keys) if (this.scene.textures.exists(k)) this.scene.textures.remove(k);
    this.images.length = 0;
    this.keys.length = 0;
  }
}
