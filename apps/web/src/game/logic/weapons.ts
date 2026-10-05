import type { Weapon } from "@bimpee/shared";

/**
 * Weapon stats and firing patterns. Pure: the simulation turns `Shot`s into
 * pooled projectiles / instant lances. Damage is in the same units as
 * archetype hp from the WorldSpec (1..60).
 */
export type WeaponKind = Weapon;

export interface WeaponStats {
  kind: WeaponKind;
  level: number;
  damage: number;
  /** seconds between volleys */
  cooldown: number;
  /** bolts per volley / blades / lobs / lances */
  projectiles: number;
  /** extra enemies a bolt passes through */
  pierce: number;
  speed: number;
  /** generic size multiplier: beam length, orbital radius, lob blast radius */
  area: number;
  /** runtime: seconds until next volley */
  timer: number;
}

export interface CombatMods {
  damageMult: number;
  fireRateMult: number;
  critChance: number;
  critMult: number;
  projBonus: number;
  pierceBonus: number;
  areaMult: number;
}

export const DEFAULT_MODS: CombatMods = {
  damageMult: 1,
  fireRateMult: 1,
  critChance: 0.05,
  critMult: 2,
  projBonus: 0,
  pierceBonus: 0,
  areaMult: 1,
};

export const WEAPON_INFO: Record<WeaponKind, { name: string; blurb: string }> = {
  blaster: { name: "Blaster", blurb: "Fast single shots" },
  scatter: { name: "Scatter", blurb: "Short-range spread" },
  beam: { name: "Lance", blurb: "Piercing beam strike" },
  orbitals: { name: "Orbitals", blurb: "Rotating blades" },
  lobber: { name: "Lobber", blurb: "Arcing explosive shells" },
};

const BASE: Record<WeaponKind, Omit<WeaponStats, "timer" | "level" | "kind">> = {
  blaster: { damage: 2.2, cooldown: 0.28, projectiles: 1, pierce: 0, speed: 760, area: 1 },
  scatter: { damage: 1.3, cooldown: 0.62, projectiles: 5, pierce: 0, speed: 600, area: 1 },
  beam: { damage: 3.2, cooldown: 0.75, projectiles: 1, pierce: 99, speed: 0, area: 1 },
  orbitals: { damage: 2.6, cooldown: 0.34, projectiles: 3, pierce: 99, speed: 3.4, area: 1 },
  lobber: { damage: 4.5, cooldown: 1.0, projectiles: 1, pierce: 0, speed: 0, area: 1 },
};

export function createWeapon(kind: WeaponKind): WeaponStats {
  return { kind, level: 1, timer: 0.2, ...BASE[kind] };
}

export function effectiveCooldown(w: WeaponStats, m: CombatMods): number {
  return Math.max(0.06, w.cooldown / Math.max(0.1, m.fireRateMult));
}

/** Auto-aim range per weapon (how far away a target may be to bother firing). */
export function weaponRange(w: WeaponStats, m: CombatMods): number {
  switch (w.kind) {
    case "scatter":
      return 300;
    case "beam":
      return beamLength(w, m);
    case "lobber":
      return 420;
    case "orbitals":
      return orbitalRadius(w, m) + 30;
    default:
      return 560;
  }
}

export const beamLength = (w: WeaponStats, m: CombatMods) => 300 * w.area * m.areaMult;
export const orbitalRadius = (w: WeaponStats, m: CombatMods) => 96 * w.area * m.areaMult;
export const lobRadius = (w: WeaponStats, m: CombatMods) => 72 * w.area * m.areaMult;

export type ShotKind = "bolt" | "lance" | "lob";

export interface Shot {
  kind: ShotKind;
  angle: number;
  speed: number;
  damage: number;
  crit: boolean;
  pierce: number;
  /** seconds (bolts) or flight time (lobs) */
  life: number;
  radius: number;
  /** lance length / lob blast radius */
  reach: number;
  /** lob target distance */
  distance: number;
}

function rollDamage(base: number, m: CombatMods, rand: () => number): { damage: number; crit: boolean } {
  const crit = rand() < m.critChance;
  return { damage: base * m.damageMult * (crit ? m.critMult : 1), crit };
}

/**
 * Produces the shots of one volley. `targetDist` is the distance to the aim
 * point (used by lobs). Orbitals never fire (they are continuous).
 */
export function fireWeapon(w: WeaponStats, m: CombatMods, angle: number, rand: () => number, targetDist = 300): Shot[] {
  const shots: Shot[] = [];
  const ang = Number.isFinite(angle) ? angle : 0;
  switch (w.kind) {
    case "blaster": {
      const n = Math.max(1, w.projectiles + m.projBonus);
      const step = 0.11;
      for (let i = 0; i < n; i++) {
        const a = ang + (i - (n - 1) / 2) * step + (rand() - 0.5) * 0.03;
        const { damage, crit } = rollDamage(w.damage, m, rand);
        shots.push({ kind: "bolt", angle: a, speed: w.speed, damage, crit, pierce: w.pierce + m.pierceBonus, life: 0.85, radius: 5, reach: 0, distance: 0 });
      }
      break;
    }
    case "scatter": {
      const n = Math.max(3, w.projectiles + m.projBonus * 2);
      const spread = Math.min(1.4, 0.55 + n * 0.03);
      for (let i = 0; i < n; i++) {
        const a = ang + (n === 1 ? 0 : (i / (n - 1) - 0.5) * spread) + (rand() - 0.5) * 0.06;
        const { damage, crit } = rollDamage(w.damage, m, rand);
        shots.push({ kind: "bolt", angle: a, speed: w.speed * (0.9 + rand() * 0.2), damage, crit, pierce: w.pierce + m.pierceBonus, life: 0.42, radius: 4, reach: 0, distance: 0 });
      }
      break;
    }
    case "beam": {
      const n = Math.max(1, w.projectiles + m.projBonus);
      for (let i = 0; i < n; i++) {
        const a = ang + (i - (n - 1) / 2) * 0.28;
        const { damage, crit } = rollDamage(w.damage, m, rand);
        shots.push({ kind: "lance", angle: a, speed: 0, damage, crit, pierce: 99, life: 0.18, radius: 10 * Math.sqrt(w.area), reach: beamLength(w, m), distance: 0 });
      }
      break;
    }
    case "lobber": {
      const n = Math.max(1, w.projectiles + m.projBonus);
      const dist = Math.max(80, Math.min(420, targetDist));
      for (let i = 0; i < n; i++) {
        const a = ang + (i - (n - 1) / 2) * 0.32;
        const { damage, crit } = rollDamage(w.damage, m, rand);
        const dd = dist * (i === 0 ? 1 : 0.85 + rand() * 0.3);
        shots.push({ kind: "lob", angle: a, speed: 0, damage, crit, pierce: 0, life: 0.55, radius: 8, reach: lobRadius(w, m), distance: dd });
      }
      break;
    }
    case "orbitals":
      break;
  }
  return shots;
}

export interface OrbitalLayout {
  count: number;
  radius: number;
  bladeRadius: number;
  angle0: number;
  damage: number;
}

export function orbitalLayout(w: WeaponStats, m: CombatMods, time: number): OrbitalLayout {
  const count = Math.max(1, Math.min(12, w.projectiles + m.projBonus));
  return {
    count,
    radius: orbitalRadius(w, m),
    bladeRadius: 15 * Math.sqrt(w.area * m.areaMult),
    angle0: (time * w.speed) % (Math.PI * 2),
    damage: w.damage * m.damageMult,
  };
}
