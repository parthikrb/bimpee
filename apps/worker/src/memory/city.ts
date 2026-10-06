import { CityMemorySchema, emptyCityMemory, type CityMemory } from "@bimpee/shared/city";
import { z } from "zod";
import { log } from "../config";

/**
 * Per-user bookkeeping for the city game that is not part of the CityMemory
 * contract: which city ids were already reported (so citiesFounded counts each
 * city once), recent climates (to avoid repeats) and the landmark quota.
 * Stored as game_memory(game = "city_meta").
 */
export const CityMetaSchema = z.object({
  reportedCityIds: z.array(z.string().max(64)).max(500).catch([]),
  recentClimates: z.array(z.string().max(32)).max(5).catch([]),
  landmarkDay: z.string().max(10).catch(""),
  landmarkCount: z.number().int().min(0).catch(0),
});
export type CityMeta = z.infer<typeof CityMetaSchema>;

export const emptyCityMeta = (): CityMeta => ({ reportedCityIds: [], recentClimates: [], landmarkDay: "", landmarkCount: 0 });

export function parseCityMeta(raw: unknown): CityMeta {
  const p = CityMetaSchema.safeParse(raw ?? {});
  return p.success ? p.data : emptyCityMeta();
}

/** Keep at most this many council entries (members of past cities age out). */
export const MAX_COUNCIL_ENTRIES = 12;

export function parseCityMemory(raw: unknown, userId: string, mayorName: string | null): CityMemory {
  if (raw) {
    const p = CityMemorySchema.safeParse(raw);
    if (p.success) return { ...p.data, userId, mayorName: mayorName ?? p.data.mayorName };
    log.warn("[memory] stored city memory failed validation; starting fresh");
  }
  return emptyCityMemory(userId, mayorName ?? undefined);
}

/** Bounds a memory before it is stored (council map size). */
export function boundCityMemory(m: CityMemory): CityMemory {
  const entries = Object.entries(m.council);
  const council = entries.length > MAX_COUNCIL_ENTRIES ? Object.fromEntries(entries.slice(-MAX_COUNCIL_ENTRIES)) : m.council;
  return { ...m, council };
}

export function addReported(meta: CityMeta, cityId: string): { meta: CityMeta; first: boolean } {
  if (meta.reportedCityIds.includes(cityId)) return { meta, first: false };
  return { meta: { ...meta, reportedCityIds: [...meta.reportedCityIds, cityId].slice(-500) }, first: true };
}
