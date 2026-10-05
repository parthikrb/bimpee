import { resolveCircle } from "../logic/mapgen";
import { dist2, segPointDist2, TAU } from "../logic/math";
import { fireWeapon, DEFAULT_MODS } from "../logic/weapons";
import type { ArchRuntime, Enemy } from "./types";
import { BASE_ENEMY_SPEED } from "./constants";
import type { Sim } from "./Sim";

const dir = { x: 0, y: 0 };

function speedOf(e: Enemy) {
  return BASE_ENEMY_SPEED * e.arch.speed * (e.elite ? 0.92 : 1);
}

/** Per-frame update of a regular enemy (movement, behaviour, modifiers, contact). */
export function updateEnemy(sim: Sim, e: Enemy, dt: number) {
  const p = sim.player;
  const mods = e.arch.modifiers;
  e.flash = Math.max(0, e.flash - dt);
  e.orbHit = Math.max(0, e.orbHit - dt);
  if (e.spawnT > 0) e.spawnT = Math.max(0, e.spawnT - dt);

  // --- modifiers
  if (mods.has("regenerates") && e.hp < e.maxHp) e.hp = Math.min(e.maxHp, e.hp + e.maxHp * 0.05 * dt);
  if (mods.has("shielded") && e.shield < (e.elite ? 3 : 2)) {
    e.shieldRegen -= dt;
    if (e.shieldRegen <= 0) {
      e.shield = e.elite ? 3 : 2;
      e.shieldRegen = 4;
    }
  }
  if (mods.has("cloaks")) {
    e.cloakT = (e.cloakT + dt) % 4.6;
    const c = e.cloakT;
    e.alpha = c < 2.2 ? 1 : c < 2.6 ? 1 - ((c - 2.2) / 0.4) * 0.88 : c < 4.2 ? 0.12 : 0.12 + ((c - 4.2) / 0.4) * 0.88;
  } else e.alpha = 1;
  if (mods.has("leaves_trail") && !e.tide) {
    e.trailT -= dt;
    if (e.trailT <= 0) {
      e.trailT = 0.45;
      sim.addHazard("puddle", e.x, e.y, e.r * 0.9 + 6, 3.5, 5, `${e.arch.name}'s trail`, e.arch.color);
    }
  }

  // --- tide enemies just sweep across
  if (e.tide) {
    e.lifeT -= dt;
    if (e.lifeT <= 0) {
      sim.releaseEnemy(e);
      return;
    }
    e.x += e.dirX * dt;
    e.y += e.dirY * dt;
    e.vx = e.dirX;
    e.vy = e.dirY;
    contact(sim, e);
    return;
  }

  if (mods.has("teleports") && p.alive) {
    e.teleT -= dt;
    if (e.teleT <= 0) {
      e.teleT = 4.5 + sim.rand() * 2.5;
      if (dist2(e.x, e.y, p.x, p.y) > 230 * 230) {
        const pos = sim.findSpawnPos(140, 230, e.r, 8);
        if (pos) {
          sim.pushFx({ t: "teleport", x: e.x, y: e.y, color: e.arch.color });
          e.x = pos.x;
          e.y = pos.y;
          e.spawnT = 0.25;
          sim.pushFx({ t: "teleport", x: e.x, y: e.y, color: e.arch.color });
        }
      }
    }
  }

  // --- behaviour
  let speed = speedOf(e);
  let mx = 0;
  let my = 0;
  const d = p.alive ? sim.seekDir(e.x, e.y, dir) : 9999;
  const dx = p.x - e.x;
  const dy = p.y - e.y;
  const dd = Math.hypot(dx, dy) || 1;
  const toPX = dx / dd;
  const toPY = dy / dd;

  if (!p.alive) {
    // wander outward slowly after the player dies
    mx = -toPX * 0.3;
    my = -toPY * 0.3;
  } else if (e.rival) {
    rivalBehaviour(sim, e, dt, d, toPX, toPY);
    mx = e.dirX;
    my = e.dirY;
  } else {
    switch (e.arch.base) {
      case "chaser":
      case "splitter":
      case "tank":
        mx = dir.x;
        my = dir.y;
        if (e.arch.base === "splitter") speed *= 0.9;
        break;
      case "swarmer": {
        const w = Math.sin(sim.t * 5 + e.uid * 1.7) * 0.55;
        mx = dir.x - dir.y * w;
        my = dir.y + dir.x * w;
        break;
      }
      case "shooter": {
        if (d > 380) {
          mx = dir.x;
          my = dir.y;
        } else if (d < 240) {
          mx = -toPX;
          my = -toPY;
        } else {
          const s = e.uid % 2 ? 1 : -1;
          mx = -toPY * s * 0.7;
          my = toPX * s * 0.7;
        }
        e.cd -= dt;
        if (e.cd <= 0 && d < 560 && e.spawnT <= 0) {
          e.cd = 2.1 + sim.rand() * 0.7;
          const fast = e.arch.modifiers.has("fast_bullets");
          const a = Math.atan2(dy, dx);
          const sp = fast ? 400 : 235;
          const n = e.elite ? 3 : 1;
          for (let i = 0; i < n; i++) sim.fireEnemyBullet(e.x, e.y, a + (i - (n - 1) / 2) * 0.2, sp, e.elite ? 10 : 8, e.arch.name, e.arch.color);
        }
        break;
      }
      case "charger": {
        e.cd -= dt;
        if (e.state === 0) {
          mx = dir.x;
          my = dir.y;
          if (d < 320 && e.cd <= 0 && e.spawnT <= 0) {
            e.state = 1;
            e.stateT = 0.65;
            e.dirX = toPX;
            e.dirY = toPY;
          }
        } else if (e.state === 1) {
          e.stateT -= dt;
          if (e.stateT > 0.3) {
            e.dirX = toPX;
            e.dirY = toPY;
          }
          if (e.stateT <= 0) {
            e.state = 2;
            e.stateT = 0.45;
          }
        } else if (e.state === 2) {
          e.stateT -= dt;
          mx = e.dirX;
          my = e.dirY;
          speed = Math.max(520, speed * 4.5);
          if (e.stateT <= 0) {
            e.state = 3;
            e.stateT = 0.45;
          }
        } else {
          e.stateT -= dt;
          if (e.stateT <= 0) {
            e.state = 0;
            e.cd = 2.2 + sim.rand();
          }
        }
        break;
      }
      case "orbiter": {
        if (e.state === 0) {
          if (d > 420) {
            mx = dir.x;
            my = dir.y;
            e.ang = Math.atan2(e.y - p.y, e.x - p.x);
          } else {
            e.ang += (speed / 170) * dt * (e.uid % 2 ? 1 : -1);
            const tx = p.x + Math.cos(e.ang) * 170 - e.x;
            const ty = p.y + Math.sin(e.ang) * 170 - e.y;
            const tl = Math.hypot(tx, ty) || 1;
            mx = tx / tl;
            my = ty / tl;
            speed *= 1.3;
            e.stateT += dt;
            if (e.stateT > 3.2 + (e.uid % 5) * 0.3) {
              e.state = 2;
              e.stateT = 0.55;
              e.dirX = toPX;
              e.dirY = toPY;
            }
          }
        } else {
          e.stateT -= dt;
          mx = e.dirX;
          my = e.dirY;
          speed *= 3.2;
          if (e.stateT <= 0) {
            e.state = 0;
            e.stateT = 0;
            e.ang = Math.atan2(e.y - p.y, e.x - p.x);
          }
        }
        break;
      }
    }
    // fast_bullets on non-shooters: an occasional aimed shot
    if (e.arch.base !== "shooter" && e.arch.modifiers.has("fast_bullets")) {
      e.cd2 -= dt;
      if (e.cd2 <= 0 && d < 520 && e.spawnT <= 0) {
        e.cd2 = 3.5 + sim.rand() * 1.5;
        sim.fireEnemyBullet(e.x, e.y, Math.atan2(dy, dx), 380, 7, e.arch.name, e.arch.color, 5);
      }
    }
  }

  if (e.spawnT > 0) speed *= 0.4;
  const kd = Math.exp(-7 * dt);
  e.vx = mx * speed;
  e.vy = my * speed;
  e.x += (e.vx + e.kx) * dt;
  e.y += (e.vy + e.ky) * dt;
  e.kx *= kd;
  e.ky *= kd;

  separate(sim, e);
  if (resolveCircle(sim.map, e, e.r) && e.state === 2) {
    // chargers / orbiters stop when slamming into walls
    e.state = 3;
    e.stateT = 0.3;
  }
  contact(sim, e);
}

