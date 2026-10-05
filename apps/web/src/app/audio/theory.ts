import type { WorldSpec } from "@bimpee/shared";

/** Pure music-theory + mixing helpers for the adaptive engine. No Tone.js here. */

type Music = WorldSpec["music"];
export type NoteName = Music["key"];
export type ScaleName = Music["scale"];
export type Instrumentation = Music["instrumentation"];

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

export const SCALE_INTERVALS: Record<ScaleName, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  pentatonic_minor: [0, 3, 5, 7, 10],
};

export const noteIndex = (n: NoteName) => NOTE_NAMES.indexOf(n);

/** MIDI number of the tonic in a given octave (C4 = 60). */
export const tonicMidi = (key: NoteName, octave: number) => 12 * (octave + 1) + noteIndex(key);

/** MIDI of scale degree `degree` (0-based, may exceed scale length or be negative). */
export function degreeMidi(key: NoteName, scale: ScaleName, degree: number, octave: number): number {
  const iv = SCALE_INTERVALS[scale];
  const n = iv.length;
  const oct = Math.floor(degree / n);
  const idx = ((degree % n) + n) % n;
  return tonicMidi(key, octave) + 12 * oct + iv[idx]!;
}

/** Stacked "thirds" within the scale (degrees d, d+2, d+4). Pentatonic gives open, quartal voicings. */
export function chordMidi(key: NoteName, scale: ScaleName, degree: number, octave: number, size = 3): number[] {
  return Array.from({ length: size }, (_, i) => degreeMidi(key, scale, degree + i * 2, octave));
}

const PROGRESSIONS: Record<"bright" | "dark" | "penta", number[][]> = {
  // I V vi IV, I vi IV V, I IV vi V
  bright: [
    [0, 4, 5, 3],
    [0, 5, 3, 4],
    [0, 3, 5, 4],
  ],
  // i VI III VII, i iv VI v, i VII VI VII
  dark: [
    [0, 5, 2, 6],
    [0, 3, 5, 4],
    [0, 6, 5, 6],
  ],
  penta: [
    [0, 2, 3, 1],
    [0, 3, 2, 4],
  ],
};

export function scaleFamily(scale: ScaleName): "bright" | "dark" | "penta" {
  if (scale === "pentatonic_minor") return "penta";
  return scale === "major" || scale === "lydian" || scale === "mixolydian" ? "bright" : "dark";
}

/** Four-chord progression (scale degrees), chosen deterministically from the seed. */
export function progression(scale: ScaleName, seed: number): number[] {
  const options = PROGRESSIONS[scaleFamily(scale)];
  return options[Math.abs(Math.trunc(seed)) % options.length]!;
}

