import { BOON_KINDS, ENEMY_MODIFIERS, EVENT_KINDS, WEATHERS, type Directive } from "@bimpee/shared";
import { circleFree } from "../logic/mapgen";
import { clamp, finiteOr, hexToInt, TAU } from "../logic/math";
import { boonWeaponUpgrade } from "../logic/upgrades";
import { swarmArch } from "./enemyAI";
import type { Sim } from "./Sim";
import type { ArchRuntime } from "./types";

export interface DirectiveResult {
  ok: boolean;
  note?: string;
}

type EventKind = (typeof EVENT_KINDS)[number];

/**
 * Applies one director directive to the simulation. Pacing directives go to
 * the PacingController first; everything else is handled here. Never throws
 * for well-formed input; returns ok=false with a note when it can't apply.
 */
export function applyDirective(sim: Sim, d: Directive): DirectiveResult {
  if (!d || typeof d !== "object" || typeof (d as { tool?: unknown }).tool !== "string") return { ok: false, note: "malformed directive" };
  if (sim.pacing.apply(d)) return { ok: true, note: "pacing" };
  switch (d.tool) {
    case "narrate":
      return { ok: true, note: "shell" };
    case "inject_event":
      return injectEvent(sim, d.kind, clamp(finiteOr(d.strength, 0.5), 0, 1), d.announce);
    case "spawn_boss":
      return sim.spawnBoss(d.announce);
    case "shift_biome": {
      if (!(WEATHERS as readonly string[]).includes(d.weather)) return { ok: false, note: `unknown weather ${d.weather}` };
      sim.theme = {
        weather: d.weather,
        fog: clamp(finiteOr(d.fog, sim.theme.fog), 0, 1),
        tint: hexToInt(d.tint, 0xffffff),
        version: sim.theme.version + 1,
      };
      if (d.announce) sim.out.emit("banner", { text: d.announce, tone: "info" });
      return { ok: true };
    }
    case "mutate_enemies": {
      const arch = findArch(sim, d.archetypeId);
      if (!arch) return { ok: false, note: `unknown archetype "${d.archetypeId}"` };
      if (!(ENEMY_MODIFIERS as readonly string[]).includes(d.addModifier)) return { ok: false, note: `unknown modifier ${d.addModifier}` };
      const had = arch.modifiers.has(d.addModifier);
      arch.modifiers.add(d.addModifier);
      arch.speed = clamp(arch.speed * clamp(finiteOr(d.speedMultiplier, 1), 0.5, 2), 0.2, 4);
      if (d.addModifier === "shielded" && !had) {
        for (const e of sim.enemies) if (e.active && e.arch === arch) e.shield = e.elite ? 3 : 2;
      }
      return { ok: true, note: had ? "modifier already present; speed changed" : undefined };
    }
    case "grant_boon": {
      if (!(BOON_KINDS as readonly string[]).includes(d.kind)) return { ok: false, note: `unknown boon ${d.kind}` };
      if (sim.ended) return { ok: false, note: "run ended" };
      const p = sim.player;
      let text: string = d.kind;
      switch (d.kind) {
        case "heal": {
          const before = p.hp;
          p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.4);
          text = `healed ${Math.round(p.hp - before)} hp`;
          break;
        }
        case "shield":
          p.shieldHits = Math.max(p.shieldHits, 3);
          text = "shield (3 hits)";
          break;
        case "weapon_upgrade":
          text = `weapon upgrade: ${boonWeaponUpgrade(sim.build, sim.rand)}`;
          break;
        case "time_slow":
          sim.timeSlowT = 6;
          text = "time slows";
          break;
        case "magnet":
          for (const g of sim.gems) if (g.active) g.mag = true;
          text = "all gems pulled in";
          break;
      }
      sim.pushFx({ t: "ring", x: p.x, y: p.y, r: 200, color: hexToInt(sim.world.theme.palette.glow) });
      sim.pushFx({ t: "flash", color: hexToInt(sim.world.theme.palette.glow), alpha: 0.25 });
      sim.event("boon", `Boon: ${text}`);
      sim.out.emit("banner", { text: d.announce || `Boon: ${text}`, tone: "boon" });
      return { ok: true };
    }
    default:
      // set_intensity_target / adjust_spawns / set_music are consumed by pacing above.
      return { ok: false, note: `unhandled tool ${(d as { tool: string }).tool}` };
  }
}

function findArch(sim: Sim, id: string): ArchRuntime | undefined {
  const exact = sim.archById.get(id);
  if (exact) return exact;
  const norm = String(id).toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return sim.archetypes.find((a) => a.id === norm || a.name.toLowerCase() === String(id).toLowerCase());
}

