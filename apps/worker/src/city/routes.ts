import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  CityFateResponseSchema,
  CityMemorySchema,
  CitySaveBodySchema,
  CitySaveMetaSchema,
  CitySessionReportSchema,
  CitySpecRequestSchema,
  CitySpecResponseSchema,
  CityFateRequestSchema,
  CouncilChatRequestSchema,
  GazetteRequestSchema,
  LandmarkModelRequestSchema,
  LandmarkModelResponseSchema,
  generateFallbackCity,
  localFate,
  sanitizeCitySpec,
  type CityMemory,
  type CitySpec,
  type CouncilChunk,
} from "@bimpee/shared/city";
import type { CityAiService, CouncilInput } from "../ai/cityTypes";
import { postProcessCityDirectives } from "../ai/cityDirectives";
import { cleanText, sanitizeDisplayName } from "../ai/untrusted";
import { errMsg, log } from "../config";
import { HttpError, INT32_MAX, checked, readBody, type AppEnv, type Ctx, type Middleware } from "../http";
import { parseCityMeta } from "../memory/city";
import type { MemoryRepo } from "../memory/types";
import { GLB_CONTENT_TYPE, HASH_RE, LandmarkQuotaError, modelKey, type LandmarkService } from "./landmarks";
import { applyCouncilUpdate, emptyCouncilMemory, mergeCitySession } from "./logic";

export const SAVE_ID_RE = /^[a-z0-9-]{3,64}$/;
export const SAVE_PATH_RE = /^\/api\/city\/saves\/[^/]+$/;

export interface CityRouteDeps {
  cityAi: CityAiService;
  memory: MemoryRepo;
  landmarks: LandmarkService;
  requireAuth: Middleware;
  /** Per-user limiter middleware for a key prefix (e.g. "ai", "save", "lm"). */
  limit: (prefix: string, message?: string) => Middleware;
  nameHeader: string;
}

/** Client-held specs are re-validated and repaired; an unrepairable one is a 400. */
function cleanSpec(spec: CitySpec): CitySpec {
  const s = sanitizeCitySpec(spec);
  if (!s) throw new HttpError(400, "invalid request: spec");
  return s;
}

const sseHeaders = (c: Ctx) => {
  c.header("Cache-Control", "no-cache");
  c.header("X-Accel-Buffering", "no");
};

