import { generateFallbackWorld } from "@bimpee/shared";
import { describe, expect, it } from "vitest";
import { Sim } from "../sim/Sim";
import { aimAssist, rayPlaneY, type AimTarget } from "./aim";
import { cameraRelativeMove, springStep, wrapAngle } from "./controls";
import { S, simAngleFromDir, spawnViewForRing, toSim, toWorld, yawFromSimAngle } from "./coords";
import { edgeIndicator, rearThreat } from "./indicators";
import { cameraClearDistance, segmentBlockedT, type WallGrid } from "./occlusion";
import { QUALITY_LEVELS, QualityGovernor } from "./quality";

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("coords", () => {
  it("round-trips sim px <-> world units", () => {
    for (const v of [0, 1, 64, 1234.5, -77]) close(toSim(toWorld(v)), v);
    close(toWorld(64), 64 * S);
  });

  it("yaw for a +X model points along the sim angle", () => {
    for (const a of [0, 0.3, -1.2, Math.PI / 2, 3]) {
      const ry = yawFromSimAngle(a);
      // three: rotating +X by ry about Y gives (cos ry, 0, -sin ry)
      const dx = Math.cos(ry);
      const dz = -Math.sin(ry);
      close(dx, Math.cos(a));
      close(dz, Math.sin(a));
      close(wrapAngle(simAngleFromDir(dx, dz) - a), 0);
    }
  });

  it("feeds the sim a view whose spawn ring lands where asked", () => {
    const sim = new Sim({ world: generateFallbackWorld(3), runId: "c", players: 1, playerName: "t", rngSeed: 1 });
    for (const ring of [500, 950, 1300]) close(sim.spawnRingRadius(spawnViewForRing(ring)), ring, 1e-6);
  });
});

describe("camera-relative input", () => {
  const out = { x: 0, y: 0 };
  it("forward follows the camera yaw", () => {
    cameraRelativeMove(0, -1, 0, out);
    close(out.x, 1);
    close(out.y, 0);
    cameraRelativeMove(0, -1, -Math.PI / 2, out); // camera looks "up" the old 2D screen
    close(out.x, 0);
    close(out.y, -1);
  });
  it("strafe right is the screen right of the camera", () => {
    cameraRelativeMove(1, 0, -Math.PI / 2, out);
    close(out.x, 1);
    close(out.y, 0);
    cameraRelativeMove(1, 0, 0, out);
    close(out.x, 0);
    close(out.y, 1);
  });
  it("matches the old 2D mapping at the default yaw and clamps diagonals", () => {
    cameraRelativeMove(1, 1, -Math.PI / 2, out);
    close(Math.hypot(out.x, out.y), 1);
    close(out.x, Math.SQRT1_2);
    close(out.y, Math.SQRT1_2);
  });
  it("is NaN-safe", () => {
    cameraRelativeMove(Number.NaN, Number.POSITIVE_INFINITY, 1, out);
    expect(Number.isFinite(out.x) && Number.isFinite(out.y)).toBe(true);
  });
  it("spring converges without overshoot blow-ups", () => {
    const s = { x: 0, v: 0 };
    for (let i = 0; i < 240; i++) springStep(s, 10, 8, 1 / 60);
    close(s.x, 10, 1e-3);
    springStep(s, Number.NaN, 8, 1 / 60);
    expect(Number.isFinite(s.x)).toBe(true);
  });
});

