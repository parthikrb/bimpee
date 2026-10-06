import type { CitySim } from "./CitySim";
import { ASTAR_PER_TICK, CARS_PER_RESIDENT, CAR_SPEED, LANE_OFFSET, PATH_CACHE_MAX, SPAWN_PER_TICK, carCap } from "./constants";
import { TileKind } from "./protocol";
import { Rand } from "./rand";

/**
 * Car agents on the road graph. Paths are A* over road tiles (4-connected),
 * cached per (from, to) road tile and invalidated when roads change. Cars
 * follow quadratic curves through tile centres (edge midpoint -> centre ->
 * edge midpoint) so turns are smooth, offset to the right-hand lane.
 * Struct-of-arrays, no per-tick allocation.
 */
export class Traffic {
  readonly cap: number;
  /** cars per tile (congestion + pollution) */
  readonly occ: Uint16Array;
  private alive: Uint8Array;
  private paths: (Int32Array | null)[];
  private pos: Int32Array;
  private prog: Float32Array;
  private spd: Float32Array;
  private kindArr: Uint8Array;
  private px: Float32Array;
  private py: Float32Array;
  private hd: Float32Array;
  private hdInit: Uint8Array;
  count = 0;
  private cache = new Map<number, Int32Array | null>();
  private cacheRoadVersion = -1;
  private originsVersion = -1;
  private resRoads: number[] = [];
  private jobRoads: number[] = [];
  private policeRoads: number[] = [];
  private slowSum = 0;
  private slowN = 0;
  private congestionValue = 0;
  // A* buffers
  private g: Float32Array;
  private came: Int32Array;
  private stamp: Uint32Array;
  private closed: Uint32Array;
  private stampId = 0;
  private heapIdx: Int32Array;
  private heapF: Float32Array;
  private heapN = 0;

  /** own stream so cars (not saved) don't perturb the saved sim stream */
  private rand: Rand;

  constructor(private sim: CitySim) {
    const n = sim.n;
    this.rand = new Rand(sim.spec.seed ^ 0x7a11);
    this.cap = carCap(sim.size);
    this.occ = new Uint16Array(n);
    const c = this.cap;
    this.alive = new Uint8Array(c);
    this.paths = new Array(c).fill(null);
    this.pos = new Int32Array(c);
    this.prog = new Float32Array(c);
    this.spd = new Float32Array(c);
    this.kindArr = new Uint8Array(c);
    this.px = new Float32Array(c);
    this.py = new Float32Array(c);
    this.hd = new Float32Array(c);
    this.hdInit = new Uint8Array(c);
    this.g = new Float32Array(n);
    this.came = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.heapIdx = new Int32Array(n * 4);
    this.heapF = new Float32Array(n * 4);
  }

  congestion(): number {
    return this.congestionValue;
  }

  /** remove every car (load, tests) */
  clear() {
    this.alive.fill(0);
    this.paths.fill(null);
    this.occ.fill(0);
    this.count = 0;
  }

  private refreshOrigins() {
    const sim = this.sim;
    this.originsVersion = sim.topoVersion;
    this.resRoads.length = 0;
    this.jobRoads.length = 0;
    this.policeRoads.length = 0;
    for (const b of sim.buildings.values()) {
      if (b.abandoned || b.damage >= 1) continue;
      const r = sim.nearestRoad[b.y * sim.size + b.x]!;
      if (r < 0 || sim.roadDist[b.y * sim.size + b.x]! > 3) continue;
      if (b.type === "res") this.resRoads.push(r);
      else if (b.type === "com" || b.type === "ind") this.jobRoads.push(r);
      else if (b.type === "police") this.policeRoads.push(r);
    }
  }

  private rushFactor(): number {
    const h = this.sim.hour;
    const peak = (c: number) => Math.exp(-((h - c) * (h - c)) / 2.5);
    const night = h < 5 || h > 23 ? 0.25 : 1;
    return night * (0.45 + 0.9 * peak(8) + 0.8 * peak(17.5));
  }

  tick(dt: number) {
    const sim = this.sim;
    if (this.cacheRoadVersion !== sim.roadVersion) this.onRoadsChanged();
    if (this.originsVersion !== sim.topoVersion) this.refreshOrigins();
    this.spawn();
    this.move(dt);
  }

  private onRoadsChanged() {
    this.cacheRoadVersion = this.sim.roadVersion;
    this.cache.clear();
    const kind = this.sim.kind;
    for (let c = 0; c < this.cap; c++) {
      if (!this.alive[c]) continue;
      const p = this.paths[c]!;
      for (let k = this.pos[c]!; k < p.length; k++) {
        if (kind[p[k]!] !== TileKind.Road) {
          this.despawn(c);
          break;
        }
      }
    }
  }

  private despawn(c: number) {
    const p = this.paths[c];
    if (p) {
      const t = p[this.pos[c]!]!;
      if (this.occ[t]! > 0) this.occ[t]!--;
    }
    this.alive[c] = 0;
    this.paths[c] = null;
    this.count--;
  }