function injectEvent(sim: Sim, kind: EventKind, strength: number, announce: string): DirectiveResult {
  if (!(EVENT_KINDS as readonly string[]).includes(kind)) return { ok: false, note: `unknown event ${kind}` };
  if (sim.ended || !sim.player.alive) return { ok: false, note: "run ended" };
  const p = sim.player;
  const view = { viewW: sim.lastView.w, viewH: sim.lastView.h };
  let tone: "info" | "danger" | "boon" = "danger";
  let note: string | undefined;

  switch (kind) {
    case "elite_pack": {
      const n = 3 + Math.round(strength * 4);
      const ring = sim.spawnRingRadius(view);
      const arch = sim.pickArchetype();
      const center = sim.findSpawnPos(ring * 0.7, ring + 100, 40, 20);
      if (!arch || !center) return { ok: false, note: "no room to spawn elite pack" };
      let spawned = 0;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU;
        let x = center.x + Math.cos(a) * 50;
        let y = center.y + Math.sin(a) * 50;
        if (!circleFree(sim.map, x, y, arch.size * 15)) {
          x = center.x;
          y = center.y;
        }
        if (sim.spawnEnemy(arch, x, y, { elite: true, spawnT: 0.6 })) spawned++;
      }
      note = `${spawned} elites`;
      break;
    }
    case "ambush": {
      const n = Math.round(8 + strength * 12);
      let spawned = 0;
      for (let i = 0; i < n; i++) {
        const arch = sim.pickArchetype();
        if (!arch) break;
        const a = (i / n) * TAU + sim.rand() * 0.1;
        for (const rad of [290, 230, 350]) {
          const x = p.x + Math.cos(a) * rad;
          const y = p.y + Math.sin(a) * rad;
          if (circleFree(sim.map, x, y, arch.size * 12) && sim.flow.distanceAt(x, y) >= 0) {
            if (sim.spawnEnemy(arch, x, y, { spawnT: 0.8 })) spawned++;
            break;
          }
        }
      }
      sim.pushFx({ t: "ring", x: p.x, y: p.y, r: 290, color: 0xff3355 });
      note = `${spawned} ambushers`;
      break;
    }
    case "treasure_room": {
      const pos = sim.findSpawnPos(300, 600, 30, 30) ?? sim.findSpawnPos(150, 400, 26, 30);
      if (!pos) return { ok: false, note: "no room for treasure" };
      sim.chests.push({ active: true, x: pos.x, y: pos.y, value: Math.round((25 + 35 * strength) * sim.lastPacing.lootMultiplier), age: 0 });
      tone = "boon";
      break;
    }
    case "healing_shrine": {
      const pos = sim.findSpawnPos(220, 420, 50, 30) ?? sim.findSpawnPos(120, 300, 40, 30);
      if (!pos) return { ok: false, note: "no room for shrine" };
      sim.shrines.push({ active: true, x: pos.x, y: pos.y, r: 90, life: 20, pool: p.maxHp * (0.5 + 0.3 * strength), age: 0 });
      tone = "boon";
      break;
    }
    case "meteor_shower":
      sim.meteor = { t: 7 + strength * 5, every: Math.max(0.2, 0.45 - strength * 0.2), acc: 0, strength };
      break;
    case "blackout":
      sim.blackoutT = 12;
      sim.blackoutMinHp = p.hp / Math.max(1, p.maxHp);
      break;
    case "swarm_tide": {
      const arch = sim.archetypes.find((a) => a.base === "swarmer") ?? swarmArch(sim, hexToInt(sim.world.theme.palette.accent));
      const n = Math.round(18 + strength * 30);
      const a = sim.rand() * TAU;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const D = sim.spawnRingRadius(view) + 60;
      const speed = 190 + strength * 90;
      const span = D * 1.1;
      let spawned = 0;
      for (let i = 0; i < n; i++) {
        const off = (i / Math.max(1, n - 1) - 0.5) * 2 * span + (sim.rand() - 0.5) * 30;
        const back = sim.rand() * 90;
        const x = p.x - dx * (D + back) - dy * off;
        const y = p.y - dy * (D + back) + dx * off;
        const e = sim.spawnEnemy(arch, x, y, { tide: true, spawnT: 0 });
        if (!e) break;
        e.dirX = dx * speed;
        e.dirY = dy * speed;
        e.lifeT = (2 * D + 200) / speed;
        spawned++;
      }
      note = `${spawned} in the tide`;
      break;
    }
    case "mirror_rival": {
      if (sim.rival?.active) return { ok: false, note: "rival already active" };
      const color = hexToInt(sim.world.theme.palette.player);
      const arch: ArchRuntime = {
        id: "__rival",
        name: "Mirror Rival",
        base: "shooter",
        hp: 50 + strength * 90,
        speed: 1.6,
        size: 1.25,
        color,
        modifiers: new Set(),
        weight: 0,
        unlockAct: 0,
        synthetic: true,
      };
      const pos = sim.findSpawnPos(320, 480, 20, 30);
      if (!pos) return { ok: false, note: "no room for rival" };
      const e = sim.spawnEnemy(arch, pos.x, pos.y, { rival: true, spawnT: 1 });
      if (!e) return { ok: false, note: "no free enemy slot" };
      e.cd = 1.5;
      sim.rival = e;
      sim.pushFx({ t: "teleport", x: pos.x, y: pos.y, color });
      break;
    }
  }
  sim.event("event_started", `${kind.replace(/_/g, " ")}${announce ? `: ${announce}` : ""}`);
  sim.out.emit("banner", { text: announce || defaultAnnounce(kind), tone });
  return { ok: true, ...(note ? { note } : {}) };
}

function defaultAnnounce(kind: EventKind): string {
  switch (kind) {
    case "elite_pack":
      return "Elites inbound";
    case "ambush":
      return "Ambush!";
    case "treasure_room":
      return "Treasure detected";
    case "healing_shrine":
      return "A healing shrine appears";
    case "meteor_shower":
      return "Meteor shower!";
    case "blackout":
      return "Blackout";
    case "swarm_tide":
      return "Here comes the tide";
    case "mirror_rival":
      return "Your rival arrives";
  }
}
