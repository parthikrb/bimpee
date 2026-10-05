import { motion } from "motion/react";
import { Crown, House, RotateCcw, Skull, Sparkles, Trophy } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { LeaderboardEntry, RunReport, WorldSpec } from "@bimpee/shared";
import { api } from "../api";
import { goTitle, playAgain } from "../flow";
import { fmtClock, fmtInt, fmtPct, timeAgo } from "../lib/format";
import { VOICE_STYLES } from "../narrator/voices";
import { localLeaderboard } from "../services/memory";
import { prefetchStatus } from "../services/world";
import { useApp, type Reflection } from "../store/app";
import { backendUp, useProfile } from "../store/profile";
import { Backdrop } from "../ui/Backdrop";
import { IntensityChart } from "../ui/charts";

export function ResultsScreen() {
  const results = useApp((s) => s.results);
  const mode = useApp((s) => s.mode);
  const wish = useApp((s) => s.wish);
  const againRef = useRef<HTMLButtonElement>(null);
  const [pre, setPre] = useState(() => prefetchStatus(wish));

  useEffect(() => {
    againRef.current?.focus({ preventScroll: true });
    const id = setInterval(() => setPre(prefetchStatus(wish)), 800);
    return () => clearInterval(id);
  }, [wish]);

  if (!results) return null;
  const { report, world, reflection } = results;

  return (
    <main className="relative min-h-dvh">
      <Backdrop dim />
      <div className="relative z-10 mx-auto flex max-w-5xl flex-col gap-6 px-4 pb-32 pt-10">
        <Headline report={report} world={world} />
        <Epitaph world={world} reflection={reflection} />
        <StatsGrid report={report} reflection={reflection} />

        <section className="panel p-4" aria-labelledby="curve-h">
          <div className="mb-2 flex items-baseline justify-between">
            <h3 id="curve-h" className="label">
              Intensity curve
            </h3>
            <span className="font-mono text-[10px] text-muted">
              <span className="text-accent-text">measured</span> vs <span className="text-pink">director target</span>
            </span>
          </div>
          <IntensityChart curve={report.intensityCurve} world={world} />
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="panel flex flex-col gap-3 p-4" aria-labelledby="story-h">
            <h3 id="story-h" className="label flex items-center gap-1.5">
              <Sparkles className="size-3.5 text-sun" aria-hidden="true" /> The story of your run
            </h3>
            {reflection ? (
              <p className="text-base leading-relaxed">{reflection.summary}</p>
            ) : (
              <div className="flex flex-col gap-2" aria-busy="true" aria-label="Claude is reflecting on your run">
                <div className="skeleton h-4 w-full" />
                <div className="skeleton h-4 w-11/12" />
                <div className="skeleton h-4 w-2/3" />
              </div>
            )}
            {report.highlights.length > 0 && (
              <ul className="flex flex-col gap-1.5">
                {report.highlights.slice(0, 8).map((h, i) => (
                  <motion.li key={i} className="flex gap-2 text-sm text-text/85" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.3 + i * 0.06 }}>
                    <span className="text-accent-text" aria-hidden="true">
                      ▸
                    </span>
                    {h}
                  </motion.li>
                ))}
              </ul>
            )}
            <DirectorSummary report={report} />
          </section>
          <Leaderboard />
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-ink/80 px-4 py-3 backdrop-blur-md" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2">
          <button ref={againRef} type="button" className="btn btn-primary flex-1 !min-h-12" onClick={() => playAgain()}>
            <RotateCcw className="size-4" aria-hidden="true" /> Play again
            {mode.kind === "solo" && pre === "ready" && <span className="hidden font-mono text-[10px] normal-case tracking-normal opacity-70 sm:inline">· next world ready</span>}
          </button>
          <button type="button" className="btn btn-neon" onClick={() => goTitle({ focusWish: true })}>
            <Sparkles className="size-4" aria-hidden="true" /> New wish
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => goTitle()} aria-label="Title screen">
            <House className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </main>
  );
}

