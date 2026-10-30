import type {
  Cached,
  ConflictRecord,
  CountryStatusEntry,
  Leader,
  NewsItem,
  PriceQuote,
  Relation,
  SourceHealth,
  Story,
} from './types';
import { KEYS, TTL, bumpRevision, readCached, writeCached, type Env } from './cache';
import { fetchFeed, fetchGdelt, fetchSubreddit, newsFeeds, tvFeeds, SUBREDDITS } from './sources/fetchers';
import { fetchLeaders, fetchRelations } from './sources/wikidata';
import { fetchPrices } from './sources/markets';
import { fetchConflicts } from './sources/conflicts';
import { clusterStories } from './lib/dedupe';
import { deriveStatuses, deriveTension, type StatusResult } from './lib/status';
import { COUNTRY_LIST } from './lib/match';

/**
 * Continuous ingestion.
 *
 * The cron fires every minute. Hitting every upstream every minute would get
 * the worker rate-limited (GDELT alone asks for one request every five
 * seconds), so the sources are split into shards and each tick processes one
 * shard plus the always-fast feeds. The effect is that fresh items land every
 * minute while no single upstream is polled faster than it tolerates.
 *
 * Shard assignment is derived from the clock, not stored, so a missed tick
 * never desynchronises the rotation.
 */

/** How many shards the rotating feeds are spread across. */
const SHARD_COUNT = 3;

/** Items older than this are dropped at rollup, bounding cache size. */
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;

/** Hard ceiling on stored items, as a second guard on KV's 25 MB value limit. */
const MAX_ITEMS = 4000;

/**
 * Feeds polled on every tick. These are the fastest-moving wires, and they
 * tolerate a once-a-minute poll.
 */
const HOT_FEED_IDS = new Set(['bbc-world', 'aljazeera-all', 'reuters-wire', 'ap-topnews']);

/** GDELT queries, rotated one per tick so the API is hit at most once a minute. */
const GDELT_QUERIES = [
  '(war OR conflict OR offensive OR airstrike OR ceasefire)',
  '(election OR parliament OR sanctions OR summit OR protest)',
  '(oil OR "natural gas" OR OPEC OR pipeline OR "energy crisis")',
  '(earthquake OR flood OR hurricane OR wildfire OR "state of emergency")',
  '("press conference" OR "news conference" OR "addresses the nation")',
];

export interface IngestResult {
  ingested: number;
  health: SourceHealth[];
  shard: number;
}

/**
 * One ingestion tick: fetch this shard's sources, merge into the raw store.
 *
 * Raw items are kept in a single rolling list rather than per-shard blobs, so
 * clustering always sees every outlet's version of a story. Shards only
 * decide *what gets fetched* on a given tick.
 */
export async function ingestTick(env: Env, minute: number): Promise<IngestResult> {
  const shard = minute % SHARD_COUNT;
  const health: SourceHealth[] = [];
  const fetched: NewsItem[] = [];

  const all = newsFeeds();
  const hot = all.filter((f) => HOT_FEED_IDS.has(f.id));
  const rotating = all.filter((f) => !HOT_FEED_IDS.has(f.id));

  // This tick's slice of the rotating feeds.
  const slice = rotating.filter((_, i) => i % SHARD_COUNT === shard);

  // Reddit and the TV channels move slower and rate-limit harder, so each
  // gets one entry per tick, rotated.
  const sub = SUBREDDITS[minute % SUBREDDITS.length]!;
  const tv = tvFeeds();
  const tvFeed = tv[minute % tv.length];
  const gdeltQuery = GDELT_QUERIES[minute % GDELT_QUERIES.length]!;

  const jobs: Array<Promise<{ data: NewsItem[]; health: SourceHealth }>> = [
    ...hot.map((f) => fetchFeed(f)),
    ...slice.map((f) => fetchFeed(f)),
    fetchSubreddit(sub),
    fetchGdelt(gdeltQuery),
  ];
  if (tvFeed) jobs.push(fetchFeed(tvFeed));

  const settled = await Promise.allSettled(jobs);
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      fetched.push(...result.value.data);
      health.push(result.value.health);
    } else {
      health.push({
        id: 'unknown',
        name: 'unknown source',
        url: '',
        ok: false,
        count: 0,
        error: String(result.reason),
        ms: 0,
        checkedAt: new Date().toISOString(),
      });
    }
  }

  await mergeRaw(env, fetched, health);
  return { ingested: fetched.length, health, shard };
}

interface RawStore {
  items: NewsItem[];
  /** Latest health line per source id, so a stale failure does not linger. */
  health: Record<string, SourceHealth>;
}

/**
 * Merges newly fetched items into the rolling raw store, de-duplicating on
 * item id (a hash of the URL) so repeated polls of the same feed do not
 * inflate outlet counts.
 */
async function mergeRaw(env: Env, incoming: NewsItem[], health: SourceHealth[]): Promise<void> {
  const existing = await readCached<RawStore>(env, KEYS.shard(0));
  const store: RawStore = existing?.data ?? { items: [], health: {} };

  const byId = new Map<string, NewsItem>();
  for (const item of store.items) byId.set(item.id, item);
  // Incoming wins, so a corrected title or date replaces the earlier copy.
  for (const item of incoming) byId.set(item.id, item);

  const cutoff = Date.now() - RETAIN_MS;
  const items = [...byId.values()]
    .filter((i) => {
      const t = Date.parse(i.publishedAt);
      // Drop anything undateable or implausibly future-dated; a feed with a
      // broken clock would otherwise pin itself to the top of the ticker.
      return Number.isFinite(t) && t > cutoff && t < Date.now() + 2 * 3600_000;
    })
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, MAX_ITEMS);

  for (const h of health) store.health[h.id] = h;

  await writeCached(env, KEYS.shard(0), { items, health: store.health }, TTL.rollup, health);
}

