import { motion } from "motion/react";
import { DoorOpen, Play } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { ttsSupported } from "../narrator/tts";
import { settingsStore, useSettings, type Settings } from "../store/settings";

type ToggleKey = "music" | "sfx" | "tts" | "subtitles" | "debugOpen";

const TOGGLES: { key: ToggleKey; label: string; hint?: string }[] = [
  { key: "music", label: "Music" },
  { key: "sfx", label: "Sound effects" },
  { key: "subtitles", label: "Narrator subtitles" },
  { key: "tts", label: "Narrator voice (TTS)", hint: "uses your browser's speech synthesis" },
  { key: "debugOpen", label: "Director HUD", hint: "`" },
];

export function PauseMenu({ onResume, onQuit, roomMode }: { onResume: () => void; onQuit: () => void; roomMode: boolean }) {
  const resumeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [confirmQuit, setConfirmQuit] = useState(false);
  const volume = useSettings((s) => s.volume);
  const muted = useSettings((s) => s.muted);
  const volId = useId();

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    resumeRef.current?.focus();
    return () => prev?.focus?.();
  }, []);

  // Minimal focus trap.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !dialogRef.current) return;
    const els = dialogRef.current.querySelectorAll<HTMLElement>("button, input, [tabindex]:not([tabindex='-1'])");
    if (!els.length) return;
    const first = els[0]!;
    const last = els[els.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <motion.div
      className="absolute inset-0 z-50 grid place-items-center bg-black/60 px-4 backdrop-blur-md"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={(e) => e.target === e.currentTarget && onResume()}
    >
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pause-h"
        onKeyDown={onKeyDown}
        className="panel panel-glow flex w-full max-w-sm flex-col gap-4 p-5"
        initial={{ scale: 0.92, y: 10 }}
        animate={{ scale: 1, y: 0 }}
      >
        <h2 id="pause-h" className="font-display text-2xl font-black uppercase tracking-widest neon-text">
          Paused
        </h2>
        {roomMode && <p className="-mt-2 text-xs text-sun">Room clock keeps running for everyone else.</p>}
        <button ref={resumeRef} type="button" className="btn btn-primary" onClick={onResume}>
          <Play className="size-4" aria-hidden="true" /> Resume
        </button>

        <div className="flex flex-col gap-1">
          {TOGGLES.filter((t) => t.key !== "tts" || ttsSupported()).map((t) => (
            <Toggle key={t.key} k={t.key} label={t.label} hint={t.hint} />
          ))}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={volId} className="label flex justify-between">
            <span>Volume</span>
            <span>{muted ? "muted" : `${Math.round(volume * 100)}%`}</span>
          </label>
          <input
            id={volId}
            type="range"
            min={0}
            max={100}
            value={Math.round(volume * 100)}
            onChange={(e) => {
              settingsStore.getState().set("volume", Number(e.target.value) / 100);
              if (settingsStore.getState().muted) settingsStore.getState().set("muted", false);
            }}
            className="w-full accent-[var(--world-accent)]"
          />
        </div>

        {confirmQuit ? (
          <div className="flex gap-2">
            <button type="button" className="btn btn-ghost flex-1" onClick={() => setConfirmQuit(false)}>
              Keep playing
            </button>
            <button type="button" className="btn flex-1 border border-danger/60 bg-danger/15 text-danger hover:bg-danger/25" onClick={onQuit}>
              End run
            </button>
          </div>
        ) : (
          <button type="button" className="btn btn-ghost" onClick={() => setConfirmQuit(true)}>
            <DoorOpen className="size-4" aria-hidden="true" /> Quit run
          </button>
        )}
      </motion.div>
    </motion.div>
  );
}

function Toggle({ k, label, hint }: { k: ToggleKey; label: string; hint?: string }) {
  const on = useSettings((s) => s[k as keyof Settings]) as boolean;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => settingsStore.getState().toggle(k)}
      className="flex items-center justify-between rounded-lg px-2 py-2 text-left text-sm hover:bg-white/5"
    >
      <span>
        {label}
        {hint && <span className="ml-2 font-mono text-[10px] text-muted">{hint}</span>}
      </span>
      <span className={`relative h-5 w-9 rounded-full transition-colors ${on ? "bg-accent" : "bg-white/15"}`} aria-hidden="true">
        <span className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left] ${on ? "left-[18px]" : "left-0.5"}`} />
      </span>
    </button>
  );
}
