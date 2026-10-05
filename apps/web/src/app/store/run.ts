import { createStore, useStore } from "zustand";
import type { Directive, PacingOutput, RoomPlayer } from "@bimpee/shared";
import type { HudState, UpgradeOption } from "../../game/contract";

/** Live, per-run state for the overlays. Reset on every run. */

export interface PacingSample {
  t: number;
  intensity: number;
  target: number;
}

export type DirectiveStatus = "pending" | "ok" | "rejected";

export interface DirectorLogEntry {
  id: number;
  /** run clock (s) when the response arrived */
  t: number;
  model: string;
  latencyMs: number;
  reasoning: string;
  source: "claude" | "local" | "fallback" | "room";
  /** why we fell back to the local director, if we did */
  note?: string;
  directives: { directive: Directive; status: DirectiveStatus; note?: string }[];
}

export interface BannerItem {
  id: number;
  text: string;
  tone: "info" | "danger" | "boon";
}

export interface SubtitleLine {
  id: number;
  text: string;
  done: boolean;
  source: "stream" | "canned" | "director";
  mood?: string;
}

export interface EmoteToast {
  id: number;
  name: string;
  emote: string;
  self: boolean;
}

export type RoomStatus = "connecting" | "open" | "reconnecting" | "closed" | "offline";

export interface DirectorStats {
  inFlight: boolean;
  requests: number;
  fallbacks: number;
  dropped: number;
}

export interface ActCard {
  id: number;
  act: number;
  name: string;
  beat: string;
}

const HISTORY_SEC = 90;
const SAMPLE_EVERY = 0.5;
const MAX_LOG = 40;
const MAX_BANNERS = 3;
const MAX_EMOTES = 4;

export interface RunLiveState {
  runId: string | null;
  hud: HudState | null;
  pacing: PacingOutput | null;
  history: PacingSample[];
  bossMaxHp: number;
  banners: BannerItem[];
  subtitle: SubtitleLine | null;
  upgradeOffer: UpgradeOption[] | null;
  paused: boolean;
  ghosts: RoomPlayer[];
  emotes: EmoteToast[];
  roomStatus: RoomStatus | null;
  directorLog: DirectorLogEntry[];
  director: DirectorStats;
  actCard: ActCard | null;

  reset(runId: string | null): void;
  setHud(h: HudState, actInfo?: (act: number) => { name: string; beat: string }): void;
  pushPacing(p: PacingOutput): void;
  pushBanner(text: string, tone: BannerItem["tone"]): void;
  dismissBanner(id: number): void;
  setSubtitle(fn: (prev: SubtitleLine | null) => SubtitleLine | null): void;
  setOffer(o: UpgradeOption[] | null): void;
  setPaused(p: boolean): void;
  setGhosts(g: RoomPlayer[]): void;
  pushEmote(e: Omit<EmoteToast, "id">): void;
  dismissEmote(id: number): void;
  setRoomStatus(s: RoomStatus | null): void;
  logDirector(e: Omit<DirectorLogEntry, "id">): void;
  markDirective(d: Directive, ok: boolean, note?: string): void;
  setDirectorStats(p: Partial<DirectorStats>): void;
}

let seq = 1;
const nextId = () => seq++;

const initial = () => ({
  runId: null as string | null,
  hud: null,
  pacing: null,
  history: [] as PacingSample[],
  bossMaxHp: 0,
  banners: [] as BannerItem[],
  subtitle: null,
  upgradeOffer: null,
  paused: false,
  ghosts: [] as RoomPlayer[],
  emotes: [] as EmoteToast[],
  roomStatus: null,
  directorLog: [] as DirectorLogEntry[],
  director: { inFlight: false, requests: 0, fallbacks: 0, dropped: 0 },
  actCard: null,
});

const sameDirective = (a: Directive, b: Directive) => a.tool === b.tool && JSON.stringify(a) === JSON.stringify(b);

export function createRunStore() {
  return createStore<RunLiveState>()((set, get) => ({
    ...initial(),

    reset: (runId) => set({ ...initial(), runId }),

    setHud(h, actInfo) {
      const prev = get().hud;
      const patch: Partial<RunLiveState> = { hud: h };
      if (h.bossName && h.bossHp !== null) {
        const prevMax = prev?.bossName === h.bossName ? get().bossMaxHp : 0;
        patch.bossMaxHp = Math.max(prevMax, h.bossHp);
      } else if (!h.bossName) patch.bossMaxHp = 0;
      if (!prev || prev.act !== h.act) {
        const info = actInfo?.(h.act);
        patch.actCard = { id: nextId(), act: h.act, name: info?.name ?? h.actName, beat: info?.beat ?? "" };
      }
      set(patch);
    },

    pushPacing(p) {
      const { history, hud } = get();
      const t = hud?.t ?? (history.length ? history[history.length - 1]!.t + 0.25 : 0);
      const last = history[history.length - 1];
      if (last && t - last.t < SAMPLE_EVERY && t >= last.t) {
        set({ pacing: p });
        return;
      }
      // Run clock went backwards (new run / offset): start fresh.
      const base = last && t < last.t ? [] : history;
      const cutoff = t - HISTORY_SEC;
      const next = base.filter((s) => s.t >= cutoff);
      next.push({ t, intensity: p.intensity, target: p.target });
      set({ pacing: p, history: next });
    },

    pushBanner(text, tone) {
      const b = { id: nextId(), text, tone };
      set((s) => ({ banners: [...s.banners, b].slice(-MAX_BANNERS) }));
    },
    dismissBanner: (id) => set((s) => ({ banners: s.banners.filter((b) => b.id !== id) })),

    setSubtitle: (fn) => set((s) => ({ subtitle: fn(s.subtitle) })),
    setOffer: (upgradeOffer) => set({ upgradeOffer }),
    setPaused: (paused) => set({ paused }),
    setGhosts: (ghosts) => set({ ghosts }),
    pushEmote: (e) => set((s) => ({ emotes: [...s.emotes, { ...e, id: nextId() }].slice(-MAX_EMOTES) })),
    dismissEmote: (id) => set((s) => ({ emotes: s.emotes.filter((e) => e.id !== id) })),
    setRoomStatus: (roomStatus) => set({ roomStatus }),

    logDirector: (e) => set((s) => ({ directorLog: [{ ...e, id: nextId() }, ...s.directorLog].slice(0, MAX_LOG) })),

    markDirective(d, ok, note) {
      const log = get().directorLog;
      for (let i = 0; i < log.length; i++) {
        const entry = log[i]!;
        const j = entry.directives.findIndex((x) => x.status === "pending" && sameDirective(x.directive, d));
        if (j === -1) continue;
        const directives = entry.directives.slice();
        directives[j] = { ...directives[j]!, status: ok ? "ok" : "rejected", note };
        const next = log.slice();
        next[i] = { ...entry, directives };
        set({ directorLog: next });
        return;
      }
    },

    setDirectorStats: (p) => set((s) => ({ director: { ...s.director, ...p } })),
  }));
}

export const runStore = createRunStore();
export function useRun<T>(selector: (s: RunLiveState) => T): T {
  return useStore(runStore, selector);
}