function separate(sim: Sim, e: Enemy) {
  let checks = 0;
  sim.hash.query(e.x, e.y, e.r * 2 + 8, (i) => {
    if (++checks > 10) return true;
    const o = sim.enemies[i]!;
    if (o === e || !o.active || o.tide) return;
    const rr = e.r + o.r;
    const ddx = e.x - o.x;
    const ddy = e.y - o.y;
    const d2 = ddx * ddx + ddy * ddy;
    if (d2 >= rr * rr || d2 < 1e-6) return;
    const dist = Math.sqrt(d2);
    const push = ((rr - dist) / dist) * (o.isBoss ? 0.9 : 0.35);
    e.x += ddx * push;
    e.y += ddy * push;
  });
}

function contact(sim: Sim, e: Enemy) {
  const p = sim.player;
  if (!p.alive || e.spawnT > 0) return;
  const rr = e.r + p.r - 2;
  if (dist2(e.x, e.y, p.x, p.y) < rr * rr) {
    const before = p.iframes;
    sim.hurtPlayer(e.tide ? e.contact * 0.6 : e.contact, e.isBoss ? sim.world.boss.name : e.rival ? "Mirror Rival" : e.arch.name);
    if (before <= 0 && !e.isBoss) {
      const dx = e.x - p.x;
      const dy = e.y - p.y;
      const l = Math.hypot(dx, dy) || 1;
      e.kx += (dx / l) * 260 * (1 - e.kbResist);
      e.ky += (dy / l) * 260 * (1 - e.kbResist);
    }
  }
}

