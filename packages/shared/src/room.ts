import { z } from "zod";
import { DirectiveSchema, TelemetrySchema } from "./director";
import { WorldSpecSchema } from "./world";

/**
 * Shared-world rooms (one Durable Object per room, via partyserver).
 * Players run their own simulation of the same world (same seed and spec).
 * The room relays positions as ghosts and runs ONE director for everyone, so
 * events, bosses and narration hit the whole group at the same moment.
 */
export const EMOTES = ["gg", "help", "boss!", "nice", "lol", "follow"] as const;

export const ClientMsgSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("join"), name: z.string().min(1).max(24) }),
  z.object({
    type: z.literal("state"),
    x: z.number(),
    y: z.number(),
    hp: z.number().min(0).max(1),
    score: z.number().int().min(0),
    alive: z.boolean(),
  }),
  z.object({ type: z.literal("telemetry"), telemetry: TelemetrySchema }),
  z.object({ type: z.literal("emote"), emote: z.enum(EMOTES) }),
]);
export type ClientMsg = z.infer<typeof ClientMsgSchema>;

export const RoomPlayerSchema = z.object({
  id: z.string(),
  name: z.string(),
  x: z.number(),
  y: z.number(),
  hp: z.number(),
  score: z.number(),
  alive: z.boolean(),
});
export type RoomPlayer = z.infer<typeof RoomPlayerSchema>;

export const ServerMsgSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("welcome"),
    selfId: z.string(),
    world: WorldSpecSchema,
    startedAt: z.number().describe("epoch ms when the room's run clock started"),
    players: z.array(RoomPlayerSchema),
  }),
  z.object({ type: z.literal("players"), players: z.array(RoomPlayerSchema) }),
  z.object({
    type: z.literal("directives"),
    directives: z.array(DirectiveSchema),
    reasoning: z.string(),
    model: z.string(),
  }),
  z.object({ type: z.literal("emote"), from: z.string(), name: z.string(), emote: z.enum(EMOTES) }),
  z.object({ type: z.literal("left"), id: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerMsg = z.infer<typeof ServerMsgSchema>;

/** Room ids: 3-24 chars, lowercase letters, digits and dashes. `daily-YYYY-MM-DD` is the public daily room. */
export const ROOM_ID_RE = /^[a-z0-9-]{3,24}$/;
export const dailyRoomId = (d = new Date()) => `daily-${d.toISOString().slice(0, 10)}`;
