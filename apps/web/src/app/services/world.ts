import { generateFallbackWorld, hashSeed, randomSeed, sanitizeWorldSpec } from "@bimpee/shared";
import { api, ApiError } from "../api";
import { backendUp } from "../store/profile";
import type { ForgedWorld } from "../store/app";
import { ensureHealth, reportNetworkFailure } from "./connectivity";

/** Asks Claude (via the worker) for a world; any failure degrades to the local generator. */
export async function forgeSoloWorld(wish: string, signal?: AbortSignal): Promise<ForgedWorld> {
  const cleanWish = wish.trim().slice(0, 200) || undefined;
  await ensureHealth();
  if (!backendUp()) return offlineWorld(randomSeed(), "AI offline: forged locally");
  const started = performance.now();
  try {
    const res = await api.world({ wish: cleanWish }, signal);
    // Belt and braces: the worker validates, but never trust the wire.
    const world = sanitizeWorldSpec(res.world);
    if (!world) throw new ApiError("parse", "world failed validation");
    return { world, source: res.source, model: res.model, latencyMs: res.latencyMs || Math.round(performance.now() - started) };
  } catch (e) {
    if (e instanceof ApiError && e.kind === "aborted") throw e;
    if (e instanceof ApiError && e.kind === "network") reportNetworkFailure();
    const why = e instanceof ApiError ? (e.kind === "timeout" ? "Claude took too long" : "the forge hiccupped") : "the forge hiccupped";
    return offlineWorld(randomSeed(), `${why}: forged locally`);
  }
}

export function offlineWorld(seed: number, note?: string): ForgedWorld {
  return { world: generateFallbackWorld(seed), source: "offline", model: "local", latencyMs: 0, note };
}

/** Room world when the room server is unreachable: deterministic from the room id so friends still share it. */
export function offlineRoomWorld(roomId: string): ForgedWorld {
  return { ...offlineWorld(hashSeed(roomId), "Room server unreachable: shared seed, solo run"), source: "offline" };
}

/**
 * Next-world prefetch. While a run is playing we forge the next world in the
 * background so "Play again" is instant. One slot, keyed by wish.
 */
interface Slot {
  wish: string;
  promise: Promise<ForgedWorld>;
  value: ForgedWorld | null;
  ctrl: AbortController;
}
let slot: Slot | null = null;

export function prefetchNextWorld(wish: string) {
  const w = wish.trim();
  if (slot && slot.wish === w) return;
  slot?.ctrl.abort();
  const ctrl = new AbortController();
  const s: Slot = { wish: w, ctrl, value: null, promise: Promise.resolve(null as unknown as ForgedWorld) };
  s.promise = forgeSoloWorld(w, ctrl.signal).then((v) => {
    if (slot === s) s.value = v;
    return v;
  });
  // Prefetch failures are silent; "Play again" just forges normally.
  s.promise.catch(() => {
    if (slot === s) slot = null;
  });
  slot = s;
}

/** Takes the prefetched world for this wish: a ready value, an in-flight promise, or null. */
export function takePrefetched(wish: string): ForgedWorld | Promise<ForgedWorld> | null {
  const s = slot;
  if (!s || s.wish !== wish.trim()) return null;
  slot = null;
  return s.value ?? s.promise;
}

export function cancelPrefetch() {
  slot?.ctrl.abort();
  slot = null;
}

export function prefetchStatus(wish: string): "ready" | "loading" | "none" {
  if (!slot || slot.wish !== wish.trim()) return "none";
  return slot.value ? "ready" : "loading";
}
