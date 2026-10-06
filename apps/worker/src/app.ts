import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import {
  DirectorRequestSchema,
  DirectorResponseSchema,
  LeaderboardResponseSchema,
  NarrateRequestSchema,
  RunRequestSchema,
  RunResultSchema,
  WorldRequestSchema,
  WorldResponseSchema,
  generateFallbackWorld,
  localDirector,
  mergeReflection,
  sanitizeWorldSpec,
  type HealthResponse,
  type NarrateChunk,
  type PlayerMemory,
  type RunReport,
  type RunResult,
} from "@bimpee/shared";
import type { AiService } from "./ai/types";
import { cleanText, sanitizeDisplayName } from "./ai/untrusted";
import { GUEST_HEADER, type AuthService } from "./auth";
import { errMsg, isOriginAllowed, log, type Config } from "./config";
import type { Limiter } from "./limiter";
import type { MemoryRepo } from "./memory/types";
import type { CityAiService } from "./ai/cityTypes";
import { MockCityAiService } from "./ai/cityMock";
import { MemoryBlobStore } from "./city/blobs";
import { LandmarkService, repoQuota } from "./city/landmarks";
import { SAVE_PATH_RE, mountCityRoutes } from "./city/routes";
import { DisabledProvider } from "./city/textTo3d";
import { HttpError, INT32_MAX, checked, readBody, type AppEnv, type Ctx } from "./http";

export interface Deps {
  ai: AiService;
  memory: MemoryRepo;
  auth: AuthService;
  limiter?: Limiter;
  config: Config;
  /** Bimpee City AI (defaults to the keyless mock). */
  cityAi?: CityAiService;
  /** Bimpee City landmark models (defaults to a disabled provider with in-memory storage in dev). */
  landmarks?: LandmarkService;
}

/** Default landmark service: provider disabled; in-memory blobs only in dev. */
export function defaultLandmarks(memory: MemoryRepo, config: Config): LandmarkService {
  return new LandmarkService({
    provider: new DisabledProvider(),
    meta: memory,
    blobs: config.dev ? new MemoryBlobStore() : null,
    consumeQuota: repoQuota(memory, config.landmarks.userDailyLimit),
    globalDailyLimit: config.landmarks.globalDailyLimit,
  });
}

export const NAME_HEADER = "x-bimpee-name";

/**
 * Bounds a client-reported run before it is stored: free text ends up on the
 * public leaderboard and in memory, and score/kills go into int4 columns.
 */
function boundReport(r: RunReport): RunReport {
  if (r.runId.length < 1 || r.runId.length > 64) throw new HttpError(400, "invalid request: runId must be 1-64 chars");
  return {
    ...r,
    worldName: cleanText(r.worldName, 60) || "Unknown world",
    biome: cleanText(r.biome, 32) || "unknown",
    killedBy: r.killedBy ? cleanText(r.killedBy, 80) || null : null,
    highlights: r.highlights.map((h) => cleanText(h, 200)).filter(Boolean),
    directivesUsed: r.directivesUsed.map((d) => cleanText(d, 32)),
    score: Math.min(r.score, INT32_MAX),
    kills: Math.min(r.kills, INT32_MAX),
    level: Math.min(r.level, INT32_MAX),
  };
}

