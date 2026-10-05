import type { Directive } from "./director";
import { clamp, type WorldSpec } from "./world";

/**
 * The fast layer. Runs every frame in the browser: measures player stress
 * ("intensity"), cycles build -> peak -> relax like Left 4 Dead's AI
 * Director, and turns it into spawn rates, loot, and music energy.
 * The slow layer (Claude) only moves its targets and multipliers.
 */
export interface StressSignals {
  /** hp fraction lost this frame (0..1) */
  damageTaken: number;
  hpFraction: number;
  /** enemies within ~250px of the player */
  nearbyEnemies: number;
  /** kills this frame */
  kills: number;
  /** enemy projectiles that passed close this frame */
  nearMisses: number;
}

export type PacingPhase = "build" | "peak" | "relax";

export interface PacingOutput {
  intensity: number;
  target: number;
  phase: PacingPhase;
  /** enemies to spawn per second right now */
  spawnPerSec: number;
  maxAlive: number;
  /** chance a spawned enemy is an elite (more hp, glow) */
  eliteChance: number;
  lootMultiplier: number;
  musicEnergy: number;
  musicTension: number;
}

export interface PacingOptions {
  players?: number;
  /** base spawns per second at target intensity 0.5 */
  baseSpawnRate?: number;
}

const DECAY_PER_SEC = 0.07;
const PEAK_HOLD_SEC = 5;
const RELAX_SEC = 9;

export class PacingController {
  private intensity = 0;
  private phase: PacingPhase = "build";
  private phaseTime = 0;
  private act = 0;
  private aiTarget: { from: number; to: number; t: number; ramp: number } | null = null;
  private spawnMultiplier = 1;
  private weightOverrides = new Map<string, number>();
  private music: { energy: number; tension: number; ttl: number } | null = null;
  private readonly baseSpawnRate: number;
  private readonly players: number;

  constructor(
    private readonly world: WorldSpec,
    opts: PacingOptions = {},
  ) {
    this.players = Math.max(1, opts.players ?? 1);
    this.baseSpawnRate = opts.baseSpawnRate ?? 1.4;
  }

  setAct(act: number) {
    this.act = clamp(Math.round(act), 0, this.world.arc.length - 1);
    // A new act re-anchors the target to the world's arc.
    this.aiTarget = null;
  }

  get currentAct() {
    return this.act;
  }

  /** The intensity the director is steering towards right now. */
  target(): number {
    const arcTarget = this.world.arc[this.act]?.intensityTarget ?? 0.5;
    if (!this.aiTarget) return arcTarget;
    const k = clamp(this.aiTarget.t / this.aiTarget.ramp, 0, 1);
    return this.aiTarget.from + (this.aiTarget.to - this.aiTarget.from) * k;
  }

  update(dt: number, s: StressSignals): PacingOutput {
    dt = clamp(dt, 0, 0.25);
    // 1. Measure stress.
    const lowHp = s.hpFraction < 0.3 ? (0.3 - s.hpFraction) * 0.6 : 0;
    const gain = s.damageTaken * 2.2 + s.nearMisses * 0.025 + Math.min(s.nearbyEnemies, 20) * 0.004 * dt * 10 + lowHp * dt;
    const relief = DECAY_PER_SEC * dt + s.kills * 0.004;
    this.intensity = clamp(this.intensity + gain - relief, 0, 1);

    // 2. Advance AI ramp + music override.
    if (this.aiTarget) this.aiTarget.t += dt;
    if (this.music) {
      this.music.ttl -= dt;
      if (this.music.ttl <= 0) this.music = null;
    }

    // 3. Phase machine.
    const target = this.target();
    this.phaseTime += dt;
    const peakAt = Math.min(0.97, target + 0.15);
    if (this.phase === "build" && this.intensity >= peakAt) this.enter("peak");
    else if (this.phase === "peak" && this.phaseTime >= PEAK_HOLD_SEC) this.enter("relax");
    else if (this.phase === "relax" && this.phaseTime >= RELAX_SEC * (1.2 - target * 0.5)) this.enter("build");

    // 4. Outputs.
    const gap = target - this.intensity; // >0: player is too comfortable
    const phaseFactor = this.phase === "build" ? 1 + clamp(gap, 0, 1) * 1.6 : this.phase === "peak" ? 0.6 : 0.18;
    const playersFactor = 1 + (this.players - 1) * 0.6;
    const spawnPerSec = this.baseSpawnRate * (0.4 + target * 1.2) * phaseFactor * this.spawnMultiplier * playersFactor;
    const maxAlive = Math.round((25 + target * 70) * Math.sqrt(playersFactor) * Math.min(this.spawnMultiplier, 2));
    return {
      intensity: this.intensity,
      target,
      phase: this.phase,
      spawnPerSec,
      maxAlive,
      eliteChance: clamp(0.02 + target * 0.12 + this.act * 0.04, 0, 0.4),
      lootMultiplier: (0.6 + this.world.loot.generosity * 0.8) * (this.phase === "relax" ? 1.5 : 1),
      musicEnergy: this.music?.energy ?? clamp(0.25 + this.intensity * 0.75, 0, 1),
      musicTension: this.music?.tension ?? clamp(target * 0.6 + (this.phase === "peak" ? 0.4 : 0), 0, 1),
    };
  }

  private enter(p: PacingPhase) {
    this.phase = p;
    this.phaseTime = 0;
  }

  /** Spawn weights for archetypes unlocked in the current act, after AI overrides. */
  spawnTable(): { id: string; weight: number }[] {
    return this.world.enemies
      .filter((e) => e.unlockAct <= this.act)
      .map((e) => ({ id: e.id, weight: this.weightOverrides.get(e.id) ?? e.weight }))
      .filter((e) => e.weight > 0);
  }

  /**
   * Applies the pacing-related directives. Returns true when consumed;
   * the game handles the rest (events, bosses, biome shifts, boons, narration).
   */
  apply(d: Directive): boolean {
    switch (d.tool) {
      case "set_intensity_target":
        this.aiTarget = { from: this.target(), to: clamp(d.target, 0, 1), t: 0, ramp: clamp(d.rampSec, 1, 30) };
        return true;
      case "adjust_spawns":
        this.spawnMultiplier = clamp(d.rateMultiplier, 0.25, 3);
        for (const w of d.weights) {
          if (this.world.enemies.some((e) => e.id === w.id)) this.weightOverrides.set(w.id, clamp(w.weight, 0, 1));
        }
        return true;
      case "set_music":
        this.music = { energy: clamp(d.energy, 0, 1), tension: clamp(d.tension, 0, 1), ttl: 20 };
        return true;
      default:
        return false;
    }
  }

  snapshot() {
    return {
      intensity: this.intensity,
      target: this.target(),
      phase: this.phase,
      act: this.act,
      spawnMultiplier: this.spawnMultiplier,
    };
  }
}
