import { createRng } from "./rng";
import {
  BOSS_SIGNATURES,
  ENEMY_BASES,
  ENEMY_MODIFIERS,
  INSTRUMENTATIONS,
  LAYOUTS,
  NARRATOR_VOICES,
  NOTES,
  SCALES,
  WEAPONS,
  type Biome,
  type EnemyArchetype,
  type Palette,
  type Weather,
  type WorldSpec,
} from "./world";

/**
 * Deterministic, offline world generator. Used when Claude is unreachable,
 * slow, or not configured, so the game never blocks on the network.
 */
const BIOME_KITS: Record<Biome, { palette: Palette; weather: Weather; names: string[]; foes: string[]; boss: string[] }> = {
  neon_city: {
    palette: { background: "#0b0221", floor: "#1a0b3d", wall: "#ff2bd6", accent: "#00f0ff", player: "#f8f8ff", glow: "#ff2bd6" },
    weather: "rain",
    names: ["Neon Undertow", "Chrome Requiem", "Midnight Arcade"],
    foes: ["Glitchling", "Pixel Hound", "Ad Drone", "Static Wraith", "Firewall Brute", "Spam Swarm"],
    boss: ["The Algorithm", "Mainframe Hydra"],
  },
  fungal_cathedral: {
    palette: { background: "#0d1a0f", floor: "#1d2e1a", wall: "#6b8f3a", accent: "#e6ff6b", player: "#fff4d6", glow: "#b6ff3b" },
    weather: "spores",
    names: ["Mycelium Mass", "Spore Choir", "The Rotting Nave"],
    foes: ["Sporeling", "Cap Knight", "Puffball", "Mold Creeper", "Rot Bishop", "Gill Lurker"],
    boss: ["The Mother Bloom", "Cardinal Fungus"],
  },
  frozen_wastes: {
    palette: { background: "#071624", floor: "#12304a", wall: "#9fd8ff", accent: "#ffffff", player: "#ffd166", glow: "#7fdbff" },
    weather: "snow",
    names: ["Whiteout Hymn", "Glacier Teeth", "The Long Frost"],
    foes: ["Frostling", "Ice Wolf", "Shard Sprite", "Yeti Grunt", "Blizzard Eye", "Rime Crawler"],
    boss: ["The Hoarfrost King", "Avalanche Wyrm"],
  },
  desert_ruins: {
    palette: { background: "#1f1306", floor: "#3b2610", wall: "#d9a441", accent: "#ff7b00", player: "#e8f6ff", glow: "#ffcf5c" },
    weather: "sandstorm",
    names: ["Dune Sepulchre", "Sunken Pharaoh", "Glass Desert"],
    foes: ["Scarab", "Dust Mummy", "Sand Wisp", "Obelisk Guard", "Jackal Runner", "Sun Eye"],
    boss: ["The Sleeping Sun", "Anubite Colossus"],
  },
  abyssal_reef: {
    palette: { background: "#020b1a", floor: "#06213d", wall: "#1fb5a8", accent: "#ff4f9a", player: "#fff7ae", glow: "#36f1cd" },
    weather: "bubbles",
    names: ["Abyssal Choir", "Drowned Lanterns", "The Pressure Deep"],
    foes: ["Lantern Fry", "Jelly Drifter", "Urchin", "Angler", "Ink Shade", "Coral Golem"],
    boss: ["Leviathan's Eye", "The Kraken Queen"],
  },
  clockwork_foundry: {
    palette: { background: "#140d07", floor: "#2a1d10", wall: "#b87333", accent: "#ffd700", player: "#bdf6ff", glow: "#ff9f1c" },
    weather: "embers",
    names: ["Gearheart Forge", "Brass Purgatory", "The Ticking Halls"],
    foes: ["Cog Mite", "Piston Brute", "Spring Hopper", "Steam Turret", "Gear Swarm", "Bellows"],
    boss: ["The Grand Regulator", "Automaton Prime"],
  },
  void_garden: {
    palette: { background: "#05010a", floor: "#140a24", wall: "#7a3cff", accent: "#ff6bd5", player: "#e9fffd", glow: "#b388ff" },
    weather: "static",
    names: ["Garden of Nothing", "Starless Bloom", "The Quiet Orchard"],
    foes: ["Void Petal", "Null Moth", "Echo", "Thornshade", "Hollow", "Gloam Seed"],
    boss: ["The Gardener", "Eclipse Rose"],
  },
  volcanic_forge: {
    palette: { background: "#160303", floor: "#2e0a06", wall: "#ff4500", accent: "#ffd23f", player: "#e0fbff", glow: "#ff6a00" },
    weather: "embers",
    names: ["Caldera Rising", "Magma Psalm", "The Ashen Crown"],
    foes: ["Cinder Imp", "Magma Slug", "Ash Bat", "Obsidian Brute", "Flame Wisp", "Lava Spitter"],
    boss: ["The Molten Tyrant", "Pyroclast Drake"],
  },
};