function rivalBehaviour(sim: Sim, e: Enemy, dt: number, d: number, toPX: number, toPY: number) {
  const s = e.uid % 2 ? 1 : -1;
  if (d > 360) {
    e.dirX = dir.x;
    e.dirY = dir.y;
  } else if (d < 220) {
    e.dirX = -toPX;
    e.dirY = -toPY;
  } else {
    e.dirX = -toPY * s;
    e.dirY = toPX * s;
  }
  e.cd -= dt;
  if (e.cd > 0 || d > 600 || e.spawnT > 0) return;
  const w = sim.build.weapons[0]!;
  e.cd = Math.max(0.5, w.cooldown * 2.4);
  const a = Math.atan2(toPY, toPX);
  const color = e.arch.color;
  if (w.kind === "orbitals") {
    for (let i = 0; i < 8; i++) sim.fireEnemyBullet(e.x, e.y, a + (i / 8) * TAU, 190, 6, "Mirror Rival", color);
    e.cd = 1.8;
    return;
  }
  if (w.kind === "lobber") {
    sim.addHazard("blast", sim.player.x, sim.player.y, 70, 0.95, 12, "Mirror Rival", color);
    e.cd = 1.6;
    return;
  }
  const shots = fireWeapon(w, { ...DEFAULT_MODS, critChance: 0 }, a, sim.rand, d);
  for (const sh of shots) {
    if (sh.kind === "lance") {
      for (let k = 0; k < 3; k++) sim.fireEnemyBullet(e.x + Math.cos(sh.angle) * k * 18, e.y + Math.sin(sh.angle) * k * 18, sh.angle, 420, 6, "Mirror Rival", color, 5);
    } else sim.fireEnemyBullet(e.x, e.y, sh.angle, Math.min(420, sh.speed * 0.55), 6, "Mirror Rival", color, 5);
  }
}

// ---------------------------------------------------------------------------
// Boss

