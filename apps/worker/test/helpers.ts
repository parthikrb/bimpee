import Anthropic from "@anthropic-ai/sdk";
import { generateFallbackWorld, type RunReport, type Telemetry } from "@bimpee/shared";
import type { ClaudeClient } from "../src/ai/claude";

export const world = generateFallbackWorld(1234);

export const telemetry = (over: Partial<Telemetry> = {}, player: Partial<Telemetry["player"]> = {}): Telemetry => ({
  runId: "run-1",
  t: 120,
  act: 1,
  intensity: 0.5,
  intensityTarget: 0.6,
  phase: "build",
  player: {
    hpFraction: 0.8,
    level: 3,
    weapon: "blaster",
    accuracy: 0.5,
    damageTaken: 0.1,
    kills: 4,
    nearMisses: 2,
    idleRatio: 0.1,
    score: 1200,
    ...player,
  },
  enemiesAlive: 10,
  bossActive: false,
  recentEvents: [],
  recentDirectives: [],
  fps: 60,
  players: 1,
  ...over,
});

export const report = (over: Partial<RunReport> = {}): RunReport => ({
  runId: "r-1",
  worldName: "Neon Undertow",
  worldSeed: 42,
  biome: "neon_city",
  outcome: "death",
  durationSec: 200,
  score: 3000,
  kills: 80,
  level: 5,
  accuracy: 0.6,
  damageTaken: 2,
  killedBy: "Pixel Hound",
  bossDefeated: false,
  highlights: ["survived a blackout at 4% hp"],
  directivesUsed: ["adjust_spawns"],
  intensityCurve: [0.2, 0.4, 0.8],
  ...over,
});

export function message(
  content: unknown[],
  stop_reason: Anthropic.Beta.BetaStopReason = "end_turn",
  model = "claude-opus-5-5",
): Anthropic.Beta.BetaMessage {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Beta.BetaMessage;
}

type CreateFn = (params: Anthropic.Beta.MessageCreateParamsNonStreaming, opts?: { signal?: AbortSignal | null }) => Promise<Anthropic.Beta.BetaMessage>;
type StreamFn = (params: unknown, opts?: { signal?: AbortSignal | null }) => AsyncIterable<Anthropic.Beta.BetaRawMessageStreamEvent>;

/** Fake Anthropic client: records requests and answers from the supplied functions. */
export function fakeClient(create: CreateFn, stream?: StreamFn) {
  const calls: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
  const client: ClaudeClient = {
    beta: {
      messages: {
        create: (params, opts) => {
          calls.push(params);
          return create(params, opts as { signal?: AbortSignal | null });
        },
        stream: (params, opts) => {
          if (!stream) throw new Error("no stream fake");
          return stream(params, opts as { signal?: AbortSignal | null });
        },
      },
    },
  };
  return { client, calls };
}

/** A create() that never answers until the request's signal aborts. */
export const hang: CreateFn = (_p, opts) =>
  new Promise((_resolve, reject) => {
    opts?.signal?.addEventListener("abort", () => reject(new Anthropic.APIUserAbortError()));
  });

export async function* textStream(parts: string[]): AsyncIterable<Anthropic.Beta.BetaRawMessageStreamEvent> {
  for (const text of parts) {
    yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } as Anthropic.Beta.BetaRawMessageStreamEvent;
  }
}

// ---- Bimpee City fixtures -----------------------------------------------------

import { generateFallbackCity, type CityTelemetry } from "@bimpee/shared/city";

export const city = generateFallbackCity(4242);

export const cityTelemetry = (over: Partial<CityTelemetry> = {}): CityTelemetry => ({
  cityId: "city-1",
  day: 12,
  hour: 10,
  population: 1200,
  funds: 20_000,
  incomePerDay: 900,
  expensesPerDay: 700,
  taxRate: 0.09,
  happiness: 0.6,
  demand: { residential: 0.3, commercial: 0.1, industrial: -0.2 },
  power: { supply: 500, demand: 400, greenShare: 0.3 },
  water: { supply: 400, demand: 300 },
  trafficCongestion: 0.2,
  unemployment: 0.05,
  pollution: 0.3,
  buildings: { residential: 40, road: 120 },
  damagedBuildings: 0,
  activeDisasters: [],
  recentPlayerActions: ["zoned 12 industrial tiles near the river"],
  recentEvents: [],
  recentDirectives: [],
  councilApproval: {},
  openMotions: 0,
  goals: [],
  ...over,
});
