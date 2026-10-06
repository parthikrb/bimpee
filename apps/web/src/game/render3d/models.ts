import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { EnemyBase } from "@bimpee/shared";

/**
 * Procedural low-poly geometry. Every merged model carries `color` (vertex
 * colour, multiplied with material / instance colour) and `aGlow` (per-vertex
 * self-illumination) so one material can light parts differently.
 */
export function part(g: THREE.BufferGeometry, shade: number | THREE.Color, glow = 0, m?: THREE.Matrix4): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  if (ng !== g) g.dispose();
  if (m) ng.applyMatrix4(m);
  if (ng.getAttribute("uv")) ng.deleteAttribute("uv");
  if (ng.getAttribute("uv1")) ng.deleteAttribute("uv1");
  if (!ng.getAttribute("normal")) ng.computeVertexNormals();
  const n = ng.getAttribute("position").count;
  const col = new Float32Array(n * 3);
  const c = typeof shade === "number" ? new THREE.Color(shade, shade, shade) : shade;
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  ng.setAttribute("color", new THREE.BufferAttribute(col, 3));
  ng.setAttribute("aGlow", new THREE.BufferAttribute(new Float32Array(n).fill(glow), 1));
  return ng;
}

export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false) ?? new THREE.BufferGeometry();
  for (const p of parts) p.dispose();
  g.computeBoundingSphere();
  return g;
}

const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const E = new THREE.Euler();
const P = new THREE.Vector3();
const SC = new THREE.Vector3();

/** Matrix helper: translate, euler rotate (radians), scale. */
export function tf(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx): THREE.Matrix4 {
  E.set(rx, ry, rz);
  Q.setFromEuler(E);
  return M.clone().compose(P.set(x, y, z), Q, SC.set(sx, sy, sz));
}

/** Enemy bodies, ~unit radius, facing +X, centred on the origin. */
export function enemyGeometry(base: EnemyBase): THREE.BufferGeometry {
  switch (base) {
    case "chaser":
      return merge([
        part(new THREE.ConeGeometry(0.62, 2.1, 4), 1, 0, tf(0.1, 0, 0, Math.PI / 4, 0, -Math.PI / 2, 1, 1, 1)),
        part(new THREE.ConeGeometry(0.28, 1.0, 3), 0.7, 0, tf(-0.55, 0, 0.55, 0, 0.6, -Math.PI / 2, 1, 1, 0.5)),
        part(new THREE.ConeGeometry(0.28, 1.0, 3), 0.7, 0, tf(-0.55, 0, -0.55, 0, -0.6, -Math.PI / 2, 1, 1, 0.5)),
        part(new THREE.OctahedronGeometry(0.22), new THREE.Color(1, 1, 1), 2.2, tf(0.55, 0.22, 0)),
      ]);
    case "swarmer":
      return merge([
        part(new THREE.OctahedronGeometry(0.85), 1, 0, tf(0, 0, 0, 0, 0, 0, 1.35, 0.7, 0.75)),
        part(new THREE.BoxGeometry(0.15, 0.05, 1.7), 0.6, 0.4, tf(-0.2, 0.1, 0, 0, 0, 0)),
        part(new THREE.OctahedronGeometry(0.3), new THREE.Color(1, 1, 1), 2.5, tf(0.2, 0, 0)),
      ]);
    case "shooter":
      return merge([
        part(new THREE.CylinderGeometry(0.85, 1.05, 0.55, 6), 0.65, 0, tf(0, -0.45, 0)),
        part(new THREE.SphereGeometry(0.66, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), 1, 0, tf(0, -0.18, 0)),
        part(new THREE.TorusGeometry(0.8, 0.07, 6, 24), 1, 1.6, tf(0, -0.16, 0, Math.PI / 2, 0, 0)),
        part(new THREE.BoxGeometry(0.2, 0.2, 0.2), 1, 2, tf(0, 0.55, 0, 0.6, 0.6, 0)),
      ]);
    case "charger": {
      const sh = new THREE.Shape();
      sh.moveTo(1.25, -0.35);
      sh.lineTo(-0.95, 0.75);
      sh.lineTo(-0.95, -0.35);
      sh.closePath();
      const wedge = new THREE.ExtrudeGeometry(sh, { depth: 1.5, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.06, bevelSegments: 1 });
      wedge.translate(0, 0, -0.75);
      return merge([
        part(wedge, 1, 0),
        part(new THREE.ConeGeometry(0.12, 0.7, 5), 0.9, 1.2, tf(0.95, 0.0, 0.5, 0, 0, -Math.PI / 2)),
        part(new THREE.ConeGeometry(0.12, 0.7, 5), 0.9, 1.2, tf(0.95, 0.0, -0.5, 0, 0, -Math.PI / 2)),
        part(new THREE.BoxGeometry(0.1, 0.1, 1.0), new THREE.Color(1, 1, 1), 2.6, tf(0.62, 0.0, 0, 0, 0, -0.46)),
      ]);
    }
    case "splitter":
      return merge([part(new THREE.IcosahedronGeometry(1, 0), 1, 0), part(new THREE.IcosahedronGeometry(0.35, 0), new THREE.Color(1, 1, 1), 1.5, tf(0.8, 0.25, 0))]);
    case "orbiter":
      return merge([
        part(new THREE.TorusGeometry(0.82, 0.2, 8, 28), 1, 0.25),
        part(new THREE.SphereGeometry(0.36, 12, 10), new THREE.Color(1, 1, 1), 2.2),
        part(new THREE.CylinderGeometry(0.05, 0.05, 1.6, 5), 0.8, 0.6, tf(0, 0, 0, 0, 0, 0)),
        part(new THREE.CylinderGeometry(0.05, 0.05, 1.6, 5), 0.8, 0.6, tf(0, 0, 0, 0, 0, Math.PI / 2)),
      ]);
    case "tank":
      return merge([
        part(new THREE.DodecahedronGeometry(1, 0), 0.85, 0),
        part(new THREE.TorusGeometry(1.0, 0.09, 6, 30), 1, 1.1, tf(0, 0, 0, Math.PI / 2, 0, 0)),
        part(new THREE.TorusGeometry(1.0, 0.09, 6, 30), 1, 1.1, tf(0, 0, 0, 0, 0, 0)),
      ]);
  }
}

