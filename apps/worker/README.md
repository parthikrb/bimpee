# @bimpee/worker

Cloudflare Worker (Hono) serving the Bimpee API under `/api/*` (the roguelite
and **Bimpee City** under `/api/city/*`), plus the
`WorldRoom` Durable Object (partyserver) for shared-world rooms at
`/parties/world-room/:roomId`. The HTTP and room contracts live in
`packages/shared/src` (`api.ts`, `room.ts`, `city/*.ts`).

## Local development (zero keys)

```bash
pnpm --filter @bimpee/worker dev      # wrangler dev on :8787
```

With no secrets configured the worker runs in **mock mode**:

| Piece | Mock mode | Real mode |
|---|---|---|
| AI | `MockAiService`: deterministic fallback worlds, the rule-based `localDirector`, canned streamed narration, heuristic reflections | Claude via `@anthropic-ai/sdk` (enabled by `ANTHROPIC_API_KEY`) |
| City AI | `MockCityAiService`: `generateFallbackCity`, `localFate`, canned persona replies per council role (streamed word by word, small approval changes), canned gazette articles per voice, heuristic session reflection | `ClaudeCityAiService` (same key) |
| Landmark models | provider disabled → `unavailable` (landmarks use their fallback shape) | text-to-3D provider + R2 cache (see below) |
| Memory / leaderboard | In-memory, per isolate (lost on restart) | Supabase Postgres (enabled by `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`) |
| Auth | `x-bimpee-guest: <uuid>` header | `Authorization: Bearer <supabase access token>` (anonymous sign-ins count). The guest header is **rejected**. |
| CORS | `ALLOWED_ORIGINS` + `http://localhost:5173` | `ALLOWED_ORIGINS` (+ localhost only if `ENVIRONMENT=development`) |

The two switches are independent: you can run Claude with in-memory storage, or Supabase with the mock AI.
`GET /api/health` reports which mode is active.

Copy `.dev.vars.example` to `.dev.vars` to set anything locally.

## Environment

