import { emptyMemory, type LeaderboardEntry, type PlayerMemory, type RunReflection, type RunReport } from "@bimpee/shared";
import { LEADERBOARD_LIMIT, startOfUtcDay, type LeaderboardScope, type MemoryRepo } from "./types";

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
}
