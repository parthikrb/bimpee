import {
  ClientMsgSchema,
  ROOM_ID_RE,
  generateFallbackWorld,
  hashSeed,
  localDirector,
  runStartOfAct,
  type Directive,
  type DirectorResponse,
  type RoomPlayer,
  type ServerMsg,
  type Telemetry,
  type WorldResponse,
  type WorldSpec,
} from "@bimpee/shared";
import { errMsg, log } from "../config";
import { sanitizeDisplayName } from "../ai/untrusted";
import type { AiService } from "../ai/types";

/** Transport-agnostic connection handle (partyserver Connection in prod, fakes in tests). */
export interface RoomConn {
  readonly id: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface RoomDeps {
  ai: Pick<AiService, "generateWorld" | "director">;
  now?: () => number;
  timers?: Timers;
  /** Cost guard for AI calls made by this room; when it says no, local fallbacks are used. */
  allowAi?: () => Promise<boolean>;
  maxPlayers?: number;
  broadcastMs?: number;
  directorMs?: number;
  /** How long an empty room keeps its world, so a solo player's reconnect resumes the same run. */
  resetGraceMs?: number;
  worldTimeoutMs?: number;
}

interface Member {
  conn: RoomConn;
  joined: boolean;
  player: RoomPlayer;
  telemetry: Telemetry | null;
}

export const MAX_PLAYERS = 8;
const MAX_MESSAGE_BYTES = 16 * 1024;
const EMOTE_COOLDOWN_MS = 750;

const defaultTimers: Timers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

/**
 * Shared-world room logic, free of any Durable Object / partyserver import so
 * it can be unit tested. One instance per room id.
 */
export class RoomCore {
  readonly valid: boolean;
  private members = new Map<string, Member>();
  private world: WorldSpec | null = null;
  private worldPromise: Promise<WorldSpec> | null = null;
  private startedAt = 0;
  private generation = 0;
  private bossSpawned = false;
  private recentDirectives: string[] = [];
  private freshTelemetry = false;
  private directorBusy = false;
  private dirty = false;
  private lastEmote = new Map<string, number>();
  private emptySince: number | null = null;
  private broadcastTimer: unknown = null;
  private directorTimer: unknown = null;

  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly maxPlayers: number;

  constructor(
    readonly roomId: string,
    private readonly deps: RoomDeps,
  ) {
    this.valid = ROOM_ID_RE.test(roomId);
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? defaultTimers;
    this.maxPlayers = deps.maxPlayers ?? MAX_PLAYERS;
  }

  get size() {
    return this.members.size;
  }
  get currentWorld() {
    return this.world;
  }
  get currentGeneration() {
    return this.generation;
  }

  private send(conn: RoomConn, msg: ServerMsg) {
    try {
      conn.send(JSON.stringify(msg));
    } catch {
      /* socket already closing */
    }
  }

  private broadcast(msg: ServerMsg, onlyJoined = true) {
    const data = JSON.stringify(msg);
    for (const m of this.members.values()) {
      if (onlyJoined && !m.joined) continue;
      try {
        m.conn.send(data);
      } catch {
        /* ignore */
      }
    }
  }

  private reject(conn: RoomConn, message: string, code = 1008) {
    this.send(conn, { type: "error", message });
    conn.close(code, message.slice(0, 120));
  }

  connect(conn: RoomConn) {
    if (!this.valid) return this.reject(conn, "invalid room id");
    if (this.members.size === 0 && this.emptySince !== null) {
      if (this.now() - this.emptySince >= (this.deps.resetGraceMs ?? 60_000)) this.reset();
      this.emptySince = null;
    }
    // Same id again (partysocket reuses its id on reconnect): the new socket replaces the old,
    // which may not have been reported closed yet. Its late close/messages are ignored below.
    const stale = this.members.get(conn.id);
    if (stale && stale.conn !== conn) {
      this.members.delete(conn.id);
      try {
        stale.conn.close(1000, "replaced by a new connection");
      } catch {
        /* already closed */
      }
      if (stale.joined) this.dirty = true;
    }
    if (this.members.size >= this.maxPlayers) return this.reject(conn, `room is full (max ${this.maxPlayers} players)`);
    this.members.set(conn.id, {
      conn,
      joined: false,
      telemetry: null,
      player: { id: conn.id, name: "Wanderer", x: 0, y: 0, hp: 1, score: 0, alive: true },
    });
  }