function Headline({ report, world }: { report: RunReport; world: WorldSpec }) {
  const cfg =
    report.outcome === "victory"
      ? { text: "World conquered", icon: <Crown className="size-8" />, style: { color: "var(--neon-sun)", textShadow: "0 0 30px var(--neon-sun)" } }
      : report.outcome === "death"
        ? { text: "You died", icon: <Skull className="size-8" />, style: { color: "var(--danger)", textShadow: "0 0 30px var(--danger)" } }
        : { text: "Run abandoned", icon: <House className="size-8" />, style: { color: "var(--muted)" } };
  return (
    <header className="flex flex-col items-center text-center">
      <motion.div initial={{ scale: 0, rotate: -30 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: "spring", bounce: 0.6 }} style={cfg.style} aria-hidden="true">
        {cfg.icon}
      </motion.div>
      <motion.h2
        className="font-display text-[clamp(2.4rem,9vw,5.5rem)] font-black uppercase italic leading-none"
        style={cfg.style}
        initial={{ opacity: 0, scale: 1.4, filter: "blur(10px)" }}
        animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
        transition={{ duration: 0.6 }}
      >
        {cfg.text}
      </motion.h2>
      <p className="mt-2 text-sm text-muted">
        {world.name}
        {report.outcome === "death" && report.killedBy && (
          <>
            {" "}
            · claimed by <span className="text-danger">{report.killedBy}</span>
          </>
        )}
      </p>
    </header>
  );
}

function Epitaph({ world, reflection }: { world: WorldSpec; reflection: Reflection | null }) {
  const v = VOICE_STYLES[world.narrator.voice];
  return (
    <figure className="mx-auto flex max-w-2xl items-start gap-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-full text-xl" style={{ color: v.color, background: `color-mix(in oklab, ${v.color} 15%, transparent)` }} aria-hidden="true">
        {v.glyph}
      </span>
      <div className="min-w-0 flex-1">
        {reflection ? (
          <motion.blockquote className="text-lg italic sm:text-xl" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            “{reflection.epitaph}”
          </motion.blockquote>
        ) : (
          <div className="skeleton mt-1 h-6 w-3/4" aria-label="Loading epitaph" />
        )}
        <figcaption className="mt-1 font-mono text-[11px]" style={{ color: v.color }}>
          {world.narrator.name}
          {reflection?.source === "local" && <span className="text-muted"> · offline reflection</span>}
        </figcaption>
      </div>
    </figure>
  );
}

function StatsGrid({ report, reflection }: { report: RunReport; reflection: Reflection | null }) {
  const best = reflection?.bestScore ?? null;
  const newBest = best !== null && report.score > 0 && report.score >= best;
  const stats: { label: string; value: string; accent?: boolean }[] = [
    { label: "Kills", value: fmtInt(report.kills) },
    { label: "Level", value: String(report.level) },
    { label: "Time", value: fmtClock(report.durationSec) },
    { label: "Accuracy", value: fmtPct(report.accuracy) },
    { label: "Damage taken", value: `${Math.round(report.damageTaken * 100)}% hp` },
    { label: "Boss", value: report.bossDefeated ? "Defeated" : "Standing", accent: report.bossDefeated },
  ];
  return (
    <section className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Run stats">
      <motion.div className="panel panel-glow col-span-2 flex flex-col justify-center p-4" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <span className="label">Score</span>
        <span className="font-display text-4xl font-black tabular-nums neon-text sm:text-5xl">{fmtInt(report.score)}</span>
        <span className="mt-1 flex flex-wrap gap-2 font-mono text-[11px] text-muted">
          {reflection ? (
            <>
              <span>best {fmtInt(reflection.bestScore)}</span>
              {newBest && <span className="text-sun">new personal best!</span>}
              {reflection.rank !== null && (
                <span className="text-accent-text">
                  <Trophy className="mr-0.5 inline size-3" aria-hidden="true" />#{reflection.rank} all-time
                </span>
              )}
            </>
          ) : (
            <span className="skeleton inline-block h-3 w-28" />
          )}
        </span>
      </motion.div>
      {stats.map((s, i) => (
        <motion.div key={s.label} className="panel flex flex-col p-3" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 * (i + 1) }}>
          <span className="label">{s.label}</span>
          <span className={`font-display text-xl font-bold tabular-nums ${s.accent ? "text-boon" : ""}`}>{s.value}</span>
        </motion.div>
      ))}
    </section>
  );
}