describe("aim", () => {
  const enemy = (x: number, y: number, extra: Partial<AimTarget> = {}): AimTarget => ({ active: true, x, y, r: 12, spawnT: 0, alpha: 1, ...extra });

  it("ray hits the ground plane in front only", () => {
    close(rayPlaneY(10, -1, 0), 10);
    expect(rayPlaneY(10, 1, 0)).toBe(-1);
    expect(rayPlaneY(10, 0, 0)).toBe(-1);
  });

  it("bends aim towards an enemy inside the cone", () => {
    const list = [enemy(300, 30)];
    const r = aimAssist(0, 0, 0, 300, list, { cone: 0.2, maxDist: 800, strength: 1 });
    expect(r.target).toBe(0);
    close(r.angle, Math.atan2(30, 300), 1e-9);
    close(r.dist, Math.hypot(300, 30), 1e-9);
  });

  it("is soft: partial strength keeps part of the raw aim", () => {
    const r = aimAssist(0, 0, 0, 300, [enemy(300, 30)], { cone: 0.2, maxDist: 800, strength: 0.5 });
    close(r.angle, Math.atan2(30, 300) / 2, 1e-9);
  });

  it("ignores enemies outside the cone, out of range, spawning or cloaked", () => {
    const list = [enemy(0, 300), enemy(2000, 0), enemy(300, 0, { spawnT: 0.5 }), enemy(300, 5, { alpha: 0.1 }), enemy(300, 0, { active: false })];
    const r = aimAssist(0, 0, 0, 300, list, { cone: 0.2, maxDist: 800, strength: 1 });
    expect(r.target).toBe(-1);
    expect(r.angle).toBe(0);
  });

  it("prefers the enemy closest to the crosshair, then the nearer one", () => {
    const list = [enemy(400, 60), enemy(400, 5), enemy(200, 4)];
    const r = aimAssist(0, 0, 0, 300, list, { cone: 0.25, maxDist: 800, strength: 1 });
    expect(r.target).toBe(2);
  });

  it("handles wrap-around at +-PI", () => {
    const r = aimAssist(0, 0, Math.PI - 0.01, 300, [enemy(-300, -6)], { cone: 0.2, maxDist: 800, strength: 1 });
    expect(r.target).toBe(0);
    close(wrapAngle(r.angle - Math.atan2(-6, -300)), 0, 1e-9);
  });
});

describe("camera collision / occlusion", () => {
  // 10x10 grid of 64px tiles with a wall column at c=5 (rows 0..9)
  const grid: WallGrid = { cols: 10, rows: 10, tile: 64, solid: new Uint8Array(100) };
  for (let r = 0; r < 10; r++) grid.solid[r * 10 + 5] = 1;

  it("a clear segment returns 1", () => {
    expect(segmentBlockedT(grid, 32, 32, 1, 300, 600, 1, 2.6)).toBe(1);
  });

  it("finds where a low segment enters a wall", () => {
    const t = segmentBlockedT(grid, 32, 100, 1, 32 + 640, 100, 1, 2.6);
    close(t, (320 - 32) / 640, 1e-9);
  });

  it("passes over walls when high enough", () => {
    expect(segmentBlockedT(grid, 32, 100, 4, 600, 100, 4, 2.6)).toBe(1);
  });

  it("is blocked when the segment dips below the wall top inside the cell", () => {
    // descends from 6 to 0 across the wall
    expect(segmentBlockedT(grid, 200, 100, 0.5, 600, 100, 6, 2.6)).toBeLessThan(1);
  });

  it("ignores the start cell and NaNs", () => {
    expect(segmentBlockedT(grid, 330, 100, 0, 340, 100, 0, 2.6)).toBe(1);
    expect(segmentBlockedT(grid, Number.NaN, 0, 0, 1, 1, 1, 2.6)).toBe(1);
  });

  it("pulls the camera in front of a wall but never below minDist", () => {
    const S2 = 1 / 32;
    const full = cameraClearDistance(grid, S2, 100, 100, 1, 600, 100, 1.2, 2.6, 0.3, 2);
    expect(full).toBeLessThan(((600 - 100) * S2));
    expect(full).toBeGreaterThanOrEqual(2);
    const free = cameraClearDistance(grid, S2, 100, 100, 1, 100, 400, 1.2, 2.6, 0.3, 2);
    close(free, Math.hypot(300 * S2, 0.2), 1e-9);
    // a wall right behind the target still leaves minDist
    const tight = cameraClearDistance(grid, S2, 310, 100, 1, 700, 100, 1, 2.6, 0.3, 2);
    expect(tight).toBe(2);
  });
});

