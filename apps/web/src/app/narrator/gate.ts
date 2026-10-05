import type { NarrateRequest } from "@bimpee/shared";

export type NarrateTrigger = NarrateRequest["trigger"];

/** Big moments always get a line, even mid-sentence. */
export const PRIORITY_TRIGGERS: ReadonlySet<NarrateTrigger> = new Set(["death", "victory", "boss_spawn", "boss_defeated"]);

export type GateDecision = "start" | "interrupt" | "drop";

/**
 * Throttle for event narration:
 *  - at most one line every `minGapMs` (default 10s)
 *  - if a line is still streaming, ordinary triggers are dropped
 *  - priority triggers bypass the gap and interrupt a streaming line
 */
export class NarrationGate {
  private lastStart = Number.NEGATIVE_INFINITY;

  constructor(private readonly minGapMs = 10_000) {}

  decide(trigger: NarrateTrigger, now: number, streaming: boolean): GateDecision {
    const priority = PRIORITY_TRIGGERS.has(trigger);
    if (streaming) return priority ? "interrupt" : "drop";
    if (priority) return "start";
    return now - this.lastStart >= this.minGapMs ? "start" : "drop";
  }

  started(now: number) {
    this.lastStart = now;
  }
}

export const KILL_MILESTONES = [25, 75, 150, 300, 500, 800, 1200, 2000, 3000] as const;

/** Returns the milestone crossed going from `before` to `after` kills, if any. */
export function crossedMilestone(before: number, after: number): number | null {
  let hit: number | null = null;
  for (const m of KILL_MILESTONES) if (before < m && after >= m) hit = m;
  return hit;
}
