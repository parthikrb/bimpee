import * as THREE from "three";
import type { RoomPlayer } from "@bimpee/shared";
import { hashString } from "../logic/math";
import { S } from "./coords";
import { NameLabel } from "./labels";

const GHOST_COLORS = [0x7df9ff, 0xff7ad9, 0xb4ff6b, 0xffd166, 0xa98bff, 0xff9f6b];

interface Ghost {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  label: NameLabel;
  x: number;
  y: number;
  tx: number;
  ty: number;
  angle: number;
  alive: boolean;
}

/** Other players in a shared room: translucent ships with name labels, interpolated. */
export class GhostLayer {
  private readonly ghosts = new Map<string, Ghost>();
  private latest: RoomPlayer[] = [];
  private dirty = false;

  constructor(
    private readonly scene: THREE.Object3D,
    private readonly shipGeo: THREE.BufferGeometry,
  ) {}

  setPlayers(list: RoomPlayer[]) {
    this.latest = Array.isArray(list) ? list : [];
    this.dirty = true;
  }

  update(dt: number, t: number) {
    if (this.dirty) {
      this.dirty = false;
      const seen = new Set<string>();
      for (const p of this.latest) {
        if (!p || typeof p.id !== "string" || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        seen.add(p.id);
        let g = this.ghosts.get(p.id);
        if (!g) {
          const hex = GHOST_COLORS[hashString(p.id) % GHOST_COLORS.length]!;
          const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(1.4), transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending });
          const mesh = new THREE.Mesh(this.shipGeo, mat);
          mesh.renderOrder = 6;
          const label = new NameLabel(String(p.name ?? ""), `#${hex.toString(16).padStart(6, "0")}`);
          this.scene.add(mesh, label.sprite);
          g = { mesh, mat, label, x: p.x, y: p.y, tx: p.x, ty: p.y, angle: 0, alive: true };
          this.ghosts.set(p.id, g);
        }
        g.tx = p.x;
        g.ty = p.y;
        g.alive = p.alive !== false;
        g.label.set(String(p.name ?? ""));
      }
      for (const [id, g] of this.ghosts) {
        if (seen.has(id)) continue;
        this.remove(g);
        this.ghosts.delete(id);
      }
    }
    const k = 1 - Math.exp(-10 * dt);
    for (const g of this.ghosts.values()) {
      const dx = g.tx - g.x;
      const dy = g.ty - g.y;
      if (Math.abs(dx) + Math.abs(dy) > 1500) {
        g.x = g.tx;
        g.y = g.ty;
      } else {
        g.x += dx * k;
        g.y += dy * k;
      }
      if (Math.abs(dx) + Math.abs(dy) > 2) g.angle = Math.atan2(dy, dx);
      const y = 0.75 + Math.sin(t * 2.4 + g.x) * 0.06;
      g.mesh.position.set(g.x * S, y, g.y * S);
      g.mesh.rotation.set(0, -g.angle, 0);
      g.mat.opacity = g.alive ? 0.45 : 0.12;
      g.label.sprite.position.set(g.x * S, 2.2, g.y * S);
      g.label.opacity = g.alive ? 0.9 : 0.35;
    }
  }

  private remove(g: Ghost) {
    g.mesh.removeFromParent();
    g.mat.dispose();
    g.label.dispose();
  }

  dispose() {
    for (const g of this.ghosts.values()) this.remove(g);
    this.ghosts.clear();
  }
}
