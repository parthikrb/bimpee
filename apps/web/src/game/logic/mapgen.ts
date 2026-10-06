import { createRng, type Rng, type WorldSpec } from "@bimpee/shared";

/**
 * Deterministic tile map generation from a WorldSpec (seed + layout).
 * Pure: no rendering. The result is a solid/open grid plus decorative pools.
 *
 * Guarantees (unit tested):
 *  - same spec => same map
 *  - the spawn area around the centre is open
 *  - every open tile is 4-connected to the centre (no sealed regions)
 *  - the border ring is solid
 */
export const TILE = 64;
export const ARENA_PX = { small: 1800, medium: 2600, large: 3400 } as const;
export const CENTER_CLEAR_TILES = 5;

export interface GameMap {
  tile: number;
  cols: number;
  rows: number;
  width: number;
  height: number;
  /** 1 = wall */
  solid: Uint8Array;
  /** 1 = decorative dark pool (walkable) */
  pool: Uint8Array;
  spawnX: number;
  spawnY: number;
  kind: WorldSpec["layout"]["kind"];
}

type LayoutInput = Pick<WorldSpec, "seed" | "layout">;

export function generateMap(world: LayoutInput): GameMap {
  const rng = createRng((world.seed ^ 0x5bd1e995) >>> 0);
  const cols = Math.round(ARENA_PX[world.layout.size] / TILE);
  const rows = cols;
  const solid = new Uint8Array(cols * rows);
  const pool = new Uint8Array(cols * rows);
  const d = Math.min(1, Math.max(0, Number.isFinite(world.layout.density) ? world.layout.density : 0.3));
  const g: Grid = { cols, rows, solid, pool };

  switch (world.layout.kind) {
    case "arena":
      genArena(g, rng, d);
      break;
    case "caverns":
      genCaverns(g, rng, d);
      break;
    case "rooms":
      genRooms(g, rng, d);
      break;
    case "islands":
      genIslands(g, rng, d);
      break;
    case "maze":
      genMaze(g, rng, d);
      break;
  }

  // Solid border ring.
  for (let c = 0; c < cols; c++) {
    solid[c] = 1;
    solid[(rows - 1) * cols + c] = 1;
  }
  for (let r = 0; r < rows; r++) {
    solid[r * cols] = 1;
    solid[r * cols + cols - 1] = 1;
  }

  // Clear the spawn area.
  const cc = Math.floor(cols / 2);
  const cr = Math.floor(rows / 2);
  for (let r = cr - CENTER_CLEAR_TILES; r <= cr + CENTER_CLEAR_TILES; r++) {
    for (let c = cc - CENTER_CLEAR_TILES; c <= cc + CENTER_CLEAR_TILES; c++) {
      if (c <= 0 || r <= 0 || c >= cols - 1 || r >= rows - 1) continue;
      const dc = c - cc;
      const dr = r - cr;
      if (dc * dc + dr * dr <= CENTER_CLEAR_TILES * CENTER_CLEAR_TILES + 1) {
        solid[r * cols + c] = 0;
        pool[r * cols + c] = 0;
      }
    }
  }

  ensureConnected(g, cc, cr);
  for (let i = 0; i < solid.length; i++) if (solid[i]) pool[i] = 0;

  return {
    tile: TILE,
    cols,
    rows,
    width: cols * TILE,
    height: rows * TILE,
    solid,
    pool,
    spawnX: cc * TILE + TILE / 2,
    spawnY: cr * TILE + TILE / 2,
    kind: world.layout.kind,
  };
}

interface Grid {
  cols: number;
  rows: number;
  solid: Uint8Array;
  pool: Uint8Array;
}

function fillRect(g: Grid, c0: number, r0: number, w: number, h: number, v: number, arr = g.solid) {
  for (let r = r0; r < r0 + h; r++) {
    if (r < 0 || r >= g.rows) continue;
    for (let c = c0; c < c0 + w; c++) {
      if (c < 0 || c >= g.cols) continue;
      arr[r * g.cols + c] = v;
    }
  }
}

function genArena(g: Grid, rng: Rng, d: number) {
  const count = Math.round(g.cols * g.rows * (0.006 + d * 0.028));
  for (let i = 0; i < count; i++) {
    const w = rng.int(1, 2);
    const h = rng.int(1, 2);
    const c = rng.int(2, g.cols - 3 - w);
    const r = rng.int(2, g.rows - 3 - h);
    fillRect(g, c, r, w, h, 1);
    if (rng.chance(0.25)) {
      // L / plus shaped pillar clusters
      if (rng.chance(0.5)) fillRect(g, c + w, r, 1, 1, 1);
      else fillRect(g, c, r + h, 1, 1, 1);
    }
  }
}

