export function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // RFC4122-ish v4 fallback for old browsers / insecure contexts.
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const newRunId = () => `run_${uuid().replace(/-/g, "").slice(0, 16)}`;

/** Random, readable room code: e.g. "neon-fox-42". */
export function randomRoomCode(rand = Math.random): string {
  const a = ["neon", "void", "frost", "ember", "chrome", "spore", "tidal", "rust", "astral", "pixel"];
  const b = ["fox", "moth", "wyrm", "golem", "comet", "ghost", "lynx", "drake", "crow", "eel"];
  const pick = (xs: string[]) => xs[Math.floor(rand() * xs.length)]!;
  return `${pick(a)}-${pick(b)}-${Math.floor(rand() * 90 + 10)}`;
}

/** Normalizes user input into a valid room id (see ROOM_ID_RE) or returns null. */
export function normalizeRoomCode(input: string): string | null {
  const s = input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  return /^[a-z0-9-]{3,24}$/.test(s) ? s : null;
}
