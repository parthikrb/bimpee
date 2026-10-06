import { z } from "zod";

/**
 * What the city game remembers about a player (the mayor) across cities, and
 * what each council member remembers about them. Stored per game in Supabase
 * (`game_memory`, game = "city").
 */
export const CouncilMemorySchema = z.object({
  approval: z.number().min(-1).max(1),
  /** short first-person notes the member keeps about the mayor ("promised me a park in Riverside") */
  notes: z.array(z.string().max(160)).max(8),
});
export type CouncilMemory = z.infer<typeof CouncilMemorySchema>;

export const CityMemorySchema = z.object({
  userId: z.string(),
  mayorName: z.string(),
  citiesFounded: z.number().int().min(0),
  bestPopulation: z.number().int().min(0),
  disastersSurvived: z.number().int().min(0),
  traits: z.array(z.string().max(60)).max(10).describe("observed play style, e.g. 'green energy purist', 'builds dense downtowns'"),
  recentCities: z
    .array(z.object({ name: z.string(), days: z.number().int(), population: z.number().int(), summary: z.string().max(240), at: z.string() }))
    .max(5),
  /** keyed by council member id of the current city */
  council: z.record(z.string(), CouncilMemorySchema),
});
export type CityMemory = z.infer<typeof CityMemorySchema>;

export const emptyCityMemory = (userId: string, mayorName = "Mayor"): CityMemory => ({
  userId,
  mayorName,
  citiesFounded: 0,
  bestPopulation: 0,
  disastersSurvived: 0,
  traits: [],
  recentCities: [],
  council: {},
});

export function cityMemoryDigest(m: CityMemory): string {
  if (m.citiesFounded === 0) return `Mayor "${m.mayorName}" is founding their first city. Make it welcoming and forgiving.`;
  const lines = [`Mayor "${m.mayorName}": ${m.citiesFounded} cities founded, best population ${m.bestPopulation}, ${m.disastersSurvived} disasters survived.`];
  if (m.traits.length) lines.push(`Play style: ${m.traits.join(", ")}.`);
  for (const c of m.recentCities.slice(0, 3)) lines.push(`- ${c.name} (day ${c.days}, pop ${c.population}): ${c.summary}`);
  return lines.join("\n");
}