  /** `conn`, when given, must be the member's current socket (a replaced socket's close is ignored). */
  disconnect(id: string, conn?: RoomConn) {
    const m = this.members.get(id);
    if (!m || (conn && m.conn !== conn)) return;
    this.members.delete(id);
    this.lastEmote.delete(id);
    if (this.members.size === 0) {
      // Keep the world for a grace period (network blips); the next connect after it resets.
      this.emptySince = this.now();
      this.stopTimers();
      return;
    }
    if (m.joined) {
      this.broadcast({ type: "left", id });
      this.dirty = true;
    }
  }

  /** Room stayed empty past the grace period: forget everything so the next group gets a fresh world. */
  private reset() {
    this.generation++;
    this.world = null;
    this.worldPromise = null;
    this.startedAt = 0;
    this.bossSpawned = false;
    this.recentDirectives = [];
    this.freshTelemetry = false;
    this.dirty = false;
    this.stopTimers();
  }

  private stopTimers() {
    if (this.broadcastTimer !== null) this.timers.clearInterval(this.broadcastTimer);
    if (this.directorTimer !== null) this.timers.clearInterval(this.directorTimer);
    this.broadcastTimer = this.directorTimer = null;
  }

  private startTimers() {
    if (this.broadcastTimer === null) this.broadcastTimer = this.timers.setInterval(() => this.flushPlayers(), this.deps.broadcastMs ?? 100);
    if (this.directorTimer === null) this.directorTimer = this.timers.setInterval(() => void this.directorTick(), this.deps.directorMs ?? 20_000);
  }

  get timersRunning() {
    return this.broadcastTimer !== null || this.directorTimer !== null;
  }

  private joinedPlayers(): RoomPlayer[] {
    return [...this.members.values()].filter((m) => m.joined).map((m) => ({ ...m.player }));
  }

  /** Broadcasts positions if anything changed since the last flush (driven at 10 Hz). */
  flushPlayers() {
    if (!this.dirty) return;
    this.dirty = false;
    this.broadcast({ type: "players", players: this.joinedPlayers() });
  }

  async message(id: string, raw: string | null, conn?: RoomConn) {
    const m = this.members.get(id);
    if (!m || (conn && m.conn !== conn)) return;
    if (raw === null || raw.length > MAX_MESSAGE_BYTES) return this.send(m.conn, { type: "error", message: "message too large or not text" });
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return this.send(m.conn, { type: "error", message: "invalid JSON" });
    }
    const p = ClientMsgSchema.safeParse(json);
    if (!p.success) return this.send(m.conn, { type: "error", message: `invalid message: ${p.error.issues[0]?.message ?? ""}`.slice(0, 160) });
    const msg = p.data;

    if (msg.type === "join") return this.join(m, msg.name);
    if (!m.joined) return this.send(m.conn, { type: "error", message: "send join first" });

    switch (msg.type) {
      case "state": {
        const fin = (v: number, prev: number) => (Number.isFinite(v) ? Math.max(-1e6, Math.min(1e6, v)) : prev);
        m.player = { ...m.player, x: fin(msg.x, m.player.x), y: fin(msg.y, m.player.y), hp: msg.hp, score: msg.score, alive: msg.alive };
        this.dirty = true;
        return;
      }
      case "telemetry":
        m.telemetry = msg.telemetry;
        this.freshTelemetry = true;
        return;
      case "emote": {
        const t = this.now();
        if (t - (this.lastEmote.get(id) ?? 0) < EMOTE_COOLDOWN_MS) return;
        this.lastEmote.set(id, t);
        this.broadcast({ type: "emote", from: id, name: m.player.name, emote: msg.emote });
        return;
      }
    }
  }

  private async join(m: Member, rawName: string) {
    if (m.joined) return this.send(m.conn, { type: "error", message: "already joined" });
    m.player.name = sanitizeDisplayName(rawName) ?? "Wanderer";
    const gen = this.generation;
    let world: WorldSpec;
    try {
      world = await this.ensureWorld();
    } catch (e) {
      log.error(`[room ${this.roomId}] world creation failed: ${errMsg(e)}`);
      world = this.adoptWorld(generateFallbackWorld(this.seed()));
    }
    // The member may have left (or the room reset) while the world was being made.
    if (gen !== this.generation || this.members.get(m.conn.id) !== m) return;
    m.joined = true;
    this.send(m.conn, { type: "welcome", selfId: m.conn.id, world, startedAt: this.startedAt, players: this.joinedPlayers() });
    this.dirty = true;
    this.startTimers();
  }

  private seed() {
    return hashSeed(`${this.roomId}:${this.generation}`);
  }

  private adoptWorld(w: WorldSpec): WorldSpec {
    if (!this.world) {
      this.world = w;
      this.startedAt = this.now();
    }
    return this.world;
  }

