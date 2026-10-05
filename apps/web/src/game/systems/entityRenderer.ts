import * as Phaser from "phaser";
import { BOSS_TEX_R, ENEMY_TEX_R } from "../fx/textures";
import { ImagePool } from "../fx/pools";
import { hexToInt, mixColor, TAU } from "../logic/math";
import { orbitalLayout } from "../logic/weapons";
import type { Sim } from "../sim/Sim";

export const DEPTH = {
  map: 0,
  puddle: 4,
  shrine: 6,
  gem: 10,
  enemyGlow: 18,
  enemy: 20,
  boss: 22,
  ghosts: 26,
  pbullet: 30,
  playerGlow: 38,
  player: 40,
  ebullet: 45,
  graphics: 47,
  particles: 50,
  numbers: 60,
  weather: 80,
  fog: 84,
  tint: 86,
  blackout: 90,
  vignette: 92,
  flash: 93,
  crt: 95,
  ui: 100,
} as const;

/**
 * Draws the simulation state every frame with pooled images
 * (enemies, bullets, gems, hazards, pickups, player, orbitals, boss telegraphs).
 */
export class EntityRenderer {
  private readonly glowPool: ImagePool;
  private readonly enemyPool: ImagePool;
  private readonly bossPool: ImagePool;
  private readonly ringPool: ImagePool;
  private readonly gemPool: ImagePool;
  private readonly puddlePool: ImagePool;
  private readonly pickupPool: ImagePool;
  private readonly pBulletPool: ImagePool;
  private readonly pGlowPool: ImagePool;
  private readonly eBulletGlow: ImagePool;
  private readonly eBulletPool: ImagePool;
  private readonly playerPool: ImagePool;
  readonly gfx: Phaser.GameObjects.Graphics;
  private readonly gfxUnder: Phaser.GameObjects.Graphics;
  private readonly lances: { x1: number; y1: number; x2: number; y2: number; w: number; color: number; t: number }[] = [];
  private readonly playerColor: number;
  private readonly accent: number;
  private readonly glowColor: number;
  private time = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly sim: Sim,
    private readonly bloom: number,
  ) {
    const ADD = Phaser.BlendModes.ADD;
    this.puddlePool = new ImagePool(scene, DEPTH.puddle);
    this.pickupPool = new ImagePool(scene, DEPTH.shrine);
    this.gemPool = new ImagePool(scene, DEPTH.gem);
    this.glowPool = new ImagePool(scene, DEPTH.enemyGlow, ADD);
    this.enemyPool = new ImagePool(scene, DEPTH.enemy);
    this.ringPool = new ImagePool(scene, DEPTH.enemy + 1, ADD);
    this.bossPool = new ImagePool(scene, DEPTH.boss);
    this.pGlowPool = new ImagePool(scene, DEPTH.pbullet - 1, ADD);
    this.pBulletPool = new ImagePool(scene, DEPTH.pbullet, ADD);
    this.playerPool = new ImagePool(scene, DEPTH.player);
    this.eBulletGlow = new ImagePool(scene, DEPTH.ebullet - 1, ADD);
    this.eBulletPool = new ImagePool(scene, DEPTH.ebullet);
    this.gfxUnder = scene.add.graphics().setDepth(DEPTH.puddle + 1);
    this.gfx = scene.add.graphics().setDepth(DEPTH.graphics);
    const pal = sim.world.theme.palette;
    this.playerColor = hexToInt(pal.player);
    this.accent = hexToInt(pal.accent);
    this.glowColor = hexToInt(pal.glow);
  }

  addLance(x1: number, y1: number, x2: number, y2: number, w: number, color: number) {
    if (this.lances.length > 40) this.lances.shift();
    this.lances.push({ x1, y1, x2, y2, w, color, t: 0 });
  }

  render(dt: number) {
    this.time += dt;
    const sim = this.sim;
    const pools = [
      this.glowPool,
      this.enemyPool,
      this.bossPool,
      this.ringPool,
      this.gemPool,
      this.puddlePool,
      this.pickupPool,
      this.pBulletPool,
      this.pGlowPool,
      this.eBulletGlow,
      this.eBulletPool,
      this.playerPool,
    ];
    for (const p of pools) p.begin();
    const g = this.gfx;
    const gu = this.gfxUnder;
    g.clear();
    gu.clear();
    const bloomA = 0.25 + this.bloom * 0.6;
    const t = this.time;

    // --- hazards (puddles under everything, telegraphs on top)
    for (const h of sim.hazards) {
      if (!h.active) continue;
      if (h.kind === "puddle") {
        const img = this.puddlePool.take("puddle", h.x, h.y);
        if (!img) continue;
        const fade = Math.min(1, (h.dur - h.t) / 0.6, h.t / 0.2);
        img.setScale((h.r * 2) / 64).setTint(h.color).setAlpha(0.42 * fade);
      } else {
        const k = Math.min(1, h.t / h.dur);
        const flick = 0.55 + 0.45 * Math.sin(t * 30);
        gu.fillStyle(h.color, 0.12 + 0.25 * k);
        gu.fillCircle(h.x, h.y, h.r * k);
        gu.lineStyle(2, h.color, 0.5 + 0.5 * flick);
        gu.strokeCircle(h.x, h.y, h.r);
        if (h.kind === "meteor") {
          // falling rock
          const img = this.pGlowPool.take("glow", h.x, h.y - (1 - k) * 420);
          if (img) img.setScale(0.5 + k * 0.3).setTint(h.color).setAlpha(0.9);
          const core = this.pBulletPool.take("dot", h.x, h.y - (1 - k) * 420);
          if (core) core.setScale(0.9).setTint(0xffe0b0);
        }
      }
    }

    // --- pickups
    for (const s of sim.shrines) {
      const pulse = 0.5 + 0.5 * Math.sin(s.age * 3);
      const img = this.pickupPool.take("shrine", s.x, s.y);
      if (img) img.setScale((s.r * 2) / 128).setTint(0x7dffb0).setAlpha(Math.min(1, s.life / 2) * (0.5 + pulse * 0.3)).setRotation(s.age * 0.3);
      gu.fillStyle(0x7dffb0, 0.08 + pulse * 0.06);
      gu.fillCircle(s.x, s.y, s.r);
      const gl = this.glowPool.take("glow", s.x, s.y);
      if (gl) gl.setScale((s.r * 2.2) / 128).setTint(0x7dffb0).setAlpha(0.35 * bloomA);
    }
    for (const c of sim.chests) {
      const bob = Math.sin(c.age * 3) * 4;
      const gl = this.glowPool.take("glow", c.x, c.y);
      if (gl) gl.setScale(1.2 + 0.2 * Math.sin(c.age * 4)).setTint(this.glowColor).setAlpha(0.6);
      this.pickupPool.take("chest", c.x, c.y + bob);
      // pointer arrow if far from player
      this.drawOffscreenArrow(c.x, c.y, this.glowColor);
    }

    // --- gems
    for (const gem of sim.gems) {
      if (!gem.active) continue;
      const s = gem.value >= 20 ? 1.4 : gem.value >= 5 ? 1.1 : 0.8;
      const pop = Math.min(1, gem.age * 6);
      const img = this.gemPool.take("gem", gem.x, gem.y + Math.sin(gem.age * 4 + gem.x) * 2);
      if (img) img.setScale(s * 0.7 * pop).setTint(gem.value >= 20 ? this.glowColor : this.accent);
      if (gem.value >= 5) {
        const gl = this.glowPool.take("glow", gem.x, gem.y);
        if (gl) gl.setScale(0.35 * s).setTint(this.accent).setAlpha(0.5 * bloomA);
      }
    }

    // --- enemies
    for (const e of sim.enemies) {
      if (!e.active) continue;
      const color = e.arch.color;
      const spawnK = e.isBoss ? 1 - Math.min(1, e.spawnT / 1.2) : 1 - Math.min(1, e.spawnT / 0.35);
      const alpha = e.alpha * (0.3 + 0.7 * spawnK);
      if (e.vx || e.vy) e.renderAng = Math.atan2(e.vy, e.vx);
      const ang = e.renderAng;
      if (e.isBoss) {
        this.drawBoss(e, alpha, bloomA);
        continue;
      }
      if (e.elite || this.bloom > 0.3) {
        const gl = this.glowPool.take("glow", e.x, e.y);
        if (gl) gl.setScale((e.r * (e.elite ? 5 : 3)) / 64).setTint(e.elite ? this.glowColor : color).setAlpha((e.elite ? 0.7 : 0.22 * bloomA) * alpha);
      }
      const body = this.enemyPool.take(`enemy_${e.arch.base}`, e.x, e.y);
      if (body) {
        let rot = ang;
        if (e.arch.base === "orbiter") rot = t * 4 + e.uid;
        else if (e.arch.base === "splitter" || e.arch.base === "tank") rot = ang * 0.3;
        body.setRotation(rot).setScale((e.r / ENEMY_TEX_R) * (0.4 + 0.6 * spawnK)).setAlpha(alpha);
        if (e.flash > 0) body.setTint(0xffffff).setTintMode(Phaser.TintModes.FILL);
        else body.setTint(e.rival ? mixColor(color, 0xff3366, 0.3) : color);
      }
      if (e.elite) {
        const ring = this.ringPool.take("ring", e.x, e.y);
        if (ring) ring.setScale((e.r * 1.6) / 56).setTint(this.glowColor).setAlpha(0.6 * alpha).setRotation(t * 2);
      }
      if (e.shield > 0) {
        const ring = this.ringPool.take("ring", e.x, e.y);
        if (ring) ring.setScale((e.r + 8) / 56).setTint(0x9fe8ff).setAlpha(0.35 + 0.15 * e.shield);
      }
      if (e.rival) {
        const ring = this.ringPool.take("ring", e.x, e.y);
        if (ring) ring.setScale((e.r * 2) / 56).setTint(0xff3366).setAlpha(0.5 + 0.3 * Math.sin(t * 8));
        this.drawHpBar(e.x, e.y - e.r - 12, e.r * 2.2, e.hp / e.maxHp, 0xff3366);
        this.drawOffscreenArrow(e.x, e.y, 0xff3366);
      } else if (e.elite && e.hp < e.maxHp) {
        this.drawHpBar(e.x, e.y - e.r - 10, e.r * 2, e.hp / e.maxHp, this.glowColor);
      }
      // charger telegraph
      if (e.arch.base === "charger" && e.state === 1) {
        const flick = Math.sin(t * 40) > 0 ? 0.8 : 0.35;
        g.lineStyle(3, color, flick);
        g.lineBetween(e.x, e.y, e.x + e.dirX * 240, e.y + e.dirY * 240);
      }
    }

    // --- player bullets
    for (const b of sim.pBullets) {
      if (!b.active) continue;
      if (b.kind === "lob") {
        const k = 1 - b.life / b.maxLife;
        const h = Math.sin(Math.min(1, k) * Math.PI) * 90;
        const sh = this.puddlePool.take("dot", b.x, b.y);
        if (sh) sh.setTint(0x000000).setAlpha(0.35).setScale(0.9 - h / 200);
        const gl = this.pGlowPool.take("glow", b.x, b.y - h);
        if (gl) gl.setScale(0.35).setTint(this.accent).setAlpha(0.8);
        const img = this.pBulletPool.take("lob", b.x, b.y - h);
        if (img) img.setTint(mixColor(this.accent, 0xffffff, 0.4)).setRotation(k * 8);
        // landing marker
        gu.lineStyle(1.5, this.accent, 0.35);
        gu.strokeCircle(b.tx, b.ty, b.area * (0.6 + 0.4 * k));
        continue;
      }
      const gl = this.pGlowPool.take("glow", b.x, b.y);
      if (gl) gl.setScale(0.28 * (b.crit ? 1.5 : 1)).setTint(this.playerColor).setAlpha(0.5 * bloomA + 0.2);
      const img = this.pBulletPool.take("bolt", b.x, b.y);
      if (img) img.setRotation(b.angle).setScale(b.r / 5).setTint(b.crit ? 0xffe066 : mixColor(this.playerColor, 0xffffff, 0.3));
    }

    // --- lances
    for (let i = this.lances.length - 1; i >= 0; i--) {
      const l = this.lances[i]!;
      l.t += dt;
      const k = l.t / 0.2;
      if (k >= 1) {
        this.lances.splice(i, 1);
        continue;
      }
      g.lineStyle(l.w * 2.2 * (1 - k), l.color, 0.25 * (1 - k));
      g.lineBetween(l.x1, l.y1, l.x2, l.y2);
      g.lineStyle(l.w * (1 - k * 0.7), l.color, 0.9 * (1 - k));
      g.lineBetween(l.x1, l.y1, l.x2, l.y2);
      g.lineStyle(Math.max(1, l.w * 0.3 * (1 - k)), 0xffffff, 1 - k);
      g.lineBetween(l.x1, l.y1, l.x2, l.y2);
    }

    // --- player
    const p = sim.player;
    if (p.alive) {
      for (const w of sim.build.weapons) {
        if (w.kind !== "orbitals") continue;
        const lay = orbitalLayout(w, sim.build.mods, sim.orbitT);
        for (let i = 0; i < lay.count; i++) {
          const a = lay.angle0 + (i * TAU) / lay.count;
          const bx = p.x + Math.cos(a) * lay.radius;
          const by = p.y + Math.sin(a) * lay.radius;
          const gl = this.pGlowPool.take("glow", bx, by);
          if (gl) gl.setScale((lay.bladeRadius * 3) / 64).setTint(this.accent).setAlpha(0.45 * bloomA + 0.15);
          const bl = this.pBulletPool.take("blade", bx, by);
          if (bl) bl.setRotation(a + t * 10).setScale((lay.bladeRadius * 2) / 36).setTint(mixColor(this.accent, 0xffffff, 0.35));
        }
      }
      const gl = this.playerPool.take("glow", p.x, p.y);
      if (gl) gl.setBlendMode(Phaser.BlendModes.ADD).setScale(1.1).setTint(this.playerColor).setAlpha(0.35 * bloomA + 0.15);
      const blink = p.iframes > 0 && p.dashT <= 0 && Math.sin(t * 50) > 0;
      const ship = this.playerPool.take("player", p.x, p.y);
      if (ship) {
        ship.setBlendMode(Phaser.BlendModes.NORMAL);
        ship.setRotation(p.facing).setScale(0.62).setAlpha(blink ? 0.45 : 1);
        if (p.hurtFlash > 0) ship.setTint(0xff3355).setTintMode(Phaser.TintModes.FILL);
        else ship.setTint(this.playerColor);
      }
      if (p.shieldHits > 0) {
        const sh = this.playerPool.take("ring", p.x, p.y);
        if (sh) sh.setBlendMode(Phaser.BlendModes.ADD).setScale(0.55 + 0.03 * Math.sin(t * 6)).setTint(0x9fe8ff).setAlpha(0.5 + 0.12 * p.shieldHits);
      }
      if (sim.timeSlowT > 0) {
        g.lineStyle(2, 0x9fd0ff, 0.3);
        g.strokeCircle(p.x, p.y, 40 + Math.sin(t * 4) * 4);
      }
      // dash cooldown arc
      if (p.dashCd > 0) {
        const k = 1 - p.dashCd / Math.max(0.01, sim.build.dashCooldown);
        g.lineStyle(2, this.playerColor, 0.5);
        g.beginPath();
        g.arc(p.x, p.y, 26, -Math.PI / 2, -Math.PI / 2 + k * TAU, false);
        g.strokePath();
      }
    }

    // --- enemy bullets (on top for readability)
    for (const b of sim.eBullets) {
      if (!b.active) continue;
      const gl = this.eBulletGlow.take("glow", b.x, b.y);
      if (gl) gl.setScale((b.r * 4.5) / 64).setTint(b.color).setAlpha(0.55 + 0.25 * bloomA);
      const img = this.eBulletPool.take("ebullet", b.x, b.y);
      if (img) img.setScale((b.r * 2.2) / 32).setTint(mixColor(b.color, 0xffffff, 0.55));
    }

    for (const p2 of pools) p2.end();
  }

  private drawBoss(e: Sim["enemies"][number], alpha: number, bloomA: number) {
    const sim = this.sim;
    const b = sim.boss;
    const t = this.time;
    const g = this.gfx;
    const color = e.arch.color;
    const gl = this.glowPool.take("glow", e.x, e.y);
    if (gl) gl.setScale((e.r * 4) / 64).setTint(color).setAlpha(0.5 * bloomA + 0.2);
    const body = this.bossPool.take(`boss_${e.arch.base}`, e.x, e.y);
    if (body) {
      const ang = e.renderAng;
      body.setRotation(e.arch.base === "orbiter" ? t * 1.5 : ang * 0.5).setScale((e.r / BOSS_TEX_R) * (1 + 0.03 * Math.sin(t * 3))).setAlpha(alpha);
      if (e.flash > 0) body.setTint(0xffffff).setTintMode(Phaser.TintModes.FILL);
      else body.setTint(color);
    }
    if (!b) return;
    for (let i = 0; i < b.phase; i++) {
      const ring = this.ringPool.take("ring", e.x, e.y);
      if (ring) ring.setScale((e.r * (1.35 + i * 0.25)) / 56).setTint(i === b.phase - 1 ? 0xff3355 : color).setAlpha(0.45).setRotation(t * (i % 2 ? -1 : 1));
    }
    this.drawOffscreenArrow(e.x, e.y, 0xff3355);
    // charge telegraph
    if (e.state === 1) {
      const flick = Math.sin(t * 40) > 0 ? 0.9 : 0.4;
      g.lineStyle(e.r * 0.8, 0xff3355, 0.15 * flick);
      g.lineBetween(e.x, e.y, e.x + e.dirX * 700, e.y + e.dirY * 700);
      g.lineStyle(3, 0xff3355, flick);
      g.lineBetween(e.x, e.y, e.x + e.dirX * 700, e.y + e.dirY * 700);
    }
    const L = b.laser;
    if (L) {
      for (let k = 0; k < L.beams; k++) {
        const a = L.angle + k * Math.PI;
        const x2 = e.x + Math.cos(a) * 1100;
        const y2 = e.y + Math.sin(a) * 1100;
        if (L.mode === "tele") {
          const flick = Math.sin(t * 36) > 0 ? 0.9 : 0.3;
          g.lineStyle(2, 0xff3355, flick);
          g.lineBetween(e.x, e.y, x2, y2);
          // show sweep direction
          const a2 = a + L.rot * 0.5;
          g.lineStyle(1, 0xff3355, 0.35);
          g.lineBetween(e.x, e.y, e.x + Math.cos(a2) * 600, e.y + Math.sin(a2) * 600);
        } else {
          g.lineStyle(34, color, 0.18);
          g.lineBetween(e.x, e.y, x2, y2);
          g.lineStyle(16, color, 0.65);
          g.lineBetween(e.x, e.y, x2, y2);
          g.lineStyle(6, 0xffffff, 0.95);
          g.lineBetween(e.x, e.y, x2, y2);
        }
      }
    }
  }

  private drawHpBar(x: number, y: number, w: number, frac: number, color: number) {
    const g = this.gfx;
    const f = Math.max(0, Math.min(1, frac));
    g.fillStyle(0x000000, 0.55);
    g.fillRect(x - w / 2 - 1, y - 1, w + 2, 6);
    g.fillStyle(color, 0.95);
    g.fillRect(x - w / 2, y, w * f, 4);
  }

  /** Arrow at the screen edge pointing to an important off-screen thing. */
  private drawOffscreenArrow(x: number, y: number, color: number) {
    const cam = this.scene.cameras.main;
    const v = cam.worldView;
    if (v.width <= 0) return;
    if (x > v.x && x < v.right && y > v.y && y < v.bottom) return;
    const cx = v.centerX;
    const cy = v.centerY;
    const a = Math.atan2(y - cy, x - cx);
    const hw = v.width / 2 - 36;
    const hh = v.height / 2 - 36;
    const s = Math.min(hw / Math.max(1e-3, Math.abs(Math.cos(a))), hh / Math.max(1e-3, Math.abs(Math.sin(a))));
    const ax = cx + Math.cos(a) * s;
    const ay = cy + Math.sin(a) * s;
    const g = this.gfx;
    g.fillStyle(color, 0.85);
    g.fillTriangle(
      ax + Math.cos(a) * 14,
      ay + Math.sin(a) * 14,
      ax + Math.cos(a + 2.4) * 10,
      ay + Math.sin(a + 2.4) * 10,
      ax + Math.cos(a - 2.4) * 10,
      ay + Math.sin(a - 2.4) * 10,
    );
  }

  destroy() {
    for (const p of [
      this.glowPool,
      this.enemyPool,
      this.bossPool,
      this.ringPool,
      this.gemPool,
      this.puddlePool,
      this.pickupPool,
      this.pBulletPool,
      this.pGlowPool,
      this.eBulletGlow,
      this.eBulletPool,
      this.playerPool,
    ])
      p.destroy();
    this.gfx.destroy();
    this.gfxUnder.destroy();
  }
}
