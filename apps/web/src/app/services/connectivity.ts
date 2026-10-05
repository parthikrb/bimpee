import { api } from "../api";
import { profileStore, type AiStatus } from "../store/profile";

let inflight: Promise<AiStatus> | null = null;

/** GET /api/health: decides whether we talk to the backend at all. */
export function checkHealth(): Promise<AiStatus> {
  inflight ??= (async () => {
    try {
      const h = await api.health();
      const status: AiStatus = h.ai ? "online" : "degraded";
      profileStore.getState().setHealth(status, h);
      return status;
    } catch {
      profileStore.getState().setHealth("offline", null);
      return "offline" as const;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Resolves once the first health check has finished (instant afterwards). */
export async function ensureHealth(): Promise<AiStatus> {
  const s = profileStore.getState().ai;
  return s === "checking" ? checkHealth() : s;
}

/** Marks the backend offline after a network failure mid-session (it will be re-checked from the title). */
export function reportNetworkFailure() {
  const s = profileStore.getState();
  if (s.ai !== "offline") s.setHealth("offline", null);
}
