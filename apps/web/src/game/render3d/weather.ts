import * as THREE from "three";
import type { Weather } from "@bimpee/shared";
import type { Bag } from "./bag";
import type { Fx } from "./fx";

interface Kit {
  count: number;
  /** box size around the camera target */
  box: [number, number, number];
  vel: [number, number, number];
  size: number;
  color: number;
  alpha: number;
  additive: boolean;
  /** fragment-shape id */
  shape: number;
  /** fog density multiplier while active */
  fog: number;
  fogColor: number | null;
}

const KITS: Record<Exclude<Weather, "none">, Kit> = {
  rain: { count: 2600, box: [60, 26, 60], vel: [-2, -34, 1], size: 0.9, color: 0xa8c8ff, alpha: 0.32, additive: false, shape: 0, fog: 1.15, fogColor: null },
  snow: { count: 2200, box: [60, 24, 60], vel: [-1.2, -2.2, 0.6], size: 0.16, color: 0xffffff, alpha: 0.85, additive: false, shape: 1, fog: 1.2, fogColor: 0xc8dcff },
  embers: { count: 700, box: [56, 18, 56], vel: [0.6, 2.4, 0.3], size: 0.13, color: 0xff8a3a, alpha: 1, additive: true, shape: 2, fog: 1, fogColor: null },
  spores: { count: 900, box: [56, 14, 56], vel: [0.3, 0.35, 0.2], size: 0.2, color: 0xc8ff6a, alpha: 0.8, additive: true, shape: 2, fog: 1.15, fogColor: null },
  sandstorm: { count: 2400, box: [60, 14, 60], vel: [24, -1.5, 6], size: 0.7, color: 0xe8c48a, alpha: 0.45, additive: false, shape: 3, fog: 2.6, fogColor: 0xc89a55 },
  bubbles: { count: 420, box: [56, 18, 56], vel: [0, 1.8, 0], size: 0.3, color: 0xbff6ff, alpha: 0.3, additive: true, shape: 4, fog: 1.1, fogColor: null },
  static: { count: 220, box: [50, 16, 50], vel: [0, 0, 0], size: 0.45, color: 0xd8e8ff, alpha: 0.45, additive: true, shape: 5, fog: 1, fogColor: null },
};

const VERT = /* glsl */ `
attribute vec4 aRand;
uniform float uTime; uniform vec3 uCenter; uniform vec3 uBox; uniform vec3 uVel; uniform float uSize; uniform float uScale;
varying float vRand; varying float vFade;
void main(){
  vec3 q = position * uBox + uVel * uTime * (0.75 + 0.5 * aRand.x);
  q.x += sin(uTime * (0.6 + aRand.y) + aRand.z * 20.0) * 0.6 * (SHAPE == 1 || SHAPE == 2 || SHAPE == 4 ? 1.0 : 0.0);
  q.z += cos(uTime * (0.5 + aRand.x) + aRand.w * 20.0) * 0.6 * (SHAPE == 1 || SHAPE == 2 ? 1.0 : 0.0);
  vec3 lo = uCenter - uBox * 0.5;
  lo.y = -1.0;
  vec3 w = lo + mod(q - lo, uBox);
#if SHAPE == 5
  w.xz += (floor(uTime * 12.0 + aRand.y * 7.0) * aRand.zw - 0.5) * 3.0;
#endif
  vec4 mv = modelViewMatrix * vec4(w, 1.0);
  float d = -mv.z;
  // fade at the box borders and near the camera
  vec3 rel = (w - uCenter) / (uBox * 0.5);
  vFade = (1.0 - smoothstep(0.75, 1.0, max(abs(rel.x), abs(rel.z)))) * smoothstep(0.5, 2.0, d);
  vRand = aRand.x;
  gl_PointSize = min(96.0, uSize * (0.6 + 0.8 * aRand.w) * uScale / max(0.5, d));
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uAlpha; uniform float uTime;
varying float vRand; varying float vFade;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float a = 0.0;
#if SHAPE == 0
  a = (1.0 - smoothstep(0.0, 0.06, abs(c.x))) * (1.0 - smoothstep(0.2, 0.5, abs(c.y)));
#elif SHAPE == 1
  a = 1.0 - smoothstep(0.15, 0.5, length(c));
#elif SHAPE == 2
  a = (1.0 - smoothstep(0.0, 0.5, length(c))) * (0.55 + 0.45 * sin(uTime * 6.0 + vRand * 40.0));
#elif SHAPE == 3
  a = (1.0 - smoothstep(0.0, 0.08, abs(c.y))) * (1.0 - smoothstep(0.1, 0.5, abs(c.x)));
#elif SHAPE == 4
  float r = length(c); a = smoothstep(0.32, 0.42, r) * (1.0 - smoothstep(0.42, 0.5, r)) + (1.0 - smoothstep(0.0, 0.12, length(c - vec2(-0.12, 0.12)))) * 0.8;
#else
  a = step(abs(c.x), 0.48) * step(abs(c.y), 0.035) * step(0.8, fract(sin(floor(uTime * 14.0) + vRand * 91.0) * 437.5));
#endif
  a *= uAlpha * vFade;
  if (a < 0.01) discard;
#ifdef ADDITIVE
  gl_FragColor = vec4(uColor * a * 1.6, 1.0);
#else
  gl_FragColor = vec4(uColor, a);
#endif
}`;

