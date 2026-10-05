import { z } from "zod";

/**
 * Converts a zod schema into the JSON-schema subset accepted by Claude's
 * structured outputs and strict tools.
 *
 * The API rejects numeric bounds, string length / pattern / format, and
 * minItems > 1 (among others). We strip those keywords and fold the
 * information into `description` so the model still sees the intent; the
 * shared zod schemas (+ sanitizeWorldSpec) re-validate the answer afterwards.
 * Every object becomes closed (`additionalProperties: false`) with all
 * properties required; optional properties become nullable instead.
 */
export type JsonSchema = { [k: string]: unknown };

const DROP = new Set(["$schema", "$id", "format", "default", "examples", "propertyNames", "patternProperties"]);
const INT_LIMIT = Number.MAX_SAFE_INTEGER;

export function toApiSchema(schema: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(schema, { io: "output", unrepresentable: "any" }) as JsonSchema;
  return clean(json) as JsonSchema;
}

function fmt(n: unknown) {
  return typeof n === "number" ? String(n) : "?";
}

function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean);
  if (!node || typeof node !== "object") return node;
  const src = node as JsonSchema;
  const out: JsonSchema = {};
  const notes: string[] = [];

  // Numeric range -> description
  const lo = src.minimum ?? src.exclusiveMinimum;
  const hi = src.maximum ?? src.exclusiveMaximum;
  const loReal = typeof lo === "number" && Math.abs(lo) < INT_LIMIT;
  const hiReal = typeof hi === "number" && Math.abs(hi) < INT_LIMIT;
  if (loReal && hiReal) notes.push(`(${fmt(lo)}..${fmt(hi)})`);
  else if (loReal) notes.push(src.exclusiveMinimum !== undefined ? `(> ${fmt(lo)})` : `(>= ${fmt(lo)})`);
  else if (hiReal) notes.push(src.exclusiveMaximum !== undefined ? `(< ${fmt(hi)})` : `(<= ${fmt(hi)})`);
  if (typeof src.multipleOf === "number") notes.push(`(multiple of ${src.multipleOf})`);

  // String constraints -> description
  if (typeof src.minLength === "number" && typeof src.maxLength === "number")
    notes.push(`(${src.minLength}-${src.maxLength} chars)`);
  else if (typeof src.maxLength === "number") notes.push(`(<= ${src.maxLength} chars)`);
  else if (typeof src.minLength === "number" && src.minLength > 0) notes.push(`(>= ${src.minLength} chars)`);
  if (typeof src.pattern === "string") notes.push(`(must match /${src.pattern}/)`);
  if (typeof src.format === "string") notes.push(`(format: ${src.format})`);

  // Array constraints: minItems 0/1 is supported, everything else goes to description
  const minItems = typeof src.minItems === "number" ? src.minItems : undefined;
  const maxItems = typeof src.maxItems === "number" ? src.maxItems : undefined;
  if (minItems !== undefined && minItems === maxItems) notes.push(`(exactly ${minItems} items)`);
  else {
    if (minItems !== undefined && minItems > 1) notes.push(`(at least ${minItems} items)`);
    if (maxItems !== undefined) notes.push(`(at most ${maxItems} items)`);
  }

  for (const [k, v] of Object.entries(src)) {
    if (DROP.has(k)) continue;
    switch (k) {
      case "minimum":
      case "maximum":
      case "exclusiveMinimum":
      case "exclusiveMaximum":
      case "multipleOf":
      case "minLength":
      case "maxLength":
      case "pattern":
      case "maxItems":
        continue;
      case "minItems":
        if (typeof v === "number" && v <= 1) out.minItems = v;
        continue;
      case "properties": {
        const props: JsonSchema = {};
        for (const [pk, pv] of Object.entries(v as JsonSchema)) props[pk] = clean(pv);
        out.properties = props;
        continue;
      }
      case "$defs":
      case "definitions": {
        const defs: JsonSchema = {};
        for (const [dk, dv] of Object.entries(v as JsonSchema)) defs[dk] = clean(dv);
        out[k] = defs;
        continue;
      }
      case "description":
        continue; // re-added below with notes
      default:
        out[k] = clean(v);
    }
  }

  const desc = [typeof src.description === "string" ? src.description : "", ...notes].filter(Boolean).join(" ");
  if (desc) out.description = desc;

  if (out.type === "object" || out.properties) {
    const props = (out.properties ?? {}) as JsonSchema;
    const required = new Set(Array.isArray(src.required) ? (src.required as string[]) : []);
    for (const key of Object.keys(props)) {
      if (!required.has(key)) props[key] = makeNullable(props[key] as JsonSchema);
    }
    out.properties = props;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  return out;
}

function makeNullable(s: JsonSchema): JsonSchema {
  if (Array.isArray(s.anyOf)) {
    return (s.anyOf as JsonSchema[]).some((x) => x.type === "null") ? s : { ...s, anyOf: [...(s.anyOf as JsonSchema[]), { type: "null" }] };
  }
  if (typeof s.type === "string") return s.type === "null" ? s : { ...s, type: [s.type, "null"], ...(s.enum ? { enum: [...(s.enum as unknown[]), null] } : {}) };
  if (Array.isArray(s.type)) return s.type.includes("null") ? s : { ...s, type: [...s.type, "null"] };
  return { anyOf: [s, { type: "null" }] };
}

/** Keywords the API's schema subset rejects; used by tests to assert a clean conversion. */
export const UNSUPPORTED_KEYWORDS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "maxItems",
  "$schema",
] as const;

/** Recursively lists unsupported keywords (and minItems > 1) found in a JSON schema. */
export function findUnsupported(node: unknown, path = "$"): string[] {
  if (Array.isArray(node)) return node.flatMap((n, i) => findUnsupported(n, `${path}[${i}]`));
  if (!node || typeof node !== "object") return [];
  const o = node as JsonSchema;
  const bad: string[] = [];
  for (const k of UNSUPPORTED_KEYWORDS) if (k in o) bad.push(`${path}.${k}`);
  if (typeof o.minItems === "number" && o.minItems > 1) bad.push(`${path}.minItems`);
  if ((o.type === "object" || o.properties) && o.additionalProperties !== false) bad.push(`${path}.additionalProperties`);
  for (const [k, v] of Object.entries(o)) {
    if (k === "properties" || k === "$defs") {
      for (const [pk, pv] of Object.entries(v as JsonSchema)) bad.push(...findUnsupported(pv, `${path}.${k}.${pk}`));
    } else if (typeof v === "object") bad.push(...findUnsupported(v, `${path}.${k}`));
  }
  return bad;
}
