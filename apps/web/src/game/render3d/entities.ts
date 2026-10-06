import * as THREE from "three";
import { ENEMY_BASES, type EnemyBase } from "@bimpee/shared";
import { hexToInt, TAU } from "../logic/math";
import { orbitalLayout } from "../logic/weapons";
import { MAX_ENEMIES, MAX_HAZARDS, type Sim } from "../sim/Sim";
import type { Bag } from "./bag";
import { wrapAngle } from "./controls";
import { S, SHOT_H } from "./coords";
import type { Draw, Fx } from "./fx";
import { PK } from "./fx";
import { bubbleMaterial, glowMaterial, pillarMaterial, type GlowUniforms } from "./materials";
import { barrelGeometry, chestGeometry, enemyGeometry, gemGeometry, merge, part, shipGeometry, standingStoneGeometry, tf } from "./models";
import { intColor, mixC, type Pal } from "./palette";

export interface LayerCtx {
  sim: Sim;
  draw: Draw;
  fx: Fx;
  pal: Pal;
  bag: Bag;
  scene: THREE.Object3D;
}

const RED = new THREE.Color(0xff3355);
const WHITE = new THREE.Color(1, 1, 1);
const SHIELD = new THREE.Color(0x9fe8ff);
const m4 = new THREE.Matrix4();
const qt = new THREE.Quaternion();
const eu = new THREE.Euler();
const v3 = new THREE.Vector3();
const sc = new THREE.Vector3();
const c1 = new THREE.Color();
const c2 = new THREE.Color();
const qr = new THREE.Quaternion();
const ZAXIS = new THREE.Vector3(0, 0, 1);

function compose(x: number, y: number, z: number, rx: number, ry: number, rz: number, sx: number, sy: number, sz: number, order: THREE.EulerOrder = "YXZ") {
  eu.set(rx, ry, rz, order);
  qt.setFromEuler(eu);
  return m4.compose(v3.set(x, y, z), qt, sc.set(sx, sy, sz));
}

/** x-ray silhouette: drawn only where the mesh is hidden behind something. */
export function xrayMaterial(color?: THREE.Color): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: color ?? 0xffffff,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
    depthFunc: THREE.GreaterDepth,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
}

interface BaseMesh {
  mesh: THREE.InstancedMesh;
  xray: THREE.InstancedMesh;
  fxAttr: THREE.InstancedBufferAttribute;
  fx: Float32Array;
  n: number;
}

/** Instanced enemies: one InstancedMesh per base type + x-ray twin, barrels, shields. */
export class EnemyLayer {
  private readonly bases = new Map<EnemyBase, BaseMesh>();
  private readonly barrels: THREE.InstancedMesh;
  private readonly shields: THREE.InstancedMesh;
  private readonly slotUid = new Int32Array(MAX_ENEMIES);
  private readonly yaw = new Float32Array(MAX_ENEMIES);
  private readonly roll = new Float32Array(MAX_ENEMIES);
  private readonly shieldMat: THREE.ShaderMaterial;

