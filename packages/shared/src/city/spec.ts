import { z } from "zod";
import { hexColor } from "../world";

/**
 * City Spec: what Claude writes before a new city is founded. The engine turns
 * it into terrain (seeded), climate, palette, starting economy, a council of
 * agent personas, the disasters Fate may use, scenario goals and up to three
 * signature landmarks (AI-generated 3D models with a CC0 fallback).
 */

export const TERRAINS = ["island", "river_valley", "coastal", "plateau", "archipelago", "canyon"] as const;
export const CLIMATES = ["temperate", "tropical", "arid", "arctic", "volcanic"] as const;
export const SEASONS = ["spring", "summer", "autumn", "winter"] as const;
export const DISASTERS = ["earthquake", "tornado", "flood", "meteor", "fire", "blackout"] as const;
export const COUNCIL_ROLES = ["rival_mayor", "environmentalist", "industrialist", "populist", "scientist", "historian"] as const;
export const LANDMARK_EFFECTS = ["tourism", "happiness", "power", "water", "research", "safety"] as const;
export const GOAL_METRICS = ["population", "happiness", "funds", "green_power_share", "traffic_flow", "disasters_survived"] as const;
export const GAZETTE_VOICES = ["tabloid", "broadsheet", "deadpan", "hype", "noir"] as const;

export const CouncilMemberSchema = z.object({
  id: z.string().describe("short snake_case id, unique"),
  name: z.string(),
  role: z.enum(COUNCIL_ROLES),
  personality: z.string().describe("how they talk and what moves them, <= 200 chars"),
  agenda: z.string().describe("what they want for the city, <= 160 chars"),
});
export type CouncilMember = z.infer<typeof CouncilMemberSchema>;

export const LandmarkSchema = z.object({
  id: z.string().describe("short snake_case id, unique"),
  name: z.string(),
  description: z.string().describe("one evocative sentence, <= 160 chars"),
  modelPrompt: z
    .string()
    .describe("prompt for a text-to-3D generator: one stylised low-poly object, no ground plane, <= 300 chars"),
  fallback: z
    .enum(["tower", "monument", "dome", "spire", "arch", "statue", "observatory", "ferris_wheel"])
    .describe("shape used when no generated model is available"),
  footprint: z.number().int().min(1).max(3).describe("square footprint in tiles"),
  effect: z.enum(LANDMARK_EFFECTS),
  cost: z.number().int().min(1000).max(200_000),
});
export type Landmark = z.infer<typeof LandmarkSchema>;

export const GoalSchema = z.object({
  description: z.string(),
  metric: z.enum(GOAL_METRICS),
  target: z.number().min(0),
  byDay: z.number().int().min(5).max(400),
});
export type Goal = z.infer<typeof GoalSchema>;

export const CitySpecSchema = z.object({
  version: z.literal(1),
  seed: z.number().int().min(0).max(2_147_483_647),
  name: z.string().describe("city name, 1-3 words"),
  tagline: z.string().describe("<= 100 chars"),
  terrain: z.object({
    kind: z.enum(TERRAINS),
    size: z.union([z.literal(48), z.literal(64), z.literal(80)]).describe("map is size x size tiles"),
    waterLevel: z.number().min(0).max(1),
    roughness: z.number().min(0).max(1),
    forest: z.number().min(0).max(1),
  }),
  climate: z.object({
    kind: z.enum(CLIMATES),
    season: z.enum(SEASONS),
    startHour: z.number().min(0).max(24),
    dayLengthSec: z.number().min(60).max(900).describe("real seconds per in-game day at 1x speed"),
  }),
  palette: z.object({
    ground: hexColor,
    water: hexColor,
    skyDay: hexColor,
    skyNight: hexColor,
    accent: hexColor.describe("UI and highlight color"),
    roofs: z.array(hexColor).min(2).max(5).describe("building tint variety"),
  }),
  economy: z.object({
    startingFunds: z.number().int().min(5_000).max(200_000),
    taxRate: z.number().min(0).max(0.2),
    difficulty: z.number().min(0).max(1),
  }),
  council: z.array(CouncilMemberSchema).length(3),
  landmarks: z.array(LandmarkSchema).max(3),
  disasters: z.object({
    allowed: z.array(z.enum(DISASTERS)).min(1),
    frequency: z.number().min(0).max(1),
  }),
  goals: z.array(GoalSchema).min(1).max(3),
  gazette: z.object({ name: z.string(), voice: z.enum(GAZETTE_VOICES) }),
  designNotes: z.string().describe("why this city fits this player, <= 400 chars"),
});
export type CitySpec = z.infer<typeof CitySpecSchema>;
export type Disaster = (typeof DISASTERS)[number];
