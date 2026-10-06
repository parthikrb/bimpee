import { DISASTERS, type CityMemory, type CitySessionReport, type CouncilMemory } from "@bimpee/shared/city";
import type { CityReflection, CouncilUpdate } from "../ai/cityTypes";
import { cleanText } from "../ai/untrusted";

export const MAX_APPROVAL_CHANGE = 0.2;
export const MAX_COUNCIL_NOTES = 8;
export const MAX_NEW_NOTES = 2;

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0);

export const emptyCouncilMemory = (): CouncilMemory => ({ approval: 0, notes: [] });

/** Applies a (possibly model-written) update with hard bounds: ±0.2 per conversation, ≤ 2 new notes, last 8 kept. */
export function applyCouncilUpdate(prev: CouncilMemory, update: CouncilUpdate): CouncilMemory {
  const delta = clamp(update.approvalDelta, -MAX_APPROVAL_CHANGE, MAX_APPROVAL_CHANGE);
  const approval = Math.round(clamp(prev.approval + delta, -1, 1) * 1000) / 1000;
  const fresh = update.notes
    .slice(0, MAX_NEW_NOTES)
    .map((n) => cleanText(n, 160))
    .filter(Boolean);
  return { approval, notes: [...prev.notes, ...fresh].slice(-MAX_COUNCIL_NOTES) };
}

/** Counts highlights that mention a disaster (each highlight at most once). */
export function disastersInHighlights(highlights: string[]): number {
  const re = new RegExp(`\\b(${DISASTERS.join("|")}|earthquakes|tornadoes|floods|meteors|fires|blackouts)\\b`, "i");
  return Math.min(20, highlights.filter((h) => re.test(h)).length);
}

/** Heuristic reflection used offline and when the model call fails. */
export function heuristicCityReflection(memory: CityMemory, r: CitySessionReport): CityReflection {
  const t = r.telemetry;
  const name = cleanText(r.cityName, 60) || "your city";
  const mood = t.happiness >= 0.7 ? "content" : t.happiness >= 0.45 ? "restless" : "furious";
  const money = t.funds < 0 ? "deep in the red" : t.funds > 50_000 ? "flush with cash" : "scraping by";
  const summary = `You led ${name} to ${t.population.toLocaleString("en-US")} citizens by day ${t.day}; they ended ${mood} and the treasury ${money}.`.slice(0, 240);
  const observed: string[] = [];
  if (t.power.greenShare >= 0.6) observed.push("green energy advocate");
  if (t.pollution >= 0.6) observed.push("tolerates smog for growth");
  if (t.taxRate >= 0.14) observed.push("high-tax planner");
  if (t.taxRate <= 0.05) observed.push("low-tax populist");
  if (t.trafficCongestion >= 0.6) observed.push("lives with traffic jams");
  if (t.happiness >= 0.75) observed.push("keeps citizens happy");
  if (t.funds < 0) observed.push("deficit spender");
  if (t.population >= 5000) observed.push("builds big");
  return { summary, traits: mergeTraits(memory.traits, observed) };
}

export function mergeTraits(old: string[], fresh: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...fresh, ...old]) {
    const t = cleanText(raw, 60);
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.slice(0, 10);
}

/**
 * Merges a session into the mayor's memory. `firstReport` is true only the
 * first time this cityId is reported (citiesFounded counts each city once).
 */
export function mergeCitySession(
  memory: CityMemory,
  r: CitySessionReport,
  reflection: CityReflection,
  firstReport: boolean,
  now = new Date(),
): CityMemory {
  const t = r.telemetry;
  const name = cleanText(r.cityName, 60) || "Unnamed city";
  const entry = { name, days: t.day, population: t.population, summary: cleanText(reflection.summary, 240), at: now.toISOString() };
  // A city reported again replaces its own entry instead of pushing others out.
  const others = firstReport ? memory.recentCities : memory.recentCities.filter((c) => c.name !== name);
  return {
    ...memory,
    citiesFounded: memory.citiesFounded + (firstReport ? 1 : 0),
    bestPopulation: Math.max(memory.bestPopulation, Math.min(t.population, 2_147_483_647)),
    disastersSurvived: Math.min(memory.disastersSurvived + disastersInHighlights(r.highlights), 2_147_483_647),
    traits: mergeTraits([], reflection.traits),
    recentCities: [entry, ...others].slice(0, 5),
  };
}
