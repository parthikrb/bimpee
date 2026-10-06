import type { CityCommand, CityDirective, CitySpec, CityTelemetry, Disaster } from "@bimpee/shared/city";

/**
 * Wire protocol between the city simulation (runs in a Web Worker,
 * apps/web/src/city/sim) and the main thread (renderer + shell glue).
 * Grid coordinates: tile (x, y), 0 <= x,y < size; index = y * size + x.
 * World space in the renderer: tile (x, y) center = ((x + 0.5) * TILE, height, (y + 0.5) * TILE), TILE = 2.
 */

export const TILE = 2;

/** Per-tile surface. */
export const TileKind = {
  Land: 0,
  Water: 1,
  Road: 2,
  Building: 3,
  Forest: 4,
} as const;
export type TileKind = (typeof TileKind)[keyof typeof TileKind];

/** Bits in `flags`. */
export const TileFlag = {
  Powered: 1,
  Watered: 2,
  OnFire: 4,
  Flooded: 8,
  Rubble: 16,
  Selected: 32,
} as const;

/** What a building is. Zoned growth uses res/com/ind; player-placed uses BuildKind names. */
export type BuildingType = "res" | "com" | "ind" | "landmark" | Exclude<import("@bimpee/shared/city").BuildKind, "road">;

export interface BuildingInfo {
  id: number;
  type: BuildingType;
  /** top-left tile */
  x: number;
  y: number;
  /** footprint in tiles (square) */
  size: number;
  /** 0..3, quarter turns */
  rot: number;
  /** 1..3 density level for zoned buildings (renderer picks taller models) */
  level: number;
  /** stable per-building variant for model/tint choice */
  variant: number;
  /** 0 intact .. 1 destroyed */
  damage: number;
  onFire: boolean;
  powered: boolean;
  watered: boolean;
  abandoned: boolean;
  /** landmark id from CitySpec.landmarks when type === "landmark" */
  landmarkId: string | null;
  /** residents or jobs, for inspection */
  occupants: number;
}

/** Sent once after init (and after loading a save). */
export interface TerrainMsg {
  type: "terrain";
  size: number;
  /** (size + 1)^2 vertex heights in tiles-units (renderer multiplies by its height scale) */
  heights: Float32Array;
  /** sea level in the same units */
  waterLevel: number;
  /** size^2, 0..255 forest density at generation time (trees may be cleared later via tiles) */
  forest: Uint8Array;
}

/** Sent whenever the grid changed (version increments). Arrays are transferred. */
export interface TilesMsg {
  type: "tiles";
  version: number;
  /** size^2 TileKind */
  kind: Uint8Array;
  /** size^2: 0 none, 1 res, 2 com, 3 ind */
  zone: Uint8Array;
  /** size^2 TileFlag bits */
  flags: Uint8Array;
  /** size^2 road connection bits: 1 north(y-1), 2 east(x+1), 4 south(y+1), 8 west(x-1) */
  roads: Uint8Array;
  /** size^2 building id + 1 occupying the tile (0 = none) */
  building: Uint32Array;
  /** size^2 0..255 pollution (for an optional overlay) */
  pollution: Uint8Array;
  /** size^2 0..255 land value (overlay) */
  landValue: Uint8Array;
  buildings: BuildingInfo[];
}

export interface ActiveDisaster {
  id: number;
  kind: Disaster;
  /** tile-space center (float) */
  x: number;
  y: number;
  radius: number;
  strength: number;
  /** seconds since start */
  t: number;
  duration: number;
  /** tornado heading (radians, tile space) */
  heading: number;
  /** flood: current water rise in height units */
  level: number;
}

/** A thing that happened; drives FX (physics debris), toasts and the gazette. */
export type CityEvent =
  | { kind: "collapse"; buildingId: number; type: BuildingType; x: number; y: number; size: number; cause: Disaster | "bulldoze" | "abandon" }
  | { kind: "meteor_impact"; x: number; y: number; radius: number }
  | { kind: "quake"; x: number; y: number; radius: number; strength: number }
  | { kind: "fire_started"; x: number; y: number }
  | { kind: "fire_out"; x: number; y: number }
  | { kind: "disaster_start"; disaster: Disaster; x: number; y: number; headline: string }
  | { kind: "disaster_end"; disaster: Disaster }
  | { kind: "built"; what: string; x: number; y: number }
  | { kind: "milestone"; text: string }
  | { kind: "economy"; text: string }
  | { kind: "news"; headline: string; body: string }
  | { kind: "visitor"; text: string }
  | { kind: "goal"; text: string; achieved: boolean };

export interface Motion {
  id: string;
  memberId: string;
  title: string;
  pitch: string;
  options: { label: string }[];
  /** in-game day it expires */
  expiresDay: number;
}

export interface CityHud {
  day: number;
  hour: number;
  speed: 0 | 1 | 2 | 4;
  funds: number;
  incomePerDay: number;
  expensesPerDay: number;
  population: number;
  happiness: number;
  taxRate: number;
  demand: { residential: number; commercial: number; industrial: number };
  power: { supply: number; demand: number };
  water: { supply: number; demand: number };
  weather: string;
  goals: { description: string; progress: number; daysLeft: number; achieved: boolean }[];
  motions: Motion[];
}

/** ~10Hz while running. `cars` is transferred: [x, y, heading, kind, ...] in tile space (float). */
export interface FrameMsg {
  type: "frame";
  day: number;
  /** 0..24 */
  hour: number;
  weather: string;
  /** 0..1 global shake for the renderer (earthquake) */
  shake: number;
  cars: Float32Array;
  disasters: ActiveDisaster[];
  events: CityEvent[];
}

export type FromSim =
  | TerrainMsg
  | TilesMsg
  | FrameMsg
  | { type: "hud"; hud: CityHud }
  | { type: "telemetry"; telemetry: CityTelemetry }
  | { type: "command_result"; ok: boolean; reason: string | null; cost: number; command: CityCommand }
  | { type: "serialized"; reqId: number; data: string }
  | { type: "ready" }
  | { type: "error"; message: string };

export type ToSim =
  | { type: "init"; spec: CitySpec; cityId: string; save: string | null }
  | { type: "command"; command: CityCommand }
  | { type: "directives"; directives: CityDirective[] }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "serialize"; reqId: number }
  | { type: "dispose" };
