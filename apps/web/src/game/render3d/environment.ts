import * as THREE from "three";
import { createRng, type WorldSpec } from "@bimpee/shared";
import type { GameMap } from "../logic/mapgen";
import type { Bag } from "./bag";
import { buildBackdrop, buildProps, type Animated } from "./backdrop";
import { S, WALL_H } from "./coords";
import { createOccluderUniforms, floorMaterial, GLSL_NOISE, wallMaterial, type OccluderUniforms } from "./materials";
import { mixC, palette, styleFor, type BiomeStyle, type Pal } from "./palette";

/** Tallest wall block (camera collision uses this). */
export const WALL_MAX = WALL_H * 1.25;

export interface EnvOptions {
  shadows: boolean;
  shadowSize: number;
  /** cheaper preview (no props animation, fewer backdrop items) */
  preview?: boolean;
}

/** Per-frame inputs that drive atmosphere changes. */
export interface EnvFrame {
  /** 0..1 blackout */
  blackout: number;
  /** extra fog density multiplier from weather (sandstorm) */
  weatherFog: number;
  /** colour the weather pushes the fog towards (null = none) */
  weatherFogColor: THREE.Color | null;
}

function skyMaterial(top: THREE.Color, horizon: THREE.Color, bottom: THREE.Color, style: BiomeStyle, glow: THREE.Color, time: THREE.IUniform<number>) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: top.clone() },
      uHorizon: { value: horizon.clone() },
      uBottom: { value: bottom.clone() },
      uGlow: { value: glow.clone() },
      uStars: { value: style.stars },
      uSun: { value: style.sun },
      uSunDir: { value: new THREE.Vector3(0.5, Math.sin(style.elev * 0.35), -0.7).normalize() },
      uDim: { value: 1 },
      uTime: time,
    },
    vertexShader: /* glsl */ `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uBottom; uniform vec3 uGlow; uniform float uStars; uniform float uSun; uniform vec3 uSunDir; uniform float uDim; uniform float uTime;
      varying vec3 vDir;
      ${GLSL_NOISE}
      void main(){
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = h > 0.0 ? mix(uHorizon, uTop, pow(smoothstep(0.0, 0.65, h), 0.7)) : mix(uHorizon, uBottom, smoothstep(0.0, 0.25, -h));
        // bright band just above the horizon
        col += uGlow * 0.25 * exp(-abs(h - 0.02) * 22.0);
        // drifting cloud streaks
        vec2 uv = d.xz / max(0.15, h + 0.2);
        float cl = g_fbm(uv * 1.3 + vec2(uTime * 0.01, 0.0));
        col = mix(col, col * 1.35 + uGlow * 0.04, smoothstep(0.55, 0.85, cl) * smoothstep(0.0, 0.3, h) * 0.5);
        // stars
        if (uStars > 0.0 && h > 0.05) {
          vec3 sd = d * 220.0; vec3 cell = floor(sd); float r = g_hash12(cell.xy + cell.z * 7.13);
          float tw = 0.6 + 0.4 * sin(uTime * 2.0 + r * 50.0);
          float star = step(0.985, r) * (1.0 - smoothstep(0.0, 0.42, length(fract(sd) - 0.5)));
          col += vec3(star * uStars * tw * smoothstep(0.05, 0.3, h) * 1.4);
        }
        // sun / moon disc with halo
        if (uSun > 0.0) {
          float sd = max(0.0, dot(d, uSunDir));
          col += uGlow * pow(sd, 400.0) * 3.0 * uSun + mix(uGlow, vec3(1.0), 0.5) * pow(sd, 12.0) * 0.35 * uSun;
        }
        gl_FragColor = vec4(col * uDim, 1.0);
      }`,
  });
}

function buildMask(map: GameMap): Uint8Array {
  const { cols, rows, solid, pool } = map;
  const data = new Uint8Array(cols * rows * 4);
  for (let i = 0; i < cols * rows; i++) {
    data[i * 4] = pool[i] ? 255 : 0;
    data[i * 4 + 1] = solid[i] ? 255 : 0;
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 255;
  }
  return data;
}

