import { WEAPONS, type WorldSpec } from "@bimpee/shared";
import type { UpgradeOption } from "../contract";
import { createWeapon, DEFAULT_MODS, WEAPON_INFO, type CombatMods, type WeaponKind, type WeaponStats } from "./weapons";

/** Everything level-ups can change. Pure data, mutated in place by `applyUpgrade`. */
export interface PlayerBuild {
  weapons: WeaponStats[];
  maxHp: number;
  moveSpeed: number;
  magnet: number;
  dashCooldown: number;
  regen: number;
  /** multiplier on incoming damage */
  armor: number;
  mods: CombatMods;
}

export const MAX_WEAPONS = 3;

export function createBuild(player: WorldSpec["player"]): PlayerBuild {
  const hpMult = Number.isFinite(player.hpMultiplier) ? Math.min(2, Math.max(0.5, player.hpMultiplier)) : 1;
  const start = (WEAPONS as readonly string[]).includes(player.startingWeapon) ? player.startingWeapon : "blaster";
  return {
    weapons: [createWeapon(start)],
    maxHp: Math.round(100 * hpMult),
    moveSpeed: 230,
    magnet: 95,
    dashCooldown: 1.6,
    regen: 0,
    armor: 1,
    mods: { ...DEFAULT_MODS },
  };
}

type Rarity = UpgradeOption["rarity"];

interface UpgradeDef {
  id: string;
  name: string;
  description: string;
  rarity: Rarity;
  apply(b: PlayerBuild): number;
}

const RARITY_WEIGHT: Record<Rarity, number> = { common: 10, rare: 4.5, epic: 1.6 };

const projWord = (k: WeaponKind) =>
  k === "orbitals" ? "blade" : k === "lobber" ? "shell" : k === "beam" ? "lance" : k === "scatter" ? "pellets" : "bolt";

function weaponDefs(w: WeaponStats): UpgradeDef[] {
  const n = WEAPON_INFO[w.kind].name;
  const k = w.kind;
  const defs: UpgradeDef[] = [
    {
      id: `wdmg:${k}`,
      name: `${n}: Overcharge`,
      description: `${n} damage +25%`,
      rarity: "common",
      apply: () => ((w.damage *= 1.25), w.level++, 0),
    },
    {
      id: `wrate:${k}`,
      name: `${n}: Hair Trigger`,
      description: k === "orbitals" ? "Blades spin 20% faster" : `${n} fires 18% faster`,
      rarity: "common",
      apply: () => {
        if (k === "orbitals") w.speed *= 1.2;
        w.cooldown *= 0.85;
        w.level++;
        return 0;
      },
    },
  ];
  if (w.projectiles < 10) {
    defs.push({
      id: `wproj:${k}`,
      name: `${n}: Multishot`,
      description: k === "scatter" ? "+2 pellets per blast" : `+1 ${projWord(k)}`,
      rarity: "rare",
      apply: () => ((w.projectiles += k === "scatter" ? 2 : 1), w.level++, 0),
    });
  }
  const areaWeapon = k === "beam" || k === "orbitals" || k === "lobber";
  if (areaWeapon ? w.area < 2.5 : w.pierce < 6) {
    defs.push({
      id: `wpierce:${k}`,
      name: areaWeapon ? `${n}: Amplify` : `${n}: Piercing Rounds`,
      description: areaWeapon ? `${n} reach/size +20%` : "Shots pierce +1 enemy",
      rarity: "rare",
      apply: () => {
        if (areaWeapon) w.area *= 1.2;
        else w.pierce += 1;
        w.level++;
        return 0;
      },
    });
  }
  return defs;
}