  private spawn() {
    const sim = this.sim;
    if (!this.resRoads.length) return;
    const target = Math.min(this.cap, Math.floor(sim.population * CARS_PER_RESIDENT * this.rushFactor()));
    let budget = ASTAR_PER_TICK;
    const police = sim.disasters.length > 0 && this.policeRoads.length > 0;
    for (let k = 0; k < SPAWN_PER_TICK; k++) {
      if (this.count >= this.cap) return;
      let from: number;
      let to: number;
      let kind: number;
      if (police && this.rand.chance(0.25)) {
        const d = sim.disasters[0]!;
        const cx = Math.max(0, Math.min(sim.size - 1, Math.floor(d.x)));
        const cy = Math.max(0, Math.min(sim.size - 1, Math.floor(d.y)));
        from = this.rand.pick(this.policeRoads);
        to = sim.nearestRoad[cy * sim.size + cx]!;
        kind = 4;
      } else {
        if (this.count >= target) return;
        const jobs = this.jobRoads.length ? this.jobRoads : this.resRoads;
        const home = this.rand.pick(this.resRoads);
        const work = this.rand.pick(jobs);
        const evening = sim.hour > 13;
        from = evening ? work : home;
        to = evening ? home : work;
        const r = this.rand.next();
        kind = r < 0.45 ? 0 : r < 0.75 ? 1 : r < 0.92 ? 2 : 3;
        if (this.policeRoads.length && this.rand.chance(0.03)) kind = 4;
      }
      if (to < 0 || from === to) continue;
      const key = from * sim.n + to;
      let path = this.cache.get(key);
      if (path === undefined) {
        if (budget <= 0) continue;
        budget--;
        path = this.astar(from, to);
        if (this.cache.size >= PATH_CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, path);
      }
      if (!path || path.length < 2) continue;
      this.add(path, kind);
    }
  }

  private add(path: Int32Array, kind: number) {
    for (let c = 0; c < this.cap; c++) {
      if (this.alive[c]) continue;
      this.alive[c] = 1;
      this.paths[c] = path;
      this.pos[c] = 0;
      this.prog[c] = 0;
      this.spd[c] = CAR_SPEED * (0.85 + 0.3 * this.rand.next()) * (kind === 4 ? 1.25 : 1);
      this.kindArr[c] = kind;
      this.hdInit[c] = 0;
      this.occ[path[0]!]!++;
      this.count++;
      this.place(c);
      return;
    }
  }

  private move(dt: number) {
    const sim = this.sim;
    const w = sim.weather;
    const weatherF = w === "snow" ? 0.65 : w === "storm" ? 0.8 : w === "fog" ? 0.85 : w === "rain" ? 0.92 : 1;
    let slow = 0;
    let n = 0;
    for (let c = 0; c < this.cap; c++) {
      if (!this.alive[c]) continue;
      const p = this.paths[c]!;
      const pos = this.pos[c]!;
      const next = pos + 1 < p.length ? p[pos + 1]! : p[pos]!;
      const o = this.occ[next]!;
      const f = o <= 2 ? 1 : Math.max(0.2, 2 / o);
      slow += 1 - f;
      n++;
      let pr = this.prog[c]! + this.spd[c]! * dt * f * weatherF;
      let k = pos;
      while (pr >= 1) {
        pr -= 1;
        if (k + 1 >= p.length) {
          k = -1;
          break;
        }
        this.occ[p[k]!]!--;
        k++;
        this.occ[p[k]!]!++;
      }
      if (k < 0) {
        this.despawn(c);
        continue;
      }
      this.pos[c] = k;
      this.prog[c] = pr;
      this.place(c);
    }
    this.slowSum = slow;
    this.slowN = n;
    const inst = n ? slow / n : 0;
    this.congestionValue += (Math.min(1, inst * 1.5) - this.congestionValue) * 0.05;
  }

