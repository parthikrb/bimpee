import { localDirector, RunReportSchema, type EMOTES, type RoomPlayer, type RunReport, type WorldSpec } from "@bimpee/shared";
import type { GameHandle, HudState } from "../../game/contract";
import { api } from "../api";
import { audio, type SfxKind } from "../audio";
import { DirectorLoop, type DirectorResult } from "../director/directorLoop";
import { Narrator } from "../narrator/narrator";
import { cancelSpeech, speak } from "../narrator/tts";
import { otherPlayers, type RoomClient } from "../rooms/roomClient";
import type { RunInfo } from "../store/app";
import { backendUp } from "../store/profile";
import { runStore } from "../store/run";
import { settingsStore } from "../store/settings";

/**
 * One live run: wires the game bus to the director, narrator, music, room
 * and overlay store. Created after the game mounts, disposed before it is
 * destroyed. Everything it registers is torn down in `dispose()`.
 */
export interface RunSessionOpts {
  game: GameHandle;
  run: RunInfo;
  room: RoomClient | null;
  onEnd: (report: RunReport) => void;
}

const SFX_FOR: Partial<Record<string, SfxKind>> = {
  kill: "kill",
  elite_kill: "elite_kill",
  player_hit: "hit",
  level_up: "level_up",
  boon: "boon",
  boss_spawn: "boss_spawn",
};