describe("quality governor", () => {
  it("steps down after sustained low fps, once per settle period", () => {
    const q = new QualityGovernor(0, { minFps: 45, sustain: 2, settle: 1, window: 0.5 });
    let changes = 0;
    for (let i = 0; i < 30 * 3.4; i++) if (q.sample(1 / 30)) changes++;
    expect(changes).toBe(1);
    expect(q.level).toBe(1);
    expect(q.current).toBe(QUALITY_LEVELS[1]);
  });

  it("keeps quality at good fps and ignores hitches", () => {
    const q = new QualityGovernor(0, { minFps: 45, sustain: 2, settle: 0.5, window: 0.5 });
    for (let i = 0; i < 60 * 10; i++) q.sample(1 / 60);
    for (let i = 0; i < 20; i++) q.sample(2); // tab switch
    expect(q.level).toBe(0);
    expect(q.fps).toBeGreaterThan(55);
  });

  it("brief dips do not trigger a step", () => {
    const q = new QualityGovernor(0, { minFps: 45, sustain: 2, settle: 0, window: 0.5 });
    for (let k = 0; k < 10; k++) {
      for (let i = 0; i < 30; i++) q.sample(1 / 30); // 1s slow
      for (let i = 0; i < 120; i++) q.sample(1 / 60); // 2s fast
    }
    expect(q.level).toBe(0);
  });

  it("never goes beyond the last level and respects lock", () => {
    const q = new QualityGovernor(0, { minFps: 45, sustain: 0.5, settle: 0, window: 0.5 });
    for (let i = 0; i < 10 * 60; i++) q.sample(1 / 10);
    expect(q.level).toBe(QUALITY_LEVELS.length - 1);
    const l = new QualityGovernor(0, { minFps: 45, sustain: 0.5, settle: 0, window: 0.5 });
    l.locked = true;
    for (let i = 0; i < 600; i++) l.sample(1 / 10);
    expect(l.level).toBe(0);
  });
});

describe("threat indicators", () => {
  const out = { x: 0, y: 0, angle: 0 };
  it("on-screen points need no arrow", () => {
    expect(edgeIndicator(0.2, -0.3, 1, 800, 600, 30, out)).toBe(false);
  });
  it("clamps off-screen points to the inset edge", () => {
    expect(edgeIndicator(3, 0, 1, 800, 600, 30, out)).toBe(true);
    close(out.x, 770);
    close(out.y, 300);
    close(out.angle, 0);
    expect(edgeIndicator(0, 5, 1, 800, 600, 30, out)).toBe(true);
    close(out.y, 30);
    close(out.angle, -Math.PI / 2);
  });
  it("mirrors points behind the camera", () => {
    // behind and slightly to the right in clip space -> arrow on the left side mirrored
    expect(edgeIndicator(0.2, 0, -1, 800, 600, 30, out)).toBe(true);
    expect(out.x).toBeLessThan(400);
    // dead behind -> bottom edge
    expect(edgeIndicator(0, 0, -1, 800, 600, 30, out)).toBe(true);
    close(out.y, 570);
  });
  it("rear threat counts only enemies behind the camera", () => {
    const yaw = 0; // camera looks +x
    const front = [{ active: true, x: 100, y: 0, spawnT: 0 }];
    const back = [
      { active: true, x: -100, y: 0, spawnT: 0 },
      { active: true, x: -50, y: 20, spawnT: 0 },
    ];
    expect(rearThreat(0, 0, yaw, front, 300)).toBe(0);
    expect(rearThreat(0, 0, yaw, back, 300)).toBeGreaterThan(0);
    expect(rearThreat(0, 0, yaw, back, 300, 1)).toBe(1);
    expect(rearThreat(0, 0, yaw, [{ active: true, x: -1000, y: 0, spawnT: 0 }], 300)).toBe(0);
  });
});
