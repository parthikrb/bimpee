import { generateFallbackWorld, type DirectorResponse, type Telemetry } from "@bimpee/shared";

export const world = generateFallbackWorld(7);

export function telemetry(runId = "run_a", t = 15, patch: Partial<Telemetry> = {}): Telemetry {
  return {
    runId,
    t,
    act: 0,
    intensity: 0.4,
    intensityTarget: 0.5,
    phase: "build",
    player: { hpFraction: 0.8, level: 2, weapon: "blaster", accuracy: 0.5, damageTaken: 0.1, kills: 4, nearMisses: 1, idleRatio: 0.1, score: 1200 },
    enemiesAlive: 12,
    bossActive: false,
    recentEvents: [],
    recentDirectives: [],
    fps: 60,
    players: 1,
    ...patch,
  };
}

export const remoteResponse: DirectorResponse = {
  directives: [{ tool: "narrate", line: "Hello", mood: "tease" }],
  reasoning: "because",
  model: "claude-test",
  latencyMs: 800,
};

export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
