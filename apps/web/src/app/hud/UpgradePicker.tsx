import { motion } from "motion/react";
import { useEffect, useRef } from "react";
import type { UpgradeOption } from "../../game/contract";

const RARITY: Record<UpgradeOption["rarity"], { color: string; label: string; glow: string }> = {
  common: { color: "#d8d4f0", label: "Common", glow: "rgb(255 255 255 / 0.25)" },
  rare: { color: "var(--rare)", label: "Rare", glow: "var(--rare)" },
  epic: { color: "var(--epic)", label: "Epic", glow: "var(--epic)" },
};

/** Level-up: choose 1 of 3. Keys 1/2/3 or click/tap. The game is paused until a pick. */
export function UpgradePicker({ options, onPick }: { options: UpgradeOption[]; onPick: (id: string) => void }) {
  const first = useRef<HTMLButtonElement>(null);
  const picked = useRef(false);

  useEffect(() => {
    picked.current = false;
    first.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      const n = Number.parseInt(e.key, 10);
      if (n >= 1 && n <= options.length) {
        e.preventDefault();
        e.stopPropagation();
        pick(options[n - 1]!.id);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);

  const pick = (id: string) => {
    if (picked.current) return;
    picked.current = true;
    onPick(id);
  };

  return (
    <motion.div
      className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-5 bg-black/55 px-4 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="lvl-h"
    >
      <motion.h2
        id="lvl-h"
        className="font-display text-3xl font-black uppercase tracking-widest text-sun sm:text-5xl"
        style={{ textShadow: "0 0 24px var(--neon-sun)" }}
        initial={{ scale: 2, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", bounce: 0.5 }}
      >
        Level up!
      </motion.h2>
      <div className="grid w-full max-w-3xl grid-cols-1 gap-3 sm:grid-cols-3">
        {options.map((o, i) => {
          const r = RARITY[o.rarity];
          return (
            <motion.button
              key={o.id}
              ref={i === 0 ? first : undefined}
              type="button"
              onClick={() => pick(o.id)}
              className="panel group relative flex flex-col gap-2 p-4 text-left outline-offset-4 transition-transform hover:-translate-y-1 sm:min-h-52"
              style={{ borderColor: `color-mix(in oklab, ${r.color} 60%, transparent)`, boxShadow: `0 0 30px -10px ${r.glow}` }}
              initial={{ y: 40, opacity: 0, rotateY: 70 }}
              animate={{ y: 0, opacity: 1, rotateY: 0 }}
              transition={{ delay: 0.1 + i * 0.09, type: "spring", bounce: 0.35 }}
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-widest" style={{ color: r.color }}>
                  {r.label}
                </span>
                <span className="kbd" aria-hidden="true">
                  {i + 1}
                </span>
              </div>
              <span className="font-display text-lg font-bold leading-tight">{o.name}</span>
              <span className="text-sm text-muted">{o.description}</span>
              {o.rarity === "epic" && (
                <span className="pointer-events-none absolute inset-0 rounded-2xl opacity-0 transition-opacity group-hover:opacity-100" style={{ background: "radial-gradient(circle at 50% 0%, color-mix(in oklab, var(--epic) 25%, transparent), transparent 70%)" }} />
              )}
            </motion.button>
          );
        })}
      </div>
      <p className="text-xs text-muted">
        Press <span className="kbd">1</span> <span className="kbd">2</span> <span className="kbd">3</span> or tap a card
      </p>
    </motion.div>
  );
}
