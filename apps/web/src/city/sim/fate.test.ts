import { CityTelemetrySchema, localFate } from "@bimpee/shared/city";
import { describe, expect, it } from "vitest";
import { CitySim } from "./CitySim";
import { addBuilding } from "./grid";
import { flatWorld, makeSpec } from "./testkit";

function sim0() {
  const s = new CitySim(makeSpec(12), "f");
  flatWorld(s);
  s.events = [];
  return s;
}
const day = (s: CitySim, n = 1) => s.advance(s.ticksPerDay * n);

describe("Fate directives", () => {
  it("ignores invalid directives without throwing and records them", () => {
    const s = sim0();
    expect(() =>
      s.applyDirectives([null, 42, { tool: "nope" }, { tool: "economic_event", kind: "boom" }, { tool: "set_weather", kind: "lava", days: 2 }] as unknown[]),
    ).not.toThrow();
    expect(s.modifiers.length).toBe(0);
    expect(s.recentDirectives.filter((d) => d.startsWith("invalid")).length).toBe(5);
    expect(() => s.applyDirectives("garbage" as never)).not.toThrow();
  });

  it("economic events: modifiers, grant funds, expiry", () => {
    const s = sim0();
    const f0 = s.funds;
    s.applyDirectives([
      { tool: "economic_event", kind: "federal_grant", strength: 1, days: 1, headline: "Grant!" },
      { tool: "economic_event", kind: "recession", strength: 1, days: 2, headline: "Recession" },
    ]);
    expect(s.funds).toBe(f0 + 25000);
    expect(s.events.filter((e) => e.kind === "economy").map((e) => (e as { text: string }).text)).toEqual(["Grant!", "Recession"]);
    s.advance(200);
    const rec = s.demand.commercial;
    const ref = sim0();
    ref.advance(200);
    expect(rec).toBeLessThan(ref.demand.commercial - 0.2);
    day(s, 3);
    expect(s.modifiers.length).toBe(0);
    expect(s.recentDirectives).toEqual(["economic_event", "economic_event"]);
    for (const kind of ["boom", "tourism_wave", "strike", "tech_startup_rush"] as const) {
      s.applyDirectives([{ tool: "economic_event", kind, strength: 0.5, days: 3, headline: kind }]);
    }
    expect(s.modifiers.length).toBe(4);
  });

  it("set_weather holds for N days; adjust_demand multiplies; visitor and news emit events", () => {
    const s = sim0();
    s.applyDirectives([{ tool: "set_weather", kind: "storm", days: 2 }]);
    expect(s.weather).toBe("storm");
    day(s, 1);
    expect(s.weather).toBe("storm");
    s.applyDirectives([
      { tool: "adjust_demand", residential: 2, commercial: 0.5, industrial: 1, days: 3 },
      { tool: "visitor", kind: "celebrity", headline: "A star visits" },
      { tool: "news", headline: "Hello", body: "World" },
    ]);
    s.advance(300);
    const ref = sim0();
    ref.advance(s.ticks - ref.ticks);
    expect(s.demand.residential).toBeGreaterThan(ref.demand.residential * 1.5);
    const kinds = s.events.map((e) => e.kind);
    expect(kinds).toContain("visitor");
    expect(kinds).toContain("news");
  });

  it("council motions: unknown member ignored, at most 2, vote applies effects, expiry costs approval", () => {
    const s = sim0();
    const [a, b] = s.spec.council;
    const motion = (memberId: string) => ({
      tool: "council_motion" as const,
      memberId,
      title: "Build a park",
      pitch: "Trees!",
      options: [
        { label: "Yes", effect: { funds: -2000, happiness: 0.1, approval: 0.3, demand: "residential" as const } },
        { label: "No", effect: { funds: 0, happiness: 0, approval: -0.2, demand: "none" as const } },
      ],
    });
    s.applyDirectives([motion("ghost"), motion(a!.id), motion(b!.id), motion(a!.id)]);
    expect(s.motions.length).toBe(2);
    const hud = s.getHud();
    expect(hud.motions[0]).toMatchObject({ memberId: a!.id, title: "Build a park", options: [{ label: "Yes" }, { label: "No" }], expiresDay: s.day + 3 });
    const f0 = s.funds;
    expect(s.command({ type: "motion_vote", motionId: hud.motions[0]!.id, option: 2 }).ok).toBe(false);
    const r = s.command({ type: "motion_vote", motionId: hud.motions[0]!.id, option: 0 });
    expect(r).toMatchObject({ ok: true, cost: 2000 });
    expect(s.funds).toBe(f0 - 2000);
    expect(s.approval[a!.id]).toBeCloseTo(0.3);
    expect(s.motions.length).toBe(1);
    expect(s.command({ type: "motion_vote", motionId: hud.motions[0]!.id, option: 0 }).ok).toBe(false);
    const before = s.approval[b!.id]!;
    day(s, 4);
    expect(s.motions.length).toBe(0);
    expect(s.approval[b!.id]!).toBeLessThan(before - 0.05);
  });

  it("approval follows player actions by role", () => {
    const s = sim0();
    s.funds = 1e6;
    const env = s.spec.council.find((m) => m.role === "environmentalist")!;
    const ind = s.spec.council.find((m) => m.role === "industrialist")!;
    s.command({ type: "build", kind: "power_coal", x: 10, y: 10, rot: 0 });
    expect(s.approval[env.id]!).toBeLessThan(0);
    expect(s.approval[ind.id]!).toBeGreaterThan(0);
    for (let k = 0; k < 5; k++) s.command({ type: "build", kind: "park", x: 20 + k, y: 20, rot: 0 });
    expect(s.approval[env.id]!).toBeGreaterThan(0);
    for (const v of Object.values(s.approval)) expect(v).toBeGreaterThanOrEqual(-1);
  });

  it("local Fate output applies cleanly and telemetry validates", () => {
    const s = sim0();
    for (let d = 0; d < 6; d++) {
      day(s, 1);
      const t = s.getTelemetry();
      expect(CityTelemetrySchema.safeParse(t).success).toBe(true);
      s.applyDirectives(localFate(s.spec, t).directives);
    }
  });
});

