/**
 * Text-to-3D provider abstraction for Bimpee City landmarks.
 *
 * A provider starts a generation job for a prompt and is polled until the job
 * yields a GLB URL. LandmarkService (./landmarks.ts) owns everything else:
 * caching by prompt hash, quotas, the SSRF-guarded download, GLB validation
 * and storage. Providers must not retry paid calls on their own.
 *
 * Status of real providers:
 * - "meshy": NOT IMPLEMENTED. Meshy's documentation (docs.meshy.ai) could not
 *   be reached from the environment this was written in, and its API is not
 *   guessed here. To add it, implement TextTo3DProvider against the current
 *   official docs (preview mode, low-poly / stylised art style), list the exact
 *   asset host(s) in `assetHosts`, and return it from createTextTo3DProvider.
 *   Until then TEXT_TO_3D_PROVIDER=meshy logs a warning and behaves like
 *   "disabled", so landmarks use their CC0 fallback shapes.
 */

export interface ProviderJobStatus {
  status: "pending" | "succeeded" | "failed";
  /** https URL of the finished binary glTF, when succeeded */
  glbUrl?: string;
}

export interface TextTo3DProvider {
  readonly name: string;
  /** False: never called; /api/city/landmark answers `unavailable` (cached models are still served). */
  readonly enabled: boolean;
  /**
   * Exact hostnames (or parent domains, matched on a dot boundary) the provider
   * serves finished assets from. Download URLs on any other host, over plain
   * http, with credentials or a non-default port are refused (SSRF guard).
   */
  readonly assetHosts: readonly string[];
  /** Starts a (paid) generation job; returns the provider's job id. */
  start(prompt: string, signal?: AbortSignal): Promise<string>;
  poll(jobId: string, signal?: AbortSignal): Promise<ProviderJobStatus>;
}

export class DisabledProvider implements TextTo3DProvider {
  readonly name = "disabled";
  readonly enabled = false;
  readonly assetHosts: readonly string[] = [];
  async start(): Promise<string> {
    throw new Error("text-to-3D generation is disabled");
  }
  async poll(): Promise<ProviderJobStatus> {
    return { status: "failed" };
  }
}

export function createTextTo3DProvider(kind: "meshy" | "disabled", opts: { meshyApiKey?: string; warn?: (msg: string) => void }): TextTo3DProvider {
  if (kind === "meshy") {
    opts.warn?.(
      opts.meshyApiKey
        ? "[landmarks] TEXT_TO_3D_PROVIDER=meshy is not implemented yet (API unverified); landmark generation is disabled"
        : "[landmarks] TEXT_TO_3D_PROVIDER=meshy without MESHY_API_KEY; landmark generation is disabled",
    );
  }
  return new DisabledProvider();
}

/** True when `url` is an https URL on one of `hosts`, without credentials or a custom port. */
export function isAllowedAssetUrl(url: string, hosts: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  return hosts.some((h) => {
    const allowed = h.toLowerCase();
    return host === allowed || host.endsWith(`.${allowed}`);
  });
}
