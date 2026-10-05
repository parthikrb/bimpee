import * as Phaser from "phaser";
import type { WorldSpec } from "@bimpee/shared";
import { hexToInt, mixColor } from "../logic/math";
import type { Sim } from "../sim/Sim";
import { DEPTH } from "./entityRenderer";

/**
 * Full-screen atmosphere: fog, biome tint wash, vignette, CRT scanlines,
 * blackout, hit flashes, low-hp pulse. All objects live in world space and
 * are re-fitted to the camera view each frame (zoom-safe).
 */
export class Overlays {
  private readonly fog: Phaser.GameObjects.TileSprite;
  private readonly tint: Phaser.GameObjects.Image;
  private readonly vignette: Phaser.GameObjects.Image;
  private readonly hurt: Phaser.GameObjects.Image;
  private readonly flash: Phaser.GameObjects.Image;
  private readonly slow: Phaser.GameObjects.Image;
  private readonly blackout: Phaser.GameObjects.Image;
  private readonly crt: Phaser.GameObjects.TileSprite | null;
  private fogAlpha: number;
  private fogTarget: number;
  private tintColor = 0xffffff;
  private tintAlpha = 0;
  private tintTarget = 0;
  private tintFrom = 0xffffff;
  private tintTo = 0xffffff;
  private tintK = 1;
  private flashA = 0;
  private blackoutA = 0;
  private themeVersion = 0;
  private time = 0;
  private fogW = 0;
  private fogH = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly world: WorldSpec,
  ) {
    const th = world.theme;
    const fogColor = mixColor(hexToInt(th.palette.background), 0xffffff, 0.45);
    this.fog = scene.add.tileSprite(0, 0, 256, 256, "fog").setDepth(DEPTH.fog).setTint(fogColor);
    this.fogAlpha = this.fogTarget = th.fog;
    this.tint = scene.add.image(0, 0, "white").setDepth(DEPTH.tint).setBlendMode(Phaser.BlendModes.MULTIPLY).setAlpha(0);
    this.slow = scene.add.image(0, 0, "white").setDepth(DEPTH.tint + 1).setBlendMode(Phaser.BlendModes.MULTIPLY).setTint(0x8fb4ff).setAlpha(0);
    this.blackout = scene.add.image(0, 0, "blackout").setDepth(DEPTH.blackout).setAlpha(0).setVisible(false);
    this.vignette = scene.add.image(0, 0, "vignette").setDepth(DEPTH.vignette).setAlpha(th.vignette * 0.85);
    this.hurt = scene.add.image(0, 0, "vignette").setDepth(DEPTH.vignette + 1).setTint(0xff1030).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0);
    this.flash = scene.add.image(0, 0, "white").setDepth(DEPTH.flash).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0);
    this.crt = th.crt ? scene.add.tileSprite(0, 0, 256, 256, "scanlines").setDepth(DEPTH.crt).setAlpha(0.2) : null;
  }

  flashColor(color: number, alpha: number) {
    this.flash.setTint(color);
    this.flashA = Math.min(0.8, Math.max(this.flashA, alpha));
  }

  update(dt: number, sim: Sim, cx: number, cy: number, w: number, h: number, reducedMotion: boolean) {
    this.time += dt;
    const W = w * 1.15;
    const H = h * 1.15;

    // director biome shift: animated tint over ~2s + fog change
    if (sim.theme.version !== this.themeVersion) {
      this.themeVersion = sim.theme.version;
      this.fogTarget = sim.theme.fog;
      this.tintFrom = this.tintColor;
      this.tintTo = sim.theme.tint ?? 0xffffff;
      this.tintTarget = sim.theme.tint === null ? 0 : 0.55;
      this.tintK = 0;
    }
    if (this.tintK < 1) {
      this.tintK = Math.min(1, this.tintK + dt / 2);
      this.tintColor = mixColor(this.tintFrom, this.tintTo, this.tintK);
    }
    this.tintAlpha += (this.tintTarget - this.tintAlpha) * Math.min(1, dt * 1.5);
    this.tint.setPosition(cx, cy).setDisplaySize(W, H).setTint(this.tintColor).setAlpha(this.tintAlpha);
    this.tint.setVisible(this.tintAlpha > 0.01);

    this.fogAlpha += (this.fogTarget - this.fogAlpha) * Math.min(1, dt * 0.8);
    const fa = this.fogAlpha * 0.55;
    this.fog.setVisible(fa > 0.01);
    if (fa > 0.01) {
      if (Math.abs(this.fogW - W) > 1 || Math.abs(this.fogH - H) > 1) {
        this.fogW = W;
        this.fogH = H;
        this.fog.setSize(W, H);
      }
      this.fog.setPosition(cx, cy).setAlpha(fa);
      // parallax drift: fog appears anchored to the world, slowly flowing
      this.fog.tilePositionX = cx * 0.6 + this.time * 12;
      this.fog.tilePositionY = cy * 0.6 + this.time * 5;
    }

    // time slow wash
    const slowA = sim.timeSlowT > 0 ? Math.min(0.45, sim.timeSlowT * 0.4) : 0;
    this.slow.setVisible(slowA > 0.01).setPosition(cx, cy).setDisplaySize(W, H).setAlpha(slowA);

    // blackout: dark everywhere except a light radius around the player
    const target = sim.blackoutT > 0 ? 1 : 0;
    this.blackoutA += (target - this.blackoutA) * Math.min(1, dt * 2.5);
    this.blackout.setVisible(this.blackoutA > 0.01);
    if (this.blackoutA > 0.01) {
      const p = sim.player;
      const holeR = 180 + Math.sin(this.time * 3) * 6;
      // texture: 512px, hole radius ~36px at full opacity
      const need = (Math.max(W, H) + Math.hypot(p.x - cx, p.y - cy) * 2) / 512;
      const scale = Math.max(holeR / 36, need);
      this.blackout.setPosition(p.x, p.y).setScale(scale).setAlpha(this.blackoutA * 0.97);
    }

    this.vignette.setPosition(cx, cy).setDisplaySize(W, H);

    // hurt / low hp pulse
    const p = sim.player;
    const hpFrac = p.hp / Math.max(1, p.maxHp);
    const low = p.alive && hpFrac < 0.3 ? (0.3 - hpFrac) * 1.6 * (0.6 + 0.4 * Math.sin(this.time * 6)) : 0;
    const hurtA = Math.max(low, p.hurtFlash * 2);
    this.hurt.setVisible(hurtA > 0.01).setPosition(cx, cy).setDisplaySize(W, H).setAlpha(Math.min(0.85, hurtA));

    this.flashA = Math.max(0, this.flashA - dt * 3);
    const fA = reducedMotion ? this.flashA * 0.4 : this.flashA;
    this.flash.setVisible(fA > 0.01).setPosition(cx, cy).setDisplaySize(W, H).setAlpha(fA);

    if (this.crt) {
      if (Math.abs(this.crt.width - W) > 1 || Math.abs(this.crt.height - H) > 1) this.crt.setSize(W, H);
      this.crt.setPosition(cx, cy);
      this.crt.tilePositionY = cy + this.time * 8;
      this.crt.tilePositionX = cx;
      this.crt.setAlpha(0.16 + (reducedMotion ? 0 : Math.random() * 0.03));
    }
  }

  destroy() {
    this.fog.destroy();
    this.tint.destroy();
    this.slow.destroy();
    this.blackout.destroy();
    this.vignette.destroy();
    this.hurt.destroy();
    this.flash.destroy();
    this.crt?.destroy();
  }
}
