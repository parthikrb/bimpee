/** Pure aiming math: crosshair ray -> ground, and soft aim assist. */

/**
 * Intersects the ray o + t*d with the horizontal plane y = planeY.
 * Returns t (>0) or -1 when the ray is parallel or points away.
 */
export function rayPlaneY(oy: number, dy: number, planeY: number): number {
  if (!Number.isFinite(oy) || !Number.isFinite(dy) || Math.abs(dy) < 1e-6) return -1;
  const t = (planeY - oy) / dy;
  return t > 0 && Number.isFinite(t) ? t : -1;
}

export interface AimTarget {
  active: boolean;
  x: number;
  y: number;
  r: number;
  spawnT: number;
  alpha: number;
}

export interface AimAssistOptions {
  /** half-angle of the assist cone (radians) */
  cone: number;
  /** ignore enemies farther than this (sim px) */
  maxDist: number;
  /** 0..1, how far the aim bends towards the chosen target */
  strength: number;
}

export interface AimResult {
  angle: number;
  dist: number;
  /** index into the list, -1 when no assist was applied */
  target: number;
}

export const DEFAULT_ASSIST: AimAssistOptions = { cone: 0.14, maxDist: 760, strength: 0.65 };

/**
 * Picks the best enemy inside a cone around the raw aim and bends the aim
 * towards it. Score favours small angular error first, distance second.
 * Allocation-free when `out` is supplied.
 */
export function aimAssist(
  px: number,
  py: number,
  aim: number,
  aimDist: number,
  list: readonly AimTarget[],
  opts: AimAssistOptions = DEFAULT_ASSIST,
  out: AimResult = { angle: 0, dist: 0, target: -1 },
): AimResult {
  out.angle = aim;
  out.dist = aimDist;
  out.target = -1;
  if (!Number.isFinite(aim) || !(opts.cone > 0)) return out;
  let best = Infinity;
  let bestA = 0;
  let bestD = 0;
  const max2 = opts.maxDist * opts.maxDist;
  for (let i = 0; i < list.length; i++) {
    const e = list[i]!;
    if (!e.active || e.spawnT > 0.3 || e.alpha < 0.3) continue;
    const dx = e.x - px;
    const dy = e.y - py;
    const d2 = dx * dx + dy * dy;
    if (d2 > max2 || d2 < 1) continue;
    const d = Math.sqrt(d2);
    const a = Math.atan2(dy, dx);
    let da = a - aim;
    da -= Math.round(da / (Math.PI * 2)) * Math.PI * 2;
    // widen the cone by the enemy's angular radius so big targets are easier to catch
    const allowance = opts.cone + Math.atan2(e.r, d);
    const ada = Math.abs(da);
    if (ada > allowance) continue;
    const score = ada / allowance + (d / opts.maxDist) * 0.35;
    if (score < best) {
      best = score;
      bestA = da;
      bestD = d;
      out.target = i;
    }
  }
  if (out.target >= 0) {
    out.angle = aim + bestA * Math.max(0, Math.min(1, opts.strength));
    out.dist = bestD;
  }
  return out;
}