export function updateBoss(sim: Sim, e: Enemy, dt: number) {
  const b = sim.boss;
  if (!b || b.e !== e) {
    updateEnemy(sim, e, dt);
    return;
  }
  const p = sim.player;
  e.flash = Math.max(0, e.flash - dt);
  e.orbHit = Math.max(0, e.orbHit - dt);
  if (e.spawnT > 0) {
    e.spawnT = Math.max(0, e.spawnT - dt);
    return;
  }
  const phaseSpeed = 1 + (b.phase - 1) * 0.3;
  const dx = p.x - e.x;
  const dy = p.y - e.y;
  const d = Math.hypot(dx, dy) || 1;
  const toA = Math.atan2(dy, dx);
  const base = BASE_ENEMY_SPEED * e.arch.speed * (1 + (b.phase - 1) * 0.15);
  let mx = 0;
  let my = 0;
  let speed = base;
  const busy = b.laser !== null || e.state === 1 || e.state === 2;

  // --- movement by base archetype
  if (!busy && p.alive) {
    const sd = sim.seekDir(e.x, e.y, dir);
    switch (e.arch.base) {
      case "orbiter": {
        e.ang += 0.5 * dt;
        const tx = p.x + Math.cos(e.ang) * 280 - e.x;
        const ty = p.y + Math.sin(e.ang) * 280 - e.y;
        const tl = Math.hypot(tx, ty) || 1;
        mx = tx / tl;
        my = ty / tl;
        speed *= 1.4;
        if (sd > 500) (mx = dir.x), (my = dir.y);
        break;
      }
      case "shooter":
        if (sd > 380) (mx = dir.x), (my = dir.y);
        else if (sd < 260) (mx = -dx / d), (my = -dy / d);
        else (mx = -dy / d), (my = dx / d);
        break;
      default:
        mx = dir.x;
        my = dir.y;
    }
  }

  // --- signature attack
  b.sigCd -= dt * phaseSpeed;
  const sig = sim.world.boss.signature;
  const color = e.arch.color;
  const name = b.name;
  if (p.alive) {
    switch (sig) {
      case "radial_burst": {
        if (b.sigCd <= 0 && b.sigStep === 0) {
          const n = 12 + b.phase * 6;
          const off = sim.rand() * TAU;
          for (let i = 0; i < n; i++) sim.fireEnemyBullet(e.x, e.y, off + (i / n) * TAU, 190 + b.phase * 15, 9, name, color, 7);
          sim.shake(0.15, 0.15);
          if (b.phase >= 3) {
            b.sigStep = 1;
            b.sigActive = 0.3;
          } else b.sigCd = 3.2;
        } else if (b.sigStep === 1) {
          b.sigActive -= dt;
          if (b.sigActive <= 0) {
            const n = 18;
            for (let i = 0; i < n; i++) sim.fireEnemyBullet(e.x, e.y, ((i + 0.5) / n) * TAU, 150, 9, name, color, 7);
            b.sigStep = 0;
            b.sigCd = 3.2;
          }
        }
        break;
      }
      case "summon_swarm": {
        if (b.sigCd <= 0) {
          b.sigCd = 6.5;
          const arch = sim.archetypes.find((a) => a.base === "swarmer") ?? swarmArch(sim, color);
          const n = 4 + b.phase * 3;
          for (let i = 0; i < n; i++) {
            const a = (i / n) * TAU;
            const x = e.x + Math.cos(a) * (e.r + 30);
            const y = e.y + Math.sin(a) * (e.r + 30);
            const m = sim.spawnEnemy(arch, x, y, { spawnT: 0.5 });
            if (m) {
              m.kx = Math.cos(a) * 200;
              m.ky = Math.sin(a) * 200;
            }
          }
          sim.pushFx({ t: "ring", x: e.x, y: e.y, r: e.r * 2.5, color });
        }
        break;
      }
      case "charge_combo": {
        if (e.state === 0 && b.sigCd <= 0) {
          b.chargesLeft = 1 + b.phase;
          e.state = 1;
          e.stateT = 0.7;
        }
        if (e.state === 1) {
          e.stateT -= dt;
          if (e.stateT > 0.25) {
            e.dirX = dx / d;
            e.dirY = dy / d;
          }
          if (e.stateT <= 0) {
            e.state = 2;
            e.stateT = 0.5;
          }
        } else if (e.state === 2) {
          e.stateT -= dt;
          mx = e.dirX;
          my = e.dirY;
          speed = 760 + b.phase * 60;
          if (e.stateT <= 0) {
            b.chargesLeft--;
            sim.shake(0.2, 0.15);
            if (b.chargesLeft > 0) {
              e.state = 1;
              e.stateT = 0.45;
            } else {
              e.state = 0;
              b.sigCd = 4.5;
            }
          }
        }
        break;
      }
      case "laser_sweep": {
        if (!b.laser && b.sigCd <= 0) {
          b.laser = { angle: toA, rot: (sim.rand() < 0.5 ? -1 : 1) * (0.75 + 0.22 * (b.phase - 1)), t: 1.0, mode: "tele", beams: b.phase >= 3 ? 2 : 1 };
        }
        const L = b.laser;
        if (L) {
          L.t -= dt;
          if (L.mode === "tele") {
            if (L.t <= 0) {
              L.mode = "fire";
              L.t = 2.6;
              sim.shake(0.25, 0.3);
            }
          } else {
            L.angle += L.rot * dt;
            for (let k = 0; k < L.beams; k++) {
              const a = L.angle + k * Math.PI;
              const x2 = e.x + Math.cos(a) * 1100;
              const y2 = e.y + Math.sin(a) * 1100;
              if (segPointDist2(e.x, e.y, x2, y2, p.x, p.y) < (p.r + 12) ** 2) sim.hurtPlayer(14, `${name}'s laser`);
            }
            if (L.t <= 0) {
              b.laser = null;
              b.sigCd = 3.5;
            }
          }
        }
        break;
      }
      case "bullet_spiral": {
        if (b.sigActive <= 0 && b.sigCd <= 0) {
          b.sigActive = 3;
          b.sigStep = 0;
        }
        if (b.sigActive > 0) {
          b.sigActive -= dt;
          b.sigStep -= dt;
          speed *= 0.3;
          if (b.sigStep <= 0) {
            b.sigStep = 0.085;
            const arms = 1 + b.phase;
            b.spiralAngle += 0.27;
            for (let k = 0; k < arms; k++) sim.fireEnemyBullet(e.x, e.y, b.spiralAngle + (k / arms) * TAU, 185, 8, name, color, 6);
          }
          if (b.sigActive <= 0) b.sigCd = 3.4;
        }
        break;
      }
    }
    // Added pattern from phase 2: aimed spread
    if (b.phase >= 2) {
      b.secondaryCd -= dt;
      if (b.secondaryCd <= 0) {
        b.secondaryCd = 2.6 / phaseSpeed;
        const n = 3 + (b.phase - 2) * 2;
        for (let i = 0; i < n; i++) sim.fireEnemyBullet(e.x, e.y, toA + (i - (n - 1) / 2) * 0.16, 260, 8, name, color, 6);
      }
    }
  }

  if (b.laser) speed = 0;
  if (e.state === 1) speed = 0;
  e.vx = mx * speed;
  e.vy = my * speed;
  e.x += e.vx * dt;
  e.y += e.vy * dt;
  e.ang = Number.isFinite(e.ang) ? e.ang : 0;
  if (resolveCircle(sim.map, e, Math.min(e.r, 60)) && e.state === 2) {
    e.stateT = Math.min(e.stateT, 0.05);
  }
  contact(sim, e);
}

const swarmCache = new WeakMap<Sim, ArchRuntime>();
/** Synthetic swarmer used when the world has none (boss summons, swarm tide). */
export function swarmArch(sim: Sim, color: number): ArchRuntime {
  let a = swarmCache.get(sim);
  if (!a) {
    a = {
      id: "__swarm",
      name: "Swarmling",
      base: "swarmer",
      hp: 1.5,
      speed: 1.5,
      size: 0.6,
      color,
      modifiers: new Set(),
      weight: 0,
      unlockAct: 0,
      synthetic: true,
    };
    swarmCache.set(sim, a);
  }
  return a;
}
