import type * as Phaser from "phaser";
import { ENEMY_BASES, type EnemyBase } from "@bimpee/shared";

/**
 * All textures are generated procedurally on canvases (no asset files).
 * Shapes are drawn white/grey so they can be colored with tints.
 */
type Draw = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

export function canvasTexture(scene: Phaser.Scene, key: string, w: number, h: number, draw: Draw): boolean {
  if (scene.textures.exists(key)) scene.textures.remove(key);
  const tex = scene.textures.createCanvas(key, Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)));
  if (!tex) return false;
  const ctx = tex.getContext();
  ctx.clearRect(0, 0, w, h);
  draw(ctx, w, h);
  tex.refresh();
  return true;
}

function radial(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, stops: [number, string][]) {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  for (const [o, c] of stops) g.addColorStop(o, c);
  ctx.fillStyle = g;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
}

function poly(ctx: CanvasRenderingContext2D, pts: [number, number][]) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

function regular(cx: number, cy: number, r: number, n: number, rot = 0): [number, number][] {
  return Array.from({ length: n }, (_, i) => {
    const a = rot + (i / n) * Math.PI * 2;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  });
}

/** Shape outline for each enemy base, pointing right (+x), radius R around (c,c). */
function enemyShape(ctx: CanvasRenderingContext2D, base: EnemyBase, c: number, R: number, boss: boolean) {
  switch (base) {
    case "chaser":
      poly(ctx, [
        [c + R, c],
        [c - R * 0.75, c - R * 0.8],
        [c - R * 0.4, c],
        [c - R * 0.75, c + R * 0.8],
      ]);
      break;
    case "swarmer":
      poly(ctx, [
        [c + R, c],
        [c, c - R * 0.6],
        [c - R * 0.8, c],
        [c, c + R * 0.6],
      ]);
      break;
    case "shooter":
      poly(ctx, regular(c, c, R * 0.85, 6, Math.PI / 6));
      break;
    case "charger":
      poly(ctx, [
        [c + R, c],
        [c - R * 0.2, c - R * 0.9],
        [c - R * 0.9, c - R * 0.5],
        [c - R * 0.3, c],
        [c - R * 0.9, c + R * 0.5],
        [c - R * 0.2, c + R * 0.9],
      ]);
      break;
    case "splitter":
      ctx.beginPath();
      ctx.arc(c, c, R * 0.88, 0, Math.PI * 2);
      ctx.closePath();
      break;
    case "orbiter": {
      const pts: [number, number][] = [];
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        const rr = i % 2 ? R * 0.45 : R;
        pts.push([c + Math.cos(a) * rr, c + Math.sin(a) * rr]);
      }
      poly(ctx, pts);
      break;
    }
    case "tank":
      poly(ctx, regular(c, c, R, 8, Math.PI / 8));
      break;
  }
  if (boss) {
    /* boss shapes get spikes drawn separately */
  }
}

