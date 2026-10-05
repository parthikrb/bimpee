import { createStore, useStore } from "zustand";
import type { RunReport, WorldSpec } from "@bimpee/shared";

/**
 * The screen state machine. Every async continuation carries a token
 * (forge `requestId`, `runId`) and the reducers drop anything stale, so a
 * world that arrives after the player navigated away can never yank them
 * back into a screen.
 */
export type Screen = "title" | "forge" | "play" | "results";

export type Mode = { kind: "solo" } | { kind: "room"; roomId: string; daily: boolean };

export type WorldSource = "claude" | "fallback" | "room" | "offline";

export interface ForgedWorld {
  world: WorldSpec;
  source: WorldSource;
  model: string;
  latencyMs: number;
  /** room only: epoch ms of the shared run clock */
  roomStartedAt?: number;
  /** why we fell back, shown subtly on the reveal */
  note?: string;
}

export interface ForgeState {
  status: "loading" | "ready" | "error";
  requestId: number;
  forged: ForgedWorld | null;
  error: string | null;
}

export interface RunInfo {
  runId: string;
  world: WorldSpec;
  source: WorldSource;
  players: number;
  startOffsetSec: number;
}

export interface Reflection {
  summary: string;
  epitaph: string;
  bestScore: number;
  rank: number | null;
  source: "claude" | "local";
}

export interface ResultsState {
  runId: string;
  world: WorldSpec;
  report: RunReport;
  reflection: Reflection | null;
}

export interface AppState {
  screen: Screen;
  mode: Mode;
  wish: string;
  forge: ForgeState | null;
  run: RunInfo | null;
  results: ResultsState | null;
  /** bumps when the title wish box should grab focus ("New Wish") */
  focusWishNonce: number;

  setWish(w: string): void;
  /** title/results -> forge(loading). Returns the request token. */
  beginForge(mode: Mode, wish?: string): number;
  /** forge(loading) -> forge(ready). Ignored if stale. */
  forgeResolved(requestId: number, forged: ForgedWorld): boolean;
  forgeFailed(requestId: number, error: string): boolean;
  /** results -> forge(ready) instantly with a prefetched world. */
  showForged(mode: Mode, forged: ForgedWorld): number;
  /** forge(ready) -> play */
  startRun(runId: string, opts: { players: number; startOffsetSec: number }): boolean;
  /** play -> results. Ignored if not the current run. */
  endRun(report: RunReport): boolean;
  reflectionResolved(runId: string, r: Reflection): boolean;
  toTitle(opts?: { focusWish?: boolean }): void;
}

export function createAppStore() {
  let nextRequest = 1;
  return createStore<AppState>()((set, get) => ({
    screen: "title",
    mode: { kind: "solo" },
    wish: "",
    forge: null,
    run: null,
    results: null,
    focusWishNonce: 0,

    setWish: (wish) => set({ wish: wish.slice(0, 200) }),

    beginForge(mode, wish) {
      const requestId = nextRequest++;
      set({
        screen: "forge",
        mode,
        wish: wish !== undefined ? wish.slice(0, 200) : get().wish,
        forge: { status: "loading", requestId, forged: null, error: null },
        run: null,
      });
      return requestId;
    },

    forgeResolved(requestId, forged) {
      const { screen, forge } = get();
      if (screen !== "forge" || !forge || forge.requestId !== requestId || forge.status !== "loading") return false;
      set({ forge: { ...forge, status: "ready", forged, error: null } });
      return true;
    },

    forgeFailed(requestId, error) {
      const { screen, forge } = get();
      if (screen !== "forge" || !forge || forge.requestId !== requestId) return false;
      set({ forge: { ...forge, status: "error", error } });
      return true;
    },

    showForged(mode, forged) {
      const requestId = nextRequest++;
      set({ screen: "forge", mode, forge: { status: "ready", requestId, forged, error: null }, run: null });
      return requestId;
    },

    startRun(runId, opts) {
      const { screen, forge } = get();
      if (screen !== "forge" || forge?.status !== "ready" || !forge.forged) return false;
      set({
        screen: "play",
        run: {
          runId,
          world: forge.forged.world,
          source: forge.forged.source,
          players: Math.max(1, opts.players),
          startOffsetSec: Math.max(0, opts.startOffsetSec),
        },
        results: null,
      });
      return true;
    },

    endRun(report) {
      const { screen, run } = get();
      if (screen !== "play" || !run || run.runId !== report.runId) return false;
      set({ screen: "results", results: { runId: run.runId, world: run.world, report, reflection: null } });
      return true;
    },

    reflectionResolved(runId, reflection) {
      const { results } = get();
      if (!results || results.runId !== runId) return false;
      set({ results: { ...results, reflection } });
      return true;
    },

    toTitle(opts) {
      set((s) => ({
        screen: "title",
        forge: null,
        run: null,
        focusWishNonce: opts?.focusWish ? s.focusWishNonce + 1 : s.focusWishNonce,
      }));
    },
  }));
}

export type AppStore = ReturnType<typeof createAppStore>;
export const appStore = createAppStore();
export function useApp<T>(selector: (s: AppState) => T): T {
  return useStore(appStore, selector);
}
