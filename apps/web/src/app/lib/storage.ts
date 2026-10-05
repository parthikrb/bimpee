/** localStorage wrapper that never throws (private mode, quota, SSR/tests). */
const PREFIX = "bimpee.";

function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readString(key: string): string | null {
  try {
    return store()?.getItem(PREFIX + key) ?? null;
  } catch {
    return null;
  }
}

export function writeString(key: string, value: string | null): void {
  try {
    const s = store();
    if (!s) return;
    if (value === null) s.removeItem(PREFIX + key);
    else s.setItem(PREFIX + key, value);
  } catch {
    /* ignore quota / privacy errors */
  }
}

export function readJson<T>(key: string, fallback: T, validate?: (v: unknown) => v is T): T {
  const raw = readString(key);
  if (raw === null) return fallback;
  try {
    const v: unknown = JSON.parse(raw);
    if (validate && !validate(v)) return fallback;
    return v as T;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    writeString(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}
