import { AnimatePresence, motion } from "motion/react";
import { Brain, Check, ChevronDown, ChevronUp, LoaderCircle, X } from "lucide-react";
import { useState } from "react";
import { describeDirective, TOOL_COLORS } from "../director/describe";
import { fmtClock, ROMAN } from "../lib/format";
import { useRun, type DirectorLogEntry } from "../store/run";
import { settingsStore } from "../store/settings";
import { Sparkline } from "../ui/charts";

const PHASE_COLORS = { build: "#00f0ff", peak: "#ff3b5c", relax: "#3bffb0" } as const;
const SOURCE_STYLE: Record<DirectorLogEntry["source"], { label: string; color: string }> = {
  claude: { label: "claude", color: "var(--boon)" },
  local: { label: "local", color: "var(--neon-sun)" },
  fallback: { label: "fallback", color: "#ff8a3d" },
  room: { label: "room", color: "var(--world-accent-text)" },
};

/**
 * The showcase: what the AI director sees and decides, live.
 * Docked right, collapsible; toggled with ` or the HUD button.
 */
export function DirectorDebug() {
  const [collapsed, setCollapsed] = useState(false);
  const pacing = useRun((s) => s.pacing);
  const history = useRun((s) => s.history);
  const act = useRun((s) => s.hud?.act ?? 0);
  const stats = useRun((s) => s.director);
  const log = useRun((s) => s.directorLog);
  const last = log[0];

  return (
    <motion.aside
      className="pointer-events-auto absolute right-2 top-[calc(var(--hud-pad)+92px)] z-30 flex max-h-[calc(100dvh-var(--hud-pad)-190px)] w-[min(92vw,330px)] flex-col overflow-hidden rounded-2xl border border-white/12 bg-[rgb(8_3_24/0.82)] font-mono text-[11px] shadow-2xl backdrop-blur-md sm:right-3"
      initial={{ opacity: 0, x: 40 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 40 }}
      aria-label="AI director debug HUD"
    >
      <header className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <Brain className="size-4 text-pink" aria-hidden="true" />
        <span className="font-display text-[11px] font-black uppercase tracking-[0.2em]">AI Director</span>
        {stats.inFlight && <LoaderCircle className="size-3.5 animate-spin text-accent-text motion-reduce:animate-none" aria-label="request in flight" />}
        <span className="ml-auto flex items-center gap-1">
          {last && (
            <span className="chip !py-0" style={{ color: SOURCE_STYLE[last.source].color }} title={last.model}>
              {last.model.length > 18 ? `${last.model.slice(0, 17)}…` : last.model}
            </span>
          )}
          <button type="button" className="rounded p-1 text-muted hover:text-text" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? "Expand" : "Collapse"} aria-expanded={!collapsed}>
            {collapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
          </button>
          <button type="button" className="rounded p-1 text-muted hover:text-text" onClick={() => settingsStore.getState().set("debugOpen", false)} aria-label="Close director HUD">
            <X className="size-3.5" />
          </button>
        </span>
      </header>

      <div className="flex flex-col gap-2 px-3 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {pacing && (
            <span
              className="chip !py-0 font-bold uppercase"
              style={{ color: PHASE_COLORS[pacing.phase], borderColor: `color-mix(in oklab, ${PHASE_COLORS[pacing.phase]} 55%, transparent)`, background: `color-mix(in oklab, ${PHASE_COLORS[pacing.phase]} 14%, transparent)` }}
            >
              {pacing.phase}
            </span>
          )}
          <span className="chip !py-0">act {ROMAN[act]}</span>
          {pacing && <span className="chip !py-0">{pacing.spawnPerSec.toFixed(2)} spawn/s</span>}
          {pacing && <span className="chip !py-0">max {pacing.maxAlive}</span>}
          {pacing && <span className="chip !py-0">elite {Math.round(pacing.eliteChance * 100)}%</span>}
        </div>
        <div>
          <div className="mb-0.5 flex justify-between text-[10px]">
            <span>
              <span className="text-accent-text">intensity {pacing ? pacing.intensity.toFixed(2) : "–"}</span>
              <span className="text-muted"> vs </span>
              <span className="text-pink">target {pacing ? pacing.target.toFixed(2) : "–"}</span>
            </span>
            <span className="text-muted">90s</span>
          </div>
          <Sparkline samples={history} />
        </div>
        {pacing && (
          <div className="grid grid-cols-2 gap-2 text-[10px] text-muted">
            <Meter label="music energy" v={pacing.musicEnergy} color="var(--neon-sun)" />
            <Meter label="tension" v={pacing.musicTension} color="var(--danger)" />
          </div>
        )}
        <div className="flex gap-3 text-[10px] text-muted">
          <span>calls {stats.requests}</span>
          <span>fallbacks {stats.fallbacks}</span>
          <span title="ticks skipped because a call was still in flight">skipped {stats.dropped}</span>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.ol
            className="thin-scroll flex min-h-0 flex-col gap-2 overflow-y-auto border-t border-white/10 px-3 py-2"
            initial={{ height: 0 }}
            animate={{ height: "auto" }}
            exit={{ height: 0 }}
            aria-label="Director decisions"
          >
            {log.length === 0 && <li className="py-3 text-center text-muted">The director is watching. First decision in ~15s.</li>}
            <AnimatePresence initial={false}>
              {log.map((e) => (
                <LogEntry key={e.id} e={e} />
              ))}
            </AnimatePresence>
          </motion.ol>
        )}
      </AnimatePresence>
    </motion.aside>
  );
}

