import { describe, expect, it } from "vitest";
import type { PacingOutput } from "@bimpee/shared";
import type { HudState } from "../../game/contract";
import { createRunStore } from "./run";

const pacing = (intensity: number): PacingOutput => ({
  intensity,
  target: 0.5,
  phase: "build",
  spawnPerSec: 1,
  maxAlive: 30,
  eliteChance: 0.05,
  lootMultiplier: 1,
  musicEnergy: 0.5,
  musicTension: 0.3,
});
const hud = (t: number, patch: Partial<HudState> = {}): HudState => ({
  t,
  act: 0,
  actName: "Arrival",
  hp: 100,
  maxHp: 100,
  level: 1,
  xp: 0,
  xpToNext: 10,
  score: 0,
  kills: 0,
  weapon: "blaster",
  bossHp: null,
  bossName: null,
  ...patch,
});

describe("run store", () => {
  it("keeps a ~90s, 2Hz pacing history keyed on the run clock", () => {
    const s = createRunStore();
    for (let i = 0; i <= 200 * 4; i++) {
      s.getState().setHud(hud(i / 4));
      s.getState().pushPacing(pacing(0.5));
    }
    const h = s.getState().history;
    expect(h[h.length - 1]!.t).toBe(200);
    expect(h[0]!.t).toBeGreaterThanOrEqual(110);
    expect(h.length).toBeLessThanOrEqual(182);
  });

  it("resets history if the clock goes backwards", () => {
    const s = createRunStore();
    s.getState().setHud(hud(50));
    s.getState().pushPacing(pacing(0.2));
    s.getState().setHud(hud(1));
    s.getState().pushPacing(pacing(0.3));
    expect(s.getState().history).toEqual([{ t: 1, intensity: 0.3, target: 0.5 }]);
  });

  it("raises an act card on act change and tracks boss max hp", () => {
    const s = createRunStore();
    s.getState().setHud(hud(0), (a) => ({ name: `Act${a}`, beat: "b" }));
    const first = s.getState().actCard;
    expect(first).toMatchObject({ act: 0, name: "Act0" });
    s.getState().setHud(hud(1));
    expect(s.getState().actCard).toBe(first);
    s.getState().setHud(hud(80, { act: 1, actName: "Swell" }));
    expect(s.getState().actCard).toMatchObject({ act: 1, name: "Swell" });
    s.getState().setHud(hud(300, { bossName: "B", bossHp: 900 }));
    s.getState().setHud(hud(301, { bossName: "B", bossHp: 400 }));
    expect(s.getState().bossMaxHp).toBe(900);
    s.getState().setHud(hud(302));
    expect(s.getState().bossMaxHp).toBe(0);
  });

  it("marks the matching pending directive applied/rejected (newest first)", () => {
    const s = createRunStore();
    const d = { tool: "grant_boon" as const, kind: "heal" as const, announce: "pity" };
    const base = { model: "m", latencyMs: 1, reasoning: "", source: "claude" as const };
    s.getState().logDirector({ ...base, t: 1, directives: [{ directive: d, status: "pending" }] });
    s.getState().logDirector({ ...base, t: 2, directives: [{ directive: d, status: "pending" }] });
    s.getState().markDirective(d, false, "on cooldown");
    const [newest, older] = s.getState().directorLog;
    expect(newest!.directives[0]).toMatchObject({ status: "rejected", note: "on cooldown" });
    expect(older!.directives[0]!.status).toBe("pending");
    s.getState().markDirective(d, true);
    expect(s.getState().directorLog[1]!.directives[0]!.status).toBe("ok");
  });

  it("caps banners and emotes", () => {
    const s = createRunStore();
    for (let i = 0; i < 10; i++) s.getState().pushBanner(`b${i}`, "info");
    expect(s.getState().banners.map((b) => b.text)).toEqual(["b7", "b8", "b9"]);
    for (let i = 0; i < 10; i++) s.getState().pushEmote({ name: "x", emote: "gg", self: false });
    expect(s.getState().emotes).toHaveLength(4);
  });

  it("reset clears everything for the next run", () => {
    const s = createRunStore();
    s.getState().pushBanner("x", "info");
    s.getState().setPaused(true);
    s.getState().reset("run_2");
    expect(s.getState()).toMatchObject({ runId: "run_2", banners: [], paused: false, directorLog: [] });
  });
});
