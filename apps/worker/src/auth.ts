import type { SupabaseClient } from "@supabase/supabase-js";
import { errMsg, log } from "./config";

export type AuthResult = { ok: true; userId: string } | { ok: false; error: string };

export interface AuthService {
  readonly mode: "supabase" | "guest";
  authenticate(headers: Headers): Promise<AuthResult>;
}

export const GUEST_HEADER = "x-bimpee-guest";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUuid = (s: string) => UUID_RE.test(s);

/**
 * Dev / no-Supabase mode: the client picks its own uuid and sends it in
 * `x-bimpee-guest`. There is no secret involved, so this is only used when
 * Supabase is not configured (never alongside real accounts).
 */
export class GuestAuth implements AuthService {
  readonly mode = "guest" as const;
  async authenticate(headers: Headers): Promise<AuthResult> {
    const id = headers.get(GUEST_HEADER)?.trim();
    if (!id) return { ok: false, error: `missing ${GUEST_HEADER} header` };
    if (!isUuid(id)) return { ok: false, error: `${GUEST_HEADER} must be a uuid` };
    return { ok: true, userId: id.toLowerCase() };
  }
}

export type GetUser = (token: string) => Promise<{ id: string } | null>;

/** Verifies a Supabase access token (anonymous users included) via `auth.getUser`. */
export class SupabaseAuth implements AuthService {
  readonly mode = "supabase" as const;
  constructor(private readonly getUser: GetUser) {}

  static fromClient(client: SupabaseClient): SupabaseAuth {
    return new SupabaseAuth(async (token) => {
      const { data, error } = await client.auth.getUser(token);
      if (error || !data.user) return null;
      return { id: data.user.id };
    });
  }

  async authenticate(headers: Headers): Promise<AuthResult> {
    const header = headers.get("authorization") ?? "";
    const m = /^Bearer\s+([A-Za-z0-9._~+/=-]{20,4096})$/.exec(header.trim());
    if (!m) {
      // The dev-only guest header is never honoured when real auth is configured.
      return { ok: false, error: headers.has(GUEST_HEADER) ? "guest mode is disabled on this server" : "missing bearer token" };
    }
    try {
      const user = await this.getUser(m[1]!);
      if (!user || !isUuid(user.id)) return { ok: false, error: "invalid or expired token" };
      return { ok: true, userId: user.id };
    } catch (e) {
      log.error(`[auth] token verification failed: ${errMsg(e)}`);
      return { ok: false, error: "could not verify token" };
    }
  }
}
