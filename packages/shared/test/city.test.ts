import { describe, expect, it } from "vitest";
import {
  CityCommandSchema,
  CitySpecSchema,
  cityMemoryDigest,
  emptyCityMemory,
  generateFallbackCity,
  localFate,
  parseCityDirectives,
  sanitizeCitySpec,
  type CityTelemetry,
} from "../src/city";

const telemetry = (over: Partial<CityTelemetry> = {}): CityTelemetry => ({
  cityId: "c", day: 6, hour: 12, population: 800, funds: 10_000, incomePerDay: 900, expensesPerDay: 700, taxRate: 0.09, happiness: 0.6,
  demand: { residential: 0.3, commercial: 0.1, industrial: 0.2 }, power: { supply: 400, demand: 300, greenShare: 0.2 }, water: { supply: 300, demand: 200 },
  trafficCongestion: 0.2, unemployment: 0.05, pollution: 0.2, buildings: { residential: 40 }, damagedBuildings: 0, activeDisasters: [],
  recentPlayerActions: [], recentEvents: [], recentDirectives: [], councilApproval: { vera: 0.1 }, openMotions: 0, goals: [],
  ...over,
});

describe("city spec", () => {
  it("fallback cities are valid and deterministic", () => {
    for (let s = 0; s < 100; s++) expect(CitySpecSchema.safeParse(generateFallbackCity(s * 7919)).success).toBe(true);
    expect(generateFallbackCity(9)).toEqual(generateFallbackCity(9));
  });
  it("repairs out-of-range numbers and duplicate ids", () => {
    const raw: any = structuredClone(generateFallbackCity(3));
    raw.economy.taxRate = 0.9;
    raw.terrain.size = 100;
    raw.council[1].id = raw.council[0].id;
    const fixed = sanitizeCitySpec(raw)!;
    expect(fixed.economy.taxRate).toBe(0.2);
    expect(fixed.terrain.size).toBe(64);
    expect(new Set(fixed.council.map((c) => c.id)).size).toBe(3);
  });
  it("rejects garbage", () => expect(sanitizeCitySpec({ nope: 1 })).toBeNull());
});

describe("city commands and directives", () => {
  it("validates commands", () => {
    expect(CityCommandSchema.safeParse({ type: "road", path: [[1, 1], [5, 1]] }).success).toBe(true);
    expect(CityCommandSchema.safeParse({ type: "build", kind: "nuke", x: 1, y: 1, rot: 0 }).success).toBe(false);
  });
  it("drops invalid directives", () => {
    const ok = parseCityDirectives([{ tool: "news", headline: "h", body: "b" }, { tool: "set_weather", kind: "acid", days: 2 }]);
    expect(ok).toHaveLength(1);
  });
});

describe("localFate", () => {
  it("bails out a broke city", () => {
    const r = localFate(generateFallbackCity(1), telemetry({ funds: -500 }));
    expect(r.directives.some((d) => d.tool === "economic_event")).toBe(true);
  });
  it("only returns valid directives", () => {
    for (let day = 0; day < 40; day++) {
      const r = localFate(generateFallbackCity(day), telemetry({ day }));
      expect(parseCityDirectives(r.directives)).toHaveLength(r.directives.length);
    }
  });
});

describe("city memory", () => {
  it("digests new mayors", () => expect(cityMemoryDigest(emptyCityMemory("u", "Ana"))).toMatch(/first city/));
});
