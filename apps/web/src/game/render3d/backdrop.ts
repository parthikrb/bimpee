import * as THREE from "three";
import type { Rng } from "@bimpee/shared";
import type { GameMap } from "../logic/mapgen";
import type { Bag } from "./bag";
import { S } from "./coords";
import { GLSL_NOISE, glowMaterial, pillarMaterial } from "./materials";
import { gearGeometry, merge, part, tf } from "./models";
import { mixC, type Pal } from "./palette";

export type Animated = (dt: number, t: number) => void;

export interface BackdropCtx {
  pal: Pal;
  rng: Rng;
  bag: Bag;
  center: THREE.Vector3;
  /** arena side length (world units) */
  arena: number;
  time: THREE.IUniform<number>;
  preview: boolean;
}

interface Built {
  group: THREE.Group;
  animate?: Animated;
}

const WHITE = new THREE.Color(1, 1, 1);
const mtx = new THREE.Matrix4();
const q = new THREE.Quaternion();
const eul = new THREE.Euler();
const pos = new THREE.Vector3();
const scl = new THREE.Vector3();

/** Random point in the ring outside the arena. */
function ringPos(ctx: BackdropCtx, minExtra: number, maxExtra: number, out: THREE.Vector3) {
  const r0 = ctx.arena * 0.72 + minExtra;
  const a = ctx.rng.next() * Math.PI * 2;
  const d = r0 + Math.pow(ctx.rng.next(), 0.8) * (maxExtra - minExtra);
  return out.set(ctx.center.x + Math.cos(a) * d, 0, ctx.center.z + Math.sin(a) * d);
}

function instanced(ctx: BackdropCtx, geo: THREE.BufferGeometry, mat: THREE.Material, n: number, place: (i: number, m: THREE.Matrix4, c: THREE.Color) => void, colors = false): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(ctx.bag.track(geo), ctx.bag.track(mat), n);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    c.setRGB(1, 1, 1);
    place(i, mtx, c);
    mesh.setMatrixAt(i, mtx);
    if (colors) mesh.setColorAt(i, c);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.frustumCulled = false;
  return mesh;
}

function compose(x: number, y: number, z: number, rx: number, ry: number, rz: number, sx: number, sy: number, sz: number) {
  eul.set(rx, ry, rz);
  q.setFromEuler(eul);
  return mtx.compose(pos.set(x, y, z), q, scl.set(sx, sy, sz));
}

/** Skyscraper material: dark glass, lit window grid, glowing roof edge. */
function towerMaterial(pal: Pal, time: THREE.IUniform<number>) {
  const m = new THREE.MeshStandardMaterial({ color: mixC(pal.bg, pal.wall, 0.12).multiplyScalar(1.4), roughness: 0.4, metalness: 0.6 });
  m.customProgramCacheKey = () => "tower";
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uA = { value: pal.glow };
    sh.uniforms.uB = { value: pal.accent };
    sh.uniforms.uTime = time;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWorldP; varying vec3 vLocal; varying vec3 vScale;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
vLocal = position; vec4 gw = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
gw = instanceMatrix * gw; vScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
#else
vScale = vec3(1.0);
#endif
vWorldP = (modelMatrix * gw).xyz;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vWorldP; varying vec3 vLocal; varying vec3 vScale; uniform vec3 uA; uniform vec3 uB; uniform float uTime;\n${GLSL_NOISE}`)
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
{
  float side = (abs(vLocal.x) > 0.499) ? vWorldP.z : vWorldP.x;
  vec2 wc = vec2(side * 1.4, vWorldP.y * 1.9);
  vec2 wi = floor(wc); vec2 wf = fract(wc);
  float win = step(0.2, wf.x) * step(wf.x, 0.8) * step(0.25, wf.y) * step(wf.y, 0.75);
  float h = g_hash12(wi + floor(vWorldP.xz * 0.13) * 17.0);
  float lit = step(0.55, h) * (0.75 + 0.25 * sin(uTime * 0.5 + h * 40.0));
  float notTop = 1.0 - step(0.499, vLocal.y);
  vec3 wcol = mix(uA, uB, step(0.8, h));
  totalEmissiveRadiance += wcol * win * lit * notTop * 1.6;
  float roof = (1.0 - smoothstep(0.0, 0.5, vScale.y * (0.5 - vLocal.y))) * notTop;
  totalEmissiveRadiance += uA * roof * 2.2;
  float band = step(0.985, fract(vWorldP.y * 0.12 + h)) * notTop;
  totalEmissiveRadiance += uB * band * 1.5;
}`,
      );
  };
  return m;
}

