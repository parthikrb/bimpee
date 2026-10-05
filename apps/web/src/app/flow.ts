import { dailyRoomId, runDurationSec, sanitizeWorldSpec, type RunReport } from "@bimpee/shared";
import { displayName } from "./api/identity";
import { audio, preloadAudio, unlockAudio } from "./audio";
import { newRunId } from "./lib/ids";
import { connectRoom, currentRoom, leaveRoom } from "./rooms";
import { roomStartOffset } from "./rooms/roomClient";
import { checkHealth, ensureHealth } from "./services/connectivity";
import { submitRun } from "./services/memory";
import { forgeSoloWorld, offlineRoomWorld, prefetchNextWorld, takePrefetched } from "./services/world";
import { appStore, type ForgedWorld, type Mode } from "./store/app";
import { runStore } from "./store/run";

/**
 * User-intent actions. Components call these; they orchestrate services and
 * advance the screen state machine with stale-safe tokens.
 */

const prefersReducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** The forge animation is part of the show: never flash it for less than this. */
const minForgeMs = () => (prefersReducedMotion() ? 400 : 2400);

let forgeAbort: AbortController | null = null;

function cancelForge() {
  forgeAbort?.abort();
  forgeAbort = null;
}

export function forgeSolo(wish?: string) {
  cancelForge();
  leaveRoom();
  const app = appStore.getState();
  const w = wish ?? app.wish;
  const id = app.beginForge({ kind: "solo" }, w);
  void preloadAudio().catch(() => undefined);
  const ctrl = new AbortController();
  forgeAbort = ctrl;
  void (async () => {
    try {
      const [forged] = await Promise.all([forgeSoloWorld(w, ctrl.signal), delay(minForgeMs())]);
      appStore.getState().forgeResolved(id, forged);
    } catch (e) {
      if (!ctrl.signal.aborted) appStore.getState().forgeFailed(id, e instanceof Error ? e.message : "forge failed");
    }
  })();
}

const WELCOME_TIMEOUT_MS = 7000;

export function forgeRoom(roomId: string) {
  cancelForge();
  const daily = roomId === dailyRoomId();
  const mode: Mode = { kind: "room", roomId, daily };
  const id = appStore.getState().beginForge(mode);
  void preloadAudio().catch(() => undefined);
  const ctrl = new AbortController();
  forgeAbort = ctrl;
  const stillMine = () => !ctrl.signal.aborted && appStore.getState().forge?.requestId === id;

  void (async () => {
    const minDelay = delay(minForgeMs());
    // Backend known to be down: don't make the player watch a socket fail.
    if ((await ensureHealth()) === "offline") {
      await minDelay;
      if (stillMine()) appStore.getState().forgeResolved(id, offlineRoomWorld(roomId));
      return;
    }
    if (!stillMine()) return;
    const room = await connectRoom(roomId, displayName());
    if (!stillMine()) {
      if (room && currentRoom() === room) leaveRoom();
      return;
    }
    let forged: ForgedWorld;
    if (!room) {
      forged = offlineRoomWorld(roomId);
    } else {
      forged = await new Promise<ForgedWorld>((resolve) => {
        const finish = (f: ForgedWorld) => {
          clearTimeout(timer);
          off();
          ctrl.signal.removeEventListener("abort", onAbort);
          resolve(f);
        };
        const timer = setTimeout(() => {
          leaveRoom();
          finish(offlineRoomWorld(roomId));
        }, WELCOME_TIMEOUT_MS);
        const onAbort = () => finish(offlineRoomWorld(roomId));
        ctrl.signal.addEventListener("abort", onAbort);
        const fromWelcome = (w: NonNullable<typeof room.welcome>): ForgedWorld => {
          const world = sanitizeWorldSpec(w.world) ?? w.world;
          return { world, source: "room", model: "room", latencyMs: 0, roomStartedAt: w.startedAt };
        };
        const off = room.onMessageType((m) => {
          if (m.type === "welcome") finish(fromWelcome(m));
          else if (m.type === "error") {
            leaveRoom();
            finish({ ...offlineRoomWorld(roomId), note: `Room said: ${m.message.slice(0, 80)}` });
          }
        });
        if (room.welcome) finish(fromWelcome(room.welcome));
      });
    }
    await minDelay;
    if (!stillMine()) {
      if (currentRoom() === room) leaveRoom();
      return;
    }
    appStore.getState().forgeResolved(id, forged);
  })();
}

export function forgeDaily() {
  forgeRoom(dailyRoomId());
}

/**
 * Start button handler. MUST be called synchronously from the click/key
 * handler: it starts the audio context inside the user gesture.
 */
export function startRun() {
  void unlockAudio();
  const app = appStore.getState();
  const forged = app.forge?.forged;
  if (!forged) return;
  const room = app.mode.kind === "room" ? currentRoom() : null;
  const offset = forged.roomStartedAt && room ? roomStartOffset(forged.roomStartedAt, Date.now(), runDurationSec(forged.world)) : 0;
  const players = room?.welcome ? Math.max(1, room.welcome.players.length) : 1;
  const runId = newRunId();
  // Clear the previous run's overlays before the play screen renders a frame.
  runStore.getState().reset(runId);
  const ok = app.startRun(runId, { players, startOffsetSec: offset });
  if (!ok) return;
  // Solo: forge the next world in the background so "Play again" is instant.
  if (app.mode.kind === "solo") {
    const wish = app.wish;
    setTimeout(() => {
      if (appStore.getState().screen === "play") prefetchNextWorld(wish);
    }, 6000);
  }
}

export function onRunEnded(report: RunReport) {
  const app = appStore.getState();
  if (!app.endRun(report)) return;
  leaveRoom();
  void submitRun(report)
    .then((r) => appStore.getState().reflectionResolved(report.runId, r))
    .catch((e: unknown) => {
      console.error("[bimpee] run submission failed", e);
      appStore.getState().reflectionResolved(report.runId, {
        summary: `${report.worldName}: ${report.kills} kills, ${report.score} points.`,
        epitaph: "The world remembers. So will you.",
        bestScore: report.score,
        rank: null,
        source: "local",
      });
    });
}

export function playAgain() {
  const app = appStore.getState();
  if (app.mode.kind === "room") {
    forgeRoom(app.mode.roomId);
    return;
  }
  audio.setWorld(null);
  const pre = takePrefetched(app.wish);
  if (pre && !(pre instanceof Promise)) {
    cancelForge();
    app.showForged({ kind: "solo" }, pre);
    return;
  }
  if (pre instanceof Promise) {
    cancelForge();
    const id = app.beginForge({ kind: "solo" });
    const ctrl = new AbortController();
    forgeAbort = ctrl;
    pre.then(
      (f) => appStore.getState().forgeResolved(id, f),
      () => {
        if (!ctrl.signal.aborted) forgeSolo();
      },
    );
    return;
  }
  forgeSolo();
}

export function goTitle(opts?: { focusWish?: boolean }) {
  cancelForge();
  leaveRoom();
  audio.stop();
  appStore.getState().toTitle(opts);
  void checkHealth();
}