interface Layer {
  points: THREE.Points;
  mat: THREE.ShaderMaterial;
  geo: THREE.BufferGeometry;
  kind: Weather;
  fade: number;
  target: number;
}

/** GPU particle volume around the camera target, cross-fading on weather changes. */
export class WeatherLayer {
  private layers: Layer[] = [];
  private time = 0;
  private splashAcc = 0;
  kind: Weather = "none";
  private readonly fogColor = new THREE.Color();

  constructor(
    private readonly bag: Bag,
    private readonly scene: THREE.Object3D,
    private readonly fx: Fx | null,
    private particleScale = 1,
    private readonly reduced: () => boolean = () => false,
  ) {}

  set(kind: Weather) {
    if (kind === this.kind) return;
    this.kind = kind;
    for (const l of this.layers) l.target = 0;
    if (kind === "none" || !(kind in KITS)) return;
    const kit = KITS[kind as Exclude<Weather, "none">];
    const n = Math.max(50, Math.round(kit.count * this.particleScale * (this.reduced() ? 0.5 : 1)));
    const pos = new Float32Array(n * 3);
    const rnd = new Float32Array(n * 4);
    for (let i = 0; i < n * 3; i++) pos[i] = Math.random();
    for (let i = 0; i < n * 4; i++) rnd[i] = Math.random();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aRand", new THREE.BufferAttribute(rnd, 4));
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      defines: { SHAPE: kit.shape, ...(kit.additive ? { ADDITIVE: 1 } : {}) },
      uniforms: {
        uTime: { value: 0 },
        uCenter: { value: new THREE.Vector3() },
        uBox: { value: new THREE.Vector3(...kit.box) },
        uVel: { value: new THREE.Vector3(...kit.vel) },
        uSize: { value: kit.size },
        uScale: { value: 1 },
        uColor: { value: new THREE.Color(kit.color).multiplyScalar(kit.additive ? 1.5 : 1) },
        uAlpha: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: kit.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 12;
    this.scene.add(points);
    this.layers.push({ points, mat, geo, kind, fade: 0, target: 1 });
  }

  /** Fog multiplier and colour the current weather asks for. */
  fogInfo(): { mul: number; color: THREE.Color | null } {
    if (this.kind === "none") return { mul: 1, color: null };
    const kit = KITS[this.kind as Exclude<Weather, "none">];
    if (!kit) return { mul: 1, color: null };
    const live = this.layers.find((l) => l.kind === this.kind);
    const f = live ? live.fade : 0;
    return { mul: 1 + (kit.fog - 1) * f, color: kit.fogColor === null ? null : this.fogColor.setHex(kit.fogColor) };
  }

  /** `pxPerUnit`: screen pixels per world unit at distance 1 (viewport height / (2 tan(fov/2))). */
  update(dt: number, center: THREE.Vector3, pxPerUnit: number, dim = 1) {
    this.time += dt;
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const l = this.layers[i]!;
      l.fade += Math.sign(l.target - l.fade) * Math.min(Math.abs(l.target - l.fade), dt / 1.5);
      if (l.target === 0 && l.fade <= 0.001) {
        l.points.removeFromParent();
        l.geo.dispose();
        l.mat.dispose();
        this.layers.splice(i, 1);
        continue;
      }
      const kit = KITS[l.kind as Exclude<Weather, "none">];
      const u = l.mat.uniforms;
      u.uTime!.value = this.time;
      (u.uCenter!.value as THREE.Vector3).copy(center);
      u.uScale!.value = pxPerUnit;
      u.uAlpha!.value = (kit?.alpha ?? 1) * l.fade * dim;
    }
    // rain splashes on the floor around the player
    if (this.kind === "rain" && this.fx && dt > 0) {
      this.splashAcc += dt * 40 * this.particleScale;
      while (this.splashAcc >= 1) {
        this.splashAcc -= 1;
        const x = center.x + (Math.random() - 0.5) * 36;
        const z = center.z + (Math.random() - 0.5) * 36;
        this.fx.spawn({ kind: 3, x, y: 0.04, z, life: 0.35, s0: 0.05, s1: 0.7, r: 0.5, g: 0.6, b: 0.8, a: 0.7, drag: 0 });
      }
    }
  }

  setParticleScale(s: number) {
    this.particleScale = s;
  }

  dispose() {
    for (const l of this.layers) {
      l.points.removeFromParent();
      l.geo.dispose();
      l.mat.dispose();
    }
    this.layers = [];
    void this.bag;
  }
}