/** Flowing lava ribbon (volcanic backdrop). */
function lavaMaterial() {
  return new THREE.ShaderMaterial({
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 } }]),
    vertexShader: /* glsl */ `varying vec2 vUv; varying float vFogDepth; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vFogDepth = -mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 fogColor; uniform float fogDensity; varying vec2 vUv; varying float vFogDepth;
      ${GLSL_NOISE}
      void main(){
        vec2 p = vec2(vUv.x * 3.0, vUv.y * 40.0 - uTime * 0.6);
        float n = g_fbm(p) ;
        float edge = smoothstep(0.0, 0.25, vUv.x) * smoothstep(1.0, 0.75, vUv.x);
        vec3 hot = mix(vec3(1.0, 0.18, 0.02), vec3(1.0, 0.75, 0.25), smoothstep(0.45, 0.8, n));
        vec3 col = mix(vec3(0.05, 0.01, 0.0), hot * 2.2, edge * smoothstep(0.3, 0.6, n + edge * 0.3));
        float f = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
        gl_FragColor = vec4(mix(col, fogColor, f * 0.8), 1.0);
      }`,
  });
}

export function buildBackdrop(biome: string, ctx: BackdropCtx): Built {
  const g = new THREE.Group();
  g.name = "backdrop";
  const { pal, rng, bag } = ctx;
  const k = ctx.preview ? 0.7 : 1;
  const anims: Animated[] = [];
  const glowMat = (p: THREE.MeshStandardMaterialParameters, o: Parameters<typeof glowMaterial>[1]) => {
    const m = glowMaterial(p, o);
    anims.push(() => (m.glow.uTime.value = ctx.time.value));
    return m;
  };

  switch (biome) {
    case "neon_city": {
      const n = Math.round(130 * k);
      const box = new THREE.BoxGeometry(1, 1, 1);
      g.add(
        instanced(ctx, box, towerMaterial(pal, ctx.time), n, (_i, m) => {
          ringPos(ctx, 6, 150, pos);
          const far = (pos.distanceTo(ctx.center) - ctx.arena * 0.7) / 150;
          const h = 10 + rng.next() * 30 + far * 70 * rng.next();
          const w = 4 + rng.next() * 7;
          compose(pos.x, h / 2, pos.z, 0, rng.next() * 0.4, 0, w, h, 4 + rng.next() * 7);
          return m;
        }),
      );
      // antenna beacons & holo rings
      const ring = merge([part(new THREE.TorusGeometry(1, 0.05, 6, 40), WHITE, 3)]);
      g.add(
        instanced(
          ctx,
          ring,
          glowMat({ color: 0xffffff, vertexColors: true }, { emissive: 0, rim: 0, vertexGlow: true }),
          Math.round(14 * k),
          (_i, m, c) => {
            ringPos(ctx, 15, 110, pos);
            const r = 3 + rng.next() * 6;
            compose(pos.x, 18 + rng.next() * 30, pos.z, Math.PI / 2, 0, 0, r, r, r);
            c.copy(rng.next() < 0.5 ? pal.glow : pal.accent);
            return m;
          },
          true,
        ),
      );
      break;
    }
    case "fungal_cathedral": {
      const n = Math.round(46 * k);
      const stem = merge([part(new THREE.CylinderGeometry(0.55, 1, 1, 10, 4), 0.85, 0, tf(0, 0.5, 0))]);
      const cap = merge([
        part(new THREE.SphereGeometry(1, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2), 1, 0.15, tf(0, 0, 0, 0, 0, 0, 1, 0.55, 1)),
        part(new THREE.CircleGeometry(0.98, 18), 1, 2.4, tf(0, 0.01, 0, Math.PI / 2, 0, 0)),
        part(new THREE.ConeGeometry(0.95, 0.25, 18, 1, true), 1, 1.6, tf(0, -0.1, 0, Math.PI, 0, 0)),
      ]);
      const mats = { stem: glowMat({ color: mixC(pal.floor, WHITE, 0.25), roughness: 0.9 }, { emissive: 0.05, rim: 0.4 }), cap: glowMat({ color: 0xffffff, vertexColors: true, roughness: 0.6 }, { emissive: 0.1, rim: 0.8, vertexGlow: true }) };
      const tr: { x: number; z: number; h: number; r: number; c: THREE.Color }[] = [];
      for (let i = 0; i < n; i++) {
        ringPos(ctx, 4, 120, pos);
        const h = 8 + rng.next() * 32;
        tr.push({ x: pos.x, z: pos.z, h, r: h * (0.35 + rng.next() * 0.3), c: [pal.glow, pal.accent, pal.wall][Math.floor(rng.next() * 3)]!.clone() });
      }
      g.add(instanced(ctx, stem, mats.stem, n, (i, m) => compose(tr[i]!.x, 0, tr[i]!.z, 0, 0, 0, tr[i]!.h * 0.09, tr[i]!.h, tr[i]!.h * 0.09)));
      g.add(instanced(ctx, cap, mats.cap, n, (i, m, c) => (c.copy(tr[i]!.c), compose(tr[i]!.x, tr[i]!.h, tr[i]!.z, 0, 0, 0, tr[i]!.r, tr[i]!.r, tr[i]!.r)), true));
      // cathedral arches
      const arch = merge([part(new THREE.TorusGeometry(1, 0.08, 8, 28, Math.PI), 0.8, 0), part(new THREE.TorusGeometry(0.92, 0.015, 4, 28, Math.PI), 1, 2)]);
      g.add(
        instanced(ctx, arch, glowMat({ color: 0xffffff, vertexColors: true, roughness: 0.8 }, { emissive: 0.02, rim: 0.3, vertexGlow: true }), Math.round(10 * k), (i, m, c) => {
          const a = (i / 10) * Math.PI * 2 + rng.next() * 0.3;
          const d = ctx.arena * 0.72 + 30 + rng.next() * 40;
          const r = 22 + rng.next() * 14;
          c.copy(mixC(pal.wall, pal.glow, 0.3));
          return compose(ctx.center.x + Math.cos(a) * d, 0, ctx.center.z + Math.sin(a) * d, 0, -a + Math.PI / 2, 0, r, r * 1.3, r);
        }, true),
      );
      break;
    }
    case "frozen_wastes": {
      const n = Math.round(110 * k);
      const spire = merge([part(new THREE.ConeGeometry(1, 1, 5, 1), 1, 0, tf(0, 0.5, 0)), part(new THREE.ConeGeometry(0.45, 0.6, 5, 1), 1.2, 0.3, tf(0.5, 0.3, 0.2, 0, 0, -0.3))]);
      g.add(
        instanced(ctx, spire, glowMat({ color: mixC(pal.glow, WHITE, 0.4), roughness: 0.12, metalness: 0.1, vertexColors: true }, { emissive: 0.08, rim: 1.4, vertexGlow: true }), n, (_i, m) => {
          ringPos(ctx, 4, 140, pos);
          const h = 8 + rng.next() * 25 + rng.next() * rng.next() * 40;
          const r = h * (0.12 + rng.next() * 0.1);
          return compose(pos.x, -0.5, pos.z, (rng.next() - 0.5) * 0.25, rng.next() * 6, (rng.next() - 0.5) * 0.25, r, h, r);
        }),
      );
      const mound = new THREE.SphereGeometry(1, 16, 8);
      g.add(
        instanced(ctx, mound, glowMat({ color: mixC(pal.accent, pal.glow, 0.2), roughness: 0.9 }, { emissive: 0.05, rim: 0.3 }), Math.round(30 * k), (_i, m) => {
          ringPos(ctx, 2, 120, pos);
          const r = 8 + rng.next() * 20;
          return compose(pos.x, -r * 0.08, pos.z, 0, rng.next() * 3, 0, r, r * 0.25, r * 0.7);
        }),
      );
      break;
    }
    case "desert_ruins": {
      const sand = mixC(pal.wall, pal.floor, 0.35);
      const dune = new THREE.SphereGeometry(1, 28, 10);
      g.add(
        instanced(ctx, dune, glowMat({ color: sand, roughness: 1 }, { emissive: 0.03, rim: 0.25 }), Math.round(30 * k), (_i, m) => {
          ringPos(ctx, 10, 150, pos);
          const r = 25 + rng.next() * 45;
          return compose(pos.x, -2, pos.z, 0, rng.next() * 3, 0, r, 5 + rng.next() * 12, r * (0.5 + rng.next() * 0.4));
        }),
      );
      const obelisk = merge([
        part(new THREE.BoxGeometry(1, 1, 1), 1, 0, tf(0, 0.5, 0, 0, 0, 0, 1, 1, 1)),
        part(new THREE.ConeGeometry(0.72, 0.12, 4), 1, 0, tf(0, 1.06, 0, 0, Math.PI / 4, 0)),
        part(new THREE.BoxGeometry(0.06, 0.7, 1.02), new THREE.Color(1, 1, 1), 2.5, tf(0.47, 0.5, 0)),
        part(new THREE.BoxGeometry(1.02, 0.7, 0.06), new THREE.Color(1, 1, 1), 2.5, tf(0, 0.5, 0.47)),
      ]);
      g.add(
        instanced(ctx, obelisk, glowMat({ color: mixC(pal.wall, pal.bg, 0.45), roughness: 0.8, vertexColors: true }, { emissive: 0.0, rim: 0.4, vertexGlow: true }), Math.round(22 * k), (_i, m, c) => {
          ringPos(ctx, 6, 90, pos);
          const h = 12 + rng.next() * 26;
          c.copy(pal.glow);
          return compose(pos.x, 0, pos.z, (rng.next() - 0.5) * 0.12, rng.next() * 3, 0, h * 0.13, h, h * 0.13);
        }, true),
      );
      const column = merge([part(new THREE.CylinderGeometry(0.5, 0.55, 1, 12, 1), 1, 0, tf(0, 0.5, 0)), part(new THREE.BoxGeometry(1.4, 0.15, 1.4), 0.9, 0, tf(0, 0.02, 0))]);
      g.add(
        instanced(ctx, column, glowMat({ color: mixC(pal.wall, WHITE, 0.15), roughness: 0.85 }, { emissive: 0.02, rim: 0.3 }), Math.round(40 * k), (_i, m) => {
          ringPos(ctx, 3, 60, pos);
          const h = 3 + rng.next() * 12;
          return compose(pos.x, 0, pos.z, (rng.next() - 0.5) * 0.3, rng.next() * 3, (rng.next() - 0.5) * 0.3, 1.6, h, 1.6);
        }),
      );
      break;
    }
    case "abyssal_reef": {
      // coral trees
      const branch = (x: number, y: number, z: number, rz: number, rx: number, h: number) => part(new THREE.CylinderGeometry(0.12, 0.2, h, 6), 1, 0, tf(x, y + h / 2, z, rx, 0, rz));
      const coral = merge([
        branch(0, 0, 0, 0, 0, 1),
        branch(0.1, 0.8, 0, -0.6, 0, 0.8),
        branch(-0.1, 0.7, 0, 0.7, 0.2, 0.9),
        branch(0, 0.6, 0.1, 0.1, 0.7, 0.7),
        part(new THREE.SphereGeometry(0.14, 8, 6), new THREE.Color(1, 1, 1), 3, tf(0.55, 1.45, 0)),
        part(new THREE.SphereGeometry(0.14, 8, 6), new THREE.Color(1, 1, 1), 3, tf(-0.6, 1.4, 0.1)),
        part(new THREE.SphereGeometry(0.14, 8, 6), new THREE.Color(1, 1, 1), 3, tf(0.05, 1.2, 0.6)),
        part(new THREE.SphereGeometry(0.14, 8, 6), new THREE.Color(1, 1, 1), 3, tf(0, 1.1, 0)),
      ]);
      g.add(
        instanced(ctx, coral, glowMat({ color: 0xffffff, vertexColors: true, roughness: 0.7 }, { emissive: 0.15, rim: 0.7, vertexGlow: true, sway: 0.4 }), Math.round(70 * k), (_i, m, c) => {
          ringPos(ctx, 3, 110, pos);
          const s = 4 + rng.next() * 12;
          c.copy([pal.accent, pal.glow, pal.wall][Math.floor(rng.next() * 3)]!);
          return compose(pos.x, 0, pos.z, 0, rng.next() * 6, 0, s, s, s);
        }, true),
      );
      const kelp = merge([part(new THREE.BoxGeometry(0.5, 1, 0.08, 1, 12, 1), 1, 0.2, tf(0, 0.5, 0))]);
      g.add(
        instanced(ctx, kelp, glowMat({ color: mixC(pal.wall, pal.floor, 0.4), side: THREE.DoubleSide, roughness: 0.8, vertexColors: true }, { emissive: 0.1, rim: 0.5, vertexGlow: true, sway: 3.5 }), Math.round(90 * k), (_i, m) => {
          ringPos(ctx, 2, 90, pos);
          const h = 10 + rng.next() * 30;
          return compose(pos.x, 0, pos.z, 0, rng.next() * 6, 0, 1.5 + rng.next() * 1.5, h, 1);
        }),
      );
      // god rays from the surface
      const rays = new THREE.Group();
      const rayGeo = bag.track(new THREE.CylinderGeometry(3, 9, 120, 16, 1, true));
      for (let i = 0; i < (ctx.preview ? 5 : 9); i++) {
        const mat = bag.track(pillarMaterial(mixC(pal.glow, WHITE, 0.4).multiplyScalar(0.12)));
        const ray = new THREE.Mesh(rayGeo, mat);
        const a = rng.next() * Math.PI * 2;
        const d = rng.next() * ctx.arena * 0.8;
        ray.position.set(ctx.center.x + Math.cos(a) * d, 60, ctx.center.z + Math.sin(a) * d);
        ray.rotation.set((rng.next() - 0.5) * 0.4, 0, 0.25 + (rng.next() - 0.5) * 0.2);
        ray.rotation.y = rng.next();
        // fade from the top down: flip uv by rotating
        ray.rotateX(Math.PI);
        ray.renderOrder = 8;
        rays.add(ray);
        const ph = rng.next() * 10;
        anims.push((_dt, t) => {
          mat.uniforms.uTime!.value = t * 0.2;
          mat.uniforms.uAlpha!.value = 0.6 + 0.4 * Math.sin(t * 0.4 + ph);
        });
      }
      g.add(rays);
      break;
    }
    case "clockwork_foundry": {
      const metal = glowMat({ color: mixC(pal.wall, pal.bg, 0.25), roughness: 0.38, metalness: 0.75 }, { emissive: 0.06, rim: 0.9 });
      const gears: { m: THREE.Mesh; s: number }[] = [];
      const ng = ctx.preview ? 9 : 14;
      for (let i = 0; i < ng; i++) {
        const teeth = 10 + Math.floor(rng.next() * 14);
        const R = 8 + rng.next() * 18;
        const geo = bag.track(gearGeometry(teeth, R, R * 0.86, 1.5 + rng.next() * 2));
        const mesh = new THREE.Mesh(geo, metal);
        const a = (i / ng) * Math.PI * 2 + rng.next() * 0.3;
        const d = ctx.arena * 0.72 + 25 + rng.next() * 60;
        mesh.position.set(ctx.center.x + Math.cos(a) * d, R * (0.5 + rng.next() * 0.6), ctx.center.z + Math.sin(a) * d);
        mesh.rotation.y = -a + Math.PI / 2 + (rng.next() - 0.5) * 0.6;
        g.add(mesh);
        gears.push({ m: mesh, s: (rng.next() < 0.5 ? -1 : 1) * (0.05 + rng.next() * 0.12) * (12 / R) });
      }
      bag.track(metal);
      anims.push((dt) => {
        for (const gg of gears) gg.m.rotateZ(gg.s * dt);
      });
      const stack = merge([
        part(new THREE.CylinderGeometry(0.8, 1, 1, 12, 1), 1, 0, tf(0, 0.5, 0)),
        part(new THREE.TorusGeometry(0.85, 0.08, 6, 16), new THREE.Color(1, 1, 1), 2.5, tf(0, 0.98, 0, Math.PI / 2, 0, 0)),
        part(new THREE.TorusGeometry(0.95, 0.06, 6, 16), 0.6, 0, tf(0, 0.6, 0, Math.PI / 2, 0, 0)),
      ]);
      g.add(
        instanced(ctx, stack, glowMat({ color: 0xffffff, vertexColors: true, roughness: 0.6, metalness: 0.6 }, { emissive: 0.02, rim: 0.5, vertexGlow: true }), Math.round(28 * k), (_i, m, c) => {
          ringPos(ctx, 8, 120, pos);
          const h = 15 + rng.next() * 40;
          const r = 2 + rng.next() * 2.5;
          c.copy(mixC(pal.wall, pal.glow, 0.25));
          return compose(pos.x, 0, pos.z, 0, 0, 0, r, h, r);
        }, true),
      );
      break;
    }
    case "void_garden": {
      const rock = merge([
        part(new THREE.IcosahedronGeometry(1, 0), 1, 0, tf(0, 0, 0, 0, 0, 0, 1, 0.45, 1)),
        part(new THREE.ConeGeometry(0.85, 1.6, 7), 0.75, 0, tf(0, -0.95, 0, Math.PI, 0, 0)),
        part(new THREE.OctahedronGeometry(0.22), new THREE.Color(1, 1, 1), 3.2, tf(0.3, 0.55, 0.1, 0, 0, 0, 1, 2.2, 1)),
        part(new THREE.OctahedronGeometry(0.15), new THREE.Color(1, 1, 1), 3.2, tf(-0.35, 0.45, -0.2, 0, 0, 0.3, 1, 2, 1)),
      ]);
      const n = Math.round(60 * k);
      const base: { x: number; y: number; z: number; s: number; ry: number; ph: number }[] = [];
      for (let i = 0; i < n; i++) {
        ringPos(ctx, 0, 140, pos);
        base.push({ x: pos.x, y: 6 + rng.next() * 40, z: pos.z, s: 2 + rng.next() * 8, ry: rng.next() * 6, ph: rng.next() * 10 });
      }
      const mesh = instanced(ctx, rock, glowMat({ color: 0xffffff, vertexColors: true, roughness: 0.75 }, { emissive: 0.05, rim: 1.0, vertexGlow: true }), n, (i, m, c) => {
        const b = base[i]!;
        c.copy(rng.next() < 0.6 ? mixC(pal.wall, pal.bg, 0.4) : mixC(pal.glow, pal.bg, 0.3));
        return compose(b.x, b.y, b.z, 0, b.ry, 0, b.s, b.s, b.s);
      }, true);
      g.add(mesh);
      anims.push((_dt, t) => {
        for (let i = 0; i < n; i++) {
          const b = base[i]!;
          compose(b.x, b.y + Math.sin(t * 0.4 + b.ph) * 1.2, b.z, 0, b.ry + t * 0.03, 0, b.s, b.s, b.s);
          mesh.setMatrixAt(i, mtx);
        }
        mesh.instanceMatrix.needsUpdate = true;
      });
      break;
    }
    case "volcanic_forge": {
      const lavaGeo = bag.track(new THREE.PlaneGeometry(1, 1, 1, 1));
      lavaGeo.rotateX(-Math.PI / 2);
      const lm = bag.track(lavaMaterial());
      anims.push((_dt, t) => (lm.uniforms.uTime!.value = t));
      for (let i = 0; i < (ctx.preview ? 5 : 8); i++) {
        const a = rng.next() * Math.PI * 2;
        const d0 = ctx.arena * 0.72 + 4;
        const len = 120 + rng.next() * 100;
        const river = new THREE.Mesh(lavaGeo, lm);
        river.scale.set(4 + rng.next() * 6, 1, len);
        river.position.set(ctx.center.x + Math.cos(a) * (d0 + len / 2), 0.02, ctx.center.z + Math.sin(a) * (d0 + len / 2));
        river.rotation.y = -a + Math.PI / 2 + (rng.next() - 0.5) * 0.3;
        g.add(river);
      }
      const volcano = merge([
        part(new THREE.ConeGeometry(1, 1, 18, 3, true), 1, 0, tf(0, 0.5, 0)),
        part(new THREE.CylinderGeometry(0.16, 0.2, 0.06, 18), new THREE.Color(1, 0.4, 0.1), 4, tf(0, 0.86, 0)),
      ]);
      g.add(
        instanced(ctx, volcano, glowMat({ color: mixC(pal.bg, pal.floor, 0.6), roughness: 0.95, vertexColors: true, side: THREE.DoubleSide }, { emissive: 0.0, rim: 0.4, vertexGlow: true }), Math.round(7 * k), (i, m) => {
          const a = (i / 7) * Math.PI * 2 + rng.next() * 0.5;
          const d = ctx.arena * 0.72 + 120 + rng.next() * 140;
          const r = 40 + rng.next() * 40;
          return compose(ctx.center.x + Math.cos(a) * d, -2, ctx.center.z + Math.sin(a) * d, 0, 0, 0, r, 30 + rng.next() * 40, r);
        }),
      );
      const pillar = merge([part(new THREE.CylinderGeometry(1, 1, 1, 6), 1, 0, tf(0, 0.5, 0)), part(new THREE.CylinderGeometry(1.02, 1.02, 0.05, 6), new THREE.Color(1, 0.35, 0.05), 3, tf(0, 0.3, 0))]);
      g.add(
        instanced(ctx, pillar, glowMat({ color: mixC(pal.bg, pal.wall, 0.25), roughness: 0.9, vertexColors: true }, { emissive: 0.02, rim: 0.5, vertexGlow: true }), Math.round(50 * k), (_i, m) => {
          ringPos(ctx, 3, 80, pos);
          const h = 4 + rng.next() * 18;
          const r = 1.5 + rng.next() * 2.5;
          return compose(pos.x, 0, pos.z, (rng.next() - 0.5) * 0.15, rng.next() * 3, 0, r, h, r);
        }),
      );
      break;
    }
  }
  return { group: g, animate: anims.length ? (dt, t) => anims.forEach((a) => a(dt, t)) : undefined };
}

