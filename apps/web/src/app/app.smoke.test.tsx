// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RunReport } from "@bimpee/shared";
import { Bus, type GameHandle, type GameOptions, type GameToShell, type ShellToGame } from "../game/contract";

/**
 * End-to-end-ish UI flow in jsdom with the backend offline, the Phaser game
 * replaced by a scriptable fake, and audio stubbed.
 */
const games: { opts: GameOptions; handle: GameHandle; destroyed: boolean; received: { k: string; p: unknown }[] }[] = [];

vi.mock("../game", () => ({
  createGame: (_el: HTMLElement, opts: GameOptions): GameHandle => {
    const out = new Bus<GameToShell>();
    const inn = new Bus<ShellToGame>();
    const rec = { opts, handle: null as unknown as GameHandle, destroyed: false, received: [] as { k: string; p: unknown }[] };
    for (const k of ["directives", "pick_upgrade", "ghosts", "pause", "resume", "quit"] as const) {
      inn.on(k, (p: unknown) => rec.received.push({ k, p }));
    }
    rec.handle = {
      out,
      in: inn,
      destroy: () => {
        rec.destroyed = true;
        out.clear();
        inn.clear();
      },
    };
    games.push(rec);
    return rec.handle;
  },
}));

vi.mock("./audio", () => ({
  audio: { unlocked: false, setWorld() {}, setPacing() {}, setBoss() {}, death() {}, victory() {}, sfx() {}, stop() {} },
  preloadAudio: () => Promise.resolve({}),
  unlockAudio: () => Promise.resolve(true),
}));

let root: Root;
let container: HTMLDivElement;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom lacks these; prefer reduced motion so the forge animation is short.
  window.matchMedia = ((q: string) => ({
    matches: q.includes("reduce"),
    media: q,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  globalThis.fetch = (() => Promise.reject(new TypeError("offline"))) as typeof fetch;
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterAll(() => {
  act(() => root?.unmount());
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 4000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting; DOM: ${container.textContent?.slice(0, 400)}`);
    await act(() => sleep(25));
  }
}
const byText = (t: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.toLowerCase().includes(t.toLowerCase()));

describe("app flow (offline)", () => {
  it("title -> forge -> reveal -> play -> results -> play again", async () => {
    const { App } = await import("./App");
    const { appStore } = await import("./store/app");
    const { runStore } = await import("./store/run");
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    // Title
    await waitFor(() => !!byText("Forge world"));
    await waitFor(() => container.textContent!.includes("Offline"));
    expect(container.querySelector("h1")?.getAttribute("aria-label")).toBe("Bimpee");

    // Forge (offline => local world)
    await act(async () => byText("Forge world")!.click());
    expect(appStore.getState().screen).toBe("forge");
    await waitFor(() => appStore.getState().forge?.status === "ready");
    const world = appStore.getState().forge!.forged!.world;
    await waitFor(() => container.textContent!.includes(world.name));
    expect(container.textContent).toContain(world.boss.name);
    expect(container.textContent).toContain("Why this world");
    expect(document.documentElement.style.getPropertyValue("--world-accent")).toBe(world.theme.palette.accent);

    // Play
    await act(async () => byText("Start run")!.click());
    await waitFor(() => games.length === 1);
    const g = games[0]!;
    expect(g.opts.world).toBe(world);
    const runId = g.opts.runId;
    await act(async () => {
      g.handle.out.emit("hud", { t: 12, act: 0, actName: world.arc[0]!.name, hp: 40, maxHp: 100, level: 3, xp: 4, xpToNext: 10, score: 4321, kills: 17, weapon: "blaster", bossHp: null, bossName: null });
      g.handle.out.emit("banner", { text: "Ambush!", tone: "danger" });
      g.handle.out.emit("event", { kind: "boss_spawn", t: 12, text: "boss" });
    });
    expect(container.textContent).toContain("4,321");
    expect(container.textContent).toContain("Ambush!");

    // Telemetry -> local director (offline) -> directives into the game + debug log
    await act(async () => {
      g.handle.out.emit("telemetry", {
        runId,
        t: 15,
        act: 0,
        intensity: 0.1,
        intensityTarget: 0.6,
        phase: "build",
        player: { hpFraction: 0.1, level: 3, weapon: "blaster", accuracy: 0.5, damageTaken: 0.3, kills: 5, nearMisses: 0, idleRatio: 0, score: 4321 },
        enemiesAlive: 3,
        bossActive: false,
        recentEvents: [],
        recentDirectives: [],
        fps: 60,
        players: 1,
      });
    });
    expect(g.received.some((r) => r.k === "directives")).toBe(true);
    expect(runStore.getState().directorLog[0]?.source).toBe("local");

    // Upgrade offer: key "2" picks the second card
    await act(async () => {
      g.handle.out.emit("upgrade_offer", [
        { id: "a", name: "Alpha", description: "x", rarity: "common" },
        { id: "b", name: "Beta", description: "y", rarity: "rare" },
        { id: "c", name: "Gamma", description: "z", rarity: "epic" },
      ]);
    });
    expect(container.textContent).toContain("Level up!");
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "2" }));
    });
    expect(g.received.find((r) => r.k === "pick_upgrade")?.p).toBe("b");
    expect(runStore.getState().upgradeOffer).toBeNull();

    // Esc pauses, debug HUD toggles with backtick
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(g.received.some((r) => r.k === "pause")).toBe(true);
    expect(container.textContent).toContain("Paused");
    await act(async () => byText("Resume")!.click());
    expect(g.received.some((r) => r.k === "resume")).toBe(true);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "`" }));
    });
    await waitFor(() => container.textContent!.includes("AI Director"));

    // Run ends -> results with a local reflection
    const report: RunReport = {
      runId,
      worldName: world.name,
      worldSeed: world.seed,
      biome: world.theme.biome,
      outcome: "death",
      durationSec: 95,
      score: 4321,
      kills: 17,
      level: 3,
      accuracy: 0.4,
      damageTaken: 1.2,
      killedBy: "Glitchling",
      bossDefeated: false,
      highlights: ["survived a blackout"],
      directivesUsed: ["grant_boon"],
      intensityCurve: [0.1, 0.3, 0.5, 0.8, 0.6],
    };
    await act(async () => g.handle.out.emit("run_end", report));
    await waitFor(() => appStore.getState().screen === "results", 5000);
    await waitFor(() => g.destroyed);
    await waitFor(() => !!appStore.getState().results?.reflection);
    await waitFor(() => container.textContent!.includes("You died"));
    expect(container.textContent).toContain("Glitchling");
    expect(container.textContent).toContain("survived a blackout");

    // Play again -> forge for a fresh world
    await act(async () => byText("Play again")!.click());
    await waitFor(() => appStore.getState().screen === "forge");
    await waitFor(() => appStore.getState().forge?.status === "ready");
  }, 20_000);
});
