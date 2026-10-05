import type { LeaderboardEntry, PlayerMemory, RunReflection, RunReport } from "@bimpee/shared";

export type LeaderboardScope = "daily" | "all";

export interface MemoryRepo {
  /** True when backed by a real database. */
  readonly persistent: boolean;
  /** The player's memory, or `emptyMemory` when they have none yet. */
  getMemory(userId: string): Promise<PlayerMemory>;
  saveMemory(memory: PlayerMemory): Promise<void>;
  /** Upserts the player's public display name. */
  setDisplayName(userId: string, name: string): Promise<void>;
  /** Whether this run id was already recorded for the user (idempotency). */
  hasRun(userId: string, runId: string): Promise<boolean>;
  /** Stores a run summary (also the leaderboard source). Returns false when the run was already recorded. */
  addRun(userId: string, report: RunReport, reflection: RunReflection): Promise<boolean>;
  /** Biomes of the user's most recent runs, newest first. */
  recentBiomes(userId: string, n: number): Promise<string[]>;
  leaderboard(scope: LeaderboardScope, limit?: number): Promise<LeaderboardEntry[]>;
  /** 1-based all-time position of a score (ties share the better rank), or null if unranked. */
  rankOf(score: number): Promise<number | null>;
}

export const LEADERBOARD_LIMIT = 20;

/** Start of the current UTC day, used for the daily board. */
export const startOfUtcDay = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
