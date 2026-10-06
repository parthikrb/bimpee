import { z } from "zod";
import { DISASTERS } from "./spec";

/**
 * Buildings, player commands, telemetry and Fate (director) tools for the
 * city sandbox. The simulation in apps/web/src/city/sim applies all of these.
 */

/** Things the player places directly. Zoned buildings grow by themselves. */
export const BUILD_KINDS = [
  "road",
  "power_coal",
  "power_wind",
  "power_solar",
  "water_tower",
  "water_pump",
  "fire_station",
  "police",
  "clinic",
  "school",
  "park",
] as const;
export type BuildKind = (typeof BUILD_KINDS)[number];

export const ZONES = ["residential", "commercial", "industrial"] as const;
export type Zone = (typeof ZONES)[number];

/** Static catalogue: cost, upkeep, footprint, service radius, capacity. Single source of truth for sim + UI. */
export const BUILD_CATALOG: Record<BuildKind, { name: string; cost: number; upkeep: number; size: number; radius?: number; power?: number; water?: number; pollution?: number }> = {
  road: { name: "Road", cost: 10, upkeep: 0.1, size: 1 },
  power_coal: { name: "Coal plant", cost: 4000, upkeep: 40, size: 2, power: 400, pollution: 1 },
  power_wind: { name: "Wind turbine", cost: 1200, upkeep: 8, size: 1, power: 60 },
  power_solar: { name: "Solar farm", cost: 2500, upkeep: 10, size: 2, power: 120 },
  water_tower: { name: "Water tower", cost: 800, upkeep: 6, size: 1, water: 120 },
  water_pump: { name: "Water pump", cost: 1800, upkeep: 14, size: 1, water: 300 },
  fire_station: { name: "Fire station", cost: 1500, upkeep: 20, size: 1, radius: 12 },
  police: { name: "Police", cost: 1500, upkeep: 20, size: 1, radius: 12 },
  clinic: { name: "Clinic", cost: 2000, upkeep: 25, size: 1, radius: 10 },
  school: { name: "School", cost: 2200, upkeep: 25, size: 1, radius: 10 },
  park: { name: "Park", cost: 300, upkeep: 2, size: 1, radius: 5 },
};

export const CityCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("build"), kind: z.enum(BUILD_KINDS), x: z.number().int(), y: z.number().int(), rot: z.number().int().min(0).max(3) }),
  /** a road polyline through tile centers; the sim fills straight segments between points */
  z.object({ type: z.literal("road"), path: z.array(z.tuple([z.number().int(), z.number().int()])).min(2).max(256) }),
  z.object({ type: z.literal("zone"), zone: z.enum(ZONES).nullable(), x0: z.number().int(), y0: z.number().int(), x1: z.number().int(), y1: z.number().int() }),
  z.object({ type: z.literal("bulldoze"), x0: z.number().int(), y0: z.number().int(), x1: z.number().int(), y1: z.number().int() }),
  z.object({ type: z.literal("landmark"), id: z.string(), x: z.number().int(), y: z.number().int() }),
  z.object({ type: z.literal("tax"), rate: z.number().min(0).max(0.2) }),
  z.object({ type: z.literal("speed"), speed: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(4)]) }),
  /** decision on a council motion */
  z.object({ type: z.literal("motion_vote"), motionId: z.string(), option: z.number().int().min(0).max(2) }),
  /** sandbox: the player summons a disaster themselves */
  z.object({ type: z.literal("sandbox_disaster"), kind: z.enum(DISASTERS), x: z.number().int(), y: z.number().int(), strength: z.number().min(0).max(1) }),
]);
export type CityCommand = z.infer<typeof CityCommandSchema>;

