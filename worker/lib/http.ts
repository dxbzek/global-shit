/**
 * Single outbound HTTP path for every source.
 *
 * Centralised so timeouts, the user agent, edge caching and error shaping are
 * identical everywhere, and so the dev bridge below has one place to hook.
 */

export const USER_AGENT = 'WorldPulse/1.0 (+https://github.com/dxbzek/global-shit)';

export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Seconds Cloudflare's edge may serve this response from cache. */
  cacheTtl?: number;
  /**
   * Set only in local development. `workerd` resolves DNS itself and ignores
   * any HTTP proxy, so in a sandboxed container every upstream fetch fails.
   * When FETCH_BRIDGE is set, requests are routed through a small local
   * proxy-aware relay (scripts/dev-fetch-bridge.mjs) instead.
   *
   * It is never set in production: `wrangler secret` is not involved, and
   * wrangler.toml does not define it.
   */
  bridge?: string | undefined;
}

export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Fetches a URL, returning the body as text. Throws HttpError on failure. */
export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const { timeoutMs = 12_000, cacheTtl = 120, headers = {}, bridge } = options;

  const target = bridge ? `${bridge}?url=${encodeURIComponent(url)}` : url;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(target, {
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT, ...headers },
      // The bridge is local; caching its responses would hide live changes.
      ...(bridge ? {} : { cf: { cacheTtl, cacheEverything: true } }),
    } as RequestInit);

    const body = await res.text();
    if (!res.ok) {
      throw new HttpError(`HTTP ${res.status}: ${body.slice(0, 160).trim()}`, res.status);
    }
    return body;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new HttpError(`timed out after ${timeoutMs}ms`, 0);
    }
    throw new HttpError(err instanceof Error ? err.message : String(err), 0);
  } finally {
    clearTimeout(timer);
  }
}

/** Fetches and parses JSON, with a clear error when the body is not JSON. */
export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(`expected JSON, got: ${text.slice(0, 160).trim()}`, 0);
  }
}

/** Normalises any thrown value into a short message fit for SourceHealth. */
export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
