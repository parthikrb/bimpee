import type { Directive, DirectorResponse, Telemetry } from "./director";
import type { WorldSpec } from "./world";

/**
 * Rule-based stand-in for the Claude director. Used offline, when no API
 * key is configured, and as the fallback when a model call fails or is slow.
 * It is intentionally simple: the point of the Claude director is everything
 * this can't do (reading the player, story beats, surprising combinations).
 */
export function localDirector(world: WorldSpec, t: Telemetry): DirectorResponse {
  const started = Date.now();
  const d: Directive[] = [];
  const reasons: string[] = [];
  const recent = new Set(t.recentDirectives);
  const p = t.player;

  if (p.hpFraction < 0.25 && !recent.has("grant_boon")) {
    d.push({ tool: "grant_boon", kind: "heal", announce: "The world takes pity" });
    d.push({ tool: "set_intensity_target", target: Math.max(0.2, t.intensityTarget - 0.25), rampSec: 6 });
    reasons.push("player is low on hp: heal and ease off");
  } else if (t.intensity < t.intensityTarget - 0.25 && p.damageTaken < 0.05) {
    // Cruising: push harder.
    d.push({ tool: "adjust_spawns", rateMultiplier: 1.6, weights: [] });
    if (!recent.has("inject_event") && t.act >= 1) {
      d.push({ tool: "inject_event", kind: t.act === 2 ? "elite_pack" : "ambush", strength: 0.6, announce: "Ambush!" });
    }
    reasons.push("player is cruising below target: raise pressure");
  } else if (t.intensity > 0.9 && p.hpFraction < 0.5) {
    d.push({ tool: "adjust_spawns", rateMultiplier: 0.6, weights: [] });
    reasons.push("player is overwhelmed: give them room");
  } else {
    d.push({ tool: "adjust_spawns", rateMultiplier: 1, weights: [] });
    reasons.push("pacing on target: hold steady");
  }

  if (t.act === 2 && !t.bossActive && t.t > runStartOfAct(world, 2) + 30 && !recent.has("spawn_boss")) {
    d.push({ tool: "spawn_boss", announce: `${world.boss.name} awakens` });
    reasons.push("act 3 is underway: summon the boss");
  }

  return { directives: d, reasoning: reasons.join("; "), model: "local", latencyMs: Date.now() - started };
}

export function runStartOfAct(world: WorldSpec, act: number) {
  return world.arc.slice(0, act).reduce((s, a) => s + a.durationSec, 0);
}
