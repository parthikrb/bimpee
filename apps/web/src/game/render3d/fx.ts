import * as THREE from "three";
import type { Bag } from "./bag";
import { beamMaterial, glowMaterial } from "./materials";
import { debrisGeometry } from "./models";
import { QuadBatch } from "./quads";
import type { TextureKit } from "./textures";

/**
 * All transient visuals: immediate-mode quad batches shared by every layer
 * (begin at frame start, push, end before render) plus pooled particles,
 * debris, beams and dash afterimages. World units throughout.
 */
export class Draw {
  readonly glow: QuadBatch;
  readonly spark: QuadBatch;
  readonly smoke: QuadBatch;
  readonly ring: QuadBatch;
  readonly groundGlow: QuadBatch;
  readonly decal: QuadBatch;
  readonly dot: QuadBatch;
  readonly puddle: QuadBatch;
  readonly chevron: QuadBatch;
  readonly bar: QuadBatch;
  readonly all: QuadBatch[];

  constructor(bag: Bag, tex: TextureKit, scene: THREE.Object3D, scale = 1) {
    const cap = (n: number) => Math.max(64, Math.round(n * scale));
    this.glow = new QuadBatch(bag, { mode: "billboard", capacity: cap(3000), texture: tex.get("glow"), renderOrder: 6 });
    this.spark = new QuadBatch(bag, { mode: "streak", capacity: cap(1600), texture: tex.get("spark"), renderOrder: 7 });
    this.smoke = new QuadBatch(bag, { mode: "billboard", capacity: cap(400), texture: tex.get("smoke"), additive: false, renderOrder: 4 });
    this.ring = new QuadBatch(bag, { mode: "ground", capacity: 600, texture: tex.get("ring"), renderOrder: 3 });
    this.groundGlow = new QuadBatch(bag, { mode: "ground", capacity: 1400, texture: tex.get("glow"), renderOrder: 2 });
    this.decal = new QuadBatch(bag, { mode: "ground", capacity: 200, texture: tex.get("scorch"), additive: false, renderOrder: 1 });
    this.dot = new QuadBatch(bag, { mode: "ground", capacity: 1300, texture: tex.get("dot"), additive: false, renderOrder: 2 });
    this.puddle = new QuadBatch(bag, { mode: "ground", capacity: 200, texture: tex.get("puddle"), renderOrder: 2 });
    this.chevron = new QuadBatch(bag, { mode: "ground", capacity: 120, texture: tex.get("chevron"), renderOrder: 3 });
    this.bar = new QuadBatch(bag, { mode: "bar", capacity: 64, additive: false, depthTest: false, renderOrder: 20 });
    this.all = [this.decal, this.puddle, this.dot, this.groundGlow, this.ring, this.chevron, this.smoke, this.glow, this.spark, this.bar];
    for (const b of this.all) scene.add(b.mesh);
  }

  begin() {
    for (const b of this.all) b.begin();
  }
  end() {
    for (const b of this.all) b.end();
  }
}

/** Particle kinds -> which batch draws them. */
export const PK = { glow: 0, spark: 1, smoke: 2, ring: 3, scorch: 4, groundGlow: 5 } as const;
type PKind = (typeof PK)[keyof typeof PK];

export interface ParticleSpec {
  kind: PKind;
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  life: number;
  s0: number;
  s1?: number;
  r: number;
  g: number;
  b: number;
  a?: number;
  drag?: number;
  grav?: number;
  /** streak length factor (spark): world units per (unit/s) of speed */
  stretch?: number;
}

const UP = new THREE.Vector3(0, 1, 0);
const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const qt = new THREE.Quaternion();
const m4 = new THREE.Matrix4();
const col = new THREE.Color();
const eu = new THREE.Euler();

