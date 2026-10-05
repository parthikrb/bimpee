import { describe, expect, it } from "vitest";
import { generateFallbackWorld } from "@bimpee/shared";
import { telemetry } from "../test/fixtures";
import { otherPlayers, RoomClient, roomStartOffset, type SocketLike } from "./roomClient";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  private l = new Map<string, Set<(e: any) => void>>();
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  addEventListener(t: string, fn: (e: any) => void) {
    if (!this.l.has(t)) this.l.set(t, new Set());
    this.l.get(t)!.add(fn);
  }
  removeEventListener(t: string, fn: (e: any) => void) {
    this.l.get(t)?.delete(fn);
  }
  listenerCount() {
    return [...this.l.values()].reduce((n, s) => n + s.size, 0);
  }
  fire(t: string, e: unknown = {}) {
    if (t === "open") this.readyState = 1;
    if (t === "close") this.readyState = 3;
    this.l.get(t)?.forEach((fn) => fn(e));
  }
}

function setup() {
  let sock!: FakeSocket;
  let now = 0;
  const c = new RoomClient({
    roomId: "neon-fox-42",
    name: "Neo",
    factory: () => (sock = new FakeSocket()),
    now: () => now,
  });
  return { c, sock, setNow: (n: number) => (now = n) };
}

const world = generateFallbackWorld(5);
const player = (id: string) => ({ id, name: id, x: 1, y: 2, hp: 1, score: 0, alive: true });

describe("RoomClient", () => {
  it("joins on open and reports status", () => {
    const { c, sock } = setup();
    const statuses: string[] = [];
    c.onStatus((s) => statuses.push(s));
    sock.fire("open");
    expect(JSON.parse(sock.sent[0]!)).toEqual({ type: "join", name: "Neo" });
    sock.fire("close");
    sock.fire("open");
    expect(statuses).toEqual(["connecting", "open", "reconnecting", "open"]);
  });

  it("validates server messages and records the welcome", () => {
    const { c, sock } = setup();
    const got: string[] = [];
    c.onMessageType((m) => got.push(m.type));
    sock.fire("message", { data: "garbage" });
    sock.fire("message", { data: JSON.stringify({ type: "players", players: [{ id: 1 }] }) });
    sock.fire("message", { data: JSON.stringify({ type: "welcome", selfId: "me", world, startedAt: 1000, players: [player("me"), player("p2")] }) });
    expect(got).toEqual(["welcome"]);
    expect(c.selfId).toBe("me");
    expect(c.welcome?.world.seed).toBe(5);
  });

  it("throttles state to 10Hz and only sends while open", () => {
    const { c, sock, setNow } = setup();
    const s = { x: 1.234, y: 2, hp: 1.5, score: 3.7, alive: true };
    expect(c.sendState(s)).toBe(false); // not open yet
    sock.fire("open");
    setNow(1000);
    expect(c.sendState(s)).toBe(true);
    setNow(1050);
    expect(c.sendState(s)).toBe(false);
    setNow(1100);
    expect(c.sendState(s)).toBe(true);
    const msg = JSON.parse(sock.sent.at(-1)!);
    expect(msg).toEqual({ type: "state", x: 1.2, y: 2, hp: 1, score: 4, alive: true });
  });

  it("sends telemetry and emotes", () => {
    const { c, sock } = setup();
    sock.fire("open");
    expect(c.sendTelemetry(telemetry())).toBe(true);
    expect(c.sendEmote("gg")).toBe(true);
    expect(sock.sent.map((s) => JSON.parse(s).type)).toEqual(["join", "telemetry", "emote"]);
  });

  it("close() detaches every listener and closes the socket", () => {
    const { c, sock } = setup();
    const statuses: string[] = [];
    c.onStatus((s) => statuses.push(s));
    c.close();
    expect(sock.closed).toBe(true);
    expect(sock.listenerCount()).toBe(0);
    expect(statuses.at(-1)).toBe("closed");
    expect(c.sendEmote("gg")).toBe(false);
  });
});

describe("room helpers", () => {
  it("filters self out of the ghost list", () => {
    expect(otherPlayers([player("a"), player("b")], "a").map((p) => p.id)).toEqual(["b"]);
    expect(otherPlayers([player("a")], null)).toHaveLength(1);
  });

  it("computes the late-join offset, clamped to leave time for the boss", () => {
    expect(roomStartOffset(10_000, 40_000, 300)).toBe(30);
    expect(roomStartOffset(50_000, 40_000, 300)).toBe(0);
    expect(roomStartOffset(0, 1_000_000, 300)).toBe(255);
  });
});
