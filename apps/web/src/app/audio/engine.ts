import * as Tone from "tone";
import type { WorldSpec } from "@bimpee/shared";
import {
  arpNote,
  chordMidi,
  degreeMidi,
  drumHits,
  layerMix,
  leadMotif,
  majorResolve,
  midiToFreq,
  progression,
  SILENT_DB,
  Throttle,
  TIMBRES,
  type LayerMix,
} from "./theory";

/**
 * Adaptive Tone.js engine. Loaded lazily (dynamic import) and only started
 * from a user gesture. One `Core` (master chain + SFX) lives for the session;
 * a `MusicGraph` is built per world and fully disposed on world change.
 */

export type SfxKind = "kill" | "elite_kill" | "hit" | "level_up" | "boon" | "boss_spawn" | "ui";

interface Core {
  limiter: Tone.Limiter;
  master: Tone.Volume;
  musicBus: Tone.Volume;
  sfxBus: Tone.Volume;
  blip: Tone.Synth;
  noise: Tone.NoiseSynth;
  chime: Tone.PolySynth;
  boom: Tone.MembraneSynth;
  glide: Tone.Synth;
}

let core: Core | null = null;
let graph: MusicGraph | null = null;
let started = false;
const sfxThrottle = new Throttle();

const settings = { volume: 0.7, muted: false, music: true, sfx: true };

/** Never -Infinity: ramping a Param to -Infinity dB is undefined behaviour. Silence is handled by `mute`. */
const volToDb = (v: number) => Math.max(-80, 20 * Math.log10(Math.max(v, 1e-4)));

export function isStarted() {
  return started && Tone.getContext().state === "running";
}

/** Must be called from a user gesture handler. */
export async function unlock(): Promise<void> {
  await Tone.start();
  started = true;
  ensureCore();
}

function ensureCore(): Core {
  if (core) return core;
  const limiter = new Tone.Limiter(-1).toDestination();
  const master = new Tone.Volume(volToDb(settings.volume)).connect(limiter);
  master.mute = settings.muted || settings.volume <= 0.001;
  const musicBus = new Tone.Volume(0).connect(master);
  musicBus.mute = !settings.music;
  const sfxBus = new Tone.Volume(-8).connect(master);
  sfxBus.mute = !settings.sfx;
  const blip = new Tone.Synth({ oscillator: { type: "square" }, envelope: { attack: 0.001, decay: 0.06, sustain: 0, release: 0.03 } }).connect(sfxBus);
  blip.volume.value = -14;
  const noise = new Tone.NoiseSynth({ noise: { type: "brown" }, envelope: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.02 } }).connect(sfxBus);
  noise.volume.value = -6;
  const chime = new Tone.PolySynth(Tone.Synth, { oscillator: { type: "triangle" }, envelope: { attack: 0.005, decay: 0.25, sustain: 0.1, release: 0.4 } }).connect(sfxBus);
  chime.maxPolyphony = 16;
  chime.volume.value = -10;
  const boom = new Tone.MembraneSynth({ pitchDecay: 0.2, octaves: 6, envelope: { attack: 0.001, decay: 0.9, sustain: 0, release: 0.3 } }).connect(sfxBus);
  boom.volume.value = -4;
  const glide = new Tone.Synth({ oscillator: { type: "sine" }, envelope: { attack: 0.01, decay: 0.1, sustain: 0.6, release: 0.25 } }).connect(sfxBus);
  glide.volume.value = -10;
  core = { limiter, master, musicBus, sfxBus, blip, noise, chime, boom, glide };
  return core;
}

export function applySettings(s: Partial<typeof settings>) {
  Object.assign(settings, s);
  if (!core) return;
  core.master.volume.rampTo(volToDb(settings.volume), 0.1);
  core.master.mute = settings.muted || settings.volume <= 0.001;
  core.musicBus.mute = !settings.music;
  core.sfxBus.mute = !settings.sfx;
}

/** Builds (or tears down, with null) the music for a world. Starts playing immediately. */
export function setWorld(world: WorldSpec | null) {
  graph?.dispose();
  graph = null;
  if (!world || !started) return;
  graph = new MusicGraph(world, ensureCore());
}

export function setPacing(energy: number, tension: number) {
  graph?.setPacing(energy, tension);
}

export function setBoss(on: boolean) {
  graph?.setBoss(on);
}

export function death() {
  graph?.death();
}

export function victory() {
  graph?.victory();
}