function Meter({ label, v, color }: { label: string; v: number; color: string }) {
  return (
    <div>
      <div className="flex justify-between">
        <span>{label}</span>
        <span>{v.toFixed(2)}</span>
      </div>
      <div className="h-1 rounded-full bg-white/10">
        <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${v * 100}%`, background: color }} />
      </div>
    </div>
  );
}

function LogEntry({ e }: { e: DirectorLogEntry }) {
  const [open, setOpen] = useState(false);
  const src = SOURCE_STYLE[e.source];
  return (
    <motion.li layout initial={{ opacity: 0, y: -8, backgroundColor: "rgba(255,255,255,0.08)" }} animate={{ opacity: 1, y: 0, backgroundColor: "rgba(255,255,255,0.02)" }} className="rounded-lg border border-white/8 p-2">
      <div className="flex items-center gap-2">
        <span className="text-muted">{fmtClock(e.t)}</span>
        <span className="font-bold" style={{ color: src.color }}>
          {src.label}
        </span>
        <span className="truncate text-muted" title={e.model}>
          {e.model}
        </span>
        <span className="ml-auto shrink-0 text-muted">{e.latencyMs}ms</span>
      </div>
      {e.note && <p className="mt-0.5 text-[10px] text-sun">{e.note}</p>}
      {e.reasoning && (
        <button type="button" className={`mt-1 block w-full text-left text-text/80 ${open ? "" : "line-clamp-2"}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} title="Show full reasoning">
          {e.reasoning}
        </button>
      )}
      {e.directives.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-1">
          {e.directives.map((d, i) => (
            <li key={i} className="flex items-start gap-1.5">
              <StatusIcon status={d.status} note={d.note} />
              <span className="shrink-0 font-bold" style={{ color: TOOL_COLORS[d.directive.tool] }}>
                {d.directive.tool}
              </span>
              <span className="min-w-0 break-words text-muted">
                {describeDirective(d.directive)}
                {d.status === "rejected" && d.note && <span className="text-danger"> · {d.note}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </motion.li>
  );
}

function StatusIcon({ status, note }: { status: "pending" | "ok" | "rejected"; note?: string }) {
  if (status === "ok") return <Check className="mt-px size-3 shrink-0 text-boon" aria-label={note ? `applied: ${note}` : "applied"} />;
  if (status === "rejected") return <X className="mt-px size-3 shrink-0 text-danger" aria-label={`rejected${note ? `: ${note}` : ""}`} />;
  return <span className="mt-1 size-1.5 shrink-0 rounded-full bg-muted" aria-label="pending" />;
}
