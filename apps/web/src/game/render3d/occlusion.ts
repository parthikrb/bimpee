/**
 * Pure camera collision / occlusion math against the tile grid.
 * Positions are sim pixels on the ground plane plus a height in world units.
 */

export interface WallGrid {
  cols: number;
  rows: number;
  tile: number;
  solid: Uint8Array;
}

const isSolid = (g: WallGrid, c: number, r: number) => c >= 0 && r >= 0 && c < g.cols && r < g.rows && g.solid[r * g.cols + c] === 1;

/**
 * Walks the grid cells crossed by segment A->B (Amanatides & Woo) and returns
 * the parameter t in [0,1] where the segment first enters a solid cell while
 * its height is below `wallTop`. Returns 1 when the segment is clear.
 * The starting cell is ignored (the player can never stand inside a wall,
 * but its collision circle may poke into a neighbour's corner).
 */
export function segmentBlockedT(g: WallGrid, ax: number, ay: number, ah: number, bx: number, by: number, bh: number, wallTop: number): number {
  if (![ax, ay, ah, bx, by, bh].every(Number.isFinite)) return 1;
  const T = g.tile;
  const dx = bx - ax;
  const dy = by - ay;
  let c = Math.floor(ax / T);
  let r = Math.floor(ay / T);
  const c1 = Math.floor(bx / T);
  const r1 = Math.floor(by / T);
  const stepC = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepR = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const tDeltaC = stepC !== 0 ? Math.abs(T / dx) : Infinity;
  const tDeltaR = stepR !== 0 ? Math.abs(T / dy) : Infinity;
  let tMaxC = stepC > 0 ? ((c + 1) * T - ax) / dx : stepC < 0 ? (c * T - ax) / dx : Infinity;
  let tMaxR = stepR > 0 ? ((r + 1) * T - ay) / dy : stepR < 0 ? (r * T - ay) / dy : Infinity;
  const heightAt = (t: number) => ah + (bh - ah) * t;
  let guard = 0;
  while ((c !== c1 || r !== r1) && guard++ < 4096) {
    let tEnter: number;
    if (tMaxC < tMaxR) {
      tEnter = tMaxC;
      tMaxC += tDeltaC;
      c += stepC;
    } else {
      tEnter = tMaxR;
      tMaxR += tDeltaR;
      r += stepR;
    }
    if (tEnter > 1) break;
    if (isSolid(g, c, r)) {
      const tExit = Math.min(1, tMaxC, tMaxR);
      if (Math.min(heightAt(tEnter), heightAt(tExit)) < wallTop) return Math.max(0, tEnter);
    }
  }
  return 1;
}

/**
 * Distance the chase camera may sit from its target without entering a wall:
 * casts from the target to the desired camera position and pulls in by
 * `margin` (world units) from the hit. Never shorter than `minDist`.
 */
export function cameraClearDistance(
  g: WallGrid,
  scale: number,
  tx: number,
  ty: number,
  th: number,
  camX: number,
  camY: number,
  camH: number,
  wallTop: number,
  margin: number,
  minDist: number,
): number {
  const full = Math.hypot((camX - tx) * scale, (camY - ty) * scale, camH - th);
  if (!(full > 0)) return 0;
  // pad the wall a little so the near plane never clips through the face
  const t = segmentBlockedT(g, tx, ty, th, camX, camY, camH, wallTop + margin);
  if (t >= 1) return full;
  return Math.max(Math.min(minDist, full), t * full - margin);
}
