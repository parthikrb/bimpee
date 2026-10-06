import * as THREE from "three";

/** GLSL helpers shared by the patched materials. */
export const GLSL_NOISE = /* glsl */ `
float g_hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 g_hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
float g_noise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(g_hash12(i), g_hash12(i+vec2(1,0)), u.x), mix(g_hash12(i+vec2(0,1)), g_hash12(i+vec2(1,1)), u.x), u.y); }
float g_fbm(vec2 p){ float a = 0.5; float s = 0.0; for(int i=0;i<4;i++){ s += a*g_noise(p); p = p*2.03 + 17.1; a *= 0.5; } return s; }
// returns (F1, F2-F1) for a cellular pattern
vec2 g_voronoi(vec2 p, float t){ vec2 n = floor(p); vec2 f = fract(p); float f1 = 8.0; float f2 = 8.0;
  for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){ vec2 g = vec2(float(i), float(j)); vec2 o = g_hash22(n+g);
    o = 0.5 + 0.5*sin(t + 6.2831*o); vec2 r = g + o - f; float d = dot(r,r);
    if(d < f1){ f2 = f1; f1 = d; } else if(d < f2){ f2 = d; } }
  f1 = sqrt(f1); f2 = sqrt(f2); return vec2(f1, f2 - f1); }
float g_bayer(vec2 p){ vec2 a = mod(floor(p), 4.0); vec2 lo = mod(a, 2.0); vec2 hi = floor(a * 0.5);
  float m1 = mod(2.0*lo.x + 3.0*lo.y, 4.0); float m2 = mod(2.0*hi.x + 3.0*hi.y, 4.0);
  return (m1 * 4.0 + m2 + 0.5) / 16.0; }
`;

export interface GlowOptions {
  /** base emissive multiplier on the albedo (incl. instance / vertex color) */
  emissive?: number;
  /** fresnel rim emissive */
  rim?: number;
  /** per-instance aFx attribute (x=alpha dither, y=emissive boost, z=white flash, w=cracks) */
  instanceFx?: boolean;
  /** geometry has a per-vertex `aGlow` float for self-lit parts */
  vertexGlow?: boolean;
  /** sway vertices by height (kelp, banners): amplitude in world units */
  sway?: number;
}

export interface GlowUniforms {
  uEmissive: THREE.IUniform<number>;
  uRim: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
  /** used when instanceFx is false: same meaning as aFx */
  uFx: THREE.IUniform<THREE.Vector4>;
}

/**
 * MeshStandardMaterial with extra self-illumination: albedo * emissive,
 * a fresnel rim (silhouettes read against dark floors), optional per-instance
 * flash / dither-fade / crack glow. Keeps three's lights, shadows and fog.
 */