export function midiToNote(midi: number): string {
  const m = Math.round(midi);
  return `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

export const midiToFreq = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** Root-position major triad + octave on the key (victory sting), regardless of mode. */
export function majorResolve(key: NoteName, octave = 4): number[] {
  const r = tonicMidi(key, octave);
  return [r, r + 4, r + 7, r + 12];
}

/** Arpeggio note for a 16th step: up-down over the chord, extended by an octave at high energy. */
export function arpNote(chord: number[], step: number, energy: number): number {
  const tones = energy > 0.7 ? [...chord, ...chord.map((n) => n + 12)] : chord;
  const cycle = [...tones, ...tones.slice(1, -1).reverse()];
  return cycle[step % cycle.length]!;
}

/** A short lead motif (scale degrees, null = rest) derived from the seed; 16 steps. */
export function leadMotif(seed: number): (number | null)[] {
  let a = (Math.abs(Math.trunc(seed)) % 2147483647) || 1;
  const rnd = () => ((a = (a * 48271) % 2147483647) / 2147483647);
  const out: (number | null)[] = [];
  let deg = 4;
  for (let i = 0; i < 16; i++) {
    if (i % 2 === 1 && rnd() < 0.55) {
      out.push(null);
      continue;
    }
    deg = Math.max(0, Math.min(9, deg + Math.round((rnd() - 0.5) * 4)));
    out.push(deg);
  }
  return out;
}

export interface LayerMix {
  pad: number;
  bass: number;
  arp: number;
  drums: number;
  lead: number;
  boss: number;
}

export const SILENT_DB = -60;

const db = (gain: number) => (gain <= 0.001 ? SILENT_DB : Math.max(SILENT_DB, 20 * Math.log10(gain)));
const smooth = (lo: number, hi: number, v: number) => {
  const x = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
  return x * x * (3 - 2 * x);
};

/**
 * Layer volumes (dB) from the pacing controller's music outputs.
 * Calm = pad + soft bass; energy brings in drums and arp; tension brings the lead.
 */
export function layerMix(energy: number, tension: number, boss: boolean): LayerMix {
  const e = Math.min(1, Math.max(0, energy));
  const t = Math.min(1, Math.max(0, tension));
  return {
    pad: db(0.55 + 0.25 * (1 - e)),
    bass: db(0.35 + 0.5 * smooth(0.15, 0.6, e)),
    arp: db(0.7 * smooth(0.3, 0.75, e)),
    drums: db(0.9 * smooth(0.2, 0.55, e) + (boss ? 0.1 : 0)),
    lead: db(0.6 * smooth(0.6, 0.9, t)),
    boss: boss ? db(0.4 + 0.4 * t) : SILENT_DB,
  };
}

/** Drum pattern flags for a 16th step (0..15) at a given energy. */
export function drumHits(step: number, energy: number, boss: boolean) {
  const s = step % 16;
  const fourOnFloor = energy > 0.45 || boss;
  return {
    kick: fourOnFloor ? s % 4 === 0 : s === 0 || s === 8 || (energy > 0.3 && s === 10),
    snare: energy > 0.25 && (s === 4 || s === 12),
    hat: energy > 0.75 || boss ? true : energy > 0.35 ? s % 2 === 0 : false,
    openHat: energy > 0.55 && s % 4 === 2,
  };
}

export interface Timbre {
  pad: "sawtooth" | "fatsawtooth" | "square" | "sine" | "triangle" | "fattriangle";
  bass: "sawtooth" | "square" | "sine" | "triangle";
  arp: "sawtooth" | "square" | "sine" | "triangle" | "pulse";
  lead: "sawtooth" | "square" | "sine" | "triangle" | "fatsawtooth";
  chorus: boolean;
  reverbWet: number;
  distortion: number;
  filterHz: number;
  padRelease: number;
}

export const TIMBRES: Record<Instrumentation, Timbre> = {
  synthwave: { pad: "fatsawtooth", bass: "sawtooth", arp: "sawtooth", lead: "fatsawtooth", chorus: true, reverbWet: 0.3, distortion: 0, filterHz: 2400, padRelease: 1.6 },
  chiptune: { pad: "square", bass: "triangle", arp: "pulse", lead: "square", chorus: false, reverbWet: 0.08, distortion: 0, filterHz: 6000, padRelease: 0.3 },
  ambient: { pad: "sine", bass: "sine", arp: "triangle", lead: "sine", chorus: true, reverbWet: 0.55, distortion: 0, filterHz: 1800, padRelease: 3 },
  industrial: { pad: "sawtooth", bass: "square", arp: "square", lead: "sawtooth", chorus: false, reverbWet: 0.18, distortion: 0.45, filterHz: 1600, padRelease: 0.8 },
  orchestral_lite: { pad: "fattriangle", bass: "triangle", arp: "triangle", lead: "triangle", chorus: true, reverbWet: 0.42, distortion: 0, filterHz: 3200, padRelease: 2.2 },
};

/** Simple per-key throttle (SFX spam guard). */
export class Throttle {
  private last = new Map<string, number>();
  allow(key: string, now: number, minGapMs: number): boolean {
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < minGapMs) return false;
    this.last.set(key, now);
    return true;
  }
}