function genCaverns(g: Grid, rng: Rng, d: number) {
  const p = 0.3 + d * 0.15;
  const { cols, rows } = g;
  let cur: Uint8Array = new Uint8Array(cols * rows);
  for (let i = 0; i < cur.length; i++) cur[i] = rng.chance(p) ? 1 : 0;
  let next: Uint8Array = new Uint8Array(cols * rows);
  for (let it = 0; it < 5; it++) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let n = 0;
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            const rr = r + dr;
            const cc = c + dc;
            if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) n++;
            else n += cur[rr * cols + cc]!;
          }
        const i = r * cols + c;
        next[i] = n > 4 ? 1 : n < 4 ? 0 : cur[i]!;
      }
    }
    const tmp = cur;
    cur = next;
    next = tmp;
  }
  g.solid.set(cur);
}

function genRooms(g: Grid, rng: Rng, d: number) {
  const R = 9;
  const { cols, rows } = g;
  const removeChance = (1 - d) * 0.35;
  // vertical walls
  for (let x = R; x < cols - 2; x += R) {
    for (let y0 = 1; y0 < rows - 1; y0 += R) {
      const y1 = Math.min(rows - 2, y0 + R - 2);
      if (rng.chance(removeChance)) continue;
      const len = y1 - y0 + 1;
      const doorW = 3;
      const doorStart = len > doorW + 1 ? y0 + rng.int(1, Math.max(1, len - doorW - 1)) : y0;
      for (let y = y0; y <= y1; y++) if (y < doorStart || y >= doorStart + doorW) g.solid[y * cols + x] = 1;
    }
  }
  // horizontal walls
  for (let y = R; y < rows - 2; y += R) {
    for (let x0 = 1; x0 < cols - 1; x0 += R) {
      const x1 = Math.min(cols - 2, x0 + R - 2);
      if (rng.chance(removeChance)) continue;
      const len = x1 - x0 + 1;
      const doorW = 3;
      const doorStart = len > doorW + 1 ? x0 + rng.int(1, Math.max(1, len - doorW - 1)) : x0;
      for (let x = x0; x <= x1; x++) if (x < doorStart || x >= doorStart + doorW) g.solid[y * cols + x] = 1;
    }
  }
  // corner posts + inner pillars
  for (let y = R; y < rows - 2; y += R) for (let x = R; x < cols - 2; x += R) g.solid[y * cols + x] = 1;
  for (let y = 0; y + R < rows; y += R) {
    for (let x = 0; x + R < cols; x += R) {
      if (rng.chance(d * 0.7)) {
        const c = x + rng.int(3, R - 4);
        const r = y + rng.int(3, R - 4);
        fillRect(g, c, r, rng.int(1, 2), rng.int(1, 2), 1);
      }
    }
  }
}

function genIslands(g: Grid, rng: Rng, d: number) {
  const { cols, rows } = g;
  const pools = Math.round(4 + d * 10 + (cols * rows) / 600);
  for (let i = 0; i < pools; i++) {
    const cx = rng.range(3, cols - 3);
    const cy = rng.range(3, rows - 3);
    const rad = rng.range(1.8, 4.5);
    const wob = rng.range(0, Math.PI * 2);
    for (let r = Math.floor(cy - rad - 1); r <= Math.ceil(cy + rad + 1); r++) {
      for (let c = Math.floor(cx - rad - 1); c <= Math.ceil(cx + rad + 1); c++) {
        if (c < 1 || r < 1 || c >= cols - 1 || r >= rows - 1) continue;
        const a = Math.atan2(r - cy, c - cx);
        const rr = rad * (0.8 + 0.2 * Math.sin(a * 3 + wob));
        if ((c - cx) ** 2 + (r - cy) ** 2 <= rr * rr) g.pool[r * cols + c] = 1;
      }
    }
  }
  const rocks = Math.round(2 + d * cols * rows * 0.006);
  for (let i = 0; i < rocks; i++) {
    const c = rng.int(2, cols - 4);
    const r = rng.int(2, rows - 4);
    fillRect(g, c, r, rng.int(1, 2), rng.int(1, 2), 1);
  }
}

