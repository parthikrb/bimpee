import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowLeft, Check, Cloud, Copy, Crown, Music, Play, Swords, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { runDurationSec, type EnemyArchetype, type WorldSpec } from "@bimpee/shared";
import { goTitle, startRun } from "../flow";
import { fmtClock, humanize } from "../lib/format";
import { VOICE_STYLES } from "../narrator/voices";
import { currentRoom } from "../rooms";
import { useApp, type ForgedWorld, type Mode } from "../store/app";
import { useProfile } from "../store/profile";
import { Backdrop } from "../ui/Backdrop";
import { EnemyGlyph } from "../ui/EnemyGlyph";

export function ForgeScreen() {
  const forge = useApp((s) => s.forge);
  const mode = useApp((s) => s.mode);
  const wish = useApp((s) => s.wish);
  return (
    <main className="relative min-h-dvh">
      <Backdrop dim={forge?.status === "ready"} />
      <AnimatePresence mode="wait">
        {forge?.status === "ready" && forge.forged ? (
          <Reveal key={`reveal-${forge.requestId}`} forged={forge.forged} mode={mode} />
        ) : forge?.status === "error" ? (
          <ForgeError key="error" message={forge.error ?? "Unknown error"} />
        ) : (
          <Forging key={`forging-${forge?.requestId ?? 0}`} mode={mode} wish={wish} />
        )}
      </AnimatePresence>
    </main>
  );
}

const FLAVOUR = [
  "Consulting the cartographers of nowhere…",
  "Reading your past runs. We remember.",
  "Teaching the enemies to hold a grudge…",
  "Negotiating with the boss's agent…",
  "Pouring neon into the cracks…",
  "Choosing a palette that will haunt you…",
  "Tuning the soundtrack to your pulse…",
  "Bribing the narrator…",
  "Hiding the healing shrines (badly)…",
  "Arguing about the weather…",
];
const ROOM_FLAVOUR = ["Knocking on the room door…", "Syncing the shared clock…", "Counting the other ghosts…", "Agreeing on one world…"];

function Forging({ mode, wish }: { mode: Mode; wish: string }) {
  const reduce = useReducedMotion();
  const ai = useProfile((s) => s.ai);
  const lines = mode.kind === "room" ? ROOM_FLAVOUR : FLAVOUR;
  const [i, setI] = useState(() => Math.floor(Math.random() * lines.length));
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = performance.now();
    const a = setInterval(() => setI((x) => (x + 1) % lines.length), 1700);
    const b = setInterval(() => setElapsed((performance.now() - started) / 1000), 100);
    return () => {
      clearInterval(a);
      clearInterval(b);
    };
  }, [lines.length]);

  const heading = mode.kind === "room" ? (mode.daily ? "Joining today's world" : `Joining room ${mode.roomId}`) : "Forging your world";
  const who = mode.kind === "room" ? "Room server" : ai === "online" ? "Claude is dreaming" : "Local forge";

  return (
    <motion.section
      className="relative z-10 flex min-h-dvh flex-col items-center justify-center gap-8 px-4 text-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.04, filter: "blur(8px)" }}
      transition={{ duration: 0.4 }}
      aria-busy="true"
    >
      <Sigil spin={!reduce} />
      <div className="flex flex-col items-center gap-3">
        <h2 className="font-display text-2xl font-black uppercase tracking-widest neon-text sm:text-4xl">{heading}</h2>
        {wish && mode.kind === "solo" && <p className="max-w-md text-balance text-sm italic text-muted">“{wish}”</p>}
        <div className="h-6" aria-live="polite">
          <AnimatePresence mode="wait">
            <motion.p
              key={i}
              className="font-mono text-sm text-text/90"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25 }}
            >
              {lines[i]}
            </motion.p>
          </AnimatePresence>
        </div>
      </div>
      <div className="w-full max-w-sm">
        <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
          <motion.div
            className="h-full w-1/3 rounded-full"
            style={{ background: "linear-gradient(90deg, var(--neon-pink), var(--world-accent), var(--neon-sun))" }}
            animate={reduce ? { x: "100%" } : { x: ["-100%", "300%"] }}
            transition={reduce ? { duration: 0 } : { duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
          />
        </div>
        <p className="mt-2 flex justify-between font-mono text-[11px] text-muted">
          <span>{who}</span>
          <span>{elapsed.toFixed(1)}s</span>
        </p>
      </div>
      <button type="button" className="btn btn-ghost" onClick={() => goTitle()}>
        <ArrowLeft className="size-4" aria-hidden="true" /> Cancel
      </button>
    </motion.section>
  );
}

