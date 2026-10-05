import type * as Phaser from "phaser";
import type { RoomPlayer } from "@bimpee/shared";
import { hashString } from "../logic/math";
import { DEPTH } from "./entityRenderer";

const GHOST_COLORS = [0x7df9ff, 0xff7ad9, 0xb4ff6b, 0xffd166, 0xa98bff, 0xff9f6b];

interface Ghost {
  ship: Phaser.GameObjects.Image;
  label: Phaser.GameObjects.Text;
  x: number;
  y: number;
  tx: number;
  ty: number;
  angle: number;
  alive: boolean;
}

/** Other players in a shared room: translucent, interpolated, no collision. */
export class GhostSystem {
  private readonly ghosts = new Map<string, Ghost>();
  private latest: RoomPlayer[] = [];
  private dirty = false;

  constructor(private readonly scene: Phaser.Scene) {}

  setPlayers(list: RoomPlayer[]) {
    this.latest = Array.isArray(list) ? list : [];
    this.dirty = true;
  }

  update(dt: number) {
    if (this.dirty) {
      this.dirty = false;
      const seen = new Set<string>();
      for (const p of this.latest) {
        if (!p || typeof p.id !== "string" || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        seen.add(p.id);
        let g = this.ghosts.get(p.id);
        if (!g) {
          const color = GHOST_COLORS[hashString(p.id) % GHOST_COLORS.length]!;
          const ship = this.scene.add.image(p.x, p.y, "player").setDepth(DEPTH.ghosts).setTint(color).setAlpha(0.45).setScale(0.55);
          const label = this.scene.add
            .text(p.x, p.y - 30, String(p.name).slice(0, 24), {
              fontFamily: "ui-sans-serif, system-ui, sans-serif",
              fontSize: "13px",
              color: "#ffffff",
              stroke: "#000000",
              strokeThickness: 3,
            })
            .setOrigin(0.5)
            .setDepth(DEPTH.ghosts)
            .setAlpha(0.8);
          g = { ship, label, x: p.x, y: p.y, tx: p.x, ty: p.y, angle: 0, alive: true };
          this.ghosts.set(p.id, g);
        }
        g.tx = p.x;
        g.ty = p.y;
        g.alive = p.alive !== false;
        if (g.label.text !== p.name) g.label.setText(String(p.name).slice(0, 24));
      }
      for (const [id, g] of this.ghosts) {
        if (seen.has(id)) continue;
        g.ship.destroy();
        g.label.destroy();
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
      g.ship.setPosition(g.x, g.y).setRotation(g.angle).setAlpha(g.alive ? 0.45 : 0.15);
      g.label.setPosition(g.x, g.y - 30).setAlpha(g.alive ? 0.8 : 0.35);
    }
  }

  destroy() {
    for (const g of this.ghosts.values()) {
      g.ship.destroy();
      g.label.destroy();
    }
    this.ghosts.clear();
  }
}
