import Anthropic from "@anthropic-ai/sdk";
import {
  RunReflectionSchema,
  WorldSpecSchema,
  generateFallbackWorld,
  heuristicReflection,
  localDirector,
  parseDirectives,
  randomSeed,
  sanitizeWorldSpec,
  type DirectorResponse,
  type NarrateRequest,
  type PlayerMemory,
  type RunReport,
  type Telemetry,
  type WorldResponse,
  type WorldSpec,
} from "@bimpee/shared";
import { errMsg, log, type Models } from "../config";
import { buildDirectorTools, postProcessDirectives } from "./directives";
import {
  DIRECTOR_SYSTEM,
  NARRATOR_SYSTEM,
  REFLECTION_SYSTEM,
  WORLD_SYSTEM,
  directorStableBlock,
  directorTelemetryBlock,
  narratorUserPrompt,
  reflectionUserPrompt,
  worldUserPrompt,
} from "./prompts";
import { toApiSchema } from "./schema";
import type { AiService, ReflectionResult, WorldInput } from "./types";

type CreateParams = Anthropic.Beta.MessageCreateParamsNonStreaming;
type StreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];
type RequestOptions = NonNullable<Parameters<Anthropic["beta"]["messages"]["create"]>[1]>;

/**
 * The slice of the SDK this service uses. The real `Anthropic` client fits
 * it; tests inject a fake so nothing touches the network.
 */
export interface ClaudeClient {
  beta: {
    messages: {
      create(params: CreateParams, options?: RequestOptions): PromiseLike<Anthropic.Beta.BetaMessage>;
      stream(params: StreamParams, options?: RequestOptions): AsyncIterable<Anthropic.Beta.BetaRawMessageStreamEvent>;
    };
  };
}

export interface ClaudeOptions {
  worldTimeoutMs: number;
  directorTimeoutMs: number;
  narratorTimeoutMs: number;
  reflectionTimeoutMs: number;
}

export const DEFAULT_CLAUDE_OPTIONS: ClaudeOptions = {
  worldTimeoutMs: 25_000,
  directorTimeoutMs: 9_000,
  narratorTimeoutMs: 12_000,
  reflectionTimeoutMs: 15_000,
};

type Effort = "low" | "medium" | "high";

/**
 * Model-specific request knobs:
 * - Thinking is never sent (always-on adaptive on Opus 5.5; omitted is the safe default elsewhere).
 * - Haiku models don't support `effort`.
 * - Opus/Sonnet 5.x (and Fable 5.x) get server-side refusal fallbacks (`fallbacks: "default"`).
 */
export function modelParams(model: string, effort: Effort, format?: Anthropic.Beta.BetaJSONOutputFormat) {
  const output_config: Anthropic.Beta.BetaOutputConfig = {};
  if (!model.startsWith("claude-haiku")) output_config.effort = effort;
  if (format) output_config.format = format;
  const fallback = /^claude-(opus|sonnet|fable)-5(-|$)/.test(model);
  return {
    model,
    ...(Object.keys(output_config).length ? { output_config } : {}),
    ...(fallback ? { betas: ["server-side-fallback-2026-07-01"] as Anthropic.Beta.AnthropicBeta[], fallbacks: "default" as const } : {}),
  };
}

const cached = (text: string): Anthropic.Beta.BetaTextBlockParam => ({ type: "text", text, cache_control: { type: "ephemeral" } });

