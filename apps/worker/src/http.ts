import type { Context } from "hono";
import type { z } from "zod";
import { log } from "./config";

export type AppEnv = { Variables: { userId: string } };
export type Ctx = Context<AppEnv>;
export type Middleware = (c: Ctx, next: () => Promise<void>) => Promise<Response | void>;

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 404 | 409 | 413 | 429 | 500 | 503,
    message: string,
  ) {
    super(message);
  }
}

export async function readBody<S extends z.ZodType>(c: Ctx, schema: S): Promise<z.infer<S>> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new HttpError(400, "body must be valid JSON");
  }
  const p = schema.safeParse(json);
  if (!p.success) {
    const issues = p.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new HttpError(400, `invalid request: ${issues}`);
  }
  return p.data;
}

/** Validate our own responses in the hot path: a contract drift is a bug we want in the logs, not on the client. */
export function checked<S extends z.ZodType>(schema: S, value: z.infer<S>, what: string): z.infer<S> {
  const p = schema.safeParse(value);
  if (!p.success) {
    log.error(`[api] ${what} response failed its schema: ${p.error.issues[0]?.message ?? "?"}`);
    throw new HttpError(500, "internal error");
  }
  return p.data;
}

export const INT32_MAX = 2_147_483_647;