function genMaze(g: Grid, rng: Rng, d: number) {
  const { cols, rows } = g;
  const CELL = 4; // 3 wide corridor + 1 wall
  const gw = Math.floor((cols - 1) / CELL);
  const gh = Math.floor((rows - 1) / CELL);
  g.solid.fill(1);
  const carveCell = (i: number, j: number) => fillRect(g, 1 + i * CELL, 1 + j * CELL, CELL - 1, CELL - 1, 0);
  const carveBetween = (i: number, j: number, ni: number, nj: number) => {
    if (ni !== i) fillRect(g, 1 + Math.max(i, ni) * CELL - 1, 1 + j * CELL, 1, CELL - 1, 0);
    else fillRect(g, 1 + i * CELL, 1 + Math.max(j, nj) * CELL - 1, CELL - 1, 1, 0);
  };
  const visited = new Uint8Array(gw * gh);
  const stack: [number, number][] = [[rng.int(0, gw - 1), rng.int(0, gh - 1)]];
  visited[stack[0]![1] * gw + stack[0]![0]] = 1;
  carveCell(stack[0]![0], stack[0]![1]);
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  while (stack.length) {
    const [i, j] = stack[stack.length - 1]!;
    const options = rng.shuffle(dirs).filter(([dx, dy]) => {
      const ni = i + dx;
      const nj = j + dy;
      return ni >= 0 && nj >= 0 && ni < gw && nj < gh && !visited[nj * gw + ni];
    });
    if (!options.length) {
      stack.pop();
      continue;
    }
    const [dx, dy] = options[0]!;
    const ni = i + dx;
    const nj = j + dy;
    visited[nj * gw + ni] = 1;
    carveCell(ni, nj);
    carveBetween(i, j, ni, nj);
    stack.push([ni, nj]);
  }
  // Extra loops so the maze is a battlefield, not a puzzle.
  const loopChance = 0.12 + (1 - d) * 0.3;
  for (let j = 0; j < gh; j++)
    for (let i = 0; i < gw; i++) {
      if (i + 1 < gw && rng.chance(loopChance)) carveBetween(i, j, i + 1, j);
      if (j + 1 < gh && rng.chance(loopChance)) carveBetween(i, j, i, j + 1);
    }
}

/** Flood fill (4-connected) over open tiles. Returns a 0/1 mask of reached tiles. */
export function floodOpen(cols: number, rows: number, solid: Uint8Array, sc: number, sr: number): Uint8Array {
  const seen = new Uint8Array(cols * rows);
  const start = sr * cols + sc;
  if (solid[start]) return seen;
  const queue = new Int32Array(cols * rows);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  seen[start] = 1;
  while (head < tail) {
    const i = queue[head++]!;
    const c = i % cols;
    const r = (i - c) / cols;
    if (c > 0) visit(i - 1);
    if (c < cols - 1) visit(i + 1);
    if (r > 0) visit(i - cols);
    if (r < rows - 1) visit(i + cols);
  }
  return seen;
  function visit(n: number) {
    if (!seen[n] && !solid[n]) {
      seen[n] = 1;
      queue[tail++] = n;
    }
  }
}

/** Carves 2-wide corridors from isolated pockets to the main region; fills tiny pockets. */
function ensureConnected(g: Grid, cc: number, cr: number) {
  const { cols, rows, solid } = g;
  for (let pass = 0; pass < 40; pass++) {
    const reached = floodOpen(cols, rows, solid, cc, cr);
    let target = -1;
    for (let i = 0; i < solid.length; i++) {
      if (!solid[i] && !reached[i]) {
        target = i;
        break;
      }
    }
    if (target < 0) return;
    // Measure that pocket.
    const pocket = floodOpen(cols, rows, solid, target % cols, Math.floor(target / cols));
    let size = 0;
    for (let i = 0; i < pocket.length; i++) size += pocket[i]!;
    if (size < 6) {
      for (let i = 0; i < pocket.length; i++) if (pocket[i]) solid[i] = 1;
      continue;
    }
    // Walk from the pocket towards the centre, carving, until we hit the main region.
    let c = target % cols;
    let r = Math.floor(target / cols);
    for (let steps = 0; steps < cols + rows; steps++) {
      if (reached[r * cols + c]) break;
      const dc = cc - c;
      const dr = cr - r;
      if (Math.abs(dc) >= Math.abs(dr) && dc !== 0) c += Math.sign(dc);
      else if (dr !== 0) r += Math.sign(dr);
      else break;
      for (const [oc, or] of [
        [0, 0],
        [1, 0],
        [0, 1],
      ] as const) {
        const x = c + oc;
        const y = r + or;
        if (x > 0 && y > 0 && x < cols - 1 && y < rows - 1) solid[y * cols + x] = 0;
      }
    }
  }
  // Safety net: anything still unreachable becomes wall.
  const reached = floodOpen(cols, rows, solid, cc, cr);
  for (let i = 0; i < solid.length; i++) if (!solid[i] && !reached[i]) solid[i] = 1;
}