export class Fx {
  private readonly cap: number;
  private n = 0;
  private readonly f: Float32Array;
  private readonly kinds: Uint8Array;
  private static readonly STRIDE = 18;
  // debris
  readonly debris: THREE.InstancedMesh;
  private readonly dCap = 220;
  private readonly d: Float32Array;
  private dN = 0;
  // beams
  readonly beams: THREE.InstancedMesh;
  private readonly beamMat: THREE.ShaderMaterial;
  private beamN = 0;
  private readonly lances: { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number; w: number; c: THREE.Color; t: number; dur: number }[] = [];
  // afterimages
  private readonly ghosts: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; t: number }[] = [];
  private ghostNext = 0;
  quality = 1;

  constructor(
    private readonly bag: Bag,
    readonly draw: Draw,
    scene: THREE.Object3D,
    cap = 2400,
  ) {
    this.cap = cap;
    this.f = new Float32Array(cap * Fx.STRIDE);
    this.kinds = new Uint8Array(cap);
    const dg = bag.track(debrisGeometry());
    const dm = bag.track(glowMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.5, flatShading: true }, { emissive: 0.3, rim: 0.4, vertexGlow: true }));
    this.debris = new THREE.InstancedMesh(dg, dm, this.dCap);
    this.debris.count = 0;
    this.debris.castShadow = true;
    this.debris.frustumCulled = false;
    this.debris.setColorAt(0, col.setRGB(1, 1, 1));
    this.d = new Float32Array(this.dCap * 16);
    scene.add(this.debris);
    const bg = bag.track(new THREE.CylinderGeometry(1, 1, 1, 12, 1, true));
    this.beamMat = bag.track(beamMaterial());
    this.beams = new THREE.InstancedMesh(bg, this.beamMat, 96);
    this.beams.count = 0;
    this.beams.frustumCulled = false;
    this.beams.renderOrder = 8;
    this.beams.setColorAt(0, col.setRGB(1, 1, 1));
    scene.add(this.beams);
  }

  /** Dash afterimages need the player ship geometry. */
  initAfterimages(geo: THREE.BufferGeometry, scene: THREE.Object3D) {
    for (let i = 0; i < 10; i++) {
      const mat = this.bag.track(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.renderOrder = 6;
      scene.add(mesh);
      this.ghosts.push({ mesh, mat, t: 0 });
    }
  }

  spawn(p: ParticleSpec) {
    let i = this.n;
    if (i >= this.cap) {
      // overwrite a random live slot rather than dropping big moments
      i = (Math.random() * this.cap) | 0;
    } else this.n++;
    const o = i * Fx.STRIDE;
    const f = this.f;
    f[o] = p.x;
    f[o + 1] = p.y;
    f[o + 2] = p.z;
    f[o + 3] = p.vx ?? 0;
    f[o + 4] = p.vy ?? 0;
    f[o + 5] = p.vz ?? 0;
    f[o + 6] = p.life;
    f[o + 7] = Math.max(0.001, p.life);
    f[o + 8] = p.s0;
    f[o + 9] = p.s1 ?? 0;
    f[o + 10] = p.r;
    f[o + 11] = p.g;
    f[o + 12] = p.b;
    f[o + 13] = p.a ?? 1;
    f[o + 14] = p.drag ?? 2;
    f[o + 15] = p.grav ?? 0;
    f[o + 16] = p.stretch ?? 0.04;
    f[o + 17] = Math.random() * 6.28;
    this.kinds[i] = p.kind;
  }

  /** Radial burst of sparks + glows (sim "burst" events), optional debris. */
  burst(x: number, y: number, z: number, c: THREE.Color, count: number, speed: number, size: number, debris = 0) {
    const n = Math.max(1, Math.round(count * this.quality));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = (Math.random() * 0.9 + 0.1) * speed * 0.6;
      const s = speed * (0.3 + Math.random() * 0.9);
      const white = i % 4 === 0;
      this.spawn({
        kind: i % 3 === 0 ? PK.glow : PK.spark,
        x,
        y,
        z,
        vx: Math.cos(a) * s,
        vy: up,
        vz: Math.sin(a) * s,
        life: 0.3 + Math.random() * 0.45,
        s0: (i % 3 === 0 ? 0.35 : 0.12) * size,
        s1: 0,
        r: white ? 2.2 : c.r * 2.4,
        g: white ? 2.2 : c.g * 2.4,
        b: white ? 2.2 : c.b * 2.4,
        drag: 2.5,
        grav: -9,
        stretch: 0.05,
      });
    }
    for (let i = 0; i < debris; i++) this.addDebris(x, y, z, c, speed * 0.5, 0.08 + Math.random() * 0.12 * size);
  }

  ring(x: number, z: number, r: number, c: THREE.Color, life = 0.45, from = 0.1, alpha = 1.6) {
    this.spawn({ kind: PK.ring, x, y: 0.05, z, life, s0: r * 2 * from, s1: r * 2, r: c.r * alpha, g: c.g * alpha, b: c.b * alpha, drag: 0 });
  }

  scorch(x: number, z: number, r: number, life = 6) {
    this.spawn({ kind: PK.scorch, x, y: 0.015, z, life, s0: r * 2, s1: r * 2, r: 0.02, g: 0.015, b: 0.012, a: 0.75, drag: 0 });
  }

  addDebris(x: number, y: number, z: number, c: THREE.Color, speed: number, size: number) {
    let i = this.dN;
    if (i >= this.dCap) i = (Math.random() * this.dCap) | 0;
    else this.dN++;
    const o = i * 16;
    const d = this.d;
    const a = Math.random() * Math.PI * 2;
    const s = speed * (0.4 + Math.random() * 0.8);
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = z;
    d[o + 3] = Math.cos(a) * s;
    d[o + 4] = 2 + Math.random() * speed * 0.8;
    d[o + 5] = Math.sin(a) * s;
    d[o + 6] = 1.1 + Math.random() * 0.8; // life
    d[o + 7] = size;
    d[o + 8] = Math.random() * 6;
    d[o + 9] = Math.random() * 6;
    d[o + 10] = (Math.random() - 0.5) * 16;
    d[o + 11] = (Math.random() - 0.5) * 16;
    d[o + 12] = c.r;
    d[o + 13] = c.g;
    d[o + 14] = c.b;
    d[o + 15] = d[o + 6]!;
  }

  lance(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, w: number, c: THREE.Color, dur = 0.2) {
    if (this.lances.length > 40) this.lances.shift();
    this.lances.push({ x1, y1, z1, x2, y2, z2, w, c: c.clone(), t: 0, dur });
  }

  /** Immediate beam for this frame (boss lasers, telegraph lines). */
  beam(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, w: number, r: number, g: number, b: number) {
    if (this.beamN >= this.beams.instanceMatrix.count) return;
    v1.set(x2 - x1, y2 - y1, z2 - z1);
    const len = v1.length();
    if (!(len > 1e-4)) return;
    v1.multiplyScalar(1 / len);
    qt.setFromUnitVectors(UP, v1);
    v2.set((x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2);
    m4.compose(v2, qt, v1.set(w, len, w));
    this.beams.setMatrixAt(this.beamN, m4);
    this.beams.setColorAt(this.beamN, col.setRGB(r, g, b));
    this.beamN++;
  }

  afterimage(x: number, y: number, z: number, yaw: number, roll: number, c: THREE.Color) {
    if (!this.ghosts.length) return;
    const g = this.ghosts[this.ghostNext]!;
    this.ghostNext = (this.ghostNext + 1) % this.ghosts.length;
    g.t = 0.28;
    g.mesh.visible = true;
    g.mesh.position.set(x, y, z);
    g.mesh.rotation.set(roll, yaw, 0, "YXZ");
    g.mat.color.copy(c);
  }

  /** Advance (dt may be 0 when paused) and write everything into the batches. */
  update(dt: number) {
    const f = this.f;
    const D = this.draw;
    for (let i = 0; i < this.n; i++) {
      const o = i * Fx.STRIDE;
      f[o + 6]! -= dt;
      if (f[o + 6]! <= 0) {
        // swap-remove
        const last = (this.n - 1) * Fx.STRIDE;
        if (o !== last) {
          for (let k = 0; k < Fx.STRIDE; k++) f[o + k] = f[last + k]!;
          this.kinds[i] = this.kinds[this.n - 1]!;
        }
        this.n--;
        i--;
        continue;
      }
      const drag = Math.exp(-f[o + 14]! * dt);
      f[o + 3]! *= drag;
      f[o + 5]! *= drag;
      f[o + 4] = f[o + 4]! * drag + f[o + 15]! * dt;
      f[o] = f[o]! + f[o + 3]! * dt;
      f[o + 1] = f[o + 1]! + f[o + 4]! * dt;
      f[o + 2] = f[o + 2]! + f[o + 5]! * dt;
      if (f[o + 1]! < 0.03 && f[o + 15]! < 0) {
        f[o + 1] = 0.03;
        f[o + 4] = Math.abs(f[o + 4]!) * 0.3;
      }
      const k = 1 - f[o + 6]! / f[o + 7]!;
      const s = f[o + 8]! + (f[o + 9]! - f[o + 8]!) * k;
      const kind = this.kinds[i]!;
      const fade = kind === PK.scorch ? Math.min(1, (1 - k) * 4) : 1 - k * k;
      const a = f[o + 13]! * fade;
      const x = f[o]!;
      const y = f[o + 1]!;
      const z = f[o + 2]!;
      switch (kind) {
        case PK.glow:
          D.glow.push(x, y, z, s, s, f[o + 10]!, f[o + 11]!, f[o + 12]!, a);
          break;
        case PK.spark: {
          const vx = f[o + 3]!;
          const vy = f[o + 4]!;
          const vz = f[o + 5]!;
          const sp = Math.hypot(vx, vy, vz);
          const len = Math.max(s * 2, sp * f[o + 16]!);
          D.spark.push(x, y, z, len, s, f[o + 10]!, f[o + 11]!, f[o + 12]!, a, 0, vx, vy, vz);
          break;
        }
        case PK.smoke:
          D.smoke.push(x, y, z, s, s, f[o + 10]!, f[o + 11]!, f[o + 12]!, a * 0.5, f[o + 17]! + k);
          break;
        case PK.ring:
          D.ring.push(x, y, z, s, s, f[o + 10]!, f[o + 11]!, f[o + 12]!, a);
          break;
        case PK.scorch:
          D.decal.push(x, y, z, s, s, f[o + 10]!, f[o + 11]!, f[o + 12]!, a, f[o + 17]!);
          break;
        case PK.groundGlow:
          D.groundGlow.push(x, y, z, s, s, f[o + 10]!, f[o + 11]!, f[o + 12]!, a);
          break;
      }
    }

    // debris
    const d = this.d;
    let shown = 0;
    for (let i = 0; i < this.dN; i++) {
      const o = i * 16;
      d[o + 6]! -= dt;
      if (d[o + 6]! <= 0) {
        const last = (this.dN - 1) * 16;
        if (o !== last) for (let k = 0; k < 16; k++) d[o + k] = d[last + k]!;
        this.dN--;
        i--;
        continue;
      }
      d[o + 4]! -= 22 * dt;
      d[o] = d[o]! + d[o + 3]! * dt;
      d[o + 1] = d[o + 1]! + d[o + 4]! * dt;
      d[o + 2] = d[o + 2]! + d[o + 5]! * dt;
      if (d[o + 1]! < d[o + 7]!) {
        d[o + 1] = d[o + 7]!;
        d[o + 4] = Math.abs(d[o + 4]!) * 0.35;
        d[o + 3]! *= 0.6;
        d[o + 5]! *= 0.6;
        d[o + 10]! *= 0.6;
        d[o + 11]! *= 0.6;
      }
      d[o + 8] = d[o + 8]! + d[o + 10]! * dt;
      d[o + 9] = d[o + 9]! + d[o + 11]! * dt;
      const life = d[o + 6]!;
      const sz = d[o + 7]! * Math.min(1, life / 0.4);
      qt.setFromEuler(eu.set(d[o + 8]!, d[o + 9]!, 0));
      m4.compose(v2.set(d[o]!, d[o + 1]!, d[o + 2]!), qt, v1.set(sz, sz, sz));
      this.debris.setMatrixAt(shown, m4);
      this.debris.setColorAt(shown, col.setRGB(d[o + 12]!, d[o + 13]!, d[o + 14]!));
      shown++;
    }
    this.debris.count = shown;
    if (shown) {
      this.debris.instanceMatrix.needsUpdate = true;
      if (this.debris.instanceColor) this.debris.instanceColor.needsUpdate = true;
    }

    // persistent lances -> beams (beamN was reset by beginFrame)
    for (let i = this.lances.length - 1; i >= 0; i--) {
      const l = this.lances[i]!;
      l.t += dt;
      const k = l.t / l.dur;
      if (k >= 1) {
        this.lances.splice(i, 1);
        continue;
      }
      const w = l.w * (1 - k * 0.6);
      const br = (1 - k) * 1.8;
      this.beam(l.x1, l.y1, l.z1, l.x2, l.y2, l.z2, w, l.c.r * br, l.c.g * br, l.c.b * br);
      this.beam(l.x1, l.y1, l.z1, l.x2, l.y2, l.z2, w * 0.35, 2 * (1 - k), 2 * (1 - k), 2 * (1 - k));
    }
    this.beams.count = this.beamN;
    if (this.beamN) {
      this.beams.instanceMatrix.needsUpdate = true;
      if (this.beams.instanceColor) this.beams.instanceColor.needsUpdate = true;
    }

    for (const g of this.ghosts) {
      if (!g.mesh.visible) continue;
      g.t -= dt;
      if (g.t <= 0) {
        g.mesh.visible = false;
        continue;
      }
      g.mat.opacity = Math.min(1, g.t / 0.28) * 0.55;
    }
  }

  /** Call at frame start, before anyone pushes immediate beams. */
  beginFrame(time: number) {
    this.beamN = 0;
    this.beamMat.uniforms.uTime!.value = time;
  }

  clear() {
    this.n = 0;
    this.dN = 0;
    this.lances.length = 0;
  }
}
