import { AnimatePresence, motion } from "motion/react";
import { Ghost, Megaphone, Wifi, WifiOff } from "lucide-react";
import { useEffect, useRef } from "react";
import { EMOTES } from "@bimpee/shared";
import { fmtInt } from "../lib/format";
import { runStore, useRun, type EmoteToast, type RoomStatus } from "../store/run";

type Emote = (typeof EMOTES)[number];

export const EMOTE_LABELS: Record<Emote, string> = {
  gg: "GG",
  help: "HELP!",
  "boss!": "BOSS!",
  nice: "NICE",
  lol: "LOL",
  follow: "FOLLOW ME",
};

const STATUS: Record<RoomStatus, { label: string; color: string }> = {
  connecting: { label: "connecting", color: "var(--neon-sun)" },
  open: { label: "live", color: "var(--boon)" },
  reconnecting: { label: "reconnecting", color: "var(--neon-sun)" },
  closed: { label: "disconnected", color: "var(--danger)" },
  offline: { label: "offline", color: "var(--danger)" },
};

/** Room status pill, ghost list (top-left, under vitals) and emote toasts. */
export function RoomOverlay({ roomId, onOpenWheel }: { roomId: string; onOpenWheel: () => void }) {
  const status = useRun((s) => s.roomStatus);
  const ghosts = useRun((s) => s.ghosts);
  const emotes = useRun((s) => s.emotes);
  const st = STATUS[status ?? "connecting"];
  return (
    <>
      <div className="pointer-events-none absolute left-3 top-[calc(var(--hud-pad)+64px)] z-20 flex max-w-[46vw] flex-col gap-1.5 sm:left-4">
        <span className="chip pointer-events-auto w-fit bg-black/50" style={{ color: st.color }} role="status" title={`Room ${roomId}`}>
          {status === "open" ? <Wifi className="size-3" aria-hidden="true" /> : <WifiOff className="size-3" aria-hidden="true" />}
          {roomId} · {st.label}
        </span>
        {ghosts.length > 0 && (
          <ul className="flex flex-col gap-0.5 rounded-lg bg-black/40 px-2 py-1.5 backdrop-blur" aria-label="Other players">
            {ghosts.slice(0, 8).map((g) => (
              <li key={g.id} className={`flex items-center gap-1.5 font-mono text-[11px] ${g.alive ? "text-text/90" : "text-muted line-through"}`}>
                <Ghost className="size-3 shrink-0" aria-hidden="true" style={{ color: g.alive ? "var(--world-accent)" : undefined }} />
                <span className="truncate">{g.name}</span>
                <span className="ml-auto h-1 w-8 shrink-0 overflow-hidden rounded-full bg-white/10" aria-label={`hp ${Math.round(g.hp * 100)}%`}>
                  <span className="block h-full bg-boon" style={{ width: `${Math.max(0, Math.min(1, g.hp)) * 100}%` }} />
                </span>
                <span className="w-12 shrink-0 text-right text-muted">{fmtInt(g.score)}</span>
              </li>
            ))}
            {ghosts.length > 8 && <li className="font-mono text-[10px] text-muted">+{ghosts.length - 8} more</li>}
          </ul>
        )}
        <button type="button" onClick={onOpenWheel} className="chip pointer-events-auto w-fit bg-black/50 hover:border-white/30" aria-label="Emote (T)">
          <Megaphone className="size-3" aria-hidden="true" /> emote <span className="kbd">T</span>
        </button>
      </div>
      <div className="pointer-events-none absolute right-3 top-[calc(var(--hud-pad)+90px)] z-20 flex flex-col items-end gap-1.5" aria-live="polite">
        <AnimatePresence>
          {emotes.map((e) => (
            <EmoteToastView key={e.id} e={e} />
          ))}
        </AnimatePresence>
      </div>
    </>
  );
}

function EmoteToastView({ e }: { e: EmoteToast }) {
  useEffect(() => {
    const id = setTimeout(() => runStore.getState().dismissEmote(e.id), 3000);
    return () => clearTimeout(id);
  }, [e.id]);
  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 40, scale: 0.8 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 40 }}
      className="rounded-xl border border-white/15 bg-black/60 px-3 py-1.5 backdrop-blur"
    >
      <span className="font-mono text-[10px] text-muted">{e.name}</span>{" "}
      <span className={`font-display text-sm font-black ${e.self ? "text-accent-text" : "text-sun"}`}>{EMOTE_LABELS[e.emote as Emote] ?? e.emote}</span>
    </motion.div>
  );
}

/** Emote wheel: T opens, 1-6 sends, Esc/T closes. */
export function EmoteWheel({ onSend, onClose }: { onSend: (e: Emote) => void; onClose: () => void }) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus({ preventScroll: true });
    const onKey = (ev: KeyboardEvent) => {
      const n = Number.parseInt(ev.key, 10);
      if (n >= 1 && n <= EMOTES.length) {
        ev.preventDefault();
        ev.stopPropagation();
        onSend(EMOTES[n - 1]!);
        onClose();
      } else if (ev.key === "Escape" || ev.key.toLowerCase() === "t") {
        ev.preventDefault();
        ev.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onSend, onClose]);

  const R = 92;
  return (
    <motion.div
      className="absolute inset-0 z-40 grid place-items-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-label="Emotes"
    >
      <div className="relative size-64">
        <div className="absolute inset-8 rounded-full border border-white/10 bg-black/50 backdrop-blur" />
        {EMOTES.map((em, i) => {
          const a = (i / EMOTES.length) * Math.PI * 2 - Math.PI / 2;
          return (
            <motion.button
              key={em}
              ref={i === 0 ? first : undefined}
              type="button"
              className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center rounded-xl border border-white/20 bg-ink-2/90 px-2.5 py-1.5 hover:border-accent"
              initial={{ x: 0, y: 0, opacity: 0 }}
              animate={{ x: Math.cos(a) * R, y: Math.sin(a) * R, opacity: 1 }}
              transition={{ type: "spring", bounce: 0.4, delay: i * 0.02 }}
              onClick={() => {
                onSend(em);
                onClose();
              }}
            >
              <span className="font-display text-xs font-black">{EMOTE_LABELS[em]}</span>
              <span className="kbd mt-0.5">{i + 1}</span>
            </motion.button>
          );
        })}
      </div>
    </motion.div>
  );
}
