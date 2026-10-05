import { ServerMsgSchema, type ClientMsg, type ServerMsg, type Telemetry } from "@bimpee/shared";
import type { RoomStatus } from "../store/run";

/**
 * Thin, validated wrapper around a (reconnecting) WebSocket to a world room.
 * The socket is injected so the logic is testable; production uses
 * PartySocket (see ./index.ts).
 */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "close" | "error" | "message", fn: (ev: any) => void): void;
  removeEventListener(type: "open" | "close" | "error" | "message", fn: (ev: any) => void): void;
}

export type SocketFactory = (roomId: string) => SocketLike;

const OPEN = 1;
const STATE_INTERVAL_MS = 100; // 10Hz

export interface RoomClientOpts {
  roomId: string;
  name: string;
  factory: SocketFactory;
  now?: () => number;
}

export class RoomClient {
  readonly roomId: string;
  private socket: SocketLike;
  private msgHandlers = new Set<(m: ServerMsg) => void>();
  private statusHandlers = new Set<(s: RoomStatus) => void>();
  private _status: RoomStatus = "connecting";
  private _selfId: string | null = null;
  private lastState = 0;
  private closed = false;
  private everOpened = false;
  private readonly now: () => number;
  private name: string;
  /** last welcome received (late subscribers can read it) */
  welcome: Extract<ServerMsg, { type: "welcome" }> | null = null;

  constructor(opts: RoomClientOpts) {
    this.roomId = opts.roomId;
    this.name = opts.name.slice(0, 24) || "Wanderer";
    this.now = opts.now ?? (() => Date.now());
    this.socket = opts.factory(opts.roomId);
    this.socket.addEventListener("open", this.onOpen);
    this.socket.addEventListener("close", this.onClose);
    this.socket.addEventListener("error", this.onError);
    this.socket.addEventListener("message", this.onMessage);
  }

  get status() {
    return this._status;
  }
  get selfId() {
    return this._selfId;
  }
  get connectedOnce() {
    return this.everOpened;
  }

  onMessageType(fn: (m: ServerMsg) => void): () => void {
    this.msgHandlers.add(fn);
    return () => this.msgHandlers.delete(fn);
  }

  onStatus(fn: (s: RoomStatus) => void): () => void {
    this.statusHandlers.add(fn);
    fn(this._status);
    return () => this.statusHandlers.delete(fn);
  }

  /** Position/health for ghosts; throttled to 10Hz. Returns whether it was sent. */
  sendState(s: { x: number; y: number; hp: number; score: number; alive: boolean }): boolean {
    const now = this.now();
    if (now - this.lastState < STATE_INTERVAL_MS) return false;
    this.lastState = now;
    return this.send({
      type: "state",
      x: Math.round(s.x * 10) / 10,
      y: Math.round(s.y * 10) / 10,
      hp: Math.min(1, Math.max(0, s.hp)),
      score: Math.max(0, Math.round(s.score)),
      alive: s.alive,
    });
  }

  sendTelemetry(telemetry: Telemetry): boolean {
    return this.send({ type: "telemetry", telemetry });
  }

  sendEmote(emote: Extract<ClientMsg, { type: "emote" }>["emote"]): boolean {
    return this.send({ type: "emote", emote });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.socket.removeEventListener("open", this.onOpen);
    this.socket.removeEventListener("close", this.onClose);
    this.socket.removeEventListener("error", this.onError);
    this.socket.removeEventListener("message", this.onMessage);
    try {
      this.socket.close(1000, "bye");
    } catch {
      /* ignore */
    }
    this.setStatus("closed");
    this.msgHandlers.clear();
    this.statusHandlers.clear();
  }

  private send(msg: ClientMsg): boolean {
    if (this.closed || this.socket.readyState !== OPEN) return false;
    try {
      this.socket.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  private setStatus(s: RoomStatus) {
    if (s === this._status) return;
    this._status = s;
    for (const h of this.statusHandlers) h(s);
  }

  private onOpen = () => {
    this.everOpened = true;
    this.setStatus("open");
    this.send({ type: "join", name: this.name });
  };

  private onClose = () => {
    if (!this.closed) this.setStatus("reconnecting");
  };

  private onError = () => {
    if (!this.closed && this._status !== "open") this.setStatus("reconnecting");
  };

  private onMessage = (ev: { data: unknown }) => {
    if (typeof ev.data !== "string") return;
    let raw: unknown;
    try {
      raw = JSON.parse(ev.data);
    } catch {
      return;
    }
    const p = ServerMsgSchema.safeParse(raw);
    if (!p.success) return;
    const msg = p.data;
    if (msg.type === "welcome") {
      this._selfId = msg.selfId;
      this.welcome = msg;
    }
    for (const h of this.msgHandlers) h(msg);
  };
}

/** Ghosts are everyone but me. */
export function otherPlayers<T extends { id: string }>(players: T[], selfId: string | null): T[] {
  return selfId ? players.filter((p) => p.id !== selfId) : players;
}

/** Seconds elapsed on the room's shared run clock, clamped so late joiners still get a boss fight. */
export function roomStartOffset(startedAt: number, now: number, runDurationSec: number): number {
  const raw = Math.max(0, (now - startedAt) / 1000);
  return Math.min(raw, Math.max(0, runDurationSec - 45));
}
