import {
  emptyMemory,
  heuristicReflection,
  mergeReflection,
  PlayerMemorySchema,
  type PlayerMemory,
  type RunReport,
} from "@bimpee/shared";
import { api } from "../api";
import { displayName, guestId } from "../api/identity";
import { readJson, writeJson } from "../lib/storage";
import type { Reflection } from "../store/app";
import { backendUp, profileStore } from "../store/profile";
import { ensureHealth, reportNetworkFailure } from "./connectivity";
import { ApiError } from "../api";

/**
 * Player memory. Server-side when the worker is up; otherwise a local copy
 * (same shape) so the title snippet and offline reflections still work.
 */
const LOCAL_KEY = "localMemory";

export function localMemory(): PlayerMemory {
  const raw = readJson<unknown>(LOCAL_KEY, null);
  const p = PlayerMemorySchema.safeParse(raw);
  return p.success ? { ...p.data, displayName: displayName() } : emptyMemory(guestId(), displayName());
}

function saveLocal(m: PlayerMemory) {
  writeJson(LOCAL_KEY, m);
}

export async function refreshMemory(): Promise<void> {
  await ensureHealth();
  const ps = profileStore.getState();
  if (!backendUp()) {
    ps.setMemory(localMemory(), "local");
    return;
  }
  try {
    const m = await api.memory();
    profileStore.getState().setMemory(m, "server");
  } catch (e) {
    if (e instanceof ApiError && e.kind === "network") reportNetworkFailure();
    profileStore.getState().setMemory(localMemory(), "local");
  }
}

/** POST /api/runs (Claude's reflection) with a local heuristic fallback. Always updates local memory too. */
export async function submitRun(report: RunReport): Promise<Reflection> {
  const local = localMemory();
  const heur = heuristicReflection(local, report);
  const merged = mergeReflection(local, report, heur);
  saveLocal(merged);
  await ensureHealth();
  if (backendUp()) {
    try {
      const r = await api.runs(report);
      void refreshMemory();
      return { summary: r.summary, epitaph: r.epitaph, bestScore: r.bestScore, rank: r.rank, source: "claude" };
    } catch (e) {
      if (e instanceof ApiError && e.kind === "network") reportNetworkFailure();
    }
  }
  profileStore.getState().setMemory(merged, "local");
  return { summary: heur.summary, epitaph: heur.epitaph, bestScore: merged.bestScore, rank: null, source: "local" };
}

/** Local top runs for the offline leaderboard. */
export function localLeaderboard(): { displayName: string; score: number; worldName: string; outcome: "victory" | "death" | "quit"; at: string }[] {
  const m = localMemory();
  return [...m.recentRuns]
    .sort((a, b) => b.score - a.score)
    .map((r) => ({ displayName: m.displayName, score: r.score, worldName: r.worldName, outcome: r.outcome, at: r.at }));
}

export function memorySnippet(m: PlayerMemory | null): string | null {
  if (!m || m.runs === 0) return null;
  const parts = [`Runs ${m.runs}`, `Best ${new Intl.NumberFormat("en-US").format(m.bestScore)}`];
  if (m.wins) parts.push(`Wins ${m.wins}`);
  if (m.nemesis) parts.push(`Nemesis: ${m.nemesis}`);
  return parts.join(" · ");
}