function groundMaterial(base: THREE.Color, glow: THREE.Color, biome: string) {
  const m = new THREE.MeshStandardMaterial({ color: base, roughness: 0.95, metalness: 0 });
  const lava = biome === "volcanic_forge" ? 1 : 0;
  m.customProgramCacheKey = () => `ground${lava}`;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uGlowC = { value: glow };
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWorldP;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWorldP = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vWorldP; uniform vec3 uGlowC;\n${GLSL_NOISE}`)
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
float gn = g_fbm(vWorldP.xz * 0.04) * 0.7 + g_fbm(vWorldP.xz * 0.3) * 0.3;
diffuseColor.rgb *= 0.55 + 0.75 * gn;`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
${lava ? "vec2 lv = g_voronoi(vWorldP.xz * 0.05, 0.0); totalEmissiveRadiance += vec3(1.0, 0.3, 0.03) * (1.0 - smoothstep(0.0, 0.04, lv.y)) * 0.9;" : ""}
totalEmissiveRadiance += uGlowC * step(0.9985, g_hash12(floor(vWorldP.xz * 1.5))) * 0.6;`,
      );
  };
  return m;
}

const tmpC = new THREE.Color();
const tmpV = new THREE.Vector3();

/**
 * Static world: sky dome, fog, lights, floor, walls, outer ground, backdrop
 * silhouettes and props. Owns the atmosphere state (biome shifts, blackout).
 */
export class Environment {
  readonly group = new THREE.Group();
  readonly pal: Pal;
  readonly style: BiomeStyle;
  readonly fog: THREE.FogExp2;
  readonly hemi: THREE.HemisphereLight;
  readonly key: THREE.DirectionalLight;
  readonly occ: OccluderUniforms = createOccluderUniforms();
  readonly time = { value: 0 };
  /** multiplies floor / wall self-illumination (blackout) */
  readonly envDim = { value: 1 };
  readonly center: THREE.Vector3;
  readonly size: number;
  readonly walls: THREE.InstancedMesh | null;
  private readonly sky: THREE.Mesh;
  private readonly skyMat: THREE.ShaderMaterial;
  private readonly animated: Animated[] = [];
  private readonly baseFog: THREE.Color;
  private readonly baseFogDensity: number;
  private readonly baseSky: { top: THREE.Color; horizon: THREE.Color; bottom: THREE.Color };
  private readonly baseHemiSky: THREE.Color;
  private readonly baseHemiGround: THREE.Color;
  private readonly baseKey: THREE.Color;
  private tintFrom = new THREE.Color(1, 1, 1);
  private tintTo = new THREE.Color(1, 1, 1);
  private tintCur = new THREE.Color(1, 1, 1);
  private tintAmt = 0;
  private tintAmtFrom = 0;
  private tintAmtTo = 0;
  private tintK = 1;
  private fogTheme: number;
  private fogThemeTarget: number;

  constructor(
    readonly world: WorldSpec,
    readonly map: GameMap,
    private readonly bag: Bag,
    opts: EnvOptions,
  ) {
    const pal = (this.pal = palette(world));
    const biome = world.theme.biome;
    const style = (this.style = styleFor(biome));
    const W = map.width * S;
    const H = map.height * S;
    this.size = Math.max(W, H);
    this.center = new THREE.Vector3(W / 2, 0, H / 2);
    this.group.name = "environment";

    // --- atmosphere
    const horizon = mixC(pal.bg, pal.glow, style.horizon * 0.45).multiplyScalar(1.25);
    const top = pal.bg.clone().multiplyScalar(0.55);
    const bottom = pal.bg.clone().multiplyScalar(0.8);
    this.baseSky = { top, horizon, bottom };
    this.baseFog = mixC(horizon, pal.bg, 0.5);
    this.fogTheme = this.fogThemeTarget = world.theme.fog;
    this.baseFogDensity = 0.0052 * style.fog;
    this.fog = new THREE.FogExp2(this.baseFog.getHex(), this.densityFor(this.fogTheme));
    this.fog.color.copy(this.baseFog);
    this.skyMat = bag.track(skyMaterial(top, horizon, bottom, style, pal.glow, this.time));
    const skyGeo = bag.track(new THREE.SphereGeometry(900, 32, 16));
    this.sky = new THREE.Mesh(skyGeo, this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.sky.position.copy(this.center);
    this.group.add(this.sky);

    // --- lights
    this.baseHemiSky = mixC(pal.glow, new THREE.Color(1, 1, 1), 0.55);
    this.baseHemiGround = mixC(pal.floor, pal.bg, 0.3).multiplyScalar(1.6);
    this.hemi = new THREE.HemisphereLight(this.baseHemiSky, this.baseHemiGround, style.hemi);
    this.group.add(this.hemi);
    this.baseKey = new THREE.Color(style.key);
    this.key = new THREE.DirectionalLight(this.baseKey, style.keyIntensity);
    this.key.castShadow = opts.shadows;
    this.key.shadow.mapSize.set(opts.shadowSize, opts.shadowSize);
    const sc = this.key.shadow.camera;
    sc.left = -24;
    sc.right = 24;
    sc.top = 24;
    sc.bottom = -24;
    sc.near = 1;
    sc.far = 140;
    this.key.shadow.bias = -0.0006;
    this.key.shadow.normalBias = 0.03;
    this.group.add(this.key);
    this.group.add(this.key.target);
    this.setFocus(this.center.x, this.center.z);

    // --- floor
    const mask = bag.track(new THREE.DataTexture(buildMask(map), map.cols, map.rows, THREE.RGBAFormat));
    mask.magFilter = THREE.LinearFilter;
    mask.minFilter = THREE.LinearFilter;
    mask.wrapS = mask.wrapT = THREE.ClampToEdgeWrapping;
    mask.needsUpdate = true;
    const floorGeo = bag.track(new THREE.PlaneGeometry(W, H, 1, 1));
    floorGeo.rotateX(-Math.PI / 2);
    const floorMat = bag.track(floorMaterial(biome, { floor: pal.floor, bg: pal.bg, wall: pal.wall, glow: pal.glow, accent: pal.accent }, mask, new THREE.Vector2(W, H), this.time, this.envDim));
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.position.set(W / 2, 0, H / 2);
    floor.receiveShadow = true;
    floor.name = "floor";
    this.group.add(floor);

    // --- outer ground (beyond the border wall) for the backdrop to stand on
    const groundGeo = bag.track(new THREE.CircleGeometry(700, 48));
    groundGeo.rotateX(-Math.PI / 2);
    const ground = new THREE.Mesh(groundGeo, bag.track(groundMaterial(mixC(pal.floor, pal.bg, 0.45), pal.glow, biome)));
    ground.position.set(W / 2, -0.04, H / 2);
    ground.receiveShadow = false;
    this.group.add(ground);

    // --- walls
    this.walls = this.buildWalls(pal, biome);
    if (this.walls) this.group.add(this.walls);

    // --- biome dressing
    const rng = createRng((world.seed ^ 0x9e3779b9) >>> 0);
    const back = buildBackdrop(biome, { pal, rng, bag, center: this.center, arena: this.size, time: this.time, preview: !!opts.preview });
    this.group.add(back.group);
    if (back.animate) this.animated.push(back.animate);
    const props = buildProps(biome, map, { pal, rng: createRng((world.seed ^ 0x51ed270b) >>> 0), bag, time: this.time });
    if (props.group) this.group.add(props.group);
    if (props.animate) this.animated.push(props.animate);
  }

  private densityFor(fog: number) {
    return this.baseFogDensity * (1 + fog * 2.4);
  }

  private buildWalls(pal: Pal, biome: string): THREE.InstancedMesh | null {
    const m = this.map;
    const { cols, rows, solid } = m;
    let n = 0;
    for (let i = 0; i < solid.length; i++) if (solid[i]) n++;
    if (!n) return null;
    const geo = this.bag.track(new THREE.BoxGeometry(1, 1, 1));
    const edges = new Float32Array(n * 4);
    const T = m.tile * S;
    const isS = (c: number, r: number) => c < 0 || r < 0 || c >= cols || r >= rows || solid[r * cols + c] === 1;
    const colors = {
      body: mixC(pal.wall, pal.bg, 0.74),
      top: mixC(pal.wall, pal.bg, 0.5),
      edge: mixC(pal.wall, new THREE.Color(1, 1, 1), 0.15),
      glow: pal.glow.clone(),
      accent: pal.accent.clone(),
    };
    const mat = this.bag.track(wallMaterial(biome, colors, this.occ, this.time, this.envDim));
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    const mtx = new THREE.Matrix4();
    let k = 0;
    const rng = createRng((this.world.seed ^ 0x2545f491) >>> 0);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        if (!solid[r * cols + c]) continue;
        const border = c === 0 || r === 0 || c === cols - 1 || r === rows - 1;
        const h = border ? WALL_MAX : WALL_H * (0.85 + rng.next() * 0.3);
        mtx.makeScale(T, h, T);
        mtx.setPosition((c + 0.5) * T, h / 2, (r + 0.5) * T);
        mesh.setMatrixAt(k, mtx);
        edges[k * 4] = isS(c - 1, r) ? 0 : 1;
        edges[k * 4 + 1] = isS(c + 1, r) ? 0 : 1;
        edges[k * 4 + 2] = isS(c, r - 1) ? 0 : 1;
        edges[k * 4 + 3] = isS(c, r + 1) ? 0 : 1;
        k++;
      }
    geo.setAttribute("aEdge", new THREE.InstancedBufferAttribute(edges, 4));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    mesh.name = "walls";
    return mesh;
  }

  /** Moves the shadow frustum with the action (snapped to texels to avoid shimmer). */
  setFocus(x: number, z: number) {
    const elev = this.style.elev;
    const dir = tmpV.set(Math.cos(0.7) * Math.cos(elev), Math.sin(elev), Math.sin(0.7) * Math.cos(elev)).normalize();
    const texel = 48 / Math.max(256, this.key.shadow.mapSize.x);
    const sx = Math.round(x / texel) * texel;
    const sz = Math.round(z / texel) * texel;
    this.key.target.position.set(sx, 0, sz);
    this.key.position.set(sx + dir.x * 60, dir.y * 60, sz + dir.z * 60);
    this.key.target.updateMatrixWorld();
  }

  setShadows(on: boolean, size: number) {
    this.key.castShadow = on;
    if (this.key.shadow.mapSize.x !== size) {
      this.key.shadow.mapSize.set(size, size);
      this.key.shadow.map?.dispose();
      this.key.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    }
  }

  /** Director biome shift: 2s lerp of fog / sky / light colours towards the tint. */
  shiftTheme(tint: number | null, fog: number) {
    this.tintFrom.copy(this.tintCur);
    this.tintAmtFrom = this.tintAmt;
    if (tint === null) {
      this.tintAmtTo = 0;
    } else {
      this.tintTo.setHex(tint & 0xffffff);
      this.tintAmtTo = 0.6;
    }
    this.tintK = 0;
    this.fogThemeTarget = Number.isFinite(fog) ? Math.max(0, Math.min(1, fog)) : this.fogThemeTarget;
  }

  /** Current wash colour/amount (post-processing grade reads this). */
  get tint(): { color: THREE.Color; amount: number } {
    return { color: this.tintCur, amount: this.tintAmt };
  }

  update(dt: number, f: EnvFrame) {
    this.time.value += dt;
    if (this.tintK < 1) {
      this.tintK = Math.min(1, this.tintK + dt / 2);
      const e = this.tintK * this.tintK * (3 - 2 * this.tintK);
      this.tintCur.copy(this.tintFrom).lerp(this.tintTo, e);
      this.tintAmt = this.tintAmtFrom + (this.tintAmtTo - this.tintAmtFrom) * e;
    }
    this.fogTheme += (this.fogThemeTarget - this.fogTheme) * Math.min(1, dt * 0.8);
    const tA = this.tintAmt;
    const bo = Math.max(0, Math.min(1, f.blackout));
    const dim = 1 - bo * 0.9;
    this.envDim.value = 1 - bo * 0.85;

    // fog colour / density
    tmpC.copy(this.baseFog).lerp(this.tintCur, tA * 0.7);
    if (f.weatherFogColor) tmpC.lerp(f.weatherFogColor, Math.min(0.6, (f.weatherFog - 1) * 0.35));
    this.fog.color.copy(tmpC).multiplyScalar(1 - bo * 0.85);
    this.fog.density = this.densityFor(this.fogTheme) * Math.max(1, f.weatherFog) * (1 + bo * 1.2);

    const u = this.skyMat.uniforms;
    (u.uTop!.value as THREE.Color).copy(this.baseSky.top).lerp(this.tintCur, tA * 0.5);
    (u.uHorizon!.value as THREE.Color).copy(this.baseSky.horizon).lerp(this.tintCur, tA * 0.7);
    if (f.weatherFogColor) (u.uHorizon!.value as THREE.Color).lerp(f.weatherFogColor, Math.min(0.5, (f.weatherFog - 1) * 0.3));
    (u.uBottom!.value as THREE.Color).copy(this.fog.color);
    u.uDim!.value = 1 - bo * 0.92;

    this.hemi.color.copy(this.baseHemiSky).lerp(this.tintCur, tA * 0.6);
    this.hemi.groundColor.copy(this.baseHemiGround).lerp(this.tintCur, tA * 0.3);
    this.hemi.intensity = this.style.hemi * (1 - bo * 0.93);
    this.key.color.copy(this.baseKey).lerp(this.tintCur, tA * 0.5);
    this.key.intensity = this.style.keyIntensity * dim * (1 - bo * 0.1);
    for (const a of this.animated) a(dt, this.time.value);
  }
}
