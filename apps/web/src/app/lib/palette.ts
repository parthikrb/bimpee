import type { Palette } from "@bimpee/shared";

/** Default (title screen) palette, mirrors :root in styles.css. */
export const DEFAULT_PALETTE: Palette = {
  background: "#07021a",
  floor: "#1a0b3d",
  wall: "#ff2bd6",
  accent: "#00f0ff",
  player: "#f8f8ff",
  glow: "#ff2bd6",
};

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const ch = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

export function mix(a: string, b: string, t: number): string {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  return rgbToHex([ra[0] + (rb[0] - ra[0]) * t, ra[1] + (rb[1] - ra[1]) * t, ra[2] + (rb[2] - ra[2]) * t]);
}

/** Lightens `color` towards white until it reaches `min` contrast against `bg`. */
export function legibleOn(color: string, bg: string, min = 4.5): string {
  let c = color;
  for (let i = 0; i < 10 && contrast(c, bg) < min; i++) c = mix(c, "#ffffff", 0.18);
  return c;
}

const PANEL_BG = "#120634";

/** Pushes a world palette into CSS variables so the whole shell re-themes. */
export function applyPalette(p: Palette | null, root: HTMLElement | null = typeof document !== "undefined" ? document.documentElement : null) {
  if (!root) return;
  const pal = p ?? DEFAULT_PALETTE;
  const set = (k: string, v: string) => root.style.setProperty(k, v);
  set("--world-bg", pal.background);
  set("--world-floor", pal.floor);
  set("--world-wall", pal.wall);
  set("--world-accent", pal.accent);
  set("--world-glow", pal.glow);
  set("--world-player", pal.player);
  set("--world-accent-text", legibleOn(pal.accent, PANEL_BG));
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", p ? pal.background : "#07021a");
}
