/** Worker bindings and vars (see wrangler.jsonc / .dev.vars.example). */
export interface Env {
  ANTHROPIC_API_KEY?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  WORLD_MODEL?: string;
  DIRECTOR_MODEL?: string;
  NARRATOR_MODEL?: string;
  ALLOWED_ORIGINS?: string;
  ENVIRONMENT?: string;
  LOG_LEVEL?: string;
  AI_LIMITER?: RateLimit;
  WorldRoom: DurableObjectNamespace;
  /** Bimpee City: R2 bucket for generated landmark models (optional; in-memory in dev when absent). */
  MODELS?: R2Bucket;
  /** Bimpee City: text-to-3D provider ("meshy" | "disabled", default disabled). */
  TEXT_TO_3D_PROVIDER?: string;
  MESHY_API_KEY?: string;
  /** New landmark generations per user per UTC day (default 5). */
  LANDMARK_USER_DAILY_LIMIT?: string;
  /** New landmark generations across all users per UTC day (default 200). */
  LANDMARK_GLOBAL_DAILY_LIMIT?: string;
}

export const DEFAULT_MODEL = "claude-opus-5-5";

export interface Models {
  world: string;
  director: string;
  narrator: string;
}

export interface Config {
  models: Models;
  /** Exact origins allowed by CORS (and for room websockets). */
  allowedOrigins: string[];
  /** Development mode: localhost dev origins allowed. */
  dev: boolean;
  /** Max accepted request body in bytes. */
  maxBodyBytes: number;
  /** Max body for PUT /api/city/saves/:id (1.4 MiB: a 1.4M-char state plus the spec). */
  maxSaveBytes: number;
  landmarks: LandmarkConfig;
}

export interface LandmarkConfig {
  provider: "meshy" | "disabled";
  userDailyLimit: number;
  globalDailyLimit: number;
}

const intVar = (v: string | undefined, def: number, lo: number, hi: number) => {
  const n = Number.parseInt((v ?? "").trim(), 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

const DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

const modelId = (v: string | undefined) => {
  const s = (v ?? "").trim();
  // Only plain model ids: letters, digits, dashes, dots.
  return /^[a-z0-9][a-z0-9.-]{2,63}$/.test(s) ? s : DEFAULT_MODEL;
};

export function loadConfig(env: Partial<Env>): Config {
  // Without Supabase the worker is in local/mock mode, so dev origins are fine.
  const dev = env.ENVIRONMENT === "development" || !(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
  const listed = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter((s) => /^https?:\/\/[^\s/]+$/.test(s));
  return {
    models: { world: modelId(env.WORLD_MODEL), director: modelId(env.DIRECTOR_MODEL), narrator: modelId(env.NARRATOR_MODEL) },
    allowedOrigins: [...new Set([...listed, ...(dev ? DEV_ORIGINS : [])])],
    dev,
    maxBodyBytes: 32 * 1024,
    maxSaveBytes: Math.floor(1.4 * 1024 * 1024),
    landmarks: {
      provider: (env.TEXT_TO_3D_PROVIDER ?? "").trim().toLowerCase() === "meshy" ? "meshy" : "disabled",
      userDailyLimit: intVar(env.LANDMARK_USER_DAILY_LIMIT, 5, 0, 100),
      globalDailyLimit: intVar(env.LANDMARK_GLOBAL_DAILY_LIMIT, 200, 0, 100_000),
    },
  };
}

export function isOriginAllowed(config: Config, origin: string | null | undefined): boolean {
  return !!origin && config.allowedOrigins.includes(origin);
}

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
let threshold: Level = "info";
export const setLogLevel = (l: string | undefined) => {
  if (l && l in ORDER) threshold = l as Level;
};
export const log = {
  debug: (...a: unknown[]) => ORDER[threshold] <= 0 && console.debug(...a),
  info: (...a: unknown[]) => ORDER[threshold] <= 1 && console.info(...a),
  warn: (...a: unknown[]) => ORDER[threshold] <= 2 && console.warn(...a),
  error: (...a: unknown[]) => console.error(...a),
};

/** Error text that is safe to log: message only, never request bodies or keys. */
export const errMsg = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 300);
