import { createRng } from "@bimpee/shared";
import type { CitySpec } from "@bimpee/shared/city";
import { clamp01, smoothstep } from "./rand";

/**
 * Seeded terrain generation. Heights are per vertex ((size+1)^2) in tile
 * units; a tile whose mean corner height is below `waterLevel` is water.
 */
export interface Terrain {
  size: number;
  heights: Float32Array;
  waterLevel: number;
  /** size^2 forest density 0..255 at generation time */
  forest: Uint8Array;
}

/** 2D value noise with a seeded lattice; fbm on top. */
class ValueNoise {
  private perm = new Uint16Array(512);
  private vals = new Float32Array(256);
  constructor(seed: number) {
    const rng = createRng(seed);
    const p = rng.shuffle(Array.from({ length: 256 }, (_, i) => i));
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255]!;
    for (let i = 0; i < 256; i++) this.vals[i] = rng.next();
  }
  private lat(ix: number, iy: number) {
    return this.vals[this.perm[(this.perm[ix & 255]! + iy) & 511]! & 255]!;
  }
  noise(x: number, y: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = this.lat(ix, iy);
    const b = this.lat(ix + 1, iy);
    const c = this.lat(ix, iy + 1);
    const d = this.lat(ix + 1, iy + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }
  /** 0..1 */
  fbm(x: number, y: number, octaves = 4): number {
    let amp = 0.5;
    let f = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      // per-octave offset + skew so lattice lines of different octaves don't align
      sum += amp * this.noise(x * f + o * 17.31 + 0.37 + y * f * 0.21, y * f + o * 9.73 + 0.61 - x * f * 0.17);
      norm += amp;
      amp *= 0.5;
      f *= 2;
    }
    return sum / norm;
  }
}