export function glowMaterial(params: THREE.MeshStandardMaterialParameters, opts: GlowOptions = {}): THREE.MeshStandardMaterial & { glow: GlowUniforms } {
  const m = new THREE.MeshStandardMaterial(params) as THREE.MeshStandardMaterial & { glow: GlowUniforms };
  const u: GlowUniforms = {
    uEmissive: { value: opts.emissive ?? 0.25 },
    uRim: { value: opts.rim ?? 0.6 },
    uTime: { value: 0 },
    uFx: { value: new THREE.Vector4(1, 0, 0, 0) },
  };
  m.glow = u;
  const key = `glow:${opts.instanceFx ? 1 : 0}${opts.vertexGlow ? 1 : 0}${opts.sway ? 1 : 0}`;
  m.customProgramCacheKey = () => key;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.uniforms.uSway = { value: opts.sway ?? 0 };
    let vs = sh.vertexShader;
    let fs = sh.fragmentShader;
    const defs = `${opts.instanceFx ? "#define GLOW_ATTR\n" : ""}${opts.vertexGlow ? "#define GLOW_VERTEX\n" : ""}${opts.sway ? "#define GLOW_SWAY\n" : ""}`;
    vs = vs.replace(
      "#include <common>",
      `#include <common>
${defs}
uniform float uTime; uniform float uSway;
varying vec3 vObjPos;
#ifdef GLOW_ATTR
attribute vec4 aFx; varying vec4 vFx;
#endif
#ifdef GLOW_VERTEX
attribute float aGlow; varying float vGlow;
#endif`,
    );
    vs = vs.replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
vObjPos = position;
#ifdef GLOW_ATTR
vFx = aFx;
#endif
#ifdef GLOW_VERTEX
vGlow = aGlow;
#endif
#ifdef GLOW_SWAY
{ float hgt = max(0.0, transformed.y);
  #ifdef USE_INSTANCING
  float ph = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.23;
  #else
  float ph = 0.0;
  #endif
  transformed.x += sin(uTime * 1.3 + ph + hgt * 0.4) * uSway * hgt * 0.08;
  transformed.z += cos(uTime * 1.1 + ph * 1.3 + hgt * 0.3) * uSway * hgt * 0.06; }
#endif`,
    );
    fs = fs.replace(
      "#include <common>",
      `#include <common>
${defs}
uniform float uEmissive; uniform float uRim; uniform float uTime;
varying vec3 vObjPos;
#ifdef GLOW_ATTR
varying vec4 vFx;
#else
uniform vec4 uFx;
#define vFx uFx
#endif
#ifdef GLOW_VERTEX
varying float vGlow;
#endif
${GLSL_NOISE}`,
    );
    fs = fs.replace(
      "#include <emissivemap_fragment>",
      `#include <emissivemap_fragment>
{
  if (vFx.x < 0.995 && vFx.x <= g_bayer(gl_FragCoord.xy)) discard;
  vec3 gAlb = diffuseColor.rgb;
  float gRim = pow(1.0 - clamp(abs(dot(normalize(vViewPosition), normal)), 0.0, 1.0), 2.2);
  float gEm = uEmissive + vFx.y;
  #ifdef GLOW_VERTEX
  gEm += vGlow;
  #endif
  totalEmissiveRadiance += gAlb * (gEm + gRim * uRim) + vec3(vFx.z);
  if (vFx.w > 0.001) {
    vec2 cr = g_voronoi(vObjPos.xz * 2.2 + vObjPos.y * 1.7, 0.0);
    float crack = 1.0 - smoothstep(0.0, 0.07 + 0.05 * vFx.w, cr.y);
    totalEmissiveRadiance += mix(gAlb, vec3(1.0, 0.95, 0.85), 0.6) * crack * vFx.w * 4.0;
  }
}`,
    );
    sh.vertexShader = vs;
    sh.fragmentShader = fs;
  };
  return m;
}

/** Uniforms shared by the wall material for the "see the player through walls" cutout. */
export interface OccluderUniforms {
  uOccCenter: THREE.IUniform<THREE.Vector2>;
  uOccRadius: THREE.IUniform<number>;
  uOccDepth: THREE.IUniform<number>;
  uOccStrength: THREE.IUniform<number>;
}

export function createOccluderUniforms(): OccluderUniforms {
  return {
    uOccCenter: { value: new THREE.Vector2(-9999, -9999) },
    uOccRadius: { value: 120 },
    uOccDepth: { value: 0 },
    uOccStrength: { value: 0 },
  };
}

export const BIOME_INDEX: Record<string, number> = {
  neon_city: 0,
  fungal_cathedral: 1,
  frozen_wastes: 2,
  desert_ruins: 3,
  abyssal_reef: 4,
  clockwork_foundry: 5,
  void_garden: 6,
  volcanic_forge: 7,
};

export interface WallColors {
  body: THREE.Color;
  top: THREE.Color;
  edge: THREE.Color;
  glow: THREE.Color;
  accent: THREE.Color;
}

