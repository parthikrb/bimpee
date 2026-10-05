import { Bot, CloudOff, LoaderCircle, Zap } from "lucide-react";
import { useProfile } from "../store/profile";

/** "Claude online / offline" pill. */
export function AiBadge({ compact = false }: { compact?: boolean }) {
  const ai = useProfile((s) => s.ai);
  const health = useProfile((s) => s.health);
  const map = {
    checking: { icon: <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />, text: "Checking AI…", color: "var(--muted)" },
    online: { icon: <Zap className="size-3.5" />, text: "Claude online", color: "var(--boon)" },
    degraded: { icon: <Bot className="size-3.5" />, text: "Server up · AI off", color: "var(--neon-sun)" },
    offline: { icon: <CloudOff className="size-3.5" />, text: "Offline · local AI", color: "var(--neon-sun)" },
  } as const;
  const m = map[ai];
  const title =
    ai === "online" && health
      ? `World: ${health.models.world}\nDirector: ${health.models.director}\nNarrator: ${health.models.narrator}`
      : ai === "offline"
        ? "Backend unreachable. Worlds, director and narrator run locally."
        : undefined;
  return (
    <span className="chip" style={{ color: m.color, borderColor: `color-mix(in oklab, ${m.color} 45%, transparent)` }} title={title} role="status">
      <span className="relative flex">
        {m.icon}
        {ai === "online" && <span className="absolute inset-0 rounded-full animate-ping motion-reduce:animate-none bg-boon/30" />}
      </span>
      {!compact && <span>{m.text}</span>}
    </span>
  );
}
