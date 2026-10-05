import type { Directive } from "@bimpee/shared";

const f = (n: number, d = 2) => n.toFixed(d).replace(/\.?0+$/, "") || "0";
const q = (s: string, n = 48) => `“${s.length > n ? `${s.slice(0, n - 1)}…` : s}”`;

/** One-line, human summary of a directive's arguments for the debug log. */
export function describeDirective(d: Directive): string {
  switch (d.tool) {
    case "set_intensity_target":
      return `target → ${f(d.target)} over ${f(d.rampSec, 0)}s`;
    case "adjust_spawns":
      return `rate ×${f(d.rateMultiplier)}${d.weights.length ? ` · ${d.weights.map((w) => `${w.id}:${f(w.weight)}`).join(", ")}` : ""}`;
    case "inject_event":
      return `${d.kind.replace(/_/g, " ")} @${f(d.strength)} ${q(d.announce, 30)}`;
    case "spawn_boss":
      return q(d.announce, 40);
    case "shift_biome":
      return `${d.weather} · fog ${f(d.fog)} · ${d.tint}`;
    case "mutate_enemies":
      return `${d.archetypeId} +${d.addModifier.replace(/_/g, " ")} ×${f(d.speedMultiplier)}`;
    case "grant_boon":
      return `${d.kind.replace(/_/g, " ")} ${q(d.announce, 30)}`;
    case "narrate":
      return `[${d.mood}] ${q(d.line, 60)}`;
    case "set_music":
      return `energy ${f(d.energy)} · tension ${f(d.tension)}`;
  }
}

export const TOOL_COLORS: Record<Directive["tool"], string> = {
  set_intensity_target: "#ff2bd6",
  adjust_spawns: "#00f0ff",
  inject_event: "#ffd23f",
  spawn_boss: "#ff3b5c",
  shift_biome: "#9fd8ff",
  mutate_enemies: "#ff8a3d",
  grant_boon: "#3bffb0",
  narrate: "#c77dff",
  set_music: "#7ae0ff",
};
