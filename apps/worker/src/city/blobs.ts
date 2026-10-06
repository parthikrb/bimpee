/** Binary storage for generated landmark models (R2 in production, memory in dev). */
export interface BlobStore {
  readonly persistent: boolean;
  has(key: string): Promise<boolean>;
  get(key: string): Promise<{ body: ReadableStream | Uint8Array<ArrayBuffer>; size: number } | null>;
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
}

export class R2BlobStore implements BlobStore {
  readonly persistent = true;
  constructor(private readonly bucket: R2Bucket) {}
  async has(key: string) {
    return (await this.bucket.head(key)) !== null;
  }
  async get(key: string) {
    const obj = await this.bucket.get(key);
    return obj ? { body: obj.body, size: obj.size } : null;
  }
  async put(key: string, data: Uint8Array, contentType: string) {
    await this.bucket.put(key, data, { httpMetadata: { contentType } });
  }
}

/** Per-isolate store for `wrangler dev` without an R2 binding. Bounded by total bytes (oldest evicted). */
export class MemoryBlobStore implements BlobStore {
  readonly persistent = false;
  private items = new Map<string, Uint8Array>();
  private total = 0;
  constructor(private readonly maxBytes = 64 * 1024 * 1024) {}
  async has(key: string) {
    return this.items.has(key);
  }
  async get(key: string) {
    const v = this.items.get(key);
    return v ? { body: v.slice(), size: v.byteLength } : null;
  }
  async put(key: string, data: Uint8Array) {
    const prev = this.items.get(key);
    if (prev) {
      this.total -= prev.byteLength;
      this.items.delete(key);
    }
    while (this.total + data.byteLength > this.maxBytes && this.items.size) {
      const [k, v] = this.items.entries().next().value!;
      this.items.delete(k);
      this.total -= v.byteLength;
    }
    this.items.set(key, data.slice());
    this.total += data.byteLength;
  }
}
