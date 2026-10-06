import { describe, expect, it } from "vitest";
import { CitySim } from "./CitySim";
import { addBuilding } from "./grid";
import { TileKind } from "./protocol";
import { b64ToBytes, bytesToB64 } from "./serialize";
import { makeSpec, scriptedCity } from "./testkit";

function played(seed = 31, days = 6) {
  const spec = makeSpec(seed);
  const sim = new CitySim(spec, "s");
  const p = scriptedCity(sim);
  const end = sim.day + days;
  let d = sim.day;
  while (sim.day < end) {
    sim.tick();
    if (sim.day !== d) {
      d = sim.day;
      p.daily();
    }
  }
  sim.applyDirectives([
    {
      tool: "council_motion",
      memberId: spec.council[0]!.id,
      title: "Über-park ☀",
      pitch: "unicode ✓",
      options: [
        { label: "a", effect: { funds: 1, happiness: 0, approval: 0, demand: "none" } },
        { label: "b", effect: { funds: 0, happiness: 0, approval: 0, demand: "none" } },
      ],
    },
    { tool: "economic_event", kind: "boom", strength: 0.5, days: 4, headline: "Boom" },
  ]);
  sim.command({ type: "sandbox_disaster", kind: "tornado", x: 32, y: 32, strength: 0.6 });
  sim.advance(37);
  return sim;
}

describe("serialization", () => {
  it("base64 helpers round-trip all lengths", () => {
    for (let n = 0; n < 20; n++) {
      const a = new Uint8Array(n).map((_, i) => (i * 37 + n) & 255);
      expect(Array.from(b64ToBytes(bytesToB64(a)))).toEqual(Array.from(a));
    }
    expect(bytesToB64(new TextEncoder().encode("hello"))).toBe(Buffer.from("hello").toString("base64"));
  });

  it("round-trips exactly and preserves the city", () => {
    const sim = played();
    const data = sim.serialize();
    const back = CitySim.deserialize(sim.spec, "s", data);
    expect(back.serialize()).toBe(data);
    expect(back.population).toBe(sim.population);
    expect(back.funds).toBe(sim.funds);
    expect(back.day).toBe(sim.day);
    expect(back.hour).toBeCloseTo(sim.hour, 6);
    expect(back.buildings.size).toBe(sim.buildings.size);
    expect(Array.from(back.kind)).toEqual(Array.from(sim.kind));
    expect(Array.from(back.roads)).toEqual(Array.from(sim.roads));
    expect(Array.from(back.flags)).toEqual(Array.from(sim.flags));
    expect(Array.from(back.building)).toEqual(Array.from(sim.building));
    expect(back.motions).toEqual(sim.motions);
    expect(back.disasters).toEqual(sim.disasters);
    expect(back.getHud()).toEqual({ ...sim.getHud(), power: back.getHud().power, water: back.getHud().water });
    // and keeps running
    back.advance(back.ticksPerDay * 2);
    expect(Number.isFinite(back.funds)).toBe(true);
  });

  it("rejects corrupt or mismatched saves", () => {
    const sim = played(32, 1);
    const data = sim.serialize();
    expect(() => CitySim.deserialize(sim.spec, "s", "!!!")).toThrow();
    const other = makeSpec(32, (s) => (s.terrain.size = 80));
    expect(() => CitySim.deserialize(other, "s", data)).toThrow(/size/);
  });

  it("stays under 1 MB for a fully built 80x80 city", () => {
    const sim = new CitySim(makeSpec(33, (s) => (s.terrain.size = 80)), "big");
    for (let y = 0; y < 80; y++)
      for (let x = 0; x < 80; x++) {
        const k = sim.kind[y * 80 + x];
        if (k === TileKind.Land || k === TileKind.Forest) {
          const b = addBuilding(sim, { type: (["res", "com", "ind"] as const)[(x + y) % 3]!, x, y, size: 1, rot: 3, level: 3, cost: 0 });
          b.damage = 0.123456789;
          b.occupants = 109;
        }
      }
    sim.advance(25);
    const data = sim.serialize();
    expect(sim.buildings.size).toBeGreaterThan(2000);
    expect(data.length).toBeLessThan(1_000_000);
    expect(CitySim.deserialize(sim.spec, "big", data).serialize()).toBe(data);
  });

  it("is deterministic for a given seed and command sequence (no Math.random)", () => {
    const orig = Math.random;
    Math.random = () => {
      throw new Error("Math.random used in the sim");
    };
    try {
      const a = played(40, 4);
      const b = played(40, 4);
      expect(a.serialize()).toBe(b.serialize());
      expect(Array.from(a.drainFrame().cars)).toEqual(Array.from(b.drainFrame().cars));
    } finally {
      Math.random = orig;
    }
  });
});