| Name | Kind | Default | Notes |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | secret | – | Enables Claude. |
| `SUPABASE_URL` | secret/var | – | Enables Supabase memory + auth (needs the key below too). |
| `SUPABASE_SERVICE_ROLE_KEY` | secret | – | Server-side only; bypasses RLS. Never ship to the web app. |
| `WORLD_MODEL` / `DIRECTOR_MODEL` / `NARRATOR_MODEL` | var | `claude-opus-5-5` | Exact model ids. Reflection uses `DIRECTOR_MODEL`. |
| `ALLOWED_ORIGINS` | var | `""` | Comma-separated exact origins, e.g. `https://bimpee.example.com`. |
| `ENVIRONMENT` | var | `production` | `development` allows localhost origins. |
| `LOG_LEVEL` | var | `info` | `debug` logs token usage incl. `cache_read_input_tokens`. |
| `AI_LIMITER` | binding | 30 req / 60 s | Per-user limit on Claude-backed routes (and per-room for rooms). Without it an in-isolate limiter is used. City saves (`save:`) and landmark requests (`lm:`) use separate per-user buckets of the same limiter. |
| `MODELS` | R2 binding | – | Bimpee City landmark GLBs (`models/<sha256>.glb`; plus `meta/<sha256>.json` when Supabase is absent). Optional: without it `wrangler dev` keeps models in memory and production disables generation. Commented out in `wrangler.jsonc`; create the bucket with `npx wrangler r2 bucket create bimpee-models`. |
| `TEXT_TO_3D_PROVIDER` | var | `disabled` | `meshy` \| `disabled`. **Meshy is not implemented yet** (its API docs could not be verified when this was written); `meshy` logs a warning and behaves like `disabled`. |
| `MESHY_API_KEY` | secret | – | Reserved for the Meshy provider. |
| `LANDMARK_USER_DAILY_LIMIT` | var | `5` | New (paid) generations per user per UTC day. Cached prompts are free. |
| `LANDMARK_GLOBAL_DAILY_LIMIT` | var | `200` | New generations across all users per UTC day (cost guard). |

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
# set ALLOWED_ORIGINS in wrangler.jsonc (vars) or the dashboard
pnpm --filter @bimpee/worker deploy
```

## Database

Schema: `supabase/migrations/0001_init.sql` (profiles, player_memory, run_summaries, leaderboard view, new-user trigger, RLS) and
`supabase/migrations/0002_city.sql` (Bimpee City):

- `game_memory (user_id, game, memory jsonb)`: per-game memory documents. `game = 'city'` holds `CityMemory`; `game = 'city_meta'` holds worker bookkeeping (reported city ids so `citiesFounded` counts each city once, recent climates, the landmark quota).
- `city_saves (user_id, id, city_name, day, population, body jsonb)`: max 10 per player, enforced by the worker (409) and by a `before insert` trigger (concurrent creates).
- `landmark_models (hash, prompt, status, provider_job, r2_key)`: the text-to-3D cache. RLS on with no policies and no grants for `anon`/`authenticated`: service role only.

```bash
supabase link --project-ref <ref>
supabase db push
```

Enable **Anonymous sign-ins** in Supabase Auth so players can start without an account. The web app sends the user's access token as a bearer token; the worker verifies it with `auth.getUser`.
All writes go through the worker with the service-role key. RLS lets a user read only their own rows; the leaderboard view is not granted to `anon`/`authenticated` and is served by `GET /api/leaderboard`.

## Routes

| Route | Auth | Notes |
|---|---|---|
| `GET /api/health` | – | modes + model ids |
| `GET /api/leaderboard?scope=daily\|all` | – | top 20 (daily = since 00:00 UTC) |
| `GET /api/memory` | ✓ | `x-bimpee-name` header sets the display name (sanitised, ≤ 24 chars) on any authed route |
| `POST /api/world` | ✓ rate-limited | Claude world (structured output) or fallback; `source` says which |
| `POST /api/director` | ✓ rate-limited | Claude director (one tool per directive) or `localDirector` (`model: "local"`) |
| `POST /api/narrate` | ✓ rate-limited | SSE: `data: {"text":…}` chunks, optional `data: {"error":…}`, always ends with `data: {"done":true}` |
| `POST /api/runs` | ✓ rate-limited | reflection → memory merge → run row; `409` if the `runId` was already recorded; `rank` = 1-based all-time position (null for score 0) |
| `WS /parties/world-room/:roomId` | – (guests) | room protocol in `packages/shared/src/room.ts`; max 8 players |
| `GET /api/city/memory` | ✓ | `CityMemory` (mayor name from the profile / `x-bimpee-name`) |
| `POST /api/city/spec` | ✓ rate-limited | Claude `CitySpec` (structured output, effort `medium`, `WORLD_MODEL`) from the memory digest + wish + recent climates; requested seed forced; `generateFallbackCity` on timeout/failure (`source` says which) |
| `POST /api/city/fate` | ✓ rate-limited | Fate tick: one strict tool per `CityDirective` (effort `low`, `DIRECTOR_MODEL`, 9 s, aborted on client disconnect) or `localFate` (`model: "local"`). Rules enforced in code: ≤ 3 directives, one per tool, ≤ 1 disaster (allowed kind, day ≥ 5, none active, frequency > 0, coordinates clamped), motions only from existing members and while < 2 are open |
| `POST /api/city/council` | ✓ rate-limited | SSE: `{"text"}` chunks (≤ 120 words), then `{"memory": CouncilMemory}`, then `{"done":true}`; on failure `{"error"}` then done. Approval change bounded to ±0.2 per conversation, ≤ 2 new notes, last 8 kept |
| `POST /api/city/gazette` | ✓ rate-limited | SSE: one article (headline line, blank line, 2-3 sentences, ≤ 90 words), then done |
| `POST /api/city/session` | ✓ rate-limited | `{summary}`; reflection (structured, effort `low`) merged into `CityMemory`: traits, bestPopulation, disastersSurvived (highlights naming a disaster), recentCities (5), citiesFounded (+1 only the first time a `cityId` is reported) |
| `GET /api/city/saves` | ✓ | `{saves: CitySaveMeta[]}`, newest first, own saves only |
| `PUT /api/city/saves/:id` | ✓ save-limited | `CitySaveBody`, ≤ 1.4 MiB body, id `^[a-z0-9-]{3,64}$`; 409 when creating an 11th save |
| `GET /api/city/saves/:id` | ✓ | `CitySaveBody`; 404 for other users' saves |
| `POST /api/city/landmark` | ✓ landmark-limited | `{prompt}` → `{status: ready\|pending\|unavailable, url, retryMs}`; 429 when the daily generation quota is used up |
| `GET /api/city/models/:hash` | – | the cached GLB (`model/gltf-binary`, `cache-control: public, max-age=31536000, immutable`). Public on purpose: content-addressed, no user data, and GLTF loaders fetch without auth headers |

Errors are JSON `{ "error": "…" }` with 400 / 401 / 404 / 409 / 413 / 429 / 500.

## Claude usage

- Opus 5.5: no `thinking` parameter (always on); depth via `output_config.effort` (world `medium`, director / narrator / reflection `low`); `effort` omitted for `claude-haiku*` models.
- `tool_choice: auto` (forced tool choice is rejected by Opus 5.5); no prefill; `stop_reason` checked on every call (`refusal` / `max_tokens` → local fallback).
- Server-side refusal fallbacks (`betas: ["server-side-fallback-2026-07-01"], fallbacks: "default"`) for Opus/Sonnet/Fable 5.x via `client.beta.messages`.
- Prompt caching: static system prompts with `cache_control`, deterministic tool list, and for the director a cached world+memory block before the volatile telemetry block.
- Strict tools / structured outputs use `toApiSchema` (`src/ai/schema.ts`), which strips keywords the API doesn't accept and moves ranges into descriptions; answers are re-validated with the shared zod schemas.
- Timeouts: world 25 s (rooms 20 s), director 9 s, narrator 12 s, reflection 15 s; `maxRetries` ≤ 1.
- Player text (wish, names, telemetry strings, run highlights) is cleaned, length-limited and only placed in tagged data sections that the system prompt marks as untrusted.
- Bimpee City: the client-held spec is re-validated with `sanitizeCitySpec` on every request; council chat history is placed in a `<conversation>` data section (the mayor's turns in `<mayor_message>` tags, never as real assistant turns) and the persona prompt forbids role changes and prompt disclosure. Fate caches its system prompt, tools and the spec+mayor block; only telemetry is volatile. Timeouts: spec 25 s, Fate 9 s, council 15 s (+ 8 s memory update), gazette 12 s, reflection 15 s; no retries.

## Landmark models (text-to-3D)

`src/city/textTo3d.ts` defines `TextTo3DProvider { start(prompt) → jobId; poll(jobId) → {status, glbUrl?}; assetHosts }`.
Only `DisabledProvider` ships today: Meshy's docs were unreachable when this was written, so its API was not guessed.
`LandmarkService` (`src/city/landmarks.ts`) does the rest, independent of the provider:

- cache key `sha256(normalised prompt)`; a `ready` model is served to everyone for free;
- a new generation costs one unit of the user's daily quota and counts toward the global daily cap;
- each request advances a pending job by at most one provider poll (≥ 3 s apart); jobs expire after 20 min; failed prompts are not retried for 6 h;
- downloads only from `https` URLs on the provider's `assetHosts` (no credentials, no custom port, `redirect: "manual"`), ≤ 15 MB, 25 s timeout, and the bytes must be a valid binary glTF 2.0 (`glTF` magic, version 2, matching length) before they are stored.

## Layout

```
src/index.ts          entry: /parties/* -> partyserver, everything else -> Hono app
src/app.ts            createApp(deps): routes, CORS, body limit, auth, rate limit
src/deps.ts           builds deps from env (mock vs real)
src/http.ts           HttpError, readBody, checked
src/ai/               claude.ts (ClaudeAiService), mock.ts, prompts.ts, schema.ts, directives.ts
src/ai/city*.ts       ClaudeCityAiService, MockCityAiService, city prompts, Fate tools + rules
src/city/             routes.ts (/api/city/*), logic.ts (memory merges), landmarks.ts, textTo3d.ts, blobs.ts
src/memory/           MemoryRepo + InMemoryRepo + SupabaseMemoryRepo
src/auth.ts           GuestAuth / SupabaseAuth
src/room/core.ts      RoomCore: pure, testable room logic
src/room/worldRoom.ts WorldRoom extends partyserver Server (thin adapter)
```

## Checks

```bash
npx tsc -p .                                  # typecheck
npx vitest run                                # unit tests (no network, no workerd)
npx wrangler deploy --dry-run --outdir dist   # bundle check
```
