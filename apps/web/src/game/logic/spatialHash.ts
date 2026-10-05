/**
 * Uniform-grid spatial hash over pooled entities (by pool index).
 * Rebuilt every frame with linked lists in typed arrays: no allocation.
 */
export class SpatialHash {
  private readonly head: Int32Array;
  private readonly next: Int32Array;
  readonly cols: number;
  readonly rows: number;

  constructor(
    width: number,
    height: number,
    readonly cell: number,
    capacity: number,
  ) {
    this.cols = Math.max(1, Math.ceil(width / cell));
    this.rows = Math.max(1, Math.ceil(height / cell));
    this.head = new Int32Array(this.cols * this.rows).fill(-1);
    this.next = new Int32Array(capacity).fill(-1);
  }

  clear() {
    this.head.fill(-1);
  }

  insert(index: number, x: number, y: number) {
    const c = Math.max(0, Math.min(this.cols - 1, Math.floor(x / this.cell)));
    const r = Math.max(0, Math.min(this.rows - 1, Math.floor(y / this.cell)));
    const k = r * this.cols + c;
    this.next[index] = this.head[k]!;
    this.head[k] = index;
  }

  /**
   * Calls fn for every index in cells overlapping the AABB of (x,y,radius).
   * Return true from fn to stop early.
   */
  query(x: number, y: number, radius: number, fn: (index: number) => boolean | void): void {
    this.queryRect(x - radius, y - radius, x + radius, y + radius, fn);
  }

  queryRect(x0: number, y0: number, x1: number, y1: number, fn: (index: number) => boolean | void): void {
    const c0 = Math.max(0, Math.floor(Math.min(x0, x1) / this.cell));
    const c1 = Math.min(this.cols - 1, Math.floor(Math.max(x0, x1) / this.cell));
    const r0 = Math.max(0, Math.floor(Math.min(y0, y1) / this.cell));
    const r1 = Math.min(this.rows - 1, Math.floor(Math.max(y0, y1) / this.cell));
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        let i = this.head[r * this.cols + c]!;
        while (i !== -1) {
          const n = this.next[i]!;
          if (fn(i) === true) return;
          i = n;
        }
      }
  }
}
