import { createStore, useStore } from "zustand";
import { readJson, writeJson } from "../lib/storage";

export interface Settings {
  /** master mute (music + sfx) */
  muted: boolean;
  music: boolean;
  /** master volume 0..1 */
  volume: number;
  sfx: boolean;
  tts: boolean;
  debugOpen: boolean;
  subtitles: boolean;
}

const DEFAULTS: Settings = { muted: false, music: true, volume: 0.7, sfx: true, tts: false, debugOpen: false, subtitles: true };

function load(): Settings {
  const raw = readJson<Partial<Settings>>("settings", {});
  const out: Settings = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    const v = raw[k];
    if (typeof v === typeof DEFAULTS[k]) (out as unknown as Record<string, unknown>)[k] = v;
  }
  out.volume = Math.min(1, Math.max(0, out.volume));
  return out;
}

export interface SettingsState extends Settings {
  set<K extends keyof Settings>(k: K, v: Settings[K]): void;
  toggle(k: "muted" | "music" | "sfx" | "tts" | "debugOpen" | "subtitles"): void;
}

export const settingsStore = createStore<SettingsState>()((set, get) => {
  const persist = () => {
    const { set: _s, toggle: _t, ...rest } = get();
    writeJson("settings", rest);
  };
  return {
    ...load(),
    set(k, v) {
      set({ [k]: v } as Partial<SettingsState>);
      persist();
    },
    toggle(k) {
      set({ [k]: !get()[k] } as Partial<SettingsState>);
      persist();
    },
  };
});

export function useSettings<T>(selector: (s: SettingsState) => T): T {
  return useStore(settingsStore, selector);
}
