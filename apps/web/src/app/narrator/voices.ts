import type { WorldSpec } from "@bimpee/shared";

type Voice = WorldSpec["narrator"]["voice"];

export interface VoiceStyle {
  glyph: string;
  color: string;
  label: string;
  /** speechSynthesis params */
  rate: number;
  pitch: number;
  /** typewriter speed, chars per second */
  cps: number;
}

export const VOICE_STYLES: Record<Voice, VoiceStyle> = {
  sardonic: { glyph: "◐", color: "#ff7bd5", label: "sardonic", rate: 1.05, pitch: 0.9, cps: 48 },
  epic: { glyph: "♛", color: "#ffd23f", label: "epic", rate: 0.9, pitch: 0.75, cps: 38 },
  deadpan: { glyph: "▭", color: "#9fd8ff", label: "deadpan", rate: 1.0, pitch: 0.6, cps: 44 },
  cheerful: { glyph: "✦", color: "#3bffb0", label: "cheerful", rate: 1.15, pitch: 1.4, cps: 55 },
  ominous: { glyph: "◉", color: "#c77dff", label: "ominous", rate: 0.8, pitch: 0.45, cps: 30 },
};

export const MOOD_COLORS: Record<string, string> = {
  hype: "#ffd23f",
  tease: "#ff7bd5",
  warn: "#ff3b5c",
  praise: "#3bffb0",
  mourn: "#9fa8ff",
  mystery: "#c77dff",
};
