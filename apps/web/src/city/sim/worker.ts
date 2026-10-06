/**
 * Web Worker entry for the city simulation (loaded by client.ts as a module
 * worker). All logic lives in SimHost; this file only binds Worker globals.
 */
import { FRAME_MS, SimHost } from "./host";
import type { FromSim, ToSim } from "./protocol";

interface WorkerScope {
  postMessage(msg: unknown, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToSim>) => void) | null;
  close(): void;
}
const scope = self as unknown as WorkerScope;
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

const host = new SimHost((msg: FromSim, transfer?: Transferable[]) => scope.postMessage(msg, transfer ?? []));
let timer: ReturnType<typeof setInterval> | null = null;

scope.onmessage = (e: MessageEvent<ToSim>) => {
  const msg = e.data;
  try {
    host.handle(msg, now());
    if (msg?.type === "init" && host.sim && !timer) timer = setInterval(() => host.pump(now()), FRAME_MS);
    if (msg?.type === "dispose") {
      if (timer) clearInterval(timer);
      timer = null;
      scope.close();
    }
  } catch (err) {
    scope.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) } satisfies FromSim, []);
  }
};