/** Shooter turret barrel, pivot at the turret centre, pointing +X. */
export function barrelGeometry(): THREE.BufferGeometry {
  return merge([
    part(new THREE.CylinderGeometry(0.15, 0.2, 1.25, 8), 0.75, 0, tf(0.7, 0, 0, 0, 0, -Math.PI / 2)),
    part(new THREE.TorusGeometry(0.17, 0.06, 6, 12), new THREE.Color(1, 1, 1), 2.5, tf(1.32, 0, 0, 0, Math.PI / 2, 0)),
  ]);
}

/** Hover-ship for the player (and ghosts), ~1.6 long, facing +X. */
export function shipGeometry(hull: THREE.Color, trim: THREE.Color, engine: THREE.Color): THREE.BufferGeometry {
  const dark = hull.clone().multiplyScalar(0.45);
  return merge([
    part(new THREE.ConeGeometry(0.42, 1.65, 6), hull, 0.05, tf(0.25, 0, 0, Math.PI / 6, 0, -Math.PI / 2, 1, 1, 1).multiply(new THREE.Matrix4().makeScale(1, 1, 0.55))),
    part(new THREE.BoxGeometry(0.62, 0.26, 0.62), dark, 0, tf(-0.55, -0.02, 0)),
    part(new THREE.BoxGeometry(0.75, 0.06, 0.85), hull, 0, tf(-0.42, -0.04, 0.5, 0, 0.42, 0)),
    part(new THREE.BoxGeometry(0.75, 0.06, 0.85), hull, 0, tf(-0.42, -0.04, -0.5, 0, -0.42, 0)),
    part(new THREE.BoxGeometry(0.42, 0.1, 0.07), trim, 2.2, tf(-0.62, -0.02, 0.92, 0, 0.42, 0)),
    part(new THREE.BoxGeometry(0.42, 0.1, 0.07), trim, 2.2, tf(-0.62, -0.02, -0.92, 0, -0.42, 0)),
    part(new THREE.BoxGeometry(0.06, 0.38, 0.35), dark, 0, tf(-0.7, 0.2, 0, 0, 0, -0.5)),
    part(new THREE.SphereGeometry(0.2, 12, 8), trim, 0.9, tf(0.12, 0.14, 0, 0, 0, 0, 1.7, 0.75, 0.95)),
    part(new THREE.CylinderGeometry(0.1, 0.14, 0.32, 10), dark, 0, tf(-0.85, -0.02, 0.22, 0, 0, Math.PI / 2)),
    part(new THREE.CylinderGeometry(0.1, 0.14, 0.32, 10), dark, 0, tf(-0.85, -0.02, -0.22, 0, 0, Math.PI / 2)),
    part(new THREE.CircleGeometry(0.1, 10), engine, 4, tf(-1.02, -0.02, 0.22, 0, -Math.PI / 2, 0)),
    part(new THREE.CircleGeometry(0.1, 10), engine, 4, tf(-1.02, -0.02, -0.22, 0, -Math.PI / 2, 0)),
  ]);
}

