import { CityTelemetrySchema } from "@bimpee/shared/city";
import { describe, expect, it } from "vitest";
import { CitySim } from "./CitySim";
import { makeSpec, scriptedCity } from "./testkit";

/** 60 in-game days on an 80x80 map with a scripted mayor and the offline Fate. */
describe("soak", () => {
  it("grows past 1,000 citizens with stable, finite state", () => {
    const spec = makeSpec(11, (s) => {
      s.terrain.size = 80;
      s.disasters.frequency = 0.5;
    });
    const sim = new CitySim(spec, "soak");
    const mayor = scriptedCity(sim);
    const curve: number[] = [];
    let day = sim.day;
    let worst = 0;
    const t0 = performance.now();
    let dayStart = t0;
    while (sim.day < 61) {
      sim.tick();
      if (sim.ticks % 10 === 0) {
        const f = sim.drainFrame();
        expect(f.cars.length % 4).toBe(0);
        sim.drainTiles();
      }
      if (sim.day !== day) {
        day = sim.day;
        const now = performance.now();
        worst = Math.max(worst, (now - dayStart) / sim.ticksPerDay);
        dayStart = now;
        mayor.daily();
        curve.push(sim.population);
        const t = sim.drainTelemetry()!;
        const parsed = CityTelemetrySchema.safeParse(t);
        if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
        // a gentle Fate: weather and news only, disasters are covered elsewhere
        if (day % 7 === 0) sim.applyDirectives([{ tool: "set_weather", kind: "rain", days: 1 }]);
        for (const v of [sim.funds, sim.happiness, sim.demand.residential, sim.power.supply, sim.congestion, sim.pollutionAvg]) expect(Number.isFinite(v)).toBe(true);
      }
    }
    const ms = (performance.now() - t0) / sim.ticks;
    console.log(`[soak] 80x80, ${sim.ticks} ticks, ${ms.toFixed(3)} ms/tick avg, worst day ${worst.toFixed(3)} ms/tick`);
    console.log(`[soak] population by day: ${curve.filter((_, i) => i % 5 === 0).join(", ")} ... ${sim.population}`);
    console.log(`[soak] buildings ${sim.buildings.size}, cars ${sim.traffic.count}, funds ${Math.round(sim.funds)}, happiness ${sim.happiness.toFixed(2)}, save ${(sim.serialize().length / 1024).toFixed(0)} KB`);
    expect(sim.population).toBeGreaterThan(1000);
    expect(ms).toBeLessThan(2);
    for (const b of sim.buildings.values()) expect(Number.isFinite(b.damage) && Number.isFinite(b.occupants)).toBe(true);
    expect(sim.pollution.every(Number.isFinite)).toBe(true);
    expect(sim.landValue.every(Number.isFinite)).toBe(true);
  }, 120_000);
});