export function sfx(kind: SfxKind) {
  if (!core || !started || !settings.sfx || settings.muted) return;
  const now = Tone.now();
  const c = core;
  try {
    switch (kind) {
      case "kill":
        if (!sfxThrottle.allow(kind, performance.now(), 55)) return;
        c.blip.triggerAttackRelease(700 + Math.random() * 500, 0.04, now, 0.5);
        break;
      case "elite_kill":
        if (!sfxThrottle.allow(kind, performance.now(), 120)) return;
        c.chime.triggerAttackRelease(["E5", "B5"], 0.12, now, 0.6);
        break;
      case "hit":
        if (!sfxThrottle.allow(kind, performance.now(), 140)) return;
        c.noise.triggerAttackRelease(0.1, now, 0.8);
        break;
      case "level_up":
        if (!sfxThrottle.allow(kind, performance.now(), 300)) return;
        ["C5", "E5", "G5", "C6"].forEach((n, i) => c.chime.triggerAttackRelease(n, 0.18, now + i * 0.07, 0.7));
        break;
      case "boon":
        if (!sfxThrottle.allow(kind, performance.now(), 400)) return;
        c.glide.triggerAttack(330, now, 0.7);
        c.glide.frequency.exponentialRampTo(1320, 0.35, now);
        c.glide.triggerRelease(now + 0.4);
        break;
      case "boss_spawn":
        if (!sfxThrottle.allow(kind, performance.now(), 1500)) return;
        c.boom.triggerAttackRelease("C1", 1.2, now, 1);
        break;
      case "ui":
        if (!sfxThrottle.allow(kind, performance.now(), 60)) return;
        c.blip.triggerAttackRelease(1400, 0.02, now, 0.25);
        break;
    }
  } catch {
    /* scheduling collisions are harmless */
  }
}

/** Stops music and releases everything (e.g. leaving to the title). */
export function stopAll() {
  setWorld(null);
}

