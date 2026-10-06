import { hashSeed, randomSeed } from "@bimpee/shared";
import {
  generateFallbackCity,
  localFate,
  type CityFateResponse,
  type CityMemory,
  type CitySessionReport,
  type CitySpec,
  type CitySpecResponse,
  type CityTelemetry,
  type CouncilMember,
} from "@bimpee/shared/city";
import type { Models } from "../config";
import { heuristicCityReflection } from "../city/logic";
import { postProcessCityDirectives } from "./cityDirectives";
import type { CityAiService, CityReflectionResult, CitySpecInput, CouncilInput, CouncilUpdate, GazetteInput } from "./cityTypes";
import { cleanText } from "./untrusted";

type Role = CouncilMember["role"];
type Voice = CitySpec["gazette"]["voice"];

/** Canned council lines per role. `{mayor}`, `{city}`, `{stat}` are substituted. */
const COUNCIL_LINES: Record<Role, { warm: string[]; cold: string[]; likes: RegExp; hates: RegExp; stat: (t: CityTelemetry) => string }> = {
  environmentalist: {
    warm: ["{mayor}, I hear you. But look at the sky over {city}: pollution sits at {stat}. Plant me a park and switch a coal plant to wind, and you'll have my vote.", "Every tree we plant is a promise kept, {mayor}. Pollution is {stat}. Keep it falling and I'll stand beside you."],
    cold: ["Pretty words, {mayor}. Pollution is at {stat} and my lungs can count. Show me solar panels, not speeches.", "I've read this script before, {mayor}. Until {city} breathes easier, my answer is no."],
    likes: /\b(park|parks|tree|trees|green|wind|solar|clean|nature|forest)\b/i,
    hates: /\b(coal|factory|factories|industrial|smog|bulldoze)\b/i,
    stat: (t) => `${Math.round(t.pollution * 100)}%`,
  },
  industrialist: {
    warm: ["Now you're talking sense, {mayor}. Industrial demand is {stat}. Give me cheap power and zoned land and {city} will hum.", "Ha! I like the cut of your jib, {mayor}. Factories pay for parks, remember that when the budget's due. Demand's at {stat}."],
    cold: ["{mayor}, sentiment doesn't pay salaries. Industrial demand is {stat} and you're sitting on your hands.", "Another tax, another regulation. Keep this up and the factories leave {city}, and the jobs go with them."],
    likes: /\b(industry|industrial|factory|factories|jobs|tax cut|cheap|power|coal|business)\b/i,
    hates: /\b(tax|taxes|regulation|ban|park|parks)\b/i,
    stat: (t) => `${Math.round(t.demand.industrial * 100)}%`,
  },
  scientist: {
    warm: ["Interesting hypothesis, {mayor}. The data agrees, for once: happiness is {stat}. Fund a school and I'll even buy the coffee.", "Evidence over enthusiasm, {mayor}, and you brought evidence. Happiness at {stat}. Let's run the experiment."],
    cold: ["{mayor}, that is an anecdote, not a plan. Happiness is {stat}. Come back with numbers.", "I ran the figures on your idea. They ran away. Build schools and prepare for disasters, then we'll talk."],
    likes: /\b(school|schools|research|science|data|study|prepare|clinic|evidence)\b/i,
    hates: /\b(cut|cuts|ignore|later|luck|gut)\b/i,
    stat: (t) => `${Math.round(t.happiness * 100)}%`,
  },
  populist: {
    warm: ["The people love it, {mayor}! Happiness is {stat} and climbing. Keep taxes low and the parties loud!", "That's what folks on the street want to hear, {mayor}. Happiness {stat}. Do it and I'll shout it from the rooftops."],
    cold: ["The people are grumbling, {mayor}. Happiness is {stat}. You want my support? Earn theirs first.", "Nobody in {city} voted for that, {mayor}. Lower taxes or I take this to the street."],
    likes: /\b(people|lower taxes|tax cut|festival|party|free|housing|homes)\b/i,
    hates: /\b(raise|tax|taxes|austerity|cut)\b/i,
    stat: (t) => `${Math.round(t.happiness * 100)}%`,
  },
  rival_mayor: {
    warm: ["Hm. Not bad, {mayor}. Not how I'd do it, but not bad. Treasury's at {stat}. Don't let it go to your head.", "Fine, {mayor}, you get this one. I'll be watching the budget: {stat}."],
    cold: ["{mayor}, when I'm mayor of {city}, the first thing I'll fix is whatever you just suggested. Funds: {stat}.", "Bold of you to ask for my vote, {mayor}. The treasury reads {stat}. Voters can read too."],
    likes: /\b(compromise|deal|together|share|credit)\b/i,
    hates: /\b(my way|veto|ignore|whatever)\b/i,
    stat: (t) => `$${t.funds.toLocaleString("en-US")}`,
  },
  historian: {
    warm: ["Ah, {mayor}, a decision the archives will remember kindly. {city} is {stat} days old and already has a story worth keeping.", "My predecessors would approve, {mayor}. Day {stat}, and {city} honours its past. Carry on."],
    cold: ["{mayor}, cities that forget their history repeat its disasters. Day {stat}, and you're already forgetting.", "Bulldozing for progress again? Every old street in {city} has a name, {mayor}. Learn them."],
    likes: /\b(history|heritage|landmark|monument|museum|old|preserve|tradition)\b/i,
    hates: /\b(bulldoze|demolish|tear down|replace|modern)\b/i,
    stat: (t) => String(t.day),
  },
};

