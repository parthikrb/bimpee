import type { Goal } from "@bimpee/shared/city";
import type { CitySim } from "./CitySim";
import { councilEvent } from "./fate";
import { clamp01, finite } from "./rand";

/** Scenario goals from the spec: progress, achievement and failure. */

export function goalValue(sim: CitySim, g: Goal): number {
  switch (g.metric) {
    case "population":
      return sim.population;
    case "happiness":
      return sim.happiness;
    case "funds":
      return sim.funds;
    case "green_power_share":
      return sim.power.greenShare;
    case "traffic_flow":
      return 1 - sim.congestion;
    case "disasters_survived":
      return sim.disastersSurvived;
  }
}

export function goalProgress(sim: CitySim, g: Goal): number {
  if (g.target <= 0) return 1;
  return clamp01(finite(goalValue(sim, g) / g.target, 0));
}

/** Called daily: resolve goals and emit `goal` events once. */
export function updateGoals(sim: CitySim) {
  sim.spec.goals.forEach((g, k) => {
    const st = sim.goals[k] ?? (sim.goals[k] = { achieved: false, failed: false });
    if (st.achieved || st.failed) return;
    if (goalValue(sim, g) >= g.target) {
      st.achieved = true;
      sim.emit({ kind: "goal", text: g.description, achieved: true });
      councilEvent(sim, "goal_achieved");
    } else if (sim.day > g.byDay) {
      st.failed = true;
      sim.emit({ kind: "goal", text: g.description, achieved: false });
      councilEvent(sim, "goal_failed");
    }
  });
}

export function goalsHud(sim: CitySim) {
  return sim.spec.goals.map((g, k) => {
    const st = sim.goals[k];
    return {
      description: g.description,
      progress: st?.achieved ? 1 : goalProgress(sim, g),
      daysLeft: Math.max(0, g.byDay - sim.day),
      achieved: !!st?.achieved,
    };
  });
}
