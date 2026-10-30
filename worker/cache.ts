import type { Cached, SourceHealth } from './types';

/**
 * KV-backed cache.
 *
 * Every blob is wrapped with the time it was written, its intended refresh
 * window and the per-source outcomes from that refresh, so the UI can show a
 * last-updated time for each data type, mark it stale, and name any source
 * that was down. Nothing is served without that envelope.
 */

export interface Env {
  WORLD_PULSE: KVNamespace;
  /** Free key from https://www.eia.gov/opendata/register.php */
  EIA_API_KEY?: string;
  /** Optional. UCDP now requires one: https://ucdp.uu.se/apidocs/ */
  UCDP_API_TOKEN?: string;
  /** Optional second conflict dataset. */
  ACLED_API_KEY?: string;
  ACLED_EMAIL?: string;
  /** Optional. Enables Google Photorealistic 3D Tiles in the globe. */
  GOOGLE_MAPS_API_KEY?: string;
  /** Optional. Enables Cesium Ion imagery and terrain. */
  CESIUM_ION_TOKEN?: string;
  ASSETS: Fetcher;
}

/** Cache keys and how long each type is considered fresh. */
export const KEYS = {
  /** Raw ingested items, per shard, merged by the rollup step. */
  shard: (n: number) => `raw:shard:${n}`,
  /** Clustered stories, country statuses and health. The app's main payload. */
  rollup: 'rollup:v1',
  leaders: 'leaders:v1',
  relations: 'relations:v1',
  conflicts: 'conflicts:v1',
  prices: 'prices:v1',
  /** Monotonic counter so the live stream can tell clients what is new. */
  revision: 'meta:revision',
} as const;

/**
 * Freshness windows, in seconds. The UI marks a data type stale once its age
 * passes its window, which is how a silently failing cron becomes visible.
 */
export const TTL = {
  /** News is re-ingested continuously; two minutes without it is stale. */
  rollup: 120,
  leaders: 24 * 3600,
  relations: 24 * 3600,
  conflicts: 6 * 3600,
  /** EIA publishes on business days, so a day-old quote is still current. */
  prices: 36 * 3600,
} as const;

export async function readCached<T>(env: Env, key: string): Promise<Cached<T> | null> {
  const raw = await env.WORLD_PULSE.get(key, 'json');
  return (raw as Cached<T> | null) ?? null;
}

export async function writeCached<T>(
  env: Env,
  key: string,
  data: T,
  ttlSeconds: number,
  sources: SourceHealth[],
): Promise<Cached<T>> {
  const payload: Cached<T> = {
    data,
    updatedAt: new Date().toISOString(),
    ttlSeconds,
    sources,
  };
  await env.WORLD_PULSE.put(key, JSON.stringify(payload), {
    // Keep blobs well past their freshness window: stale data clearly labelled
    // is more useful than an empty page, and the UI says which it is showing.
    expirationTtl: Math.max(600, ttlSeconds * 20),
  });
  return payload;
}

/** True when a blob has outlived its freshness window. */
export function isStale(cached: Pick<Cached<unknown>, 'updatedAt' | 'ttlSeconds'>): boolean {
  return Date.now() - Date.parse(cached.updatedAt) > cached.ttlSeconds * 1000;
}

export function ageSeconds(cached: Pick<Cached<unknown>, 'updatedAt'>): number {
  return Math.max(0, Math.round((Date.now() - Date.parse(cached.updatedAt)) / 1000));
}

/** Bumps and returns the revision counter the live stream watches. */
export async function bumpRevision(env: Env): Promise<number> {
  const current = Number((await env.WORLD_PULSE.get(KEYS.revision)) ?? '0');
  const next = Number.isFinite(current) ? current + 1 : 1;
  await env.WORLD_PULSE.put(KEYS.revision, String(next));
  return next;
}

export async function readRevision(env: Env): Promise<number> {
  const v = Number((await env.WORLD_PULSE.get(KEYS.revision)) ?? '0');
  return Number.isFinite(v) ? v : 0;
}
