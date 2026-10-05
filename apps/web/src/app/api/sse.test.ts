import { describe, expect, it } from "vitest";
import { payloadToChunks, readNarrateStream, SseParser } from "./sse";

function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      c.close();
    },
  });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("SseParser", () => {
  it("emits one payload per event, across arbitrary chunk boundaries", () => {
    const p = new SseParser();
    expect(p.push('data: {"te')).toEqual([]);
    expect(p.push('xt":"hi"}\n')).toEqual([]);
    expect(p.push("\n")).toEqual(['{"text":"hi"}']);
  });

  it("handles CRLF, a CR split across chunks, comments and other fields", () => {
    const p = new SseParser();
    const out = [...p.push(": keepalive\r\nevent: msg\r\nid: 1\r\ndata: a\r"), ...p.push("\n\r\n")];
    expect(out).toEqual(["a"]);
  });

  it("joins multi-line data with newlines and strips one leading space only", () => {
    const p = new SseParser();
    expect(p.push("data:  x\ndata:y\n\n")).toEqual([" x\ny"]);
  });

  it("flushes a trailing event without a blank line on end()", () => {
    const p = new SseParser();
    expect(p.push('data: {"done":true}')).toEqual([]);
    expect(p.end()).toEqual(['{"done":true}']);
  });
});

describe("payloadToChunks", () => {
  it("validates chunk shapes", () => {
    expect(payloadToChunks('{"text":"a"}')).toEqual([{ text: "a" }]);
    expect(payloadToChunks('{"done":true}')).toEqual([{ done: true }]);
    expect(payloadToChunks('{"error":"boom"}')).toEqual([{ error: "boom" }]);
    expect(payloadToChunks('{"text":5}')).toEqual([]);
    expect(payloadToChunks("not json")).toEqual([]);
  });

  it("tolerates several JSON objects in one event", () => {
    expect(payloadToChunks('{"text":"a"}\n{"text":"b"}')).toEqual([{ text: "a" }, { text: "b" }]);
  });
});

describe("readNarrateStream", () => {
  it("yields chunks and stops at done", async () => {
    const body = streamOf(['data: {"text":"Hel"}\n\ndata: {"te', 'xt":"lo"}\n\n', 'data: {"done":true}\n\n', 'data: {"text":"ignored"}\n\n']);
    expect(await collect(readNarrateStream(body))).toEqual([{ text: "Hel" }, { text: "lo" }, { done: true }]);
  });

  it("ends cleanly when the stream closes without done", async () => {
    const body = streamOf(['data: {"text":"x"}']);
    expect(await collect(readNarrateStream(body))).toEqual([{ text: "x" }]);
  });
});
