import { motion, useReducedMotion } from "motion/react";

const LETTERS = "BIMPEE".split("");

export function Logo({ size = "lg" }: { size?: "lg" | "sm" }) {
  const reduce = useReducedMotion();
  const cls = size === "lg" ? "text-[clamp(3.2rem,13vw,8.5rem)]" : "text-3xl";
  return (
    <h1 className={`font-display font-black italic leading-none tracking-tight select-none ${cls}`} aria-label="Bimpee">
      <span className="inline-flex -skew-x-6" aria-hidden="true">
        {LETTERS.map((ch, i) => (
          <motion.span
            key={i}
            className="chrome-text inline-block"
            initial={reduce ? false : { y: -40, opacity: 0, rotateX: 90 }}
            animate={reduce ? undefined : { y: [0, -6, 0], opacity: 1, rotateX: 0 }}
            transition={
              reduce
                ? undefined
                : {
                    opacity: { delay: i * 0.06, duration: 0.4 },
                    rotateX: { delay: i * 0.06, duration: 0.5, type: "spring", bounce: 0.5 },
                    y: { delay: 0.8 + i * 0.12, duration: 2.4, repeat: Infinity, repeatDelay: 1.2, ease: "easeInOut" },
                  }
            }
          >
            {ch}
          </motion.span>
        ))}
      </span>
    </h1>
  );
}