class MusicGraph {
  private nodes: { dispose(): unknown }[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private repeatId: number | null = null;
  private step = 0;
  private energy = 0.3;
  private tension = 0.2;
  private boss = false;
  private ended = false;
  private mix: LayerMix;
  private readonly prog: number[];
  private readonly motif: (number | null)[];
  private readonly bpm: number;

  private fxIn: Tone.Filter;
  private pad: Tone.PolySynth;
  private bass: Tone.MonoSynth;
  private arp: Tone.Synth;
  private lead: Tone.Synth;
  private kick: Tone.MembraneSynth;
  private snare: Tone.NoiseSynth;
  private hat: Tone.MetalSynth;
  private bossSynth: Tone.MonoSynth;
  private vol: Record<keyof LayerMix, Tone.Volume>;
  private bus: Tone.Volume;

  constructor(
    private readonly world: WorldSpec,
    core: Core,
  ) {
    const m = world.music;
    const tb = TIMBRES[m.instrumentation];
    this.bpm = m.bpm;
    this.prog = progression(m.scale, world.seed);
    this.motif = leadMotif(world.seed);

    const own = <T extends { dispose(): unknown }>(n: T): T => {
      this.nodes.push(n);
      return n;
    };

    this.bus = own(new Tone.Volume(0).connect(core.musicBus));
    const reverb = own(new Tone.Reverb({ decay: tb.reverbWet > 0.4 ? 5 : 2.5, wet: tb.reverbWet }).connect(this.bus));
    let fxTail: Tone.ToneAudioNode = reverb;
    if (tb.chorus) {
      const chorus = own(new Tone.Chorus({ frequency: 1.5, delayTime: 3.5, depth: 0.6, wet: 0.5 }).start());
      chorus.connect(fxTail);
      fxTail = chorus;
    }
    if (tb.distortion > 0) {
      const dist = own(new Tone.Distortion({ distortion: tb.distortion, wet: 0.6 }));
      dist.connect(fxTail);
      fxTail = dist;
    }
    this.fxIn = own(new Tone.Filter({ frequency: tb.filterHz, type: "lowpass", rolloff: -24, Q: 1 }));
    this.fxIn.connect(fxTail);

    const layer = () => own(new Tone.Volume(SILENT_DB));
    this.vol = { pad: layer(), bass: layer(), arp: layer(), drums: layer(), lead: layer(), boss: layer() };
    this.vol.pad.connect(this.fxIn);
    this.vol.bass.connect(this.fxIn);
    this.vol.arp.connect(this.fxIn);
    this.vol.lead.connect(this.fxIn);
    this.vol.boss.connect(this.fxIn);
    // Drums skip the tone filter/chorus so they stay punchy.
    this.vol.drums.connect(this.bus);

    this.pad = own(
      new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: tb.pad },
        envelope: { attack: 0.5, decay: 0.4, sustain: 0.65, release: tb.padRelease },
      }),
    );
    this.pad.maxPolyphony = 10;
    this.pad.volume.value = -14;
    this.pad.connect(this.vol.pad);

    this.bass = own(
      new Tone.MonoSynth({
        oscillator: { type: tb.bass },
        envelope: { attack: 0.005, decay: 0.2, sustain: 0.45, release: 0.15 },
        filter: { Q: 2, type: "lowpass", rolloff: -24 },
        filterEnvelope: { attack: 0.005, decay: 0.15, sustain: 0.3, release: 0.2, baseFrequency: 90, octaves: 2.8 },
      }),
    );
    this.bass.volume.value = -10;
    this.bass.connect(this.vol.bass);

    const arpDelay = own(new Tone.FeedbackDelay({ delayTime: "8n.", feedback: 0.28, wet: 0.25 }));
    arpDelay.connect(this.vol.arp);
    this.arp = own(
      new Tone.Synth({
        oscillator: { type: tb.arp },
        envelope: { attack: 0.003, decay: 0.12, sustain: 0.05, release: 0.08 },
      }),
    );
    this.arp.volume.value = -16;
    this.arp.connect(arpDelay);

    const leadDelay = own(new Tone.FeedbackDelay({ delayTime: "4n", feedback: 0.3, wet: 0.3 }));
    leadDelay.connect(this.vol.lead);
    this.lead = own(
      new Tone.Synth({
        oscillator: { type: tb.lead },
        envelope: { attack: 0.02, decay: 0.2, sustain: 0.5, release: 0.3 },
        portamento: 0.03,
      }),
    );
    this.lead.volume.value = -14;
    this.lead.connect(leadDelay);

    this.kick = own(new Tone.MembraneSynth({ pitchDecay: 0.04, octaves: 6, envelope: { attack: 0.001, decay: 0.35, sustain: 0, release: 0.1 } }));
    this.kick.volume.value = -6;
    this.kick.connect(this.vol.drums);
    this.snare = own(new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.16, sustain: 0, release: 0.05 } }));
    this.snare.volume.value = -14;
    this.snare.connect(this.vol.drums);
    this.hat = own(
      new Tone.MetalSynth({
        envelope: { attack: 0.001, decay: 0.05, release: 0.01 },
        harmonicity: 5.1,
        modulationIndex: 32,
        resonance: 5000,
        octaves: 1.5,
      }),
    );
    this.hat.frequency.value = 250;
    this.hat.volume.value = -28;
    this.hat.connect(this.vol.drums);

    this.bossSynth = own(
      new Tone.MonoSynth({
        oscillator: { type: "fmsawtooth" },
        envelope: { attack: 0.02, decay: 0.3, sustain: 0.4, release: 0.4 },
        filter: { Q: 4, type: "lowpass" },
        filterEnvelope: { baseFrequency: 60, octaves: 3.5, attack: 0.01, decay: 0.25, sustain: 0.2, release: 0.3 },
      }),
    );
    this.bossSynth.volume.value = -10;
    this.bossSynth.connect(this.vol.boss);

    this.mix = layerMix(this.energy, this.tension, false);
    this.applyMix(0.5);

    const transport = Tone.getTransport();
    transport.stop();
    transport.cancel(0);
    transport.bpm.value = this.bpm;
    this.repeatId = transport.scheduleRepeat((time) => this.tick(time), "16n");
    transport.start("+0.05");
  }

  setPacing(energy: number, tension: number) {
    if (this.ended) return;
    this.energy = energy;
    this.tension = tension;
    const next = layerMix(energy, tension, this.boss);
    const changed = (Object.keys(next) as (keyof LayerMix)[]).some((k) => Math.abs(next[k] - this.mix[k]) > 0.75);
    if (!changed) return;
    this.mix = next;
    this.applyMix(1.2);
  }

  setBoss(on: boolean) {
    if (this.ended || on === this.boss) return;
    this.boss = on;
    const tb = TIMBRES[this.world.music.instrumentation];
    // Filter sweep: open up hard for the boss, settle back after.
    this.fxIn.frequency.cancelScheduledValues(Tone.now());
    if (on) {
      this.fxIn.frequency.rampTo(300, 0.4);
      this.fxIn.frequency.exponentialRampTo(Math.min(9000, tb.filterHz * 2.5), 4, Tone.now() + 0.5);
    } else {
      this.fxIn.frequency.rampTo(tb.filterHz, 2);
    }
    this.mix = layerMix(this.energy, this.tension, on);
    this.applyMix(0.8);
  }

  death() {
    if (this.ended) return;
    this.ended = true;
    const transport = Tone.getTransport();
    this.fxIn.frequency.cancelScheduledValues(Tone.now());
    this.fxIn.frequency.exponentialRampTo(180, 2.5);
    transport.bpm.rampTo(this.bpm * 0.55, 3);
    this.vol.drums.volume.rampTo(SILENT_DB, 1.5);
    this.vol.lead.volume.rampTo(SILENT_DB, 1);
    this.vol.boss.volume.rampTo(SILENT_DB, 1);
    this.bus.volume.rampTo(-28, 6);
    this.later(() => this.halt(), 6500);
  }

  victory() {
    if (this.ended) return;
    this.ended = true;
    const now = Tone.now() + 0.05;
    for (const k of ["drums", "arp", "bass", "boss", "lead"] as const) this.vol[k].volume.rampTo(SILENT_DB, 0.3);
    this.vol.pad.volume.rampTo(-2, 0.2);
    const chord = majorResolve(this.world.music.key, 4).map(midiToFreq);
    try {
      this.pad.releaseAll(now);
      this.pad.triggerAttackRelease(chord, 3.5, now + 0.1, 0.9);
      this.vol.lead.volume.rampTo(-4, 0.1);
      chord.forEach((f, i) => this.lead.triggerAttackRelease(f * 2, 0.22, now + 0.1 + i * 0.11, 0.8));
    } catch {
      /* ignore */
    }
    this.bus.volume.rampTo(-30, 7, now + 2);
    this.later(() => this.halt(), 8000);
  }

  dispose() {
    this.ended = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.halt();
    // Give release tails a moment? No: dispose now to guarantee no leaks on fast world swaps.
    for (const n of this.nodes.reverse()) {
      try {
        n.dispose();
      } catch {
        /* already disposed */
      }
    }
    this.nodes = [];
  }

  private halt() {
    const transport = Tone.getTransport();
    if (this.repeatId !== null) {
      transport.clear(this.repeatId);
      this.repeatId = null;
    }
    transport.stop();
    transport.cancel(0);
    try {
      this.pad.releaseAll();
      this.bass.triggerRelease();
      this.bossSynth.triggerRelease();
    } catch {
      /* disposed */
    }
  }

  private later(fn: () => void, ms: number) {
    this.timers.push(setTimeout(fn, ms));
  }

  private applyMix(rampSec: number) {
    for (const k of Object.keys(this.mix) as (keyof LayerMix)[]) this.vol[k].volume.rampTo(this.mix[k], rampSec);
  }

  private tick(time: number) {
    if (this.ended) return;
    const step = this.step++;
    const s16 = step % 16;
    const bar = Math.floor(step / 16) % 4;
    const { key, scale } = this.world.music;
    const deg = this.prog[bar] ?? 0;
    const barSec = (60 / this.bpm) * 4;
    const sixteenth = barSec / 16;
    const e = this.energy;
    const m = this.mix;
    try {
      if (s16 === 0 && m.pad > SILENT_DB) {
        const chord = chordMidi(key, scale, deg, 4, e > 0.6 ? 4 : 3).map(midiToFreq);
        this.pad.triggerAttackRelease(chord, barSec * 0.92, time, 0.45);
      }
      if (m.bass > SILENT_DB) {
        const root = degreeMidi(key, scale, deg, 2);
        if (e < 0.35) {
          if (s16 === 0) this.bass.triggerAttackRelease(midiToFreq(root), barSec * 0.45, time, 0.8);
        } else if (s16 % 2 === 0) {
          const up = e > 0.65 && s16 % 4 === 2 ? 12 : 0;
          this.bass.triggerAttackRelease(midiToFreq(root + up), sixteenth * 1.6, time, s16 % 4 === 0 ? 0.9 : 0.6);
        }
      }
      if (m.arp > -40) {
        const chord = chordMidi(key, scale, deg, 5);
        this.arp.triggerAttackRelease(midiToFreq(arpNote(chord, s16, e)), sixteenth * 0.8, time, 0.55);
      }
      if (m.drums > -40) {
        const h = drumHits(s16, e, this.boss);
        if (h.kick) this.kick.triggerAttackRelease("C1", "8n", time, 0.95);
        if (h.snare) this.snare.triggerAttackRelease("16n", time, 0.7);
        if (h.hat || h.openHat) this.hat.triggerAttackRelease(h.openHat ? "8n" : "32n", time, h.openHat ? 0.35 : 0.2);
      }
      if (m.lead > -40 && bar % 2 === 1) {
        const md = this.motif[s16];
        if (md !== null && md !== undefined) this.lead.triggerAttackRelease(midiToFreq(degreeMidi(key, scale, md, 5)), sixteenth * 1.8, time, 0.6);
      }
      if (this.boss && m.boss > SILENT_DB && s16 % 8 === 0) {
        const root = degreeMidi(key, scale, deg, 1);
        this.bossSynth.triggerAttackRelease(midiToFreq(root), sixteenth * 5, time, 0.9);
      }
    } catch {
      /* a dropped note is better than a crashed loop */
    }
  }
}