  constructor(private readonly ctx: LayerCtx) {
    const { bag, scene } = ctx;
    const mat = bag.track(glowMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.45, metalness: 0.15, flatShading: true }, { emissive: 0.16, rim: 0.75, instanceFx: true, vertexGlow: true }));
    const xm = bag.track(xrayMaterial());
    for (const base of ENEMY_BASES) {
      const geo = bag.track(enemyGeometry(base));
      const fx = new Float32Array(MAX_ENEMIES * 4);
      const fxAttr = new THREE.InstancedBufferAttribute(fx, 4);
      fxAttr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute("aFx", fxAttr);
      const mesh = new THREE.InstancedMesh(geo, mat, MAX_ENEMIES);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.setColorAt(0, WHITE);
      mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      mesh.name = `enemy_${base}`;
      const xray = new THREE.InstancedMesh(geo, xm, MAX_ENEMIES);
      xray.instanceMatrix = mesh.instanceMatrix;
      xray.instanceColor = mesh.instanceColor;
      xray.count = 0;
      xray.frustumCulled = false;
      xray.renderOrder = 9;
      scene.add(mesh, xray);
      this.bases.set(base, { mesh, xray, fxAttr, fx, n: 0 });
    }
    const bgeo = bag.track(barrelGeometry());
    this.barrels = new THREE.InstancedMesh(bgeo, bag.track(glowMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.4, metalness: 0.4 }, { emissive: 0.2, rim: 0.6, vertexGlow: true })), MAX_ENEMIES);
    this.barrels.count = 0;
    this.barrels.castShadow = true;
    this.barrels.frustumCulled = false;
    this.barrels.setColorAt(0, WHITE);
    scene.add(this.barrels);
    this.shieldMat = bag.track(bubbleMaterial());
    this.shields = new THREE.InstancedMesh(bag.track(new THREE.SphereGeometry(1, 20, 14)), this.shieldMat, 200);
    this.shields.count = 0;
    this.shields.frustumCulled = false;
    this.shields.renderOrder = 7;
    this.shields.setColorAt(0, SHIELD);
    scene.add(this.shields);
  }

  update(dt: number, t: number) {
    const { sim, draw, fx, pal } = this.ctx;
    for (const b of this.bases.values()) b.n = 0;
    let nb = 0;
    let ns = 0;
    this.shieldMat.uniforms.uTime!.value = t;
    const p = sim.player;
    const k = 1 - Math.exp(-10 * dt);
    for (const e of sim.enemies) {
      if (!e.active || e.isBoss) continue;
      const i = e.idx;
      const rw = e.r * S;
      const x = e.x * S;
      const z = e.y * S;
      intColor(e.arch.color, c1);
      if (e.rival) c1.lerp(RED, 0.25);

      // spawn detection -> ring + rising motes
      if (this.slotUid[i] !== e.uid) {
        this.slotUid[i] = e.uid;
        this.yaw[i] = -Math.atan2(p.y - e.y, p.x - e.x);
        this.roll[i] = 0;
        if (!e.tide) {
          fx.ring(x, z, rw * 3.2, c1, 0.55, 0.2, e.elite ? 2.5 : 1.6);
          for (let j = 0; j < 5; j++)
            fx.spawn({ kind: PK.glow, x: x + (Math.random() - 0.5) * rw * 2, y: 0.1, z: z + (Math.random() - 0.5) * rw * 2, vy: 2 + Math.random() * 3, life: 0.5, s0: rw * 0.7, s1: 0, r: c1.r * 2, g: c1.g * 2, b: c1.b * 2, drag: 1 });
        }
      }
      const spawnK = 1 - Math.min(1, e.spawnT / 0.6);
      const speed = Math.hypot(e.vx, e.vy);
      if (speed > 1) {
        const target = -Math.atan2(e.vy, e.vx);
        this.yaw[i] = this.yaw[i]! + wrapAngle(target - this.yaw[i]!) * k;
      }
      let yaw = this.yaw[i]!;
      let pitch = 0;
      let roll = 0;
      let y = rw * 1.05;
      let sx = 1;
      let sy = 1;
      let sz = 1;
      let boost = e.elite ? 0.3 : 0;
      let crack = 0;
      const base = e.rival ? "shooter" : e.arch.base;
      switch (base) {
        case "chaser":
          roll = t * 5 + i;
          pitch = 0;
          y += Math.sin(t * 6 + i) * rw * 0.08;
          break;
        case "swarmer":
          y += rw * 0.6 + Math.sin(t * 9 + i * 1.7) * rw * 0.35;
          roll = Math.sin(t * 7 + i) * 0.5;
          break;
        case "shooter":
          y = rw * 1.1;
          yaw = t * 0.6 + i;
          break;
        case "charger":
          if (e.state === 1) {
            // crouch: nose down, glowing harder
            y = rw * 0.75;
            sy = 0.82;
            roll = 0;
            pitch = 0;
            boost += 0.6 + 0.6 * Math.sin(t * 40);
            yaw = -Math.atan2(e.dirY, e.dirX);
            this.yaw[i] = yaw;
          } else if (e.state === 2) {
            sx = 1.25;
            sz = 0.85;
            boost += 0.8;
          }
          break;
        case "splitter":
          crack = e.maxHp > 0 ? Math.max(0, 1 - e.hp / e.maxHp) : 0;
          y += Math.sin(t * 3 + i) * rw * 0.1;
          roll = t * 0.8 + i;
          break;
        case "orbiter":
          y += rw * 0.4;
          yaw = t * 6 + i;
          break;
        case "tank": {
          // roll along the ground as it moves
          this.roll[i] = (this.roll[i]! + (speed * S * dt) / Math.max(0.1, rw)) % TAU;
          roll = 0;
          pitch = 0;
          break;
        }
      }
      if (e.arch.modifiers.has("explodes")) {
        const pulse = 0.5 + 0.5 * Math.sin(t * 9 + i);
        boost += pulse * 0.9;
        draw.glow.push(x, y, z, rw * 2.2, rw * 2.2, 2.2 * pulse, 0.6 * pulse, 0.2 * pulse, 0.9);
      }
      y -= (1 - spawnK) * rw * 2.2;
      const s = rw * 1.12 * (0.55 + 0.45 * spawnK);
      const bm = this.bases.get(base)!;
      const n = bm.n++;
      if (base === "tank") {
        // rolling: rotate about the axis perpendicular to motion
        eu.set(0, yaw, 0, "YXZ");
        qt.setFromEuler(eu);
        qr.setFromAxisAngle(ZAXIS, -this.roll[i]!);
        qt.multiply(qr);
        m4.compose(v3.set(x, y, z), qt, sc.set(s, s, s));
      } else {
        compose(x, y, z, roll, yaw, pitch, s * sx, s * sy, s * sz, "YZX");
      }
      bm.mesh.setMatrixAt(n, m4);
      const bright = e.elite ? 1.35 : 1;
      c2.copy(c1).multiplyScalar(bright);
      bm.mesh.setColorAt(n, c2);
      const fxa = bm.fx;
      fxa[n * 4] = Math.min(e.alpha, 0.25 + 0.75 * spawnK);
      fxa[n * 4 + 1] = boost;
      fxa[n * 4 + 2] = e.flash > 0 ? 1.2 : 0;
      fxa[n * 4 + 3] = crack;

      // grounding blob + elite halo
      if (e.alpha > 0.3) draw.dot.push(x, 0.02, z, rw * 2.4, rw * 2.4, 0, 0, 0, 0.32 * spawnK);
      if (e.elite) {
        draw.ring.push(x, 0.04, z, rw * 3.4, rw * 3.4, pal.glow.r * 2, pal.glow.g * 2, pal.glow.b * 2, 0.9 * e.alpha, t * 2);
        draw.groundGlow.push(x, 0.03, z, rw * 4.5, rw * 4.5, pal.glow.r, pal.glow.g, pal.glow.b, 0.35 * e.alpha);
        if (e.hp < e.maxHp) draw.bar.push(x, y + rw * 1.9 + 0.3, z, Math.max(0.9, rw * 2.6), 0.16, pal.glow.r * 1.5, pal.glow.g * 1.5, pal.glow.b * 1.5, 1, Math.max(0, e.hp / e.maxHp));
      }
      if (e.rival) {
        draw.ring.push(x, 0.05, z, rw * 4, rw * 4, 2.5, 0.3, 0.5, 0.6 + 0.3 * Math.sin(t * 8));
        draw.bar.push(x, y + rw * 2 + 0.4, z, 1.8, 0.2, 2.2, 0.35, 0.5, 1, Math.max(0, e.hp / e.maxHp));
      }
      if (base === "shooter" && nb < MAX_ENEMIES) {
        const aim = -Math.atan2(p.y - e.y, p.x - e.x);
        compose(x, y + s * 0.05, z, 0, aim, 0, s, s, s);
        this.barrels.setMatrixAt(nb, m4);
        this.barrels.setColorAt(nb, c2);
        nb++;
      }
      if (base === "charger" && e.state === 1) {
        const len = 240 * S;
        const a = Math.atan2(e.dirY, e.dirX);
        const on = Math.sin(t * 40) > 0 ? 1 : 0.45;
        draw.chevron.push(x + Math.cos(a) * len * 0.55, 0.06, z + Math.sin(a) * len * 0.55, len, rw * 2.2, c1.r * 2.5 * on, c1.g * 2.5 * on, c1.b * 2.5 * on, 0.9, -a);
      }
      if (e.shield > 0 && ns < 200) {
        const r = rw * 1.75;
        compose(x, y, z, 0, t, 0, r, r, r);
        this.shields.setMatrixAt(ns, m4);
        c2.copy(SHIELD).multiplyScalar(0.6 + 0.25 * e.shield);
        this.shields.setColorAt(ns, c2);
        ns++;
      }
    }
    for (const b of this.bases.values()) {
      b.mesh.count = b.n;
      b.xray.count = b.n;
      if (b.n) {
        b.mesh.instanceMatrix.needsUpdate = true;
        b.mesh.instanceColor!.needsUpdate = true;
        b.fxAttr.clearUpdateRanges();
        b.fxAttr.addUpdateRange(0, b.n * 4);
        b.fxAttr.needsUpdate = true;
      }
    }
    this.barrels.count = nb;
    if (nb) {
      this.barrels.instanceMatrix.needsUpdate = true;
      this.barrels.instanceColor!.needsUpdate = true;
    }
    this.shields.count = ns;
    if (ns) {
      this.shields.instanceMatrix.needsUpdate = true;
      this.shields.instanceColor!.needsUpdate = true;
    }
  }
}

