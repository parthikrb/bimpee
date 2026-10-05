import { describe, expect, it } from "vitest";
import {
  arpNote,
  chordMidi,
  degreeMidi,
  drumHits,
  layerMix,
  leadMotif,
  majorResolve,
  midiToFreq,
  midiToNote,
  progression,
  scaleFamily,
  SILENT_DB,
  Throttle,
  tonicMidi,
} from "./theory";

describe("music theory", () => {
  it("places tonics by octave (C4 = 60, A4 = 69)", () => {
    expect(tonicMidi("C", 4)).toBe(60);
    expect(tonicMidi("A", 4)).toBe(69);
    expect(midiToFreq(69)).toBeCloseTo(440);
    expect(midiToNote(61)).toBe("C#4");
  });

  it("walks scale degrees across octaves, including negative degrees", () => {
    expect(degreeMidi("C", "major", 0, 4)).toBe(60);
    expect(degreeMidi("C", "major", 7, 4)).toBe(72);
    expect(degreeMidi("C", "minor", 2, 4)).toBe(63);
    expect(degreeMidi("C", "major", -1, 4)).toBe(59);
    expect(degreeMidi("A", "pentatonic_minor", 5, 3)).toBe(tonicMidi("A", 4));
  });

  it("builds diatonic triads", () => {
    expect(chordMidi("C", "major", 0, 4)).toEqual([60, 64, 67]); // C major
    expect(chordMidi("C", "major", 5, 4)).toEqual([69, 72, 76]); // A minor
    expect(chordMidi("A", "minor", 0, 3)).toEqual([57, 60, 64]); // A minor
    expect(chordMidi("D", "dorian", 0, 4, 4)).toHaveLength(4);
  });

  it("picks a 4-chord progression per scale family, deterministically", () => {
    expect(scaleFamily("lydian")).toBe("bright");
    expect(scaleFamily("phrygian")).toBe("dark");
    expect(scaleFamily("pentatonic_minor")).toBe("penta");
    for (const s of ["major", "minor", "pentatonic_minor"] as const) {
      const p = progression(s, 1234);
      expect(p).toHaveLength(4);
      expect(p[0]).toBe(0);
      expect(progression(s, 1234)).toEqual(p);
    }
  });

  it("resolves to a major triad + octave for victory", () => {
    expect(majorResolve("D", 4)).toEqual([62, 66, 69, 74]);
  });

  it("arpeggiates up and down and extends at high energy", () => {
    const chord = [60, 64, 67];
    expect([0, 1, 2, 3].map((s) => arpNote(chord, s, 0.2))).toEqual([60, 64, 67, 64]);
    expect(Math.max(...Array.from({ length: 16 }, (_, s) => arpNote(chord, s, 0.9)))).toBe(79);
  });

  it("makes a seeded 16-step motif within range", () => {
    const m = leadMotif(99);
    expect(m).toHaveLength(16);
    expect(leadMotif(99)).toEqual(m);
    for (const d of m) if (d !== null) expect(d).toBeGreaterThanOrEqual(0);
  });
});

describe("layer mix", () => {
  it("is calm at low energy and full at high energy", () => {
    const calm = layerMix(0, 0, false);
    const hot = layerMix(1, 1, false);
    expect(calm.drums).toBe(SILENT_DB);
    expect(calm.arp).toBe(SILENT_DB);
    expect(calm.lead).toBe(SILENT_DB);
    expect(calm.pad).toBeGreaterThan(SILENT_DB);
    expect(hot.drums).toBeGreaterThan(-6);
    expect(hot.lead).toBeGreaterThan(-10);
    expect(hot.boss).toBe(SILENT_DB);
  });

  it("is monotonic in energy for the rhythm section", () => {
    let prev = layerMix(0, 0.5, false);
    for (let e = 0.05; e <= 1; e += 0.05) {
      const m = layerMix(e, 0.5, false);
      expect(m.drums).toBeGreaterThanOrEqual(prev.drums);
      expect(m.bass).toBeGreaterThanOrEqual(prev.bass);
      prev = m;
    }
  });

  it("adds the boss layer", () => {
    expect(layerMix(0.5, 0.5, true).boss).toBeGreaterThan(SILENT_DB);
  });

  it("clamps out-of-range input", () => {
    expect(layerMix(5, -3, false)).toEqual(layerMix(1, 0, false));
  });
});

describe("drums", () => {
  it("goes four-on-the-floor with energy", () => {
    const kicks = (e: number) => Array.from({ length: 16 }, (_, s) => drumHits(s, e, false).kick).filter(Boolean).length;
    expect(kicks(0.1)).toBe(2);
    expect(kicks(0.8)).toBe(4);
    expect(drumHits(4, 0.8, false).snare).toBe(true);
    expect(drumHits(4, 0.1, false).snare).toBe(false);
  });
});

describe("Throttle", () => {
  it("throttles per key", () => {
    const t = new Throttle();
    expect(t.allow("kill", 0, 50)).toBe(true);
    expect(t.allow("kill", 20, 50)).toBe(false);
    expect(t.allow("hit", 20, 50)).toBe(true);
    expect(t.allow("kill", 60, 50)).toBe(true);
  });
});
