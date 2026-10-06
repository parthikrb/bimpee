import { CityDirectiveSchema, type CityCommand, type CityDirective, type CouncilMember } from "@bimpee/shared/city";
import type { CitySim } from "./CitySim";
import { MAX_OPEN_MOTIONS, MOTION_DAYS } from "./constants";
import { triggerDisaster } from "./disasters";
import type { CmdResult } from "./grid";
import { clamp, clamp01 } from "./rand";
import { mod } from "./types";

/**
 * Fate's directives, the council's approval of the mayor, and motions.
 */

export function applyDirectiveList(sim: CitySim, list: unknown[]) {
  for (const raw of list.slice(0, 8)) {
    const p = CityDirectiveSchema.safeParse(raw);
    if (!p.success) {
      const tool = raw && typeof raw === "object" && typeof (raw as { tool?: unknown }).tool === "string" ? (raw as { tool: string }).tool : "?";
      pushRecent(sim, `invalid:${tool}`.slice(0, 40));
      continue;
    }
    const note = applyDirective(sim, p.data);
    pushRecent(sim, p.data.tool);
    if (note) sim.recentEvents.push(`fate ${p.data.tool} ignored: ${note}`), sim.recentEvents.length > 10 && sim.recentEvents.shift();
  }
}

function pushRecent(sim: CitySim, s: string) {
  sim.recentDirectives.push(s);
  if (sim.recentDirectives.length > 8) sim.recentDirectives.shift();
}

/** Applies one validated directive; returns a note if it was ignored. */
export function applyDirective(sim: CitySim, d: CityDirective): string | null {
  switch (d.tool) {
    case "trigger_disaster": {
      const r = triggerDisaster(sim, d.kind, d.x, d.y, d.strength, true, d.headline);
      if (r.ok) councilEvent(sim, "disaster");
      return r.ok ? null : r.reason;
    }
    case "economic_event":
      return economicEvent(sim, d.kind, clamp01(d.strength), clamp(d.days, 1, 30), d.headline);
    case "set_weather":
      sim.weather = d.kind;
      sim.weatherDaysLeft = clamp(d.days, 1, 10);
      sim.netDirty = true;
      return null;
    case "council_motion": {
      if (!sim.spec.council.some((m) => m.id === d.memberId)) return "unknown council member";
      if (sim.motions.length >= MAX_OPEN_MOTIONS) return "too many open motions";
      sim.motionCounter++;
      sim.motions.push({
        id: `m${sim.motionCounter}`,
        memberId: d.memberId,
        title: d.title.slice(0, 80),
        pitch: d.pitch.slice(0, 300),
        options: d.options.slice(0, 3).map((o) => ({ label: o.label.slice(0, 48), effect: { ...o.effect } })),
        expiresDay: sim.day + MOTION_DAYS,
      });
      return null;
    }
    case "adjust_demand":
      sim.modifiers.push(mod("demand", { res: clamp(d.residential, 0.5, 2), com: clamp(d.commercial, 0.5, 2), ind: clamp(d.industrial, 0.5, 2), daysLeft: d.days }));
      return null;
    case "visitor":
      return visitor(sim, d.kind, d.headline);
    case "news":
      sim.emit({ kind: "news", headline: d.headline.slice(0, 120), body: d.body.slice(0, 400) });
      return null;
  }
}

function economicEvent(sim: CitySim, kind: string, s: number, days: number, headline: string): string | null {
  switch (kind) {
    case "boom":
      sim.modifiers.push(mod("boom", { strength: s, daysLeft: days, res: 0.2 * s, com: 0.3 * s, ind: 0.3 * s, income: 0.2 * s, happiness: 0.03 * s }));
      break;
    case "recession":
      sim.modifiers.push(mod("recession", { strength: s, daysLeft: days, res: -0.2 * s, com: -0.35 * s, ind: -0.3 * s, income: -0.25 * s, happiness: -0.05 * s }));
      break;
    case "tourism_wave":
      sim.modifiers.push(mod("tourism_wave", { strength: s, daysLeft: days, com: 0.4 * s, income: 0.05 * s, happiness: 0.02 }));
      break;
    case "strike":
      sim.modifiers.push(mod("strike", { strength: s, daysLeft: days, ind: -0.4 * s, income: -0.3 * s, happiness: -0.06 * s }));
      break;
    case "federal_grant":
      sim.funds += Math.round(5000 + 20000 * s);
      break;
    case "tech_startup_rush":
      sim.modifiers.push(mod("tech_startup_rush", { strength: s, daysLeft: days, res: 0.2 * s, com: 0.3 * s, landValue: 0.1 * s, income: 0.08 * s }));
      break;
    default:
      return "unknown economic event";
  }
  sim.emit({ kind: "economy", text: headline || kind.replace(/_/g, " ") });
  return null;
}

function visitor(sim: CitySim, kind: string, headline: string): string | null {
  switch (kind) {
    case "investor":
      sim.funds += 2500;
      sim.modifiers.push(mod("visitor", { ind: 0.15, com: 0.1, daysLeft: 4 }));
      break;
    case "celebrity":
      sim.modifiers.push(mod("visitor", { happiness: 0.05, com: 0.1, daysLeft: 3 }));
      break;
    case "inspector":
      if (sim.pollutionAvg > 0.25) sim.funds -= 1500;
      else sim.funds += 1000;
      break;
    case "tourists":
      sim.modifiers.push(mod("tourists", { strength: 0.5, com: 0.15, income: 0.05, daysLeft: 3 }));
      break;
    case "refugees":
      sim.modifiers.push(mod("visitor", { res: 0.4, happiness: -0.02, daysLeft: 5 }));
      break;
    default:
      return "unknown visitor";
  }
  sim.emit({ kind: "visitor", text: headline || kind });
  return null;
}

