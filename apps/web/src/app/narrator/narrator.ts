import type { NarrateChunk, NarrateRequest, WorldSpec } from "@bimpee/shared";
import type { GameEvent } from "../../game/contract";
import type { SubtitleLine } from "../store/run";
import { crossedMilestone, NarrationGate, type NarrateTrigger } from "./gate";
import { cannedLine } from "./lines";

/**
 * Turns game events into narrator lines. Streams from /api/narrate when the
 * backend is up, falls back to canned lines otherwise. UI rendering
 * (typewriter, fade) lives in the Subtitles component; this only decides
 * WHAT is said and WHEN.
 */
export interface NarratorDeps {
  world: WorldSpec;
  stream: (req: NarrateRequest, signal: AbortSignal) => AsyncIterable<NarrateChunk>;
  online: () => boolean;
  setLine: (fn: (prev: SubtitleLine | null) => SubtitleLine | null) => void;
  /** called once a line is complete (TTS) */
  onLineDone?: (text: string) => void;
  /** stop any speech (on interrupt) */
  onInterrupt?: () => void;
  now?: () => number;
  rand?: () => number;
  minGapMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

const EVENT_TRIGGERS: Partial<Record<GameEvent["kind"], NarrateTrigger>> = {
  run_start: "run_start",
  act_change: "act_change",
  boss_spawn: "boss_spawn",
  boss_defeated: "boss_defeated",
  near_death: "near_death",
  death: "death",
  victory: "victory",
};

/** Approximate time a line stays on screen (typewriter + reading). */
export const readTimeMs = (text: string) => 1800 + text.length * 45;

let lineSeq = 1;

export class Narrator {
  private gate: NarrationGate;
  private current: { id: number; ctrl: AbortController } | null = null;
  private kills = 0;
  private busyUntil = 0;
  private pending: { line: string; mood: string } | null = null;
  private pendingTimer: unknown = null;
  private disposed = false;
  private readonly now: () => number;
  private readonly rand: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (id: unknown) => void;

  constructor(private readonly deps: NarratorDeps) {
    this.gate = new NarrationGate(deps.minGapMs ?? 10_000);
    this.now = deps.now ?? (() => Date.now());
    this.rand = deps.rand ?? Math.random;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  }

  get streaming() {
    return this.current !== null;
  }

  onGameEvent(ev: GameEvent): void {
    if (this.disposed) return;
    if (ev.kind === "kill" || ev.kind === "elite_kill") {
      const before = this.kills;
      this.kills++;
      const m = crossedMilestone(before, this.kills);
      if (m !== null) this.trigger("milestone", `${m} kills reached at ${Math.round(ev.t)}s. ${ev.text}`, { n: m });
      return;
    }
    const trigger = EVENT_TRIGGERS[ev.kind];
    if (!trigger) return;
    const actName = trigger === "act_change" ? ev.text : undefined;
    this.trigger(trigger, `${ev.text} (t=${Math.round(ev.t)}s)`, { act: actName });
  }

  /** Narration requested by the director (`narrate` directive). Never interrupts a line mid-stream. */
  sayDirect(line: string, mood: string): void {
    if (this.disposed || !line.trim()) return;
    const now = this.now();
    if (this.current || now < this.busyUntil) {
      this.pending = { line, mood };
      this.schedulePending();
      return;
    }
    this.show(line, "director", mood);
  }

  /** Returns the decision taken, for tests/telemetry. */
  trigger(trigger: NarrateTrigger, context: string, vars: { act?: string; n?: number } = {}): "start" | "interrupt" | "drop" {
    if (this.disposed) return "drop";
    const now = this.now();
    const decision = this.gate.decide(trigger, now, this.streaming);
    if (decision === "drop") return decision;
    if (decision === "interrupt") this.abortCurrent();
    this.gate.started(now);
    if (!this.deps.online()) {
      this.show(cannedLine(this.deps.world, trigger, vars, this.rand), "canned");
      return decision;
    }
    void this.streamLine(trigger, context.slice(0, 400), vars);
    return decision;
  }

  dispose(): void {
    this.disposed = true;
    this.abortCurrent();
    if (this.pendingTimer !== null) this.clearTimer(this.pendingTimer);
    this.pendingTimer = null;
    this.pending = null;
  }

  private show(text: string, source: SubtitleLine["source"], mood?: string) {
    const id = lineSeq++;
    this.deps.onInterrupt?.();
    this.deps.setLine(() => ({ id, text, done: true, source, mood }));
    this.busyUntil = this.now() + readTimeMs(text);
    this.deps.onLineDone?.(text);
  }

  private async streamLine(trigger: NarrateTrigger, context: string, vars: { act?: string; n?: number }) {
    const id = lineSeq++;
    const ctrl = new AbortController();
    this.current = { id, ctrl };
    this.deps.onInterrupt?.();
    let text = "";
    let failed = false;
    this.deps.setLine(() => ({ id, text: "", done: false, source: "stream" }));
    try {
      for await (const chunk of this.deps.stream({ world: this.deps.world, trigger, context }, ctrl.signal)) {
        if (this.current?.id !== id) return; // interrupted
        if ("error" in chunk) {
          failed = true;
          break;
        }
        if ("done" in chunk) break;
        text += chunk.text;
        const snapshot = text;
        this.deps.setLine((prev) => (prev?.id === id ? { ...prev, text: snapshot } : prev));
      }
    } catch {
      failed = true;
    }
    if (this.current?.id !== id || this.disposed) return;
    this.current = null;
    if (failed || !text.trim()) {
      // Replace the empty/broken line with a canned one, same id so the UI doesn't flicker twice.
      text = text.trim() ? text : cannedLine(this.deps.world, trigger, vars, this.rand);
    }
    const final = text.trim();
    this.deps.setLine((prev) => (prev?.id === id || prev === null ? { id, text: final, done: true, source: "stream" } : prev));
    this.busyUntil = this.now() + readTimeMs(final);
    this.deps.onLineDone?.(final);
    if (this.pending) this.schedulePending();
  }

  private schedulePending() {
    if (this.pendingTimer !== null || this.current) return;
    const wait = Math.max(0, this.busyUntil - this.now());
    this.pendingTimer = this.setTimer(() => {
      this.pendingTimer = null;
      const p = this.pending;
      this.pending = null;
      if (p && !this.disposed) this.sayDirect(p.line, p.mood);
    }, wait);
  }

  private abortCurrent() {
    if (!this.current) return;
    this.current.ctrl.abort();
    this.current = null;
  }
}