/** Non-colliding decorative props that hug the arena walls. */
export function buildProps(biome: string, map: GameMap, ctx: { pal: Pal; rng: Rng; bag: Bag; time: THREE.IUniform<number> }): { group: THREE.Group | null; animate?: Animated } {
  const { pal, rng, bag } = ctx;
  const { cols, rows, solid } = map;
  const T = map.tile * S;
  const spots: { x: number; z: number; ry: number; s: number }[] = [];
  const cc = cols / 2;
  const cr = rows / 2;
  for (let r = 1; r < rows - 1; r++)
    for (let c = 1; c < cols - 1; c++) {
      if (solid[r * cols + c]) continue;
      if ((c - cc) ** 2 + (r - cr) ** 2 < 49) continue;
      const nb = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].filter(([dc, dr]) => solid[(r + dr!) * cols + c + dc!]);
      if (!nb.length || rng.next() > 0.32) continue;
      const [dc, dr] = nb[Math.floor(rng.next() * nb.length)]!;
      // push towards the wall so the open floor stays readable
      spots.push({ x: (c + 0.5 + dc! * 0.3 + (rng.next() - 0.5) * 0.3) * T, z: (r + 0.5 + dr! * 0.3 + (rng.next() - 0.5) * 0.3) * T, ry: rng.next() * Math.PI * 2, s: 0.7 + rng.next() * 0.6 });
      if (spots.length >= 160) break;
    }
  if (!spots.length) return { group: null };
  const W = new THREE.Color(1, 1, 1);
  const dark = mixC(pal.wall, pal.bg, 0.6);
  let geo: THREE.BufferGeometry;
  let hover = 0;
  switch (biome) {
    case "neon_city":
      geo = merge([
        part(new THREE.CylinderGeometry(0.12, 0.16, 0.9, 8), dark, 0, tf(0, 0.45, 0)),
        part(new THREE.CylinderGeometry(0.13, 0.13, 0.08, 8), pal.accent, 3, tf(0, 0.86, 0)),
        part(new THREE.BoxGeometry(0.6, 0.45, 0.6), mixC(pal.floor, W, 0.15), 0, tf(0.45, 0.22, 0.2, 0, 0.4, 0)),
        part(new THREE.BoxGeometry(0.62, 0.03, 0.62), pal.glow, 2, tf(0.45, 0.3, 0.2, 0, 0.4, 0)),
      ]);
      break;
    case "fungal_cathedral":
      geo = merge([
        part(new THREE.CylinderGeometry(0.06, 0.1, 0.6, 6), mixC(pal.floor, W, 0.4), 0, tf(0, 0.3, 0)),
        part(new THREE.SphereGeometry(0.32, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), pal.glow, 1.2, tf(0, 0.58, 0, 0, 0, 0, 1, 0.6, 1)),
        part(new THREE.CylinderGeometry(0.04, 0.07, 0.35, 6), mixC(pal.floor, W, 0.4), 0, tf(0.3, 0.17, 0.15)),
        part(new THREE.SphereGeometry(0.2, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), pal.accent, 1.5, tf(0.3, 0.34, 0.15, 0, 0, 0, 1, 0.6, 1)),
      ]);
      break;
    case "frozen_wastes":
      geo = merge([
        part(new THREE.ConeGeometry(0.2, 1.1, 5), mixC(pal.glow, W, 0.5), 0.5, tf(0, 0.55, 0, 0.1, 0, 0.1)),
        part(new THREE.ConeGeometry(0.14, 0.7, 5), mixC(pal.glow, W, 0.6), 0.6, tf(0.22, 0.32, 0.1, 0, 0, -0.4)),
        part(new THREE.ConeGeometry(0.12, 0.5, 5), mixC(pal.glow, W, 0.6), 0.6, tf(-0.2, 0.22, -0.1, 0.4, 0, 0.3)),
      ]);
      break;
    case "desert_ruins":
      geo = merge([
        part(new THREE.CylinderGeometry(0.25, 0.28, 0.9, 10), mixC(pal.wall, W, 0.1), 0, tf(0, 0.45, 0)),
        part(new THREE.DodecahedronGeometry(0.2, 0), mixC(pal.wall, pal.bg, 0.3), 0, tf(0.4, 0.12, 0.2)),
        part(new THREE.DodecahedronGeometry(0.14, 0), mixC(pal.wall, pal.bg, 0.3), 0, tf(-0.3, 0.08, 0.35)),
        part(new THREE.BoxGeometry(0.52, 0.06, 0.52), pal.glow, 1.4, tf(0, 0.9, 0)),
      ]);
      break;
    case "abyssal_reef":
      geo = merge([
        part(new THREE.ConeGeometry(0.08, 0.7, 5), pal.accent, 0.3, tf(0, 0.35, 0)),
        part(new THREE.ConeGeometry(0.07, 0.6, 5), pal.glow, 0.3, tf(0.12, 0.3, 0.05, 0, 0, -0.4)),
        part(new THREE.ConeGeometry(0.07, 0.6, 5), pal.glow, 0.3, tf(-0.1, 0.3, -0.06, 0.3, 0, 0.4)),
        part(new THREE.SphereGeometry(0.06, 6, 4), W, 4, tf(0, 0.72, 0)),
        part(new THREE.SphereGeometry(0.05, 6, 4), W, 4, tf(0.25, 0.55, 0.05)),
        part(new THREE.SphereGeometry(0.05, 6, 4), W, 4, tf(-0.22, 0.55, -0.06)),
      ]);
      break;
    case "clockwork_foundry": {
      const gear = gearGeometry(10, 0.45, 0.38, 0.12, 4);
      geo = merge([part(gear, mixC(pal.wall, W, 0.1), 0.05, tf(0, 0.07, 0, Math.PI / 2, 0, 0)), part(new THREE.CylinderGeometry(0.2, 0.2, 0.6, 10), dark, 0, tf(0.5, 0.3, 0.3)), part(new THREE.TorusGeometry(0.2, 0.03, 4, 12), pal.glow, 2.5, tf(0.5, 0.45, 0.3, Math.PI / 2, 0, 0))]);
      break;
    }
    case "void_garden":
      hover = 0.9;
      geo = merge([part(new THREE.OctahedronGeometry(0.28), pal.glow, 1.6, tf(0, 0, 0, 0, 0, 0, 0.8, 1.8, 0.8)), part(new THREE.OctahedronGeometry(0.12), pal.accent, 2.4, tf(0.3, -0.2, 0.1))]);
      break;
    default:
      geo = merge([part(new THREE.DodecahedronGeometry(0.35, 0), mixC(pal.bg, pal.wall, 0.2), 0, tf(0, 0.2, 0, 0, 0, 0, 1, 0.7, 1)), part(new THREE.OctahedronGeometry(0.1), new THREE.Color(1, 0.4, 0.08), 4, tf(0.2, 0.35, 0.1)), part(new THREE.OctahedronGeometry(0.08), new THREE.Color(1, 0.5, 0.1), 4, tf(-0.25, 0.3, -0.05))]);
  }
  const mat = glowMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.6 }, { emissive: 0.05, rim: 0.5, vertexGlow: true });
  const mesh = instanced({ pal, rng, bag, center: new THREE.Vector3(), arena: 0, time: ctx.time, preview: false }, geo, mat, spots.length, (i, m) => {
    const s = spots[i]!;
    return compose(s.x, hover, s.z, 0, s.ry, 0, s.s, s.s, s.s);
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = true;
  const group = new THREE.Group();
  group.add(mesh);
  if (hover > 0) {
    return {
      group,
      animate: (_dt, t) => {
        for (let i = 0; i < spots.length; i++) {
          const s = spots[i]!;
          compose(s.x, hover + Math.sin(t * 1.3 + i) * 0.15, s.z, 0, s.ry + t * 0.5, 0, s.s, s.s, s.s);
          mesh.setMatrixAt(i, mtx);
        }
        mesh.instanceMatrix.needsUpdate = true;
      },
    };
  }
  return { group };
}
