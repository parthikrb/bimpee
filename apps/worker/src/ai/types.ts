import type {
  DirectorResponse,
  NarrateRequest,
  PlayerMemory,
  RunReflection,
  RunReport,
  Telemetry,
  WorldResponse,
  WorldSpec,
} from "@bimpee/shared";
import type { Models } from "../config";

export interface WorldInput {
  /** Player memory for personalisation (null for shared rooms). */
  memory: PlayerMemory | null;
  /** Untrusted free text from the player. */
  wish?: string;
  seed?: number;
  /** Biomes of the player's last runs, to avoid repeats. */
  recentBiomes?: string[];
  timeoutMs?: number;
}

export interface ReflectionResult {
  reflection: RunReflection;
  source: "claude" | "fallback";
}

export interface AiService {
  /** True when backed by Claude (an API key is configured). */
  readonly enabled: boolean;
  readonly models: Models;
  generateWorld(input: WorldInput): Promise<WorldResponse>;
  /** `signal`: aborts the model call when the client has gone away (it falls back locally anyway). */
  director(world: WorldSpec, telemetry: Telemetry, memory: PlayerMemory | null, signal?: AbortSignal): Promise<DirectorResponse>;
  /** Yields narration text fragments. Throws on failure (callers turn it into an `{error}` chunk). */
  narrate(req: NarrateRequest, memory: PlayerMemory | null, signal?: AbortSignal): AsyncIterable<string>;
  reflect(memory: PlayerMemory, report: RunReport): Promise<ReflectionResult>;
}
