import * as THREE from "three";
import type { Bag } from "./bag";

/**
 * Immediate-mode instanced quads (one draw call per batch):
 *  - "billboard": camera-facing sprites (glows, particles), rotation = spin
 *  - "ground": flat decals on the floor (rings, puddles, scorch), rotation = yaw
 *  - "streak": billboards stretched along a world direction (sparks, trails)
 *  - "bar": billboard progress bar, `rot` = fill fraction (hp bars)
 * Colours are linear and may exceed 1 (bloom). Call begin(), push() per quad,
 * end() once per frame.
 */
export type QuadMode = "billboard" | "ground" | "streak" | "bar";

export interface QuadBatchOptions {
  mode: QuadMode;
  capacity: number;
  texture?: THREE.Texture | null;
  additive?: boolean;
  fog?: boolean;
  depthTest?: boolean;
  renderOrder?: number;
}

const VERT = /* glsl */ `
attribute vec3 iPos; attribute vec2 iSize; attribute vec4 iColor; attribute float iRot; attribute vec3 iDir;
varying vec2 vUv; varying vec4 vColor; varying float vFogDepth; varying float vFill;
void main(){
  vUv = uv; vColor = iColor; vFill = iRot;
  vec2 c = position.xy; // -0.5..0.5
  vec4 mv;
#if QMODE == 1
  float cr = cos(iRot), sr = sin(iRot);
  vec2 q = vec2(c.x * iSize.x, c.y * iSize.y);
  vec3 wp = iPos + vec3(q.x * cr - q.y * sr, 0.0, -(q.x * sr + q.y * cr));
  mv = modelViewMatrix * vec4(wp, 1.0);
#elif QMODE == 2
  vec4 p0 = modelViewMatrix * vec4(iPos, 1.0);
  vec4 p1 = modelViewMatrix * vec4(iPos + iDir, 1.0);
  vec2 d = p1.xy / max(0.001, -p1.z) - p0.xy / max(0.001, -p0.z);
  float dl = length(d);
  vec2 dir = dl > 1e-5 ? d / dl : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  mv = p0;
  mv.xy += dir * (c.x - 0.5) * iSize.x + perp * c.y * iSize.y;
#else
  mv = modelViewMatrix * vec4(iPos, 1.0);
  float cr = cos(iRot), sr = sin(iRot);
  #if QMODE == 3
  cr = 1.0; sr = 0.0;
  #endif
  vec2 q = vec2(c.x * iSize.x, c.y * iSize.y);
  mv.xy += vec2(q.x * cr - q.y * sr, q.x * sr + q.y * cr);
#endif
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform sampler2D uMap; uniform float uHasMap;
uniform vec3 fogColor; uniform float fogDensity;
varying vec2 vUv; varying vec4 vColor; varying float vFogDepth; varying float vFill;
void main(){
#if QMODE == 3
  float inside = step(vUv.x, vFill);
  float border = step(0.06, vUv.x) * step(vUv.x, 0.94) * step(0.18, vUv.y) * step(vUv.y, 0.82);
  vec4 col = mix(vec4(0.0, 0.0, 0.0, 0.65), vec4(vColor.rgb, vColor.a), inside * border);
#else
  vec4 tex = uHasMap > 0.5 ? texture2D(uMap, vUv) : vec4(1.0);
  vec4 col = vec4(vColor.rgb * tex.rgb, vColor.a * tex.a);
#endif
  if (col.a < 0.003) discard;
  float fogF = 0.0;
#ifdef USE_FOG
  fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
#endif
#ifdef ADDITIVE
  gl_FragColor = vec4(col.rgb * col.a * (1.0 - fogF), 1.0);
#else
  gl_FragColor = vec4(mix(col.rgb, fogColor, fogF), col.a);
#endif
}`;

const MODE_ID: Record<QuadMode, number> = { billboard: 0, ground: 1, streak: 2, bar: 3 };

export class QuadBatch {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly pos: Float32Array;
  private readonly size: Float32Array;
  private readonly color: Float32Array;
  private readonly rot: Float32Array;
  private readonly dir: Float32Array;
  private readonly attrs: THREE.InstancedBufferAttribute[];
  count = 0;

  constructor(bag: Bag, o: QuadBatchOptions) {
    this.capacity = Math.max(1, Math.floor(o.capacity));
    const n = this.capacity;
    const plane = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = plane.index;
    geo.setAttribute("position", plane.getAttribute("position"));
    geo.setAttribute("uv", plane.getAttribute("uv"));
    plane.dispose();
    this.pos = new Float32Array(n * 3);
    this.size = new Float32Array(n * 2);
    this.color = new Float32Array(n * 4);
    this.rot = new Float32Array(n);
    this.dir = new Float32Array(n * 3);
    const mk = (arr: Float32Array, k: number) => {
      const a = new THREE.InstancedBufferAttribute(arr, k);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.attrs = [mk(this.pos, 3), mk(this.size, 2), mk(this.color, 4), mk(this.rot, 1), mk(this.dir, 3)];
    geo.setAttribute("iPos", this.attrs[0]!);
    geo.setAttribute("iSize", this.attrs[1]!);
    geo.setAttribute("iColor", this.attrs[2]!);
    geo.setAttribute("iRot", this.attrs[3]!);
    geo.setAttribute("iDir", this.attrs[4]!);
    geo.instanceCount = 0;
    this.geo = bag.track(geo);
    const additive = o.additive !== false;
    const mat = bag.track(
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        defines: { QMODE: MODE_ID[o.mode], ...(additive ? { ADDITIVE: 1 } : {}) },
        uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uMap: { value: null }, uHasMap: { value: 0 } }]),
        transparent: true,
        depthWrite: false,
        depthTest: o.depthTest !== false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        fog: o.fog !== false,
        side: THREE.DoubleSide,
        polygonOffset: o.mode === "ground",
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
      }),
    );
    mat.uniforms.uMap!.value = o.texture ?? null;
    mat.uniforms.uHasMap!.value = o.texture ? 1 : 0;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = o.renderOrder ?? (o.mode === "ground" ? 1 : 5);
    this.mesh.matrixAutoUpdate = false;
  }

  begin() {
    this.count = 0;
  }

  /** Returns false when full. */
  push(x: number, y: number, z: number, w: number, h: number, r: number, g: number, b: number, a: number, rot = 0, dx = 0, dy = 0, dz = 0): boolean {
    const i = this.count;
    if (i >= this.capacity) return false;
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) && Number.isFinite(w) && Number.isFinite(h))) return true;
    const i3 = i * 3;
    this.pos[i3] = x;
    this.pos[i3 + 1] = y;
    this.pos[i3 + 2] = z;
    this.size[i * 2] = w;
    this.size[i * 2 + 1] = h;
    const i4 = i * 4;
    this.color[i4] = r;
    this.color[i4 + 1] = g;
    this.color[i4 + 2] = b;
    this.color[i4 + 3] = a;
    this.rot[i] = rot;
    this.dir[i3] = dx;
    this.dir[i3 + 1] = dy;
    this.dir[i3 + 2] = dz;
    this.count++;
    return true;
  }

  end() {
    const n = this.count;
    this.geo.instanceCount = n;
    if (n === 0) return;
    const sizes = [3, 2, 4, 1, 3];
    for (let k = 0; k < this.attrs.length; k++) {
      const a = this.attrs[k]!;
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * sizes[k]!);
      a.needsUpdate = true;
    }
  }
}
