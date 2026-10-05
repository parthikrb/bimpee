import {
  BIOMES,
  createRng,
  generateFallbackWorld,
  hashSeed,
  heuristicReflection,
  localDirector,
  randomSeed,
  type Biome,
  type DirectorResponse,
  type NarrateRequest,
  type PlayerMemory,
  type RunReport,
  type Telemetry,
  type WorldResponse,
  type WorldSpec,
} from "@bimpee/shared";
import type { Models } from "../config";
import { postProcessDirectives } from "./directives";
import type { AiService, ReflectionResult, WorldInput } from "./types";

type Voice = WorldSpec["narrator"]["voice"];
type Trigger = NarrateRequest["trigger"];

/** Canned narration per trigger; `{world}`, `{boss}`, `{nemesis}` are substituted. Flavoured per voice below. */
const LINES: Record<Trigger, string[]> = {
  run_start: ["Welcome to {world}. Try not to die immediately.", "{world} stirs. It has noticed you."],
  act_change: ["The air in {world} changes. Something bigger is coming.", "Act over. The next one bites harder."],
  boss_spawn: ["{boss} has arrived, and it is not here to talk.", "Behold {boss}. Run, or don't. Mostly run."],
  boss_defeated: ["{boss} falls. {world} will remember this.", "And just like that, {boss} is history."],
  near_death: ["One more hit and this story ends badly.", "Your health is a rumour at this point."],
  death: ["{world} claims another wanderer.", "So ends the run. {nemesis} sends regards."],
  victory: ["{world} bends the knee. Well played.", "Victory. The world will need a moment to recover."],
  milestone: ["Not bad. Not bad at all.", "The numbers are going up. {world} is getting nervous."],
};

const VOICE_TAG: Record<Voice, (s: string) => string> = {
  sardonic: (s) => s,
  epic: (s) => `Hear me! ${s}`,
  deadpan: (s) => s.replace(/!/g, "."),
  cheerful: (s) => `${s} Yay!`,
  ominous: (s) => `${s} ...`,
};

/**
 * Keyless stand-in for Claude: deterministic fallback worlds, the rule-based
 * director, canned streamed narration and heuristic reflections. Lets the
 * whole game run locally with zero configuration.
 */
export class MockAiService implements AiService {
  readonly enabled = false;
  constructor(
    readonly models: Models,
    private readonly opts: { narrationDelayMs?: number } = {},
  ) {}

  async generateWorld(input: WorldInput): Promise<WorldResponse> {
    const started = Date.now();
    const seed = input.seed ?? randomSeed();
    const recent = new Set(input.recentBiomes ?? []);
    const options = BIOMES.filter((b) => !recent.has(b));
    const biome: Biome | undefined = options.length ? createRng(seed).pick(options) : undefined;
    return { world: generateFallbackWorld(seed, biome ? { biome } : {}), source: "fallback", model: "mock", latencyMs: Date.now() - started };
  }

  async director(world: WorldSpec, telemetry: Telemetry): Promise<DirectorResponse> {
    const r = localDirector(world, telemetry);
    return { ...r, directives: postProcessDirectives(world, telemetry, r.directives) };
  }

  async *narrate(req: NarrateRequest, memory: PlayerMemory | null, signal?: AbortSignal): AsyncIterable<string> {
    const options = LINES[req.trigger];
    const base = options[hashSeed(`${req.world.seed}:${req.trigger}:${req.context}`) % options.length]!;
    const line = VOICE_TAG[req.world.narrator.voice](
      base
        .replaceAll("{world}", req.world.name)
        .replaceAll("{boss}", req.world.boss.name)
        .replaceAll("{nemesis}", memory?.nemesis ?? req.world.boss.name),
    );
    const words = line.split(" ");
    for (let i = 0; i < words.length; i++) {
      if (signal?.aborted) return;
      if (this.opts.narrationDelayMs) await new Promise((r) => setTimeout(r, this.opts.narrationDelayMs));
      yield i === 0 ? words[i]! : ` ${words[i]}`;
    }
  }

  async reflect(memory: PlayerMemory, report: RunReport): Promise<ReflectionResult> {
    return { reflection: heuristicReflection(memory, report), source: "fallback" };
  }
}
