import { ClaudeAiService, createAnthropicClient } from "./ai/claude";
import { MockAiService } from "./ai/mock";
import { defaultLandmarks, type Deps } from "./app";
import { ClaudeCityAiService } from "./ai/cityClaude";
import { MockCityAiService } from "./ai/cityMock";
import { MemoryBlobStore, R2BlobStore } from "./city/blobs";
import { BlobMetaStore, LandmarkService, repoQuota } from "./city/landmarks";
import { createTextTo3DProvider } from "./city/textTo3d";
import { GuestAuth, SupabaseAuth } from "./auth";
import { loadConfig, log, setLogLevel, type Env } from "./config";
import { MemoryLimiter, bindingLimiter } from "./limiter";
import { InMemoryRepo } from "./memory/inMemory";
import { SupabaseMemoryRepo, createServiceClient } from "./memory/supabase";

/**
 * Builds dependencies from the environment:
 * - ANTHROPIC_API_KEY set     -> Claude, else MockAiService (fallback worlds, local director, canned narration)
 * - SUPABASE_URL + SERVICE_ROLE_KEY -> Supabase memory + bearer auth, else in-memory repo + guest header auth
 */
export function buildDeps(env: Partial<Env>): Deps {
  setLogLevel(env.LOG_LEVEL);
  const config = loadConfig(env);
  const client = env.ANTHROPIC_API_KEY ? createAnthropicClient(env.ANTHROPIC_API_KEY) : null;
  const ai = client ? new ClaudeAiService(client, config.models) : new MockAiService(config.models);
  const cityAi = client ? new ClaudeCityAiService(client, config.models) : new MockCityAiService(config.models);

  let deps: Deps;
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    const db = createServiceClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    deps = { ai, memory: new SupabaseMemoryRepo(db), auth: SupabaseAuth.fromClient(db), config };
  } else {
    deps = { ai, memory: new InMemoryRepo(), auth: new GuestAuth(), config };
    if (env.ENVIRONMENT === "production") {
      log.warn("[bimpee] Supabase is not configured: running with guest auth and in-memory storage (data is lost on restart)");
    }
  }
  deps.cityAi = cityAi;
  deps.landmarks = buildLandmarks(env, deps);
  deps.limiter = env.AI_LIMITER ? bindingLimiter(env.AI_LIMITER) : new MemoryLimiter(30, 60_000);
  log.info(`[bimpee] ai=${ai.enabled ? "claude" : "mock"} memory=${deps.memory.persistent ? "supabase" : "in-memory"} auth=${deps.auth.mode}`);
  return deps;
}

/**
 * Landmark models: R2 (MODELS binding) stores GLBs, and also job metadata when
 * Supabase is absent; without R2, dev keeps models in memory and production
 * disables generation (cached models can't be stored).
 */
function buildLandmarks(env: Partial<Env>, deps: Deps): LandmarkService {
  const { config, memory } = deps;
  const provider = createTextTo3DProvider(config.landmarks.provider, { meshyApiKey: env.MESHY_API_KEY, warn: (m) => log.warn(m) });
  if (!env.MODELS) {
    if (provider.enabled && !config.dev) log.warn("[landmarks] no MODELS R2 binding: landmark generation disabled");
    return provider.enabled && config.dev
      ? new LandmarkService({
          provider,
          meta: memory,
          blobs: new MemoryBlobStore(),
          consumeQuota: repoQuota(memory, config.landmarks.userDailyLimit),
          globalDailyLimit: config.landmarks.globalDailyLimit,
        })
      : defaultLandmarks(memory, config);
  }
  return new LandmarkService({
    provider,
    meta: memory.persistent ? memory : new BlobMetaStore(env.MODELS, memory),
    blobs: new R2BlobStore(env.MODELS),
    consumeQuota: repoQuota(memory, config.landmarks.userDailyLimit),
    globalDailyLimit: config.landmarks.globalDailyLimit,
  });
}

// One set of deps per isolate (bindings and vars are fixed for an isolate's lifetime). The
// in-memory repo must be shared between requests, so this cache matters in mock mode.
// Deliberately not keyed on the env object's identity, which the runtime does not guarantee.
let cached: Deps | null = null;
export function getDeps(env: Env): Deps {
  cached ??= buildDeps(env);
  return cached;
}
