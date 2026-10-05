import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { DirectiveSchema, type Directive, type DirectiveTool, type Telemetry, type WorldSpec } from "@bimpee/shared";
import { toApiSchema } from "./schema";
import { truncate } from "./untrusted";

export const MAX_DIRECTIVES_PER_TICK = 4;

/** What each director tool does in the game. Shown to Claude as the tool description. */
export const TOOL_DESCRIPTIONS: Record<DirectiveTool, string> = {
  set_intensity_target:
    "Move the pacing controller's target stress level (0 calm .. 1 overwhelming) over rampSec seconds. The spawner follows this target; use it to shape build-up, peaks and breathers.",
  adjust_spawns:
    "Scale the enemy spawn rate (1 = unchanged) and optionally re-weight which enemy archetypes spawn, by archetype id from the world spec. Pass an empty weights list to keep the current mix.",
  inject_event:
    "Trigger a one-off set piece immediately (elite pack, ambush, treasure room, healing shrine, meteor shower, blackout, swarm tide, mirror rival) with a strength 0..1 and a short on-screen banner (<= 60 chars). Big moment: at most one per tick.",
  spawn_boss:
    "Summon the world's boss now with an arrival banner. Only valid in the final act (act index 2) and only when no boss is active. Happens once per run.",
  shift_biome:
    "Change the atmosphere: weather, fog density 0..1 and a color the scene is tinted towards (#rrggbb), with a banner. Use for mood shifts between acts or to mark a turning point.",
  mutate_enemies:
    "Give one existing enemy archetype (by id from the world spec) an extra modifier and a speed multiplier, so a familiar foe suddenly behaves differently.",
  grant_boon:
    "Give the player(s) a boon right now (heal, shield, weapon upgrade, time slow, loot magnet) with a banner. Use when they are struggling or deserve a reward for a great moment.",
  narrate:
    "Have the narrator speak one line (<= 140 chars) in the world's narrator persona, with a mood. Use sparingly: at most once per tick, only when something is worth commenting on.",
  set_music:
    "Set the adaptive soundtrack's energy and tension (each 0..1) to match the moment.",
};

/** One Claude tool per Directive variant: name = the `tool` literal, input = the rest. Deterministic order (cache-friendly). */
export function buildDirectorTools(): Anthropic.Beta.BetaTool[] {
  return DirectiveSchema.options.map((variant) => {
    const name = variant.shape.tool.value;
    return {
      name,
      description: TOOL_DESCRIPTIONS[name],
      input_schema: toApiSchema((variant as unknown as z.ZodObject<{ tool: z.ZodType }>).omit({ tool: true })) as Anthropic.Beta.BetaTool.InputSchema,
      strict: true,
    };
  });
}

const BANNER = 60;

/**
 * Enforces game rules on directives regardless of who produced them:
 * cap per tick, ≤1 narrate, no boss outside act 2 or while one is active,
 * archetype ids must exist, banners/lines truncated.
 */
export function postProcessDirectives(world: WorldSpec, t: Telemetry, input: Directive[]): Directive[] {
  const ids = new Set(world.enemies.map((e) => e.id));
  const out: Directive[] = [];
  let narrated = false;
  let bossed = false;
  let evented = false;
  for (const d of input) {
    if (out.length >= MAX_DIRECTIVES_PER_TICK) break;
    switch (d.tool) {
      case "spawn_boss":
        if (bossed || t.bossActive || t.act !== 2) continue;
        bossed = true;
        out.push({ ...d, announce: truncate(d.announce, BANNER) });
        break;
      case "narrate":
        if (narrated) continue;
        narrated = true;
        out.push({ ...d, line: truncate(d.line, 140) });
        break;
      case "inject_event":
        if (evented) continue;
        evented = true;
        out.push({ ...d, announce: truncate(d.announce, BANNER) });
        break;
      case "mutate_enemies":
        if (!ids.has(d.archetypeId)) continue;
        out.push(d);
        break;
      case "adjust_spawns":
        out.push({ ...d, weights: d.weights.filter((w) => ids.has(w.id)) });
        break;
      case "shift_biome":
      case "grant_boon":
        out.push({ ...d, announce: truncate(d.announce, BANNER) });
        break;
      default:
        out.push(d);
    }
  }
  return out;
}
