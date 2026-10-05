import { z } from "zod";

/**
 * World Spec: the small, validated document Claude writes before every run.
 * The engine turns it into the actual scene (procedural map, recolored
 * shapes, particles, music). Every numeric field is clamped by
 * `sanitizeWorldSpec`, so a slightly-off model answer never breaks a run.
 */

export const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "expected #rrggbb")
  .describe("CSS hex color like #ff00aa");

export const BIOMES = [
  "neon_city",
  "fungal_cathedral",
  "frozen_wastes",
  "desert_ruins",
  "abyssal_reef",
  "clockwork_foundry",
  "void_garden",
  "volcanic_forge",
] as const;
export const WEATHERS = ["none", "rain", "snow", "embers", "spores", "sandstorm", "bubbles", "static"] as const;
export const LAYOUTS = ["arena", "caverns", "rooms", "islands", "maze"] as const;
export const ENEMY_BASES = ["chaser", "swarmer", "shooter", "charger", "splitter", "orbiter", "tank"] as const;
export const ENEMY_MODIFIERS = [
  "shielded",
  "explodes",
  "teleports",
  "regenerates",
  "leaves_trail",
  "fast_bullets",
  "cloaks",
] as const;
export const BOSS_SIGNATURES = ["radial_burst", "summon_swarm", "charge_combo", "laser_sweep", "bullet_spiral"] as const;
export const WEAPONS = ["blaster", "scatter", "beam", "orbitals", "lobber"] as const;
export const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
export const SCALES = ["major", "minor", "dorian", "phrygian", "lydian", "mixolydian", "pentatonic_minor"] as const;
export const INSTRUMENTATIONS = ["synthwave", "chiptune", "ambient", "industrial", "orchestral_lite"] as const;
export const NARRATOR_VOICES = ["sardonic", "epic", "deadpan", "cheerful", "ominous"] as const;

export const PaletteSchema = z.object({
  background: hexColor,
  floor: hexColor,
  wall: hexColor,
  accent: hexColor,
  player: hexColor,
  glow: hexColor,
});

export const EnemyArchetypeSchema = z.object({
  id: z.string().describe("short snake_case id, unique within the world"),
  name: z.string().describe("flavourful display name"),
  base: z.enum(ENEMY_BASES).describe("behaviour block this enemy is built from"),
  hp: z.number().min(1).max(60),
  speed: z.number().min(0.3).max(3).describe("multiplier on base speed"),
  size: z.number().min(0.5).max(2.5),
  color: hexColor,
  modifiers: z.array(z.enum(ENEMY_MODIFIERS)).max(3),
  weight: z.number().min(0).max(1).describe("relative spawn weight"),
  unlockAct: z.number().int().min(0).max(2).describe("act index (0-2) where it starts appearing"),
});

export const BossSchema = z.object({
  name: z.string(),
  base: z.enum(ENEMY_BASES),
  hp: z.number().min(80).max(3000),
  size: z.number().min(2).max(6),
  color: hexColor,
  phases: z.number().int().min(1).max(3),
  signature: z.enum(BOSS_SIGNATURES),
  taunt: z.string().describe("one line the boss says on arrival, <= 100 chars"),
});

export const ActSchema = z.object({
  name: z.string(),
  durationSec: z.number().min(30).max(240),
  intensityTarget: z.number().min(0).max(1),
  beat: z.string().describe("one sentence describing what this act should feel like"),
});

export const WorldSpecSchema = z.object({
  version: z.literal(1),
  seed: z.number().int().min(0).max(2_147_483_647),
  name: z.string().describe("world title, 2-5 words"),
  tagline: z.string().describe("one evocative line, <= 90 chars"),
  theme: z.object({
    biome: z.enum(BIOMES),
    palette: PaletteSchema,
    weather: z.enum(WEATHERS),
    fog: z.number().min(0).max(1),
    vignette: z.number().min(0).max(1),
    bloom: z.number().min(0).max(1),
    crt: z.boolean(),
  }),
  layout: z.object({
    kind: z.enum(LAYOUTS),
    density: z.number().min(0).max(1).describe("obstacle density"),
    size: z.enum(["small", "medium", "large"]),
  }),
  enemies: z.array(EnemyArchetypeSchema).min(2).max(6),
  boss: BossSchema,
  music: z.object({
    key: z.enum(NOTES),
    scale: z.enum(SCALES),
    bpm: z.number().min(70).max(180),
    instrumentation: z.enum(INSTRUMENTATIONS),
  }),
  narrator: z.object({
    name: z.string(),
    voice: z.enum(NARRATOR_VOICES),
    persona: z.string().describe("who the narrator is, <= 200 chars"),
  }),
  arc: z.array(ActSchema).length(3).describe("three acts: opening, escalation, boss"),
  player: z.object({
    startingWeapon: z.enum(WEAPONS),
    hpMultiplier: z.number().min(0.5).max(2),
  }),
  loot: z.object({ generosity: z.number().min(0).max(1) }),
  designNotes: z.string().describe("why this world fits this player right now, <= 400 chars"),
});