/**
 * Instanced wall blocks: darker body, lighter caps, glowing edges on sides
 * that face open floor (per-instance aEdge mask), a glowing base strip, biome
 * face patterns, and a dithered cutout around the player when a wall sits
 * between the camera and the player.
 */
export function wallMaterial(biome: string, colors: WallColors, occ: OccluderUniforms, time: THREE.IUniform<number>, envDim: THREE.IUniform<number>): THREE.MeshStandardMaterial {
  const b = BIOME_INDEX[biome] ?? 0;
  const glossy = b === 2 || b === 6 || b === 0;
  const m = new THREE.MeshStandardMaterial({
    color: colors.body,
    roughness: glossy ? 0.35 : 0.8,
    metalness: b === 5 ? 0.55 : b === 0 ? 0.3 : 0.05,
  });
  const u = {
    uTop: { value: colors.top },
    uEdge: { value: colors.edge },
    uGlowC: { value: colors.glow },
    uAccentC: { value: colors.accent },
    uTime: time,
    uEnvDim: envDim,
    ...occ,
  };
  m.customProgramCacheKey = () => `wall${b}`;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
attribute vec4 aEdge; varying vec4 vEdge; varying vec3 vLocal; varying vec3 vWorldP; varying vec3 vScale;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
vEdge = aEdge; vLocal = position;
{ vec4 gw = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  gw = instanceMatrix * gw;
  vScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  #else
  vScale = vec3(1.0);
  #endif
  vWorldP = (modelMatrix * gw).xyz; }`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
#define BIOME ${b}
uniform vec3 uTop; uniform vec3 uEdge; uniform vec3 uGlowC; uniform vec3 uAccentC; uniform float uTime; uniform float uEnvDim;
uniform vec2 uOccCenter; uniform float uOccRadius; uniform float uOccDepth; uniform float uOccStrength;
varying vec4 vEdge; varying vec3 vLocal; varying vec3 vWorldP; varying vec3 vScale;
${GLSL_NOISE}`,
      )
      .replace(
        "#include <clipping_planes_fragment>",
        `#include <clipping_planes_fragment>
if (uOccStrength > 0.001 && vViewPosition.z < uOccDepth - 0.6) {
  float dpx = length(gl_FragCoord.xy - uOccCenter);
  float k = (1.0 - smoothstep(uOccRadius * 0.55, uOccRadius, dpx)) * uOccStrength;
  if (g_bayer(gl_FragCoord.xy) < k * 0.92) discard;
}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
float isTop = step(0.4995, vLocal.y);
float hgt = vWorldP.y;
// local distance to each side in world units (for crisp edges at any block size)
vec2 hsz = vScale.xz * 0.5;
vec2 lw = vLocal.xz * vScale.xz;
float dxN = lw.x + hsz.x; float dxP = hsz.x - lw.x; float dzN = lw.y + hsz.y; float dzP = hsz.y - lw.y;
float side = 1e3;
side = min(side, mix(1e3, dxN, vEdge.x)); side = min(side, mix(1e3, dxP, vEdge.y));
side = min(side, mix(1e3, dzN, vEdge.z)); side = min(side, mix(1e3, dzP, vEdge.w));
float topH = vScale.y;
float fromTop = topH - hgt;
float edgeLine = 0.0;
// glowing rim along the top of open faces
edgeLine += (1.0 - smoothstep(0.03, 0.09, side)) * isTop;
edgeLine += (1.0 - smoothstep(0.02, 0.08, fromTop)) * (1.0 - smoothstep(0.0, 0.02, side)) * (1.0 - isTop);
float baseStrip = (1.0 - smoothstep(0.05, 0.16, hgt)) * (1.0 - isTop);
vec3 alb = diffuseColor.rgb;
// ambient occlusion towards the floor, panel grooves
alb *= mix(0.35, 1.0, smoothstep(0.0, topH * 0.9, hgt));
float wcoord = (abs(vLocal.x) > 0.4995) ? vWorldP.z : vWorldP.x;
float panel = 1.0;
float selfLit = 0.0;
#if BIOME == 0
  // neon city: lit windows on the faces
  vec2 wc = vec2(wcoord * 2.2, hgt * 2.6);
  vec2 wi = floor(wc); vec2 wf = fract(wc);
  float win = step(0.25, wf.x) * step(wf.x, 0.75) * step(0.3, wf.y) * step(wf.y, 0.7);
  float lit = step(0.62, g_hash12(wi + floor(vWorldP.xz * 0.5)));
  selfLit += win * lit * (1.0 - isTop) * step(0.4, hgt) * 0.9;
  panel = 1.0 - 0.25 * step(0.96, fract(hgt * 1.3));
#elif BIOME == 1
  float n = g_fbm(vec2(wcoord, hgt) * 1.6 + vWorldP.xz * 0.3);
  alb *= 0.7 + 0.6 * n;
  float spots = smoothstep(0.78, 0.84, g_noise(vec2(wcoord, hgt) * 3.0 + 7.0));
  selfLit += spots * (1.0 - isTop) * 0.8;
#elif BIOME == 2
  vec2 cr = g_voronoi(vec2(wcoord, hgt) * 1.4 + vWorldP.xz * 0.2, 0.0);
  alb *= 0.85 + 0.35 * smoothstep(0.0, 0.5, cr.x);
  selfLit += (1.0 - smoothstep(0.0, 0.05, cr.y)) * 0.35;
#elif BIOME == 3
  // sandstone blocks
  vec2 bc = vec2(wcoord * 1.1 + floor(hgt * 1.6) * 0.5, hgt * 1.6);
  vec2 bf = fract(bc);
  panel = 0.72 + 0.28 * step(0.06, bf.x) * step(0.08, bf.y);
  alb *= 0.85 + 0.25 * g_noise(bc * 3.0);
  selfLit += step(0.94, g_hash12(floor(bc))) * step(0.3, bf.y) * step(bf.y, 0.7) * 0.6 * (1.0 - isTop);
#elif BIOME == 4
  float n = g_fbm(vec2(wcoord, hgt) * 2.0 + vWorldP.xz * 0.2);
  alb *= 0.6 + 0.8 * n;
  selfLit += smoothstep(0.7, 0.75, g_noise(vec2(wcoord * 3.0, hgt * 3.0 - uTime * 0.2))) * 0.7;
#elif BIOME == 5
  panel = 1.0 - 0.35 * step(0.92, fract(hgt * 1.25)) - 0.25 * step(0.95, fract(wcoord * 0.5));
  vec2 rv = fract(vec2(wcoord * 2.0, hgt * 2.5)) - 0.5;
  selfLit += (1.0 - smoothstep(0.06, 0.1, length(rv))) * 0.25 * (1.0 - isTop);
#elif BIOME == 6
  float grad = smoothstep(0.0, topH, hgt);
  selfLit += grad * grad * 0.45 * (1.0 - isTop);
  selfLit += step(0.985, g_hash12(floor(vec2(wcoord, hgt) * 8.0))) * 1.5;
#elif BIOME == 7
  vec2 cr = g_voronoi(vec2(wcoord, hgt) * 1.2 + vWorldP.xz * 0.15, 0.0);
  float lava = 1.0 - smoothstep(0.0, 0.06, cr.y);
  selfLit += lava * (0.8 + 0.4 * sin(uTime * 2.0 + vWorldP.x)) * (1.0 - smoothstep(0.0, topH, hgt) * 0.6) * 1.6;
  alb *= 0.6 + 0.4 * g_noise(vec2(wcoord, hgt) * 4.0);
#endif
alb *= panel;
diffuseColor.rgb = mix(alb, uTop * panel, isTop);`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
totalEmissiveRadiance += uEdge * edgeLine * 2.6 + uGlowC * baseStrip * 1.4;
#if BIOME == 7
totalEmissiveRadiance += vec3(1.0, 0.35, 0.05) * selfLit;
#elif BIOME == 0
totalEmissiveRadiance += mix(uGlowC, uAccentC, step(0.5, g_hash12(floor(vWorldP.xz) + floor(hgt * 2.6)))) * selfLit;
#else
totalEmissiveRadiance += uGlowC * selfLit;
#endif
totalEmissiveRadiance *= uEnvDim;`,
      );
  };
  return m;
}

export interface FloorColors {
  floor: THREE.Color;
  bg: THREE.Color;
  wall: THREE.Color;
  glow: THREE.Color;
  accent: THREE.Color;
}

/**
 * Procedural arena floor: biome pattern, grid / cracks / caustics, pools and
 * wall AO from a small data mask (R = pool, G = wall), subtle emissive lines.
 */
export function floorMaterial(biome: string, c: FloorColors, mask: THREE.Texture, mapSize: THREE.Vector2, time: THREE.IUniform<number>, envDim: THREE.IUniform<number>): THREE.MeshStandardMaterial {
  const b = BIOME_INDEX[biome] ?? 0;
  const rough = [0.32, 0.85, 0.28, 0.95, 0.75, 0.55, 0.3, 0.8][b] ?? 0.7;
  const metal = [0.35, 0.0, 0.1, 0.0, 0.0, 0.5, 0.2, 0.05][b] ?? 0;
  const m = new THREE.MeshStandardMaterial({ color: c.floor, roughness: rough, metalness: metal });
  const u = {
    uMask: { value: mask },
    uMapSize: { value: mapSize },
    uBg: { value: c.bg },
    uWallC: { value: c.wall },
    uGlowC: { value: c.glow },
    uAccentC: { value: c.accent },
    uTime: time,
    uEnvDim: envDim,
  };
  m.customProgramCacheKey = () => `floor${b}`;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vWorldP;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\nvWorldP = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
#define BIOME ${b}
uniform sampler2D uMask; uniform vec2 uMapSize; uniform vec3 uBg; uniform vec3 uWallC; uniform vec3 uGlowC; uniform vec3 uAccentC; uniform float uTime; uniform float uEnvDim;
varying vec3 vWorldP;
${GLSL_NOISE}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
vec2 wp = vWorldP.xz;
vec2 tp = wp * 0.5; // tile units (1 tile = 2 world units)
vec4 mk = texture2D(uMask, wp / uMapSize);
float pool = smoothstep(0.35, 0.65, mk.r);
float poolEdge = smoothstep(0.2, 0.42, mk.r) * (1.0 - smoothstep(0.42, 0.62, mk.r));
float nearWall = mk.g;
vec3 alb = diffuseColor.rgb;
vec3 fEm = vec3(0.0);
float rgh = roughness;
float n1 = g_fbm(wp * 0.35);
alb *= 0.82 + 0.36 * n1;
#if BIOME == 0
  vec2 gw = fwidth(tp);
  vec2 gl = abs(fract(tp - 0.5) - 0.5) / max(gw * 1.4, vec2(1e-4));
  float line = (1.0 - min(min(gl.x, gl.y), 1.0)) * (1.0 - smoothstep(0.08, 0.35, max(gw.x, gw.y)));
  float tileLit = step(0.93, g_hash12(floor(tp)));
  fEm += uAccentC * line * 0.32 + uWallC * tileLit * 0.10 * (0.6 + 0.4 * sin(uTime * 1.5 + g_hash12(floor(tp)) * 30.0));
  alb *= 0.9 + 0.2 * step(0.5, g_hash12(floor(tp) + 3.0));
#elif BIOME == 1
  vec2 v = g_voronoi(wp * 0.55, 0.0);
  float vein = 1.0 - smoothstep(0.0, 0.035, v.y);
  float veinMask = smoothstep(0.35, 0.65, g_fbm(wp * 0.12 + 3.0));
  fEm += uGlowC * vein * veinMask * (0.12 + 0.08 * sin(uTime * 1.2 + n1 * 9.0));
  alb *= 0.75 + 0.5 * smoothstep(0.0, 0.6, v.x);
  alb = mix(alb, alb * vec3(0.8, 1.15, 0.7), smoothstep(0.45, 0.7, g_fbm(wp * 0.8 + 4.0)));
#elif BIOME == 2
  vec2 v = g_voronoi(wp * 0.55, 0.0);
  float crack = 1.0 - smoothstep(0.0, 0.035, v.y);
  alb = mix(alb, alb * 1.35 + 0.05, smoothstep(0.1, 0.6, v.x));
  fEm += uGlowC * crack * 0.22;
  fEm += vec3(step(0.9985, g_hash12(floor(wp * 14.0)))) * 0.5;
#elif BIOME == 3
  float rip = sin(wp.x * 2.4 + wp.y * 0.6 + g_fbm(wp * 0.4) * 6.0);
  alb *= 0.9 + 0.12 * rip;
  vec2 g = abs(fract(tp * 0.5) - 0.5);
  float slab = smoothstep(0.48, 0.5, max(g.x, g.y)) * step(0.55, g_fbm(wp * 0.15 + 2.0));
  alb *= 1.0 - slab * 0.35;
#elif BIOME == 4
  vec2 c1 = g_voronoi(wp * 0.6 + vec2(uTime * 0.12, uTime * 0.07), uTime * 0.6);
  vec2 c2 = g_voronoi(wp * 0.9 - vec2(uTime * 0.05, uTime * 0.1), uTime * 0.5 + 2.0);
  float caus = pow(1.0 - smoothstep(0.0, 0.12, c1.y), 2.0) + pow(1.0 - smoothstep(0.0, 0.1, c2.y), 2.0) * 0.6;
  fEm += uGlowC * caus * 0.28;
#elif BIOME == 5
  vec2 pf = fract(tp);
  vec2 g = abs(pf - 0.5);
  float seam = smoothstep(0.47, 0.5, max(g.x, g.y));
  float rivet = 1.0 - smoothstep(0.035, 0.06, length(abs(pf - 0.5) - 0.4));
  alb *= (0.85 + 0.25 * step(0.5, g_hash12(floor(tp)))) * (1.0 - seam * 0.5);
  alb += rivet * 0.12;
  rgh = mix(rgh, 0.25, rivet);
  float stripe = step(0.5, fract((wp.x + wp.y) * 0.5)) * step(0.97, g_hash12(floor(tp * 0.25)));
  alb = mix(alb, uGlowC * 0.6, stripe * 0.5);
#elif BIOME == 6
  fEm += vec3(1.0) * step(0.997, g_hash12(floor(wp * 6.0))) * 0.9;
  float rings = abs(fract(length(wp - uMapSize * 0.5) * 0.12 - uTime * 0.03) - 0.5);
  fEm += uGlowC * (1.0 - smoothstep(0.0, 0.02, rings)) * 0.18;
  vec2 gw = fwidth(tp);
  vec2 gl = abs(fract(tp - 0.5) - 0.5) / max(gw * 1.2, vec2(1e-4));
  fEm += uWallC * (1.0 - min(min(gl.x, gl.y), 1.0)) * 0.1;
#elif BIOME == 7
  vec2 v = g_voronoi(wp * 0.75, 0.0);
  float seam = 1.0 - smoothstep(0.0, 0.035, v.y);
  float hot = smoothstep(0.5, 0.75, g_fbm(wp * 0.06 + vec2(uTime * 0.015, 0.0)));
  float pulse = 0.7 + 0.3 * sin(uTime * 1.7 + v.x * 6.0);
  fEm += vec3(1.0, 0.28, 0.03) * seam * hot * 1.3 * pulse;
  alb *= (0.55 + 0.45 * smoothstep(0.0, 0.35, v.x)) * (1.0 - seam * (1.0 - hot) * 0.6);
#endif
// pools: dark glossy water with a glowing rim
alb = mix(alb, uBg * 0.45, pool);
rgh = mix(rgh, 0.08, pool);
fEm += uGlowC * poolEdge * 0.35;
fEm += uGlowC * pool * 0.05 * (0.5 + 0.5 * sin(uTime * 1.3 + wp.x * 0.8 + wp.y * 0.6));
// fake AO + a soft glow line where walls meet the floor
alb *= 1.0 - smoothstep(0.05, 0.5, nearWall) * 0.55;
fEm += uGlowC * smoothstep(0.32, 0.5, nearWall) * 0.35;
diffuseColor.rgb = alb;`,
      )
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = rgh;")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += fEm * uEnvDim;");
  };
  return m;
}

