import * as THREE from "three";
import type { GameMap } from "../logic/mapgen";
import { springStep } from "./controls";
import { S } from "./coords";
import { cameraClearDistance } from "./occlusion";

export const CROSSHAIR_NDC_Y = 0.16;
const PITCH_MIN = 0.34;
const PITCH_MAX = 0.74;

export interface RigFrame {
  /** player position, world units */
  x: number;
  z: number;
  /** player velocity, world units/s */
  vx: number;
  vz: number;
  alive: boolean;
  dashing: boolean;
  /** pacing intensity 0..1 */
  intensity: number;
  reduced: boolean;
  /** extra yaw / pitch from input (radians) */
  yaw: number;
  pitch: number;
}

/**
 * Third-person chase camera: spring-follows the player from behind/above,
 * mouse-driven yaw + small pitch range, pulls in when walls block it,
 * intensity pull-back and tension, dash FOV kick, trauma screenshake.
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  yaw = -Math.PI / 2;
  pitch = 0.5;
  private readonly sx = { x: 0, v: 0 };
  private readonly sz = { x: 0, v: 0 };
  private dist = 11;
  private fovKick = 0;
  private trauma = 0;
  private shakeT = 0;
  private time = 0;
  private aspect = 1;
  private intensity = 0;
  private deathT = 0;
  private pitchLift = 0;
  readonly target = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();

  constructor(
    private readonly map: GameMap,
    private readonly wallTop: number,
    x: number,
    z: number,
  ) {
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.3, 2000);
    this.sx.x = x;
    this.sz.x = z;
    this.target.set(x, 1, z);
    this.update(0, { x, z, vx: 0, vz: 0, alive: true, dashing: false, intensity: 0, reduced: true, yaw: 0, pitch: 0 });
  }

  resize(w: number, h: number) {
    this.aspect = w / Math.max(1, h);
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
  }

  shake(amount: number, dur: number, reduced: boolean) {
    if (!Number.isFinite(amount)) return;
    const k = reduced ? 0.2 : 1;
    this.trauma = Math.min(1, this.trauma + amount * k);
    this.shakeT = Math.max(this.shakeT, Number.isFinite(dur) ? dur : 0);
  }

  kickFov(deg: number) {
    this.fovKick = Math.max(this.fovKick, deg);
  }

  update(dt: number, f: RigFrame) {
    this.time += dt;
    if (Number.isFinite(f.yaw)) this.yaw += f.yaw;
    if (Number.isFinite(f.pitch)) this.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, this.pitch + f.pitch * 0.6));
    if (!f.alive) {
      // slow memorial orbit after death
      this.deathT += dt;
      this.yaw += dt * 0.25;
    } else this.deathT = 0;
    this.intensity += ((Number.isFinite(f.intensity) ? f.intensity : 0) - this.intensity) * Math.min(1, dt * 1.5);

    const cy = Math.cos(this.yaw);
    const syaw = Math.sin(this.yaw);
    // the camera orbits a point just ahead of the player and looks further ahead,
    // so the player sits in the lower third and the horizon stays in frame
    const lead = f.alive ? 1.2 : 0;
    const tx = f.x + cy * lead + f.vx * 0.08;
    const tz = f.z + syaw * lead + f.vz * 0.08;
    springStep(this.sx, tx, 9, dt);
    springStep(this.sz, tz, 9, dt);
    if (dt === 0) {
      this.sx.x = tx;
      this.sz.x = tz;
    }
    const portrait = this.aspect < 1;
    const ty = 1.0;
    this.target.set(this.sx.x, ty, this.sz.x);

    const want = 10.5 + this.intensity * 2.2 + (portrait ? 3.5 : 0) + Math.min(6, this.deathT * 2);
    // camera collision: rise over walls first (keeps the view readable), pull in only if that fails
    let pitchGoal = this.pitch;
    for (let k = 0; k < 6; k++) {
      pitchGoal = Math.min(1.2, this.pitch + k * 0.14);
      if (this.clearance(cy, syaw, pitchGoal, want, ty) >= want - 0.05) break;
    }
    this.pitchLift += (pitchGoal - this.pitch - this.pitchLift) * Math.min(1, dt * (pitchGoal - this.pitch > this.pitchLift ? 9 : 2.2));
    if (dt === 0) this.pitchLift = pitchGoal - this.pitch;
    const pitch = Math.min(1.2, this.pitch + this.pitchLift);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const fit = Math.min(want, this.clearance(cy, syaw, pitch, want, ty));
    const rate = fit < this.dist ? 22 : 3;
    this.dist += (fit - this.dist) * Math.min(1, dt * rate);
    if (!(this.dist > 0) || !Number.isFinite(this.dist)) this.dist = fit;
    if (dt === 0) this.dist = fit;

    const cam = this.camera;
    cam.position.set(this.target.x - cy * cp * this.dist, ty + sp * this.dist, this.target.z - syaw * cp * this.dist);
    // look ahead less when the camera is pulled in, so the player stays in frame
    const ahead = f.alive ? 6.5 * Math.max(0.2, Math.min(1, this.dist / want)) * (1 - this.pitchLift * 0.8) : 0;
    this.look.set(this.target.x + cy * ahead, ty + (f.alive ? 0.2 : 0), this.target.z + syaw * ahead);
    cam.lookAt(this.look);

    // shake (trauma^2), along camera right/up, plus a hint of roll
    this.shakeT = Math.max(0, this.shakeT - dt);
    this.trauma = Math.max(0, this.trauma - dt * (this.shakeT > 0 ? 0.8 : 2.2));
    const mag = this.trauma * this.trauma;
    if (mag > 1e-4) {
      const t = this.time * 60;
      const ox = mag * 0.45 * (Math.sin(t * 1.3) * 0.6 + Math.sin(t * 2.9 + 1.7) * 0.4);
      const oy = mag * 0.45 * (Math.sin(t * 1.7 + 0.5) * 0.6 + Math.sin(t * 3.3 + 2.1) * 0.4);
      this.right.setFromMatrixColumn(cam.matrixWorld, 0);
      this.up.setFromMatrixColumn(cam.matrixWorld, 1);
      cam.position.addScaledVector(this.right, ox).addScaledVector(this.up, oy);
      cam.rotateZ(mag * 0.03 * Math.sin(t * 2.1));
    }
    // tension: dutch roll on intensity peaks (never with reduced motion)
    if (!f.reduced && this.intensity > 0.72) cam.rotateZ(Math.sin(this.time * 0.55) * 0.035 * Math.min(1, (this.intensity - 0.72) * 4));

    if (f.dashing && !f.reduced) this.kickFov(9);
    this.fovKick = Math.max(0, this.fovKick - dt * 30);
    const base = portrait ? 72 : 58;
    const fov = base + (f.reduced ? 0 : this.intensity * 4 + this.fovKick);
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov += (fov - cam.fov) * Math.min(1, dt * 12 || 1);
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
  }

  private clearance(cy: number, syaw: number, pitch: number, want: number, ty: number) {
    const cp = Math.cos(pitch);
    const camX = this.target.x - cy * cp * want;
    const camZ = this.target.z - syaw * cp * want;
    const camH = ty + Math.sin(pitch) * want;
    return cameraClearDistance(this.map, S, this.target.x / S, this.target.z / S, ty, camX / S, camZ / S, camH, this.wallTop, 0.4, 3.2);
  }

  /** Distance the camera currently sits from its target (world units). */
  get distance() {
    return this.dist;
  }
}