export type Palette = z.infer<typeof PaletteSchema>;
export type EnemyArchetype = z.infer<typeof EnemyArchetypeSchema>;
export type Boss = z.infer<typeof BossSchema>;
export type Act = z.infer<typeof ActSchema>;
export type WorldSpec = z.infer<typeof WorldSpecSchema>;
export type Biome = (typeof BIOMES)[number];
export type Weather = (typeof WEATHERS)[number];
export type EnemyBase = (typeof ENEMY_BASES)[number];
export type EnemyModifier = (typeof ENEMY_MODIFIERS)[number];
export type Weapon = (typeof WEAPONS)[number];

export const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Repairs a world spec that is *almost* valid (values out of range, long strings,
 * duplicate enemy ids) instead of rejecting it. Returns null only if the shape
 * is unusable, in which case callers fall back to `generateFallbackWorld`.
 */
export function sanitizeWorldSpec(input: unknown): WorldSpec | null {
  const loose = WorldSpecSchema.safeParse(input);
  if (loose.success) return normalize(loose.data);
  // Second chance: coerce common problems, then re-validate.
  if (!input || typeof input !== "object") return null;
  try {
    const raw = JSON.parse(JSON.stringify(input)) as Record<string, any>;
    raw.version = 1;
    raw.seed = Math.abs(Math.trunc(Number(raw.seed) || 0)) % 2_147_483_647;
    const numPaths: [string[], number, number][] = [
      [["theme", "fog"], 0, 1],
      [["theme", "vignette"], 0, 1],
      [["theme", "bloom"], 0, 1],
      [["layout", "density"], 0, 1],
      [["music", "bpm"], 70, 180],
      [["player", "hpMultiplier"], 0.5, 2],
      [["loot", "generosity"], 0, 1],
      [["boss", "hp"], 80, 3000],
      [["boss", "size"], 2, 6],
      [["boss", "phases"], 1, 3],
    ];
    for (const [path, lo, hi] of numPaths) {
      let o: any = raw;
      for (const k of path.slice(0, -1)) o = o?.[k];
      const last = path[path.length - 1]!;
      if (o && last in o) o[last] = clamp(Number(o[last]), lo, hi);
    }
    if (Array.isArray(raw.enemies)) {
      raw.enemies = raw.enemies.slice(0, 6).map((e: any) => ({
        ...e,
        hp: clamp(Number(e?.hp), 1, 60),
        speed: clamp(Number(e?.speed), 0.3, 3),
        size: clamp(Number(e?.size), 0.5, 2.5),
        weight: clamp(Number(e?.weight), 0, 1),
        unlockAct: Math.round(clamp(Number(e?.unlockAct), 0, 2)),
        modifiers: Array.isArray(e?.modifiers) ? e.modifiers.slice(0, 3) : [],
      }));
    }
    if (Array.isArray(raw.arc)) {
      raw.arc = raw.arc.slice(0, 3).map((a: any) => ({
        ...a,
        durationSec: clamp(Number(a?.durationSec), 30, 240),
        intensityTarget: clamp(Number(a?.intensityTarget), 0, 1),
      }));
    }
    const second = WorldSpecSchema.safeParse(raw);
    return second.success ? normalize(second.data) : null;
  } catch {
    return null;
  }
}

function normalize(w: WorldSpec): WorldSpec {
  const seen = new Set<string>();
  const enemies = w.enemies.map((e, i) => {
    let id = e.id.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32) || `enemy_${i}`;
    while (seen.has(id)) id = `${id}_${i}`;
    seen.add(id);
    return { ...e, id, name: truncate(e.name, 40), modifiers: [...new Set(e.modifiers)] };
  });
  // Guarantee something spawns in act 0.
  if (!enemies.some((e) => e.unlockAct === 0)) enemies[0] = { ...enemies[0]!, unlockAct: 0 };
  if (enemies.every((e) => e.weight === 0)) enemies.forEach((e) => (e.weight = 0.5));
  return {
    ...w,
    name: truncate(w.name, 48),
    tagline: truncate(w.tagline, 120),
    designNotes: truncate(w.designNotes, 600),
    boss: { ...w.boss, name: truncate(w.boss.name, 48), taunt: truncate(w.boss.taunt, 140) },
    narrator: { ...w.narrator, name: truncate(w.narrator.name, 40), persona: truncate(w.narrator.persona, 300) },
    enemies,
  };
}

/** Total planned run length in seconds. */
export const runDurationSec = (w: WorldSpec) => w.arc.reduce((s, a) => s + a.durationSec, 0);