/** Additive fresnel bubble (shields). Instance colour drives tint and strength. */
export function bubbleMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0x9fe8ff) } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying vec3 vC; varying vec3 vP;
      uniform vec3 uColor;
      void main(){
        vec4 p = vec4(position, 1.0);
        vC = uColor;
        #ifdef USE_INSTANCING
        p = instanceMatrix * p;
        #endif
        #ifdef USE_INSTANCING_COLOR
        vC = instanceColor;
        #endif
        vec4 mv = modelViewMatrix * p;
        vN = normalize(normalMatrix * mat3(
        #ifdef USE_INSTANCING
          instanceMatrix
        #else
          mat4(1.0)
        #endif
        ) * normal);
        vV = -mv.xyz; vP = position;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying vec3 vC; varying vec3 vP; uniform float uTime;
      void main(){
        float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.5);
        float hex = 0.5 + 0.5 * sin(vP.y * 30.0 + uTime * 4.0);
        gl_FragColor = vec4(vC * (f * 1.6 + 0.04 + hex * f * 0.4), 1.0);
      }`,
  });
}

/** Tall additive light pillar (chests, shrines). Pierces fog on purpose. */
export function pillarMaterial(color: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uColor: { value: color.clone() }, uAlpha: { value: 1 } },
    vertexShader: /* glsl */ `varying vec2 vUv; varying float vNear; varying vec3 vN; varying vec3 vV;
      void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vNear = smoothstep(3.0, 16.0, -mv.z);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv; varying float vNear; varying vec3 vN; varying vec3 vV; uniform float uTime; uniform vec3 uColor; uniform float uAlpha;
      void main(){
        float fade = pow(1.0 - vUv.y, 1.6);
        float bands = 0.75 + 0.25 * sin(vUv.y * 40.0 - uTime * 4.0);
        // bright core, soft sides: strongest where the surface faces the viewer
        float core = pow(abs(dot(vN, vV)), 2.0);
        gl_FragColor = vec4(uColor * fade * bands * core * uAlpha * vNear * 1.3, 1.0);
      }`,
  });
}

/** Cylindrical energy beam (lasers, lances, teleports): bright core, soft edges. */
export function beamMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying vec3 vC; varying float vY;
      void main(){
        vec4 p = vec4(position, 1.0);
        vC = vec3(1.0);
        #ifdef USE_INSTANCING
        p = instanceMatrix * p;
        vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
        #else
        vN = normalize(normalMatrix * normal);
        #endif
        #ifdef USE_INSTANCING_COLOR
        vC = instanceColor;
        #endif
        vY = position.y;
        vec4 mv = modelViewMatrix * p; vV = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying vec3 vC; varying float vY; uniform float uTime;
      void main(){
        float f = abs(dot(normalize(vN), normalize(vV)));
        float core = pow(f, 3.0);
        float flick = 0.85 + 0.15 * sin(vY * 60.0 - uTime * 40.0);
        gl_FragColor = vec4((vC * (0.25 + f) + vec3(core) * length(vC) * 0.6) * flick, 1.0);
      }`,
  });
}
