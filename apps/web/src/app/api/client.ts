import {
  DirectorResponseSchema,
  HealthResponseSchema,
  LeaderboardResponseSchema,
  PlayerMemorySchema,
  RunResultSchema,
  WorldResponseSchema,
  type DirectorRequest,
  type DirectorResponse,
  type HealthResponse,
  type LeaderboardResponse,
  type NarrateChunk,
  type NarrateRequest,
  type PlayerMemory,
  type RunReport,
  type RunResult,
  type WorldRequest,
  type WorldResponse,
} from "@bimpee/shared";
import { ApiError, rawRequest, requestJson, type HttpDeps } from "./http";
import { readNarrateStream } from "./sse";

export const TIMEOUTS = {
  health: 4_000,
  memory: 8_000,
  world: 30_000,
  director: 9_000,
  narrateConnect: 8_000,
  narrateTotal: 25_000,
  runs: 20_000,
  leaderboard: 8_000,
} as const;

export interface ApiClient {
  health(signal?: AbortSignal): Promise<HealthResponse>;
  memory(signal?: AbortSignal): Promise<PlayerMemory>;
  world(req: WorldRequest, signal?: AbortSignal): Promise<WorldResponse>;
  director(req: DirectorRequest, signal?: AbortSignal): Promise<DirectorResponse>;
  /** Streams narration chunks. Throws ApiError on connect failure; the iterator ends on {done} or stream end. */
  narrate(req: NarrateRequest, signal?: AbortSignal): AsyncGenerator<NarrateChunk>;
  runs(report: RunReport, signal?: AbortSignal): Promise<RunResult>;
  leaderboard(scope: "daily" | "all", signal?: AbortSignal): Promise<LeaderboardResponse>;
}

export function createApiClient(deps: HttpDeps): ApiClient {
  return {
    health: (signal) => requestJson(deps, "GET", "/api/health", undefined, HealthResponseSchema, { timeoutMs: TIMEOUTS.health, signal }),
    memory: (signal) => requestJson(deps, "GET", "/api/memory", undefined, PlayerMemorySchema, { timeoutMs: TIMEOUTS.memory, signal }),
    world: (req, signal) => requestJson(deps, "POST", "/api/world", req, WorldResponseSchema, { timeoutMs: TIMEOUTS.world, signal }),
    director: (req, signal) => requestJson(deps, "POST", "/api/director", req, DirectorResponseSchema, { timeoutMs: TIMEOUTS.director, signal }),
    runs: (report, signal) => requestJson(deps, "POST", "/api/runs", report, RunResultSchema, { timeoutMs: TIMEOUTS.runs, signal }),
    leaderboard: (scope, signal) =>
      requestJson(deps, "GET", `/api/leaderboard?scope=${scope}`, undefined, LeaderboardResponseSchema, {
        timeoutMs: TIMEOUTS.leaderboard,
        signal,
      }),
    narrate: (req, signal) => narrateStream(deps, req, signal),
  };
}

async function* narrateStream(deps: HttpDeps, req: NarrateRequest, signal?: AbortSignal): AsyncGenerator<NarrateChunk> {
  // Overall budget for the whole stream, separate from the connect timeout.
  const total = new AbortController();
  const totalTimer = setTimeout(() => total.abort(), TIMEOUTS.narrateTotal);
  const onOuter = () => total.abort();
  signal?.addEventListener("abort", onOuter, { once: true });
  if (signal?.aborted) total.abort();
  try {
    const { res, done } = await rawRequest(deps, "POST", "/api/narrate", req, { timeoutMs: TIMEOUTS.narrateConnect, signal: total.signal }, "text/event-stream");
    // Connected: the connect timeout no longer applies, the total budget does.
    done();
    if (!res.body) throw new ApiError("parse", "/api/narrate: empty body");
    const ctype = res.headers.get("content-type") ?? "";
    if (ctype.includes("application/json")) {
      // Some servers answer non-streaming; accept {text} or {error}.
      const j = (await res.json()) as unknown;
      if (j && typeof j === "object" && "text" in j && typeof (j as { text: unknown }).text === "string") yield { text: (j as { text: string }).text };
      yield { done: true };
      return;
    }
    yield* readNarrateStream(res.body, total.signal);
  } finally {
    clearTimeout(totalTimer);
    signal?.removeEventListener("abort", onOuter);
  }
}
