import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EMOTES } from "@bimpee/shared";
import type { GameHandle } from "../../game/contract";
import { displayName } from "../api/identity";
import { goTitle, onRunEnded } from "../flow";
import { ActCardOverlay, Hud } from "../hud/Hud";
import { Banners } from "../hud/Banners";
import { DirectorDebug } from "../hud/DirectorDebug";
import { PauseMenu } from "../hud/PauseMenu";
import { EmoteWheel, RoomOverlay } from "../hud/RoomOverlay";
import { Subtitles } from "../hud/Subtitles";
import { UpgradePicker } from "../hud/UpgradePicker";
import { currentRoom } from "../rooms";
import { RunSession } from "../run/session";
import { useApp } from "../store/app";
import { runStore, useRun } from "../store/run";
import { settingsStore, useSettings } from "../store/settings";

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);

export function PlayScreen() {
  const run = useApp((s) => s.run);
  const mode = useApp((s) => s.mode);
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<RunSession | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [wheelOpen, setWheelOpen] = useState(false);
  const paused = useRun((s) => s.paused);
  const offer = useRun((s) => s.upgradeOffer);
  const debugOpen = useSettings((s) => s.debugOpen);
  const runId = run?.runId;

  // Mount the game. StrictMode-safe: the dynamic import resolves after a
  // dev double-unmount, so the `disposed` flag prevents a ghost instance.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !run) return;
    let disposed = false;
    let handle: GameHandle | null = null;
    let session: RunSession | null = null;
    setReady(false);
    setLoadError(null);
    import("../../game")
      .then(({ createGame }) => {
        if (disposed) return;
        handle = createGame(el, {
          world: run.world,
          runId: run.runId,
          players: run.players,
          startOffsetSec: run.startOffsetSec,
          playerName: displayName(),
        });
        session = new RunSession({ game: handle, run, room: mode.kind === "room" ? currentRoom() : null, onEnd: onRunEnded });
        sessionRef.current = session;
        setReady(true);
      })
      .catch((e: unknown) => {
        if (!disposed) setLoadError(e instanceof Error ? e.message : "The game failed to load.");
      });
    return () => {
      disposed = true;
      session?.dispose();
      if (sessionRef.current === session) sessionRef.current = null;
      try {
        handle?.destroy();
      } catch {
        /* game already torn down */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const pause = useCallback(() => sessionRef.current?.pause(), []);
  const resume = useCallback(() => sessionRef.current?.resume(), []);
  const quit = useCallback(() => sessionRef.current?.quit(), []);
  const sendEmote = useCallback((e: (typeof EMOTES)[number]) => sessionRef.current?.emote(e), []);
  const closeWheel = useCallback(() => setWheelOpen(false), []);

  // Global keys. Modal overlays (upgrade picker, emote wheel) capture their own keys first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.repeat) return;
      const { paused: isPaused, upgradeOffer } = runStore.getState();
      const st = { paused: isPaused, offer: !!upgradeOffer };
      if (e.key === "Escape") {
        e.preventDefault();
        if (st.offer) return;
        if (st.paused) resume();
        else pause();
      } else if (e.key === "`" || e.code === "Backquote") {
        e.preventDefault();
        settingsStore.getState().toggle("debugOpen");
      } else if (e.key === "m" || e.key === "M") {
        settingsStore.getState().toggle("muted");
      } else if ((e.key === "t" || e.key === "T") && mode.kind === "room" && !st.offer && !st.paused) {
        e.preventDefault();
        setWheelOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pause, resume, mode.kind]);

  // Tabbing away pauses (solo) so nobody dies in a background tab.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "hidden" && mode.kind === "solo") pause();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [pause, mode.kind]);

  if (!run) return null;

  return (
    <main className="fixed inset-0 overflow-hidden bg-world" aria-label={`Playing ${run.world.name}`}>
      <div ref={containerRef} className="absolute inset-0 touch-none select-none" />
      {/* Overlays: pointer-events-none by default so the canvas (and touch joystick) keep input. */}
      <div className="pointer-events-none absolute inset-0">
        <Hud onPause={pause} />
        <ActCardOverlay />
        <Banners />
        <Subtitles narrator={run.world.narrator} />
        {mode.kind === "room" && <RoomOverlay roomId={mode.roomId} onOpenWheel={() => setWheelOpen(true)} />}
        <AnimatePresence>{debugOpen && <DirectorDebug key="debug" />}</AnimatePresence>
      </div>
      <AnimatePresence>
        {offer && !paused && (
          <motion.div key="offer" className="absolute inset-0 z-40">
            <UpgradePicker options={offer} onPick={(id) => sessionRef.current?.pickUpgrade(id)} />
          </motion.div>
        )}
        {wheelOpen && !offer && !paused && <EmoteWheel key="wheel" onSend={sendEmote} onClose={closeWheel} />}
        {paused && <PauseMenu key="pause" onResume={resume} onQuit={quit} roomMode={mode.kind === "room"} />}
      </AnimatePresence>
      {!ready && !loadError && (
        <div className="absolute inset-0 grid place-items-center bg-world">
          <p className="animate-pulse font-display text-sm uppercase tracking-[0.4em] text-accent-text motion-reduce:animate-none">Entering {run.world.name}…</p>
        </div>
      )}
      {loadError && (
        <div className="absolute inset-0 z-50 grid place-items-center bg-ink/90 px-4 text-center">
          <div className="panel flex max-w-sm flex-col gap-3 p-5">
            <h2 className="font-display text-xl font-black text-danger">The world failed to load</h2>
            <p className="text-sm text-muted">{loadError}</p>
            <button type="button" className="btn btn-neon" onClick={() => goTitle()}>
              Back to title
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
