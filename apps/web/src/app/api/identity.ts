import { readString, writeString } from "../lib/storage";
import { uuid } from "../lib/ids";

/**
 * Who the player is, as far as the API is concerned:
 *  - Supabase configured: `Authorization: Bearer <access token>` (anonymous sign-in counts)
 *  - otherwise: a stable guest uuid in `x-bimpee-guest`, persisted in localStorage.
 * The display name always rides along in `x-bimpee-name` (URI-encoded, since
 * header values must be ISO-8859-1).
 */
const GUEST_KEY = "guestId";
const NAME_KEY = "displayName";
const MAX_NAME = 24;

let tokenProvider: (() => Promise<string | null>) | null = null;

export function setAccessTokenProvider(fn: (() => Promise<string | null>) | null) {
  tokenProvider = fn;
}

export function guestId(): string {
  let id = readString(GUEST_KEY);
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    id = uuid();
    writeString(GUEST_KEY, id);
  }
  return id;
}

export function sanitizeName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
}

const ADJ = ["Neon", "Rogue", "Static", "Lucky", "Feral", "Velvet", "Hollow", "Turbo", "Cosmic", "Quiet"];
const NOUN = ["Wanderer", "Moth", "Comet", "Pilot", "Specter", "Drifter", "Fox", "Glitch", "Nomad", "Spark"];

export function randomName(rand = Math.random): string {
  return `${ADJ[Math.floor(rand() * ADJ.length)]}${NOUN[Math.floor(rand() * NOUN.length)]}`;
}

export function displayName(): string {
  const stored = sanitizeName(readString(NAME_KEY) ?? "");
  if (stored) return stored;
  const n = randomName();
  writeString(NAME_KEY, n);
  return n;
}

export function setDisplayName(name: string): string {
  const n = sanitizeName(name) || displayName();
  writeString(NAME_KEY, n);
  return n;
}

export async function authHeaders(): Promise<Record<string, string>> {
  const h: Record<string, string> = { "x-bimpee-name": encodeURIComponent(displayName()) };
  let token: string | null = null;
  try {
    token = tokenProvider ? await tokenProvider() : null;
  } catch {
    token = null;
  }
  if (token) h.authorization = `Bearer ${token}`;
  else h["x-bimpee-guest"] = guestId();
  return h;
}