function DirectorSummary({ report }: { report: RunReport }) {
  if (!report.directivesUsed.length) return null;
  const counts = new Map<string, number>();
  for (const d of report.directivesUsed) counts.set(d, (counts.get(d) ?? 0) + 1);
  return (
    <div>
      <p className="label mb-1.5">The director pulled</p>
      <div className="flex flex-wrap gap-1.5">
        {[...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => (
            <span key={k} className="chip">
              {k.replace(/_/g, " ")} ×{n}
            </span>
          ))}
      </div>
    </div>
  );
}

function Leaderboard() {
  const [scope, setScope] = useState<"daily" | "all">("daily");
  const [state, setState] = useState<{ status: "loading" } | { status: "ready"; entries: LeaderboardEntry[]; local: boolean }>({ status: "loading" });
  const me = useProfile((s) => s.displayName);
  const memory = useProfile((s) => s.memory);
  const tabsId = useId();

  useEffect(() => {
    const ctrl = new AbortController();
    setState({ status: "loading" });
    if (!backendUp()) {
      setState({ status: "ready", entries: localLeaderboard(), local: true });
      return () => ctrl.abort();
    }
    api.leaderboard(scope, ctrl.signal).then(
      (r) => !ctrl.signal.aborted && setState({ status: "ready", entries: r.entries, local: false }),
      () => !ctrl.signal.aborted && setState({ status: "ready", entries: localLeaderboard(), local: true }),
    );
    return () => ctrl.abort();
    // Refetch when memory changes (our run just landed server-side).
  }, [scope, memory?.runs]);

  const tab = (s: "daily" | "all", label: string) => (
    <button
      type="button"
      role="tab"
      id={`${tabsId}-${s}`}
      aria-selected={scope === s}
      aria-controls={`${tabsId}-panel`}
      tabIndex={scope === s ? 0 : -1}
      onClick={() => setScope(s)}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          const next = scope === "daily" ? "all" : "daily";
          setScope(next);
          document.getElementById(`${tabsId}-${next}`)?.focus();
        }
      }}
      className={`rounded-md px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider ${scope === s ? "bg-white/10 text-text" : "text-muted hover:text-text"}`}
    >
      {label}
    </button>
  );

  return (
    <section className="panel flex flex-col gap-3 p-4" aria-labelledby={`${tabsId}-h`}>
      <div className="flex items-center justify-between">
        <h3 id={`${tabsId}-h`} className="label flex items-center gap-1.5">
          <Trophy className="size-3.5 text-sun" aria-hidden="true" /> Leaderboard
        </h3>
        <div role="tablist" aria-label="Leaderboard scope" className="flex gap-1 rounded-lg border border-line p-0.5">
          {tab("daily", "Today")}
          {tab("all", "All time")}
        </div>
      </div>
      <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${scope}`} className="min-h-48">
        {state.status === "loading" ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="skeleton h-7" />
            ))}
          </div>
        ) : state.entries.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">No scores yet. Yours could be first.</p>
        ) : (
          <>
            {state.local && <p className="mb-2 font-mono text-[10px] text-sun">offline: showing your local runs</p>}
            <ol className="flex flex-col gap-1">
              {state.entries.slice(0, 10).map((e, i) => (
                <li
                  key={`${e.displayName}-${e.at}-${i}`}
                  className={`grid grid-cols-[1.5rem_1fr_auto] items-center gap-2 rounded-md px-2 py-1.5 text-sm ${e.displayName === me ? "bg-accent/10 ring-1 ring-accent/40" : i % 2 ? "bg-white/[0.02]" : ""}`}
                >
                  <span className={`font-display text-xs font-black ${i === 0 ? "text-sun" : i < 3 ? "text-text" : "text-muted"}`}>{i + 1}</span>
                  <span className="min-w-0">
                    <span className="block truncate">{e.displayName}</span>
                    <span className="block truncate font-mono text-[10px] text-muted">
                      {e.worldName} · {e.outcome} · {timeAgo(e.at)}
                    </span>
                  </span>
                  <span className="font-mono tabular-nums">{fmtInt(e.score)}</span>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </section>
  );
}