/** The player's hover-ship: banking, thrusters, shield bubble, i-frame flicker. */
export class PlayerModel {
  readonly group = new THREE.Group();
  readonly ship: THREE.Mesh;
  readonly geometry: THREE.BufferGeometry;
  private readonly xray: THREE.Mesh;
  private readonly shield: THREE.Mesh;
  private readonly glow: GlowUniforms;
  readonly light: THREE.PointLight;
  private bank = 0;
  private pitch = 0;
  private lastFacing = 0;
  private thrustAcc = 0;
  /** smoothed world position (for camera / labels) */
  readonly pos = new THREE.Vector3();
  height = 0.75;

  constructor(private readonly ctx: LayerCtx) {
    const { bag, pal, scene } = ctx;
    this.geometry = bag.track(shipGeometry(pal.player, pal.accent, mixC(pal.glow, WHITE, 0.3)));
    const mat = bag.track(glowMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.35, metalness: 0.35 }, { emissive: 0.12, rim: 0.8, vertexGlow: true }));
    this.glow = mat.glow;
    this.ship = new THREE.Mesh(this.geometry, mat);
    this.ship.castShadow = true;
    this.xray = new THREE.Mesh(this.geometry, bag.track(xrayMaterial(mixC(pal.player, pal.accent, 0.4))));
    this.xray.renderOrder = 9;
    (this.xray.material as THREE.MeshBasicMaterial).opacity = 0.55;
    const smat = bag.track(bubbleMaterial());
    smat.uniforms.uColor!.value = SHIELD.clone();
    this.shield = new THREE.Mesh(bag.track(new THREE.SphereGeometry(1, 24, 16)), smat);
    this.shield.renderOrder = 7;
    this.group.add(this.ship, this.xray, this.shield);
    this.light = new THREE.PointLight(mixC(pal.player, pal.glow, 0.6), 3, 9, 1.6);
    this.light.position.set(0, 2.2, 0);
    this.group.add(this.light);
    scene.add(this.group);
    const p = ctx.sim.player;
    this.pos.set(p.x * S, this.height, p.y * S);
    this.lastFacing = p.facing;
  }

  update(dt: number, t: number, reduced: boolean) {
    const { sim, draw, fx, pal } = this.ctx;
    const p = sim.player;
    const alive = p.alive;
    this.group.visible = alive;
    if (!alive) return;
    const x = p.x * S;
    const z = p.y * S;
    const bob = reduced ? 0 : Math.sin(t * 2.4) * 0.06;
    this.pos.set(x, this.height + bob, z);
    // bank into turns (facing angular velocity) and strafes
    const df = dt > 0 ? wrapAngle(p.facing - this.lastFacing) / dt : 0;
    this.lastFacing = p.facing;
    const speed = sim.build.moveSpeed || 1;
    const lat = (-Math.sin(p.facing) * p.vx + Math.cos(p.facing) * p.vy) / speed;
    const fwd = (Math.cos(p.facing) * p.vx + Math.sin(p.facing) * p.vy) / speed;
    const targetBank = Math.max(-0.6, Math.min(0.6, -lat * 0.45 - df * 0.05));
    const targetPitch = Math.max(-0.25, Math.min(0.25, -fwd * 0.12));
    const k = 1 - Math.exp(-8 * dt);
    this.bank += (targetBank - this.bank) * k;
    this.pitch += (targetPitch - this.pitch) * k;
    const yaw = -p.facing;
    const dashing = p.dashT > 0;
    this.ship.position.copy(this.pos);
    this.ship.rotation.set(this.bank, yaw, this.pitch, "YXZ");
    const st = dashing ? 1.25 : 1;
    this.ship.scale.set(st, 1 / Math.sqrt(st), 1 / Math.sqrt(st));
    this.xray.position.copy(this.ship.position);
    this.xray.rotation.copy(this.ship.rotation);
    this.xray.scale.copy(this.ship.scale);
    const blink = p.iframes > 0 && !dashing && Math.sin(t * 45) > 0;
    this.glow.uFx.value.set(blink ? 0.4 : 1, dashing ? 0.6 : 0, p.hurtFlash > 0 ? 1.8 : 0, 0);
    this.glow.uTime.value = t;
    // shield bubble
    this.shield.visible = p.shieldHits > 0;
    if (this.shield.visible) {
      const r = 1.15 + 0.04 * Math.sin(t * 6);
      this.shield.position.copy(this.pos);
      this.shield.scale.set(r, r * 0.8, r);
      (this.shield.material as THREE.ShaderMaterial).uniforms.uTime!.value = t;
      (this.shield.material as THREE.ShaderMaterial).uniforms.uColor!.value.copy(SHIELD).multiplyScalar(0.7 + 0.2 * p.shieldHits);
    }
    this.light.intensity = sim.blackoutT > 0 ? 12 : 3;
    this.light.position.set(this.pos.x, this.pos.y + 1.5, this.pos.z);
    this.light.distance = sim.blackoutT > 0 ? 14 : 9;
    // under-glow + engine plume
    draw.groundGlow.push(x, 0.03, z, 2.6, 2.6, pal.player.r * 0.5, pal.player.g * 0.5, pal.player.b * 0.5, 0.8);
    draw.dot.push(x, 0.02, z, 1.4, 1.4, 0, 0, 0, 0.4);
    const cf = Math.cos(p.facing);
    const sf = Math.sin(p.facing);
    for (const side of [-1, 1]) {
      const ex = x - cf * 1.0 - sf * 0.22 * side;
      const ez = z - sf * 1.0 + cf * 0.22 * side;
      const thr = 0.45 + (p.moving ? 0.35 : 0) + (dashing ? 0.8 : 0);
      draw.glow.push(ex, this.pos.y, ez, thr, thr, pal.glow.r * 3, pal.glow.g * 3, pal.glow.b * 3, 1);
    }
    this.thrustAcc += dt * (p.moving || dashing ? 40 : 14) * fx.quality;
    while (this.thrustAcc >= 1) {
      this.thrustAcc -= 1;
      const side = Math.random() < 0.5 ? -1 : 1;
      fx.spawn({
        kind: PK.glow,
        x: x - cf * 1.05 - sf * 0.22 * side,
        y: this.pos.y + (Math.random() - 0.5) * 0.05,
        z: z - sf * 1.05 + cf * 0.22 * side,
        vx: -cf * (4 + Math.random() * 3) + p.vx * S * 0.3,
        vy: Math.random() * 0.4,
        vz: -sf * (4 + Math.random() * 3) + p.vy * S * 0.3,
        life: 0.25 + Math.random() * 0.15,
        s0: 0.32,
        s1: 0.02,
        r: pal.glow.r * 2.5,
        g: pal.glow.g * 2.5,
        b: pal.glow.b * 2.5,
        drag: 4,
      });
    }
    if (dashing && dt > 0) {
      // speed lines streaming past the ship
      for (let k = 0; k < 4; k++) {
        const a = Math.random() * TAU;
        const rr = 0.5 + Math.random() * 1.2;
        fx.spawn({
          kind: PK.spark,
          x: x + Math.cos(a) * rr * 0.6 + cf * 1.5,
          y: this.pos.y + Math.sin(a) * rr * 0.5,
          z: z + Math.sin(a) * rr * 0.6 + sf * 1.5,
          vx: -p.dashDirX * 34,
          vy: 0,
          vz: -p.dashDirY * 34,
          life: 0.12,
          s0: 0.05,
          r: 1.6,
          g: 1.8,
          b: 2.2,
          a: 0.8,
          drag: 0,
          stretch: 0.06,
        });
      }
    }
    if (sim.timeSlowT > 0) draw.ring.push(x, 0.06, z, 3 + Math.sin(t * 4) * 0.2, 3 + Math.sin(t * 4) * 0.2, 0.5, 0.8, 1.6, 0.6, t);
  }

  get bankAngle() {
    return this.bank;
  }
}

