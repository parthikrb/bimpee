import type Anthropic from "@anthropic-ai/sdk";
import {
  CitySpecSchema,
  generateFallbackCity,
  localFate,
  parseCityDirectives,
  sanitizeCitySpec,
  type CityFateResponse,
  type CityMemory,
  type CitySessionReport,
  type CitySpec,
  type CitySpecResponse,
  type CityTelemetry,
} from "@bimpee/shared/city";
import { randomSeed } from "@bimpee/shared";
import { log, type Models } from "../config";
import { heuristicCityReflection } from "../city/logic";
import { cached, describeError, logUsage, modelParams, textOf, type ClaudeClient, type StreamParams } from "./claude";
import { buildFateTools, postProcessCityDirectives } from "./cityDirectives";
import {
  CITY_REFLECTION_SYSTEM,
  CITY_SPEC_SYSTEM,
  COUNCIL_SYSTEM,
  COUNCIL_UPDATE_SYSTEM,
  FATE_SYSTEM,
  GAZETTE_SYSTEM,
  cityReflectionUserPrompt,
  citySpecUserPrompt,
  councilUpdateUserPrompt,
  councilUserPrompt,
  fateStableBlock,
  fateTelemetryBlock,
  gazetteUserPrompt,
} from "./cityPrompts";
import {
  CityReflectionSchema,
  CouncilUpdateSchema,
  type CityAiService,
  type CityReflectionResult,
  type CitySpecInput,
  type CouncilInput,
  type CouncilUpdate,
  type GazetteInput,
} from "./cityTypes";
import { toApiSchema } from "./schema";

export interface CityClaudeOptions {
  specTimeoutMs: number;
  fateTimeoutMs: number;
  councilTimeoutMs: number;
  councilUpdateTimeoutMs: number;
  gazetteTimeoutMs: number;
  reflectionTimeoutMs: number;
}

export const DEFAULT_CITY_OPTIONS: CityClaudeOptions = {
  specTimeoutMs: 25_000,
  fateTimeoutMs: 9_000,
  councilTimeoutMs: 15_000,
  councilUpdateTimeoutMs: 8_000,
  gazetteTimeoutMs: 12_000,
  reflectionTimeoutMs: 15_000,
};

export const COUNCIL_MAX_WORDS = 120;
export const GAZETTE_MAX_WORDS = 90;

const withTimeout = (ms: number, signal?: AbortSignal) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));

/** Length of the prefix of `text` that holds its first `n` words (whitespace preserved). */
export function wordPrefixLength(text: string, n: number): number {
  let count = 0;
  for (const m of text.matchAll(/\S+/g)) {
    count++;
    if (count === n) return m.index + m[0].length;
  }
  return text.length;
}

/**
 * Forwards text deltas of a streamed message, cut at `maxWords` words (and a
 * character cap) whatever the model does. Throws when the model refuses
 * before saying anything.
 */
async function* cappedText(stream: AsyncIterable<Anthropic.Beta.BetaRawMessageStreamEvent>, maxWords: number, maxChars: number): AsyncIterable<string> {
  let full = "";
  let emitted = 0;
  for await (const ev of stream) {
    if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
      if (emitted >= maxChars) continue;
      full += ev.delta.text;
      const end = Math.min(wordPrefixLength(full, maxWords), maxChars);
      if (end > emitted) {
        yield full.slice(emitted, end);
        emitted = end;
      }
    } else if (ev.type === "message_delta" && ev.delta.stop_reason === "refusal" && emitted === 0) {
      throw new Error("model refused");
    }
  }
}

export class ClaudeCityAiService implements CityAiService {
  readonly enabled = true;
  private readonly tools = buildFateTools();
  private readonly specFormat: Anthropic.Beta.BetaJSONOutputFormat = { type: "json_schema", schema: toApiSchema(CitySpecSchema) };
  private readonly updateFormat: Anthropic.Beta.BetaJSONOutputFormat = { type: "json_schema", schema: toApiSchema(CouncilUpdateSchema) };
  private readonly reflectionFormat: Anthropic.Beta.BetaJSONOutputFormat = { type: "json_schema", schema: toApiSchema(CityReflectionSchema) };
  private readonly opts: CityClaudeOptions;

