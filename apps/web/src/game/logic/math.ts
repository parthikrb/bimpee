/** Small, allocation-free math helpers shared by the simulation and renderer. Phaser-free. */

export const TAU = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number) => clamp(Number.isFinite(v) ? v : 0, 0, 1);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const finiteOr = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);

export const dist2 = (ax: number, ay: number, bx: number, by: number) => {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
};

/** Squared distance from point P to segment AB. */
export function segPointDist2(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  let t = len2 > 1e-9 ? ((px - ax) * abx + (py - ay) * aby) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + abx * t - px;
  const cy = ay + aby * t - py;
  return cx * cx + cy * cy;
}

/** Shortest signed angle from a to b. */
export function angleDiff(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** "#rrggbb" -> 0xrrggbb, with a safe fallback for malformed input. */
export function hexToInt(hex: string, fallback = 0xffffff): number {
  if (typeof hex !== "string" || !/^#[0-9a-fA-F]{6}$/.test(hex)) return fallback;
  return parseInt(hex.slice(1), 16);
}

export const intToHex = (c: number) => `#${(c & 0xffffff).toString(16).padStart(6, "0")}`;

export function mixColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(lerp(ar, br, t));
  const g = Math.round(lerp(ag, bg, t));
  const bl = Math.round(lerp(ab, bb, t));
  return (r << 16) | (g << 8) | bl;
}

/** Relative luminance-ish brightness 0..1. */
export function brightness(c: number): number {
  return (((c >> 16) & 255) * 0.299 + ((c >> 8) & 255) * 0.587 + (c & 255) * 0.114) / 255;
}

/** 31-bit FNV hash of a string. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2_147_483_647;
}