/** Big composite boss with rotating parts, phase colours and telegraphs. */
export class BossModel {
  readonly group = new THREE.Group();
  private readonly core: THREE.Mesh;
  private readonly xray: THREE.Mesh;
  private readonly rings: THREE.Mesh[] = [];
  private readonly shards: THREE.InstancedMesh;
  private readonly glow: GlowUniforms;
  private readonly coreMat: THREE.MeshStandardMaterial;
  private readonly ringMat: THREE.MeshStandardMaterial & { glow: GlowUniforms };
  readonly light: THREE.PointLight;
  private scorchAcc = 0;
  private seen = 0;
  /** world position of the boss centre (for indicators / camera) */
  readonly pos = new THREE.Vector3();
  active = false;

  constructor(private readonly ctx: LayerCtx) {
    const { bag, scene, sim } = ctx;
    const spec = sim.world.boss;
    const geo = bag.track(enemyGeometry(spec.base));
    const mat = bag.track(glowMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.35, metalness: 0.3, flatShading: true }, { emissive: 0.12, rim: 0.8, vertexGlow: true }));
    this.coreMat = mat;
    this.glow = mat.glow;
    this.core = new THREE.Mesh(geo, mat);
    this.core.castShadow = true;
    this.xray = new THREE.Mesh(geo, bag.track(xrayMaterial()));
    this.xray.renderOrder = 9;
    this.group.add(this.core, this.xray);
    const ringGeo = bag.track(merge([part(new THREE.TorusGeometry(1, 0.04, 6, 64), 1, 1.8), part(new THREE.BoxGeometry(0.12, 0.12, 0.3), 1, 2.5, tf(1, 0, 0)), part(new THREE.BoxGeometry(0.12, 0.12, 0.3), 1, 2.5, tf(-1, 0, 0))]));
    this.ringMat = bag.track(glowMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.4 }, { emissive: 0.3, rim: 0.5, vertexGlow: true }));
    for (let i = 0; i < 3; i++) {
      const r = new THREE.Mesh(ringGeo, this.ringMat);
      this.rings.push(r);
      this.group.add(r);
    }
    const shardGeo = bag.track(merge([part(new THREE.OctahedronGeometry(1, 0), 1, 1.2, tf(0, 0, 0, 0, 0, 0, 0.5, 1.4, 0.5))]));
    this.shards = new THREE.InstancedMesh(shardGeo, this.ringMat, 10);
    this.shards.castShadow = true;
    this.shards.frustumCulled = false;
    this.group.add(this.shards);
    this.light = new THREE.PointLight(intColor(hexToInt(sim.world.boss.color), new THREE.Color()), 0, 22, 1.4);
    this.group.add(this.light);
    this.group.visible = false;
    scene.add(this.group);
  }

  update(dt: number, t: number) {
    const { sim, draw, fx } = this.ctx;
    const b = sim.boss;
    if (!b || !b.e.active) {
      this.active = false;
      this.group.visible = false;
      this.light.intensity = 0;
      return;
    }
    this.active = true;
    const e = b.e;
    if (this.seen !== e.uid) {
      this.seen = e.uid;
      intColor(e.arch.color, c1);
      fx.ring(e.x * S, e.y * S, e.r * S * 6, c1, 1.2, 0.05, 3);
    }
    this.group.visible = true;
    const rw = e.r * S;
    const x = e.x * S;
    const z = e.y * S;
    const spawnK = 1 - Math.min(1, e.spawnT / 1.2);
    const phaseK = b.phases > 1 ? (b.phase - 1) / (b.phases - 1) : 0;
    intColor(e.arch.color, c1).lerp(RED, phaseK * 0.45);
    const pulse = 0.5 + 0.5 * Math.sin(t * (2 + b.phase * 1.5));
    const y = rw * 1.15 - (1 - spawnK) * rw * 2.6 + Math.sin(t * 1.4) * rw * 0.06;
    this.pos.set(x, y, z);
    const s = rw * 1.1 * (1 + 0.03 * Math.sin(t * 3));
    if (e.vx || e.vy) e.renderAng = Math.atan2(e.vy, e.vx);
    const yaw = e.arch.base === "orbiter" ? t * 1.5 : -e.renderAng;
    this.core.position.set(x, y, z);
    this.core.rotation.set(0, yaw, e.arch.base === "tank" ? t * 0.4 : 0, "YXZ");
    this.core.scale.setScalar(s);
    this.xray.position.copy(this.core.position);
    this.xray.rotation.copy(this.core.rotation);
    this.xray.scale.copy(this.core.scale);
    this.coreMat.color.copy(c1);
    (this.xray.material as THREE.MeshBasicMaterial).color.copy(c1);
    this.glow.uFx.value.set(Math.min(1, 0.3 + spawnK), 0.04 + pulse * 0.12 * b.phase, e.flash > 0 ? 0.3 : 0, phaseK * 0.5);
    this.glow.uTime.value = t;
    this.ringMat.color.copy(c1).lerp(WHITE, 0.2);
    for (let i = 0; i < 3; i++) {
      const r = this.rings[i]!;
      r.visible = i < b.phase;
      const rr = rw * (1.75 + i * 0.4);
      r.position.set(x, y, z);
      r.rotation.set(Math.PI / 2 + Math.sin(t * 0.7 + i) * (0.35 + i * 0.15), t * (0.8 + i * 0.5) * (i % 2 ? -1 : 1), 0, "YXZ");
      r.scale.setScalar(rr);
    }
    const ns = 4 + b.phase * 2;
    this.shards.count = ns;
    for (let i = 0; i < ns; i++) {
      const a = (i / ns) * TAU + t * (0.9 + b.phase * 0.3);
      const R = rw * 2.4;
      compose(x + Math.cos(a) * R, y + Math.sin(t * 2 + i) * rw * 0.4, z + Math.sin(a) * R, 0, -a, t * 2 + i, rw * 0.22, rw * 0.22, rw * 0.22);
      this.shards.setMatrixAt(i, m4);
    }
    this.shards.instanceMatrix.needsUpdate = true;
    this.light.color.copy(c1);
    this.light.position.set(x, y + rw, z);
    this.light.intensity = (8 + pulse * 6) * spawnK;
    // ground presence
    draw.groundGlow.push(x, 0.04, z, rw * 7, rw * 7, c1.r * 0.9, c1.g * 0.9, c1.b * 0.9, 0.7);
    draw.dot.push(x, 0.02, z, rw * 3, rw * 3, 0, 0, 0, 0.5);
    for (let i = 0; i < b.phase; i++) draw.ring.push(x, 0.05, z, rw * (3.2 + i * 0.7), rw * (3.2 + i * 0.7), i === b.phase - 1 ? 2.5 : c1.r * 2, i === b.phase - 1 ? 0.4 : c1.g * 2, i === b.phase - 1 ? 0.6 : c1.b * 2, 0.7, t * (i % 2 ? -1 : 1));

    // charge telegraph: long flickering arrow
    if (e.state === 1) {
      const a = Math.atan2(e.dirY, e.dirX);
      const len = 700 * S;
      const on = Math.sin(t * 40) > 0 ? 1 : 0.4;
      draw.chevron.push(x + Math.cos(a) * len * 0.5, 0.07, z + Math.sin(a) * len * 0.5, len, rw * 1.6, 3 * on, 0.35 * on, 0.5 * on, 0.85, -a);
      draw.groundGlow.push(x + Math.cos(a) * len * 0.5, 0.05, z + Math.sin(a) * len * 0.5, len, rw * 1.6, 1.2 * on, 0.1, 0.2, 0.35, -a);
    }
    const L = b.laser;
    if (L) {
      for (let kb = 0; kb < L.beams; kb++) {
        const a = L.angle + kb * Math.PI;
        const len = 1100 * S;
        const x2 = x + Math.cos(a) * len;
        const z2 = z + Math.sin(a) * len;
        if (L.mode === "tele") {
          const on = Math.sin(t * 36) > 0 ? 1 : 0.3;
          fx.beam(x, 0.25, z, x2, 0.25, z2, 0.06, 3 * on, 0.3 * on, 0.5 * on);
          const a2 = a + L.rot * 0.45;
          draw.chevron.push(x + Math.cos(a2) * 8, 0.07, z + Math.sin(a2) * 8, 12, 1.4, 2 * on, 0.25, 0.4, 0.5, -a2);
        } else {
          const by = Math.max(0.6, y * 0.6);
          fx.beam(x, by, z, x2, by, z2, 0.75, c1.r * 1.8, c1.g * 1.8, c1.b * 1.8);
          fx.beam(x, by, z, x2, by, z2, 0.22, 2.2, 2.2, 2.2);
          draw.groundGlow.push((x + x2) / 2, 0.05, (z + z2) / 2, len, 3.2, c1.r * 1.5, c1.g * 1.5, c1.b * 1.5, 0.8, -a);
          this.scorchAcc += dt;
          while (this.scorchAcc > 0.05) {
            this.scorchAcc -= 0.05;
            const d = 3 + Math.random() * (len - 3);
            const sx = x + Math.cos(a) * d;
            const sz = z + Math.sin(a) * d;
            fx.scorch(sx, sz, 0.9 + Math.random() * 0.6, 4);
            fx.spawn({ kind: PK.spark, x: sx, y: 0.1, z: sz, vx: (Math.random() - 0.5) * 6, vy: 3 + Math.random() * 4, vz: (Math.random() - 0.5) * 6, life: 0.4, s0: 0.08, r: c1.r * 3, g: c1.g * 3, b: c1.b * 3, grav: -12 });
          }
        }
      }
    }
  }
}

