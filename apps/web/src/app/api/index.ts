import { authHeaders } from "./identity";
import { createApiClient } from "./client";

export { ApiError } from "./http";
export type { ApiClient } from "./client";
export { TIMEOUTS } from "./client";

const base = (import.meta.env.VITE_API_BASE ?? "").replace(/\/+$/, "");

/** App-wide API client (same-origin by default; Vite proxies /api to the worker). */
export const api = createApiClient({
  baseUrl: base,
  fetch: (...args) => globalThis.fetch(...args),
  headers: authHeaders,
});

export const apiBase = base;
