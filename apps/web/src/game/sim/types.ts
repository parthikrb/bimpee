import type { EnemyBase, EnemyModifier, Weather } from "@bimpee/shared";

/** Runtime archetype: spec archetype + director mutations (shared by all alive instances). */
export interface ArchRuntime {
  id: string;
  name: string;
  base: EnemyBase;
  hp: number;
  /** multiplier on BASE_ENEMY_SPEED, includes mutate_enemies */
  speed: number;
  size: number;
  color: number;
  modifiers: Set<EnemyModifier>;
  weight: number;
  unlockAct: number;
  synthetic: boolean;
}

export const EState = { Move: 0, Telegraph: 1, Dash: 2, Recover: 3 } as const;
export type EState = (typeof EState)[keyof typeof EState];

export interface Enemy {
  active: boolean;
  /** pool slot */
  idx: number;
  /** unique id per spawn (pierce bookkeeping, renderer slot reuse) */
  uid: number;
  arch: ArchRuntime;
  x: number;
  y: number;
  /** last movement velocity (for facing) */
  vx: number;
  vy: number;
  /** knockback velocity */
  kx: number;
  ky: number;
  r: number;
  hp: number;
  maxHp: number;
  elite: boolean;
  isBoss: boolean;
  rival: boolean;
  tide: boolean;
  splitGen: number;
  state: EState;
  stateT: number;
  cd: number;
  cd2: number;
  ang: number;
  dirX: number;
  dirY: number;
  shield: number;
  shieldRegen: number;
  flash: number;
  spawnT: number;
  alpha: number;
  cloakT: number;
  trailT: number;
  teleT: number;
  orbHit: number;
  lifeT: number;
  contact: number;
  kbResist: number;
  /** facing used by the renderer */
  renderAng: number;
}

export interface PBullet {
  active: boolean;
  kind: "bolt" | "lob";
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  dmg: number;
  crit: boolean;
  pierce: number;
  life: number;
  maxLife: number;
  hits: number[];
  counted: boolean;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  area: number;
  angle: number;
}

export interface EBullet {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  dmg: number;
  life: number;
  near: boolean;
  src: string;
  color: number;
}

export interface Gem {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  value: number;
  mag: boolean;
  speed: number;
  /** age, for spawn pop animation */
  age: number;
}

export type HazardKind = "puddle" | "blast" | "meteor";

export interface Hazard {
  active: boolean;
  kind: HazardKind;
  x: number;
  y: number;
  r: number;
  t: number;
  /** puddle: lifetime; blast/meteor: detonation delay */
  dur: number;
  dmg: number;
  src: string;
  color: number;
  hitsEnemies: boolean;
}

export interface Chest {
  active: boolean;
  x: number;
  y: number;
  value: number;
  age: number;
}

export interface Shrine {
  active: boolean;
  x: number;
  y: number;
  r: number;
  life: number;
  pool: number;
  age: number;
}

export interface PlayerState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  facing: number;
  iframes: number;
  dashT: number;
  dashCd: number;
  dashDirX: number;
  dashDirY: number;
  shieldHits: number;
  level: number;
  xp: number;
  xpToNext: number;
  moving: boolean;
  hurtFlash: number;
}

export interface BossState {
  e: Enemy;
  name: string;
  phase: number;
  phases: number;
  sigCd: number;
  sigActive: number;
  sigStep: number;
  secondaryCd: number;
  laser: { angle: number; rot: number; t: number; mode: "tele" | "fire"; beams: number } | null;
  spiralAngle: number;
  chargesLeft: number;
  spawnedAt: number;
}

export interface ThemeState {
  weather: Weather;
  fog: number;
  /** wash color, null = none */
  tint: number | null;
  /** bumps whenever the director shifts the biome */
  version: number;
}

export interface SimInput {
  /** -1..1 */
  moveX: number;
  moveY: number;
  /** manual aim angle (radians), null = auto-aim */
  aim: number | null;
  /** distance to the manual aim point (lob range) */
  aimDist: number;
  firing: boolean;
  /** edge-triggered */
  dash: boolean;
  /** visible world size (for off-screen spawn ring) */
  viewW: number;
  viewH: number;
}

export const IDLE_INPUT: SimInput = { moveX: 0, moveY: 0, aim: null, aimDist: 300, firing: false, dash: false, viewW: 1280, viewH: 720 };

export type FxEvent =
  | { t: "burst"; x: number; y: number; color: number; count: number; speed: number; size: number }
  | { t: "dmg"; x: number; y: number; amount: number; crit: boolean }
  | { t: "shake"; amount: number; dur: number }
  | { t: "flash"; color: number; alpha: number }
  | { t: "lance"; x1: number; y1: number; x2: number; y2: number; width: number; color: number }
  | { t: "afterimage"; x: number; y: number; angle: number }
  | { t: "ring"; x: number; y: number; r: number; color: number }
  | { t: "muzzle"; x: number; y: number; angle: number; color: number }
  | { t: "teleport"; x: number; y: number; color: number }
  | { t: "pickup"; x: number; y: number; color: number }
  | { t: "shield"; x: number; y: number; r: number };
