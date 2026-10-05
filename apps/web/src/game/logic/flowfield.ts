import type { GameMap } from "./mapgen";

/**
 * BFS flow field towards a goal tile. Enemies read a precomputed unit
 * direction per tile, so steering around walls costs O(1) per enemy.
 * Diagonal moves are allowed only when both orthogonal neighbours are open
 * (no corner cutting).
 */
export class FlowField {
  readonly dist: Int32Array;
  readonly dirX: Float32Array;
  readonly dirY: Float32Array;
  private readonly queue: Int32Array;
  goalC = -1;
  goalR = -1;

  constructor(private readonly map: GameMap) {
    const n = map.cols * map.rows;
    this.dist = new Int32Array(n).fill(-1);
    this.dirX = new Float32Array(n);
    this.dirY = new Float32Array(n);
    this.queue = new Int32Array(n);
  }

  /** Recomputes the field if the goal tile changed. Returns true when recomputed. */
  update(x: number, y: number): boolean {
    const m = this.map;
    const c = Math.max(0, Math.min(m.cols - 1, Math.floor(x / m.tile)));
    const r = Math.max(0, Math.min(m.rows - 1, Math.floor(y / m.tile)));
    if (c === this.goalC && r === this.goalR) return false;
    this.goalC = c;
    this.goalR = r;
    this.compute(c, r);
    return true;
  }

  private compute(gc: number, gr: number) {
    const { cols, rows, solid } = this.map;
    const dist = this.dist;
    dist.fill(-1);
    const q = this.queue;
    let head = 0;
    let tail = 0;
    const start = gr * cols + gc;
    dist[start] = 0;
    q[tail++] = start;
    while (head < tail) {
      const i = q[head++]!;
      const c = i % cols;
      const r = (i - c) / cols;
      const nd = dist[i]! + 1;
      if (c > 0 && !solid[i - 1] && dist[i - 1] === -1) (dist[i - 1] = nd), (q[tail++] = i - 1);
      if (c < cols - 1 && !solid[i + 1] && dist[i + 1] === -1) (dist[i + 1] = nd), (q[tail++] = i + 1);
      if (r > 0 && !solid[i - cols] && dist[i - cols] === -1) (dist[i - cols] = nd), (q[tail++] = i - cols);
      if (r < rows - 1 && !solid[i + cols] && dist[i + cols] === -1) (dist[i + cols] = nd), (q[tail++] = i + cols);
    }
    // Directions: towards the lowest-distance neighbour (8-way, no corner cutting).
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        this.dirX[i] = 0;
        this.dirY[i] = 0;
        const di = dist[i]!;
        if (di <= 0) continue;
        let best = di;
        let bx = 0;
        let by = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nc = c + dx;
            const nr = r + dy;
            if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
            const ni = nr * cols + nc;
            const nd = dist[ni]!;
            if (nd < 0) continue;
            if (dx && dy && (solid[r * cols + nc] || solid[nr * cols + c])) continue;
            // diagonals cost ~1.41: prefer them only when strictly better
            const score = nd + (dx && dy ? 0.41 : 0);
            if (score < best) {
              best = score;
              bx = dx;
              by = dy;
            }
          }
        const len = Math.hypot(bx, by) || 1;
        this.dirX[i] = bx / len;
        this.dirY[i] = by / len;
      }
    }
  }

  /** Tile distance from (x,y) to the goal, -1 if unreachable. */
  distanceAt(x: number, y: number): number {
    const m = this.map;
    const c = Math.floor(x / m.tile);
    const r = Math.floor(y / m.tile);
    if (c < 0 || r < 0 || c >= m.cols || r >= m.rows) return -1;
    return this.dist[r * m.cols + c]!;
  }

  /** Writes the steering direction at (x,y) into out; returns false if unreachable. */
  directionAt(x: number, y: number, out: { x: number; y: number }): boolean {
    const m = this.map;
    const c = Math.floor(x / m.tile);
    const r = Math.floor(y / m.tile);
    if (c < 0 || r < 0 || c >= m.cols || r >= m.rows) return false;
    const i = r * m.cols + c;
    if (this.dist[i]! < 0) return false;
    out.x = this.dirX[i]!;
    out.y = this.dirY[i]!;
    return true;
  }
}
