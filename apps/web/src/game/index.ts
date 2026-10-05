import * as Phaser from "phaser";
import { Bus, type CreateGame, type GameHandle, type ShellToGame } from "./contract";
import { GameScene, type GhostSystemHost } from "./scenes/GameScene";
import { connectCommands } from "./sim/commands";
import { Sim } from "./sim/Sim";

export type { GameHandle } from "./contract";

/**
 * Creates the Phaser game inside `parent` and returns the typed bus.
 * The simulation exists synchronously (so directives sent before the first
 * frame are applied); Phaser only renders it. `destroy()` is idempotent and
 * StrictMode-safe.
 */
export const createGame: CreateGame = (parent, opts) => {
  const sim = new Sim(opts);
  const out = sim.out;
  const inn = new Bus<ShellToGame>();
  const ghosts: GhostSystemHost = { latest: [], version: 0 };

  const offCommands = connectCommands(sim, inn);
  const offGhosts = inn.on("ghosts", (list) => {
    ghosts.latest = Array.isArray(list) ? list : [];
    ghosts.version++;
  });

  let reduced = false;
  const mq = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const onMq = (e: MediaQueryListEvent) => (reduced = e.matches);
  if (mq) {
    reduced = mq.matches;
    mq.addEventListener?.("change", onMq);
  }

  const scene = new GameScene({ sim, ghosts, reducedMotion: () => reduced });
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    backgroundColor: opts.world.theme.palette.background,
    banner: false,
    audio: { noAudio: true },
    input: { activePointers: 3 },
    render: { antialias: true, powerPreference: "high-performance" },
    scale: {
      mode: Phaser.Scale.RESIZE,
      width: Math.max(1, parent.clientWidth || 800),
      height: Math.max(1, parent.clientHeight || 600),
    },
    scene: scene,
  });

  let destroyed = false;
  const handle: GameHandle = {
    out,
    in: inn,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      offCommands();
      offGhosts();
      mq?.removeEventListener?.("change", onMq);
      // hide immediately; Phaser tears down on its next step
      if (game.canvas) game.canvas.style.display = "none";
      game.destroy(true);
      inn.clear();
      out.clear();
    },
  };
  return handle;
};
