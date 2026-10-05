import { createStore, useStore } from "zustand";
import type { HealthResponse, PlayerMemory } from "@bimpee/shared";

export type AiStatus = "checking" | "online" | "degraded" | "offline";

export interface AuthInfo {
  mode: "guest" | "supabase";
  ready: boolean;
  userId: string | null;
  isAnonymous: boolean;
  email: string | null;
}

export interface ProfileState {
  displayName: string;
  memory: PlayerMemory | null;
  memorySource: "server" | "local" | null;
  ai: AiStatus;
  health: HealthResponse | null;
  auth: AuthInfo;
  setDisplayName(n: string): void;
  setMemory(m: PlayerMemory | null, source: "server" | "local"): void;
  setHealth(ai: AiStatus, h: HealthResponse | null): void;
  setAuth(a: Partial<AuthInfo>): void;
}

export const profileStore = createStore<ProfileState>()((set) => ({
  displayName: "",
  memory: null,
  memorySource: null,
  ai: "checking",
  health: null,
  auth: { mode: "guest", ready: false, userId: null, isAnonymous: true, email: null },
  setDisplayName: (displayName) => set({ displayName }),
  setMemory: (memory, memorySource) => set({ memory, memorySource }),
  setHealth: (ai, health) => set({ ai, health }),
  setAuth: (a) => set((s) => ({ auth: { ...s.auth, ...a } })),
}));

export function useProfile<T>(selector: (s: ProfileState) => T): T {
  return useStore(profileStore, selector);
}

/** True when the worker answered /api/health (AI may still be off: the worker then serves fallbacks itself). */
export const backendUp = () => {
  const a = profileStore.getState().ai;
  return a === "online" || a === "degraded";
};
