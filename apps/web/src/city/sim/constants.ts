/**
 * Tuning constants for the city simulation. Times are in simulation seconds
 * (one tick = TICK seconds at 1x speed) unless they say "days".
 */

/** fixed simulation step, seconds of game-clock per tick at 1x */
export const TICK = 0.1;
/** max ticks a single step() may run (protects against tab-throttle catch-up spirals) */
export const MAX_CATCHUP_TICKS = 40;

/** serialization format version */
export const SAVE_VERSION = 1;

// ---- terrain -------------------------------------------------------------
/** max corner-height spread (tile units) of a tile that can carry a road or a 1x1 building */
export const MAX_ROAD_SLOPE = 1.0;
export const MAX_BUILD_SLOPE = 1.1;
/** max consecutive water tiles bridged by one road command */
export const MAX_BRIDGE = 8;
export const BRIDGE_COST_MULT = 5;
export const BULLDOZE_REFUND = 0.25;
export const CLEAR_FOREST_COST = 2;
export const CLEAR_RUBBLE_COST = 5;

// ---- zoning & growth -----------------------------------------------------
/** tiles from a road (BFS steps) a zoned lot may be to grow */
export const ROAD_REACH = 2;
/** growth scans of every tile per in-game day (spread over the ticks of a day) */
export const GROWTH_PASSES_PER_DAY = 3;
export const GROWTH_CHANCE = 0.55;
export const LEVELUP_CHANCE = 0.35;
/** days without power/water before a zoned building is abandoned */
export const ABANDON_DAYS = 3;
/** days abandoned before it is demolished (collapse cause "abandon") */
export const DEMOLISH_ABANDONED_DAYS = 8;
/** residents (res) / jobs (com, ind) per building by level 1..3 */
export const OCCUPANTS: Record<"res" | "com" | "ind", [number, number, number]> = {
  res: [14, 40, 110],
  com: [8, 22, 60],
  ind: [12, 30, 60],
};
/** utility demand per zoned building by level (power, water) */
export const UTIL_DEMAND: Record<"res" | "com" | "ind", [number, number]> = {
  res: [2, 2],
  com: [3, 2],
  ind: [5, 3],
};
export const SERVICE_UTIL_DEMAND: [number, number] = [3, 2];
export const LANDMARK_UTIL_DEMAND: [number, number] = [5, 3];
/** output of a utility landmark */
export const LANDMARK_UTILITY_OUTPUT = 200;
/** pump must be within this many tiles of open water */
export const PUMP_WATER_REACH = 2;

// ---- economy -------------------------------------------------------------
/** per-day tax base: rate x (residents x RES_TAX + jobs x JOB_TAX) */
export const RES_TAX = 11;
export const JOB_TAX = 8;
/** daily interest on debt */
export const DEBT_INTEREST = 0.01;
export const TOURISM_LANDMARK_INCOME = 260;

// ---- fields --------------------------------------------------------------
export const POLLUTION_EVERY = 10; // ticks
export const LANDVALUE_EVERY = 20; // ticks
/** a fields-only (overlay) tiles message at most this often (ticks) */
export const FIELD_TILES_EVERY = 50;
export const LANDMARK_EFFECT_RADIUS = 10;

// ---- traffic -------------------------------------------------------------
export const CAR_SPEED = 2.6; // tiles per second
export const LANE_OFFSET = 0.2;
export const PATH_CACHE_MAX = 600;
export const ASTAR_PER_TICK = 3;
export const SPAWN_PER_TICK = 3;
/** cars per resident at rush hour */
export const CARS_PER_RESIDENT = 0.1;
export const carCap = (size: number) => Math.round(200 + size * 1.5);

// ---- disasters -----------------------------------------------------------
export const MAX_ACTIVE_DISASTERS = 6;
export const EARTHQUAKE_DURATION = 8;
export const TORNADO_DURATION = 20;
export const FLOOD_DURATION = 30;
export const METEOR_DELAY = 3;
export const METEOR_DURATION = 6;
export const FIRE_MAX_DURATION = 120;
/** fire damage per second to a burning building */
export const FIRE_BURN_RATE = 0.045;

// ---- council -------------------------------------------------------------
export const MOTION_DAYS = 3;
export const MAX_OPEN_MOTIONS = 2;

export const MILESTONES = [100, 500, 1000, 2500, 5000, 10000, 25000, 50000];
