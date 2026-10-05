import { ClaudeAiService, createAnthropicClient } from "./ai/claude";
import { MockAiService } from "./ai/mock";
import type { Deps } from "./app";
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
  const ai = env.ANTHROPIC_API_KEY ? new ClaudeAiService(createAnthropicClient(env.ANTHROPIC_API_KEY), config.models) : new MockAiService(config.models);

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
  deps.limiter = env.AI_LIMITER ? bindingLimiter(env.AI_LIMITER) : new MemoryLimiter(30, 60_000);
  log.info(`[bimpee] ai=${ai.enabled ? "claude" : "mock"} memory=${deps.memory.persistent ? "supabase" : "in-memory"} auth=${deps.auth.mode}`);
  return deps;
}

// One set of deps per isolate (bindings and vars are fixed for an isolate's lifetime). The
// in-memory repo must be shared between requests, so this cache matters in mock mode.
// Deliberately not keyed on the env object's identity, which the runtime does not guarantee.
let cached: Deps | null = null;
export function getDeps(env: Env): Deps {
  cached ??= buildDeps(env);
  return cached;
}
