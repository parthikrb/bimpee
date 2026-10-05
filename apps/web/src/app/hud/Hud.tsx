import { AnimatePresence, motion } from "motion/react";
import { Activity, Pause, Skull, Volume2, VolumeX } from "lucide-react";
import { fmtClock, fmtInt, ROMAN } from "../lib/format";
import { useRun } from "../store/run";
import { settingsStore, useSettings } from "../store/settings";

/** Top HUD: health/xp (left), act + clock (center), score (right), plus the boss bar. */
export function Hud({ onPause }: { onPause: () => void }) {
  const hud = useRun((s) => s.hud);
  const debugOpen = useSettings((s) => s.debugOpen);
  const muted = useSettings((s) => s.muted);
  const hpFrac = hud ? Math.max(0, Math.min(1, hud.hp / Math.max(1, hud.maxHp))) : 1;
  const xpFrac = hud ? Math.max(0, Math.min(1, hud.xp / Math.max(1, hud.xpToNext))) : 0;
  const low = hpFrac < 0.3;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 px-3 sm:px-4" style={{ paddingTop: "var(--hud-pad)" }}>
      <div className="flex items-start justify-between gap-3">
        {/* left: vitals */}
        <div className="flex w-[min(44vw,280px)] flex-col gap-1.5 hud-text">
          <div className="flex items-baseline justify-between font-mono text-[11px]">
            <span className="font-display text-xs font-bold tracking-wider">LV {hud?.level ?? 1}</span>
            <span className={low ? "text-danger" : "text-text/80"}>
              {Math.ceil(hud?.hp ?? 0)}/{Math.ceil(hud?.maxHp ?? 0)}
            </span>
          </div>
          <div
            className="relative h-3 overflow-hidden rounded-full border border-white/20 bg-black/50"
            role="meter"
            aria-label="Health"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(hpFrac * 100)}
          >
            <motion.div
              className="absolute inset-y-0 left-0 rounded-full"
              style={{
                background: low ? "linear-gradient(90deg, #ff3b5c, #ff8a3d)" : "linear-gradient(90deg, #3bffb0, var(--world-accent))",
                boxShadow: low ? "0 0 12px #ff3b5c" : "0 0 10px var(--world-accent)",
              }}
              animate={{ width: `${hpFrac * 100}%` }}
              transition={{ type: "spring", stiffness: 220, damping: 30 }}
            />
            {low && <div className="absolute inset-0 animate-pulse bg-danger/20 motion-reduce:animate-none" />}
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-black/50" role="meter" aria-label="Experience" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(xpFrac * 100)}>
            <motion.div className="h-full rounded-full bg-sun" animate={{ width: `${xpFrac * 100}%` }} transition={{ duration: 0.3 }} />
          </div>
        </div>

        {/* center: act + clock */}
        <div className="hidden flex-col items-center hud-text sm:flex">
          <AnimatePresence mode="wait">
            <motion.span
              key={hud?.act ?? -1}
              className="font-display text-[11px] font-bold uppercase tracking-[0.25em] text-accent-text"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
            >
              Act {ROMAN[hud?.act ?? 0]} · {hud?.actName ?? "…"}
            </motion.span>
          </AnimatePresence>
          <span className="font-mono text-xl tabular-nums">{fmtClock(hud?.t ?? 0)}</span>
        </div>

        {/* right: score + buttons */}
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex items-center gap-1.5">
            <HudButton label={muted ? "Unmute (M)" : "Mute (M)"} onClick={() => settingsStore.getState().toggle("muted")}>
              {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
            </HudButton>
            <HudButton label="Director HUD (`)" pressed={debugOpen} onClick={() => settingsStore.getState().toggle("debugOpen")}>
              <Activity className="size-4" />
            </HudButton>
            <HudButton label="Pause (Esc)" onClick={onPause}>
              <Pause className="size-4" />
            </HudButton>
          </div>
          <div className="text-right hud-text">
            <div className="font-display text-xl font-black tabular-nums sm:text-2xl">{fmtInt(hud?.score ?? 0)}</div>
            <div className="flex items-center justify-end gap-1 font-mono text-[11px] text-text/75">
              <Skull className="size-3" aria-hidden="true" /> {fmtInt(hud?.kills ?? 0)}
              <span className="sm:hidden">· {fmtClock(hud?.t ?? 0)}</span>
            </div>
          </div>
        </div>
      </div>
      <BossBar />
    </div>
  );
}

