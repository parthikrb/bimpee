import type { Directive, PacingOutput, RoomPlayer, RunReport, Telemetry, WorldSpec } from "@bimpee/shared";

/**
 * Contract between the React shell (apps/web/src/app) and the 3D game
 * (apps/web/src/game). The shell owns AI calls, UI overlays, audio and
 * multiplayer; the game owns simulation and rendering. They talk only
 * through this typed bus.
 */

export type GameEventKind =
  | "run_start"
  | "act_change"
  | "kill"
  | "elite_kill"
  | "player_hit"
  | "near_death"
  | "level_up"
  | "event_started"
  | "boss_spawn"
  | "boss_phase"
  | "boss_defeated"
  | "boon"
  | "death"
  | "victory";

export interface GameEvent {
  kind: GameEventKind;
  /** run clock in seconds */
  t: number;
  /** short human-readable description, also fed to the director/narrator */
  text: string;
}

export interface UpgradeOption {
  id: string;
  name: string;
  description: string;
  rarity: "common" | "rare" | "epic";
}

export interface HudState {
  t: number;
  act: number;
  actName: string;
  hp: number;
  maxHp: number;
  level: number;
  xp: number;
  xpToNext: number;
  score: number;
  kills: number;
  weapon: string;
  /** boss hp as a 0..1 fraction (null when no boss) */
  bossHp: number | null;
  bossName: string | null;
}

export interface GameToShell {
  /** every frame-ish (throttled to ~4Hz): HUD numbers */
  hud: HudState;
  /** ~4Hz: pacing controller output, for the debug HUD and music */
  pacing: PacingOutput;
  /** every ~15s (and on demand): telemetry for the AI director */
  telemetry: Telemetry;
  /** discrete happenings */
  event: GameEvent;
  /** player leveled up: game is paused until shell sends `pick_upgrade` */
  upgrade_offer: UpgradeOption[];
  /** ~10Hz: own position for multiplayer ghosts (world coordinates) */
  player_state: { x: number; y: number; hp: number; score: number; alive: boolean };
  /** big on-screen banner from a directive (event / boss / boon / biome) */
  banner: { text: string; tone: "info" | "danger" | "boon" };
  /** run finished (victory, death, or quit) */
  run_end: RunReport;
  /** a directive was applied (or rejected) by the game, for the debug HUD log */
  directive_applied: { directive: Directive; ok: boolean; note?: string };
}

export interface ShellToGame {
  directives: Directive[];
  pick_upgrade: string;
  ghosts: RoomPlayer[];
  pause: void;
  resume: void;
  quit: void;
}

export interface GameOptions {
  world: WorldSpec;
  runId: string;
  /** number of players sharing this world (scales spawns) */
  players: number;
  /** seconds already elapsed on a shared room clock (late joiners) */
  startOffsetSec?: number;
  /** player chosen display name (shown over own ship in multiplayer) */
  playerName: string;
}

type Handler<T> = (payload: T) => void;

export class Bus<Events extends { [K in keyof Events]: unknown }> {
  private handlers = new Map<keyof Events, Set<Handler<any>>>();
  on<K extends keyof Events>(k: K, h: Handler<Events[K]>): () => void {
    let set = this.handlers.get(k);
    if (!set) this.handlers.set(k, (set = new Set()));
    set.add(h);
    return () => set!.delete(h);
  }
  emit<K extends keyof Events>(k: K, ...payload: Events[K] extends void ? [] : [Events[K]]): void {
    this.handlers.get(k)?.forEach((h) => h(payload[0]));
  }
  clear() {
    this.handlers.clear();
  }
}

export interface GameHandle {
  /** events from the game */
  out: Bus<GameToShell>;
  /** commands into the game */
  in: Bus<ShellToGame>;
  destroy(): void;
}

/** Implemented in ./index.ts by the game module. */
export type CreateGame = (parent: HTMLElement, opts: GameOptions) => GameHandle;
