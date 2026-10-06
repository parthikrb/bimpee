import * as THREE from "three";
import {
  BlendFunction,
  BloomEffect,
  ChromaticAberrationEffect,
  Effect,
  EffectComposer,
  EffectPass,
  GlitchEffect,
  GlitchMode,
  NoiseEffect,
  RenderPass,
  ScanlineEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from "postprocessing";

const GRADE_FRAG = /* glsl */ `
uniform vec3 uTint; uniform float uTintAmt; uniform float uSat; uniform float uCool;
uniform vec3 uFlash; uniform float uFlashAmt; uniform float uHurt; uniform float uDanger; uniform float uExposure;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor){
  vec3 c = inputColor.rgb * uExposure;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSat);
  c = mix(c, c * vec3(0.68, 0.86, 1.32) + vec3(0.0, 0.004, 0.012), uCool);
  c = mix(c, c * uTint * 1.25 + uTint * 0.02, uTintAmt);
  vec2 d = uv - 0.5;
  float edge = smoothstep(0.25, 0.75, length(d * vec2(1.25, 1.0)));
  c += vec3(1.0, 0.06, 0.12) * edge * uHurt * 0.9;
  // danger from behind: warm glow rising from the bottom edge
  c += vec3(1.0, 0.1, 0.12) * smoothstep(0.2, 0.0, uv.y) * edge * uDanger * 0.22;
  c += uFlash * uFlashAmt;
  outputColor = vec4(c, inputColor.a);
}`;

/** Colour grade: biome tint wash, desaturation/blue shift (time slow), flashes, hurt + danger edges. */
export class GradeEffect extends Effect {
  constructor() {
    super("GradeEffect", GRADE_FRAG, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ["uTint", new THREE.Uniform(new THREE.Color(1, 1, 1))],
        ["uTintAmt", new THREE.Uniform(0)],
        ["uSat", new THREE.Uniform(1)],
        ["uCool", new THREE.Uniform(0)],
        ["uFlash", new THREE.Uniform(new THREE.Color(1, 1, 1))],
        ["uFlashAmt", new THREE.Uniform(0)],
        ["uHurt", new THREE.Uniform(0)],
        ["uDanger", new THREE.Uniform(0)],
        ["uExposure", new THREE.Uniform(1)],
      ]),
    });
  }
  u(name: string): THREE.Uniform {
    return this.uniforms.get(name)!;
  }
}

export interface PostOptions {
  bloom: number;
  vignette: number;
  crt: boolean;
  bloomScale: number;
  exposure: number;
}

/** One EffectComposer: render -> bloom + CA + glitch + grade + tonemap + vignette (+ CRT). */
export class PostFx {
  readonly composer: EffectComposer;
  readonly bloom: BloomEffect;
  readonly ca: ChromaticAberrationEffect;
  readonly glitch: GlitchEffect;
  readonly grade: GradeEffect;
  readonly vignette: VignetteEffect;
  private readonly noise: NoiseEffect | null;
  private readonly scan: ScanlineEffect | null;
  private readonly glitchPass: EffectPass;
  private caPulse = 0;
  private flash = 0;
  private readonly baseVignette: number;
  private readonly caOffset = new THREE.Vector2();

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, o: PostOptions) {
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new BloomEffect({
      mipmapBlur: true,
      intensity: 0.7 + o.bloom * 1.5,
      luminanceThreshold: 0.62 - o.bloom * 0.18,
      luminanceSmoothing: 0.25,
      radius: 0.72,
    });
    this.bloom.resolution.scale = o.bloomScale;
    this.ca = new ChromaticAberrationEffect({ offset: new THREE.Vector2(0, 0), radialModulation: true, modulationOffset: 0.25 });
    this.glitch = new GlitchEffect({ delay: new THREE.Vector2(2.5, 6), duration: new THREE.Vector2(0.06, 0.16), strength: new THREE.Vector2(0.008, 0.03), ratio: 0.97, columns: 0.02, chromaticAberrationOffset: new THREE.Vector2(0.002, 0.001) });
    this.glitch.mode = GlitchMode.DISABLED;
    this.grade = new GradeEffect();
    this.grade.u("uExposure").value = o.exposure;
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    this.baseVignette = 0.3 + o.vignette * 0.45;
    this.vignette = new VignetteEffect({ offset: 0.32, darkness: this.baseVignette });
    this.noise = o.crt ? new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false }) : null;
    if (this.noise) this.noise.blendMode.opacity.value = 0.08;
    this.scan = o.crt ? new ScanlineEffect({ blendFunction: BlendFunction.OVERLAY, density: 0.9 }) : null;
    if (this.scan) this.scan.blendMode.opacity.value = 0.06;
    // glitch transforms UVs, which can't share a pass with the CA convolution
    this.glitchPass = new EffectPass(camera, this.glitch);
    this.glitchPass.enabled = false;
    this.composer.addPass(this.glitchPass);
    const effects: Effect[] = [this.bloom, this.ca, this.grade, tone, this.vignette];
    if (this.noise) effects.push(this.noise);
    if (this.scan) effects.push(this.scan);
    this.composer.addPass(new EffectPass(camera, ...effects));
  }

  hit(strength: number) {
    this.caPulse = Math.min(1, Math.max(this.caPulse, strength));
  }

  flashColor(c: THREE.Color, a: number) {
    (this.grade.u("uFlash").value as THREE.Color).copy(c);
    this.flash = Math.min(0.8, Math.max(this.flash, a));
  }

  setStatic(on: boolean) {
    this.glitch.mode = on ? GlitchMode.SPORADIC : GlitchMode.DISABLED;
    this.glitchPass.enabled = on;
  }

  setBloomScale(s: number) {
    this.bloom.resolution.scale = s;
  }

  update(
    dt: number,
    s: { tint: THREE.Color; tintAmt: number; slow: number; hurt: number; danger: number; blackout: number; reduced: boolean },
  ) {
    this.caPulse = Math.max(0, this.caPulse - dt * 3);
    const ca = s.reduced ? 0 : this.caPulse * 0.006;
    this.caOffset.set(ca, ca * 0.6);
    this.ca.offset = this.caOffset;
    this.flash = Math.max(0, this.flash - dt * 3);
    const g = this.grade;
    (g.u("uTint").value as THREE.Color).copy(s.tint);
    g.u("uTintAmt").value = s.tintAmt * 0.55;
    g.u("uSat").value = 1 - s.slow * 0.4;
    g.u("uCool").value = s.slow * 0.28;
    g.u("uFlashAmt").value = s.reduced ? this.flash * 0.4 : this.flash;
    g.u("uHurt").value = s.hurt;
    g.u("uDanger").value = s.danger;
    this.vignette.darkness = Math.min(0.95, this.baseVignette + s.blackout * 0.45 + s.danger * 0.1);
  }

  setSize(w: number, h: number) {
    this.composer.setSize(w, h, false);
  }

  render(dt: number) {
    this.composer.render(dt);
  }

  dispose() {
    this.composer.dispose();
  }
}
