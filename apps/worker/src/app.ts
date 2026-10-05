import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { z } from "zod";
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

export interface Deps {
  ai: AiService;
  memory: MemoryRepo;
  auth: AuthService;
  limiter?: Limiter;
  config: Config;
}

type AppEnv = { Variables: { userId: string } };
type Ctx = Context<AppEnv>;

export const NAME_HEADER = "x-bimpee-name";

class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 404 | 409 | 413 | 429 | 500,
    message: string,
  ) {
    super(message);
  }
}

async function readBody<S extends z.ZodType>(c: Ctx, schema: S): Promise<z.infer<S>> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new HttpError(400, "body must be valid JSON");
  }
  const p = schema.safeParse(json);
  if (!p.success) {
    const issues = p.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new HttpError(400, `invalid request: ${issues}`);
  }
  return p.data;
}

/** Validate our own responses in the hot path: a contract drift is a bug we want in the logs, not on the client. */
function checked<S extends z.ZodType>(schema: S, value: z.infer<S>, what: string): z.infer<S> {
  const p = schema.safeParse(value);
  if (!p.success) {
    log.error(`[api] ${what} response failed its schema: ${p.error.issues[0]?.message ?? "?"}`);
    throw new HttpError(500, "internal error");
  }
  return p.data;
}

const INT32_MAX = 2_147_483_647;

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
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", GUEST_HEADER, NAME_HEADER],
      maxAge: 600,
    }),
  );

  app.use(
    "/api/*",
    bodyLimit({
      maxSize: config.maxBodyBytes,
      onError: (c) => c.json({ error: "request body too large" }, 413),
    }),
  );

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

  const rateLimit = async (c: Ctx, next: () => Promise<void>) => {
    if (limiter && !(await limiter.limit(`ai:${c.get("userId")}`))) {
      return c.json({ error: "rate limited: too many AI requests, slow down" }, 429);
    }
    await next();
  };

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
    const res = await ai.director(world, req.telemetry, mem);
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

  return app;
}
