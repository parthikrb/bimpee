import { CitySim } from "./CitySim";
import type { FromSim, ToSim } from "./protocol";

/**
 * The worker's brain, separated from Worker globals so it can be tested in
 * node: owns the clock (call pump(nowMs) on a ~10 Hz timer), turns sim
 * output into protocol messages, and never throws (errors become
 * {type:"error"}).
 */
export type Post = (msg: FromSim, transfer?: Transferable[]) => void;

export const FRAME_MS = 100;
export const HUD_MS = 250;
/** longest wall-clock gap one pump may simulate (throttled tabs) */
export const MAX_GAP_MS = 1000;

export class SimHost {
  sim: CitySim | null = null;
  private last = -1;
  private lastHud = -1e9;
  disposed = false;

  constructor(private post: Post) {}

  handle(msg: ToSim, now: number) {
    if (this.disposed) return;
    try {
      switch (msg.type) {
        case "init": {
          this.sim = new CitySim(msg.spec, msg.cityId, msg.save);
          this.last = now;
          const terrain = this.sim.getTerrainMsg();
          this.post(terrain, [terrain.heights.buffer, terrain.forest.buffer]);
          this.postTiles(true);
          this.post({ type: "hud", hud: this.sim.getHud() });
          const tel = this.sim.drainTelemetry();
          if (tel) this.post({ type: "telemetry", telemetry: tel });
          this.post({ type: "ready" });
          return;
        }
        case "command": {
          const sim = this.need();
          const r = sim.command(msg.command);
          this.post({ type: "command_result", ok: r.ok, reason: r.reason, cost: r.cost, command: msg.command });
          if (r.ok) {
            this.postTiles(false);
            this.post({ type: "hud", hud: sim.getHud() });
          }
          return;
        }
        case "directives":
          this.need().applyDirectives(Array.isArray(msg.directives) ? msg.directives : []);
          return;
        case "pause":
          this.need().paused = true;
          return;
        case "resume":
          this.need().paused = false;
          this.last = now; // no catch-up for the paused span
          return;
        case "serialize":
          this.post({ type: "serialized", reqId: msg.reqId, data: this.need().serialize() });
          return;
        case "dispose":
          this.disposed = true;
          this.sim = null;
          return;
        default:
          return;
      }
    } catch (err) {
      this.post({ type: "error", message: errMsg(err) });
    }
  }

  /** advance the clock to `now` (ms) and emit due messages */
  pump(now: number) {
    const sim = this.sim;
    if (!sim || this.disposed) return;
    try {
      if (this.last < 0) this.last = now;
      const gap = Math.min(MAX_GAP_MS, Math.max(0, now - this.last));
      this.last = now;
      sim.step(gap / 1000);
      const terrain = sim.drainTerrain();
      if (terrain) this.post(terrain, [terrain.heights.buffer, terrain.forest.buffer]);
      this.postTiles(false);
      const frame = sim.drainFrame();
      this.post(frame, [frame.cars.buffer]);
      if (now - this.lastHud >= HUD_MS) {
        this.lastHud = now;
        this.post({ type: "hud", hud: sim.getHud() });
      }
      const tel = sim.drainTelemetry();
      if (tel) this.post({ type: "telemetry", telemetry: tel });
    } catch (err) {
      this.post({ type: "error", message: errMsg(err) });
    }
  }

  private postTiles(force: boolean) {
    const sim = this.need();
    const t = force ? sim.getTilesMsg() : sim.drainTiles();
    if (!t) return;
    this.post(t, [t.kind.buffer, t.zone.buffer, t.flags.buffer, t.roads.buffer, t.building.buffer, t.pollution.buffer, t.landValue.buffer]);
  }

  private need(): CitySim {
    if (!this.sim) throw new Error("simulation not initialised");
    return this.sim;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
