import { z } from "zod";
import { TelemetrySchema } from "./director";
import { RunReportSchema } from "./memory";
import { WorldSpecSchema } from "./world";

/**
 * HTTP API between apps/web and apps/worker. All routes live under /api.
 * Auth: `Authorization: Bearer <supabase access token>` (anonymous sign-in
 * counts). Without Supabase configured the worker runs in dev mode and
 * accepts an `x-bimpee-guest: <uuid>` header instead.
 *
 *   GET  /api/health                     -> HealthResponse
 *   GET  /api/memory                     -> PlayerMemory
 *   POST /api/world      WorldRequest    -> WorldResponse
 *   POST /api/director   DirectorRequest -> DirectorResponse
 *   POST /api/narrate    NarrateRequest  -> text/event-stream of NarrateChunk (data: JSON per line), ends with {done:true}
 *   POST /api/runs       RunReport       -> RunResult
 *   GET  /api/leaderboard?scope=daily|all -> LeaderboardResponse
 *   WS   /parties/world-room/:roomId     -> room protocol (room.ts)
 */

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  ai: z.boolean().describe("Claude key configured"),
  memory: z.boolean().describe("Supabase configured"),
  models: z.object({ world: z.string(), director: z.string(), narrator: z.string() }),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const WorldRequestSchema = z.object({
  /** Optional player wish, e.g. "something underwater and spooky". */
  wish: z.string().max(200).optional(),
  /** Seed to use (rooms pass one so every member gets the same map). */
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
});
export type WorldRequest = z.infer<typeof WorldRequestSchema>;

export const WorldResponseSchema = z.object({
  world: WorldSpecSchema,
  source: z.enum(["claude", "fallback"]),
  model: z.string(),
  latencyMs: z.number(),
});
export type WorldResponse = z.infer<typeof WorldResponseSchema>;

export const DirectorRequestSchema = z.object({
  world: WorldSpecSchema,
  telemetry: TelemetrySchema,
});
export type DirectorRequest = z.infer<typeof DirectorRequestSchema>;

export const NARRATE_TRIGGERS = ["run_start", "act_change", "boss_spawn", "boss_defeated", "near_death", "death", "victory", "milestone"] as const;
export const NarrateRequestSchema = z.object({
  world: WorldSpecSchema,
  trigger: z.enum(NARRATE_TRIGGERS),
  context: z.string().max(400).describe("what just happened, short"),
});
export type NarrateRequest = z.infer<typeof NarrateRequestSchema>;
export type NarrateChunk = { text: string } | { done: true } | { error: string };

export const RunRequestSchema = RunReportSchema;
export const RunResultSchema = z.object({
  summary: z.string(),
  epitaph: z.string(),
  bestScore: z.number().int(),
  rank: z.number().int().nullable(),
});
export type RunResult = z.infer<typeof RunResultSchema>;

export const LeaderboardEntrySchema = z.object({
  displayName: z.string(),
  score: z.number().int(),
  worldName: z.string(),
  outcome: z.enum(["victory", "death", "quit"]),
  at: z.string(),
});
export const LeaderboardResponseSchema = z.object({ entries: z.array(LeaderboardEntrySchema) });
export type LeaderboardEntry = z.infer<typeof LeaderboardEntrySchema>;
export type LeaderboardResponse = z.infer<typeof LeaderboardResponseSchema>;