/** Player shots, lobs, orbitals and enemy bullets. */
export class BulletLayer {
  private readonly bolts: THREE.InstancedMesh;
  private readonly lobs: THREE.InstancedMesh;
  private readonly orbs: THREE.InstancedMesh;
  private readonly blades: THREE.InstancedMesh;

  constructor(private readonly ctx: LayerCtx) {
    const { bag, scene } = ctx;
    const hdr = () => bag.track(new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: true }));
    const capsule = bag.track(new THREE.CapsuleGeometry(0.5, 1, 3, 8));
    capsule.rotateZ(-Math.PI / 2);
    this.bolts = new THREE.InstancedMesh(capsule, hdr(), 700);
    this.lobs = new THREE.InstancedMesh(bag.track(new THREE.IcosahedronGeometry(1, 1)), hdr(), 200);
    this.orbs = new THREE.InstancedMesh(bag.track(new THREE.IcosahedronGeometry(1, 2)), hdr(), 700);
    this.blades = new THREE.InstancedMesh(bag.track(merge([part(new THREE.OctahedronGeometry(1, 0), 1, 0, tf(0, 0, 0, 0, 0, 0, 1.4, 0.25, 0.5))])), hdr(), 16);
    for (const m of [this.bolts, this.lobs, this.orbs, this.blades]) {
      m.count = 0;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.setColorAt(0, WHITE);
      m.renderOrder = 6;
      scene.add(m);
    }
  }

  update(_dt: number, t: number) {
    const { sim, draw, pal } = this.ctx;
    const pc = pal.player;
    let nb = 0;
    let nl = 0;
    for (const b of sim.pBullets) {
      if (!b.active) continue;
      const x = b.x * S;
      const z = b.y * S;
      if (b.kind === "lob") {
        const k = Math.min(1, Math.max(0, 1 - b.life / b.maxLife));
        const h = SHOT_H + Math.sin(k * Math.PI) * 4.2;
        const r = 0.28;
        compose(x, h, z, t * 6, t * 4, 0, r, r, r);
        this.lobs.setMatrixAt(nl, m4);
        c1.copy(pal.accent).lerp(WHITE, 0.4).multiplyScalar(3);
        this.lobs.setColorAt(nl, c1);
        nl++;
        draw.glow.push(x, h, z, 1.3, 1.3, pal.accent.r * 2, pal.accent.g * 2, pal.accent.b * 2, 0.9);
        draw.dot.push(x, 0.02, z, 0.9 - (h - SHOT_H) * 0.08, 0.9 - (h - SHOT_H) * 0.08, 0, 0, 0, 0.45);
        const ar = b.area * S * (0.6 + 0.4 * k);
        draw.ring.push(b.tx * S, 0.05, b.ty * S, ar * 2, ar * 2, pal.accent.r * 1.4, pal.accent.g * 1.4, pal.accent.b * 1.4, 0.35 + 0.4 * k);
        continue;
      }
      const sp = Math.hypot(b.vx, b.vy) || 1;
      const rw = b.r * S;
      const len = Math.max(0.5, rw * 4);
      compose(x, SHOT_H, z, 0, -b.angle, 0, len, rw * 1.4, rw * 1.4);
      this.bolts.setMatrixAt(nb, m4);
      if (b.crit) c1.setRGB(3, 2.6, 0.9);
      else c1.copy(pc).lerp(WHITE, 0.35).multiplyScalar(2.6);
      this.bolts.setColorAt(nb, c1);
      nb++;
      draw.spark.push(x, SHOT_H, z, Math.min(3.2, sp * S * 0.07), rw * 2.4, pal.glow.r * 1.6, pal.glow.g * 1.6, pal.glow.b * 1.6, 0.8, 0, b.vx, 0, b.vy);
      draw.glow.push(x, SHOT_H, z, rw * 6 * (b.crit ? 1.5 : 1), rw * 6 * (b.crit ? 1.5 : 1), pc.r * 1.2, pc.g * 1.2, pc.b * 1.2, 0.7);
    }
    this.bolts.count = nb;
    this.lobs.count = nl;

    let no = 0;
    for (const b of sim.eBullets) {
      if (!b.active) continue;
      const x = b.x * S;
      const z = b.y * S;
      const rw = b.r * S;
      const r = rw * 1.35;
      compose(x, SHOT_H, z, 0, 0, 0, r, r, r);
      this.orbs.setMatrixAt(no, m4);
      intColor(b.color, c2);
      c1.copy(c2).lerp(WHITE, 0.6).multiplyScalar(2.8);
      this.orbs.setColorAt(no, c1);
      no++;
      const pulse = 0.85 + 0.15 * Math.sin(t * 20 + no);
      draw.glow.push(x, SHOT_H, z, rw * 5.2 * pulse, rw * 5.2 * pulse, c2.r * 2.4, c2.g * 2.4, c2.b * 2.4, 0.95);
      // readable footprint on the floor: where the bullet is, how fast it comes
      draw.groundGlow.push(x, 0.035, z, rw * 4, rw * 4, c2.r * 1.4, c2.g * 1.4, c2.b * 1.4, 0.8);
      draw.dot.push(x, 0.025, z, rw * 2, rw * 2, 0, 0, 0, 0.5);
      draw.spark.push(x, SHOT_H, z, Math.min(2.2, Math.hypot(b.vx, b.vy) * S * 0.08), rw * 1.6, c2.r * 1.5, c2.g * 1.5, c2.b * 1.5, 0.55, 0, b.vx, 0, b.vy);
    }
    this.orbs.count = no;

    // orbitals
    let nbl = 0;
    const p = sim.player;
    if (p.alive) {
      for (const w of sim.build.weapons) {
        if (w.kind !== "orbitals") continue;
        const lay = orbitalLayout(w, sim.build.mods, sim.orbitT);
        for (let i = 0; i < lay.count && nbl < 16; i++) {
          const a = lay.angle0 + (i * TAU) / lay.count;
          const bx = (p.x + Math.cos(a) * lay.radius) * S;
          const bz = (p.y + Math.sin(a) * lay.radius) * S;
          const br = lay.bladeRadius * S;
          compose(bx, SHOT_H + 0.1, bz, 0, -a - Math.PI / 2, t * 12, br, br, br, "YXZ");
          this.blades.setMatrixAt(nbl, m4);
          c1.copy(pal.accent).lerp(WHITE, 0.35).multiplyScalar(2.6);
          this.blades.setColorAt(nbl, c1);
          nbl++;
          draw.glow.push(bx, SHOT_H + 0.1, bz, br * 4, br * 4, pal.accent.r * 1.4, pal.accent.g * 1.4, pal.accent.b * 1.4, 0.7);
          draw.groundGlow.push(bx, 0.04, bz, br * 3, br * 3, pal.accent.r, pal.accent.g, pal.accent.b, 0.6);
        }
      }
    }
    this.blades.count = nbl;
    for (const m of [this.bolts, this.lobs, this.orbs, this.blades]) {
      if (!m.count) continue;
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor!.needsUpdate = true;
    }
  }
}

