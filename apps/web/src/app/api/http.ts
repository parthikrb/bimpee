import type { z } from "zod";

export type ApiErrorKind = "timeout" | "network" | "http" | "parse" | "aborted";

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface HttpDeps {
  /** "" for same-origin (Vite proxy) or e.g. "https://api.example.com" */
  baseUrl: string;
  fetch: typeof fetch;
  headers: () => Promise<Record<string, string>>;
}

export interface RequestOpts {
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * Links an optional caller signal with a timeout. Returns the combined signal
 * and a cleanup that must be called once the request settles.
 */
export function timeoutSignal(timeoutMs: number, outer?: AbortSignal) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const onOuter = () => ctrl.abort();
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener("abort", onOuter, { once: true });
  }
  return {
    signal: ctrl.signal,
    timedOut: () => timedOut,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuter);
    },
  };
}

export async function rawRequest(
  deps: HttpDeps,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  opts: RequestOpts,
  accept = "application/json",
): Promise<{ res: Response; done: () => void; timedOut: () => boolean }> {
  const t = timeoutSignal(opts.timeoutMs, opts.signal);
  try {
    const headers: Record<string, string> = { accept, ...(await deps.headers()) };
    if (body !== undefined) headers["content-type"] = "application/json";
    // Aborted while resolving headers (e.g. token refresh): don't start the request.
    if (t.signal.aborted) throw new DOMException("Aborted", "AbortError");
    const res = await deps.fetch(`${deps.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: t.signal,
    });
    if (!res.ok) {
      t.done();
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {
        /* ignore */
      }
      throw new ApiError("http", `${method} ${path} -> ${res.status} ${detail}`.trim(), res.status);
    }
    return { res, done: t.done, timedOut: t.timedOut };
  } catch (e) {
    t.done();
    throw toApiError(e, t.timedOut(), opts.signal, `${method} ${path}`);
  }
}

export function toApiError(e: unknown, timedOut: boolean, outer: AbortSignal | undefined, what: string): ApiError {
  if (e instanceof ApiError) return e;
  if (timedOut) return new ApiError("timeout", `${what} timed out`);
  if (outer?.aborted) return new ApiError("aborted", `${what} aborted`);
  return new ApiError("network", `${what} failed: ${e instanceof Error ? e.message : String(e)}`);
}

export async function requestJson<S extends z.ZodType>(
  deps: HttpDeps,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  schema: S,
  opts: RequestOpts,
): Promise<z.infer<S>> {
  const { res, done, timedOut } = await rawRequest(deps, method, path, body, opts);
  let json: unknown;
  try {
    json = await res.json();
  } catch (e) {
    throw e instanceof SyntaxError ? new ApiError("parse", `${path}: invalid JSON`) : toApiError(e, timedOut(), opts.signal, path);
  } finally {
    done();
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiError("parse", `${path}: unexpected response shape (${parsed.error.issues[0]?.message ?? "?"})`);
  return parsed.data;
}