// ---- council ---------------------------------------------------------------

type Role = CouncilMember["role"];

function shift(sim: CitySim, role: Role, delta: number) {
  for (const m of sim.spec.council) {
    if (m.role !== role) continue;
    sim.approval[m.id] = clamp((sim.approval[m.id] ?? 0) + delta, -1, 1);
  }
}

/** world events council members react to */
export function councilEvent(sim: CitySim, what: "disaster" | "collapse" | "goal_failed" | "goal_achieved") {
  switch (what) {
    case "disaster":
    case "collapse":
      shift(sim, "rival_mayor", 0.02);
      break;
    case "goal_failed":
      shift(sim, "rival_mayor", 0.05);
      shift(sim, "populist", -0.04);
      break;
    case "goal_achieved":
      for (const m of sim.spec.council) if (m.role !== "rival_mayor") shift(sim, m.role, 0.04);
      shift(sim, "rival_mayor", -0.03);
      break;
  }
}

/** player actions move approval by role */
export function councilReact(sim: CitySim, cmd: CityCommand, r: CmdResult) {
  if (cmd.type === "speed" || cmd.type === "motion_vote") return;
  shift(sim, "rival_mayor", -0.004);
  switch (cmd.type) {
    case "build":
      switch (cmd.kind) {
        case "park":
          shift(sim, "environmentalist", 0.03);
          shift(sim, "historian", 0.02);
          shift(sim, "populist", 0.01);
          break;
        case "power_wind":
        case "power_solar":
          shift(sim, "environmentalist", 0.04);
          shift(sim, "scientist", 0.01);
          break;
        case "power_coal":
          shift(sim, "environmentalist", -0.06);
          shift(sim, "industrialist", 0.03);
          break;
        case "school":
        case "clinic":
          shift(sim, "scientist", 0.03);
          shift(sim, "populist", 0.01);
          break;
        case "fire_station":
          shift(sim, "scientist", 0.03);
          break;
        case "police":
          shift(sim, "populist", 0.01);
          break;
        default:
          break;
      }
      break;
    case "zone":
      if (cmd.zone === "industrial") {
        shift(sim, "industrialist", 0.02);
        shift(sim, "environmentalist", -0.01);
      } else if (cmd.zone === "residential") shift(sim, "populist", 0.01);
      else if (cmd.zone === "commercial") shift(sim, "industrialist", 0.005);
      break;
    case "tax": {
      const delta = r.delta ?? 0;
      if (delta < 0) {
        shift(sim, "populist", Math.min(0.08, -delta * 2));
        shift(sim, "industrialist", Math.min(0.06, -delta * 1.5));
      } else if (delta > 0) {
        shift(sim, "populist", -Math.min(0.1, delta * 2.5));
        shift(sim, "industrialist", -Math.min(0.08, delta * 2));
      }
      break;
    }
    case "landmark":
      shift(sim, "historian", 0.08);
      for (const m of sim.spec.council) if (m.role !== "rival_mayor") shift(sim, m.role, 0.02);
      break;
    case "bulldoze":
      if ((r.count ?? 0) > 20) shift(sim, "historian", -0.02);
      break;
    case "sandbox_disaster":
      shift(sim, "scientist", -0.02);
      shift(sim, "populist", -0.03);
      shift(sim, "rival_mayor", 0.03);
      break;
    default:
      break;
  }
}

/** Daily drift from the state of the city, and motion expiry. */
export function dailyCouncil(sim: CitySim) {
  for (const m of sim.spec.council) {
    let d = 0;
    switch (m.role) {
      case "environmentalist":
        if (sim.pollutionAvg > 0.3) d -= 0.02;
        if (sim.power.greenShare > 0.5) d += 0.01;
        break;
      case "industrialist":
        if (sim.taxRate < 0.08) d += 0.01;
        if (sim.taxRate > 0.13) d -= 0.02;
        if (sim.demand.industrial > 0.3) d -= 0.005;
        break;
      case "scientist":
        for (const b of sim.buildings.values())
          if (b.type === "fire_station" || b.type === "school" || b.type === "clinic") {
            d += 0.004;
            break;
          }
        break;
      case "populist":
        if (sim.happiness > 0.65) d += 0.01;
        if (sim.happiness < 0.4) d -= 0.02;
        if (sim.taxRate > 0.12) d -= 0.02;
        break;
      case "historian":
        break;
      case "rival_mayor":
        if (sim.funds < 0) d += 0.02;
        if (sim.happiness < 0.4) d += 0.01;
        d -= 0.003;
        break;
    }
    const cur = sim.approval[m.id] ?? 0;
    sim.approval[m.id] = clamp(cur * 0.99 + d, -1, 1);
  }
  const day = sim.day;
  for (let k = sim.motions.length - 1; k >= 0; k--) {
    const mo = sim.motions[k]!;
    if (day < mo.expiresDay) continue;
    sim.motions.splice(k, 1);
    if (sim.approval[mo.memberId] !== undefined) sim.approval[mo.memberId] = clamp(sim.approval[mo.memberId]! - 0.1, -1, 1);
    sim.emit({ kind: "news", headline: `Motion lapses: ${mo.title}`, body: "The mayor never answered the council." });
  }
}