function Sigil({ spin }: { spin: boolean }) {
  const ring = (r: number, dash: string, dur: number, dir: 1 | -1, color: string, w = 2) => (
    <motion.circle
      cx="100"
      cy="100"
      r={r}
      fill="none"
      stroke={color}
      strokeWidth={w}
      strokeDasharray={dash}
      strokeLinecap="round"
      style={{ originX: "100px", originY: "100px" }}
      animate={spin ? { rotate: 360 * dir } : undefined}
      transition={{ duration: dur, repeat: Infinity, ease: "linear" }}
    />
  );
  return (
    <svg viewBox="0 0 200 200" className="size-44 drop-shadow-[0_0_24px_var(--world-glow)] sm:size-56" aria-hidden="true">
      {ring(92, "2 10", 30, 1, "var(--neon-sun)", 3)}
      {ring(78, "60 20 8 20", 9, -1, "var(--world-accent)")}
      {ring(64, "120 40", 6, 1, "var(--neon-pink)", 3)}
      {ring(48, "4 6", 14, -1, "white", 1.5)}
      <motion.polygon
        points="100,62 133,119 67,119"
        fill="none"
        stroke="var(--world-accent)"
        strokeWidth="2.5"
        style={{ originX: "100px", originY: "100px" }}
        animate={spin ? { rotate: [0, 120, 120, 240, 240, 360], scale: [1, 1.1, 1, 1.1, 1, 1] } : undefined}
        transition={{ duration: 4.5, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.circle cx="100" cy="100" r="8" fill="var(--neon-sun)" animate={spin ? { r: [6, 11, 6] } : undefined} transition={{ duration: 1.2, repeat: Infinity }} />
    </svg>
  );
}

function ForgeError({ message }: { message: string }) {
  return (
    <motion.section className="relative z-10 flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <h2 className="font-display text-2xl font-black text-danger">The forge cracked</h2>
      <p className="max-w-md text-sm text-muted">{message}</p>
      <button type="button" className="btn btn-neon" onClick={() => goTitle()}>
        <ArrowLeft className="size-4" aria-hidden="true" /> Back to title
      </button>
    </motion.section>
  );
}

const reveal = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08, delayChildren: 0.15 } },
};
const up = {
  hidden: { opacity: 0, y: 18 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.2, 0.8, 0.2, 1] as const } },
};

