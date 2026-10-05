import type { EnemyBase } from "@bimpee/shared";

/** Tiny vector portrait for each enemy behaviour block. */
export function EnemyGlyph({ base, color, className }: { base: EnemyBase; color: string; className?: string }) {
  const stroke = { stroke: color, strokeWidth: 3, fill: `color-mix(in oklab, ${color} 22%, transparent)`, strokeLinejoin: "round" as const };
  let body: React.ReactNode;
  switch (base) {
    case "chaser":
      body = <polygon points="24,6 42,40 6,40" {...stroke} />;
      break;
    case "swarmer":
      body = (
        <g {...stroke}>
          <circle cx="15" cy="16" r="6" />
          <circle cx="33" cy="14" r="5" />
          <circle cx="24" cy="32" r="7" />
        </g>
      );
      break;
    case "shooter":
      body = (
        <g>
          <rect x="8" y="8" width="32" height="32" rx="5" {...stroke} />
          <circle cx="24" cy="24" r="5" fill={color} />
          <line x1="24" y1="24" x2="44" y2="24" stroke={color} strokeWidth="3" />
        </g>
      );
      break;
    case "charger":
      body = <polygon points="4,24 24,6 44,24 24,42 30,24" {...stroke} />;
      break;
    case "splitter":
      body = (
        <g {...stroke}>
          <path d="M22 8 A16 16 0 0 0 22 40 Z" />
          <path d="M26 8 A16 16 0 0 1 26 40 Z" />
        </g>
      );
      break;
    case "orbiter":
      body = (
        <g>
          <circle cx="24" cy="24" r="8" {...stroke} />
          <circle cx="24" cy="24" r="17" fill="none" stroke={color} strokeWidth="2" strokeDasharray="4 5" />
          <circle cx="41" cy="24" r="3.5" fill={color} />
        </g>
      );
      break;
    case "tank":
      body = <polygon points="24,4 42,14 42,34 24,44 6,34 6,14" {...stroke} strokeWidth={4} />;
      break;
  }
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true" style={{ filter: `drop-shadow(0 0 6px ${color})` }}>
      {body}
    </svg>
  );
}
