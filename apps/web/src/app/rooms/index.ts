import { RoomClient, type SocketLike } from "./roomClient";

/**
 * Process-wide room connection. A room is joined on the forge screen (the
 * welcome carries the shared world) and kept through the run.
 */
let current: RoomClient | null = null;
let seq = 0;

function partyHost(): { host: string; protocol: "ws" | "wss" } {
  const explicit = import.meta.env.VITE_PARTY_HOST?.trim();
  const apiBase = import.meta.env.VITE_API_BASE?.trim();
  const secure = typeof location !== "undefined" && location.protocol === "https:";
  if (explicit) {
    const isSecure = explicit.startsWith("wss://") || explicit.startsWith("https://") || (!explicit.includes("://") && secure);
    return { host: explicit.replace(/^\w+:\/\//, "").replace(/\/+$/, ""), protocol: isSecure ? "wss" : "ws" };
  }
  if (apiBase) {
    try {
      const u = new URL(apiBase);
      return { host: u.host, protocol: u.protocol === "https:" ? "wss" : "ws" };
    } catch {
      /* fall through */
    }
  }
  return { host: location.host, protocol: secure ? "wss" : "ws" };
}

/** Connects (replacing any previous room). Resolves null if the party module fails to load. */
export async function connectRoom(roomId: string, name: string): Promise<RoomClient | null> {
  leaveRoom();
  const mySeq = ++seq;
  let PartySocket: typeof import("partysocket").PartySocket;
  try {
    ({ PartySocket } = await import("partysocket"));
  } catch {
    return null;
  }
  if (mySeq !== seq) return null; // superseded while loading
  const { host, protocol } = partyHost();
  current = new RoomClient({
    roomId,
    name,
    factory: (room) =>
      new PartySocket({
        host,
        protocol,
        party: "world-room",
        room,
        maxReconnectionDelay: 8_000,
        minReconnectionDelay: 500,
        connectionTimeout: 5_000,
      }) as unknown as SocketLike,
  });
  return current;
}

export function currentRoom(): RoomClient | null {
  return current;
}

export function leaveRoom(): void {
  seq++;
  current?.close();
  current = null;
}

export { RoomClient };