function Reveal({ forged, mode }: { forged: ForgedWorld; mode: Mode }) {
  const { world } = forged;
  const startRef = useRef<HTMLButtonElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [starting, setStarting] = useState(false);

  // Orbiting 3D diorama of the forged world behind the reveal (three.js loads lazily).
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    let disposed = false;
    let preview: { destroy(): void } | null = null;
    import("../../game/preview")
      .then(({ createWorldPreview }) => {
        if (!disposed) preview = createWorldPreview(el, world);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      preview?.destroy();
    };
  }, [world]);

  useEffect(() => {
    startRef.current?.focus({ preventScroll: true });
  }, []);

  const start = () => {
    if (starting) return;
    setStarting(true);
    startRun();
  };

  return (
    <motion.section
      className="relative z-10 mx-auto flex min-h-dvh max-w-5xl flex-col px-4 pb-32 pt-8 sm:pt-12"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.25 } }}
    >
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10">
        <div ref={previewRef} className="absolute inset-0" />
        <div className="absolute inset-0 bg-gradient-to-r from-[var(--ink)]/90 via-[var(--ink)]/55 to-[var(--ink)]/10" />
        <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-[var(--ink)] to-transparent" />
      </div>
      <motion.div variants={reveal} initial="hidden" animate="show" className="flex flex-col gap-6">
        <motion.div variants={up} className="flex flex-wrap items-center gap-2">
          <SourceChip forged={forged} />
          {mode.kind === "room" && <RoomChip mode={mode} forged={forged} />}
        </motion.div>

        <div>
          <motion.h2
            className="font-display text-[clamp(2.2rem,8vw,5.5rem)] font-black uppercase leading-[0.95] tracking-tight neon-text"
            initial={{ opacity: 0, letterSpacing: "0.4em", filter: "blur(12px)" }}
            animate={{ opacity: 1, letterSpacing: "-0.01em", filter: "blur(0px)" }}
            transition={{ duration: 0.9, ease: [0.2, 0.8, 0.2, 1] }}
          >
            {world.name}
          </motion.h2>
          <motion.p variants={up} className="mt-3 max-w-2xl text-balance text-lg italic text-text/85 sm:text-xl">
            {world.tagline}
          </motion.p>
        </div>

        <motion.div variants={up}>
          <Swatches world={world} />
        </motion.div>

        <motion.div variants={up} className="flex flex-wrap gap-2">
          <span className="chip">{humanize(world.theme.biome)}</span>
          <span className="chip">weather: {humanize(world.theme.weather)}</span>
          <span className="chip">{world.layout.kind} · {world.layout.size}</span>
          <span className="chip">
            <Music className="size-3" aria-hidden="true" /> {world.music.key} {humanize(world.music.scale)} · {Math.round(world.music.bpm)} bpm · {humanize(world.music.instrumentation)}
          </span>
          <span className="chip">
            <Swords className="size-3" aria-hidden="true" /> {world.player.startingWeapon}
          </span>
          <span className="chip">{fmtClock(runDurationSec(world))} run</span>
        </motion.div>

        <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <motion.section variants={up} aria-labelledby="roster-h">
            <h3 id="roster-h" className="label mb-2">
              Bestiary
            </h3>
            <ul className="grid gap-2 sm:grid-cols-2">
              {world.enemies.map((e, i) => (
                <EnemyCard key={e.id} enemy={e} index={i} />
              ))}
            </ul>
          </motion.section>
          <div className="flex flex-col gap-4">
            <motion.div variants={up}>
              <BossCard world={world} />
            </motion.div>
            <motion.div variants={up}>
              <NarratorCard world={world} />
            </motion.div>
          </div>
        </div>

        <motion.section variants={up} className="panel p-4" aria-labelledby="arc-h">
          <h3 id="arc-h" className="label mb-3">
            The arc
          </h3>
          <ol className="grid gap-3 sm:grid-cols-3">
            {world.arc.map((a, i) => (
              <li key={i} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-display text-sm font-bold">
                    {["I", "II", "III"][i]}. {a.name}
                  </span>
                  <span className="font-mono text-[11px] text-muted">{fmtClock(a.durationSec)}</span>
                </div>
                <div className="h-1 rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-pink" style={{ width: `${a.intensityTarget * 100}%` }} />
                </div>
                <p className="text-xs text-muted">{a.beat}</p>
              </li>
            ))}
          </ol>
        </motion.section>

        <motion.blockquote variants={up} className="border-l-2 border-accent pl-4 text-sm text-text/85">
          <span className="label mb-1 block">Why this world</span>
          {world.designNotes}
          {forged.note && <span className="mt-2 block font-mono text-[11px] text-sun">{forged.note}</span>}
        </motion.blockquote>
      </motion.div>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-ink/80 px-4 py-3 backdrop-blur-md" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
        <div className="mx-auto flex max-w-5xl items-center gap-3">
          <button type="button" className="btn btn-ghost" onClick={() => goTitle()}>
            <ArrowLeft className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">Back</span>
          </button>
          <motion.button
            ref={startRef}
            type="button"
            className="btn btn-primary flex-1 !min-h-14 !text-base"
            onClick={start}
            disabled={starting}
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.6, type: "spring", bounce: 0.5 }}
          >
            <Play className="size-5" aria-hidden="true" /> {mode.kind === "room" ? "Drop in" : "Start run"}
          </motion.button>
        </div>
      </div>
    </motion.section>
  );
}

function SourceChip({ forged }: { forged: ForgedWorld }) {
  if (forged.source === "claude")
    return (
      <span className="chip text-boon" title="Generated by Claude for this run">
        <Check className="size-3" aria-hidden="true" /> forged by {forged.model} · {(forged.latencyMs / 1000).toFixed(1)}s
      </span>
    );
  if (forged.source === "room")
    return (
      <span className="chip text-accent-text">
        <Users className="size-3" aria-hidden="true" /> shared room world
      </span>
    );
  return (
    <span className="chip text-sun" title={forged.note}>
      <Cloud className="size-3" aria-hidden="true" /> {forged.source === "fallback" ? "server fallback world" : "offline forge"}
    </span>
  );
}

function RoomChip({ mode, forged }: { mode: Extract<Mode, { kind: "room" }>; forged: ForgedWorld }) {
  const [copied, setCopied] = useState(false);
  const room = currentRoom();
  const players = room?.welcome?.players.length ?? 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(mode.roomId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard denied */
    }
  };
  return (
    <>
      <button type="button" className="chip hover:border-white/30" onClick={() => void copy()} aria-label={`Room code ${mode.roomId}. Copy`}>
        {mode.daily ? "daily" : "room"} <span className="text-text">{mode.roomId}</span>
        {copied ? <Check className="size-3 text-boon" aria-hidden="true" /> : <Copy className="size-3" aria-hidden="true" />}
      </button>
      {room && players > 0 && <span className="chip">{players} in room</span>}
      {forged.roomStartedAt && room && <span className="chip">run clock {fmtClock((now - forged.roomStartedAt) / 1000)}</span>}
      {!room && <span className="chip text-sun">room offline · solo on shared seed</span>}
    </>
  );
}