/** distance from (px,py) to a polyline given as arrays of points */
function distToPolyline(px: number, py: number, xs: number[], ys: number[]): number {
  let best = Infinity;
  for (let i = 0; i < xs.length - 1; i++) {
    const ax = xs[i]!;
    const ay = ys[i]!;
    const bx = xs[i + 1]!;
    const by = ys[i + 1]!;
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy || 1;
    const t = clamp01(((px - ax) * dx + (py - ay) * dy) / l2);
    const ex = ax + dx * t - px;
    const ey = ay + dy * t - py;
    const d = ex * ex + ey * ey;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Winding channel that runs top-to-bottom (or left-to-right) and keeps clear of the centre. */
function windingChannel(rng: ReturnType<typeof createRng>, size: number, minOffset: number) {
  const vertical = rng.chance(0.5);
  const side = rng.chance(0.5) ? 1 : -1;
  const phase = rng.range(0, Math.PI * 2);
  const amp = size * 0.06;
  const xs: number[] = [];
  const ys: number[] = [];
  const c = size / 2;
  for (let i = 0; i <= 32; i++) {
    const t = i / 32;
    const along = -2 + t * (size + 4);
    const across = c + side * (minOffset + amp + amp * Math.sin(phase + t * Math.PI * 2.2));
    if (vertical) {
      xs.push(across);
      ys.push(along);
    } else {
      xs.push(along);
      ys.push(across);
    }
  }
  return { xs, ys };
}

export function generateTerrain(spec: CitySpec): Terrain {
  const size = spec.terrain.size;
  const V = size + 1;
  const rough = clamp01(spec.terrain.roughness);
  const wlNorm = clamp01(spec.terrain.waterLevel);
  const rng = createRng((spec.seed ^ 0x5eed1234) >>> 0);
  const noise = new ValueNoise(rng.int(0, 2 ** 30));
  const detail = new ValueNoise(rng.int(0, 2 ** 30));
  const forestNoise = new ValueNoise(rng.int(0, 2 ** 30));
  const hmax = 3 + 5 * rough;
  /** normalized sea threshold */
  const sea = 0.2 + 0.3 * wlNorm;
  const waterLevel = sea * hmax;
  const scale = 4 / 64; // noise features per tile
  const c = size / 2;
  const flatR = size * 0.17;
  const kind = spec.terrain.kind;

  // kind-specific setup
  const channel = kind === "river_valley" || kind === "canyon" ? windingChannel(rng, size, flatR * 1.35) : null;
  const coastAngle = rng.range(0, Math.PI * 2);
  const islands: { x: number; y: number; r: number }[] = [];
  if (kind === "archipelago") {
    islands.push({ x: c, y: c, r: size * 0.22 });
    const n = rng.int(4, 6);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
      const d = size * rng.range(0.3, 0.4);
      islands.push({ x: c + Math.cos(a) * d, y: c + Math.sin(a) * d, r: size * rng.range(0.09, 0.15) });
    }
  }

  const e = new Float32Array(V * V);
  for (let y = 0; y < V; y++) {
    for (let x = 0; x < V; x++) {
      const n = noise.fbm(x * scale, y * scale, 4);
      const d = detail.fbm(x * scale * 3, y * scale * 3, 3) - 0.5;
      const dx = (x - c) / size;
      const dy = (y - c) / size;
      const r = Math.sqrt(dx * dx + dy * dy); // 0 centre .. ~0.7 corners
      let h: number;
      switch (kind) {
        case "island":
          h = 0.25 + 0.5 * n + 0.55 * (1 - smoothstep(0.18, 0.47, r)) - 0.6 * smoothstep(0.38, 0.55, r);
          break;
        case "river_valley":
          h = 0.4 + 0.45 * n + 0.3 * smoothstep(0.15, 0.6, r);
          break;
        case "coastal": {
          // t: 0 on the sea side .. 1 inland
          const t = 0.5 + (dx * Math.cos(coastAngle) + dy * Math.sin(coastAngle));
          h = 0.05 + 0.75 * smoothstep(0.08, 0.5, t) + 0.35 * (n - 0.5) + 0.2 * smoothstep(0.6, 1, t);
          break;
        }
        case "plateau": {
          const m = noise.fbm(x * scale * 0.8 + 37, y * scale * 0.8 + 11, 2);
          h = 0.42 + 0.3 * (n - 0.5) + 0.38 * smoothstep(0.55, 0.6, m);
          break;
        }
        case "archipelago": {
          let best = 0;
          for (const isl of islands) {
            const ix = (x - isl.x) / isl.r;
            const iy = (y - isl.y) / isl.r;
            const q = Math.exp(-(ix * ix + iy * iy) * 1.1);
            if (q > best) best = q;
          }
          h = 0.1 + 0.75 * best + 0.3 * (n - 0.5);
          break;
        }
        case "canyon":
          h = 0.72 + 0.25 * (n - 0.5);
          break;
      }
      h += d * 0.25 * rough;
      if (channel) {
        const dc = distToPolyline(x, y, channel.xs, channel.ys);
        if (kind === "river_valley") {
          const bed = sea - 0.08;
          const w = smoothstep(1.6, 6, dc);
          h = bed + (h - bed) * w;
        } else {
          const floor = sea - 0.06;
          const w = smoothstep(3.5, 5.5, dc); // steep walls
          h = floor + (h - floor) * w;
        }
      }
      // buildable, flat-ish, dry centre
      const dcen = Math.sqrt((x - c) ** 2 + (y - c) ** 2);
      const flatH = Math.max(sea + 0.12, kind === "canyon" ? 0.72 : kind === "plateau" ? 0.45 : sea + 0.12);
      const wFlat = 1 - smoothstep(flatR * 0.75, flatR * 1.5, dcen);
      h = h + (flatH + (h - flatH) * 0.15 - h) * wFlat;
      e[y * V + x] = h;
    }
  }
  const heights = new Float32Array(V * V);
  for (let i = 0; i < V * V; i++) heights[i] = Math.max(0, e[i]!) * hmax;

  // forest
  const forest = new Uint8Array(size * size);
  const fAmount = clamp01(spec.terrain.forest);
  if (fAmount > 0) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const h = tileHeightOf(heights, size, x, y);
        if (h < waterLevel + 0.15) continue;
        const dcen = Math.sqrt((x + 0.5 - c) ** 2 + (y + 0.5 - c) ** 2);
        if (dcen < flatR * 0.85) continue;
        const f = forestNoise.fbm(x * scale * 2, y * scale * 2, 3);
        const dens = clamp01((f - (1 - fAmount) * 0.75 - 0.15) * 3.5);
        forest[y * size + x] = Math.round(dens * 255);
      }
    }
  }
  return { size, heights, waterLevel, forest };
}

export function tileHeightOf(heights: Float32Array, size: number, x: number, y: number): number {
  const V = size + 1;
  const i = y * V + x;
  return (heights[i]! + heights[i + 1]! + heights[i + V]! + heights[i + V + 1]!) * 0.25;
}

export function tileSlopeOf(heights: Float32Array, size: number, x: number, y: number): number {
  const V = size + 1;
  const i = y * V + x;
  const a = heights[i]!;
  const b = heights[i + 1]!;
  const c = heights[i + V]!;
  const d = heights[i + V + 1]!;
  return Math.max(a, b, c, d) - Math.min(a, b, c, d);
}

/** Threshold of forest density above which a tile starts as TileKind.Forest. */
export const FOREST_TILE_MIN = 90;
