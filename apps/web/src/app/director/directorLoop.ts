import type { Directive, DirectorRequest, DirectorResponse, Telemetry, WorldSpec } from "@bimpee/shared";

/**
 * The slow (AI) layer of the director, run from the browser.
 *
 *   solo: telemetry -> POST /api/director (one request in flight, max) ->
 *         directives. A slow/failed call falls back to the rule-based
 *         `localDirector` so a tick is never lost.
 *   room: telemetry goes to the room; the room runs ONE director for every
 *         member and broadcasts directives back (`onRoomDirectives`).
 *
 * Pure: the fetcher, local director and clock are injected so it is unit
 * tested without network or timers.
 */

export type DirectorSource = "claude" | "local" | "fallback" | "room";

export interface DirectorResult {
  directives: Directive[];
  reasoning: string;
  model: string;
  latencyMs: number;
  source: DirectorSource;
  note?: string;
  /** run clock (s) of the telemetry that triggered it (room: last telemetry seen) */
  t: number;
}

export interface DirectorStatsSnapshot {
  inFlight: boolean;
  requests: number;
  fallbacks: number;
  dropped: number;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export interface DirectorLoopDeps {
  world: WorldSpec;
  runId: string;
  mode: "solo" | "room";
  fetchDirector: (req: DirectorRequest, signal: AbortSignal) => Promise<DirectorResponse>;
  localDirector: (world: WorldSpec, t: Telemetry) => DirectorResponse;
  /** whether the backend is believed reachable; false => go local immediately */
  online: () => boolean;
  /** returns false when the room socket can't take it (then we decide locally) */
  sendToRoom?: (t: Telemetry) => boolean | void;
  onResult: (r: DirectorResult) => void;
  onStats?: (s: DirectorStatsSnapshot) => void;
  timeoutMs?: number;
  clock?: Clock;
}

export class DirectorLoop {
  private inFlight: { token: number; ctrl: AbortController; timer: unknown } | null = null;
  private token = 0;
  private disposed = false;
  private lastT = 0;
  private stats: DirectorStatsSnapshot = { inFlight: false, requests: 0, fallbacks: 0, dropped: 0 };
  private readonly clock: Clock;
  private readonly timeoutMs: number;

  constructor(private readonly deps: DirectorLoopDeps) {
    this.clock = deps.clock ?? realClock;
    this.timeoutMs = deps.timeoutMs ?? 9_000;
  }

  get busy() {
    return this.inFlight !== null;
  }

  snapshot(): DirectorStatsSnapshot {
    return { ...this.stats };
  }

  onTelemetry(tel: Telemetry): void {
    if (this.disposed) return;
    if (tel.runId !== this.deps.runId) {
      this.bump({ dropped: this.stats.dropped + 1 });
      return;
    }
    this.lastT = tel.t;

    if (this.deps.mode === "room") {
      if (this.deps.sendToRoom?.(tel) === false) this.emitLocal(tel, "fallback", "room disconnected: local director");
      return;
    }

    if (this.inFlight) {
      // Never stack requests: the next tick will carry fresher telemetry anyway.
      this.bump({ dropped: this.stats.dropped + 1 });
      return;
    }

    if (!this.deps.online()) {
      this.emitLocal(tel, "local");
      return;
    }

    const token = ++this.token;
    const ctrl = new AbortController();
    const started = this.clock.now();
    const timer = this.clock.setTimeout(() => {
      if (this.inFlight?.token !== token) return;
      ctrl.abort();
      this.finish(token);
      this.emitLocal(tel, "fallback", `director timed out after ${this.timeoutMs}ms`);
    }, this.timeoutMs);
    this.inFlight = { token, ctrl, timer };
    this.bump({ inFlight: true, requests: this.stats.requests + 1 });

    let p: Promise<DirectorResponse>;
    try {
      p = this.deps.fetchDirector({ world: this.deps.world, telemetry: tel }, ctrl.signal);
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      (res) => {
        if (!this.finish(token)) return; // timed out, superseded, or disposed
        this.deps.onResult({
          directives: res.directives,
          reasoning: res.reasoning,
          model: res.model,
          latencyMs: res.latencyMs || this.clock.now() - started,
          source: res.model === "local" ? "local" : "claude",
          t: tel.t,
        });
      },
      (err: unknown) => {
        if (!this.finish(token)) return;
        this.emitLocal(tel, "fallback", err instanceof Error ? err.message : "director request failed");
      },
    );
  }

  /** Room mode: directives broadcast by the room's shared director. */
  onRoomDirectives(msg: { directives: Directive[]; reasoning: string; model: string }): void {
    if (this.disposed) return;
    this.deps.onResult({ ...msg, latencyMs: 0, source: "room", t: this.lastT });
  }

  dispose(): void {
    this.disposed = true;
    if (this.inFlight) {
      this.clock.clearTimeout(this.inFlight.timer);
      this.inFlight.ctrl.abort();
      this.inFlight = null;
    }
  }

  /** Clears the in-flight slot if `token` still owns it. Returns false if the result is stale. */
  private finish(token: number): boolean {
    if (this.disposed || !this.inFlight || this.inFlight.token !== token) return false;
    this.clock.clearTimeout(this.inFlight.timer);
    this.inFlight = null;
    this.bump({ inFlight: false });
    return true;
  }

  private emitLocal(tel: Telemetry, source: "local" | "fallback", note?: string) {
    if (this.disposed) return;
    const res = this.deps.localDirector(this.deps.world, tel);
    if (source === "fallback") this.bump({ fallbacks: this.stats.fallbacks + 1 });
    this.deps.onResult({
      directives: res.directives,
      reasoning: res.reasoning,
      model: res.model,
      latencyMs: res.latencyMs,
      source,
      note,
      t: tel.t,
    });
  }

  private bump(p: Partial<DirectorStatsSnapshot>) {
    this.stats = { ...this.stats, ...p };
    this.deps.onStats?.(this.snapshot());
  }
}
