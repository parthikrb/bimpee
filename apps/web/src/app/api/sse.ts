import { z } from "zod";
import type { NarrateChunk } from "@bimpee/shared";

export const NarrateChunkSchema: z.ZodType<NarrateChunk> = z.union([
  z.object({ text: z.string() }),
  z.object({ done: z.literal(true) }),
  z.object({ error: z.string() }),
]);

function parseChunk(raw: string): NarrateChunk | null {
  try {
    const p = NarrateChunkSchema.safeParse(JSON.parse(raw));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

/**
 * Incremental Server-Sent-Events parser. Feed it decoded text; it yields the
 * `data:` payload of each complete event. Multi-line `data:` fields are
 * joined with "\n" as per the SSE spec. Comments (":") and other fields
 * (event/id/retry) are ignored.
 */
export class SseParser {
  private buf = "";
  private data: string[] = [];

  push(text: string): string[] {
    this.buf += text;
    const out: string[] = [];
    let nl: number;
    while ((nl = this.buf.search(/\r\n|\r|\n/)) !== -1) {
      const line = this.buf.slice(0, nl);
      const sepLen = this.buf.startsWith("\r\n", nl) ? 2 : 1;
      // A lone trailing "\r" might be the first half of "\r\n": wait for more.
      if (this.buf[nl] === "\r" && nl + 1 === this.buf.length) break;
      this.buf = this.buf.slice(nl + sepLen);
      this.line(line, out);
    }
    return out;
  }

  /** Flush at end of stream (dispatches a final event without trailing blank line). */
  end(): string[] {
    const out: string[] = [];
    if (this.buf) {
      this.line(this.buf, out);
      this.buf = "";
    }
    this.flush(out);
    return out;
  }

  private line(line: string, out: string[]) {
    if (line === "") return this.flush(out);
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
  }

  private flush(out: string[]) {
    if (this.data.length) out.push(this.data.join("\n"));
    this.data = [];
  }
}

/** Turns one SSE event payload into chunks; tolerates servers that put several JSON objects in one event. */
export function payloadToChunks(payload: string): NarrateChunk[] {
  const whole = parseChunk(payload);
  if (whole) return [whole];
  return payload
    .split("\n")
    .map((l) => parseChunk(l.trim()))
    .filter((c): c is NarrateChunk => c !== null);
}

/** Reads a fetch body stream as NarrateChunks. Stops after {done:true}. */
export async function* readNarrateStream(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<NarrateChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      const payloads = done ? [...parser.push(decoder.decode()), ...parser.end()] : parser.push(decoder.decode(value, { stream: true }));
      for (const p of payloads) {
        for (const c of payloadToChunks(p)) {
          yield c;
          if ("done" in c) return;
        }
      }
      if (done) return;
    }
  } finally {
    try {
      await reader.cancel();
      reader.releaseLock();
    } catch {
      /* already closed / released */
    }
  }
}
