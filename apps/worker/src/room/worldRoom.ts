import { Server, type Connection, type WSMessage } from "partyserver";
import type { Env } from "../config";
import { getDeps } from "../deps";
import { RoomCore } from "./core";

/**
 * Thin partyserver adapter around RoomCore. Non-hibernating (the default),
 * so the in-memory room state and intervals live as long as anyone is
 * connected; when the last player leaves, RoomCore resets itself.
 */
export class WorldRoom extends Server<Env> {
  private core: RoomCore | null = null;

  private getCore(): RoomCore {
    if (!this.core) {
      const deps = getDeps(this.env);
      const roomId = this.name;
      this.core = new RoomCore(roomId, {
        ai: deps.ai,
        allowAi: deps.limiter ? () => deps.limiter!.limit(`room:${roomId}`) : undefined,
      });
    }
    return this.core;
  }

  override onConnect(connection: Connection) {
    this.getCore().connect(connection);
  }

  override async onMessage(connection: Connection, message: WSMessage) {
    await this.getCore().message(connection.id, typeof message === "string" ? message : null, connection);
  }

  override onClose(connection: Connection) {
    this.getCore().disconnect(connection.id, connection);
  }

  override onError(connection: Connection, error: unknown) {
    console.error(`[room] connection error: ${error instanceof Error ? error.message : String(error)}`);
    this.getCore().disconnect(connection.id, connection);
  }
}
