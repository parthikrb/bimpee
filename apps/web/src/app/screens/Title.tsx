import { AnimatePresence, motion } from "motion/react";
import { Calendar, Check, Dices, DoorOpen, Hash, Mail, Pencil, Sparkles, Users, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { dailyRoomId } from "@bimpee/shared";
import { linkEmail, saveDisplayName, supabaseConfigured } from "../auth";
import { forgeDaily, forgeRoom, forgeSolo } from "../flow";
import { normalizeRoomCode, randomRoomCode } from "../lib/ids";
import { memorySnippet } from "../services/memory";
import { useApp, appStore } from "../store/app";
import { useProfile } from "../store/profile";
import { AiBadge } from "../ui/AiBadge";
import { Backdrop } from "../ui/Backdrop";
import { Logo } from "../ui/Logo";

const WISHES = [
  "a drowned cathedral where jellyfish sing hymns",
  "a neon bazaar run by sentient vending machines",
  "a frozen moon full of very angry snowmen",
  "something underwater and spooky",
  "a volcano that hates me personally",
  "a cozy but deadly mushroom forest",
  "clockwork heaven, slightly broken",
  "a desert where the sand remembers",
];

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.07, delayChildren: 0.35 } },
};
const item = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.2, 0.8, 0.2, 1] as const } },
};