interface ChestSlot {
  group: THREE.Group;
  pillar: THREE.Mesh;
  pmat: THREE.ShaderMaterial;
}

/** Gems, chests (with light pillars) and healing shrines. */
export class PickupLayer {
  private readonly gems: THREE.InstancedMesh;
  private readonly chests: ChestSlot[] = [];
  private readonly shrinePillars: { mesh: THREE.Mesh; mat: THREE.ShaderMaterial }[] = [];
  private readonly stones: THREE.InstancedMesh;

  constructor(private readonly ctx: LayerCtx) {
    const { bag, scene, pal } = ctx;
    const gmat = bag.track(glowMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.2, metalness: 0.3, flatShading: true }, { emissive: 0.25, rim: 0.8, vertexGlow: true }));
    this.gems = new THREE.InstancedMesh(bag.track(gemGeometry()), gmat, 400);
    this.gems.count = 0;
    this.gems.frustumCulled = false;
    this.gems.castShadow = true;
    this.gems.setColorAt(0, WHITE);
    this.gems.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.gems);
    const gold = new THREE.Color(0xffc23a);
    const cgeo = bag.track(chestGeometry(gold, mixC(pal.wall, pal.bg, 0.55)));
    const cmat = bag.track(glowMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.4, metalness: 0.4 }, { emissive: 0.15, rim: 0.7, vertexGlow: true }));
    const pgeo = bag.track(new THREE.CylinderGeometry(0.28, 0.42, 60, 12, 1, true));
    pgeo.translate(0, 30, 0);
    for (let i = 0; i < 6; i++) {
      const g = new THREE.Group();
      const mesh = new THREE.Mesh(cgeo, cmat);
      mesh.castShadow = true;
      g.add(mesh);
      const pmat = bag.track(pillarMaterial(mixC(pal.glow, gold, 0.5)));
      const pillar = new THREE.Mesh(pgeo, pmat);
      pillar.renderOrder = 8;
      pillar.frustumCulled = false;
      scene.add(pillar);
      g.visible = false;
      pillar.visible = false;
      scene.add(g);
      this.chests.push({ group: g, pillar, pmat });
    }
    for (let i = 0; i < 4; i++) {
      const mat = bag.track(pillarMaterial(new THREE.Color(0x7dffb0)));
      const mesh = new THREE.Mesh(pgeo, mat);
      mesh.visible = false;
      mesh.renderOrder = 8;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.shrinePillars.push({ mesh, mat });
    }
    this.stones = new THREE.InstancedMesh(bag.track(standingStoneGeometry()), bag.track(glowMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.8 }, { emissive: 0.05, rim: 0.4, vertexGlow: true })), 4 * 7);
    this.stones.count = 0;
    this.stones.castShadow = true;
    this.stones.frustumCulled = false;
    this.stones.setColorAt(0, WHITE);
    scene.add(this.stones);
  }

  update(dt: number, t: number) {
    const { sim, draw, fx, pal } = this.ctx;
    let n = 0;
    for (const g of sim.gems) {
      if (!g.active) continue;
      const x = g.x * S;
      const z = g.y * S;
      const big = g.value >= 20;
      const s = (g.value >= 20 ? 0.3 : g.value >= 5 ? 0.22 : 0.17) * Math.min(1, g.age * 5);
      const y = 0.45 + Math.sin(g.age * 4 + g.x) * 0.1 + (g.mag ? 0.25 : 0);
      compose(x, y, z, 0, g.age * 3 + g.x, 0, s, s, s);
      this.gems.setMatrixAt(n, m4);
      c1.copy(big ? pal.glow : pal.accent);
      this.gems.setColorAt(n, c1);
      n++;
      if (g.value >= 5 || g.mag) draw.glow.push(x, y, z, s * 3, s * 3, c1.r, c1.g, c1.b, g.mag ? 0.55 : 0.25);
      draw.groundGlow.push(x, 0.03, z, s * 3, s * 3, c1.r * 0.5, c1.g * 0.5, c1.b * 0.5, 0.5);
      if (g.mag && dt > 0) draw.spark.push(x, y, z, 0.8, 0.12, c1.r * 1.5, c1.g * 1.5, c1.b * 1.5, 0.7, 0, g.x - sim.player.x, 0, g.y - sim.player.y);
    }
    this.gems.count = n;
    if (n) {
      this.gems.instanceMatrix.needsUpdate = true;
      this.gems.instanceColor!.needsUpdate = true;
    }

    // chests
    for (let i = 0; i < this.chests.length; i++) {
      const slot = this.chests[i]!;
      const c = sim.chests[i];
      const on = !!c && c.active;
      slot.group.visible = on;
      slot.pillar.visible = on;
      if (!c || !on) continue;
      const x = c.x * S;
      const z = c.y * S;
      slot.group.position.set(x, Math.abs(Math.sin(c.age * 2.5)) * 0.15, z);
      slot.group.rotation.y = c.age * 0.6;
      slot.group.scale.setScalar(Math.min(1, c.age * 3) * 1.1);
      slot.pillar.position.set(x, 0, z);
      slot.pmat.uniforms.uTime!.value = t;
      slot.pmat.uniforms.uAlpha!.value = 0.8 + 0.2 * Math.sin(t * 3);
      draw.groundGlow.push(x, 0.04, z, 5, 5, pal.glow.r * 1.2, pal.glow.g * 1.2, pal.glow.b * 0.5, 0.9);
      draw.ring.push(x, 0.05, z, 3 + Math.sin(t * 3) * 0.3, 3 + Math.sin(t * 3) * 0.3, 2.4, 1.8, 0.6, 0.8, t);
      if (Math.random() < dt * 12) fx.spawn({ kind: PK.glow, x: x + (Math.random() - 0.5) * 1.2, y: 0.5, z: z + (Math.random() - 0.5) * 1.2, vy: 3 + Math.random() * 2, life: 0.9, s0: 0.25, s1: 0, r: 2.4, g: 1.9, b: 0.6, drag: 0.5 });
    }

    // shrines
    let ns = 0;
    for (let i = 0; i < this.shrinePillars.length; i++) {
      const sp = this.shrinePillars[i]!;
      const s = sim.shrines[i];
      const on = !!s && s.active;
      sp.mesh.visible = on;
      if (!s || !on) continue;
      const x = s.x * S;
      const z = s.y * S;
      const r = s.r * S;
      const fade = Math.min(1, s.life / 2, s.age * 2);
      const pulse = 0.5 + 0.5 * Math.sin(s.age * 3);
      sp.mesh.position.set(x, 0, z);
      sp.mesh.scale.set(1.2, 1, 1.2);
      sp.mat.uniforms.uTime!.value = t;
      sp.mat.uniforms.uAlpha!.value = fade * (0.7 + 0.3 * pulse);
      draw.groundGlow.push(x, 0.04, z, r * 2, r * 2, 0.25, 1.2, 0.6, (0.35 + pulse * 0.2) * fade);
      draw.ring.push(x, 0.05, z, r * 2, r * 2, 0.5, 2.2, 1.1, 0.9 * fade, s.age * 0.3);
      draw.ring.push(x, 0.05, z, r * 1.3, r * 1.3, 0.4, 1.8, 0.9, 0.5 * fade, -s.age * 0.5);
      for (let k = 0; k < 7 && ns < 28; k++) {
        const a = (k / 7) * TAU + 0.3;
        compose(x + Math.cos(a) * r * 0.92, 0, z + Math.sin(a) * r * 0.92, 0, -a, 0, 1, 0.6 + 0.4 * fade, 1);
        this.stones.setMatrixAt(ns, m4);
        this.stones.setColorAt(ns, c1.setRGB(0.5, 1.2, 0.8));
        ns++;
      }
      if (Math.random() < dt * 20 * fade) {
        const a = Math.random() * TAU;
        const d = Math.random() * r;
        fx.spawn({ kind: PK.glow, x: x + Math.cos(a) * d, y: 0.1, z: z + Math.sin(a) * d, vy: 1.5 + Math.random() * 2, life: 1.2, s0: 0.3, s1: 0, r: 0.4, g: 2, b: 1, drag: 0.3 });
      }
    }
    this.stones.count = ns;
    if (ns) {
      this.stones.instanceMatrix.needsUpdate = true;
      this.stones.instanceColor!.needsUpdate = true;
    }
  }
}