  /** position + heading for car c from its path progress */
  private place(c: number) {
    const s = this.sim.size;
    const p = this.paths[c]!;
    const k = this.pos[c]!;
    const t = this.prog[c]!;
    const cur = p[k]!;
    const cx = (cur % s) + 0.5;
    const cy = ((cur / s) | 0) + 0.5;
    let ex = cx;
    let ey = cy;
    let xx = cx;
    let xy = cy;
    if (k > 0) {
      const pv = p[k - 1]!;
      ex = (cx + (pv % s) + 0.5) * 0.5;
      ey = (cy + ((pv / s) | 0) + 0.5) * 0.5;
    }
    if (k + 1 < p.length) {
      const nx = p[k + 1]!;
      xx = (cx + (nx % s) + 0.5) * 0.5;
      xy = (cy + ((nx / s) | 0) + 0.5) * 0.5;
    }
    const u = 1 - t;
    const bx = u * u * ex + 2 * u * t * cx + t * t * xx;
    const by = u * u * ey + 2 * u * t * cy + t * t * xy;
    let tx = 2 * u * (cx - ex) + 2 * t * (xx - cx);
    let ty = 2 * u * (cy - ey) + 2 * t * (xy - cy);
    const len = Math.sqrt(tx * tx + ty * ty);
    if (len < 1e-5) {
      tx = Math.cos(this.hd[c]!);
      ty = Math.sin(this.hd[c]!);
    } else {
      tx /= len;
      ty /= len;
    }
    // right-hand lane: in tile space (x right, y down) the right of (tx,ty) is (-ty, tx)
    this.px[c] = bx - ty * LANE_OFFSET;
    this.py[c] = by + tx * LANE_OFFSET;
    const target = Math.atan2(ty, tx);
    if (!this.hdInit[c]) {
      this.hd[c] = target;
      this.hdInit[c] = 1;
    } else {
      let d = target - this.hd[c]!;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      let h = this.hd[c]! + d * 0.6;
      if (h > Math.PI) h -= Math.PI * 2;
      if (h < -Math.PI) h += Math.PI * 2;
      this.hd[c] = h;
    }
  }

  /** [x, y, heading, kind, ...] in tile space; fresh array (safe to transfer) */
  snapshot(): Float32Array {
    const out = new Float32Array(this.count * 4);
    let o = 0;
    for (let c = 0; c < this.cap && o < out.length; c++) {
      if (!this.alive[c]) continue;
      out[o++] = this.px[c]!;
      out[o++] = this.py[c]!;
      out[o++] = this.hd[c]!;
      out[o++] = this.kindArr[c]!;
    }
    return out;
  }

  /** A* over road tiles; null when unreachable */
  astar(from: number, to: number): Int32Array | null {
    const sim = this.sim;
    const s = sim.size;
    const n = sim.n;
    const kind = sim.kind;
    if (kind[from] !== TileKind.Road || kind[to] !== TileKind.Road) return null;
    this.stampId++;
    if (this.stampId >= 0xfffffff0) {
      this.stamp.fill(0);
      this.closed.fill(0);
      this.stampId = 1;
    }
    const sid = this.stampId;
    const tx = to % s;
    const ty = (to / s) | 0;
    const h = (i: number) => Math.abs((i % s) - tx) + Math.abs(((i / s) | 0) - ty);
    this.heapN = 0;
    this.g[from] = 0;
    this.stamp[from] = sid;
    this.came[from] = -1;
    this.push(from, h(from));
    while (this.heapN > 0) {
      const i = this.pop();
      if (this.closed[i] === sid) continue;
      this.closed[i] = sid;
      if (i === to) break;
      const gi = this.g[i]! + 1;
      const x = i % s;
      for (let d = 0; d < 4; d++) {
        let j: number;
        if (d === 0) {
          if (i < s) continue;
          j = i - s;
        } else if (d === 1) {
          if (x >= s - 1) continue;
          j = i + 1;
        } else if (d === 2) {
          if (i + s >= n) continue;
          j = i + s;
        } else {
          if (x <= 0) continue;
          j = i - 1;
        }
        if (kind[j] !== TileKind.Road || this.closed[j] === sid) continue;
        const gj = gi + this.occ[j]! * 0.05;
        if (this.stamp[j] !== sid || gj < this.g[j]!) {
          this.stamp[j] = sid;
          this.g[j] = gj;
          this.came[j] = i;
          if (this.heapN < this.heapIdx.length) this.push(j, gj + h(j));
        }
      }
    }
    if (this.closed[to] !== sid) return null;
    let len = 0;
    for (let i = to; i !== -1; i = this.came[i]!) len++;
    const out = new Int32Array(len);
    let k = len - 1;
    for (let i = to; i !== -1; i = this.came[i]!) out[k--] = i;
    return out;
  }

  private push(i: number, f: number) {
    let k = this.heapN++;
    const hi = this.heapIdx;
    const hf = this.heapF;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (hf[p]! <= f) break;
      hi[k] = hi[p]!;
      hf[k] = hf[p]!;
      k = p;
    }
    hi[k] = i;
    hf[k] = f;
  }

  private pop(): number {
    const hi = this.heapIdx;
    const hf = this.heapF;
    const top = hi[0]!;
    const n = --this.heapN;
    if (n > 0) {
      const li = hi[n]!;
      const lf = hf[n]!;
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= n) break;
        if (c + 1 < n && hf[c + 1]! < hf[c]!) c++;
        if (hf[c]! >= lf) break;
        hi[k] = hi[c]!;
        hf[k] = hf[c]!;
        k = c;
      }
      hi[k] = li;
      hf[k] = lf;
    }
    return top;
  }

  /** debug/test: alive car count */
  get size() {
    return this.count;
  }
  get lastSlow() {
    return this.slowN ? this.slowSum / this.slowN : 0;
  }
}
