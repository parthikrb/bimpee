import type { WorldSpec } from "@bimpee/shared";
import { settingsStore } from "../store/settings";
import type { SfxKind } from "./engine";

/**
 * Facade over the lazily-loaded Tone engine. Safe to call anything at any
 * time: before the engine is loaded/unlocked calls are no-ops (the latest
 * world/pacing is remembered and applied once audio starts).
 */
type Engine = typeof import("./engine");

let engine: Engine | null = null;
let loading: Promise<Engine> | null = null;
let unlocked = false;
let wantedWorld: WorldSpec | null = null;
let settingsUnsub: (() => void) | null = null;

export function preloadAudio(): Promise<Engine> {
  // Note: importing Tone creates a (suspended) AudioContext up front. That is
  // deliberate: resuming an existing context inside the click is what Safari
  // needs, so we preload on the forge screen and only *start* on "Start run".
  loading ??= import("./engine").then(
    (m) => {
      engine = m;
      syncSettings();
      settingsUnsub ??= settingsStore.subscribe(syncSettings);
      return m;
    },
    (e: unknown) => {
      loading = null; // allow a retry (e.g. chunk failed on a flaky network)
      throw e;
    },
  );
  return loading;
}

function syncSettings() {
  const s = settingsStore.getState();
  engine?.applySettings({ volume: s.volume, muted: s.muted, music: s.music, sfx: s.sfx });
}

/**
 * Call synchronously inside a click/keydown handler. If the engine chunk is
 * already loaded (we preload it on the forge screen) `Tone.start()` runs
 * inside the gesture, which Safari requires.
 */
export function unlockAudio(): Promise<boolean> {
  const go = async (m: Engine) => {
    try {
      await m.unlock();
      unlocked = true;
      if (wantedWorld) m.setWorld(wantedWorld);
      return true;
    } catch {
      return false;
    }
  };
  if (engine) return go(engine);
  return preloadAudio().then(go, () => false);
}

export const audio = {
  get unlocked() {
    return unlocked;
  },
  /** Builds the adaptive soundtrack for a world (null = silence + dispose). */
  setWorld(world: WorldSpec | null) {
    wantedWorld = world;
    if (unlocked) engine?.setWorld(world);
  },
  setPacing(energy: number, tension: number) {
    if (unlocked) engine?.setPacing(energy, tension);
  },
  setBoss(on: boolean) {
    if (unlocked) engine?.setBoss(on);
  },
  death() {
    if (unlocked) engine?.death();
  },
  victory() {
    if (unlocked) engine?.victory();
  },
  sfx(kind: SfxKind) {
    if (unlocked) engine?.sfx(kind);
  },
  stop() {
    wantedWorld = null;
    if (unlocked) engine?.stopAll();
  },
};

export type { SfxKind };