// ---------------------------------------------------------------------------
// Queries + collision

export function isSolidTile(m: GameMap, c: number, r: number): boolean {
  if (c < 0 || r < 0 || c >= m.cols || r >= m.rows) return true;
  return m.solid[r * m.cols + c] === 1;
}

export function isSolidAt(m: GameMap, x: number, y: number): boolean {
  return isSolidTile(m, Math.floor(x / m.tile), Math.floor(y / m.tile));
}

/** True when a circle of radius r at (x,y) overlaps no wall tile and is inside the map. */
export function circleFree(m: GameMap, x: number, y: number, r: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (x - r < 0 || y - r < 0 || x + r > m.width || y + r > m.height) return false;
  const T = m.tile;
  const c0 = Math.floor((x - r) / T);
  const c1 = Math.floor((x + r) / T);
  const r0 = Math.floor((y - r) / T);
  const r1 = Math.floor((y + r) / T);
  for (let rr = r0; rr <= r1; rr++)
    for (let cc = c0; cc <= c1; cc++) {
      if (!isSolidTile(m, cc, rr)) continue;
      const nx = Math.max(cc * T, Math.min(x, cc * T + T));
      const ny = Math.max(rr * T, Math.min(y, rr * T + T));
      if ((x - nx) ** 2 + (y - ny) ** 2 < r * r) return false;
    }
  return true;
}

/**
 * Pushes a circle out of wall tiles (in place). Returns true if it collided.
 * Handles deep penetration (centre inside a tile) by pushing along the shallowest axis.
 */
export function resolveCircle(m: GameMap, p: { x: number; y: number }, r: number): boolean {
  const T = m.tile;
  let hit = false;
  for (let iter = 0; iter < 2; iter++) {
    const c0 = Math.floor((p.x - r) / T);
    const c1 = Math.floor((p.x + r) / T);
    const r0 = Math.floor((p.y - r) / T);
    const r1 = Math.floor((p.y + r) / T);
    let moved = false;
    for (let rr = r0; rr <= r1; rr++)
      for (let cc = c0; cc <= c1; cc++) {
        if (!isSolidTile(m, cc, rr)) continue;
        const tx = cc * T;
        const ty = rr * T;
        const nx = Math.max(tx, Math.min(p.x, tx + T));
        const ny = Math.max(ty, Math.min(p.y, ty + T));
        const dx = p.x - nx;
        const dy = p.y - ny;
        const d2 = dx * dx + dy * dy;
        if (d2 >= r * r) continue;
        hit = moved = true;
        if (d2 > 1e-6) {
          const dd = Math.sqrt(d2);
          const push = (r - dd) / dd;
          p.x += dx * push;
          p.y += dy * push;
        } else {
          // centre inside the tile: exit through the nearest open side
          const left = p.x - tx;
          const right = tx + T - p.x;
          const top = p.y - ty;
          const bottom = ty + T - p.y;
          const opts: [number, number, number][] = [
            [left + r, -1, 0],
            [right + r, 1, 0],
            [top + r, 0, -1],
            [bottom + r, 0, 1],
          ];
          opts.sort((a, b) => a[0] - b[0]);
          let chosen = opts[0]!;
          for (const o of opts) {
            if (!isSolidTile(m, cc + o[1], rr + o[2])) {
              chosen = o;
              break;
            }
          }
          p.x += chosen[1] * chosen[0];
          p.y += chosen[2] * chosen[0];
        }
      }
    if (!moved) break;
  }
  p.x = Math.max(r, Math.min(m.width - r, p.x));
  p.y = Math.max(r, Math.min(m.height - r, p.y));
  return hit;
}

/** Number of open tiles (for stats/tests). */
export function openCount(m: GameMap): number {
  let n = 0;
  for (let i = 0; i < m.solid.length; i++) if (!m.solid[i]) n++;
  return n;
}