function allDefs(b: PlayerBuild): UpgradeDef[] {
  const defs: UpgradeDef[] = [];
  for (const w of b.weapons) defs.push(...weaponDefs(w));
  if (b.weapons.length < MAX_WEAPONS) {
    for (const k of WEAPONS) {
      if (b.weapons.some((w) => w.kind === k)) continue;
      defs.push({
        id: `wnew:${k}`,
        name: `New weapon: ${WEAPON_INFO[k].name}`,
        description: WEAPON_INFO[k].blurb,
        rarity: "epic",
        apply: (bb) => (bb.weapons.length < MAX_WEAPONS && bb.weapons.push(createWeapon(k)), 0),
      });
    }
  }
  defs.push(
    {
      id: "maxhp",
      name: "Reinforced Hull",
      description: "+20 max hp, heal 20",
      rarity: "common",
      apply: (bb) => ((bb.maxHp += 20), 20),
    },
    {
      id: "speed",
      name: "Thrusters",
      description: "Move speed +8%",
      rarity: "common",
      apply: (bb) => ((bb.moveSpeed = Math.min(420, bb.moveSpeed * 1.08)), 0),
    },
    {
      id: "magnet",
      name: "Gravity Well",
      description: "Pickup radius +35%",
      rarity: "common",
      apply: (bb) => ((bb.magnet = Math.min(600, bb.magnet * 1.35)), 0),
    },
  );
  if (b.dashCooldown > 0.55)
    defs.push({
      id: "dash",
      name: "Blink Coils",
      description: "Dash cooldown -15%",
      rarity: "common",
      apply: (bb) => ((bb.dashCooldown = Math.max(0.5, bb.dashCooldown * 0.85)), 0),
    });
  if (b.mods.critChance < 0.6)
    defs.push({
      id: "crit",
      name: "Weak Points",
      description: "+6% crit chance, +25% crit damage",
      rarity: "rare",
      apply: (bb) => ((bb.mods.critChance += 0.06), (bb.mods.critMult += 0.25), 0),
    });
  if (b.regen < 4)
    defs.push({ id: "regen", name: "Nanites", description: "Regenerate 0.6 hp/s", rarity: "rare", apply: (bb) => ((bb.regen += 0.6), 0) });
  if (b.armor > 0.55)
    defs.push({ id: "armor", name: "Plating", description: "Take 10% less damage", rarity: "rare", apply: (bb) => ((bb.armor *= 0.9), 0) });
  defs.push(
    { id: "power", name: "Power Core", description: "All damage +20%", rarity: "epic", apply: (bb) => ((bb.mods.damageMult *= 1.2), 0) },
    { id: "haste", name: "Overclock", description: "All weapons fire 15% faster", rarity: "epic", apply: (bb) => ((bb.mods.fireRateMult *= 1.15), 0) },
  );
  if (b.mods.projBonus < 3)
    defs.push({
      id: "multi",
      name: "Split Chamber",
      description: "+1 projectile on every weapon",
      rarity: "epic",
      apply: (bb) => ((bb.mods.projBonus += 1), 0),
    });
  return defs;
}

/** Rolls `n` distinct upgrade options weighted by rarity. */
export function rollUpgrades(b: PlayerBuild, rand: () => number, n = 3): UpgradeOption[] {
  const pool = allDefs(b);
  const out: UpgradeOption[] = [];
  while (out.length < n && pool.length) {
    let total = 0;
    for (const d of pool) total += RARITY_WEIGHT[d.rarity];
    let roll = rand() * total;
    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      roll -= RARITY_WEIGHT[pool[i]!.rarity];
      if (roll <= 0) {
        idx = i;
        break;
      }
    }
    const [d] = pool.splice(idx, 1);
    out.push({ id: d!.id, name: d!.name, description: d!.description, rarity: d!.rarity });
  }
  return out;
}

/** Applies an upgrade by id. Returns null if unknown/unavailable, else hp to heal. */
export function applyUpgrade(b: PlayerBuild, id: string): number | null {
  const def = allDefs(b).find((d) => d.id === id);
  if (!def) return null;
  return def.apply(b);
}

/** A random improvement to the primary weapon (grant_boon weapon_upgrade). */
export function boonWeaponUpgrade(b: PlayerBuild, rand: () => number): string {
  const w = b.weapons[0]!;
  const defs = weaponDefs(w);
  const d = defs[Math.floor(rand() * defs.length)] ?? defs[0]!;
  d.apply(b);
  w.damage *= 1.1;
  return d.name;
}

/** XP needed to go from `level` to `level + 1`. */
export function xpToNext(level: number): number {
  const l = Math.max(1, Math.floor(level));
  return Math.round(4 + l * 2.2 + l * l * 0.09);
}
