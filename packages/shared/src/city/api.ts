import { z } from "zod";
import { CityDirectiveSchema, CityTelemetrySchema } from "./game";
import { CouncilMemorySchema } from "./memory";
import { CitySpecSchema } from "./spec";

/**
 * City routes (same auth/headers as the roguelite API in ../api.ts):
 *
 *   POST /api/city/spec      CitySpecRequest     -> CitySpecResponse
 *   POST /api/city/fate      CityFateRequest     -> CityFateResponse        (the director tick, ~once per in-game day)
 *   POST /api/city/council   CouncilChatRequest  -> text/event-stream of NarrateChunk, then a final
 *                                                   `data: {"memory": CouncilMemory}` event before {done:true}
 *   POST /api/city/gazette   GazetteRequest      -> text/event-stream of NarrateChunk (one short article)
 *   GET  /api/city/memory                        -> CityMemory
 *   POST /api/city/session   CitySessionReport   -> { summary: string }     (reflection merged into CityMemory)
 *   GET  /api/city/saves                         -> { saves: CitySaveMeta[] }
 *   PUT  /api/city/saves/:id CitySaveBody        -> CitySaveMeta            (<= 1.4 MB, base64 sim state)
 *   GET  /api/city/saves/:id                     -> CitySaveBody
 *   POST /api/city/landmark  LandmarkModelRequest -> LandmarkModelResponse  (text-to-3D; cached by prompt hash)
 *   GET  /api/city/models/:hash                  -> model/gltf-binary       (cached generated model)
 */

export const CitySpecRequestSchema = z.object({
  wish: z.string().max(200).optional(),
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
});
export type CitySpecRequest = z.infer<typeof CitySpecRequestSchema>;

export const CitySpecResponseSchema = z.object({
  spec: CitySpecSchema,
  source: z.enum(["claude", "fallback"]),
  model: z.string(),
  latencyMs: z.number(),
});
export type CitySpecResponse = z.infer<typeof CitySpecResponseSchema>;

export const CityFateRequestSchema = z.object({ spec: CitySpecSchema, telemetry: CityTelemetrySchema });
export type CityFateRequest = z.infer<typeof CityFateRequestSchema>;

export const CityFateResponseSchema = z.object({
  directives: z.array(CityDirectiveSchema),
  reasoning: z.string(),
  model: z.string(),
  latencyMs: z.number(),
});
export type CityFateResponse = z.infer<typeof CityFateResponseSchema>;

export const CouncilChatRequestSchema = z.object({
  spec: CitySpecSchema,
  telemetry: CityTelemetrySchema,
  memberId: z.string(),
  /** the conversation so far with this member, oldest first; the last entry is the mayor's new message */
  history: z
    .array(z.object({ from: z.enum(["mayor", "member"]), text: z.string().max(600) }))
    .min(1)
    .max(20),
});
export type CouncilChatRequest = z.infer<typeof CouncilChatRequestSchema>;
export type CouncilChunk = { text: string } | { memory: z.infer<typeof CouncilMemorySchema> } | { done: true } | { error: string };

export const GazetteRequestSchema = z.object({
  spec: CitySpecSchema,
  telemetry: CityTelemetrySchema,
  event: z.string().max(300).describe("what happened"),
});
export type GazetteRequest = z.infer<typeof GazetteRequestSchema>;

export const CitySessionReportSchema = z.object({
  cityId: z.string().max(64),
  cityName: z.string().max(60),
  telemetry: CityTelemetrySchema,
  highlights: z.array(z.string().max(160)).max(20),
});
export type CitySessionReport = z.infer<typeof CitySessionReportSchema>;

export const CitySaveMetaSchema = z.object({
  id: z.string().max(64),
  cityName: z.string().max(60),
  day: z.number().int(),
  population: z.number().int(),
  updatedAt: z.string(),
});
export type CitySaveMeta = z.infer<typeof CitySaveMetaSchema>;

export const CitySaveBodySchema = z.object({
  spec: CitySpecSchema,
  /** CitySim.serialize() output, base64 */
  state: z.string().max(1_400_000),
  day: z.number().int(),
  population: z.number().int(),
});
export type CitySaveBody = z.infer<typeof CitySaveBodySchema>;

export const LandmarkModelRequestSchema = z.object({ prompt: z.string().min(3).max(300) });
export const LandmarkModelResponseSchema = z.object({
  status: z.enum(["ready", "pending", "unavailable"]),
  /** same-origin URL of a .glb when ready */
  url: z.string().nullable(),
  /** poll again after this many ms when pending */
  retryMs: z.number().int().nullable(),
});
export type LandmarkModelResponse = z.infer<typeof LandmarkModelResponseSchema>;
