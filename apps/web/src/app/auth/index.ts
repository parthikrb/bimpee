import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { displayName, sanitizeName, setAccessTokenProvider, setDisplayName } from "../api/identity";
import { profileStore } from "../store/profile";

/**
 * Auth. With VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY: anonymous Supabase
 * sign-in on first load (session persisted by supabase-js), optional email
 * upgrade via `updateUser({ email })` (magic-link confirmation turns the
 * anonymous user permanent: same user id, so memory carries over).
 * Without them: guest mode (x-bimpee-guest uuid).
 */
const URL_ = import.meta.env.VITE_SUPABASE_URL?.trim();
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
export const supabaseConfigured = Boolean(URL_ && KEY);

let client: SupabaseClient | null = null;
let initPromise: Promise<void> | null = null;

function publish(session: Session | null) {
  const u = session?.user ?? null;
  profileStore.getState().setAuth({
    mode: "supabase",
    ready: true,
    userId: u?.id ?? null,
    isAnonymous: u ? (u.is_anonymous ?? !u.email) : true,
    email: u?.email ?? null,
  });
}

/** Idempotent (StrictMode-safe). Never rejects: auth failures degrade to guest mode. */
export function initAuth(): Promise<void> {
  initPromise ??= (async () => {
    profileStore.getState().setDisplayName(displayName());
    if (!supabaseConfigured) {
      profileStore.getState().setAuth({ mode: "guest", ready: true });
      return;
    }
    try {
      const { createClient } = await import("@supabase/supabase-js");
      const c = createClient(URL_!, KEY!, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      });
      client = c;
      setAccessTokenProvider(async () => (await c.auth.getSession()).data.session?.access_token ?? null);
      let { data } = await c.auth.getSession();
      if (!data.session) {
        const res = await c.auth.signInAnonymously({ options: { data: { display_name: displayName() } } });
        if (res.error) throw res.error;
        data = { session: res.data.session };
      }
      const metaName = (data.session?.user.user_metadata as { display_name?: unknown } | undefined)?.display_name;
      if (typeof metaName === "string" && sanitizeName(metaName)) {
        profileStore.getState().setDisplayName(setDisplayName(metaName));
      }
      publish(data.session);
      c.auth.onAuthStateChange((_event, session) => publish(session));
    } catch (e) {
      console.warn("[bimpee] Supabase auth unavailable, playing as guest:", e);
      setAccessTokenProvider(null);
      client = null;
      profileStore.getState().setAuth({ mode: "guest", ready: true });
    }
  })();
  return initPromise;
}

export async function saveDisplayName(name: string): Promise<string> {
  const n = setDisplayName(name);
  profileStore.getState().setDisplayName(n);
  if (client) {
    try {
      await client.auth.updateUser({ data: { display_name: n } });
    } catch {
      /* name still saved locally and sent via header */
    }
  }
  return n;
}

/** Sends a magic link that upgrades the anonymous account to a permanent one. */
export async function linkEmail(email: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!client) return { ok: false, error: "Accounts are not configured on this server." };
  const clean = email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return { ok: false, error: "That doesn't look like an email address." };
  try {
    const { error } = await client.auth.updateUser({ email: clean }, { emailRedirectTo: location.origin });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not send the link." };
  }
}
