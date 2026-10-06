import type { LandmarkModelResponse } from "@bimpee/shared/city";
import { cleanText } from "../ai/untrusted";
import { errMsg, log } from "../config";
import { startOfUtcDay, type CityRepo, type LandmarkMetaStore, type LandmarkRecord } from "../memory/types";
import { parseCityMeta } from "../memory/city";
import type { BlobStore } from "./blobs";
import { isAllowedAssetUrl, type TextTo3DProvider } from "./textTo3d";

export const GLB_CONTENT_TYPE = "model/gltf-binary";
export const MAX_GLB_BYTES = 15 * 1024 * 1024;
export const HASH_RE = /^[0-9a-f]{64}$/;

const POLL_RETRY_MS = 5_000;
/** Don't hit the provider more often than this per job, however often clients poll. */
const MIN_POLL_INTERVAL_MS = 3_000;
/** A job still pending after this is abandoned. */
const JOB_TTL_MS = 20 * 60_000;
/** A failed prompt may be retried (paid again) after this. */
const FAILED_RETRY_MS = 6 * 60 * 60_000;
const PROVIDER_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 25_000;

export class LandmarkQuotaError extends Error {
  constructor() {
    super("landmark generation limit reached for today");
  }
}

/** Prompt normalisation for the cache key: NFKC, cleaned, lower-case, single spaces. */
export function normalizePrompt(prompt: string): string {
  return cleanText(prompt.normalize("NFKC"), 300).toLowerCase();
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const modelKey = (hash: string) => `models/${hash}.glb`;
export const modelUrl = (hash: string) => `/api/city/models/${hash}`;

/** Binary glTF 2.0 check: "glTF" magic, version 2, header length matching, ≤ 15 MB. */
export function isValidGlb(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 20 || bytes.byteLength > MAX_GLB_BYTES) return false;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return v.getUint32(0, true) === 0x46546c67 && v.getUint32(4, true) === 2 && v.getUint32(8, true) === bytes.byteLength;
}

/**
 * Downloads a finished model from the provider. Only https URLs on the
 * provider's asset hosts, no redirects (a redirect could point anywhere),
 * bounded size and time.
 */
export async function downloadGlb(url: string, hosts: readonly string[], fetchImpl: typeof fetch): Promise<Uint8Array | null> {
  if (!isAllowedAssetUrl(url, hosts)) {
    log.warn("[landmarks] refused model URL outside the provider's asset hosts");
    return null;
  }
  const res = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (res.status !== 200 || !res.body) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_GLB_BYTES) {
    await res.body.cancel().catch(() => {});
    return null;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_GLB_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

/** Per-user daily quota of new generations, kept in the user's city_meta document. */
export function repoQuota(repo: CityRepo, limit: number, now: () => Date = () => new Date()) {
  return async (userId: string): Promise<boolean> => {
    const meta = parseCityMeta(await repo.getGameMemory(userId, "city_meta"));
    const day = now().toISOString().slice(0, 10);
    const used = meta.landmarkDay === day ? meta.landmarkCount : 0;
    if (used >= limit) return false;
    await repo.saveGameMemory(userId, "city_meta", { ...meta, landmarkDay: day, landmarkCount: used + 1 });
    return true;
  };
}

/** Landmark metadata stored as small JSON objects next to the models (dev/R2 without Supabase). */
export class BlobMetaStore implements LandmarkMetaStore {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly fallback: LandmarkMetaStore,
  ) {}
  async getLandmark(hash: string): Promise<LandmarkRecord | null> {
    const obj = await this.bucket.get(`meta/${hash}.json`);
    if (!obj) return null;
    try {
      return (await obj.json()) as LandmarkRecord;
    } catch {
      return null;
    }
  }
  async putLandmark(r: LandmarkRecord): Promise<void> {
    await this.bucket.put(`meta/${r.hash}.json`, JSON.stringify(r), { httpMetadata: { contentType: "application/json" } });
    await this.fallback.putLandmark(r); // keeps the in-isolate global counter roughly right
  }
  countLandmarksSince(since: Date): Promise<number> {
    return this.fallback.countLandmarksSince(since);
  }
}

export interface LandmarkServiceDeps {
  provider: TextTo3DProvider;
  meta: LandmarkMetaStore;
  /** null: no storage available (production without R2) -> generation unavailable */
  blobs: BlobStore | null;
  /** Consumes one new generation from the user's daily quota; false when exhausted. */
  consumeQuota: (userId: string) => Promise<boolean>;
  globalDailyLimit: number;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Landmark model cache in front of a text-to-3D provider. Cache key is the
 * sha256 of the normalised prompt; cached prompts are free, new ones cost one
 * unit of the user's daily quota (and count toward a global daily cap). Each
 * request advances a pending job by at most one provider poll; there are no
 * internal retry loops.
 */
export class LandmarkService {
  private readonly inflight = new Map<string, Promise<LandmarkModelResponse>>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly d: LandmarkServiceDeps) {
    this.fetchImpl = d.fetch ?? ((...a) => fetch(...a));
    this.now = d.now ?? Date.now;
  }