export class RunSession {
  readonly director: DirectorLoop;
  readonly narrator: Narrator;
  private unsubs: (() => void)[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private ended = false;
  private disposed = false;
  private lastHud: HudState | null = null;
  private lastIntensity: number[] = [];
  private kills = 0;
  private readonly world: WorldSpec;
  private readonly runId: string;
  private readonly startedWall = Date.now();

  constructor(private readonly opts: RunSessionOpts) {
    const { game, run, room } = opts;
    this.world = run.world;
    this.runId = run.runId;
    const rs = runStore.getState();
    rs.reset(run.runId);
    rs.setRoomStatus(room ? room.status : null);

    this.director = new DirectorLoop({
      world: run.world,
      runId: run.runId,
      mode: room ? "room" : "solo",
      fetchDirector: (req, signal) => api.director(req, signal),
      localDirector,
      online: backendUp,
      // false (socket down) => the loop falls back to the local director for this tick
      sendToRoom: (t) => room?.sendTelemetry(t) ?? false,
      onResult: (r) => this.applyDirector(r),
      onStats: (s) => runStore.getState().setDirectorStats(s),
    });

    const voice = run.world.narrator.voice;
    this.narrator = new Narrator({
      world: run.world,
      stream: (req, signal) => api.narrate(req, signal),
      online: backendUp,
      setLine: (fn) => runStore.getState().setSubtitle(fn),
      onLineDone: (text) => {
        if (settingsStore.getState().tts) speak(text, voice);
      },
      onInterrupt: cancelSpeech,
    });

    const actInfo = (act: number) => {
      const a = run.world.arc[act];
      return { name: a?.name ?? `Act ${act + 1}`, beat: a?.beat ?? "" };
    };

    const out = game.out;
    this.unsubs.push(
      out.on("hud", (h) => {
        const prevBoss = this.lastHud?.bossName ?? null;
        this.lastHud = h;
        runStore.getState().setHud(h, actInfo);
        if (!!h.bossName !== !!prevBoss) audio.setBoss(!!h.bossName);
      }),
      out.on("pacing", (p) => {
        runStore.getState().pushPacing(p);
        audio.setPacing(p.musicEnergy, p.musicTension);
        if (this.lastIntensity.length < 240) this.lastIntensity.push(p.intensity);
      }),
      out.on("telemetry", (t) => this.director.onTelemetry(t)),
      out.on("event", (ev) => {
        const kind = SFX_FOR[ev.kind];
        if (kind) audio.sfx(kind);
        if (ev.kind === "kill" || ev.kind === "elite_kill") this.kills++;
        if (ev.kind === "boss_spawn") audio.setBoss(true);
        if (ev.kind === "boss_defeated") audio.setBoss(false);
        this.narrator.onGameEvent(ev);
      }),
      out.on("upgrade_offer", (o) => runStore.getState().setOffer(o.length ? o : null)),
      out.on("player_state", (s) => room?.sendState(s)),
      out.on("banner", (b) => runStore.getState().pushBanner(b.text, b.tone)),
      out.on("directive_applied", (d) => runStore.getState().markDirective(d.directive, d.ok, d.note)),
      out.on("run_end", (report) => this.finish(report)),
    );

    if (room) this.wireRoom(room);

    // Turning narrator voice off mid-sentence should silence it now.
    this.unsubs.push(
      settingsStore.subscribe((s, prev) => {
        if (prev.tts && !s.tts) cancelSpeech();
      }),
    );

    audio.setWorld(run.world);
  }

  pickUpgrade(id: string) {
    if (this.disposed) return;
    this.opts.game.in.emit("pick_upgrade", id);
    runStore.getState().setOffer(null);
    audio.sfx("ui");
  }

  pause() {
    // The game already holds itself paused while an upgrade is on offer; a
    // pause/resume pair would release it early.
    if (this.disposed || this.ended || runStore.getState().upgradeOffer) return;
    this.opts.game.in.emit("pause");
    runStore.getState().setPaused(true);
  }

  resume() {
    if (this.disposed) return;
    this.opts.game.in.emit("resume");
    runStore.getState().setPaused(false);
  }

  /** Asks the game to end the run; synthesizes a report if the game never answers. */
  quit() {
    if (this.disposed || this.ended) return;
    runStore.getState().setPaused(false);
    this.opts.game.in.emit("quit");
    this.later(() => {
      if (!this.ended) this.finish(this.synthesizeReport("quit"));
    }, 1500);
  }

  emote(emote: (typeof EMOTES)[number]) {
    const room = this.opts.room;
    if (!room || this.disposed) return;
    if (room.sendEmote(emote)) runStore.getState().pushEmote({ name: "You", emote, self: true });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.director.dispose();
    this.narrator.dispose();
    cancelSpeech();
  }

  private finish(raw: RunReport) {
    if (this.ended || this.disposed) return;
    if (raw.runId !== this.runId) return;
    this.ended = true;
    const report = sanitizeReport(raw);
    if (report.outcome === "victory") audio.victory();
    else audio.death();
    runStore.getState().setOffer(null);
    // Let the death/victory beat land before switching screens.
    this.later(() => this.opts.onEnd(report), report.outcome === "quit" ? 0 : 1600);
  }

  private applyDirector(r: DirectorResult) {
    if (this.disposed || this.ended) return;
    try {
      if (r.directives.length) this.opts.game.in.emit("directives", r.directives);
    } catch (e) {
      console.error("[bimpee] game rejected directives", e);
    }
    runStore.getState().logDirector({
      t: r.t,
      model: r.model,
      latencyMs: Math.round(r.latencyMs),
      reasoning: r.reasoning,
      source: r.source,
      note: r.note,
      directives: r.directives.map((directive) => ({ directive, status: "pending" as const })),
    });
    for (const d of r.directives) {
      if (d.tool === "narrate") this.narrator.sayDirect(d.line, d.mood);
      else if (d.tool === "set_music") audio.setPacing(d.energy, d.tension);
    }
  }

  private wireRoom(room: RoomClient) {
    const { game } = this.opts;
    const pushGhosts = (players: RoomPlayer[]) => {
      const ghosts = otherPlayers(players, room.selfId);
      runStore.getState().setGhosts(ghosts);
      game.in.emit("ghosts", ghosts);
    };
    if (room.welcome) pushGhosts(room.welcome.players);
    this.unsubs.push(
      room.onStatus((s) => runStore.getState().setRoomStatus(s)),
      room.onMessageType((m) => {
        if (this.disposed) return;
        switch (m.type) {
          case "welcome":
          case "players":
            pushGhosts(m.players);
            break;
          case "left": {
            const ghosts = runStore.getState().ghosts.filter((g) => g.id !== m.id);
            runStore.getState().setGhosts(ghosts);
            game.in.emit("ghosts", ghosts);
            break;
          }
          case "directives":
            this.director.onRoomDirectives(m);
            break;
          case "emote":
            if (m.from !== room.selfId) runStore.getState().pushEmote({ name: m.name, emote: m.emote, self: false });
            break;
          case "error":
            runStore.getState().pushBanner(`Room: ${m.message.slice(0, 60)}`, "info");
            break;
        }
      }),
    );
  }

  private later(fn: () => void, ms: number) {
    this.timers.push(setTimeout(fn, ms));
  }

  private synthesizeReport(outcome: RunReport["outcome"]): RunReport {
    const h = this.lastHud;
    return {
      runId: this.runId,
      worldName: this.world.name,
      worldSeed: this.world.seed,
      biome: this.world.theme.biome,
      outcome,
      durationSec: h?.t ?? (Date.now() - this.startedWall) / 1000,
      score: Math.max(0, Math.round(h?.score ?? 0)),
      kills: Math.max(0, h?.kills ?? this.kills),
      level: Math.max(1, h?.level ?? 1),
      accuracy: 0,
      damageTaken: 0,
      killedBy: null,
      bossDefeated: false,
      highlights: [],
      directivesUsed: runStore
        .getState()
        .directorLog.flatMap((e) => e.directives.map((d) => d.directive.tool))
        .slice(0, 60),
      intensityCurve: downsample(this.lastIntensity, 120),
    };
  }
}

function downsample(xs: number[], max: number): number[] {
  if (xs.length <= max) return xs.map((v) => Math.min(1, Math.max(0, v)));
  const step = xs.length / max;
  return Array.from({ length: max }, (_, i) => Math.min(1, Math.max(0, xs[Math.floor(i * step)] ?? 0)));
}

/** Coerces a game report into something the API schema accepts. */
export function sanitizeReport(r: RunReport): RunReport {
  const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
  const fixed: RunReport = {
    ...r,
    durationSec: Math.max(0, Number.isFinite(r.durationSec) ? r.durationSec : 0),
    score: Math.max(0, Math.round(r.score || 0)),
    kills: Math.max(0, Math.round(r.kills || 0)),
    level: Math.max(1, Math.round(r.level || 1)),
    worldSeed: Math.round(r.worldSeed || 0),
    accuracy: clamp01(r.accuracy),
    damageTaken: Math.max(0, Number.isFinite(r.damageTaken) ? r.damageTaken : 0),
    highlights: (r.highlights ?? []).slice(0, 20).map((s) => String(s).slice(0, 200)),
    directivesUsed: (r.directivesUsed ?? []).slice(-60),
    intensityCurve: downsample(r.intensityCurve ?? [], 240),
  };
  const p = RunReportSchema.safeParse(fixed);
  return p.success ? p.data : fixed;
}
