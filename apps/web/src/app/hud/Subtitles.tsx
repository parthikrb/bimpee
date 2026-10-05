import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import type { WorldSpec } from "@bimpee/shared";
import { MOOD_COLORS, VOICE_STYLES } from "../narrator/voices";
import { readTimeMs } from "../narrator/narrator";
import { useRun } from "../store/run";
import { useSettings } from "../store/settings";

/**
 * Narrator subtitles with a typewriter reveal. Streaming lines grow while
 * they type; the box fades after the line is complete and read.
 * Positioned bottom-right on phones so the touch joystick (bottom-left) stays clear.
 */
export function Subtitles({ narrator }: { narrator: WorldSpec["narrator"] }) {
  const line = useRun((s) => s.subtitle);
  const enabled = useSettings((s) => s.subtitles);
  const reduce = useReducedMotion();
  const style = VOICE_STYLES[narrator.voice];
  // Typewriter progress is keyed to the line id, so a new line never renders
  // with the previous line's count (no one-frame flash of the full text).
  const [progress, setProgress] = useState<{ id: number | null; n: number }>({ id: null, n: 0 });
  const [hiddenId, setHiddenId] = useState<number | null>(null);

  const id = line?.id ?? null;
  const len = line?.text.length ?? 0;
  const shown = reduce ? len : progress.id === id ? Math.min(progress.n, len) : 0;

  // Typewriter.
  useEffect(() => {
    if (id === null || reduce || shown >= len) return;
    const t = setTimeout(() => setProgress({ id, n: shown + 2 }), (2 * 1000) / style.cps);
    return () => clearTimeout(t);
  }, [id, len, shown, reduce, style.cps]);

  // Fade out after the line is complete and fully revealed.
  const complete = !!line?.done && shown >= len;
  useEffect(() => {
    if (!complete || id === null) return;
    const t = setTimeout(() => setHiddenId(id), Math.max(2600, readTimeMs(line?.text ?? "") * 0.6));
    return () => clearTimeout(t);
  }, [complete, id, line?.text]);

  const visible = enabled && line !== null && hiddenId !== line.id && (line.text.length > 0 || !line.done);
  const moodColor = line?.mood ? MOOD_COLORS[line.mood] : undefined;

  return (
    <div
      className="pointer-events-none absolute bottom-0 right-0 z-20 flex w-[min(62vw,640px)] justify-end px-3 sm:inset-x-0 sm:mx-auto sm:w-full sm:max-w-2xl sm:justify-center"
      style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
    >
      <AnimatePresence>
        {visible && line && (
          <motion.div
            key={line.id}
            className="flex max-w-full items-start gap-3 rounded-2xl border bg-black/65 px-3 py-2.5 backdrop-blur-md sm:px-4"
            style={{ borderColor: `color-mix(in oklab, ${moodColor ?? style.color} 45%, transparent)` }}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8, transition: { duration: 0.4 } }}
            role="status"
            aria-live="polite"
          >
            <motion.span
              className="grid size-9 shrink-0 place-items-center rounded-full text-lg sm:size-10"
              style={{ color: style.color, background: `color-mix(in oklab, ${style.color} 16%, transparent)`, boxShadow: `0 0 16px -4px ${style.color}` }}
              animate={!line.done || shown < len ? { scale: [1, 1.12, 1] } : { scale: 1 }}
              transition={{ duration: 0.5, repeat: !line.done || shown < len ? Infinity : 0 }}
              aria-hidden="true"
            >
              {style.glyph}
            </motion.span>
            <div className="min-w-0">
              <p className="font-mono text-[10px] uppercase tracking-widest" style={{ color: style.color }}>
                {narrator.name}
              </p>
              <p className="text-sm leading-snug text-text sm:text-base">
                {/* Model text is rendered as plain text, never as HTML. */}
                <span className="sr-only">{line.done ? line.text : ""}</span>
                <span aria-hidden="true">
                  {line.text.slice(0, shown)}
                  {(!line.done || shown < len) && <span className="caret">&nbsp;</span>}
                </span>
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
