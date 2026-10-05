import { TelemetrySchema, type Telemetry } from "@bimpee/shared";
import { clamp01 } from "./math";

/**
 * Accumulates per-tick counters and builds a schema-valid Telemetry object.
 * Every field is clamped/rounded so `TelemetrySchema.parse` never throws.
 */
export class TelemetryTracker {
  private elapsed = 0;
  private idle = 0;
  private damage = 0;
  private kills = 0;
  private nearMisses = 0;
  private shots = 0;
  private hits = 0;
  private totalShots = 0;
  private totalHits = 0;
  private readonly events: string[] = [];
  private readonly directives: string[] = [];

  sample(dt: number, moving: boolean) {
    if (!(dt > 0)) return;
    this.elapsed += dt;
    if (!moving) this.idle += dt;
  }
  addDamage(frac: number) {
    if (frac > 0 && Number.isFinite(frac)) this.damage += frac;
  }
  addKill(n = 1) {
    this.kills += n;
  }
  addNearMiss(n = 1) {
    this.nearMisses += n;
  }
  addShot(n = 1) {
    this.shots += n;
    this.totalShots += n;
  }
  addHit(n = 1) {
    this.hits += n;
    this.totalHits += n;
  }
  addEvent(text: string) {
    this.events.push(text.slice(0, 160));
    if (this.events.length > 12) this.events.shift();
  }
  addDirective(tool: string) {
    this.directives.push(tool);
    if (this.directives.length > 8) this.directives.shift();
  }

  /** Lifetime accuracy (0.5 when nothing was fired yet). */
  get accuracy(): number {
    return this.totalShots > 0 ? clamp01(this.totalHits / this.totalShots) : 0.5;
  }

  build(ctx: {
    runId: string;
    t: number;
    act: number;
    intensity: number;
    intensityTarget: number;
    phase: Telemetry["phase"];
    hpFraction: number;
    level: number;
    weapon: string;
    score: number;
    enemiesAlive: number;
    bossActive: boolean;
    fps: number;
    players: number;
  }): Telemetry {
    const acc = this.shots > 0 ? clamp01(this.hits / this.shots) : this.accuracy;
    const int = (v: number, min = 0) => Math.max(min, Math.round(Number.isFinite(v) ? v : min));
    const tel: Telemetry = {
      runId: String(ctx.runId),
      t: Math.max(0, Number.isFinite(ctx.t) ? Math.round(ctx.t * 10) / 10 : 0),
      act: Math.min(2, int(ctx.act)),
      intensity: clamp01(ctx.intensity),
      intensityTarget: clamp01(ctx.intensityTarget),
      phase: ctx.phase,
      player: {
        hpFraction: clamp01(ctx.hpFraction),
        level: int(ctx.level, 1),
        weapon: ctx.weapon || "blaster",
        accuracy: Math.round(acc * 100) / 100,
        damageTaken: Math.max(0, Math.round(this.damage * 1000) / 1000),
        kills: int(this.kills),
        nearMisses: int(this.nearMisses),
        idleRatio: this.elapsed > 0 ? Math.round(clamp01(this.idle / this.elapsed) * 100) / 100 : 0,
        score: int(ctx.score),
      },
      enemiesAlive: int(ctx.enemiesAlive),
      bossActive: !!ctx.bossActive,
      recentEvents: this.events.slice(-12),
      recentDirectives: this.directives.slice(-8),
      fps: Math.min(240, Math.max(0, Number.isFinite(ctx.fps) ? Math.round(ctx.fps) : 0)),
      players: int(ctx.players, 1),
    };
    return tel;
  }

  /** Builds, validates and resets the per-tick counters. */
  flush(ctx: Parameters<TelemetryTracker["build"]>[0]): Telemetry | null {
    const tel = this.build(ctx);
    this.elapsed = this.idle = this.damage = 0;
    this.kills = this.nearMisses = this.shots = this.hits = 0;
    const parsed = TelemetrySchema.safeParse(tel);
    if (!parsed.success) {
      console.warn("[bimpee] telemetry failed validation", parsed.error);
      return null;
    }
    return parsed.data;
  }
}