  private ensureWorld(): Promise<WorldSpec> {
    if (this.world) return Promise.resolve(this.world);
    if (this.worldPromise) return this.worldPromise;
    const gen = this.generation;
    const seed = this.seed();
    const p = (async () => {
      let res: WorldResponse | null = null;
      if (!this.deps.allowAi || (await this.deps.allowAi())) {
        res = await this.deps.ai.generateWorld({ memory: null, seed, timeoutMs: this.deps.worldTimeoutMs ?? 20_000 });
      }
      const w = res?.world ?? generateFallbackWorld(seed);
      if (gen !== this.generation) return w; // room was reset meanwhile; caller discards
      return this.adoptWorld({ ...w, seed });
    })();
    this.worldPromise = p;
    p.catch(() => {
      if (this.worldPromise === p) this.worldPromise = null;
    });
    return p;
  }

  /** Current act from the room clock. */
  actAt(world: WorldSpec, tSec: number): number {
    for (let a = 2; a >= 0; a--) if (tSec >= runStartOfAct(world, a)) return a;
    return 0;
  }

  /** Builds one group telemetry from the latest per-player telemetry. Null when nobody has reported. */
  aggregate(): Telemetry | null {
    const world = this.world;
    const ts = [...this.members.values()].filter((m) => m.joined && m.telemetry).map((m) => m.telemetry!);
    if (!world || ts.length === 0) return null;
    const t = Math.max(0, (this.now() - this.startedAt) / 1000);
    const act = this.actAt(world, t);
    const sum = (f: (x: Telemetry) => number) => ts.reduce((s, x) => s + f(x), 0);
    const avg = (f: (x: Telemetry) => number) => sum(f) / ts.length;
    const max = (f: (x: Telemetry) => number) => Math.max(...ts.map(f));
    const min = (f: (x: Telemetry) => number) => Math.min(...ts.map(f));
    const weakest = ts.reduce((a, b) => (b.player.hpFraction < a.player.hpFraction ? b : a));
    const hottest = ts.reduce((a, b) => (b.intensity > a.intensity ? b : a));
    const events = [...new Set(ts.flatMap((x) => x.recentEvents))].slice(-12);
    return {
      runId: `${this.roomId}:${this.generation}`,
      t,
      act,
      intensity: max((x) => x.intensity),
      intensityTarget: world.arc[act]?.intensityTarget ?? avg((x) => x.intensityTarget),
      phase: hottest.phase,
      player: {
        hpFraction: min((x) => x.player.hpFraction),
        level: Math.max(1, Math.round(avg((x) => x.player.level))),
        weapon: weakest.player.weapon,
        accuracy: avg((x) => x.player.accuracy),
        damageTaken: sum((x) => x.player.damageTaken),
        kills: sum((x) => x.player.kills),
        nearMisses: sum((x) => x.player.nearMisses),
        idleRatio: avg((x) => x.player.idleRatio),
        score: sum((x) => x.player.score),
      },
      enemiesAlive: max((x) => x.enemiesAlive),
      bossActive: ts.some((x) => x.bossActive),
      recentEvents: events,
      recentDirectives: this.recentDirectives.slice(-8),
      fps: min((x) => x.fps),
      players: this.joinedPlayers().length,
    };
  }

  /** One director for the whole room. Runs on the director interval; exposed for tests. */
  async directorTick(): Promise<Directive[] | null> {
    if (!this.freshTelemetry || this.directorBusy || !this.world) return null;
    const agg = this.aggregate();
    if (!agg) return null;
    this.freshTelemetry = false;
    this.directorBusy = true;
    const gen = this.generation;
    const world = this.world;
    try {
      let res: DirectorResponse;
      try {
        res = !this.deps.allowAi || (await this.deps.allowAi()) ? await this.deps.ai.director(world, agg, null) : localDirector(world, agg);
      } catch (e) {
        log.error(`[room ${this.roomId}] director failed: ${errMsg(e)}`);
        res = localDirector(world, agg);
      }
      if (gen !== this.generation) return null;
      const directives = res.directives.filter((d) => {
        if (d.tool !== "spawn_boss") return true;
        if (this.bossSpawned) return false;
        this.bossSpawned = true;
        return true;
      });
      if (directives.length === 0) return [];
      this.recentDirectives = [...this.recentDirectives, ...directives.map((d) => d.tool)].slice(-8);
      this.broadcast({ type: "directives", directives, reasoning: res.reasoning.slice(0, 400), model: res.model });
      return directives;
    } finally {
      this.directorBusy = false;
    }
  }

  /** For shutdown / tests. */
  dispose() {
    this.stopTimers();
  }
}
