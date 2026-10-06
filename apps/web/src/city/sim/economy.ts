import { BUILD_CATALOG } from "@bimpee/shared/city";
import type { CitySim } from "./CitySim";
import { DEBT_INTEREST, JOB_TAX, RES_TAX, TOURISM_LANDMARK_INCOME } from "./constants";
import { TileKind } from "./protocol";
import { clamp, clamp01, finite } from "./rand";
import { isZonedType } from "./types";

/**
 * Population, jobs, happiness, RCI demand (smoothed, every sim second) and
 * the daily ledger.
 */

export function updateStats(sim: CitySim) {
  let pop = 0;
  let com = 0;
  let ind = 0;
  let resN = 0;
  let svc = 0;
  let pol = 0;
  let outage = 0;
  let damaged = 0;
  let total = 0;
  const s = sim.size;
  for (const b of sim.buildings.values()) {
    total++;
    if (b.damage > 0.05) damaged++;
    if (!isZonedType(b.type)) continue;
    if (b.type === "com") com += b.abandoned ? 0 : b.occupants;
    else if (b.type === "ind") ind += b.abandoned ? 0 : b.occupants;
    else {
      if (!b.abandoned) pop += b.occupants;
      resN++;
      const i = b.y * s + b.x;
      svc +=
        (sim.covFire[i] ? 0.05 : 0) +
        (sim.covPolice[i] ? 0.06 : 0) +
        (sim.covHealth[i] ? 0.06 : 0) +
        (sim.covEdu[i] ? 0.06 : 0) +
        Math.min(2, sim.covPark[i]!) * 0.04;
      pol += Math.min(1, sim.pollution[i]!);
      if (!b.powered || !b.watered) outage++;
    }
  }
  sim.population = Math.round(pop);
  sim.comJobs = Math.round(com);
  sim.indJobs = Math.round(ind);
  const workforce = pop * 0.6;
  const jobs = com + ind;
  sim.unemployment = workforce > 0 ? clamp01((workforce - jobs) / workforce) : 0;

  // modifiers
  let mRes = 0;
  let mCom = 0;
  let mInd = 0;
  let mHappy = 0;
  let multR = 1;
  let multC = 1;
  let multI = 1;
  for (const m of sim.modifiers) {
    if (m.kind === "demand") {
      multR *= m.res;
      multC *= m.com;
      multI *= m.ind;
    } else {
      mRes += m.res;
      mCom += m.com;
      mInd += m.ind;
    }
    mHappy += m.happiness;
  }
  let lmHappy = 0;
  for (const b of sim.buildings.values()) {
    if (b.type !== "landmark" || b.damage >= 1) continue;
    lmHappy += 0.02;
    const lm = sim.spec.landmarks.find((l) => l.id === b.landmarkId);
    if (lm?.effect === "happiness") lmHappy += 0.06;
  }

  // happiness
  const avgSvc = resN ? svc / resN : 0.15;
  const avgPol = resN ? pol / resN : 0;
  const outageFrac = resN ? outage / resN : 0;
  const disasterPenalty = Math.min(0.2, sim.disasters.length * 0.06);
  const target =
    0.5 +
    avgSvc -
    avgPol * 0.35 -
    (sim.taxRate - 0.08) * 2.5 -
    sim.congestion * 0.12 -
    outageFrac * 0.3 -
    sim.unemployment * 0.25 -
    disasterPenalty -
    (total ? (damaged / total) * 0.2 : 0) +
    mHappy +
    Math.min(0.15, lmHappy);
  sim.happiness = clamp01(finite(sim.happiness + (clamp01(target) - sim.happiness) * 0.08, 0.5));

  // demand
  const tax = -(sim.taxRate - 0.07) * 4;
  const r = 0.4 + clamp((jobs - workforce) / (workforce + 80), -1, 1) * 0.7 + (sim.happiness - 0.5) * 0.4 + tax + mRes;
  const c = 0.15 + clamp((pop * 0.3 - com) / (com + 50), -1, 1) * 0.7 + tax + mCom;
  const i = 0.25 + clamp((pop * 0.35 + com * 0.3 - ind) / (ind + 50), -1, 1) * 0.6 + tax + mInd;
  const apply = (v: number, mult: number) => clamp(v > 0 ? v * mult : v / mult, -1, 1);
  const lerp = 0.12;
  sim.demand.residential = finite(sim.demand.residential + (apply(r, multR) - sim.demand.residential) * lerp);
  sim.demand.commercial = finite(sim.demand.commercial + (apply(c, multC) - sim.demand.commercial) * lerp);
  sim.demand.industrial = finite(sim.demand.industrial + (apply(i, multI) - sim.demand.industrial) * lerp);
  sim.congestion = sim.traffic.congestion();

  const ledger = projectLedger(sim);
  sim.incomePerDay = ledger.income;
  sim.expensesPerDay = ledger.expenses;
}

export function projectLedger(sim: CitySim): { income: number; expenses: number } {
  let incomeMult = 1;
  let extra = 0;
  let tourism = 0;
  for (const m of sim.modifiers) {
    incomeMult *= 1 + m.income;
    if (m.kind === "tourism_wave" || m.kind === "tourists") tourism += m.strength;
  }
  let upkeep = 0;
  let roads = 0;
  for (let k = 0; k < sim.n; k++) if (sim.kind[k] === TileKind.Road) roads += sim.terrainWater[k] ? 3 : 1;
  for (const b of sim.buildings.values()) {
    if (isZonedType(b.type)) continue;
    if (b.type === "landmark") {
      upkeep += b.cost * 0.002;
      const lm = sim.spec.landmarks.find((l) => l.id === b.landmarkId);
      if (lm?.effect === "tourism" && b.damage < 1) extra += TOURISM_LANDMARK_INCOME * (1 + tourism);
      continue;
    }
    upkeep += BUILD_CATALOG[b.type]?.upkeep ?? 0;
  }
  if (tourism > 0) extra += sim.comJobs * 2 * tourism;
  upkeep += roads * BUILD_CATALOG.road.upkeep;
  upkeep *= 0.8 + 0.4 * clamp01(sim.spec.economy.difficulty);
  if (sim.funds < 0) upkeep += -sim.funds * DEBT_INTEREST;
  const income = sim.taxRate * (sim.population * RES_TAX + (sim.comJobs + sim.indJobs) * JOB_TAX) * incomeMult + extra;
  return { income: Math.round(finite(income)), expenses: Math.round(finite(upkeep)) };
}

/** Called at each day rollover. */
export function dailyEconomy(sim: CitySim) {
  const { income, expenses } = projectLedger(sim);
  sim.incomePerDay = income;
  sim.expensesPerDay = expenses;
  const before = sim.funds;
  sim.funds = Math.round(finite(sim.funds + income - expenses, before));
  if (before >= 0 && sim.funds < 0) sim.emit({ kind: "economy", text: `${sim.spec.name} slips into debt` });
  if (before < 0 && sim.funds >= 0) sim.emit({ kind: "economy", text: `${sim.spec.name} is back in the black` });
  // modifiers count down
  for (const m of sim.modifiers) m.daysLeft--;
  const expired = sim.modifiers.filter((m) => m.daysLeft <= 0);
  if (expired.length) {
    sim.modifiers = sim.modifiers.filter((m) => m.daysLeft > 0);
    for (const m of expired)
      if (m.kind !== "motion" && m.kind !== "demand" && m.kind !== "visitor" && m.kind !== "tourists")
        sim.emit({ kind: "economy", text: `the ${m.kind.replace(/_/g, " ")} is over` });
  }
}
