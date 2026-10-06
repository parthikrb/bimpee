import * as THREE from "three";
import type { WorldSpec } from "@bimpee/shared";

/** Linear-space THREE colours derived from the world palette. */
export interface Pal {
  bg: THREE.Color;
  floor: THREE.Color;
  wall: THREE.Color;
  accent: THREE.Color;
  player: THREE.Color;
  glow: THREE.Color;
}

const safe = (hex: string, fb: string) => new THREE.Color(/^#[0-9a-fA-F]{6}$/.test(hex) ? hex : fb);

export function palette(world: WorldSpec): Pal {
  const p = world.theme.palette;
  return {
    bg: safe(p.background, "#0b0221"),
    floor: safe(p.floor, "#1a0b3d"),
    wall: safe(p.wall, "#ff2bd6"),
    accent: safe(p.accent, "#00f0ff"),
    player: safe(p.player, "#f8f8ff"),
    glow: safe(p.glow, "#ff2bd6"),
  };
}

/** sRGB int (0xrrggbb from the sim) -> linear THREE colour, written into `out`. */
export function intColor(c: number, out: THREE.Color): THREE.Color {
  return out.setHex(Number.isFinite(c) ? c & 0xffffff : 0xffffff);
}

export const mixC = (a: THREE.Color, b: THREE.Color, t: number) => a.clone().lerp(b, t);

/** Per-biome lighting / atmosphere style. */
export interface BiomeStyle {
  key: number;
  keyIntensity: number;
  hemi: number;
  /** sky top multiplier and horizon mix towards glow */
  horizon: number;
  stars: number;
  sun: number;
  /** extra fog density multiplier */
  fog: number;
  exposure: number;
  /** key light elevation (radians) */
  elev: number;
}

export const BIOME_STYLE: Record<string, BiomeStyle> = {
  neon_city: { key: 0xb9a8ff, keyIntensity: 1.6, hemi: 0.9, horizon: 0.55, stars: 0.4, sun: 0.0, fog: 1.0, exposure: 1.15, elev: 0.95 },
  fungal_cathedral: { key: 0xd9ffb0, keyIntensity: 1.3, hemi: 0.85, horizon: 0.45, stars: 0.0, sun: 0.0, fog: 1.3, exposure: 1.2, elev: 1.05 },
  frozen_wastes: { key: 0xe6f4ff, keyIntensity: 2.2, hemi: 1.0, horizon: 0.5, stars: 0.15, sun: 0.6, fog: 1.1, exposure: 1.05, elev: 0.6 },
  desert_ruins: { key: 0xffe2b0, keyIntensity: 3.4, hemi: 1.4, horizon: 0.75, stars: 0.0, sun: 1.0, fog: 0.9, exposure: 1.25, elev: 0.6 },
  abyssal_reef: { key: 0x9fffee, keyIntensity: 1.4, hemi: 0.8, horizon: 0.4, stars: 0.0, sun: 0.0, fog: 1.6, exposure: 1.25, elev: 1.2 },
  clockwork_foundry: { key: 0xffc27a, keyIntensity: 2.0, hemi: 0.8, horizon: 0.55, stars: 0.0, sun: 0.3, fog: 1.2, exposure: 1.1, elev: 0.8 },
  void_garden: { key: 0xd2b8ff, keyIntensity: 1.4, hemi: 0.75, horizon: 0.5, stars: 1.0, sun: 0.0, fog: 0.8, exposure: 1.2, elev: 0.9 },
  volcanic_forge: { key: 0xffa070, keyIntensity: 1.7, hemi: 0.75, horizon: 0.65, stars: 0.0, sun: 0.0, fog: 1.2, exposure: 1.1, elev: 0.85 },
};

export const styleFor = (biome: string): BiomeStyle => BIOME_STYLE[biome] ?? BIOME_STYLE.neon_city!;
