import type { LeaderboardEntry, PlayerMemory, RunReflection, RunReport } from "@bimpee/shared";
import type { CityMemory, CitySaveBody, CitySaveMeta } from "@bimpee/shared/city";

export type LeaderboardScope = "daily" | "all";

/** Games with their own per-user memory document (`game_memory.game`). */
export type GameKey = "city" | "city_meta";

export const MAX_CITY_SAVES = 10;

/** Cached text-to-3D job / model, keyed by sha256 of the normalised prompt. */
export interface LandmarkRecord {
  hash: string;
  prompt: string;
  status: "pending" | "ready" | "failed";
  providerJob: string | null;
  /** R2 / blob key of the validated GLB when ready */
  r2Key: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Landmark model metadata. Shared across users (the cache is content-addressed). */
export interface LandmarkMetaStore {
  getLandmark(hash: string): Promise<LandmarkRecord | null>;
  putLandmark(record: LandmarkRecord): Promise<void>;
  /** Generations started since `since` (global cost guard). */
  countLandmarksSince(since: Date): Promise<number>;
}

export interface CityRepo extends LandmarkMetaStore {
  /** Raw per-game memory document, or null. Callers validate the shape. */
  getGameMemory(userId: string, game: GameKey): Promise<unknown | null>;
  saveGameMemory(userId: string, game: GameKey, value: unknown): Promise<void>;
  /** The mayor's city memory, or an empty one (named after the profile) when they have none yet. */
  getCityMemory(userId: string): Promise<CityMemory>;
  saveCityMemory(memory: CityMemory): Promise<void>;
  /** Records that a city id was reported. True only the first time for this user. */
  markCityReported(userId: string, cityId: string): Promise<boolean>;
  /** The user's saves, newest first. */
  listCitySaves(userId: string): Promise<CitySaveMeta[]>;
  /** Creates or replaces a save. "limit" when creating it would exceed MAX_CITY_SAVES. */
  putCitySave(userId: string, id: string, cityName: string, body: CitySaveBody): Promise<CitySaveMeta | "limit">;
  getCitySave(userId: string, id: string): Promise<CitySaveBody | null>;
}

export interface MemoryRepo extends CityRepo {
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
