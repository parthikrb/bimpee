import { z } from "zod";
import { ENEMY_MODIFIERS, WEATHERS, hexColor } from "./world";

/**
 * Telemetry: what the in-browser game reports to the AI director every
 * tick (~15s). Keep it compact: it is sent to the model verbatim.
 */
export const TelemetrySchema = z.object({
  runId: z.string(),
  t: z.number().describe("seconds since run start"),
  act: z.number().int().min(0).max(2),
  intensity: z.number().min(0).max(1).describe("measured player stress, 0 calm .. 1 overwhelmed"),
  intensityTarget: z.number().min(0).max(1),
  phase: z.enum(["build", "peak", "relax"]),
  player: z.object({
    hpFraction: z.number().min(0).max(1),
    level: z.number().int().min(1),
    weapon: z.string(),
    accuracy: z.number().min(0).max(1),
    damageTaken: z.number().min(0).describe("hp fraction lost since last tick"),
    kills: z.number().int().min(0).describe("kills since last tick"),
    nearMisses: z.number().int().min(0).describe("enemy bullets that passed close since last tick"),
    idleRatio: z.number().min(0).max(1).describe("fraction of time not moving since last tick"),
    score: z.number().int().min(0),
  }),
  enemiesAlive: z.number().int().min(0),
  bossActive: z.boolean(),
  recentEvents: z.array(z.string()).max(12),
  recentDirectives: z.array(z.string()).max(8).describe("tool names the director used in the last ticks"),
  fps: z.number().min(0).max(240),
  players: z.number().int().min(1).describe("players sharing this world (multiplayer rooms)"),
});
export type Telemetry = z.infer<typeof TelemetrySchema>;

export const EVENT_KINDS = [
  "elite_pack",
  "ambush",
  "treasure_room",
  "healing_shrine",
  "meteor_shower",
  "blackout",
  "swarm_tide",
  "mirror_rival",
] as const;
export const BOON_KINDS = ["heal", "shield", "weapon_upgrade", "time_slow", "magnet"] as const;
export const NARRATION_MOODS = ["hype", "tease", "warn", "praise", "mourn", "mystery"] as const;

/**
 * Directives: the tools the director calls. Each one maps 1:1 to a Claude tool
 * (`name` = tool name, rest = tool input). The game applies them; it never
 * runs model-generated code.
 */
export const DirectiveSchema = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("set_intensity_target"),
    target: z.number().min(0).max(1),
    rampSec: z.number().min(1).max(30),
  }),
  z.object({
    tool: z.literal("adjust_spawns"),
    rateMultiplier: z.number().min(0.25).max(3),
    weights: z
      .array(z.object({ id: z.string(), weight: z.number().min(0).max(1) }))
      .max(6)
      .describe("optional per-archetype spawn weights"),
  }),
  z.object({
    tool: z.literal("inject_event"),
    kind: z.enum(EVENT_KINDS),
    strength: z.number().min(0).max(1),
    announce: z.string().describe("on-screen banner, <= 60 chars"),
  }),
  z.object({
    tool: z.literal("spawn_boss"),
    announce: z.string(),
  }),
  z.object({
    tool: z.literal("shift_biome"),
    weather: z.enum(WEATHERS),
    fog: z.number().min(0).max(1),
    tint: hexColor.describe("color the scene is washed towards"),
    announce: z.string(),
  }),
  z.object({
    tool: z.literal("mutate_enemies"),
    archetypeId: z.string(),
    addModifier: z.enum(ENEMY_MODIFIERS),
    speedMultiplier: z.number().min(0.5).max(2),
  }),
  z.object({
    tool: z.literal("grant_boon"),
    kind: z.enum(BOON_KINDS),
    announce: z.string(),
  }),
  z.object({
    tool: z.literal("narrate"),
    line: z.string().describe("<= 140 chars, in the narrator's persona"),
    mood: z.enum(NARRATION_MOODS),
  }),
  z.object({
    tool: z.literal("set_music"),
    energy: z.number().min(0).max(1),
    tension: z.number().min(0).max(1),
  }),
]);
export type Directive = z.infer<typeof DirectiveSchema>;
export type DirectiveTool = Directive["tool"];
export const DIRECTIVE_TOOLS = DirectiveSchema.options.map((o) => o.shape.tool.value) as DirectiveTool[];

export const DirectorResponseSchema = z.object({
  directives: z.array(DirectiveSchema),
  reasoning: z.string(),
  model: z.string().describe("model id, or 'local' for the offline rule-based director"),
  latencyMs: z.number(),
});
export type DirectorResponse = z.infer<typeof DirectorResponseSchema>;

/** Parses a list of untrusted directives, dropping invalid ones instead of failing the batch. */
export function parseDirectives(raw: unknown[]): Directive[] {
  const out: Directive[] = [];
  for (const r of raw) {
    const p = DirectiveSchema.safeParse(r);
    if (p.success) out.push(p.data);
  }
  return out;
}
