# @bimpee/worker

Cloudflare Worker (Hono) serving the Bimpee API under `/api/*`, plus the
`WorldRoom` Durable Object (partyserver) for shared-world rooms at
`/parties/world-room/:roomId`. The HTTP and room contracts live in
`packages/shared/src` (`api.ts`, `room.ts`).

## Local development (zero keys)

```bash
pnpm --filter @bimpee/worker dev      # wrangler dev on :8787
```

With no secrets configured the worker runs in **mock mode**:

| Piece | Mock mode | Real mode |
|---|---|---|
| AI | `MockAiService`: deterministic fallback worlds, the rule-based `localDirector`, canned streamed narration, heuristic reflections | Claude via `@anthropic-ai/sdk` (enabled by `ANTHROPIC_API_KEY`) |
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
| `AI_LIMITER` | binding | 30 req / 60 s | Per-user limit on Claude-backed routes (and per-room for rooms). Without it an in-isolate limiter is used. |

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
# set ALLOWED_ORIGINS in wrangler.jsonc (vars) or the dashboard
pnpm --filter @bimpee/worker deploy
```

## Database

Schema: `supabase/migrations/0001_init.sql` (profiles, player_memory, run_summaries, leaderboard view, new-user trigger, RLS).

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

Errors are JSON `{ "error": "…" }` with 400 / 401 / 404 / 409 / 413 / 429 / 500.

## Claude usage

- Opus 5.5: no `thinking` parameter (always on); depth via `output_config.effort` (world `medium`, director / narrator / reflection `low`); `effort` omitted for `claude-haiku*` models.
- `tool_choice: auto` (forced tool choice is rejected by Opus 5.5); no prefill; `stop_reason` checked on every call (`refusal` / `max_tokens` → local fallback).
- Server-side refusal fallbacks (`betas: ["server-side-fallback-2026-07-01"], fallbacks: "default"`) for Opus/Sonnet/Fable 5.x via `client.beta.messages`.
- Prompt caching: static system prompts with `cache_control`, deterministic tool list, and for the director a cached world+memory block before the volatile telemetry block.
- Strict tools / structured outputs use `toApiSchema` (`src/ai/schema.ts`), which strips keywords the API doesn't accept and moves ranges into descriptions; answers are re-validated with the shared zod schemas.
- Timeouts: world 25 s (rooms 20 s), director 9 s, narrator 12 s, reflection 15 s; `maxRetries` ≤ 1.
- Player text (wish, names, telemetry strings, run highlights) is cleaned, length-limited and only placed in tagged data sections that the system prompt marks as untrusted.

## Layout

```
src/index.ts          entry: /parties/* -> partyserver, everything else -> Hono app
src/app.ts            createApp(deps): routes, CORS, body limit, auth, rate limit
src/deps.ts           builds deps from env (mock vs real)
src/ai/               claude.ts (ClaudeAiService), mock.ts, prompts.ts, schema.ts, directives.ts
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
