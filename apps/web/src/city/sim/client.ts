import type { FromSim, ToSim } from "./protocol";

/** Main-thread handle to the city simulation worker (./worker.ts). */
export interface SimClient {
  send(msg: ToSim, transfer?: Transferable[]): void;
  /** returns an unsubscribe function */
  on(handler: (msg: FromSim) => void): () => void;
  destroy(): void;
}

export function createSimClient(): SimClient {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "bimpee-city-sim" });
  const handlers = new Set<(msg: FromSim) => void>();
  worker.onmessage = (e: MessageEvent<FromSim>) => handlers.forEach((h) => h(e.data));
  worker.onerror = (e) => handlers.forEach((h) => h({ type: "error", message: e.message || "simulation worker crashed" }));
  let destroyed = false;
  return {
    send(msg, transfer) {
      if (!destroyed) worker.postMessage(msg, transfer ?? []);
    },
    on(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      worker.postMessage({ type: "dispose" } satisfies ToSim);
      handlers.clear();
      worker.terminate();
    },
  };
}