export function createApp(deps: Deps) {
  const { ai, memory, auth, limiter, config } = deps;
  const app = new Hono<AppEnv>();

  app.use(
    "/api/*",
    cors({
      origin: (origin) => (isOriginAllowed(config, origin) ? origin : null),
      allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", GUEST_HEADER, NAME_HEADER],
      maxAge: 600,
    }),
  );

  // Small bodies everywhere, except city saves (PUT /api/city/saves/:id, ~1.4 MB).
  const onTooLarge = (c: Ctx) => c.json({ error: "request body too large" }, 413);
  const smallBody = bodyLimit({ maxSize: config.maxBodyBytes, onError: onTooLarge });
  const saveBody = bodyLimit({ maxSize: config.maxSaveBytes, onError: onTooLarge });
  app.use("/api/*", (c, next) => (c.req.method === "PUT" && SAVE_PATH_RE.test(c.req.path) ? saveBody(c, next) : smallBody(c, next)));

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    log.error(`[api] ${c.req.method} ${c.req.path} failed: ${errMsg(err)}`);
    return c.json({ error: "internal error" }, 500);
  });
  app.notFound((c) => c.json({ error: "not found" }, 404));

  const requireAuth = async (c: Ctx, next: () => Promise<void>) => {
    const r = await auth.authenticate(c.req.raw.headers);
    if (!r.ok) return c.json({ error: r.error }, 401);
    c.set("userId", r.userId);
    await next();
  };

  const limitFor =
    (prefix: string, message = "rate limited: too many AI requests, slow down") =>
    async (c: Ctx, next: () => Promise<void>) => {
      if (limiter && !(await limiter.limit(`${prefix}:${c.get("userId")}`))) {
        return c.json({ error: message }, 429);
      }
      await next();
    };
  const rateLimit = limitFor("ai");

  /** Loads memory and applies a display-name override from the x-bimpee-name header. */
  const loadMemory = async (c: Ctx): Promise<PlayerMemory> => {
    const userId = c.get("userId");
    const m = await memory.getMemory(userId);
    const name = sanitizeDisplayName(c.req.header(NAME_HEADER));
    if (name && name !== m.displayName) {
      await memory.setDisplayName(userId, name);
      return { ...m, displayName: name };
    }
    return m;
  };
  /** Memory is a nice-to-have for AI routes: degrade to none instead of failing the request. */
  const tryLoadMemory = async (c: Ctx): Promise<PlayerMemory | null> => {
    try {
      return await loadMemory(c);
    } catch (e) {
      log.error(`[api] memory load failed: ${errMsg(e)}`);
      return null;
    }
  };

  app.get("/api/health", (c) => {
    const body: HealthResponse = { ok: true, ai: ai.enabled, memory: memory.persistent, models: ai.models };
    return c.json(body);
  });

  app.get("/api/leaderboard", async (c) => {
    const scope = c.req.query("scope") ?? "all";
    if (scope !== "daily" && scope !== "all") throw new HttpError(400, "scope must be 'daily' or 'all'");
    const entries = await memory.leaderboard(scope);
    c.header("Cache-Control", "public, max-age=15");
    return c.json(checked(LeaderboardResponseSchema, { entries }, "leaderboard"));
  });

  app.get("/api/memory", requireAuth, async (c) => c.json(await loadMemory(c)));

  app.post("/api/world", requireAuth, rateLimit, async (c) => {
    const req = await readBody(c, WorldRequestSchema);
    const userId = c.get("userId");
    const [mem, recentBiomes] = await Promise.all([
      tryLoadMemory(c),
      memory.recentBiomes(userId, 3).catch((e: unknown) => {
        log.error(`[api] recentBiomes failed: ${errMsg(e)}`);
        return [] as string[];
      }),
    ]);
    const res = await ai.generateWorld({ memory: mem, wish: req.wish, seed: req.seed, recentBiomes });
    const ok = WorldResponseSchema.safeParse(res);
    if (ok.success) return c.json(ok.data);
    log.error("[api] world response failed schema; serving fallback world");
    const seed = req.seed ?? res.world.seed;
    return c.json({ world: generateFallbackWorld(seed), source: "fallback", model: "fallback", latencyMs: res.latencyMs });
  });

  app.post("/api/director", requireAuth, rateLimit, async (c) => {
    const req = await readBody(c, DirectorRequestSchema);
    const world = sanitizeWorldSpec(req.world) ?? req.world;
    const mem = await tryLoadMemory(c);
    const res = await ai.director(world, req.telemetry, mem, c.req.raw.signal);
    const ok = DirectorResponseSchema.safeParse(res);
    if (ok.success) return c.json(ok.data);
    log.error("[api] director response failed schema; serving local director");
    return c.json(localDirector(world, req.telemetry));
  });

  app.post("/api/narrate", requireAuth, rateLimit, async (c) => {
    const req = await readBody(c, NarrateRequestSchema);
    const world = sanitizeWorldSpec(req.world) ?? req.world;
    const mem = await tryLoadMemory(c);
    c.header("Cache-Control", "no-cache");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      const ctrl = new AbortController();
      stream.onAbort(() => ctrl.abort());
      const send = (chunk: NarrateChunk) => stream.writeSSE({ data: JSON.stringify(chunk) });
      try {
        for await (const text of ai.narrate({ ...req, world }, mem, ctrl.signal)) {
          if (ctrl.signal.aborted) break;
          if (text) await send({ text });
        }
      } catch (e) {
        log.error(`[api] narration failed: ${errMsg(e)}`);
        if (!ctrl.signal.aborted) await send({ error: "narration unavailable" });
      } finally {
        if (!ctrl.signal.aborted) await send({ done: true });
      }
    });
  });

  app.post("/api/runs", requireAuth, rateLimit, async (c) => {
    const report = boundReport(await readBody(c, RunRequestSchema));
    const userId = c.get("userId");
    if (await memory.hasRun(userId, report.runId)) throw new HttpError(409, "run already recorded");
    const current = await loadMemory(c);
    const { reflection } = await ai.reflect(current, report);
    const merged = mergeReflection(current, report, reflection);
    const inserted = await memory.addRun(userId, report, reflection);
    if (!inserted) throw new HttpError(409, "run already recorded");
    await memory.saveMemory(merged);
    const rank = await memory.rankOf(report.score).catch((e: unknown) => {
      log.error(`[api] rank lookup failed: ${errMsg(e)}`);
      return null;
    });
    const body: RunResult = { summary: reflection.summary, epitaph: reflection.epitaph, bestScore: merged.bestScore, rank };
    return c.json(checked(RunResultSchema, body, "runs"));
  });

  mountCityRoutes(app, {
    cityAi: deps.cityAi ?? new MockCityAiService(config.models),
    memory,
    landmarks: deps.landmarks ?? defaultLandmarks(memory, config),
    requireAuth,
    limit: limitFor,
    nameHeader: NAME_HEADER,
  });

  return app;
}
