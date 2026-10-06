import type { CityTelemetry } from "@bimpee/shared/city";
import type { CitySim } from "./CitySim";
import { goalProgress } from "./goals";
import { TileKind } from "./protocol";
import { clamp, clamp01, finite } from "./rand";

/** Aggregate a player action for today's summary ("#" is replaced by the count). */
export function recordAction(sim: CitySim, key: string, count: number) {
  sim.dayActions.set(key, (sim.dayActions.get(key) ?? 0) + count);
}

const int = (v: number) => Math.round(finite(v, 0));

export function buildTelemetry(sim: CitySim): CityTelemetry {
  const buildings: Record<string, number> = {};
  let damaged = 0;
  for (const b of sim.buildings.values()) {
    const key = b.abandoned ? `${b.type}_abandoned` : b.type;
    buildings[key] = (buildings[key] ?? 0) + 1;
    if (b.damage > 0.05) damaged++;
  }
  let roads = 0;
  for (let i = 0; i < sim.n; i++) if (sim.kind[i] === TileKind.Road) roads++;
  buildings.road_tiles = roads;
  // include today's actions so far (yesterday's are in recentActions)
  const actions = [...sim.recentActions];
  for (const [k, v] of sim.dayActions) actions.push(k.replace("#", String(v)));
  const approval: Record<string, number> = {};
  for (const [k, v] of Object.entries(sim.approval)) approval[k] = clamp(finite(v, 0), -1, 1);
  return {
    cityId: sim.cityId,
    day: Math.max(0, sim.day),
    hour: clamp(finite(sim.hour, 0), 0, 24),
    population: Math.max(0, int(sim.population)),
    funds: int(sim.funds),
    incomePerDay: int(sim.incomePerDay),
    expensesPerDay: int(sim.expensesPerDay),
    taxRate: clamp(finite(sim.taxRate, 0.09), 0, 0.2),
    happiness: clamp01(finite(sim.happiness, 0.5)),
    demand: {
      residential: clamp(finite(sim.demand.residential), -1, 1),
      commercial: clamp(finite(sim.demand.commercial), -1, 1),
      industrial: clamp(finite(sim.demand.industrial), -1, 1),
    },
    power: { supply: Math.max(0, finite(sim.power.supply)), demand: Math.max(0, finite(sim.power.demand)), greenShare: clamp01(finite(sim.power.greenShare)) },
    water: { supply: Math.max(0, finite(sim.water.supply)), demand: Math.max(0, finite(sim.water.demand)) },
    trafficCongestion: clamp01(finite(sim.congestion)),
    unemployment: clamp01(finite(sim.unemployment)),
    pollution: clamp01(finite(sim.pollutionAvg)),
    buildings,
    damagedBuildings: damaged,
    activeDisasters: sim.disasters.slice(0, 6).map((d) => d.kind),
    recentPlayerActions: actions.slice(-10).map((s) => s.slice(0, 160)),
    recentEvents: sim.recentEvents.slice(-10).map((s) => s.slice(0, 200)),
    recentDirectives: sim.recentDirectives.slice(-8),
    councilApproval: approval,
    openMotions: sim.motions.length,
    goals: sim.spec.goals.slice(0, 3).map((g, k) => ({
      description: g.description,
      progress: sim.goals[k]?.achieved ? 1 : goalProgress(sim, g),
      daysLeft: g.byDay - sim.day,
    })),
  };
}
