import { CityTelemetrySchema } from "@bimpee/shared/city";
import { describe, expect, it } from "vitest";
import { SimHost } from "./host";
import type { FromSim } from "./protocol";
import { makeSpec } from "./testkit";

function harness() {
  const out: { msg: FromSim; transfer: Transferable[] }[] = [];
  const host = new SimHost((msg, transfer) => {
    // emulate transfer: a buffer may only be transferred once
    for (const t of transfer ?? []) {
      expect((t as ArrayBuffer).byteLength).toBeGreaterThan(-1);
      expect(seen.has(t)).toBe(false);
      seen.add(t);
    }
    out.push({ msg, transfer: transfer ?? [] });
  });
  const seen = new Set<Transferable>();
  return { host, out, of: <T extends FromSim["type"]>(t: T) => out.filter((o) => o.msg.type === t).map((o) => o.msg as Extract<FromSim, { type: T }>) };
}

describe("worker host", () => {
  it("init posts terrain, tiles, hud, ready; pump posts frames/hud/telemetry on the clock", () => {
    const h = harness();
    const spec = makeSpec(50);
    h.host.handle({ type: "init", spec, cityId: "w", save: null }, 0);
    expect(h.out.map((o) => o.msg.type)).toEqual(["terrain", "tiles", "hud", "telemetry", "ready"]);
    const terrain = h.of("terrain")[0]!;
    expect(terrain.heights.length).toBe(65 * 65);
    expect(CityTelemetrySchema.safeParse(h.of("telemetry")[0]!.telemetry).success).toBe(true);
    h.out.length = 0;
    let t = 0;
    for (let k = 0; k < 20; k++) h.host.pump((t += 100));
    expect(h.of("frame").length).toBe(20);
    expect(h.of("hud").length).toBeGreaterThanOrEqual(7);
    expect(h.of("tiles").length).toBeLessThanOrEqual(2); // nothing changed structurally
    expect(h.host.sim!.ticks).toBe(20);
    // commands: result + immediate tiles
    h.out.length = 0;
    h.host.handle({ type: "command", command: { type: "road", path: [[30, 32], [34, 32]] } }, t);
    expect(h.of("command_result")[0]).toMatchObject({ ok: true, cost: 50 });
    const tiles = h.of("tiles")[0]!;
    expect(tiles.kind[32 * 64 + 31]).toBe(2);
    expect(h.out.find((o) => o.msg.type === "tiles")!.transfer.length).toBe(7);
    h.host.handle({ type: "command", command: { type: "road", path: [[30, 32]] } as never }, t);
    expect(h.of("command_result")[1]).toMatchObject({ ok: false });
    // a whole day -> one telemetry
    h.out.length = 0;
    for (let k = 0; k < 700; k++) h.host.pump((t += 100));
    expect(h.of("telemetry").length).toBe(1);
  });

  it("pause/resume/speed, throttled gaps capped, serialize, errors, dispose", () => {
    const h = harness();
    const spec = makeSpec(51);
    h.host.handle({ type: "pause" }, 0);
    expect(h.of("error").length).toBe(1);
    h.host.handle({ type: "init", spec, cityId: "w", save: null }, 0);
    const sim = h.host.sim!;
    h.host.handle({ type: "pause" }, 0);
    h.host.pump(5000);
    expect(sim.ticks).toBe(0);
    h.host.handle({ type: "resume" }, 5000);
    h.host.pump(5100);
    expect(sim.ticks).toBe(1);
    h.host.pump(60_000); // tab was asleep: at most MAX_GAP_MS simulated
    expect(sim.ticks).toBe(11);
    h.host.handle({ type: "command", command: { type: "speed", speed: 4 } }, 60_000);
    h.host.pump(60_100);
    expect(sim.ticks).toBe(15);
    h.host.handle({ type: "command", command: { type: "speed", speed: 0 } }, 60_100);
    h.host.pump(60_200);
    expect(sim.ticks).toBe(15);
    expect(h.of("hud").at(-1)!.hud.speed).toBe(0);
    h.host.handle({ type: "serialize", reqId: 7 }, 60_200);
    const ser = h.of("serialized")[0]!;
    expect(ser.reqId).toBe(7);
    // load the save in a new host
    const h2 = harness();
    h2.host.handle({ type: "init", spec, cityId: "w", save: ser.data }, 0);
    expect(h2.of("ready").length).toBe(1);
    expect(h2.host.sim!.ticks).toBe(15);
    const h3 = harness();
    h3.host.handle({ type: "init", spec, cityId: "w", save: "garbage" }, 0);
    expect(h3.of("error").length).toBe(1);
    h.host.handle({ type: "directives", directives: [{ tool: "news", headline: "x", body: "y" }] }, 60_200);
    h.host.handle({ type: "command", command: { type: "speed", speed: 1 } }, 60_200);
    h.host.pump(60_300);
    expect(h.of("frame").at(-1)!.events.some((e) => e.kind === "news")).toBe(true);
    h.host.handle({ type: "dispose" }, 60_300);
    const n = h.out.length;
    h.host.pump(70_000);
    expect(h.out.length).toBe(n);
  });
});