  get blobs() {
    return this.d.blobs;
  }

  /** Throws LandmarkQuotaError when a new generation would exceed the user's quota. */
  async request(userId: string, prompt: string): Promise<LandmarkModelResponse> {
    const norm = normalizePrompt(prompt);
    if (norm.length < 3) return unavailable();
    const hash = await sha256Hex(norm);
    // One evaluation per hash at a time in this isolate: concurrent requests share it.
    // A quota error belongs to whoever started the evaluation, not to requests sharing it.
    const running = this.inflight.get(hash);
    if (running) return running.catch((e: unknown) => (e instanceof LandmarkQuotaError ? pending() : Promise.reject(e)));
    const p = this.evaluate(userId, norm, hash).finally(() => this.inflight.delete(hash));
    this.inflight.set(hash, p);
    return p;
  }

  private async evaluate(userId: string, prompt: string, hash: string): Promise<LandmarkModelResponse> {
    const { provider, meta, blobs } = this.d;
    let rec = await meta.getLandmark(hash);
    if (rec?.status === "ready" && rec.r2Key && blobs && (await blobs.has(rec.r2Key))) return ready(hash);
    if (!provider.enabled || !blobs) return unavailable();
    if (rec?.status === "pending" && rec.providerJob) return this.advance(rec);
    if (rec?.status === "failed" && this.now() - Date.parse(rec.updatedAt) < FAILED_RETRY_MS) return unavailable();

    // New (paid) generation.
    const today = startOfUtcDay(new Date(this.now()));
    if ((await meta.countLandmarksSince(today)) >= this.d.globalDailyLimit) {
      log.warn("[landmarks] global daily generation cap reached");
      return unavailable();
    }
    if (!(await this.d.consumeQuota(userId))) throw new LandmarkQuotaError();
    const at = new Date(this.now()).toISOString();
    rec = { hash, prompt, status: "pending", providerJob: null, r2Key: null, createdAt: at, updatedAt: at };
    try {
      rec.providerJob = await provider.start(prompt, AbortSignal.timeout(PROVIDER_TIMEOUT_MS));
    } catch (e) {
      log.error(`[landmarks] ${provider.name} start failed: ${errMsg(e)}`);
      await meta.putLandmark({ ...rec, status: "failed" });
      return unavailable();
    }
    await meta.putLandmark(rec);
    return pending();
  }

  private async advance(rec: LandmarkRecord): Promise<LandmarkModelResponse> {
    const { provider, meta, blobs } = this.d;
    const now = this.now();
    const touch = (r: Partial<LandmarkRecord>) => meta.putLandmark({ ...rec, ...r, updatedAt: new Date(now).toISOString() });
    if (now - Date.parse(rec.createdAt) > JOB_TTL_MS) {
      await touch({ status: "failed" });
      return unavailable();
    }
    if (now - Date.parse(rec.updatedAt) < MIN_POLL_INTERVAL_MS) return pending();
    let job;
    try {
      job = await provider.poll(rec.providerJob!, AbortSignal.timeout(PROVIDER_TIMEOUT_MS));
    } catch (e) {
      log.warn(`[landmarks] ${provider.name} poll failed: ${errMsg(e)}`);
      await touch({});
      return pending();
    }
    if (job.status === "pending") {
      await touch({});
      return pending();
    }
    if (job.status === "succeeded" && job.glbUrl && blobs) {
      let bytes: Uint8Array | null = null;
      try {
        bytes = await downloadGlb(job.glbUrl, provider.assetHosts, this.fetchImpl);
      } catch (e) {
        log.warn(`[landmarks] model download failed: ${errMsg(e)}`);
      }
      if (bytes && isValidGlb(bytes)) {
        const key = modelKey(rec.hash);
        await blobs.put(key, bytes, GLB_CONTENT_TYPE);
        await touch({ status: "ready", r2Key: key });
        return ready(rec.hash);
      }
      log.warn("[landmarks] provider returned an invalid or unreachable GLB");
    }
    await touch({ status: "failed" });
    return unavailable();
  }
}

const ready = (hash: string): LandmarkModelResponse => ({ status: "ready", url: modelUrl(hash), retryMs: null });
const pending = (): LandmarkModelResponse => ({ status: "pending", url: null, retryMs: POLL_RETRY_MS });
const unavailable = (): LandmarkModelResponse => ({ status: "unavailable", url: null, retryMs: null });