function drawEnemy(ctx: CanvasRenderingContext2D, size: number, base: EnemyBase, boss: boolean) {
  const c = size / 2;
  const R = size * (boss ? 0.36 : 0.4);
  ctx.save();
  if (boss) {
    // spiked crown
    ctx.fillStyle = "#c8c8c8";
    const spikes = 12;
    const pts: [number, number][] = [];
    for (let i = 0; i < spikes * 2; i++) {
      const a = (i / (spikes * 2)) * Math.PI * 2;
      const rr = i % 2 ? R * 1.05 : R * 1.32;
      pts.push([c + Math.cos(a) * rr, c + Math.sin(a) * rr]);
    }
    poly(ctx, pts);
    ctx.fill();
  }
  // body
  enemyShape(ctx, base, c, R, boss);
  const g = ctx.createRadialGradient(c - R * 0.3, c - R * 0.3, R * 0.1, c, c, R * 1.1);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(1, "#b4b4b4");
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = Math.max(2, size * 0.04);
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
  // inner detail (darker = tint shows deeper shade)
  ctx.fillStyle = "rgba(40,40,40,0.55)";
  switch (base) {
    case "shooter":
      ctx.fillRect(c, c - R * 0.14, R * 1.05, R * 0.28);
      ctx.beginPath();
      ctx.arc(c, c, R * 0.35, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "splitter":
      ctx.fillRect(c - R * 0.06, c - R * 0.88, R * 0.12, R * 1.76);
      break;
    case "tank":
      poly(ctx, regular(c, c, R * 0.55, 8, Math.PI / 8));
      ctx.fill();
      break;
    case "orbiter":
      ctx.beginPath();
      ctx.arc(c, c, R * 0.25, 0, Math.PI * 2);
      ctx.fill();
      break;
    default:
      // eye
      ctx.beginPath();
      ctx.arc(c + R * 0.25, c, R * 0.18, 0, Math.PI * 2);
      ctx.fill();
  }
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(c + R * (base === "shooter" || base === "tank" || base === "orbiter" || base === "splitter" ? 0 : 0.28), c, R * 0.08, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export const ENEMY_TEX = 64;
/** shape radius in the enemy texture (sprite scale = r / this) */
export const ENEMY_TEX_R = ENEMY_TEX * 0.4;
export const BOSS_TEX = 192;
export const BOSS_TEX_R = BOSS_TEX * 0.36;

export function createTextures(scene: Phaser.Scene) {
  canvasTexture(scene, "white", 4, 4, (ctx) => {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 4, 4);
  });
  canvasTexture(scene, "dot", 32, 32, (ctx) =>
    radial(ctx, 16, 16, 16, [
      [0, "rgba(255,255,255,1)"],
      [0.4, "rgba(255,255,255,0.85)"],
      [1, "rgba(255,255,255,0)"],
    ]),
  );
  canvasTexture(scene, "glow", 128, 128, (ctx) =>
    radial(ctx, 64, 64, 64, [
      [0, "rgba(255,255,255,0.9)"],
      [0.25, "rgba(255,255,255,0.45)"],
      [0.6, "rgba(255,255,255,0.12)"],
      [1, "rgba(255,255,255,0)"],
    ]),
  );
  canvasTexture(scene, "spark", 32, 8, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 32, 0);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.7, "rgba(255,255,255,0.9)");
    g.addColorStop(1, "rgba(255,255,255,1)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(16, 4, 16, 3, 0, 0, Math.PI * 2);
    ctx.fill();
  });
  canvasTexture(scene, "ring", 128, 128, (ctx) => {
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(64, 64, 56, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 4;
    ctx.stroke();
  });
  canvasTexture(scene, "bolt", 40, 14, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 40, 0);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.5, "rgba(255,255,255,0.6)");
    g.addColorStop(1, "rgba(255,255,255,1)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(20, 7, 20, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.ellipse(31, 7, 8, 3, 0, 0, Math.PI * 2);
    ctx.fill();
  });
  canvasTexture(scene, "ebullet", 32, 32, (ctx) => {
    radial(ctx, 16, 16, 16, [
      [0, "rgba(255,255,255,1)"],
      [0.35, "rgba(255,255,255,1)"],
      [0.5, "rgba(200,200,200,0.9)"],
      [1, "rgba(200,200,200,0)"],
    ]);
  });
  canvasTexture(scene, "gem", 24, 30, (ctx) => {
    poly(ctx, [
      [12, 1],
      [23, 13],
      [12, 29],
      [1, 13],
    ]);
    ctx.fillStyle = "#d8d8d8";
    ctx.fill();
    poly(ctx, [
      [12, 1],
      [23, 13],
      [12, 13],
    ]);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    poly(ctx, [
      [1, 13],
      [12, 13],
      [12, 29],
    ]);
    ctx.fillStyle = "#9a9a9a";
    ctx.fill();
  });
  canvasTexture(scene, "player", 64, 64, (ctx) => {
    poly(ctx, [
      [60, 32],
      [14, 8],
      [22, 32],
      [14, 56],
    ]);
    const g = ctx.createLinearGradient(14, 0, 60, 0);
    g.addColorStop(0, "#c8c8c8");
    g.addColorStop(1, "#ffffff");
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    ctx.fillStyle = "rgba(30,30,30,0.6)";
    poly(ctx, [
      [44, 32],
      [30, 25],
      [30, 39],
    ]);
    ctx.fill();
    // engine
    radial(ctx, 18, 32, 8, [
      [0, "rgba(255,255,255,1)"],
      [1, "rgba(255,255,255,0)"],
    ]);
  });
  canvasTexture(scene, "blade", 40, 40, (ctx) => {
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(20, 20, 18, -0.2, Math.PI * 1.1);
    ctx.arc(14, 16, 13, Math.PI * 1.1, -0.2, true);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(20, 20, 4, 0, Math.PI * 2);
    ctx.fill();
  });
  canvasTexture(scene, "lob", 28, 28, (ctx) => {
    radial(ctx, 14, 14, 14, [
      [0, "#ffffff"],
      [0.55, "#e0e0e0"],
      [0.7, "rgba(255,255,255,0.5)"],
      [1, "rgba(255,255,255,0)"],
    ]);
  });
  canvasTexture(scene, "puddle", 64, 64, (ctx) => {
    radial(ctx, 32, 32, 32, [
      [0, "rgba(255,255,255,0.9)"],
      [0.7, "rgba(255,255,255,0.6)"],
      [1, "rgba(255,255,255,0)"],
    ]);
  });
  canvasTexture(scene, "chest", 56, 46, (ctx) => {
    ctx.fillStyle = "#b07a2a";
    ctx.fillRect(4, 16, 48, 28);
    ctx.fillStyle = "#d9a441";
    ctx.beginPath();
    ctx.moveTo(4, 18);
    ctx.quadraticCurveTo(28, -4, 52, 18);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#ffe08a";
    ctx.fillRect(4, 18, 48, 4);
    ctx.fillRect(25, 12, 6, 32);
    ctx.fillStyle = "#fff6c8";
    ctx.fillRect(24, 24, 8, 8);
    ctx.strokeStyle = "#5a3a10";
    ctx.lineWidth = 2;
    ctx.strokeRect(4, 16, 48, 28);
  });
  canvasTexture(scene, "shrine", 128, 128, (ctx) => {
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(64, 64, 60, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(64, 64, 48, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(64 + Math.cos(a) * 48, 64 + Math.sin(a) * 48);
      ctx.lineTo(64 + Math.cos(a + Math.PI * (2 / 3)) * 48, 64 + Math.sin(a + Math.PI * (2 / 3)) * 48);
      ctx.stroke();
    }
    // plus
    ctx.fillStyle = "#fff";
    ctx.fillRect(58, 44, 12, 40);
    ctx.fillRect(44, 58, 40, 12);
  });
  canvasTexture(scene, "vignette", 256, 256, (ctx) =>
    radial(ctx, 128, 128, 182, [
      [0, "rgba(0,0,0,0)"],
      [0.55, "rgba(0,0,0,0)"],
      [0.8, "rgba(0,0,0,0.55)"],
      [1, "rgba(0,0,0,1)"],
    ]),
  );
  canvasTexture(scene, "blackout", 512, 512, (ctx) => {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 512, 512);
    ctx.globalCompositeOperation = "destination-out";
    radial(ctx, 256, 256, 64, [
      [0, "rgba(0,0,0,1)"],
      [0.55, "rgba(0,0,0,0.9)"],
      [1, "rgba(0,0,0,0)"],
    ]);
    ctx.globalCompositeOperation = "source-over";
  });
  canvasTexture(scene, "scanlines", 4, 4, (ctx) => {
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, 2, 4, 2);
  });
  canvasTexture(scene, "fog", 256, 256, (ctx) => {
    // seamless: every blob is drawn wrapped
    let s = 1337;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 26; i++) {
      const x = rnd() * 256;
      const y = rnd() * 256;
      const r = 30 + rnd() * 70;
      const a = 0.08 + rnd() * 0.14;
      for (const ox of [-256, 0, 256])
        for (const oy of [-256, 0, 256])
          radial(ctx, x + ox, y + oy, r, [
            [0, `rgba(255,255,255,${a})`],
            [1, "rgba(255,255,255,0)"],
          ]);
    }
  });
  // weather particles
  canvasTexture(scene, "w_rain", 3, 26, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, 26);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(1, "rgba(255,255,255,0.9)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 3, 26);
  });
  canvasTexture(scene, "w_streak", 28, 3, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 28, 0);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(1, "rgba(255,255,255,0.9)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 28, 3);
  });
  canvasTexture(scene, "w_bubble", 20, 20, (ctx) => {
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(10, 10, 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.beginPath();
    ctx.arc(7, 7, 2, 0, Math.PI * 2);
    ctx.fill();
  });
  canvasTexture(scene, "w_static", 14, 2, (ctx) => {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 14, 2);
  });
  for (const base of ENEMY_BASES) {
    canvasTexture(scene, `enemy_${base}`, ENEMY_TEX, ENEMY_TEX, (ctx, w) => drawEnemy(ctx, w, base, false));
    canvasTexture(scene, `boss_${base}`, BOSS_TEX, BOSS_TEX, (ctx, w) => drawEnemy(ctx, w, base, true));
  }
}
