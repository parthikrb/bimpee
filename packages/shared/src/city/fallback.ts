import { createRng } from "../rng";
import type { CityDirective, CityTelemetry } from "./game";
import { CITY_SPEC_LIMITS } from "./limits";
import { CitySpecSchema, CLIMATES, DISASTERS, GAZETTE_VOICES, TERRAINS, type CitySpec } from "./spec";

/** Deterministic offline city: used without a key, on timeouts, and as the repair target. */
export function generateFallbackCity(seed: number): CitySpec {
  const rng = createRng(seed);
  const climate = rng.pick(CLIMATES);
  const palettes: Record<(typeof CLIMATES)[number], CitySpec["palette"]> = {
    temperate: { ground: "#6fa35a", water: "#3a8fd1", skyDay: "#9fd3ff", skyNight: "#0b1a3a", accent: "#ffcc4d", roofs: ["#d9534f", "#5b8def", "#f0ad4e", "#7a6cf0"] },
    tropical: { ground: "#4fb36b", water: "#18c3c9", skyDay: "#8be3ff", skyNight: "#071b33", accent: "#ff7a59", roofs: ["#ff6b6b", "#ffd166", "#06d6a0", "#118ab2"] },
    arid: { ground: "#d8b878", water: "#2fa3b5", skyDay: "#ffd9a0", skyNight: "#1b1030", accent: "#ff9f1c", roofs: ["#c8553d", "#f28f3b", "#ffd5c2", "#588b8b"] },
    arctic: { ground: "#e8f1f7", water: "#4a7fa8", skyDay: "#cfe8ff", skyNight: "#06122a", accent: "#7fdbff", roofs: ["#c0392b", "#2c3e50", "#16a085", "#8e44ad"] },
    volcanic: { ground: "#5a4d4a", water: "#2b6c8f", skyDay: "#f0a875", skyNight: "#1a0606", accent: "#ff5e3a", roofs: ["#2d2d2d", "#8c2f39", "#b23a48", "#fcb9b2"] },
  };
  const names = ["Port Ember", "New Hollow", "Lumen Bay", "Ashford", "Cobalt Reach", "Greywater", "Solace", "Kestrel Point"];
  return {
    version: 1,
    seed,
    name: rng.pick(names),
    tagline: "A city drafted while the AI planners were offline.",
    terrain: { kind: rng.pick(TERRAINS), size: 64, waterLevel: rng.range(0.25, 0.45), roughness: rng.range(0.2, 0.6), forest: rng.range(0.2, 0.6) },
    climate: { kind: climate, season: "spring", startHour: 8, dayLengthSec: 180 },
    palette: palettes[climate],
    economy: { startingFunds: 50_000, taxRate: 0.09, difficulty: 0.4 },
    council: [
      { id: "vera", name: "Vera Quill", role: "environmentalist", personality: "Warm, idealistic, quotes poetry, furious about smog.", agenda: "Parks, clean power and a skyline you can see stars over." },
      { id: "brannock", name: "Otto Brannock", role: "industrialist", personality: "Gruff, numbers-first, secretly sentimental about his first factory.", agenda: "Cheap power, industrial zones and low taxes." },
      { id: "lin", name: "Dr. Mei Lin", role: "scientist", personality: "Dry wit, evidence or nothing, loves a good experiment.", agenda: "Schools, research and disaster preparedness." },
    ],
    landmarks: [
      {
        id: "beacon",
        name: "The Beacon",
        description: "A lighthouse-tower whose lamp burns for every new citizen.",
        modelPrompt: "stylized low-poly lighthouse tower with a glowing lantern top, white and red stripes",
        fallback: "tower",
        footprint: 1,
        effect: "tourism",
        cost: 15_000,
      },
    ],
    disasters: { allowed: [...DISASTERS], frequency: 0.35 },
    goals: [
      { description: "Grow to 2,000 citizens", metric: "population", target: 2000, byDay: 30 },
      { description: "Keep happiness above 60%", metric: "happiness", target: 0.6, byDay: 40 },
    ],
    gazette: { name: "The Daily Bimpee", voice: rng.pick(GAZETTE_VOICES) },
    designNotes: "Offline fallback city, generated deterministically from the seed.",
  };
}

/** Accepts a spec if valid after light repair (unique ids, clamped numbers); otherwise null. */
export function sanitizeCitySpec(input: unknown): CitySpec | null {
  const first = CitySpecSchema.safeParse(input);
  let spec: CitySpec | null = first.success ? first.data : null;
  if (!spec && input && typeof input === "object") {
    try {
      const raw = JSON.parse(JSON.stringify(input)) as Record<string, any>;
      raw.version = 1;
      for (const [path, lo, hi] of CITY_SPEC_LIMITS) {
        let o: any = raw;
        for (const k of path.slice(0, -1)) o = o?.[k];
        const last = path[path.length - 1]!;
        if (o && typeof o[last] === "number") o[last] = Math.min(hi, Math.max(lo, o[last]));
      }
      if (raw.terrain && ![48, 64, 80].includes(raw.terrain.size)) raw.terrain.size = 64;
      if (Array.isArray(raw.landmarks)) raw.landmarks = raw.landmarks.slice(0, 3);
      const second = CitySpecSchema.safeParse(raw);
      spec = second.success ? second.data : null;
    } catch {
      spec = null;
    }
  }
  if (!spec) return null;
  const ids = new Set<string>();
  const uniq = (id: string, i: number, prefix: string) => {
    let v = id.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32) || `${prefix}_${i}`;
    while (ids.has(v)) v = `${v}_${i}`;
    ids.add(v);
    return v;
  };
  return {
    ...spec,
    council: spec.council.map((c, i) => ({ ...c, id: uniq(c.id, i, "member") })),
    landmarks: spec.landmarks.map((l, i) => ({ ...l, id: uniq(l.id, i, "landmark") })),
    disasters: { ...spec.disasters, allowed: [...new Set(spec.disasters.allowed)] },
  };
}

/** Rule-based Fate used offline and as the fallback for a failed model call. */
export function localFate(spec: CitySpec, t: CityTelemetry): { directives: CityDirective[]; reasoning: string } {
  const d: CityDirective[] = [];
  const why: string[] = [];
  const recent = new Set(t.recentDirectives);
  if (t.funds < 0 && !recent.has("economic_event")) {
    d.push({ tool: "economic_event", kind: "federal_grant", strength: 0.5, days: 1, headline: "Emergency grant keeps the lights on" });
    why.push("city is broke: emergency grant");
  }
  if (t.power.demand > t.power.supply * 1.1 && !recent.has("news")) {
    d.push({ tool: "news", headline: "Brownouts across town", body: "Residents report flickering lights as demand outstrips the grid." });
    why.push("power shortage: warn via news");
  }
  const calm = t.activeDisasters.length === 0 && t.day >= 5 && t.population > 300;
  if (calm && spec.disasters.frequency > 0 && t.day % Math.max(3, Math.round(12 - spec.disasters.frequency * 9)) === 0 && !recent.has("trigger_disaster")) {
    const kind = spec.disasters.allowed[t.day % spec.disasters.allowed.length]!;
    const c = Math.floor(spec.terrain.size / 2);
    d.push({ tool: "trigger_disaster", kind, x: c, y: c, strength: 0.4, headline: `${kind[0]!.toUpperCase()}${kind.slice(1)} strikes!` });
    why.push(`quiet stretch: ${kind}`);
  }
  if (!d.length) why.push("city is steady: let it breathe");
  return { directives: d.slice(0, 3), reasoning: why.join("; ") };
}