export function gemGeometry(): THREE.BufferGeometry {
  return merge([part(new THREE.OctahedronGeometry(1, 0), 1, 0.35, tf(0, 0, 0, 0, 0, 0, 0.55, 1.15, 0.55))]);
}

export function chestGeometry(gold: THREE.Color, wood: THREE.Color): THREE.BufferGeometry {
  return merge([
    part(new THREE.BoxGeometry(1.2, 0.65, 0.8), wood, 0, tf(0, 0.33, 0)),
    part(new THREE.CylinderGeometry(0.4, 0.4, 1.2, 12, 1, false, 0, Math.PI), wood, 0, tf(0, 0.66, 0, 0, 0, Math.PI / 2)),
    part(new THREE.BoxGeometry(1.25, 0.1, 0.85), gold, 0.8, tf(0, 0.66, 0)),
    part(new THREE.BoxGeometry(0.12, 1.1, 0.86), gold, 0.8, tf(0.4, 0.5, 0)),
    part(new THREE.BoxGeometry(0.12, 1.1, 0.86), gold, 0.8, tf(-0.4, 0.5, 0)),
    part(new THREE.BoxGeometry(0.2, 0.25, 0.1), gold, 2.5, tf(0, 0.6, 0.43)),
  ]);
}

export function standingStoneGeometry(): THREE.BufferGeometry {
  return merge([
    part(new THREE.CylinderGeometry(0.16, 0.24, 1.3, 5), 0.7, 0, tf(0, 0.65, 0)),
    part(new THREE.OctahedronGeometry(0.16), new THREE.Color(1, 1, 1), 3, tf(0, 1.5, 0)),
  ]);
}

export function debrisGeometry(): THREE.BufferGeometry {
  return merge([part(new THREE.TetrahedronGeometry(1, 0), 1, 0.25)]);
}

/** Gear outline extruded (clockwork backdrop + props). */
export function gearGeometry(teeth: number, rOuter: number, rInner: number, depth: number, holes = 5): THREE.BufferGeometry {
  const sh = new THREE.Shape();
  const n = teeth * 4;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = i % 4;
    const r = k === 1 || k === 2 ? rOuter : rInner;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) sh.moveTo(x, y);
    else sh.lineTo(x, y);
  }
  const hub = new THREE.Path();
  hub.absarc(0, 0, rInner * 0.22, 0, Math.PI * 2, true);
  sh.holes.push(hub);
  for (let h = 0; h < holes; h++) {
    const a = (h / holes) * Math.PI * 2;
    const p = new THREE.Path();
    p.absarc(Math.cos(a) * rInner * 0.6, Math.sin(a) * rInner * 0.6, rInner * 0.18, 0, Math.PI * 2, true);
    sh.holes.push(p);
  }
  const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false, curveSegments: 6 });
  g.translate(0, 0, -depth / 2);
  return g;
}