describe("goals and telemetry", () => {
  it("achieves and fails goals once, with events", () => {
    const s = new CitySim(
      makeSpec(13, (sp) => {
        sp.goals = [
          { description: "Hold 1000 funds", metric: "funds", target: 1000, byDay: 10 },
          { description: "Reach 5000 people", metric: "population", target: 5000, byDay: 5 },
        ];
      }),
      "g",
    );
    flatWorld(s);
    expect(s.getHud().goals[1]).toMatchObject({ progress: 0, achieved: false });
    day(s, 6);
    const goals = s.recentEvents.filter((e) => e.startsWith("goal"));
    expect(goals).toEqual(["goal achieved: Hold 1000 funds", "goal failed: Reach 5000 people"]);
    day(s, 2);
    expect(s.recentEvents.filter((e) => e.startsWith("goal")).length).toBe(2);
    const hud = s.getHud().goals;
    expect(hud[0]).toMatchObject({ progress: 1, achieved: true });
    expect(hud[1]!.daysLeft).toBe(0);
  });

  it("aggregates player actions, milestones and building counts", () => {
    const s = sim0();
    s.command({ type: "road", path: [[5, 5], [18, 5]] });
    s.command({ type: "zone", zone: "residential", x0: 5, y0: 6, x1: 7, y1: 8 });
    const t = s.getTelemetry();
    expect(t.recentPlayerActions).toEqual(["built 14 road tiles", "zoned 9 residential tiles"]);
    for (let k = 0; k < 12; k++) addBuilding(s, { type: "res", x: 20 + k, y: 20, size: 1, rot: 0, level: 3, cost: 0 }).occupants = 110;
    s.advance(20);
    day(s, 1);
    expect(s.population).toBeGreaterThan(1000);
    expect(s.recentEvents.some((e) => /reaches 1,000/.test(e))).toBe(true);
    const t2 = s.drainTelemetry()!;
    expect(t2).not.toBeNull();
    expect(s.drainTelemetry()).toBeNull(); // once per day
    expect((t2.buildings.res ?? 0) + (t2.buildings.res_abandoned ?? 0)).toBe(12);
    expect(t2.buildings.road_tiles).toBe(14);
    expect(CityTelemetrySchema.safeParse(t2).success).toBe(true);
  });
});
