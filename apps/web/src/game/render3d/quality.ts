/** Pure adaptive-quality logic (no three). */

export interface QualityLevel {
  name: string;
  /** cap on devicePixelRatio */
  dprCap: number;
  shadows: boolean;
  shadowSize: number;
  /** multiplier on particle / weather counts */
  particles: number;
  /** bloom resolution scale */
  bloomScale: number;
}

export const QUALITY_LEVELS: readonly QualityLevel[] = [
  { name: "high", dprCap: 2, shadows: true, shadowSize: 2048, particles: 1, bloomScale: 0.5 },
  { name: "medium", dprCap: 1, shadows: true, shadowSize: 1024, particles: 1, bloomScale: 0.5 },
  { name: "low", dprCap: 1, shadows: false, shadowSize: 1024, particles: 0.6, bloomScale: 0.5 },
  { name: "potato", dprCap: 1, shadows: false, shadowSize: 512, particles: 0.4, bloomScale: 0.25 },
];

export interface GovernorOptions {
  /** fps below this counts as "slow" */
  minFps: number;
  /** seconds of sustained slowness before stepping down */
  sustain: number;
  /** seconds ignored after start / after a step (shader compiles, resizes) */
  settle: number;
  /** measurement window (s) */
  window: number;
}

export const DEFAULT_GOVERNOR: GovernorOptions = { minFps: 45, sustain: 2.5, settle: 2.5, window: 0.5 };

/**
 * Measures frame rate in windows and steps quality down when it is
 * sustainably below `minFps`. Never steps back up (avoids oscillation).
 * Frames longer than 250ms (tab switches, GC hitches) are ignored.
 */
export class QualityGovernor {
  level: number;
  fps = 60;
  private winT = 0;
  private winFrames = 0;
  private slowT = 0;
  private settleT: number;
  locked = false;

  constructor(
    start = 0,
    private readonly opts: GovernorOptions = DEFAULT_GOVERNOR,
    private readonly maxLevel = QUALITY_LEVELS.length - 1,
  ) {
    this.level = Math.max(0, Math.min(maxLevel, Math.round(start)));
    this.settleT = opts.settle;
  }

  get current(): QualityLevel {
    return QUALITY_LEVELS[Math.min(this.level, QUALITY_LEVELS.length - 1)]!;
  }

  /** Feed one frame's real dt (seconds). Returns true when the level changed. */
  sample(dt: number): boolean {
    if (!Number.isFinite(dt) || dt <= 0 || dt > 0.25) return false;
    this.winT += dt;
    this.winFrames++;
    if (this.winT < this.opts.window) return false;
    this.fps = this.winFrames / this.winT;
    const span = this.winT;
    this.winT = 0;
    this.winFrames = 0;
    if (this.settleT > 0) {
      this.settleT -= span;
      return false;
    }
    if (this.locked || this.level >= this.maxLevel) return false;
    if (this.fps < this.opts.minFps) this.slowT += span;
    else this.slowT = Math.max(0, this.slowT - span * 2);
    if (this.slowT >= this.opts.sustain) {
      this.level++;
      this.slowT = 0;
      this.settleT = this.opts.settle;
      return true;
    }
    return false;
  }
}