  constructor(
    private readonly client: ClaudeClient,
    readonly models: Models,
    opts: Partial<CityClaudeOptions> = {},
  ) {
    this.opts = { ...DEFAULT_CITY_OPTIONS, ...opts };
  }

  async designCity(input: CitySpecInput): Promise<CitySpecResponse> {
    const started = Date.now();
    const seed = input.seed ?? randomSeed();
    const model = this.models.world;
    const timeout = input.timeoutMs ?? this.opts.specTimeoutMs;
    const fallback = (why: string): CitySpecResponse => {
      log.warn(`[ai] city spec fallback: ${why}`);
      return { spec: generateFallbackCity(seed), source: "fallback", model: "fallback", latencyMs: Date.now() - started };
    };
    try {
      const msg = await this.client.beta.messages.create(
        {
          ...modelParams(model, "medium", this.specFormat),
          max_tokens: 16_000,
          system: [cached(CITY_SPEC_SYSTEM)],
          messages: [
            {
              role: "user",
              content: citySpecUserPrompt({ memory: input.memory, wish: input.wish, recentClimates: (input.recentClimates ?? []).slice(0, 5), seed }),
            },
          ],
        },
        { timeout, maxRetries: 0, signal: AbortSignal.timeout(timeout) },
      );
      logUsage("city_spec", msg);
      if (msg.stop_reason !== "end_turn") return fallback(`stop_reason=${msg.stop_reason}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(textOf(msg));
      } catch {
        return fallback("invalid JSON");
      }
      if (parsed && typeof parsed === "object") (parsed as Record<string, unknown>).seed = seed;
      const spec = sanitizeCitySpec(parsed);
      if (!spec) return fallback("spec failed validation");
      return { spec: { ...spec, seed }, source: "claude", model: msg.model || model, latencyMs: Date.now() - started };
    } catch (e) {
      return fallback(describeError(e));
    }
  }

  async fate(spec: CitySpec, telemetry: CityTelemetry, memory: CityMemory | null, signal?: AbortSignal): Promise<CityFateResponse> {
    const started = Date.now();
    const local = (why: string): CityFateResponse => {
      log.warn(`[ai] fate fallback: ${why}`);
      const r = localFate(spec, telemetry);
      return { directives: postProcessCityDirectives(spec, telemetry, r.directives), reasoning: r.reasoning, model: "local", latencyMs: Date.now() - started };
    };
    if (signal?.aborted) return local("client went away");
    try {
      const msg = await this.client.beta.messages.create(
        {
          ...modelParams(this.models.director, "low"),
          max_tokens: 4_000,
          system: [cached(FATE_SYSTEM)],
          tools: this.tools,
          tool_choice: { type: "auto" },
          messages: [{ role: "user", content: [cached(fateStableBlock(spec, memory)), { type: "text", text: fateTelemetryBlock(telemetry) }] }],
        },
        { timeout: this.opts.fateTimeoutMs, maxRetries: 0, signal: withTimeout(this.opts.fateTimeoutMs, signal) },
      );
      logUsage("fate", msg);
      if (msg.stop_reason === "refusal" || msg.stop_reason === "max_tokens") return local(`stop_reason=${msg.stop_reason}`);
      const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      const raw = uses.map((b) => ({ ...(b.input && typeof b.input === "object" ? (b.input as object) : {}), tool: b.name }));
      const parsed = parseCityDirectives(raw);
      if (uses.length > 0 && parsed.length === 0) return local("all tool calls invalid");
      return {
        directives: postProcessCityDirectives(spec, telemetry, parsed),
        reasoning: textOf(msg).trim().slice(0, 400),
        model: msg.model || this.models.director,
        latencyMs: Date.now() - started,
      };
    } catch (e) {
      return local(describeError(e));
    }
  }

  async *councilReply(input: CouncilInput, signal?: AbortSignal): AsyncIterable<string> {
    const params: StreamParams = {
      ...modelParams(this.models.narrator, "low"),
      // Thinking counts toward max_tokens; leave headroom beyond the ~200 tokens of the reply.
      max_tokens: 1_500,
      system: [cached(COUNCIL_SYSTEM)],
      messages: [{ role: "user", content: councilUserPrompt(input) }],
    };
    const stream = this.client.beta.messages.stream(params, {
      maxRetries: 0,
      timeout: this.opts.councilTimeoutMs,
      signal: withTimeout(this.opts.councilTimeoutMs, signal),
    });
    yield* cappedText(stream, COUNCIL_MAX_WORDS, 1_000);
  }

  async councilUpdate(input: CouncilInput, reply: string): Promise<CouncilUpdate> {
    const none: CouncilUpdate = { approvalDelta: 0, notes: [] };
    try {
      const msg = await this.client.beta.messages.create(
        {
          ...modelParams(this.models.director, "low", this.updateFormat),
          max_tokens: 2_000,
          system: [cached(COUNCIL_UPDATE_SYSTEM)],
          messages: [{ role: "user", content: councilUpdateUserPrompt(input, reply) }],
        },
        { timeout: this.opts.councilUpdateTimeoutMs, maxRetries: 0, signal: AbortSignal.timeout(this.opts.councilUpdateTimeoutMs) },
      );
      logUsage("council_update", msg);
      if (msg.stop_reason !== "end_turn") return none;
      const p = CouncilUpdateSchema.safeParse(JSON.parse(textOf(msg)));
      return p.success ? p.data : none;
    } catch (e) {
      log.warn(`[ai] council update fallback: ${describeError(e)}`);
      return none;
    }
  }

  async *gazette(input: GazetteInput, signal?: AbortSignal): AsyncIterable<string> {
    const stream = this.client.beta.messages.stream(
      {
        ...modelParams(this.models.narrator, "low"),
        max_tokens: 1_200,
        system: [cached(GAZETTE_SYSTEM)],
        messages: [{ role: "user", content: gazetteUserPrompt(input) }],
      },
      { maxRetries: 0, timeout: this.opts.gazetteTimeoutMs, signal: withTimeout(this.opts.gazetteTimeoutMs, signal) },
    );
    yield* cappedText(stream, GAZETTE_MAX_WORDS, 800);
  }

  async reflectCity(memory: CityMemory, report: CitySessionReport): Promise<CityReflectionResult> {
    const fallback = (why: string): CityReflectionResult => {
      log.warn(`[ai] city reflection fallback: ${why}`);
      return { reflection: heuristicCityReflection(memory, report), source: "fallback" };
    };
    try {
      const msg = await this.client.beta.messages.create(
        {
          ...modelParams(this.models.director, "low", this.reflectionFormat),
          max_tokens: 3_000,
          system: [cached(CITY_REFLECTION_SYSTEM)],
          messages: [{ role: "user", content: cityReflectionUserPrompt(memory, report) }],
        },
        { timeout: this.opts.reflectionTimeoutMs, maxRetries: 0, signal: AbortSignal.timeout(this.opts.reflectionTimeoutMs) },
      );
      logUsage("city_reflection", msg);
      if (msg.stop_reason !== "end_turn") return fallback(`stop_reason=${msg.stop_reason}`);
      let json: unknown;
      try {
        json = JSON.parse(textOf(msg));
      } catch {
        return fallback("invalid JSON");
      }
      const p = CityReflectionSchema.safeParse(json);
      if (!p.success) return fallback("reflection failed validation");
      return { reflection: p.data, source: "claude" };
    } catch (e) {
      return fallback(describeError(e));
    }
  }
}
