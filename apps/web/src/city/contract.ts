import type { BuildKind, CityCommand, CityDirective, CitySpec, CityTelemetry, Disaster, Zone } from "@bimpee/shared/city";
import { Bus } from "../game/contract";
import type { BuildingInfo, CityEvent, CityHud } from "./sim/protocol";

export { Bus };

/**
 * Contract between the React shell (apps/web/src/app) and the city game
 * (apps/web/src/city). The game owns the worker simulation, rendering,
 * physics FX and pointer interaction with the map; the shell owns UI panels,
 * AI calls (Fate, council chat, gazette), saves and audio.
 */

/** The active tool, chosen in the shell's toolbar. The game interprets pointer input with it. */
export type CityTool =
  | { kind: "inspect" }
  | { kind: "road" }
  | { kind: "zone"; zone: Zone | null }
  | { kind: "bulldoze" }
  | { kind: "build"; build: Exclude<BuildKind, "road"> }
  | { kind: "landmark"; id: string }
  | { kind: "disaster"; disaster: Disaster };

export interface TileInspection {
  x: number;
  y: number;
  terrain: string;
  zone: Zone | null;
  building: BuildingInfo | null;
  powered: boolean;
  watered: boolean;
  pollution: number;
  landValue: number;
}

export interface CityToShell {
  /** ~4Hz */
  hud: CityHud;
  /** once per in-game day: feed to POST /api/city/fate */
  telemetry: CityTelemetry;
  event: CityEvent;
  command_result: { ok: boolean; reason: string | null; cost: number; command: CityCommand };
  inspect: TileInspection | null;
  /** hover feedback for the current tool: cost of the pending action, validity */
  preview: { valid: boolean; cost: number; label: string } | null;
  /** worker/renderer is ready (terrain built, first frame drawn) */
  ready: void;
  /** fatal problem (e.g. WebGL unavailable); show it to the player */
  error: string;
}

export interface ShellToCity {
  tool: CityTool;
  command: CityCommand;
  directives: CityDirective[];
  pause: void;
  resume: void;
  /** a generated landmark model became available (same-origin .glb URL) */
  landmark_model: { id: string; url: string };
  /** fly the camera to a tile */
  focus: { x: number; y: number };
  /** toggle data overlays */
  overlay: "none" | "power" | "water" | "pollution" | "land_value" | "traffic";
}

export interface CityOptions {
  spec: CitySpec;
  cityId: string;
  /** CitySim.serialize() output to resume a saved city */
  save: string | null;
}

export interface CityHandle {
  out: Bus<CityToShell>;
  in: Bus<ShellToCity>;
  /** snapshot of the simulation for saving (base64) */
  serialize(): Promise<string>;
  destroy(): void;
}

export type CreateCity = (parent: HTMLElement, opts: CityOptions) => CityHandle;