export const CityTelemetrySchema = z.object({
  cityId: z.string(),
  day: z.number().int().min(0),
  hour: z.number().min(0).max(24),
  population: z.number().int().min(0),
  funds: z.number().int(),
  incomePerDay: z.number().int(),
  expensesPerDay: z.number().int(),
  taxRate: z.number().min(0).max(0.2),
  happiness: z.number().min(0).max(1),
  demand: z.object({ residential: z.number().min(-1).max(1), commercial: z.number().min(-1).max(1), industrial: z.number().min(-1).max(1) }),
  power: z.object({ supply: z.number().min(0), demand: z.number().min(0), greenShare: z.number().min(0).max(1) }),
  water: z.object({ supply: z.number().min(0), demand: z.number().min(0) }),
  trafficCongestion: z.number().min(0).max(1),
  unemployment: z.number().min(0).max(1),
  pollution: z.number().min(0).max(1),
  buildings: z.record(z.string(), z.number().int().min(0)).describe("counts by kind/zone"),
  damagedBuildings: z.number().int().min(0),
  activeDisasters: z.array(z.string()).max(6),
  recentPlayerActions: z.array(z.string()).max(10).describe("short summaries, e.g. 'zoned 12 industrial tiles near the river'"),
  recentEvents: z.array(z.string()).max(10),
  recentDirectives: z.array(z.string()).max(8),
  councilApproval: z.record(z.string(), z.number().min(-1).max(1)).describe("member id -> approval of the mayor"),
  openMotions: z.number().int().min(0),
  goals: z.array(z.object({ description: z.string(), progress: z.number().min(0).max(1), daysLeft: z.number().int() })).max(3),
});
export type CityTelemetry = z.infer<typeof CityTelemetrySchema>;

export const ECONOMIC_EVENTS = ["boom", "recession", "tourism_wave", "strike", "federal_grant", "tech_startup_rush"] as const;
export const WEATHER_KINDS = ["clear", "rain", "storm", "snow", "heatwave", "fog"] as const;

export const MotionOptionSchema = z.object({
  label: z.string().describe("<= 40 chars"),
  effect: z.object({
    funds: z.number().int().min(-50_000).max(50_000),
    happiness: z.number().min(-0.3).max(0.3),
    approval: z.number().min(-0.5).max(0.5).describe("change in the proposer's approval of the mayor"),
    demand: z.enum(["none", "residential", "commercial", "industrial"]).describe("zone demand boosted by this option"),
  }),
});

/** Fate's tools (one Claude tool per variant; `tool` is the tool name). */
export const CityDirectiveSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("trigger_disaster"), kind: z.enum(DISASTERS), x: z.number().int(), y: z.number().int(), strength: z.number().min(0).max(1), headline: z.string() }),
  z.object({ tool: z.literal("economic_event"), kind: z.enum(ECONOMIC_EVENTS), strength: z.number().min(0).max(1), days: z.number().int().min(1).max(30), headline: z.string() }),
  z.object({ tool: z.literal("set_weather"), kind: z.enum(WEATHER_KINDS), days: z.number().int().min(1).max(10) }),
  z.object({
    tool: z.literal("council_motion"),
    memberId: z.string(),
    title: z.string().describe("<= 60 chars"),
    pitch: z.string().describe("in the member's voice, <= 240 chars"),
    options: z.array(MotionOptionSchema).min(2).max(3),
  }),
  z.object({ tool: z.literal("adjust_demand"), residential: z.number().min(0.5).max(2), commercial: z.number().min(0.5).max(2), industrial: z.number().min(0.5).max(2), days: z.number().int().min(1).max(30) }),
  z.object({ tool: z.literal("visitor"), kind: z.enum(["investor", "celebrity", "inspector", "tourists", "refugees"]), headline: z.string() }),
  z.object({ tool: z.literal("news"), headline: z.string().describe("<= 80 chars"), body: z.string().describe("<= 280 chars, in the gazette's voice") }),
]);
export type CityDirective = z.infer<typeof CityDirectiveSchema>;
export type CityDirectiveTool = CityDirective["tool"];

export function parseCityDirectives(raw: unknown[]): CityDirective[] {
  const out: CityDirective[] = [];
  for (const r of raw) {
    const p = CityDirectiveSchema.safeParse(r);
    if (p.success) out.push(p.data);
  }
  return out;
}