/** Ground hazards: puddles, telegraph rings, falling meteors + impact scorch. */
export class HazardLayer {
  private readonly meteors: THREE.InstancedMesh;
  private readonly prevActive = new Uint8Array(MAX_HAZARDS);
  private readonly prevKind: string[] = [];
  private readonly prevProgress = new Float32Array(MAX_HAZARDS);
  private readonly prevPos = new Float32Array(MAX_HAZARDS * 3);

  constructor(private readonly ctx: LayerCtx) {
    const { bag, scene } = ctx;
    this.meteors = new THREE.InstancedMesh(
      bag.track(merge([part(new THREE.IcosahedronGeometry(1, 0), 0.5, 0), part(new THREE.IcosahedronGeometry(0.8, 0), new THREE.Color(1, 0.55, 0.25), 3.5, tf(0.25, 0.22, 0.1, 0.5, 0.3, 0))])),
      bag.track(glowMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.9, flatShading: true }, { emissive: 0.05, rim: 1.4, vertexGlow: true })),
      MAX_HAZARDS,
    );
    this.meteors.count = 0;
    this.meteors.frustumCulled = false;
    this.meteors.castShadow = true;
    this.meteors.setColorAt(0, WHITE);
    scene.add(this.meteors);
  }

  update(dt: number, t: number) {
    const { sim, draw, fx } = this.ctx;
    let nm = 0;
    const hz = sim.hazards;
    for (let i = 0; i < hz.length; i++) {
      const h = hz[i]!;
      // detonation detection: the slot's fuse ran out (now inactive or recycled)
      const nowProgress = h.active && h.kind !== "puddle" ? h.t / Math.max(0.01, h.dur) : -1;
      if (this.prevActive[i] && this.prevKind[i] !== "puddle" && this.prevProgress[i]! > 0.8 && (!h.active || h.kind === "puddle" || nowProgress < this.prevProgress[i]! - 0.01)) {
        const x = this.prevPos[i * 3]!;
        const z = this.prevPos[i * 3 + 2]!;
        const r = this.prevPos[i * 3 + 1]!;
        fx.scorch(x, z, r * 1.1, this.prevKind[i] === "meteor" ? 8 : 5);
        if (this.prevKind[i] === "meteor") {
          c1.setRGB(1, 0.45, 0.15);
          for (let k = 0; k < 6; k++) fx.addDebris(x, 0.4, z, c1, 9, 0.12 + Math.random() * 0.15);
          for (let k = 0; k < 6; k++)
            fx.spawn({ kind: PK.smoke, x, y: 0.4, z, vx: (Math.random() - 0.5) * 4, vy: 1 + Math.random() * 2, vz: (Math.random() - 0.5) * 4, life: 1.4, s0: r, s1: r * 2.4, r: 0.12, g: 0.1, b: 0.09, a: 0.8, drag: 1.5 });
        }
      }
      this.prevActive[i] = h.active ? 1 : 0;
      if (!h.active) continue;
      this.prevKind[i] = h.kind;
      this.prevProgress[i] = h.kind === "puddle" ? 0 : Math.min(1, h.t / Math.max(0.01, h.dur));
      this.prevPos[i * 3] = h.x * S;
      this.prevPos[i * 3 + 1] = h.r * S;
      this.prevPos[i * 3 + 2] = h.y * S;
      const x = h.x * S;
      const z = h.y * S;
      const r = h.r * S;
      intColor(h.color, c1);
      if (h.kind === "puddle") {
        const fade = Math.min(1, (h.dur - h.t) / 0.6, h.t / 0.2);
        draw.puddle.push(x, 0.03, z, r * 2.2, r * 2.2, c1.r * 1.3, c1.g * 1.3, c1.b * 1.3, 0.6 * fade, i * 1.7);
        continue;
      }
      const k = Math.min(1, h.t / Math.max(0.01, h.dur));
      const flick = 0.55 + 0.45 * Math.sin(t * 30);
      draw.ring.push(x, 0.06, z, r * 2, r * 2, c1.r * 2.5, c1.g * 2.5, c1.b * 2.5, 0.5 + 0.5 * flick);
      draw.groundGlow.push(x, 0.045, z, r * 2 * k, r * 2 * k, c1.r * 1.6, c1.g * 1.6, c1.b * 1.6, 0.3 + 0.5 * k);
      if (h.kind === "meteor") {
        const fall = 1 - k;
        const mx = x + fall * 9;
        const my = 0.5 + fall * fall * 30 + fall * 4;
        const mz = z - fall * 6;
        const ms = Math.max(0.35, r * 0.35);
        compose(mx, my, mz, t * 3 + i, t * 2, 0, ms, ms, ms);
        this.meteors.setMatrixAt(nm, m4);
        this.meteors.setColorAt(nm, c2.setRGB(0.32, 0.17, 0.12));
        nm++;
        draw.glow.push(mx, my, mz, ms * 5, ms * 5, 2.6, 0.9, 0.25, 0.9);
        if (dt > 0)
          for (let q = 0; q < 2; q++)
            fx.spawn({ kind: q ? PK.smoke : PK.glow, x: mx + (Math.random() - 0.5) * ms, y: my, z: mz + (Math.random() - 0.5) * ms, vx: 2 + Math.random(), vy: 3, vz: -1.5, life: q ? 0.9 : 0.35, s0: q ? ms * 1.6 : ms * 2, s1: q ? ms * 3 : 0, r: q ? 0.15 : 2.6, g: q ? 0.12 : 1, b: q ? 0.1 : 0.3, a: q ? 0.6 : 1, drag: 1 });
      }
    }
    this.meteors.count = nm;
    if (nm) {
      this.meteors.instanceMatrix.needsUpdate = true;
      this.meteors.instanceColor!.needsUpdate = true;
    }
  }
}

