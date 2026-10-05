import { z } from "zod";

/**
 * Player memory: what the game remembers about a player between runs.
 * Stored in Supabase (`player_memory` + `run_summaries`), digested into a
 * short text block for the world builder and director prompts.
 */
export const SkillSchema = z.object({
  aim: z.number().min(0).max(1),
  evasion: z.number().min(0).max(1),
  aggression: z.number().min(0).max(1),
  endurance: z.number().min(0).max(1),
});
export type Skill = z.infer<typeof SkillSchema>;

export const PlayerMemorySchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  runs: z.number().int().min(0),
  wins: z.number().int().min(0),
  bestScore: z.number().int().min(0),
  skill: SkillSchema,
  likes: z.array(z.string()).max(12),
  dislikes: z.array(z.string()).max(12),
  nemesis: z.string().nullable().describe("enemy or boss that beat them most memorably"),
  recentRuns: z
    .array(
      z.object({
        worldName: z.string(),
        outcome: z.enum(["victory", "death", "quit"]),
        score: z.number().int(),
        summary: z.string(),
        at: z.string(),
      }),
    )
    .max(5),
});
export type PlayerMemory = z.infer<typeof PlayerMemorySchema>;

export const DEFAULT_SKILL: Skill = { aim: 0.5, evasion: 0.5, aggression: 0.5, endurance: 0.5 };

export const emptyMemory = (userId: string, displayName = "Wanderer"): PlayerMemory => ({
  userId,
  displayName,
  runs: 0,
  wins: 0,
  bestScore: 0,
  skill: { ...DEFAULT_SKILL },
  likes: [],
  dislikes: [],
  nemesis: null,
  recentRuns: [],
});

/** Compact, prompt-ready digest. Deterministic so it caches well. */
export function memoryDigest(m: PlayerMemory): string {
  if (m.runs === 0) return `Player "${m.displayName}" is brand new: no runs yet. Make a welcoming but exciting first world.`;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const lines = [
    `Player "${m.displayName}": ${m.runs} runs, ${m.wins} wins, best score ${m.bestScore}.`,
    `Skill estimate: aim ${pct(m.skill.aim)}, evasion ${pct(m.skill.evasion)}, aggression ${pct(m.skill.aggression)}, endurance ${pct(m.skill.endurance)}.`,
  ];
  if (m.likes.length) lines.push(`Enjoys: ${m.likes.join(", ")}.`);
  if (m.dislikes.length) lines.push(`Dislikes: ${m.dislikes.join(", ")}.`);
  if (m.nemesis) lines.push(`Nemesis: ${m.nemesis}.`);
  for (const r of m.recentRuns.slice(0, 3)) lines.push(`- ${r.worldName} (${r.outcome}, ${r.score}): ${r.summary}`);
  return lines.join("\n");
}

/** What the game reports when a run ends. */
export const RunReportSchema = z.object({
  runId: z.string(),
  worldName: z.string(),
  worldSeed: z.number().int(),
  biome: z.string(),
  outcome: z.enum(["victory", "death", "quit"]),
  durationSec: z.number().min(0),
  score: z.number().int().min(0),
  kills: z.number().int().min(0),
  level: z.number().int().min(1),
  accuracy: z.number().min(0).max(1),
  damageTaken: z.number().min(0).describe("total hp fractions lost"),
  killedBy: z.string().nullable(),
  bossDefeated: z.boolean(),
  highlights: z.array(z.string()).max(20).describe("notable moments, e.g. 'survived blackout at 4% hp'"),
  directivesUsed: z.array(z.string()).max(60),
  intensityCurve: z.array(z.number().min(0).max(1)).max(240).describe("intensity sampled every ~5s"),
});
export type RunReport = z.infer<typeof RunReportSchema>;

/** Claude's reflection on a finished run; merged into PlayerMemory. */
export const RunReflectionSchema = z.object({
  summary: z.string().describe("one or two sentences, second person, vivid"),
  skill: SkillSchema.describe("updated skill estimate"),
  likes: z.array(z.string()).max(12),
  dislikes: z.array(z.string()).max(12),
  nemesis: z.string().nullable(),
  epitaph: z.string().describe("one punchy line the narrator says on the results screen"),
});
export type RunReflection = z.infer<typeof RunReflectionSchema>;

/** Folds a reflection into memory. Skill moves gradually (EMA) to resist one-off runs. */
export function mergeReflection(m: PlayerMemory, report: RunReport, r: RunReflection, now = new Date()): PlayerMemory {
  const ema = (a: number, b: number) => Math.min(1, Math.max(0, a * 0.7 + b * 0.3));
  return {
    ...m,
    runs: m.runs + 1,
    wins: m.wins + (report.outcome === "victory" ? 1 : 0),
    bestScore: Math.max(m.bestScore, report.score),
    skill: {
      aim: ema(m.skill.aim, r.skill.aim),
      evasion: ema(m.skill.evasion, r.skill.evasion),
      aggression: ema(m.skill.aggression, r.skill.aggression),
      endurance: ema(m.skill.endurance, r.skill.endurance),
    },
    likes: dedupe(r.likes).slice(0, 12),
    dislikes: dedupe(r.dislikes).slice(0, 12),
    nemesis: r.nemesis ?? m.nemesis,
    recentRuns: [
      { worldName: report.worldName, outcome: report.outcome, score: report.score, summary: r.summary, at: now.toISOString() },
      ...m.recentRuns,
    ].slice(0, 5),
  };
}

const dedupe = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

/** Heuristic reflection used when Claude is unavailable. */
export function heuristicReflection(m: PlayerMemory, report: RunReport): RunReflection {
  const survived = report.outcome === "victory";
  const evasion = Math.max(0, 1 - report.damageTaken / Math.max(1, report.durationSec / 60));
  return {
    summary: survived
      ? `You conquered ${report.worldName} with ${report.kills} kills.`
      : `${report.worldName} claimed you after ${Math.round(report.durationSec)}s${report.killedBy ? `, courtesy of ${report.killedBy}` : ""}.`,
    skill: {
      aim: report.accuracy,
      evasion: Math.min(1, evasion),
      aggression: Math.min(1, report.kills / Math.max(1, report.durationSec) / 1.5),
      endurance: Math.min(1, report.durationSec / 420),
    },
    likes: m.likes,
    dislikes: m.dislikes,
    nemesis: report.killedBy ?? m.nemesis,
    epitaph: survived ? "Another world bends the knee." : "The world remembers. So will you.",
  };
}
