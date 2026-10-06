/**
 * Sim <-> three.js coordinate mapping. Pure (no three import) so it is
 * testable in node.
 *
 * The Sim lives on a 2D ground plane in pixels (x right, y "down" on the old
 * 2D screen). three.js is y-up: sim (x, y) -> three (x * S, height, y * S).
 * A sim angle `a` (atan2(dy, dx)) points along three (cos a, 0, sin a); a
 * model built facing +X therefore needs rotation.y = -a.
 */

/** world units per sim pixel (one 64px tile = 2 units) */
export const S = 1 / 32;
/** height of arena walls in world units */
export const WALL_H = 2.6;
/** height above the floor where bullets fly and the crosshair ray is cast */
export const SHOT_H = 0.55;

export const toWorld = (px: number) => px * S;
export const toSim = (u: number) => u / S;

/** three.js rotation.y for a +X-facing model that should face sim angle `a`. */
export const yawFromSimAngle = (a: number) => -a;

/** Sim angle for a three.js direction on the ground plane. */
export const simAngleFromDir = (dx: number, dz: number) => Math.atan2(dz, dx);

/**
 * The Sim derives its off-screen spawn ring from the visible view size
 * (ring = clamp(hypot(viewW, viewH) / 2 + 60, 420, 1400)). In 3D there is no
 * rectangle, so we feed a square "view" whose ring lands at `ringPx`.
 */
export function spawnViewForRing(ringPx: number): { viewW: number; viewH: number } {
  const half = Math.max(1, ringPx - 60);
  const side = half * Math.SQRT2;
  return { viewW: side, viewH: side };
}
