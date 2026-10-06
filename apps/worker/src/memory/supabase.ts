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
import { CitySaveBodySchema, type CityMemory, type CitySaveBody, type CitySaveMeta } from "@bimpee/shared/city";
import { addReported, boundCityMemory, parseCityMemory, parseCityMeta } from "./city";
import { LEADERBOARD_LIMIT, MAX_CITY_SAVES, startOfUtcDay, type GameKey, type LandmarkRecord, type LeaderboardScope, type MemoryRepo } from "./types";

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

  // ---- city -----------------------------------------------------------------

  async getGameMemory(userId: string, game: GameKey): Promise<unknown | null> {
    const { data, error } = await this.db.from("game_memory").select("memory").eq("user_id", userId).eq("game", game).maybeSingle();
    if (error) throw fail("game_memory.select", error);
    return (data?.memory as unknown) ?? null;
  }

  async saveGameMemory(userId: string, game: GameKey, value: unknown): Promise<void> {
    const { error } = await this.db
      .from("game_memory")
      .upsert({ user_id: userId, game, memory: value, updated_at: new Date().toISOString() }, { onConflict: "user_id,game" });
    if (error) throw fail("game_memory.upsert", error);
  }

  async getCityMemory(userId: string): Promise<CityMemory> {
    const [raw, name] = await Promise.all([this.getGameMemory(userId, "city"), this.displayName(userId)]);
    return parseCityMemory(raw, userId, name ? sanitizeDisplayName(name) : null);
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
    const { data, error } = await this.db
      .from("city_saves")
      .select("id, city_name, day, population, updated_at")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(MAX_CITY_SAVES);
    if (error) throw fail("city_saves.list", error);
    return (data ?? []).map((r) => ({
      id: String(r.id),
      cityName: String(r.city_name ?? ""),
      day: Number(r.day) | 0,
      population: Number(r.population) | 0,
      updatedAt: new Date(r.updated_at as string).toISOString(),
    }));
  }

  async putCitySave(userId: string, id: string, cityName: string, body: CitySaveBody): Promise<CitySaveMeta | "limit"> {
    const { data: existing, error: listErr } = await this.db.from("city_saves").select("id").eq("user_id", userId);
    if (listErr) throw fail("city_saves.ids", listErr);
    const ids = (existing ?? []).map((r) => String(r.id));
    if (!ids.includes(id) && ids.length >= MAX_CITY_SAVES) return "limit";
    const updatedAt = new Date().toISOString();
    const { error } = await this.db.from("city_saves").upsert(
      { id, user_id: userId, city_name: cityName, day: body.day, population: body.population, body, updated_at: updatedAt },
      { onConflict: "user_id,id" },
    );
    // The database trigger enforces the cap too (concurrent creates).
    if (error && /city_saves_limit/.test(error.message ?? "")) return "limit";
    if (error) throw fail("city_saves.upsert", error);
    return { id, cityName, day: body.day, population: body.population, updatedAt };
  }

  async getCitySave(userId: string, id: string): Promise<CitySaveBody | null> {
    const { data, error } = await this.db.from("city_saves").select("body").eq("user_id", userId).eq("id", id).maybeSingle();
    if (error) throw fail("city_saves.select", error);
    if (!data?.body) return null;
    const p = CitySaveBodySchema.safeParse(data.body);
    if (!p.success) {
      log.warn("[memory] stored city save failed validation");
      return null;
    }
    return p.data;
  }

  async getLandmark(hash: string): Promise<LandmarkRecord | null> {
    const { data, error } = await this.db
      .from("landmark_models")
      .select("hash, prompt, status, provider_job, r2_key, created_at, updated_at")
      .eq("hash", hash)
      .maybeSingle();
    if (error) throw fail("landmark_models.select", error);
    if (!data) return null;
    const status = data.status === "ready" || data.status === "pending" ? data.status : "failed";
    return {
      hash: String(data.hash),
      prompt: String(data.prompt ?? ""),
      status,
      providerJob: (data.provider_job as string | null) ?? null,
      r2Key: (data.r2_key as string | null) ?? null,
      createdAt: new Date(data.created_at as string).toISOString(),
      updatedAt: new Date(data.updated_at as string).toISOString(),
    };
  }

  async putLandmark(r: LandmarkRecord): Promise<void> {
    const { error } = await this.db.from("landmark_models").upsert(
      {
        hash: r.hash,
        prompt: r.prompt,
        status: r.status,
        provider_job: r.providerJob,
        r2_key: r.r2Key,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
      },
      { onConflict: "hash" },
    );
    if (error) throw fail("landmark_models.upsert", error);
  }

  async countLandmarksSince(since: Date): Promise<number> {
    const { count, error } = await this.db
      .from("landmark_models")
      .select("hash", { count: "exact", head: true })
      .gte("created_at", since.toISOString());
    if (error) throw fail("landmark_models.count", error);
    return count ?? 0;
  }
}
