/** Scoring and loot formulas. Pure. */

export interface ScoreInput {
  kills: number;
  eliteKills: number;
  bossKills: number;
  /** seconds survived */
  timeSec: number;
}

/** score = kills*10 + elite*50 + boss*1000 + time bonus (2/s). Always a non-negative integer. */
export function computeScore(s: ScoreInput): number {
  const n = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
  return Math.max(0, Math.floor(n(s.kills) * 10 + n(s.eliteKills) * 50 + n(s.bossKills) * 1000 + Math.floor(n(s.timeSec)) * 2));
}

/** XP value of the gems an enemy drops. */
export function gemValue(archHp: number, elite: boolean, lootMultiplier: number): number {
  const base = 1 + Math.max(0, archHp) / 15;
  const v = base * (elite ? 4 : 1) * (Number.isFinite(lootMultiplier) ? Math.max(0.2, lootMultiplier) : 1);
  return Math.max(1, Math.round(v));
}