export function TitleScreen() {
  const wish = useApp((s) => s.wish);
  const focusNonce = useApp((s) => s.focusWishNonce);
  const memory = useProfile((s) => s.memory);
  const wishRef = useRef<HTMLInputElement>(null);
  const [roomsOpen, setRoomsOpen] = useState(false);
  const wishId = useId();

  useEffect(() => {
    if (focusNonce > 0) wishRef.current?.focus();
  }, [focusNonce]);

  const snippet = memorySnippet(memory);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    forgeSolo(wish);
  };
  const rollWish = () => {
    const pool = WISHES.filter((w) => w !== wish);
    appStore.getState().setWish(pool[Math.floor(Math.random() * pool.length)]!);
    wishRef.current?.focus();
  };

  return (
    <main className="relative min-h-dvh overflow-x-hidden">
      <Backdrop />
      <div className="relative z-10 mx-auto flex min-h-dvh max-w-2xl flex-col items-center justify-center gap-6 px-4 py-10">
        <div className="flex flex-col items-center text-center">
          <Logo />
          <motion.p
            className="mt-3 max-w-md text-balance font-mono text-xs uppercase tracking-[0.28em] text-muted sm:text-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.6 }}
          >
            Every run a new world · Dreamed by Claude · Directed live
          </motion.p>
        </div>

        <motion.div variants={stagger} initial="hidden" animate="show" className="flex w-full flex-col gap-4">
          <motion.div variants={item} className="flex flex-wrap items-center justify-center gap-2">
            <AiBadge />
            <NameChip />
          </motion.div>

          {snippet && (
            <motion.p variants={item} className="text-center font-mono text-xs text-accent-text sm:text-sm" aria-label="Your record">
              {snippet}
            </motion.p>
          )}

          <motion.form variants={item} onSubmit={submit} className="panel panel-glow flex flex-col gap-3 p-4 sm:p-5">
            <label htmlFor={wishId} className="label flex items-center gap-2">
              <Sparkles className="size-3.5 text-sun" aria-hidden="true" /> Your wish
            </label>
            <div className="flex gap-2">
              <input
                id={wishId}
                ref={wishRef}
                className="field"
                value={wish}
                maxLength={200}
                autoComplete="off"
                enterKeyHint="go"
                placeholder="Describe the world you want… or leave it to fate"
                onChange={(e) => appStore.getState().setWish(e.target.value)}
              />
              <button type="button" className="btn btn-ghost !px-3" onClick={rollWish} aria-label="Suggest a wish" title="Suggest a wish">
                <Dices className="size-5" />
              </button>
            </div>
            <button type="submit" className="btn btn-primary w-full !min-h-14 !text-base">
              <Sparkles className="size-5" aria-hidden="true" /> Forge world
            </button>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button type="button" className="btn btn-neon" onClick={() => forgeDaily()}>
                <Calendar className="size-4" aria-hidden="true" /> Daily shared world
                <span className="sr-only">({dailyRoomId()})</span>
              </button>
              <button type="button" className="btn btn-neon" aria-expanded={roomsOpen} onClick={() => setRoomsOpen((o) => !o)}>
                <Users className="size-4" aria-hidden="true" /> Play with friends
              </button>
            </div>
            <AnimatePresence initial={false}>{roomsOpen && <RoomPanel key="rooms" />}</AnimatePresence>
          </motion.form>

          {supabaseConfigured && (
            <motion.div variants={item}>
              <AccountPanel />
            </motion.div>
          )}

          <motion.p variants={item} className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-center text-xs text-muted">
            <span>
              <span className="kbd">W</span>
              <span className="kbd">A</span>
              <span className="kbd">S</span>
              <span className="kbd">D</span> move
            </span>
            <span>
              <span className="kbd">Esc</span> pause
            </span>
            <span>
              <span className="kbd">`</span> director HUD
            </span>
            <span>
              <span className="kbd">M</span> mute
            </span>
          </motion.p>
        </motion.div>
      </div>
    </main>
  );
}

function NameChip() {
  const name = useProfile((s) => s.displayName);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const save = async () => {
    setEditing(false);
    if (draft.trim() && draft !== name) await saveDisplayName(draft);
  };

  if (editing) {
    return (
      <span className="chip !py-0.5 !pr-1">
        <input
          ref={inputRef}
          aria-label="Display name"
          className="w-36 bg-transparent font-mono text-xs text-text outline-none"
          value={draft}
          maxLength={24}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            }
            if (e.key === "Escape") {
              e.stopPropagation();
              setDraft(name);
              setEditing(false);
            }
          }}
          onBlur={() => void save()}
        />
        <button type="button" className="rounded p-1 hover:bg-white/10" aria-label="Save name" onMouseDown={(e) => e.preventDefault()} onClick={() => void save()}>
          <Check className="size-3.5" />
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="chip hover:border-white/30"
      onClick={() => {
        setDraft(name);
        setEditing(true);
      }}
      aria-label={`Display name: ${name}. Edit`}
    >
      <span className="text-text">{name || "…"}</span>
      <Pencil className="size-3 text-muted" aria-hidden="true" />
    </button>
  );
}

function RoomPanel() {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const join = () => {
    const room = normalizeRoomCode(code);
    if (!room) {
      setError("Room codes are 3-24 letters, digits or dashes.");
      return;
    }
    forgeRoom(room);
  };
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      className="overflow-hidden"
    >
      <div className="flex flex-col gap-2 rounded-xl border border-line bg-black/20 p-3">
        <p className="text-xs text-muted">Everyone in a room shares one world and one AI director. You'll see each other as ghosts.</p>
        <div className="flex gap-2">
          <label htmlFor={id} className="sr-only">
            Room code
          </label>
          <div className="relative flex-1">
            <Hash className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <input
              id={id}
              className="field !pl-9 font-mono"
              placeholder="room code"
              value={code}
              maxLength={24}
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!error}
              aria-describedby={error ? `${id}-err` : undefined}
              onChange={(e) => {
                setCode(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  join();
                }
              }}
            />
          </div>
          <button type="button" className="btn btn-neon" onClick={join} disabled={!code.trim()}>
            <DoorOpen className="size-4" aria-hidden="true" /> Join
          </button>
        </div>
        {error && (
          <p id={`${id}-err`} className="text-xs text-danger" role="alert">
            {error}
          </p>
        )}
        <button type="button" className="btn btn-ghost" onClick={() => forgeRoom(randomRoomCode())}>
          <Users className="size-4" aria-hidden="true" /> Create a new room
        </button>
      </div>
    </motion.div>
  );
}

function AccountPanel() {
  const auth = useProfile((s) => s.auth);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [state, setState] = useState<{ kind: "idle" | "sending" | "sent" } | { kind: "error"; msg: string }>({ kind: "idle" });
  const id = useId();

  if (auth.mode !== "supabase" || !auth.ready) return null;
  if (!auth.isAnonymous) {
    return (
      <p className="text-center text-xs text-muted">
        <Check className="mr-1 inline size-3.5 text-boon" aria-hidden="true" />
        Progress saved to {auth.email}
      </p>
    );
  }
  if (!open) {
    return (
      <div className="text-center">
        <button type="button" className="text-xs text-muted underline decoration-dotted underline-offset-4 hover:text-text" onClick={() => setOpen(true)}>
          Save progress across devices
        </button>
      </div>
    );
  }
  const send = async (e: FormEvent) => {
    e.preventDefault();
    setState({ kind: "sending" });
    const r = await linkEmail(email);
    setState(r.ok ? { kind: "sent" } : { kind: "error", msg: r.error });
  };
  return (
    <form onSubmit={send} className="panel flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between">
        <label htmlFor={id} className="label">
          Save progress across devices
        </label>
        <button type="button" className="rounded p-1 text-muted hover:text-text" aria-label="Close" onClick={() => setOpen(false)}>
          <X className="size-4" />
        </button>
      </div>
      {state.kind === "sent" ? (
        <p className="text-sm text-boon" role="status">
          Check your inbox: the magic link makes this account permanent. Your runs come with you.
        </p>
      ) : (
        <>
          <div className="flex gap-2">
            <input id={id} type="email" className="field" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
            <button type="submit" className="btn btn-neon" disabled={state.kind === "sending"}>
              <Mail className="size-4" aria-hidden="true" /> {state.kind === "sending" ? "Sending…" : "Send link"}
            </button>
          </div>
          {state.kind === "error" && (
            <p className="text-xs text-danger" role="alert">
              {state.msg}
            </p>
          )}
        </>
      )}
    </form>
  );
}
