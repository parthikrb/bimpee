import * as THREE from "three";
import { ENEMY_BASES, type EnemyBase, type WorldSpec } from "@bimpee/shared";
import { generateMap } from "./logic/mapgen";
import { Bag } from "./render3d/bag";
import { S } from "./render3d/coords";
import { Environment } from "./render3d/environment";
import { glowMaterial } from "./render3d/materials";
import { enemyGeometry, merge, part, shipGeometry } from "./render3d/models";
import { palette } from "./render3d/palette";
import { PostFx } from "./render3d/postfx";
import { WeatherLayer } from "./render3d/weather";

export interface WorldPreview {
  destroy(): void;
}

/**
 * A slowly orbiting cinematic diorama of a world's arena for the reveal
 * screen: map, props, sky, lighting, weather, a few idle enemies and the
 * boss silhouette, with bloom. No Sim. Light and fully disposable; returns a
 * no-op handle when WebGL is unavailable.
 */
export function createWorldPreview(parent: HTMLElement, world: WorldSpec): WorldPreview {
  const bag = new Bag();
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance", alpha: false, stencil: false });
  } catch {
    return { destroy() {} };
  }
  let destroyed = false;
  let raf = 0;
  const reduced = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const scene = new THREE.Scene();
  let post: PostFx | null = null;
  let weather: WeatherLayer | null = null;
  let ro: ResizeObserver | null = null;
  const cv = renderer.domElement;

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    cancelAnimationFrame(raf);
    ro?.disconnect();
    cv.removeEventListener("webglcontextlost", onLost);
    weather?.dispose();
    post?.dispose();
    bag.dispose();
    scene.traverse((o) => {
      if ((o as THREE.Light).isLight) (o as THREE.Light).dispose();
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose?.();
    });
    scene.clear();
    renderer.dispose();
    renderer.forceContextLoss();
    cv.remove();
  };
  let lost = false;
  const onLost = (e: Event) => {
    e.preventDefault();
    lost = true;
  };

  try {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    Object.assign(cv.style, { position: "absolute", inset: "0", width: "100%", height: "100%", display: "block", pointerEvents: "none" });
    cv.setAttribute("aria-hidden", "true");
    cv.addEventListener("webglcontextlost", onLost);
    cv.addEventListener("webglcontextrestored", () => (lost = false));
    parent.appendChild(cv);

    const map = generateMap(world);
    const env = new Environment(world, map, bag, { shadows: true, shadowSize: 1024, preview: true });
    scene.add(env.group);
    scene.fog = env.fog;
    const pal = palette(world);
    const cx = env.center.x;
    const cz = env.center.z;

    // idle enemies in a loose ring around the arena centre
    const mat = bag.track(glowMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.45, metalness: 0.15, flatShading: true }, { emissive: 0.2, rim: 0.9, vertexGlow: true }));
    const geos = new Map<EnemyBase, THREE.BufferGeometry>();
    const idle: { mesh: THREE.Mesh; base: EnemyBase; y: number; ph: number }[] = [];
    const list = world.enemies.slice(0, 5);
    list.forEach((e, i) => {
      const base = (ENEMY_BASES as readonly string[]).includes(e.base) ? e.base : "chaser";
      let g = geos.get(base);
      if (!g) {
        g = bag.track(enemyGeometry(base));
        geos.set(base, g);
      }
      const m0 = bag.track(mat.clone());
      m0.color.set(e.color);
      for (let k = 0; k < 3; k++) {
        const m = new THREE.Mesh(g, m0);
        const r = 12 * e.size * S * 1.15;
        const a = (i / list.length) * Math.PI * 2 + k * 0.42;
        const d = 6.5 + k * 1.6 + (i % 2) * 1.2;
        m.position.set(cx + Math.cos(a) * d, r * 1.1, cz + Math.sin(a) * d);
        m.scale.setScalar(r);
        m.rotation.y = -a + Math.PI; // face the centre
        m.castShadow = true;
        scene.add(m);
        idle.push({ mesh: m, base, y: r * 1.1, ph: i * 1.7 + k });
      }
    });

    // the boss looms over the centre, dark with a burning rim
    const boss = world.boss;
    const bossGeo = bag.track(enemyGeometry((ENEMY_BASES as readonly string[]).includes(boss.base) ? boss.base : "tank"));
    const bossMat = bag.track(glowMaterial({ color: new THREE.Color(boss.color).multiplyScalar(0.3), vertexColors: true, roughness: 0.5, metalness: 0.4, flatShading: true }, { emissive: 0.08, rim: 2.4, vertexGlow: true }));
    const bossMesh = new THREE.Mesh(bossGeo, bossMat);
    const br = Math.max(1.6, 15 * boss.size * S * 1.25);
    const bossPos = new THREE.Vector3(cx, br * 1.6 + 1, cz);
    bossMesh.position.copy(bossPos);
    bossMesh.scale.setScalar(br);
    bossMesh.castShadow = true;
    scene.add(bossMesh);
    const ringGeo = bag.track(merge([part(new THREE.TorusGeometry(1, 0.03, 6, 72), 1, 0.9)]));
    const ringMat = bag.track(glowMaterial({ color: new THREE.Color(boss.color), vertexColors: true }, { emissive: 0.2, rim: 0.3, vertexGlow: true }));
    const rings = Array.from({ length: Math.max(1, Math.min(3, boss.phases)) }, (_, i) => {
      const r = new THREE.Mesh(ringGeo, ringMat);
      r.position.copy(bossPos);
      r.scale.setScalar(br * (1.75 + i * 0.4));
      scene.add(r);
      return r;
    });
    const bossLight = new THREE.PointLight(new THREE.Color(boss.color), 30, 30, 1.3);
    bossLight.position.copy(bossPos).add(new THREE.Vector3(0, -br * 0.6, 0));
    scene.add(bossLight);
    // ground halo under the boss
    const halo = new THREE.Mesh(
      bag.track(new THREE.RingGeometry(0.85, 1, 64)),
      bag.track(new THREE.MeshBasicMaterial({ color: new THREE.Color(boss.color), transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.set(cx, 0.05, cz);
    halo.scale.setScalar(br * 3);
    scene.add(halo);
    // the player's ship, waiting at the edge of the pack
    const ship = new THREE.Mesh(
      bag.track(shipGeometry(pal.player, pal.accent, pal.glow.clone())),
      bag.track(glowMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.35, metalness: 0.35 }, { emissive: 0.12, rim: 0.8, vertexGlow: true })),
    );
    ship.position.set(cx + 11, 0.8, cz + 3);
    ship.rotation.y = Math.PI - 0.25;
    ship.castShadow = true;
    scene.add(ship);

    weather = new WeatherLayer(bag, scene, null, 0.6, () => reduced);
    weather.set(world.theme.weather);

    const camera = new THREE.PerspectiveCamera(50, 1, 0.3, 2000);
    post = new PostFx(renderer, scene, camera, { bloom: world.theme.bloom, vignette: world.theme.vignette, crt: world.theme.crt, bloomScale: 0.5, exposure: env.style.exposure });
    post.setStatic(world.theme.weather === "static");

    const resize = () => {
      if (destroyed) return;
      const w = Math.max(1, parent.clientWidth || 640);
      const h = Math.max(1, parent.clientHeight || 360);
      renderer.setSize(w, h, false);
      post?.setSize(w, h);
      camera.aspect = w / h;
      camera.fov = w / h < 1 ? 62 : 46;
      camera.updateProjectionMatrix();
    };
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(resize);
      ro.observe(parent);
    }
    resize();

    const look = new THREE.Vector3(cx, 3.2, cz);
    const v = new THREE.Vector3();
    let angle = 0.6;
    let t = 0;
    let lastNow = -1;
    const frame = (now: number) => {
      if (destroyed) return;
      raf = requestAnimationFrame(frame);
      const dt = lastNow < 0 ? 1 / 60 : Math.min(0.1, (now - lastNow) / 1000);
      lastNow = now;
      t += dt;
      angle += dt * (reduced ? 0.02 : 0.07);
      const R = 24;
      camera.position.set(cx + Math.cos(angle) * R, 9.5 + Math.sin(t * 0.2) * 1.2, cz + Math.sin(angle) * R);
      camera.lookAt(look);
      camera.updateMatrixWorld();
      // dither out walls between the camera and the centre of the diorama
      const ou = env.occ;
      v.copy(look).project(camera);
      ou.uOccCenter.value.set((v.x * 0.5 + 0.5) * cv.width, (v.y * 0.5 + 0.5) * cv.height);
      ou.uOccRadius.value = cv.height * 0.42;
      ou.uOccDepth.value = R - 4;
      ou.uOccStrength.value = 1;
      env.setFocus(cx, cz);
      env.update(dt, { blackout: 0, weatherFog: weather?.fogInfo().mul ?? 1, weatherFogColor: weather?.fogInfo().color ?? null });
      for (const e of idle) {
        e.mesh.position.y = e.y + Math.sin(t * 2 + e.ph) * 0.08 + (e.base === "swarmer" ? 0.4 : 0);
        if (e.base === "orbiter") e.mesh.rotation.y += dt * 3;
        else e.mesh.rotation.y += Math.sin(t * 0.5 + e.ph) * dt * 0.4;
      }
      bossMesh.rotation.y = t * 0.25;
      ship.position.y = 0.8 + Math.sin(t * 2.4) * 0.06;
      bossMesh.position.y = bossPos.y + Math.sin(t * 0.9) * 0.3;
      rings.forEach((r) => (r.position.y = bossMesh.position.y));
      rings.forEach((r, i) => r.rotation.set(Math.PI / 2 + Math.sin(t * 0.6 + i) * 0.4, t * (0.5 + i * 0.3) * (i ? -1 : 1), 0));
      weather?.update(dt, look, ((parent.clientHeight || 360) * renderer.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)));
      post?.update(dt, { tint: env.tint.color, tintAmt: 0, slow: 0, hurt: 0, danger: 0, blackout: 0, reduced });
      if (!lost) post?.render(dt);
    };
    raf = requestAnimationFrame(frame);
  } catch (err) {
    console.warn("[bimpee] world preview failed", err);
    destroy();
  }
  return { destroy };
}