function textOf(msg: Anthropic.Beta.BetaMessage): string {
  return msg.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function logUsage(kind: string, msg: Anthropic.Beta.BetaMessage) {
  const u = msg.usage;
  log.debug(
    `[ai] ${kind} model=${msg.model} stop=${msg.stop_reason} in=${u.input_tokens} out=${u.output_tokens} cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0}`,
  );
}

function describeError(e: unknown): string {
  if (e instanceof Anthropic.APIUserAbortError) return "timeout/aborted";
  if (e instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (e instanceof Anthropic.RateLimitError) return "rate limited (429)";
  if (e instanceof Anthropic.AuthenticationError) return "authentication failed (check ANTHROPIC_API_KEY)";
  if (e instanceof Anthropic.BadRequestError) return `bad request: ${e.message.slice(0, 200)}`;
  if (e instanceof Anthropic.APIError) return `api error ${e.status ?? "?"}`;
  return errMsg(e);
}

export class ClaudeAiService implements AiService {
  readonly enabled = true;
  private readonly tools = buildDirectorTools();
  private readonly worldFormat: Anthropic.Beta.BetaJSONOutputFormat = { type: "json_schema", schema: toApiSchema(WorldSpecSchema) };
  private readonly reflectionFormat: Anthropic.Beta.BetaJSONOutputFormat = { type: "json_schema", schema: toApiSchema(RunReflectionSchema) };
  private readonly opts: ClaudeOptions;

  constructor(
    private readonly client: ClaudeClient,
    readonly models: Models,
    opts: Partial<ClaudeOptions> = {},
  ) {
    this.opts = { ...DEFAULT_CLAUDE_OPTIONS, ...opts };
  }

  async generateWorld(input: WorldInput): Promise<WorldResponse> {
    const started = Date.now();
    const seed = input.seed ?? randomSeed();
    const model = this.models.world;
    const fallback = (why: string): WorldResponse => {
      log.warn(`[ai] world fallback: ${why}`);
      return { world: generateFallbackWorld(seed), source: "fallback", model: "fallback", latencyMs: Date.now() - started };
    };
    try {
      const msg = await this.client.beta.messages.create(
        {
          ...modelParams(model, "medium", this.worldFormat),
          max_tokens: 16_000,
          system: [cached(WORLD_SYSTEM)],
          messages: [
            {
              role: "user",
              content: worldUserPrompt({ memory: input.memory, wish: input.wish, recentBiomes: (input.recentBiomes ?? []).slice(0, 3), seed }),
            },
          ],
        },
        { timeout: input.timeoutMs ?? this.opts.worldTimeoutMs, maxRetries: 0, signal: AbortSignal.timeout(input.timeoutMs ?? this.opts.worldTimeoutMs) },
      );
      logUsage("world", msg);
      if (msg.stop_reason !== "end_turn") return fallback(`stop_reason=${msg.stop_reason}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(textOf(msg));
      } catch {
        return fallback("invalid JSON");
      }
      if (parsed && typeof parsed === "object") (parsed as Record<string, unknown>).seed = seed;
      const world = sanitizeWorldSpec(parsed);
      if (!world) return fallback("spec failed validation");
      return { world: { ...world, seed }, source: "claude", model: msg.model || model, latencyMs: Date.now() - started };
    } catch (e) {
      return fallback(describeError(e));
    }
  }

  async director(world: WorldSpec, telemetry: Telemetry, memory: PlayerMemory | null): Promise<DirectorResponse> {
    const started = Date.now();
    const local = (why: string): DirectorResponse => {
      log.warn(`[ai] director fallback: ${why}`);
      const r = localDirector(world, telemetry);
      return { ...r, directives: postProcessDirectives(world, telemetry, r.directives), latencyMs: Date.now() - started };
    };
    try {
      const msg = await this.client.beta.messages.create(
        {
          ...modelParams(this.models.director, "low"),
          max_tokens: 4_000,
          system: [cached(DIRECTOR_SYSTEM)],
          tools: this.tools,
          tool_choice: { type: "auto" },
          messages: [
            {
              role: "user",
              content: [cached(directorStableBlock(world, memory)), { type: "text", text: directorTelemetryBlock(telemetry) }],
            },
          ],
        },
        { timeout: this.opts.directorTimeoutMs, maxRetries: 1, signal: AbortSignal.timeout(this.opts.directorTimeoutMs) },
      );
      logUsage("director", msg);
      if (msg.stop_reason === "refusal" || msg.stop_reason === "max_tokens") return local(`stop_reason=${msg.stop_reason}`);
      const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      const raw = uses.map((b) => ({ ...(b.input && typeof b.input === "object" ? (b.input as object) : {}), tool: b.name }));
      const parsed = parseDirectives(raw);
      if (uses.length > 0 && parsed.length === 0) return local("all tool calls invalid");
      const reasoning = textOf(msg).trim().slice(0, 400);
      return {
        directives: postProcessDirectives(world, telemetry, parsed),
        reasoning,
        model: msg.model || this.models.director,
        latencyMs: Date.now() - started,
      };
    } catch (e) {
      return local(describeError(e));
    }
  }

  async *narrate(req: NarrateRequest, memory: PlayerMemory | null, signal?: AbortSignal): AsyncIterable<string> {
    const timeout = AbortSignal.timeout(this.opts.narratorTimeoutMs);
    const stream = this.client.beta.messages.stream(
      {
        ...modelParams(this.models.narrator, "low"),
        // Thinking is always on and counts toward max_tokens; leave headroom
        // beyond the ~300 tokens the line itself needs.
        max_tokens: 1_024,
        system: [cached(NARRATOR_SYSTEM)],
        messages: [{ role: "user", content: narratorUserPrompt(req, req.world, memory) }],
      },
      { maxRetries: 1, timeout: this.opts.narratorTimeoutMs, signal: signal ? AbortSignal.any([signal, timeout]) : timeout },
    );
    let emitted = 0;
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        // Hard cap on what we forward, whatever the model does.
        const room = 400 - emitted;
        if (room <= 0) continue;
        const text = ev.delta.text.slice(0, room);
        emitted += text.length;
        yield text;
      } else if (ev.type === "message_delta" && ev.delta.stop_reason === "refusal" && emitted === 0) {
        throw new Error("narration refused");
      }
    }
  }

  async reflect(memory: PlayerMemory, report: RunReport): Promise<ReflectionResult> {
    const fallback = (why: string): ReflectionResult => {
      log.warn(`[ai] reflection fallback: ${why}`);
      return { reflection: heuristicReflection(memory, report), source: "fallback" };
    };
    try {
      const msg = await this.client.beta.messages.create(
        {
          ...modelParams(this.models.director, "low", this.reflectionFormat),
          max_tokens: 4_000,
          system: [cached(REFLECTION_SYSTEM)],
          messages: [{ role: "user", content: reflectionUserPrompt(memory, report) }],
        },
        { timeout: this.opts.reflectionTimeoutMs, maxRetries: 1, signal: AbortSignal.timeout(this.opts.reflectionTimeoutMs) },
      );
      logUsage("reflection", msg);
      if (msg.stop_reason !== "end_turn") return fallback(`stop_reason=${msg.stop_reason}`);
      let json: unknown;
      try {
        json = JSON.parse(textOf(msg));
      } catch {
        return fallback("invalid JSON");
      }
      const p = RunReflectionSchema.safeParse(json);
      if (!p.success) return fallback("reflection failed validation");
      const r = p.data;
      return {
        reflection: {
          ...r,
          summary: r.summary.slice(0, 300),
          epitaph: r.epitaph.slice(0, 140),
          likes: r.likes.map((s) => s.slice(0, 60)),
          dislikes: r.dislikes.map((s) => s.slice(0, 60)),
          nemesis: r.nemesis ? r.nemesis.slice(0, 60) : null,
        },
        source: "claude",
      };
    } catch (e) {
      return fallback(describeError(e));
    }
  }
}

export function createAnthropicClient(apiKey: string): ClaudeClient {
  return new Anthropic({ apiKey, maxRetries: 1 });
}
