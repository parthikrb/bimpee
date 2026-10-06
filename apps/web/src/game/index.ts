import { Bus, type CreateGame, type GameHandle, type ShellToGame } from "./contract";
import { GameView } from "./render3d/GameView";
import { SPAWN_RING_PX } from "./render3d/GameView";
import { spawnViewForRing } from "./render3d/coords";
import { connectCommands } from "./sim/commands";
import { Sim } from "./sim/Sim";
import { IDLE_INPUT, type SimInput } from "./sim/types";

export type { GameHandle } from "./contract";

const HEADLESS_INPUT: SimInput = { ...IDLE_INPUT, ...spawnViewForRing(SPAWN_RING_PX) };

/** Dev-only knobs from the URL (?quality=0..3 locks the quality level for screenshots). */
function devQuality(): { quality?: number; lock?: boolean } {
  if (!import.meta.env.DEV || typeof location === "undefined") return {};
  const q = new URLSearchParams(location.search).get("quality");
  if (q === null) return {};
  const n = Number(q);
  return Number.isFinite(n) ? { quality: n, lock: true } : {};
}

/**
 * Creates the game inside `parent` and returns the typed bus.
 * The simulation exists synchronously (so directives sent before the first
 * frame are applied); the Three.js view only renders it and feeds it input.
 * If WebGL is unavailable the Sim keeps running headless (so the run still
 * ends and reports) and the shell gets a banner. `destroy()` is idempotent
 * and StrictMode-safe.
 */
export const createGame: CreateGame = (parent, opts) => {
  const sim = new Sim(opts);
  const out = sim.out;
  const inn = new Bus<ShellToGame>();
  let destroyed = false;

  let reduced = false;
  const mq = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const onMq = (e: MediaQueryListEvent) => (reduced = e.matches);
  if (mq) {
    reduced = mq.matches;
    mq.addEventListener?.("change", onMq);
  }

  let view: GameView | null = null;
  let webglError: string | null = null;
  try {
    const dq = devQuality();
    view = new GameView(parent, sim, { reducedMotion: () => reduced, quality: dq.quality, lockQuality: dq.lock });
  } catch (err) {
    view = null;
    webglError = err instanceof Error ? err.message : String(err);
    console.warn("[bimpee] WebGL unavailable, running headless:", webglError);
  }

  const offCommands = connectCommands(sim, inn);
  const offs: (() => void)[] = [
    inn.on("ghosts", (list) => view?.setGhosts(Array.isArray(list) ? list : [])),
    // pointer-lock etiquette: hand the mouse back whenever the shell needs it
    inn.on("pause", () => view?.releasePointer()),
    inn.on("quit", () => view?.releasePointer()),
    out.on("upgrade_offer", () => view?.releasePointer()),
    out.on("run_end", () => view?.releasePointer()),
  ];

  let raf = 0;
  let last = -1;
  let fps = 60;
  let first = true;
  const frame = (now: number) => {
    if (destroyed) return;
    raf = requestAnimationFrame(frame);
    if (first) {
      first = false;
      if (webglError) out.emit("banner", { text: "3D graphics are unavailable on this device (WebGL is disabled). The run continues without visuals.", tone: "danger" });
    }
    // clamped real dt; a hidden tab stops rAF, so the first frame back is clamped too
    const raw = last < 0 ? 1 / 60 : Math.max(0, (now - last) / 1000);
    const dt = Math.min(0.1, raw);
    last = now;
    // real frame rate (unclamped, hitches over 1s ignored) for telemetry
    if (raw > 0 && raw < 1) fps += (1 / raw - fps) * 0.05;
    const input = view ? view.readInput(dt) : HEADLESS_INPUT;
    sim.setFps(fps);
    try {
      sim.step(dt, input);
    } catch (err) {
      console.error("[bimpee] sim step failed", err);
    }
    if (sim.paused || sim.ended) view?.releasePointer();
    // animation time: frozen while paused / offering upgrades, crawls in hit-stop, slowed in slow-mo
    const visDt = sim.paused || sim.endEmitted ? 0 : sim.hitstop > 0 ? dt * 0.05 : sim.slowmoT > 0 ? dt * sim.slowmoScale : dt;
    if (view) {
      try {
        view.frame(dt, visDt);
      } catch (err) {
        console.error("[bimpee] render failed, continuing headless", err);
        view.dispose();
        view = null;
      }
    } else sim.fx.length = 0;
  };
  raf = requestAnimationFrame(frame);

  if (import.meta.env.DEV && typeof window !== "undefined") {
    (window as unknown as { __bimpee?: unknown }).__bimpee = { sim, inn, out, view: () => view };
  }

  const handle: GameHandle = {
    out,
    in: inn,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(raf);
      offCommands();
      offs.forEach((f) => f());
      mq?.removeEventListener?.("change", onMq);
      view?.dispose();
      view = null;
      inn.clear();
      out.clear();
      if (import.meta.env.DEV && typeof window !== "undefined") {
        const w = window as unknown as { __bimpee?: { sim: Sim } };
        if (w.__bimpee?.sim === sim) delete w.__bimpee;
      }
    },
  };
  return handle;
};
