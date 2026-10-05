import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";
import { runStore, useRun, type BannerItem } from "../store/run";

const TONE: Record<BannerItem["tone"], { color: string; glow: string; label: string }> = {
  info: { color: "var(--world-accent-text)", glow: "var(--world-accent)", label: "event" },
  danger: { color: "#ff6b81", glow: "var(--danger)", label: "warning" },
  boon: { color: "var(--boon)", glow: "var(--boon)", label: "boon" },
};

/** Directive banners ("Ambush!", "The world takes pity"). Auto-dismiss. */
export function Banners() {
  const banners = useRun((s) => s.banners);
  return (
    <div className="pointer-events-none absolute inset-x-0 top-[18%] z-20 flex flex-col items-center gap-2 px-4" aria-live="assertive">
      <AnimatePresence>
        {banners.map((b) => (
          <Banner key={b.id} banner={b} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function Banner({ banner }: { banner: BannerItem }) {
  useEffect(() => {
    const id = setTimeout(() => runStore.getState().dismissBanner(banner.id), 3200);
    return () => clearTimeout(id);
  }, [banner.id]);
  const t = TONE[banner.tone];
  return (
    <motion.div
      layout
      className="relative overflow-hidden px-6 py-2"
      initial={{ opacity: 0, scaleX: 0.2, skewX: -12 }}
      animate={{ opacity: 1, scaleX: 1, skewX: -8 }}
      exit={{ opacity: 0, x: 80, transition: { duration: 0.25 } }}
      transition={{ type: "spring", stiffness: 420, damping: 26 }}
      style={{
        background: `linear-gradient(90deg, transparent, color-mix(in oklab, ${t.glow} 28%, rgb(0 0 0 / 0.6)) 20%, color-mix(in oklab, ${t.glow} 28%, rgb(0 0 0 / 0.6)) 80%, transparent)`,
        borderTop: `1px solid color-mix(in oklab, ${t.glow} 60%, transparent)`,
        borderBottom: `1px solid color-mix(in oklab, ${t.glow} 60%, transparent)`,
      }}
    >
      <span className="sr-only">{t.label}: </span>
      <span
        className="block skew-x-[8deg] font-display text-lg font-black uppercase tracking-wider sm:text-2xl"
        style={{ color: t.color, textShadow: `0 0 16px ${t.glow}, 0 2px 0 rgb(0 0 0 / 0.8)` }}
      >
        {banner.text}
      </span>
    </motion.div>
  );
}
