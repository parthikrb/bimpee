import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useEffect } from "react";
import { initAuth } from "./auth";
import { applyPalette } from "./lib/palette";
import { ForgeScreen } from "./screens/Forge";
import { PlayScreen } from "./screens/Play";
import { ResultsScreen } from "./screens/Results";
import { TitleScreen } from "./screens/Title";
import { checkHealth } from "./services/connectivity";
import { refreshMemory } from "./services/memory";
import { appStore, useApp, type AppState } from "./store/app";
import { profileStore } from "./store/profile";

/** The world currently on screen (drives the accent palette), or null on the title. */
function screenWorld(s: AppState) {
  if (s.screen === "forge") return s.forge?.status === "ready" ? (s.forge.forged?.world ?? null) : null;
  if (s.screen === "play") return s.run?.world ?? null;
  if (s.screen === "results") return s.results?.world ?? null;
  return null;
}

export function App() {
  const screen = useApp((s) => s.screen);

  // Boot: auth (needed for memory) and health in parallel. Idempotent, so StrictMode's double effect is harmless.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([initAuth(), checkHealth()]).then(() => {
      if (!cancelled) void refreshMemory();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-theme the whole shell from the world palette.
  useEffect(() => {
    let last = screenWorld(appStore.getState());
    applyPalette(last?.theme.palette ?? null);
    return appStore.subscribe((s) => {
      const w = screenWorld(s);
      if (w === last) return;
      last = w;
      applyPalette(w?.theme.palette ?? null);
    });
  }, []);

  // While on the title and offline, quietly retry the backend every 30s.
  useEffect(() => {
    if (screen !== "title") return;
    const id = setInterval(() => {
      if (profileStore.getState().ai === "offline") {
        void checkHealth().then((s) => {
          if (s !== "offline") void refreshMemory();
        });
      }
    }, 30_000);
    return () => clearInterval(id);
  }, [screen]);

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence mode="wait">
        <motion.div key={screen} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
          {screen === "title" && <TitleScreen />}
          {screen === "forge" && <ForgeScreen />}
          {screen === "play" && <PlayScreen />}
          {screen === "results" && <ResultsScreen />}
        </motion.div>
      </AnimatePresence>
    </MotionConfig>
  );
}
