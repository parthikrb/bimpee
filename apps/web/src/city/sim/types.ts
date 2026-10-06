import type { BuildKind, Disaster, Zone } from "@bimpee/shared/city";
import type { BuildingType } from "./protocol";

/** Internal building record (BuildingInfo is derived from it). */
export interface Building {
  id: number;
  type: BuildingType;
  x: number;
  y: number;
  size: number;
  rot: number;
  level: number;
  variant: number;
  damage: number;
  onFire: boolean;
  powered: boolean;
  watered: boolean;
  abandoned: boolean;
  landmarkId: string | null;
  occupants: number;
  /** days without power / water (zoned only) */
  noPowerDays: number;
  noWaterDays: number;
  /** days spent abandoned */
  abandonedDays: number;
  /** sim seconds flooded in the current flood */
  floodT: number;
  /** producers: offline until this sim time (seconds); 0 = online */
  offlineUntil: number;
  /** what it cost the player (for the bulldoze refund) */
  cost: number;
}

export const ZONE_CODE: Record<Zone, number> = { residential: 1, commercial: 2, industrial: 3 };
export const ZONE_NAMES: (Zone | null)[] = [null, "residential", "commercial", "industrial"];
export const ZONE_TYPE: ("res" | "com" | "ind" | null)[] = [null, "res", "com", "ind"];

export const isZonedType = (t: BuildingType): t is "res" | "com" | "ind" => t === "res" || t === "com" || t === "ind";
export const isPowerProducer = (t: BuildingType) => t === "power_coal" || t === "power_wind" || t === "power_solar";
export const isWaterProducer = (t: BuildingType) => t === "water_tower" || t === "water_pump";
export const isService = (t: BuildingType) => t === "fire_station" || t === "police" || t === "clinic" || t === "school" || t === "park";

/** All non-road player build kinds in a fixed order (serialization codes). */
export const TYPE_CODES: BuildingType[] = [
  "res",
  "com",
  "ind",
  "landmark",
  "power_coal",
  "power_wind",
  "power_solar",
  "water_tower",
  "water_pump",
  "fire_station",
  "police",
  "clinic",
  "school",
  "park",
];
export type PlacedKind = Exclude<BuildKind, "road">;

export interface DisasterState {
  id: number;
  kind: Disaster;
  x: number;
  y: number;
  radius: number;
  strength: number;
  t: number;
  duration: number;
  heading: number;
  level: number;
  /** sent by Fate (at most one Fate disaster at a time) */
  fate: boolean;
  /** one-shot phase flag (quake hit applied, meteor impacted…) */
  phase: number;
  headline: string;
}

export interface Modifier {
  /** economic_event kind, "demand" (adjust_demand), "motion", "visitor" … */
  kind: string;
  strength: number;
  daysLeft: number;
  /** demand multipliers / additive offsets */
  res: number;
  com: number;
  ind: number;
  income: number;
  happiness: number;
  landValue: number;
}

export interface MotionState {
  id: string;
  memberId: string;
  title: string;
  pitch: string;
  options: {
    label: string;
    effect: { funds: number; happiness: number; approval: number; demand: "none" | "residential" | "commercial" | "industrial" };
  }[];
  expiresDay: number;
}

export interface GoalState {
  achieved: boolean;
  failed: boolean;
}

export function mod(kind: string, p: Partial<Modifier>): Modifier {
  return { kind, strength: 0, daysLeft: 1, res: 0, com: 0, ind: 0, income: 0, happiness: 0, landValue: 0, ...p };
}