export function mountCityRoutes(app: Hono<AppEnv>, d: CityRouteDeps) {
  const { cityAi, memory, landmarks, requireAuth } = d;
  const ai = d.limit("ai");

  /** The mayor's city memory, with a display-name override from the name header. */
  const loadCityMemory = async (c: Ctx): Promise<CityMemory> => {
    const userId = c.get("userId");
    const m = await memory.getCityMemory(userId);
    const name = sanitizeDisplayName(c.req.header(d.nameHeader));
    if (name && name !== m.mayorName) {
      await memory.setDisplayName(userId, name).catch((e: unknown) => log.error(`[city] setDisplayName failed: ${errMsg(e)}`));
      return { ...m, mayorName: name };
    }
    return m;
  };
  const tryLoadCityMemory = async (c: Ctx): Promise<CityMemory | null> => {
    try {
      return await loadCityMemory(c);
    } catch (e) {
      log.error(`[city] memory load failed: ${errMsg(e)}`);
      return null;
    }
  };

  app.get("/api/city/memory", requireAuth, async (c) => c.json(checked(CityMemorySchema, await loadCityMemory(c), "city memory")));

  app.post("/api/city/spec", requireAuth, ai, async (c) => {
    const req = await readBody(c, CitySpecRequestSchema);
    const userId = c.get("userId");
    const [mem, rawMeta] = await Promise.all([
      tryLoadCityMemory(c),
      memory.getGameMemory(userId, "city_meta").catch((e: unknown) => {
        log.error(`[city] meta load failed: ${errMsg(e)}`);
        return null;
      }),
    ]);
    const meta = parseCityMeta(rawMeta);
    const res = await cityAi.designCity({ memory: mem, wish: req.wish, seed: req.seed, recentClimates: meta.recentClimates });
    const seed = req.seed ?? res.spec.seed;
    const ok = CitySpecResponseSchema.safeParse({ ...res, spec: { ...res.spec, seed } });
    const body = ok.success ? ok.data : { spec: generateFallbackCity(seed), source: "fallback" as const, model: "fallback", latencyMs: res.latencyMs };
    if (!ok.success) log.error("[city] spec response failed schema; serving fallback city");
    // Remember the climate so the next city differs (best effort).
    const recentClimates = [body.spec.climate.kind, ...meta.recentClimates].slice(0, 5);
    await memory
      .saveGameMemory(userId, "city_meta", { ...meta, recentClimates })
      .catch((e: unknown) => log.error(`[city] meta save failed: ${errMsg(e)}`));
    return c.json(body);
  });

  app.post("/api/city/fate", requireAuth, ai, async (c) => {
    const req = await readBody(c, CityFateRequestSchema);
    const spec = cleanSpec(req.spec);
    const mem = await tryLoadCityMemory(c);
    const res = await cityAi.fate(spec, req.telemetry, mem, c.req.raw.signal);
    const ok = CityFateResponseSchema.safeParse(res);
    if (ok.success) return c.json(ok.data);
    log.error("[city] fate response failed schema; serving localFate");
    const r = localFate(spec, req.telemetry);
    return c.json({ directives: postProcessCityDirectives(spec, req.telemetry, r.directives), reasoning: r.reasoning, model: "local", latencyMs: 0 });
  });

  app.post("/api/city/council", requireAuth, ai, async (c) => {
    const req = await readBody(c, CouncilChatRequestSchema);
    const spec = cleanSpec(req.spec);
    const memberId = cleanText(req.memberId, 32);
    const member = spec.council.find((m) => m.id === memberId);
    if (!member) throw new HttpError(400, "invalid request: unknown council member");
    if (req.history.at(-1)!.from !== "mayor") throw new HttpError(400, "invalid request: the last message must be the mayor's");
    const userId = c.get("userId");
    const mem = await tryLoadCityMemory(c);
    const input: CouncilInput = {
      spec,
      telemetry: req.telemetry,
      member,
      memberMemory: mem?.council[member.id] ?? emptyCouncilMemory(),
      mayorName: mem?.mayorName ?? "Mayor",
      history: req.history,
    };
    sseHeaders(c);
    return streamSSE(c, async (stream) => {
      const ctrl = new AbortController();
      stream.onAbort(() => ctrl.abort());
      const send = (chunk: CouncilChunk) => stream.writeSSE({ data: JSON.stringify(chunk) });
      let reply = "";
      let failed = false;
      try {
        for await (const text of cityAi.councilReply(input, ctrl.signal)) {
          if (ctrl.signal.aborted) break;
          if (text) {
            reply += text;
            await send({ text });
          }
        }
      } catch (e) {
        failed = true;
        log.error(`[city] council reply failed: ${errMsg(e)}`);
        if (!ctrl.signal.aborted) await send({ error: "the council member is unavailable" });
      }
      try {
        if (!failed && !ctrl.signal.aborted && reply.trim()) {
          const update = await cityAi.councilUpdate(input, reply);
          const next = applyCouncilUpdate(input.memberMemory, update);
          try {
            // Re-read right before writing so other concurrent changes survive (last write wins per member).
            const fresh = await memory.getCityMemory(userId);
            const council = { ...fresh.council };
            delete council[member.id]; // re-insert: most recently talked-to members are kept longest
            council[member.id] = next;
            await memory.saveCityMemory({ ...fresh, mayorName: mem?.mayorName ?? fresh.mayorName, council });
          } catch (e) {
            log.error(`[city] council memory save failed: ${errMsg(e)}`);
          }
          if (!ctrl.signal.aborted) await send({ memory: next });
        }
      } finally {
        if (!ctrl.signal.aborted) await send({ done: true });
      }
    });
  });

  app.post("/api/city/gazette", requireAuth, ai, async (c) => {
    const req = await readBody(c, GazetteRequestSchema);
    const spec = cleanSpec(req.spec);
    sseHeaders(c);
    return streamSSE(c, async (stream) => {
      const ctrl = new AbortController();
      stream.onAbort(() => ctrl.abort());
      const send = (chunk: CouncilChunk) => stream.writeSSE({ data: JSON.stringify(chunk) });
      try {
        for await (const text of cityAi.gazette({ spec, telemetry: req.telemetry, event: req.event }, ctrl.signal)) {
          if (ctrl.signal.aborted) break;
          if (text) await send({ text });
        }
      } catch (e) {
        log.error(`[city] gazette failed: ${errMsg(e)}`);
        if (!ctrl.signal.aborted) await send({ error: "the gazette is unavailable" });
      } finally {
        if (!ctrl.signal.aborted) await send({ done: true });
      }
    });
  });

  app.post("/api/city/session", requireAuth, ai, async (c) => {
    const report = await readBody(c, CitySessionReportSchema);
    if (!report.cityId.trim()) throw new HttpError(400, "invalid request: cityId");
    const userId = c.get("userId");
    const current = await loadCityMemory(c);
    const { reflection } = await cityAi.reflectCity(current, report);
    const first = await memory.markCityReported(userId, cleanText(report.cityId, 64));
    // Re-read so a council conversation that finished meanwhile is not lost.
    const fresh = await memory.getCityMemory(userId).catch(() => current);
    const merged = mergeCitySession({ ...fresh, mayorName: current.mayorName }, report, reflection, first);
    await memory.saveCityMemory(merged);
    return c.json({ summary: cleanText(reflection.summary, 240) });
  });

  // ---- saves ------------------------------------------------------------------

  const saveId = (c: Ctx) => {
    const id = c.req.param("id") ?? "";
    if (!SAVE_ID_RE.test(id)) throw new HttpError(400, "invalid save id: use 3-64 chars of a-z, 0-9 and -");
    return id;
  };

  app.get("/api/city/saves", requireAuth, async (c) => {
    const saves = await memory.listCitySaves(c.get("userId"));
    return c.json({ saves: saves.map((s) => checked(CitySaveMetaSchema, s, "save meta")) });
  });

  app.put("/api/city/saves/:id", requireAuth, d.limit("save", "rate limited: too many saves, slow down"), async (c) => {
    const id = saveId(c);
    const body = await readBody(c, CitySaveBodySchema);
    const spec = cleanSpec(body.spec);
    const bounded = {
      ...body,
      spec,
      day: Math.min(Math.max(body.day, 0), INT32_MAX),
      population: Math.min(Math.max(body.population, 0), INT32_MAX),
    };
    const cityName = cleanText(spec.name, 60) || "Unnamed city";
    const res = await memory.putCitySave(c.get("userId"), id, cityName, bounded);
    if (res === "limit") throw new HttpError(409, "save limit reached: delete or overwrite an existing save (max 10)");
    return c.json(checked(CitySaveMetaSchema, res, "save meta"));
  });

  app.get("/api/city/saves/:id", requireAuth, async (c) => {
    const save = await memory.getCitySave(c.get("userId"), saveId(c));
    if (!save) throw new HttpError(404, "save not found");
    return c.json(save);
  });

  // ---- landmark models ----------------------------------------------------------

  app.post("/api/city/landmark", requireAuth, d.limit("lm", "rate limited: too many landmark requests, slow down"), async (c) => {
    const req = await readBody(c, LandmarkModelRequestSchema);
    try {
      const res = await landmarks.request(c.get("userId"), req.prompt);
      return c.json(checked(LandmarkModelResponseSchema, res, "landmark"));
    } catch (e) {
      if (e instanceof LandmarkQuotaError) throw new HttpError(429, e.message);
      throw e;
    }
  });

  /**
   * Content-addressed and immutable, so public: GLTF loaders fetch it without
   * auth headers, and the hash only identifies a prompt's model (no user data).
   */
  app.get("/api/city/models/:hash", async (c) => {
    const hash = c.req.param("hash");
    if (!HASH_RE.test(hash)) throw new HttpError(404, "model not found");
    const obj = await landmarks.blobs?.get(modelKey(hash));
    if (!obj) throw new HttpError(404, "model not found");
    return c.body(obj.body, 200, {
      "content-type": GLB_CONTENT_TYPE,
      "content-length": String(obj.size),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    });
  });
}
