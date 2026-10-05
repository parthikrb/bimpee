import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  LeaderboardEntrySchema,
  PlayerMemorySchema,
  emptyMemory,
  type LeaderboardEntry,
  type PlayerMemory,
  type RunReflection,
  type RunReport,
} from "@bimpee/shared";
import { log } from "../config";
import { sanitizeDisplayName } from "../ai/untrusted";
import { LEADERBOARD_LIMIT, startOfUtcDay, type LeaderboardScope, type MemoryRepo } from "./types";

export function createServiceClient(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

class RepoError extends Error {
  constructor(op: string, detail: string) {
    super(`supabase ${op} failed: ${detail}`);
    this.name = "RepoError";
  }
}

const fail = (op: string, e: { message?: string; code?: string } | null) => new RepoError(op, `${e?.code ?? ""} ${e?.message ?? "unknown"}`.trim());

/** Memory repo backed by Supabase Postgres via the service-role client. */
export class SupabaseMemoryRepo implements MemoryRepo {
  readonly persistent = true;
  constructor(private readonly db: SupabaseClient) {}

  private async displayName(userId: string): Promise<string | null> {
    const { data, error } = await this.db.from("profiles").select("display_name").eq("id", userId).maybeSingle();
    if (error) throw fail("profiles.select", error);
    return (data?.display_name as string | undefined) ?? null;
  }

  async getMemory(userId: string): Promise<PlayerMemory> {
    const [mem, name] = await Promise.all([
      this.db.from("player_memory").select("memory").eq("user_id", userId).maybeSingle(),
      this.displayName(userId),
    ]);
    if (mem.error) throw fail("player_memory.select", mem.error);
    if (mem.data?.memory) {
      const parsed = PlayerMemorySchema.safeParse(mem.data.memory);
      if (parsed.success) return { ...parsed.data, userId, displayName: name ?? parsed.data.displayName };
      log.warn(`[memory] stored memory for user failed validation; starting fresh`);
    }
    return emptyMemory(userId, name ?? undefined);
  }

  async saveMemory(memory: PlayerMemory): Promise<void> {
    const { error } = await this.db
      .from("player_memory")
      .upsert({ user_id: memory.userId, memory, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    if (error) throw fail("player_memory.upsert", error);
  }

  async setDisplayName(userId: string, name: string): Promise<void> {
    const { error } = await this.db.from("profiles").upsert({ id: userId, display_name: name }, { onConflict: "id" });
    if (error) throw fail("profiles.upsert", error);
  }

  async hasRun(userId: string, runId: string): Promise<boolean> {
    const { count, error } = await this.db
      .from("run_summaries")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("run_id", runId);
    if (error) throw fail("run_summaries.exists", error);
    return (count ?? 0) > 0;
  }

  async addRun(userId: string, report: RunReport, reflection: RunReflection): Promise<boolean> {
    const { error } = await this.db.from("run_summaries").insert({
      user_id: userId,
      run_id: report.runId,
      world_name: report.worldName,
      biome: report.biome,
      world_seed: report.worldSeed,
      outcome: report.outcome,
      score: report.score,
      kills: report.kills,
      duration_sec: report.durationSec,
      summary: reflection.summary,
      highlights: report.highlights,
      report,
    });
    if (error?.code === "23505") return false; // unique (user_id, run_id)
    if (error) throw fail("run_summaries.insert", error);
    return true;
  }

  async recentBiomes(userId: string, n: number): Promise<string[]> {
    const { data, error } = await this.db
      .from("run_summaries")
      .select("biome")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(n);
    if (error) throw fail("run_summaries.biomes", error);
    return (data ?? []).map((r) => String(r.biome));
  }

  async leaderboard(scope: LeaderboardScope, limit = LEADERBOARD_LIMIT): Promise<LeaderboardEntry[]> {
    let q = this.db.from("leaderboard").select("display_name, score, world_name, outcome, created_at");
    if (scope === "daily") q = q.gte("created_at", startOfUtcDay().toISOString());
    const { data, error } = await q.order("score", { ascending: false }).order("created_at", { ascending: true }).limit(limit);
    if (error) throw fail("leaderboard.select", error);
    const out: LeaderboardEntry[] = [];
    for (const r of data ?? []) {
      const p = LeaderboardEntrySchema.safeParse({
        // profiles.display_name can come straight from sign-up metadata (handle_new_user), unsanitized.
        displayName: sanitizeDisplayName(String(r.display_name ?? "")) ?? "Wanderer",
        score: r.score,
        worldName: r.world_name,
        outcome: r.outcome,
        at: new Date(r.created_at as string).toISOString(),
      });
      if (p.success) out.push(p.data);
    }
    return out;
  }

  async rankOf(score: number): Promise<number | null> {
    if (score <= 0) return null;
    const { count, error } = await this.db.from("run_summaries").select("id", { count: "exact", head: true }).gt("score", score);
    if (error) throw fail("run_summaries.rank", error);
    return (count ?? 0) + 1;
  }
}
