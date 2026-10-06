import { z } from "zod";
import type {
  CityFateResponse,
  CityMemory,
  CitySessionReport,
  CitySpec,
  CitySpecResponse,
  CityTelemetry,
  CouncilChatRequest,
  CouncilMember,
  CouncilMemory,
} from "@bimpee/shared/city";
import type { Models } from "../config";

/** Structured answer of the small "update this member's memory" call. */
export const CouncilUpdateSchema = z.object({
  approvalDelta: z
    .number()
    .min(-0.2)
    .max(0.2)
    .describe("how much this conversation changed the member's approval of the mayor; 0 if it was neutral"),
  notes: z
    .array(z.string().max(160).describe("short first-person note the member keeps about the mayor"))
    .max(2)
    .describe("only things worth remembering (promises, insults, deals); empty if nothing new"),
});
export type CouncilUpdate = z.infer<typeof CouncilUpdateSchema>;

/** Structured answer of the end-of-session reflection. */
export const CityReflectionSchema = z.object({
  summary: z.string().max(240).describe("one or two vivid sentences in second person about this session"),
  traits: z
    .array(z.string().max(60).describe("short phrase, e.g. 'green energy purist'"))
    .max(10)
    .describe("the mayor's observed play style; keep earlier traits that still hold"),
});
export type CityReflection = z.infer<typeof CityReflectionSchema>;

export interface CitySpecInput {
  memory: CityMemory | null;
  /** Untrusted free text from the player. */
  wish?: string;
  seed?: number;
  /** Climates of the player's recent cities, to avoid repeats. */
  recentClimates?: string[];
  timeoutMs?: number;
}

export interface CouncilInput {
  spec: CitySpec;
  telemetry: CityTelemetry;
  member: CouncilMember;
  /** What this member remembers about the mayor. */
  memberMemory: CouncilMemory;
  mayorName: string;
  history: CouncilChatRequest["history"];
}

export interface GazetteInput {
  spec: CitySpec;
  telemetry: CityTelemetry;
  event: string;
}

export interface CityReflectionResult {
  reflection: CityReflection;
  source: "claude" | "fallback";
}

export interface CityAiService {
  readonly enabled: boolean;
  readonly models: Models;
  /** Never throws: falls back to generateFallbackCity. */
  designCity(input: CitySpecInput): Promise<CitySpecResponse>;
  /** Never throws: falls back to localFate. Directives are already rule-checked. */
  fate(spec: CitySpec, telemetry: CityTelemetry, memory: CityMemory | null, signal?: AbortSignal): Promise<CityFateResponse>;
  /** Yields the member's reply. Throws on failure (callers send an `{error}` chunk). */
  councilReply(input: CouncilInput, signal?: AbortSignal): AsyncIterable<string>;
  /** Never throws: falls back to a heuristic. Values are not yet bounded (see applyCouncilUpdate). */
  councilUpdate(input: CouncilInput, reply: string): Promise<CouncilUpdate>;
  /** Yields one short article. Throws on failure. */
  gazette(input: GazetteInput, signal?: AbortSignal): AsyncIterable<string>;
  /** Never throws. */
  reflectCity(memory: CityMemory, report: CitySessionReport): Promise<CityReflectionResult>;
}
