/** Pure threat-indicator math (screen-edge arrows, rear danger). */

export interface EdgePoint {
  x: number;
  y: number;
  /** screen-space angle of the arrow (radians, 0 = right, y down) */
  angle: number;
}

/**
 * Takes a point in clip space (x, y, w) and returns false when it is visible
 * on screen (inside the inset rectangle). Otherwise writes the clamped edge
 * position and arrow angle into `out` and returns true. Points behind the
 * camera (w <= 0) are mirrored so the arrow points the right way.
 */
export function edgeIndicator(cx: number, cy: number, cw: number, width: number, height: number, margin: number, out: EdgePoint): boolean {
  if (![cx, cy, cw].every(Number.isFinite) || !(width > 0) || !(height > 0)) return false;
  let nx: number;
  let ny: number;
  const behind = cw <= 1e-5;
  if (behind) {
    const w = Math.max(1e-5, Math.abs(cw));
    nx = -cx / w;
    ny = -cy / w;
    // straight behind: point down (towards the viewer's back)
    if (Math.abs(nx) < 1e-3 && Math.abs(ny) < 1e-3) ny = -1;
    // make sure it lands outside the screen
    const m = Math.max(Math.abs(nx), Math.abs(ny));
    if (m < 1.5) {
      nx *= 1.5 / Math.max(1e-3, m);
      ny *= 1.5 / Math.max(1e-3, m);
    }
  } else {
    nx = cx / cw;
    ny = cy / cw;
    if (Math.abs(nx) <= 1 && Math.abs(ny) <= 1) return false;
  }
  // screen px relative to centre (y down)
  const sx = (nx * width) / 2;
  const sy = (-ny * height) / 2;
  const a = Math.atan2(sy, sx);
  const hw = Math.max(1, width / 2 - margin);
  const hh = Math.max(1, height / 2 - margin);
  const s = Math.min(hw / Math.max(1e-6, Math.abs(Math.cos(a))), hh / Math.max(1e-6, Math.abs(Math.sin(a))));
  out.x = width / 2 + Math.cos(a) * s;
  out.y = height / 2 + Math.sin(a) * s;
  out.angle = a;
  return true;
}

/**
 * How crowded the space behind the player is (0..1): enemies within `radius`
 * sim px whose direction is more than 100deg away from the camera yaw,
 * weighted by closeness. `full` enemies saturate the value.
 */
export function rearThreat(
  px: number,
  py: number,
  yaw: number,
  list: readonly { active: boolean; x: number; y: number; spawnT: number }[],
  radius: number,
  full = 6,
): number {
  const fx = Math.cos(yaw);
  const fy = Math.sin(yaw);
  const cosLimit = Math.cos((100 * Math.PI) / 180);
  const r2 = radius * radius;
  let acc = 0;
  for (let i = 0; i < list.length; i++) {
    const e = list[i]!;
    if (!e.active || e.spawnT > 0.2) continue;
    const dx = e.x - px;
    const dy = e.y - py;
    const d2 = dx * dx + dy * dy;
    if (d2 > r2 || d2 < 1) continue;
    const d = Math.sqrt(d2);
    if ((dx * fx + dy * fy) / d > cosLimit) continue;
    acc += 1 - d / radius * 0.6;
  }
  return Math.max(0, Math.min(1, acc / full));
}