function Swatches({ world }: { world: WorldSpec }) {
  const entries = Object.entries(world.theme.palette) as [string, string][];
  return (
    <ul className="flex flex-wrap gap-3" aria-label="Palette">
      {entries.map(([k, v], i) => (
        <motion.li
          key={k}
          className="flex flex-col items-center gap-1"
          initial={{ scale: 0, rotate: -90, opacity: 0 }}
          animate={{ scale: 1, rotate: 0, opacity: 1 }}
          transition={{ delay: 0.35 + i * 0.07, type: "spring", bounce: 0.55 }}
        >
          <span className="size-11 rounded-full border-2 border-white/20 sm:size-14" style={{ background: v, boxShadow: `0 0 22px -2px ${v}` }} />
          <span className="font-mono text-[10px] text-muted">{k}</span>
        </motion.li>
      ))}
    </ul>
  );
}

function Stat({ label, value, max }: { label: string; value: number; max: number }) {
  return (
    <div className="flex items-center gap-1.5" title={`${label} ${value.toFixed(1)}`}>
      <span className="w-8 font-mono text-[9px] uppercase text-muted">{label}</span>
      <span className="h-1 flex-1 rounded-full bg-white/10">
        <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
      </span>
    </div>
  );
}

function EnemyCard({ enemy, index }: { enemy: EnemyArchetype; index: number }) {
  return (
    <motion.li
      className="panel flex gap-3 p-3"
      initial={{ opacity: 0, x: -16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.5 + index * 0.08 }}
      style={{ borderColor: `color-mix(in oklab, ${enemy.color} 35%, transparent)` }}
    >
      <EnemyGlyph base={enemy.base} color={enemy.color} className="size-12 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate font-semibold">{enemy.name}</p>
          <span className="shrink-0 font-mono text-[10px] text-muted">act {["I", "II", "III"][enemy.unlockAct]}</span>
        </div>
        <p className="font-mono text-[11px] text-muted">{enemy.base}</p>
        <div className="mt-1.5 flex flex-col gap-1">
          <Stat label="hp" value={enemy.hp} max={60} />
          <Stat label="spd" value={enemy.speed} max={3} />
        </div>
        {enemy.modifiers.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {enemy.modifiers.map((m) => (
              <span key={m} className="chip !py-0 !text-[10px] text-sun">
                {humanize(m)}
              </span>
            ))}
          </div>
        )}
      </div>
    </motion.li>
  );
}

function BossCard({ world }: { world: WorldSpec }) {
  const b = world.boss;
  return (
    <section
      className="panel relative overflow-hidden p-4"
      style={{ borderColor: `color-mix(in oklab, ${b.color} 55%, transparent)`, boxShadow: `0 0 40px -12px ${b.color}` }}
      aria-labelledby="boss-h"
    >
      <div className="pointer-events-none absolute -right-6 -top-6 opacity-30">
        <EnemyGlyph base={b.base} color={b.color} className="size-36" />
      </div>
      <p className="label flex items-center gap-1.5 text-danger">
        <Crown className="size-3.5" aria-hidden="true" /> Boss
      </p>
      <h3 id="boss-h" className="mt-1 font-display text-2xl font-black uppercase">
        {b.name}
      </h3>
      <p className="mt-2 text-sm italic text-text/90">“{b.taunt}”</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <span className="chip">{humanize(b.signature)}</span>
        <span className="chip">{b.phases} phase{b.phases > 1 ? "s" : ""}</span>
        <span className="chip">{Math.round(b.hp)} hp</span>
      </div>
    </section>
  );
}

function NarratorCard({ world }: { world: WorldSpec }) {
  const n = world.narrator;
  const v = VOICE_STYLES[n.voice];
  return (
    <section className="panel flex gap-3 p-4" aria-labelledby="narr-h">
      <span className="grid size-12 shrink-0 place-items-center rounded-full text-2xl" style={{ color: v.color, background: `color-mix(in oklab, ${v.color} 15%, transparent)`, boxShadow: `0 0 18px -4px ${v.color}` }} aria-hidden="true">
        {v.glyph}
      </span>
      <div>
        <p className="label">Narrator · {v.label}</p>
        <h3 id="narr-h" className="font-semibold">
          {n.name}
        </h3>
        <p className="mt-1 text-xs text-muted">{n.persona}</p>
      </div>
    </section>
  );
}
