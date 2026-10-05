import { RunReportSchema, type RunReport } from "@bimpee/shared";
import { clamp01 } from "./math";

export const CURVE_INTERVAL = 5;
export const CURVE_CAP = 240;

/**
 * Samples intensity every 5s. If the curve would exceed the cap, it is
 * compacted by averaging pairs and the interval doubles (keeps whole-run shape).
 */
export class IntensitySampler {
  readonly values: number[] = [];
  private acc = 0;
  private interval = CURVE_INTERVAL;

  update(dt: number, intensity: number) {
    if (!(dt > 0)) return;
    this.acc += dt;
    while (this.acc >= this.interval) {
      this.acc -= this.interval;
      this.values.push(Math.round(clamp01(intensity) * 1000) / 1000);
      if (this.values.length >= CURVE_CAP) {
        const merged: number[] = [];
        for (let i = 0; i < this.values.length; i += 2) {
          const a = this.values[i]!;
          const b = this.values[i + 1] ?? a;
          merged.push(Math.round(((a + b) / 2) * 1000) / 1000);
        }
        this.values.length = 0;
        this.values.push(...merged);
        this.interval *= 2;
      }
    }
  }
}

export interface ReportInput {
  runId: string;
  worldName: string;
  worldSeed: number;
  biome: string;
  outcome: RunReport["outcome"];
  durationSec: number;
  score: number;
  kills: number;
  level: number;
  accuracy: number;
  damageTaken: number;
  killedBy: string | null;
  bossDefeated: boolean;
  highlights: string[];
  directivesUsed: string[];
  intensityCurve: number[];
}

/** Builds a RunReport that always satisfies RunReportSchema. */
export function buildRunReport(i: ReportInput): RunReport {
  const nn = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
  const report: RunReport = {
    runId: String(i.runId),
    worldName: i.worldName,
    worldSeed: Math.trunc(nn(i.worldSeed)),
    biome: i.biome,
    outcome: i.outcome,
    durationSec: Math.round(nn(i.durationSec) * 10) / 10,
    score: Math.floor(nn(i.score)),
    kills: Math.floor(nn(i.kills)),
    level: Math.max(1, Math.floor(nn(i.level))),
    accuracy: Math.round(clamp01(i.accuracy) * 100) / 100,
    damageTaken: Math.round(nn(i.damageTaken) * 1000) / 1000,
    killedBy: i.killedBy ? i.killedBy.slice(0, 80) : null,
    bossDefeated: !!i.bossDefeated,
    highlights: i.highlights.slice(0, 20),
    directivesUsed: i.directivesUsed.slice(-60),
    intensityCurve: i.intensityCurve.slice(0, 240).map(clamp01),
  };
  const parsed = RunReportSchema.safeParse(report);
  if (!parsed.success) {
    console.warn("[bimpee] run report failed validation", parsed.error);
  }
  return report;
}