export interface Rollup {
  stories: Story[];
  statuses: CountryStatusEntry[];
  /** Full status detail keyed by ISO, including the rule that produced it. */
  statusDetail: Record<string, StatusResult>;
  counts: { items: number; stories: number; confirmed: number };
}

/**
 * Clusters the raw store into stories and derives country statuses.
 *
 * Run after every ingest tick. Clustering is O(items x clusters), which is why
 * the raw store is capped: at 4000 items this stays inside the worker's CPU
 * budget comfortably.
 */
export async function rollup(env: Env): Promise<Cached<Rollup>> {
  const raw = await readCached<RawStore>(env, KEYS.shard(0));
  const items = raw?.data.items ?? [];
  const health = Object.values(raw?.data.health ?? {});

  const stories = clusterStories(items);

  const conflictCache = await readCached<{ byCountry: ConflictRecord[]; coversWorld: boolean; provenance: null | { source: string; url: string | null; retrievedAt: string } }>(
    env,
    KEYS.conflicts,
  );
  const datasetByCountry = new Map<string, ConflictRecord>(
    (conflictCache?.data.byCountry ?? []).map((r) => [r.countryIso2, r]),
  );

  const statusDetail = deriveStatuses({
    datasetByCountry,
    stories,
    datasetCoversWorld: conflictCache?.data.coversWorld ?? false,
    datasetProvenance: conflictCache?.data.provenance ?? undefined,
  });
  deriveTension(stories, statusDetail);

  // Story counts per country over the last 24h, for the news-volume sort.
  const dayAgo = Date.now() - 24 * 3600_000;
  const newsCount = new Map<string, number>();
  for (const s of stories) {
    if (Date.parse(s.latestAt) < dayAgo) continue;
    for (const iso of s.countries) newsCount.set(iso, (newsCount.get(iso) ?? 0) + 1);
  }

  const statuses: CountryStatusEntry[] = COUNTRY_LIST.map((c) => {
    const detail = statusDetail.get(c.iso2);
    return {
      iso2: c.iso2,
      status: detail?.status ?? 'unknown',
      basis: detail?.basis ?? 'none',
      newsCount24h: newsCount.get(c.iso2) ?? 0,
    };
  });

  const payload: Rollup = {
    stories,
    statuses,
    statusDetail: Object.fromEntries(statusDetail),
    counts: {
      items: items.length,
      stories: stories.length,
      confirmed: stories.filter((s) => s.confidence === 'confirmed').length,
    },
  };

  const written = await writeCached(env, KEYS.rollup, payload, TTL.rollup, health);
  await bumpRevision(env);
  return written;
}

/** Refreshes the slow-moving reference data. Called on a longer cadence. */
export async function refreshReference(env: Env, which: 'leaders' | 'relations' | 'conflicts' | 'prices'): Promise<SourceHealth[]> {
  switch (which) {
    case 'leaders': {
      const { data, health } = await fetchLeaders();
      // Never overwrite good data with an empty result from a failed fetch.
      if (data.length || !(await readCached<Leader[]>(env, KEYS.leaders))) {
        await writeCached(env, KEYS.leaders, data, TTL.leaders, [health]);
      }
      return [health];
    }
    case 'relations': {
      const { data, health } = await fetchRelations();
      if (data.length || !(await readCached<Relation[]>(env, KEYS.relations))) {
        await writeCached(env, KEYS.relations, data, TTL.relations, [health]);
      }
      return [health];
    }
    case 'conflicts': {
      const { data, health } = await fetchConflicts(env.UCDP_API_TOKEN);
      await writeCached(env, KEYS.conflicts, data, TTL.conflicts, [health]);
      return [health];
    }
    case 'prices': {
      const { data, health } = await fetchPrices(env.EIA_API_KEY);
      if (data.length || !(await readCached<PriceQuote[]>(env, KEYS.prices))) {
        await writeCached(env, KEYS.prices, data, TTL.prices, [health]);
      }
      return [health];
    }
  }
}

/**
 * The scheduled entry point. Decides what this tick does from the clock:
 *
 *   every minute      ingest a shard, then re-cluster
 *   every 5 minutes   prices
 *   every 30 minutes  conflict dataset
 *   every 6 hours     leaders and alliances
 */
export async function runScheduled(env: Env, scheduledTime: number): Promise<void> {
  const d = new Date(scheduledTime);
  const minute = d.getUTCMinutes() + d.getUTCHours() * 60;

  await ingestTick(env, minute);
  await rollup(env);

  if (minute % 5 === 0) await refreshReference(env, 'prices');
  if (minute % 30 === 7) await refreshReference(env, 'conflicts');
  if (minute % 360 === 13) await refreshReference(env, 'leaders');
  if (minute % 360 === 23) await refreshReference(env, 'relations');
}

/**
 * First-run bootstrap: fills every cache so a freshly deployed worker serves
 * real data immediately rather than an empty page until the first cron.
 */
export async function bootstrap(env: Env): Promise<void> {
  await Promise.allSettled([
    refreshReference(env, 'prices'),
    refreshReference(env, 'conflicts'),
    refreshReference(env, 'leaders'),
    refreshReference(env, 'relations'),
  ]);
  // Three ticks so all shards get a first pass.
  for (let i = 0; i < SHARD_COUNT; i++) await ingestTick(env, i);
  await rollup(env);
}

export { SHARD_COUNT };
