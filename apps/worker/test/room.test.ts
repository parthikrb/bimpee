import { describe, expect, it, vi } from "vitest";
import { ServerMsgSchema, generateFallbackWorld, type Directive, type DirectorResponse, type ServerMsg, type WorldResponse } from "@bimpee/shared";
import { RoomCore, type RoomConn, type RoomDeps, type Timers } from "../src/room/core";
import type { Telemetry } from "@bimpee/shared";
import { telemetry } from "./helpers";

class FakeConn implements RoomConn {
  sent: ServerMsg[] = [];
  closed: { code?: number; reason?: string } | null = null;
  constructor(readonly id: string) {}
  send(data: string) {
    this.sent.push(ServerMsgSchema.parse(JSON.parse(data)));
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  of<T extends ServerMsg["type"]>(type: T) {
    return this.sent.filter((m): m is Extract<ServerMsg, { type: T }> => m.type === type);
  }
}

class FakeTimers implements Timers {
  active = new Map<number, { fn: () => void; ms: number }>();
  private next = 1;
  setInterval(fn: () => void, ms: number) {
    const id = this.next++;
    this.active.set(id, { fn, ms });
    return id;
  }
  clearInterval(h: unknown) {
    this.active.delete(h as number);
  }
  fire(ms: number) {
    for (const t of this.active.values()) if (t.ms === ms) t.fn();
  }
}

function makeRoom(over: Partial<RoomDeps> = {}, roomId = "test-room") {
  let now = 1_000_000;
  const timers = new FakeTimers();
  const directives: Directive[] = [{ tool: "spawn_boss", announce: "Boss!" }, { tool: "set_music", energy: 1, tension: 1 }];
  const ai = {
    generateWorld: vi.fn(async ({ seed }: { seed?: number }): Promise<WorldResponse> => ({
      world: generateFallbackWorld(seed ?? 0),
      source: "fallback",
      model: "mock",
      latencyMs: 0,
    })),
    director: vi.fn(async (_w: unknown, _t: Telemetry, _m: unknown): Promise<DirectorResponse> => ({ directives, reasoning: "test", model: "test", latencyMs: 0 })),
  };
  const room = new RoomCore(roomId, { ai, timers, now: () => now, ...over });
  const advance = (ms: number) => (now += ms);
  return { room, ai, timers, advance };
}

const join = async (room: RoomCore, id: string, name = id) => {
  const c = new FakeConn(id);
  room.connect(c);
  await room.message(id, JSON.stringify({ type: "join", name }));
  return c;
};

describe("RoomCore", () => {
  it("rejects invalid room ids", () => {
    const { room } = makeRoom({}, "Bad_Room!");
    const c = new FakeConn("a");
    room.connect(c);
    expect(c.of("error")[0]!.message).toMatch(/invalid room id/);
    expect(c.closed).not.toBeNull();
  });

  it("creates one world per generation and welcomes everyone into it", async () => {
    const { room, ai } = makeRoom();
    const [a, b] = await Promise.all([join(room, "a"), join(room, "b")]);
    expect(ai.generateWorld).toHaveBeenCalledTimes(1);
    expect(ai.generateWorld.mock.calls[0]![0]).toMatchObject({ memory: null, timeoutMs: 20_000 });
    const wa = a.of("welcome")[0]!;
    const wb = b.of("welcome")[0]!;
    expect(wa.selfId).toBe("a");
    expect(wa.world).toEqual(wb.world);
    expect(wa.startedAt).toBe(wb.startedAt);
  });

  it("caps rooms at 8 players", async () => {
    const { room } = makeRoom();
    for (let i = 0; i < 8; i++) await join(room, `p${i}`);
    const ninth = new FakeConn("p8");
    room.connect(ninth);
    expect(ninth.of("error")[0]!.message).toMatch(/full/);
    expect(ninth.closed).not.toBeNull();
    expect(room.size).toBe(8);
  });

  it("validates messages and requires join first", async () => {
    const { room } = makeRoom();
    const c = new FakeConn("x");
    room.connect(c);
    await room.message("x", "{bad json");
    await room.message("x", JSON.stringify({ type: "state", x: 1 }));
    await room.message("x", JSON.stringify({ type: "emote", emote: "gg" }));
    expect(c.of("error").map((e) => e.message)).toEqual([expect.stringMatching(/invalid JSON/), expect.stringMatching(/invalid message/), "send join first"]);
  });

  it("relays player state at the broadcast tick only when something changed, and emotes with names", async () => {
    const { room, timers } = makeRoom();
    const a = await join(room, "a", "Alice<script>");
    const b = await join(room, "b", "Bob");
    await room.message("a", JSON.stringify({ type: "state", x: 10, y: 20, hp: 0.5, score: 7, alive: true }));
    timers.fire(100);
    const players = b.of("players").at(-1)!.players;
    expect(players.find((p) => p.id === "a")).toMatchObject({ name: "Alicescript", x: 10, y: 20, hp: 0.5, score: 7 });
    const before = b.of("players").length;
    timers.fire(100);
    expect(b.of("players").length).toBe(before);
    await room.message("b", JSON.stringify({ type: "emote", emote: "gg" }));
    expect(a.of("emote")[0]).toEqual({ type: "emote", from: "b", name: "Bob", emote: "gg" });
  });

  it("aggregates telemetry across players", async () => {
    const { room, advance } = makeRoom();
    await join(room, "a");
    await join(room, "b");
    advance(10_000);
    await room.message("a", JSON.stringify({ type: "telemetry", telemetry: telemetry({ intensity: 0.3, fps: 50 }, { hpFraction: 0.9, kills: 3, damageTaken: 0.1, weapon: "beam" }) }));
    await room.message("b", JSON.stringify({ type: "telemetry", telemetry: telemetry({ intensity: 0.8, fps: 60, bossActive: true }, { hpFraction: 0.2, kills: 5, damageTaken: 0.3, weapon: "scatter" }) }));
    const agg = room.aggregate()!;
    expect(agg.players).toBe(2);
    expect(agg.player.hpFraction).toBe(0.2);
    expect(agg.player.weapon).toBe("scatter");
    expect(agg.intensity).toBe(0.8);
    expect(agg.player.kills).toBe(8);
    expect(agg.player.damageTaken).toBeCloseTo(0.4);
    expect(agg.fps).toBe(50);
    expect(agg.bossActive).toBe(true);
    expect(agg.act).toBe(0);
    expect(agg.t).toBe(10);
  });

  it("runs one director for everyone on the 20s tick, and only spawns one boss per run", async () => {
    const { room, ai, timers } = makeRoom();
    const a = await join(room, "a");
    const b = await join(room, "b");
    expect(await room.directorTick()).toBeNull(); // no telemetry yet
    await room.message("a", JSON.stringify({ type: "telemetry", telemetry: telemetry() }));
    timers.fire(20_000);
    await vi.waitFor(() => expect(a.of("directives")).toHaveLength(1));
    expect(ai.director).toHaveBeenCalledTimes(1);
    expect(ai.director.mock.calls[0]![2]).toBeNull();
    expect(b.of("directives")[0]!.directives.map((d) => d.tool)).toEqual(["spawn_boss", "set_music"]);

    await room.message("b", JSON.stringify({ type: "telemetry", telemetry: telemetry() }));
    const second = await room.directorTick();
    expect(second!.map((d) => d.tool)).toEqual(["set_music"]);
    expect(ai.director.mock.calls[1]![1].recentDirectives).toEqual(["spawn_boss", "set_music"]);
  });

  it("uses the local director when the room's AI budget is exhausted", async () => {
    const { room, ai } = makeRoom({ allowAi: async () => false });
    const a = await join(room, "a");
    expect(ai.generateWorld).not.toHaveBeenCalled();
    expect(a.of("welcome")).toHaveLength(1);
    await room.message("a", JSON.stringify({ type: "telemetry", telemetry: telemetry({}, { hpFraction: 0.1 }) }));
    const d = await room.directorTick();
    expect(ai.director).not.toHaveBeenCalled();
    expect(d!.some((x) => x.tool === "grant_boon")).toBe(true);
  });

  it("resets when empty: timers cleared, next group gets a fresh world", async () => {
    const { room, ai, timers } = makeRoom();
    const a = await join(room, "a");
    const b = await join(room, "b");
    const firstWorld = a.of("welcome")[0]!.world;
    room.disconnect("a");
    expect(b.of("left")[0]).toEqual({ type: "left", id: "a" });
    expect(timers.active.size).toBe(2);
    room.disconnect("b");
    expect(timers.active.size).toBe(0);
    expect(room.currentWorld).toBeNull();
    const c = await join(room, "c");
    expect(ai.generateWorld).toHaveBeenCalledTimes(2);
    expect(c.of("welcome")[0]!.world.seed).not.toBe(firstWorld.seed);
  });

  it("does not welcome a player who left while the world was generating", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { room } = makeRoom({
      ai: {
        generateWorld: async ({ seed }) => {
          await gate;
          return { world: generateFallbackWorld(seed ?? 0), source: "fallback", model: "mock", latencyMs: 0 };
        },
        director: async () => ({ directives: [], reasoning: "", model: "x", latencyMs: 0 }),
      },
    });
    const c = new FakeConn("a");
    room.connect(c);
    const pending = room.message("a", JSON.stringify({ type: "join", name: "A" }));
    room.disconnect("a");
    release();
    await pending;
    expect(c.of("welcome")).toHaveLength(0);
    expect(room.timersRunning).toBe(false);
  });
});