const PERSONAS: Record<(typeof NARRATOR_VOICES)[number], string> = {
  sardonic: "A bored cosmic game-show host who has seen a thousand heroes fail and secretly roots for you.",
  epic: "An ancient bard who narrates every dodge like a legend carved in stone.",
  deadpan: "A corporate safety announcer reading incident reports in real time.",
  cheerful: "An overly upbeat robot coach who believes in you far too much.",
  ominous: "The world itself, whispering, patient, hungry.",
};

export function generateFallbackWorld(seed: number, opts: { biome?: Biome } = {}): WorldSpec {
  const rng = createRng(seed);
  const biomes = Object.keys(BIOME_KITS) as Biome[];
  const biome = opts.biome ?? rng.pick(biomes);
  const kit = BIOME_KITS[biome];
  const voice = rng.pick(NARRATOR_VOICES);
  const foeNames = rng.shuffle(kit.foes);
  const bases = rng.shuffle(ENEMY_BASES);
  const enemyCount = rng.int(3, 5);
  const enemies: EnemyArchetype[] = Array.from({ length: enemyCount }, (_, i) => {
    const base = i === 0 ? "chaser" : bases[i % bases.length]!;
    const name = foeNames[i % foeNames.length]!;
    return {
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
      name,
      base,
      hp: base === "tank" ? rng.int(18, 30) : base === "swarmer" ? rng.int(1, 3) : rng.int(3, 10),
      speed: base === "tank" ? rng.range(0.4, 0.7) : base === "swarmer" ? rng.range(1.2, 1.8) : rng.range(0.8, 1.3),
      size: base === "tank" ? rng.range(1.6, 2.2) : base === "swarmer" ? rng.range(0.5, 0.8) : rng.range(0.9, 1.3),
      color: i % 2 === 0 ? kit.palette.accent : kit.palette.wall,
      modifiers: i >= 2 && rng.chance(0.5) ? [rng.pick(ENEMY_MODIFIERS)] : [],
      weight: i === 0 ? 1 : rng.range(0.3, 0.8),
      unlockAct: Math.min(2, Math.floor(i / 2)),
    };
  });
  return {
    version: 1,
    seed,
    name: rng.pick(kit.names),
    tagline: "A world stitched together while the AI director was away.",
    theme: {
      biome,
      palette: kit.palette,
      weather: kit.weather,
      fog: rng.range(0.1, 0.4),
      vignette: rng.range(0.3, 0.6),
      bloom: rng.range(0.3, 0.8),
      crt: rng.chance(0.3),
    },
    layout: { kind: rng.pick(LAYOUTS), density: rng.range(0.15, 0.45), size: "medium" },
    enemies,
    boss: {
      name: rng.pick(kit.boss),
      base: rng.pick(["tank", "charger", "orbiter", "shooter"] as const),
      hp: rng.int(400, 900),
      size: rng.range(3, 4.5),
      color: kit.palette.glow,
      phases: rng.int(2, 3),
      signature: rng.pick(BOSS_SIGNATURES),
      taunt: "You came all this way just to be remembered as a footnote.",
    },
    music: {
      key: rng.pick(NOTES),
      scale: rng.pick(SCALES),
      bpm: rng.int(96, 140),
      instrumentation: rng.pick(INSTRUMENTATIONS),
    },
    narrator: { name: voice === "ominous" ? "The Hollow Voice" : "The Announcer", voice, persona: PERSONAS[voice] },
    arc: [
      { name: "Arrival", durationSec: 75, intensityTarget: 0.35, beat: "Learn the land, feel powerful." },
      { name: "The Swell", durationSec: 120, intensityTarget: 0.65, beat: "The world notices you and pushes back." },
      { name: "Reckoning", durationSec: 120, intensityTarget: 0.85, beat: "Everything converges on the boss." },
    ],
    player: { startingWeapon: rng.pick(WEAPONS), hpMultiplier: 1 },
    loot: { generosity: rng.range(0.4, 0.7) },
    designNotes: "Offline fallback world, generated deterministically from the seed.",
  };
}