function HudButton({ label, onClick, pressed, children }: { label: string; onClick: () => void; pressed?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={`pointer-events-auto grid size-9 place-items-center rounded-lg border bg-black/40 backdrop-blur transition-colors hover:bg-black/60 ${
        pressed ? "border-accent text-accent-text" : "border-white/15 text-text/85"
      }`}
    >
      {children}
    </button>
  );
}

function BossBar() {
  const name = useRun((s) => s.hud?.bossName ?? null);
  const hp = useRun((s) => s.hud?.bossHp ?? null);
  const max = useRun((s) => s.bossMaxHp);
  const frac = hp !== null && max > 0 ? Math.max(0, Math.min(1, hp / max)) : 0;
  return (
    <AnimatePresence>
      {name && hp !== null && (
        <motion.div
          className="mx-auto mt-3 w-[min(92vw,560px)]"
          initial={{ opacity: 0, y: -20, scaleX: 0.6 }}
          animate={{ opacity: 1, y: 0, scaleX: 1 }}
          exit={{ opacity: 0, y: -10 }}
          role="meter"
          aria-label={`${name} health`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(frac * 100)}
        >
          <div className="mb-1 text-center font-display text-sm font-black uppercase tracking-[0.2em] text-danger hud-text">{name}</div>
          <div className="relative h-3.5 overflow-hidden rounded-sm border border-danger/60 bg-black/60 shadow-[0_0_20px_-4px_var(--danger)]">
            <motion.div
              className="absolute inset-y-0 left-0"
              style={{ background: "linear-gradient(90deg, #7a0019, #ff3b5c 60%, #ff8a3d)" }}
              animate={{ width: `${frac * 100}%` }}
              transition={{ type: "spring", stiffness: 160, damping: 26 }}
            />
            {[0.25, 0.5, 0.75].map((m) => (
              <span key={m} className="absolute inset-y-0 w-px bg-black/60" style={{ left: `${m * 100}%` }} />
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Big transient "ACT II — The Swell" card on act changes. */
export function ActCardOverlay() {
  const card = useRun((s) => s.actCard);
  return (
    <AnimatePresence>
      {card && <ActCardView key={card.id} act={card.act} name={card.name} beat={card.beat} />}
    </AnimatePresence>
  );
}

function ActCardView({ act, name, beat }: { act: number; name: string; beat: string }) {
  return (
    <motion.div
      className="pointer-events-none absolute inset-x-0 top-[28%] z-10 flex flex-col items-center px-4 text-center"
      initial={{ opacity: 0, scale: 1.3, filter: "blur(10px)" }}
      animate={{ opacity: [0, 1, 1, 0], scale: [1.3, 1, 1, 0.96], filter: ["blur(10px)", "blur(0px)", "blur(0px)", "blur(4px)"] }}
      transition={{ duration: 3.6, times: [0, 0.15, 0.8, 1] }}
      aria-live="polite"
    >
      <span className="font-mono text-xs uppercase tracking-[0.5em] text-text/80 hud-text">Act {ROMAN[act]}</span>
      <span className="font-display text-[clamp(1.8rem,7vw,4rem)] font-black uppercase neon-text">{name}</span>
      {beat && <span className="mt-1 max-w-lg text-sm italic text-text/80 hud-text">{beat}</span>}
    </motion.div>
  );
}
