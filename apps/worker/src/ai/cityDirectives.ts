import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { CityDirectiveSchema, type CityDirective, type CityDirectiveTool, type CitySpec, type CityTelemetry } from "@bimpee/shared/city";
import { toApiSchema } from "./schema";
import { truncate } from "./untrusted";

export const MAX_FATE_DIRECTIVES = 3;
export const MAX_OPEN_MOTIONS = 2;
/** No disasters before this in-game day: let the city get on its feet. */
export const FIRST_DISASTER_DAY = 5;

/** What each Fate tool does in the city. Shown to Claude as the tool description. */
export const FATE_TOOL_DESCRIPTIONS: Record<CityDirectiveTool, string> = {
  trigger_disaster:
    "Unleash a disaster of an allowed kind at tile (x, y) with strength 0..1 and a short newspaper headline (<= 80 chars). The biggest lever you have: at most one per tick, never before day 5, never while a disaster is active, only kinds in the spec's disasters.allowed. Aim it where it tests the mayor's planning (e.g. a fire far from fire stations), not to wipe the city out.",
  economic_event:
    "Start an economic event (boom, recession, tourism wave, strike, federal grant, tech startup rush) with strength 0..1 lasting `days` days, announced with a headline (<= 80 chars). Use to reward good planning or to create pressure that has a clear remedy.",
  set_weather:
    "Set the weather for the next `days` days. Fits the climate; sets mood and foreshadows events (a storm before a flood, a heatwave before fires).",
  council_motion:
    "Have a council member (memberId from the spec's council) table a motion the mayor must vote on: a title (<= 60 chars), a pitch in that member's own voice (<= 240 chars) and 2-3 options (labels <= 40 chars) whose effects are real trade-offs (funds vs happiness vs the proposer's approval vs zone demand). Gives the council agency; pick the member whose agenda the current situation touches.",
  adjust_demand:
    "Multiply residential/commercial/industrial zone demand (each 0.5..2, 1 = unchanged) for `days` days. A quiet, structural nudge: migration waves, an industry leaving town.",
  visitor:
    "Send a visitor (investor, celebrity, inspector, tourists, refugees) with a headline (<= 80 chars). Investors reward healthy economies, inspectors punish neglect, refugees test generosity and capacity.",
  news:
    "Publish a gazette item (headline <= 80 chars, body <= 280 chars in the gazette's voice). Use sparingly, for foreshadowing or to make the city react to the mayor's actions.",
};

/** One Claude tool per CityDirective variant: name = the `tool` literal, input = the rest. Deterministic order (cache-friendly). */
export function buildFateTools(): Anthropic.Beta.BetaTool[] {
  return CityDirectiveSchema.options.map((variant) => {
    const name = variant.shape.tool.value;
    return {
      name,
      description: FATE_TOOL_DESCRIPTIONS[name],
      input_schema: toApiSchema((variant as unknown as z.ZodObject<{ tool: z.ZodType }>).omit({ tool: true })) as Anthropic.Beta.BetaTool.InputSchema,
      strict: true,
    };
  });
}

const clampTile = (v: number, size: number) => Math.min(size - 1, Math.max(0, Math.round(v)));

/**
 * Enforces the city's rules on directives whoever produced them: ≤ 3 per tick,
 * one per tool kind, ≤ 1 disaster (allowed kind, day ≥ 5, none active,
 * frequency > 0, coordinates clamped to the map), council motions only from
 * existing members and only while fewer than 2 motions are open, texts
 * truncated. Invalid directives are dropped.
 */
export function postProcessCityDirectives(spec: CitySpec, t: CityTelemetry, input: CityDirective[]): CityDirective[] {
  const members = new Set(spec.council.map((m) => m.id));
  const allowed = new Set<string>(spec.disasters.allowed);
  const size = spec.terrain.size;
  const used = new Set<string>();
  let openMotions = t.openMotions;
  const out: CityDirective[] = [];
  for (const d of input) {
    if (out.length >= MAX_FATE_DIRECTIVES) break;
    if (used.has(d.tool)) continue;
    let next: CityDirective | null = null;
    switch (d.tool) {
      case "trigger_disaster":
        if (t.day < FIRST_DISASTER_DAY || t.activeDisasters.length > 0 || spec.disasters.frequency <= 0 || !allowed.has(d.kind)) break;
        next = { ...d, x: clampTile(d.x, size), y: clampTile(d.y, size), headline: truncate(d.headline, 80) };
        break;
      case "council_motion":
        if (!members.has(d.memberId) || openMotions >= MAX_OPEN_MOTIONS) break;
        openMotions++;
        next = {
          ...d,
          title: truncate(d.title, 60),
          pitch: truncate(d.pitch, 240),
          options: d.options.slice(0, 3).map((o) => ({ ...o, label: truncate(o.label, 40) })),
        };
        break;
      case "news":
        next = { ...d, headline: truncate(d.headline, 80), body: truncate(d.body, 280) };
        break;
      case "economic_event":
      case "visitor":
        next = { ...d, headline: truncate(d.headline, 80) };
        break;
      default:
        next = d;
    }
    if (!next) continue;
    used.add(d.tool);
    out.push(next);
  }
  return out;
}
