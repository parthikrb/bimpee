import { emptyMemory, type LeaderboardEntry, type PlayerMemory, type RunReflection, type RunReport } from "@bimpee/shared";
import type { CityMemory, CitySaveBody, CitySaveMeta } from "@bimpee/shared/city";
import { addReported, boundCityMemory, parseCityMemory, parseCityMeta } from "./city";
import { LEADERBOARD_LIMIT, MAX_CITY_SAVES, startOfUtcDay, type GameKey, type LandmarkRecord, type LeaderboardScope, type MemoryRepo } from "./types";

interface StoredRun {
  userId: string;
  runId: string;
  worldName: string;
  biome: string;
  outcome: RunReport["outcome"];
  score: number;
  at: Date;
}

/**
 * Process-local repo for development without Supabase. Data lives as long
 * as the worker isolate does. Bounded so a long dev session can't grow it
 * without limit.
 */
export class InMemoryRepo implements MemoryRepo {
  readonly persistent = false;
  private memories = new Map<string, PlayerMemory>();
  private names = new Map<string, string>();
  private runs: StoredRun[] = [];
  private static readonly MAX_RUNS = 5_000;
  private static readonly MAX_USERS = 5_000;
  private games = new Map<string, unknown>();
  private saves = new Map<string, { meta: CitySaveMeta; body: CitySaveBody }>();
  private landmarks = new Map<string, LandmarkRecord>();
  private static readonly MAX_SAVES_TOTAL = 40; // saves can be ~1.4 MB each; isolates have 128 MB
  private static readonly MAX_LANDMARKS = 2_000;

  constructor(private readonly now: () => Date = () => new Date()) {}

  async getMemory(userId: string): Promise<PlayerMemory> {
    const m = this.memories.get(userId);
    const name = this.names.get(userId);
    if (m) return structuredClone(name ? { ...m, displayName: name } : m);
    return emptyMemory(userId, name);
  }

  async saveMemory(memory: PlayerMemory): Promise<void> {
    if (!this.memories.has(memory.userId) && this.memories.size >= InMemoryRepo.MAX_USERS) {
      const oldest = this.memories.keys().next().value;
      if (oldest !== undefined) this.memories.delete(oldest);
    }
    this.memories.set(memory.userId, structuredClone(memory));
  }

  async setDisplayName(userId: string, name: string): Promise<void> {
    if (!this.names.has(userId) && this.names.size >= InMemoryRepo.MAX_USERS) {
      const oldest = this.names.keys().next().value;
      if (oldest !== undefined) this.names.delete(oldest);
    }
    this.names.set(userId, name);
  }

  async hasRun(userId: string, runId: string): Promise<boolean> {
    return this.runs.some((r) => r.userId === userId && r.runId === runId);
  }

  async addRun(userId: string, report: RunReport, _reflection: RunReflection): Promise<boolean> {
    if (await this.hasRun(userId, report.runId)) return false;
    this.runs.push({
      userId,
      runId: report.runId,
      worldName: report.worldName,
      biome: report.biome,
      outcome: report.outcome,
      score: report.score,
      at: this.now(),
    });
    if (this.runs.length > InMemoryRepo.MAX_RUNS) this.runs.splice(0, this.runs.length - InMemoryRepo.MAX_RUNS);
    return true;
  }

  async recentBiomes(userId: string, n: number): Promise<string[]> {
    return this.runs
      .filter((r) => r.userId === userId)
      .slice(-n)
      .reverse()
      .map((r) => r.biome);
  }

  async leaderboard(scope: LeaderboardScope, limit = LEADERBOARD_LIMIT): Promise<LeaderboardEntry[]> {
    const since = scope === "daily" ? startOfUtcDay(this.now()).getTime() : 0;
    return this.runs
      .filter((r) => r.at.getTime() >= since)
      .sort((a, b) => b.score - a.score || a.at.getTime() - b.at.getTime())
      .slice(0, limit)
      .map((r) => ({
        displayName: this.names.get(r.userId) ?? this.memories.get(r.userId)?.displayName ?? "Wanderer",
        score: r.score,
        worldName: r.worldName,
        outcome: r.outcome,
        at: r.at.toISOString(),
      }));
  }

  async rankOf(score: number): Promise<number | null> {
    if (score <= 0) return null;
    return this.runs.filter((r) => r.score > score).length + 1;
  }

  // ---- city -----------------------------------------------------------------

  async getGameMemory(userId: string, game: GameKey): Promise<unknown | null> {
    const v = this.games.get(`${userId}:${game}`);
    return v === undefined ? null : structuredClone(v);
  }

  async saveGameMemory(userId: string, game: GameKey, value: unknown): Promise<void> {
    const key = `${userId}:${game}`;
    if (!this.games.has(key) && this.games.size >= InMemoryRepo.MAX_USERS * 2) evictOldest(this.games);
    this.games.set(key, structuredClone(value));
  }

  async getCityMemory(userId: string): Promise<CityMemory> {
    return parseCityMemory(await this.getGameMemory(userId, "city"), userId, this.names.get(userId) ?? null);
  }

  async saveCityMemory(memory: CityMemory): Promise<void> {
    await this.saveGameMemory(memory.userId, "city", boundCityMemory(memory));
  }

  async markCityReported(userId: string, cityId: string): Promise<boolean> {
    const { meta, first } = addReported(parseCityMeta(await this.getGameMemory(userId, "city_meta")), cityId);
    if (first) await this.saveGameMemory(userId, "city_meta", meta);
    return first;
  }

  async listCitySaves(userId: string): Promise<CitySaveMeta[]> {
    return [...this.saves.entries()]
      .filter(([k]) => k.startsWith(`${userId}:`))
      .map(([, v]) => ({ ...v.meta }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async putCitySave(userId: string, id: string, cityName: string, body: CitySaveBody): Promise<CitySaveMeta | "limit"> {
    const key = `${userId}:${id}`;
    if (!this.saves.has(key) && (await this.listCitySaves(userId)).length >= MAX_CITY_SAVES) return "limit";
    const meta: CitySaveMeta = { id, cityName, day: body.day, population: body.population, updatedAt: this.now().toISOString() };
    this.saves.delete(key); // re-insert so eviction order follows recency
    if (this.saves.size >= InMemoryRepo.MAX_SAVES_TOTAL) evictOldest(this.saves);
    this.saves.set(key, { meta, body: structuredClone(body) });
    return { ...meta };
  }

  async getCitySave(userId: string, id: string): Promise<CitySaveBody | null> {
    const v = this.saves.get(`${userId}:${id}`);
    return v ? structuredClone(v.body) : null;
  }

  async getLandmark(hash: string): Promise<LandmarkRecord | null> {
    const r = this.landmarks.get(hash);
    return r ? { ...r } : null;
  }

  async putLandmark(record: LandmarkRecord): Promise<void> {
    if (!this.landmarks.has(record.hash) && this.landmarks.size >= InMemoryRepo.MAX_LANDMARKS) evictOldest(this.landmarks);
    this.landmarks.set(record.hash, { ...record });
  }

  async countLandmarksSince(since: Date): Promise<number> {
    const t = since.getTime();
    return [...this.landmarks.values()].filter((r) => Date.parse(r.createdAt) >= t).length;
  }
}

function evictOldest<K, V>(m: Map<K, V>) {
  const oldest = m.keys().next();
  if (!oldest.done) m.delete(oldest.value);
}
