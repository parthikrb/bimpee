import type * as Phaser from "phaser";
import type { GameMap } from "../logic/mapgen";

/**
 * Smooth follow with look-ahead and trauma-based screenshake.
 * We drive the camera manually (centerOn) so overlays and aim math can use
 * the exact same centre and zoom.
 */
export class CameraRig {
  x: number;
  y: number;
  zoom = 1;
  private trauma = 0;
  private shakeT = 0;
  private time = 0;
  /** where the camera is actually centred this frame (incl. shake) */
  readonly center = { x: 0, y: 0 };

  constructor(
    private readonly cam: Phaser.Cameras.Scene2D.Camera,
    private readonly map: GameMap,
    startX: number,
    startY: number,
    private readonly reducedMotion: () => boolean,
  ) {
    this.x = startX;
    this.y = startY;
    this.center.x = startX;
    this.center.y = startY;
  }

  /** Recomputes zoom from viewport size (zoom out on small screens). */
  resize(w: number, h: number) {
    this.zoom = Math.max(0.6, Math.min(1, Math.min(w, h) / 820));
    this.cam.setZoom(this.zoom);
  }

  shake(amount: number, dur: number) {
    const k = this.reducedMotion() ? 0.2 : 1;
    this.trauma = Math.min(1, this.trauma + amount * k);
    this.shakeT = Math.max(this.shakeT, dur);
  }

  update(dt: number, tx: number, ty: number, vx: number, vy: number, facing: number) {
    this.time += dt;
    const look = 70;
    const gx = tx + Math.cos(facing) * look + vx * 0.12;
    const gy = ty + Math.sin(facing) * look + vy * 0.12;
    const k = 1 - Math.exp(-6 * dt);
    if (Number.isFinite(gx) && Number.isFinite(gy)) {
      this.x += (gx - this.x) * k;
      this.y += (gy - this.y) * k;
    }
    // clamp so we never show much beyond the arena
    const vw = this.cam.width / this.zoom;
    const vh = this.cam.height / this.zoom;
    const margin = 160;
    this.x = vw >= this.map.width + margin * 2 ? this.map.width / 2 : Math.max(vw / 2 - margin, Math.min(this.map.width - vw / 2 + margin, this.x));
    this.y = vh >= this.map.height + margin * 2 ? this.map.height / 2 : Math.max(vh / 2 - margin, Math.min(this.map.height - vh / 2 + margin, this.y));

    this.shakeT = Math.max(0, this.shakeT - dt);
    this.trauma = Math.max(0, this.trauma - dt * (this.shakeT > 0 ? 0.8 : 2.2));
    const mag = this.trauma * this.trauma * 26;
    const t = this.time * 60;
    const ox = mag * (Math.sin(t * 1.3) * 0.6 + Math.sin(t * 2.9 + 1.7) * 0.4);
    const oy = mag * (Math.sin(t * 1.7 + 0.5) * 0.6 + Math.sin(t * 3.3 + 2.1) * 0.4);
    this.center.x = this.x + ox;
    this.center.y = this.y + oy;
    this.cam.centerOn(this.center.x, this.center.y);
  }

  get viewW() {
    return this.cam.width / this.zoom;
  }
  get viewH() {
    return this.cam.height / this.zoom;
  }
}
