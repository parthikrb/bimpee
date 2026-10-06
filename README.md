# Bimpee

A browser roguelite where **Claude designs a new world before every run** and an **AI director steers the pacing while you play**. The game remembers you between runs: your skill, your nemesis, what you enjoy.

- **World Director**: before each run Claude writes a *World Spec*: theme, palette, weather, map layout, an enemy roster built from behaviour blocks, a boss, the music's key/scale/tempo, a narrator persona and a three-act arc, tuned to your memory and an optional wish ("something underwater and spooky"). The engine turns that spec into the scene, so a bad answer can never break the game: specs are schema-validated, repaired, or replaced by a deterministic fallback.
- **Two-layer AI director**: an in-browser pacing controller (Left 4 Dead-style build → peak → relax) runs every frame. Every ~15s Claude reads telemetry and calls tools (`set_intensity_target`, `adjust_spawns`, `inject_event`, `spawn_boss`, `shift_biome`, `mutate_enemies`, `grant_boon`, `narrate`, `set_music`) to move the controller's targets and create story moments.
- **Narrator**: streamed commentary in the world's persona that references your past runs; optional text-to-speech.
- **Adaptive music**: Tone.js builds the soundtrack from the spec; layers follow intensity, bosses add tension, death slows it down.
- **Shared worlds**: daily and invite-code rooms where everyone plays the same world, sees each other as ghosts, and one director runs encounters for the whole group.
- **Director debug HUD** (press <kbd>`</kbd>): live intensity vs target, phase, and every director decision with Claude's reasoning and latency.

## Architecture

```
apps/web        Vite + React 19 + Three.js + postprocessing + Tailwind 4 + Motion + Zustand
  src/app         shell: screens, director loop, narrator, Tone.js music, rooms, Supabase auth
  src/game        Three.js third-person 3D renderer + a renderer-free simulation (headless-testable)
apps/worker     Cloudflare Worker (Hono) + Anthropic SDK + Supabase + partyserver Durable Object rooms
packages/shared zod contracts used by both: WorldSpec, Directive, Telemetry, PacingController,
                PlayerMemory, room protocol, API types, offline fallbacks
supabase/       Postgres schema with RLS (profiles, player_memory, run_summaries, leaderboard)
```

| Concern | Choice |
|---|---|
| Models | `claude-opus-5-5` everywhere by default; per-route effort: world `medium`, director/narrator/reflection `low`. Override per route with `WORLD_MODEL` / `DIRECTOR_MODEL` / `NARRATOR_MODEL`. |
| Reliability | Every AI call has a timeout and a local fallback (fallback world, rule-based director, heuristic reflection); server-side refusal fallbacks are enabled; directives are validated and rule-checked in code. |
| Cost | Prompt caching (stable system prompt, tools and world spec first), per-user and per-room rate limits, ≤4 directives per tick, one in-flight director call per client. |
| Memory | Supabase anonymous sign-in on first visit (with optional email upgrade). Claude reflects on each run, and the reflection is merged into the profile via EMA. |

## Run it

```bash
pnpm install
pnpm --filter @bimpee/worker dev   # :8787. With no keys it runs in mock mode (fallback worlds, local director)
pnpm --filter @bimpee/web dev      # :5173, proxies /api and /parties to the worker
```

The game is fully playable with **no keys and even no worker**. To turn on the real AI and memory:

1. `apps/worker/.dev.vars`: `ANTHROPIC_API_KEY=...` (plus `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` for memory). See `apps/worker/.dev.vars.example`.
2. Supabase: enable Anonymous sign-ins, then `supabase db push`.
3. `apps/web/.env.local`: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. See `apps/web/.env.example`.

Deploy notes are in [`apps/worker/README.md`](apps/worker/README.md).

## Checks

```bash
pnpm typecheck && pnpm test && pnpm build
```

## Controls

Third-person chase camera. Click the game to lock the mouse: the mouse turns the camera and aims at the crosshair (with soft aim assist) · WASD moves relative to the camera · hold left button to fire, F toggles auto-fire · Space/Shift dash · Q/E turn the camera when the mouse isn't locked · 1/2/3 pick upgrades · Esc pause · <kbd>`</kbd> director HUD. Touch: left-half joystick, drag the right half to turn, aim and fire are automatic, dash button.
