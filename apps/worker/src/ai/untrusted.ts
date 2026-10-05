/**
 * Helpers for text that comes from players (wishes, names, telemetry strings).
 * Such text is only ever placed inside clearly delimited data sections of a
 * prompt; we also strip markup-ish characters so it cannot fake a closing tag.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069]", "g");

export function cleanText(s: string, max: number): string {
  return s.replace(CONTROL, " ").replace(/[<>`{}]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Display names: ≤ 24 chars, letters/digits/space/basic punctuation only. */
export function sanitizeDisplayName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s: string;
  try {
    s = decodeURIComponent(raw);
  } catch {
    s = raw;
  }
  s = s
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} _.\-']/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24)
    .trim();
  return s.length > 0 ? s : null;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