/** Canned gazette articles per voice. `{event}`, `{city}` are substituted; first line is the headline. */
const GAZETTE_LINES: Record<Voice, string[]> = {
  tabloid: ["SHOCK IN {city}!\n\n{event}! Residents are reeling, gossip is flowing and nobody is admitting anything. Our sources say this is only the beginning."],
  broadsheet: ["{city} responds to developments\n\n{event}. Officials urged calm while council members debated the implications. A fuller account will follow in tomorrow's edition."],
  deadpan: ["Thing happens in {city}\n\n{event}. Most residents noticed. Several did not. Life continued, mostly."],
  hype: ["{city} IS UNSTOPPABLE\n\n{event}, and honestly? Best. City. Ever. Everyone is talking about it and the future has never looked brighter!"],
  noir: ["Rain on {city}\n\n{event}. The streetlights flickered like they knew something. In this town, nothing stays buried for long."],
};

async function* words(text: string, signal?: AbortSignal, delayMs = 0): AsyncIterable<string> {
  const parts = text.split(" ");
  for (let i = 0; i < parts.length; i++) {
    if (signal?.aborted) return;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    yield i === 0 ? parts[i]! : ` ${parts[i]}`;
  }
}

const lastMayorMessage = (input: CouncilInput) => [...input.history].reverse().find((h) => h.from === "mayor")?.text ?? "";

/**
 * Keyless stand-in for the city's Claude features: fallback city specs, the
 * rule-based localFate, persona-flavoured canned council replies, canned
 * gazette articles per voice and heuristic reflections.
 */
export class MockCityAiService implements CityAiService {
  readonly enabled = false;
  constructor(
    readonly models: Models,
    private readonly opts: { delayMs?: number } = {},
  ) {}

  async designCity(input: CitySpecInput): Promise<CitySpecResponse> {
    const seed = input.seed ?? randomSeed();
    return { spec: generateFallbackCity(seed), source: "fallback", model: "mock", latencyMs: 0 };
  }

  async fate(spec: CitySpec, telemetry: CityTelemetry): Promise<CityFateResponse> {
    const r = localFate(spec, telemetry);
    return { directives: postProcessCityDirectives(spec, telemetry, r.directives), reasoning: r.reasoning, model: "local", latencyMs: 0 };
  }

  async *councilReply(input: CouncilInput, signal?: AbortSignal): AsyncIterable<string> {
    const lines = COUNCIL_LINES[input.member.role];
    const msg = lastMayorMessage(input);
    const tone = lines.hates.test(msg) && !lines.likes.test(msg) ? "cold" : input.memberMemory.approval < -0.3 && !lines.likes.test(msg) ? "cold" : "warm";
    const options = lines[tone];
    const base = options[hashSeed(`${input.member.id}:${input.history.length}:${msg}`) % options.length]!;
    const text = base
      .replaceAll("{mayor}", cleanText(input.mayorName, 24) || "Mayor")
      .replaceAll("{city}", cleanText(input.spec.name, 60) || "this city")
      .replaceAll("{stat}", lines.stat(input.telemetry));
    yield* words(text, signal, this.opts.delayMs);
  }

  async councilUpdate(input: CouncilInput, _reply: string): Promise<CouncilUpdate> {
    const lines = COUNCIL_LINES[input.member.role];
    const msg = lastMayorMessage(input);
    const liked = lines.likes.test(msg);
    const hated = lines.hates.test(msg);
    const approvalDelta = liked && !hated ? 0.08 : hated && !liked ? -0.08 : 0.01;
    const snippet = cleanText(msg, 100);
    const notes = liked || hated ? [`${liked ? "The mayor seemed to back me" : "The mayor pushed against me"} on day ${input.telemetry.day}: "${snippet}"`] : [];
    return { approvalDelta, notes };
  }

  async *gazette(input: GazetteInput, signal?: AbortSignal): AsyncIterable<string> {
    const options = GAZETTE_LINES[input.spec.gazette.voice];
    const event = cleanText(input.event, 200).replace(/[.!?]+$/, "") || "Something happened";
    const text = options[hashSeed(event) % options.length]!.replaceAll("{event}", event).replaceAll("{city}", cleanText(input.spec.name, 60) || "Town");
    yield* words(text, signal, this.opts.delayMs);
  }

  async reflectCity(memory: CityMemory, report: CitySessionReport): Promise<CityReflectionResult> {
    return { reflection: heuristicCityReflection(memory, report), source: "fallback" };
  }
}
