import type {
  Category,
  ConflictRecord,
  Leader,
  PriceQuote,
  Relation,
  SourceType,
  Story,
} from './types';
import {
  KEYS,
  TTL,
  ageSeconds,
  isStale,
  readCached,
  readRevision,
  type Env,
} from './cache';
import { bootstrap, rollup, runScheduled } from './pipeline';
import type { Rollup } from './pipeline';
import { COUNTRIES, COUNTRY_LIST, findCountry } from './lib/match';
import { CATEGORY_LABELS, CATEGORY_ORDER } from './lib/categorize';
import { STATUS_LABELS, STATUS_RANK, type StatusResult } from './lib/status';
import { BAND_LABELS, BAND_RULES, scoreCountry, scoreStory } from './lib/score';

/**
 * HTTP surface.
 *
 * Every response that carries data also carries `meta`, holding the time the
 * data was written, whether it is past its freshness window, and the health of
 * each source behind it. The UI uses that to show a last-updated time on every
 * panel and a visible warning when a source is down, rather than presenting
 * stale or partial data as current.
 */

const json = (body: unknown, status = 200, extraHeaders: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Short edge cache: the data changes every minute and the live stream
      // notifies clients anyway, so a long cache would only add staleness.
      'cache-control': 'public, max-age=15, stale-while-revalidate=60',
      ...extraHeaders,
    },
  });

const notFound = () => json({ error: 'not found' }, 404);

interface Meta {
  updatedAt: string | null;
  ageSeconds: number | null;
  stale: boolean;
  ttlSeconds: number;
  sources: Array<{ id: string; name: string; ok: boolean; count: number; error: string | null; checkedAt: string }>;
}

const metaFrom = (cached: { updatedAt: string; ttlSeconds: number; sources: Meta['sources'] } | null, ttl: number): Meta =>
  cached
    ? {
        updatedAt: cached.updatedAt,
        ageSeconds: ageSeconds(cached),
        stale: isStale(cached),
        ttlSeconds: cached.ttlSeconds,
        sources: cached.sources,
      }
    : { updatedAt: null, ageSeconds: null, stale: true, ttlSeconds: ttl, sources: [] };

// ---------------------------------------------------------------------------
// Filtering and sorting, shared by the feed and country endpoints
// ---------------------------------------------------------------------------

type SortKey = 'newest' | 'reported' | 'relevant';

interface Query {
  categories: Category[];
  countries: string[];
  regions: string[];
  sourceTypes: SourceType[];
  outlets: string[];
  /** Hours. 1, 24, 168 or 720. */
  since: number | null;
  sort: SortKey;
  /** Minimum accuracy score. */
  minScore: number | null;
  confirmedOnly: boolean;
  search: string | null;
  limit: number;
  offset: number;
}

const parseList = (raw: string | null): string[] =>
  raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];

function parseQuery(url: URL): Query {
  const n = (key: string, fallback: number) => {
    const v = Number(url.searchParams.get(key));
    return Number.isFinite(v) ? v : fallback;
  };
  const sortRaw = url.searchParams.get('sort');
  return {
    categories: parseList(url.searchParams.get('category')) as Category[],
    countries: parseList(url.searchParams.get('country')).map((c) => c.toUpperCase()),
    regions: parseList(url.searchParams.get('region')),
    sourceTypes: parseList(url.searchParams.get('sourceType')) as SourceType[],
    outlets: parseList(url.searchParams.get('outlet')).map((o) => o.toLowerCase()),
    since: url.searchParams.has('since') ? n('since', 24) : null,
    sort: sortRaw === 'reported' || sortRaw === 'relevant' ? sortRaw : 'newest',
    minScore: url.searchParams.has('minScore') ? n('minScore', 0) : null,
    confirmedOnly: url.searchParams.get('confirmed') === '1',
    search: url.searchParams.get('q')?.trim().toLowerCase() || null,
    limit: Math.min(300, Math.max(1, n('limit', 60))),
    offset: Math.max(0, n('offset', 0)),
  };
}

/** Countries in a named region, from the generated continent field. */
function countriesInRegions(regions: string[]): Set<string> {
  const wanted = new Set(regions.map((r) => r.toLowerCase()));
  const out = new Set<string>();
  for (const c of COUNTRY_LIST) {
    if (c.continent && wanted.has(c.continent.toLowerCase())) out.add(c.iso2);
  }
  return out;
}

interface ScoredStory extends Story {
  accuracy: ReturnType<typeof scoreStory>;
}

function applyQuery(stories: ScoredStory[], q: Query): ScoredStory[] {
  const regionSet = q.regions.length ? countriesInRegions(q.regions) : null;
  const cutoff = q.since != null ? Date.now() - q.since * 3600_000 : null;

  const filtered = stories.filter((s) => {
    if (cutoff != null && Date.parse(s.latestAt) < cutoff) return false;
    if (q.confirmedOnly && s.confidence !== 'confirmed') return false;
    if (q.minScore != null && s.accuracy.total < q.minScore) return false;
    if (q.categories.length && !q.categories.some((c) => s.categories.includes(c))) return false;
    if (q.countries.length && !q.countries.some((c) => s.countries.includes(c))) return false;
    if (regionSet && !s.countries.some((c) => regionSet.has(c))) return false;
    if (q.sourceTypes.length && !s.items.some((i) => q.sourceTypes.includes(i.sourceType))) return false;
    if (q.outlets.length && !s.items.some((i) => q.outlets.includes(i.outlet.domain.toLowerCase()))) return false;
    if (q.search) {
      const hay = `${s.title} ${s.primary.summary ?? ''}`.toLowerCase();
      if (!hay.includes(q.search)) return false;
    }
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    switch (q.sort) {
      case 'reported':
        // Breadth first, newest as the tie-break.
        return b.outletCount - a.outletCount || Date.parse(b.latestAt) - Date.parse(a.latestAt);
      case 'relevant':
        return b.relevance - a.relevance || Date.parse(b.latestAt) - Date.parse(a.latestAt);
      default:
        return Date.parse(b.latestAt) - Date.parse(a.latestAt);
    }
  });

  return sorted;
}

/** Attaches an accuracy score to every story, given the conflict dataset. */
function scoreAll(stories: Story[], conflicts: Map<string, ConflictRecord>): ScoredStory[] {
  return stories.map((s) => {
    const conflict = s.countries.map((c) => conflicts.get(c)).find(Boolean) ?? null;
    return { ...s, accuracy: scoreStory(s, conflict) };
  });
}

/** Trims a story for list responses, keeping every citation. */
const forList = (s: ScoredStory) => ({
  id: s.id,
  title: s.title,
  url: s.primary.url,
  outlet: s.primary.outlet,
  publishedAt: s.primary.publishedAt,
  latestAt: s.latestAt,
  firstSeenAt: s.firstSeenAt,
  countries: s.countries,
  categories: s.categories,
  outletCount: s.outletCount,
  confidence: s.confidence,
  relevance: s.relevance,
  summary: s.primary.summary,
  sourceTypes: [...new Set(s.items.map((i) => i.sourceType))],
  accuracy: {
    total: s.accuracy.total,
    band: s.accuracy.band,
    bandLabel: BAND_LABELS[s.accuracy.band],
    summary: s.accuracy.summary,
    components: s.accuracy.components,
  },
  // Every outlet that carried it, with a link and a time, always.
  citations: s.accuracy.citations,
  matchedBy: s.primary.matchedBy,
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function loadRollup(env: Env) {
  const cached = await readCached<Rollup>(env, KEYS.rollup);
  const conflictCache = await readCached<{ byCountry: ConflictRecord[] }>(env, KEYS.conflicts);
  const conflicts = new Map<string, ConflictRecord>(
    (conflictCache?.data.byCountry ?? []).map((r) => [r.countryIso2, r]),
  );
  return { cached, conflicts };
}

async function handleFeed(env: Env, url: URL): Promise<Response> {
  const q = parseQuery(url);
  const { cached, conflicts } = await loadRollup(env);
  if (!cached) {
    return json(
      {
        stories: [],
        total: 0,
        meta: metaFrom(null, TTL.rollup),
        message: 'No data cached yet. The first ingest runs within a minute of deploy.',
      },
      503,
    );
  }

  const scored = scoreAll(cached.data.stories, conflicts);
  const matched = applyQuery(scored, q);

  return json({
    stories: matched.slice(q.offset, q.offset + q.limit).map(forList),
    total: matched.length,
    counts: cached.data.counts,
    meta: metaFrom(cached, TTL.rollup),
  });
}

async function handleCountry(env: Env, url: URL, iso2: string): Promise<Response> {
  const country = COUNTRIES[iso2.toUpperCase()];
  if (!country) return notFound();

  const q = parseQuery(url);
  const [{ cached, conflicts }, leadersC, relationsC, pricesC] = await Promise.all([
    loadRollup(env),
    readCached<Leader[]>(env, KEYS.leaders),
    readCached<Relation[]>(env, KEYS.relations),
    readCached<PriceQuote[]>(env, KEYS.prices),
  ]);

  const leaders = (leadersC?.data ?? []).filter((l) => l.countryIso2 === country.iso2);
  const relation = (relationsC?.data ?? []).find((r) => r.countryIso2 === country.iso2) ?? null;
  const conflict = conflicts.get(country.iso2) ?? null;
  const statusDetail: StatusResult | null = cached?.data.statusDetail[country.iso2] ?? null;

  const scored = cached ? scoreAll(cached.data.stories, conflicts) : [];
  const mine = scored.filter((s) => s.countries.includes(country.iso2));
  const filtered = applyQuery(mine, { ...q, countries: [] });

  // Stories grouped by category, which is how the panel presents them.
  const byCategory: Record<string, ReturnType<typeof forList>[]> = {};
  for (const cat of CATEGORY_ORDER) {
    const inCat = filtered.filter((s) => s.categories.includes(cat));
    if (inCat.length) byCategory[cat] = inCat.slice(0, 12).map(forList);
  }

  /*
   * Local fuel prices. The app has no verified per-country retail fuel source,
   * so rather than present a global benchmark as a local price, it says so and
   * shows the benchmark labelled as exactly what it is.
   */
  const benchmarks = pricesC?.data ?? [];

  const confidence = scoreCountry({
    hasLeader: leaders.length > 0,
    leaderSource: leaders[0]?.provenance.source ?? null,
    statusBasis: statusDetail?.basis ?? 'none',
    statusReason: statusDetail?.reason ?? 'No conflict dataset row and no confirmed conflict reporting.',
    storyCount: mine.length,
    confirmedCount: mine.filter((s) => s.confidence === 'confirmed').length,
    hasRelations: Boolean(relation && (relation.organizations.length || relation.allies.length)),
  });

  /*
   * Shared-membership partners.
   *
   * The app does not assert that two countries are allies; nothing in the
   * sources supports that claim. What it can show, and cite, is that they
   * belong to the same body. The most specific shared body is used, because
   * sharing a 20-member organisation is informative where sharing the UN is
   * not, and the body is named in the UI next to every line it produces.
   */
  const myOrgs = relation?.organizations ?? [];
  // organizations arrive sorted smallest-membership first.
  const anchorOrg = myOrgs[0] ?? null;
  const sharedPartners = anchorOrg
    ? (relationsC?.data ?? [])
        .filter(
          (r) =>
            r.countryIso2 !== country.iso2 &&
            COUNTRIES[r.countryIso2] &&
            r.organizations.some((o) => o.wikidataId === anchorOrg.wikidataId),
        )
        .slice(0, 28)
        .map((r) => ({
          iso2: r.countryIso2,
          name: COUNTRIES[r.countryIso2]!.name,
          centroid: COUNTRIES[r.countryIso2]!.centroid,
          basis: `Both members of ${anchorOrg.abbreviation ?? anchorOrg.name} (Wikidata)`,
          kind: 'pact' as const,
        }))
    : [];

  /*
   * Opposing parties come only from a conflict dataset naming both sides.
   * They are never inferred from reporting, so a country with no dataset row
   * shows none rather than a guess.
   */
  const adversaries = (conflict?.conflicts ?? [])
    .flatMap((c) => [...c.sideA, ...c.sideB])
    .filter((p) => p.iso2 && p.iso2 !== country.iso2 && COUNTRIES[p.iso2])
    .map((p) => ({
      iso2: p.iso2!,
      name: COUNTRIES[p.iso2!]!.name,
      centroid: COUNTRIES[p.iso2!]!.centroid,
      basis: `Named as an opposing party by ${conflict!.provenance.source}`,
      kind: 'adversary' as const,
    }));

  // De-duplicate: a country named as an opponent must not also draw a
  // shared-membership line, or the globe contradicts itself.
  const adversaryIsos = new Set(adversaries.map((a) => a.iso2));
  const lineTargets = sharedPartners.filter((p) => !adversaryIsos.has(p.iso2));

  return json({
    country: {
      iso2: country.iso2,
      iso3: country.iso3,
      name: country.name,
      capital: country.capital,
      continent: country.continent,
      centroid: country.centroid,
      bbox: country.bbox,
    },
    leaders: leaders.map((l) => ({
      role: l.position,
      name: l.name,
      since: l.since,
      source: l.provenance,
    })),
    status: statusDetail
      ? {
          status: statusDetail.status,
          label: STATUS_LABELS[statusDetail.status],
          basis: statusDetail.basis,
          reason: statusDetail.reason,
          evidence: statusDetail.evidence,
          conflictStories: statusDetail.conflictStories,
        }
      : {
          status: 'unknown',
          label: STATUS_LABELS.unknown,
          basis: 'none',
          reason: 'No conflict-dataset row and no confirmed conflict reporting in the last 7 days.',
          evidence: [],
          conflictStories: 0,
        },
    conflicts:
      conflict?.conflicts.map((c) => ({
        name: c.name,
        sideA: c.sideA,
        sideB: c.sideB,
        deaths: c.deaths,
        typeOfViolence: c.typeOfViolence,
        startDate: c.startDate,
        latestEventDate: c.latestEventDate,
        source: conflict.provenance,
      })) ?? [],
    relations: relation
      ? {
          organizations: relation.organizations,
          // Named "shared memberships", not "allies": this is what the source
          // supports, and the anchor body is stated so the list can be checked.
          sharedWith: lineTargets,
          anchorOrganization: anchorOrg,
          source: relation.provenance,
        }
      : null,
    lines: [...lineTargets, ...adversaries],
    newsByCategory: byCategory,
    newsTotal: filtered.length,
    benchmarkPrices: benchmarks,
    localPrices: {
      available: false,
      note:
        'No free source for verified country-level retail fuel prices was found, so none is shown. ' +
        'The figures above are international benchmark spot prices from the EIA, not local pump prices.',
    },
    confidence,
    meta: {
      news: metaFrom(cached, TTL.rollup),
      leaders: metaFrom(leadersC, TTL.leaders),
      relations: metaFrom(relationsC, TTL.relations),
      prices: metaFrom(pricesC, TTL.prices),
    },
  });
}

async function handleCountries(env: Env, url: URL): Promise<Response> {
  const { cached } = await loadRollup(env);
  const statusByIso = new Map(
    (cached?.data.statuses ?? []).map((s) => [s.iso2, s]),
  );
  const wantStatus = parseList(url.searchParams.get('status'));
  const sort = url.searchParams.get('sort') ?? 'name';

  let rows = COUNTRY_LIST.map((c) => {
    const s = statusByIso.get(c.iso2);
    const detail = cached?.data.statusDetail[c.iso2];
    return {
      iso2: c.iso2,
      iso3: c.iso3,
      name: c.name,
      capital: c.capital,
      continent: c.continent,
      centroid: c.centroid,
      bbox: c.bbox,
      status: s?.status ?? 'unknown',
      statusLabel: STATUS_LABELS[s?.status ?? 'unknown'],
      basis: s?.basis ?? 'none',
      reason: detail?.reason ?? null,
      newsCount24h: s?.newsCount24h ?? 0,
    };
  });

  if (wantStatus.length) rows = rows.filter((r) => wantStatus.includes(r.status));

  rows.sort((a, b) => {
    if (sort === 'status') {
      return STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.name.localeCompare(b.name);
    }
    if (sort === 'news') return b.newsCount24h - a.newsCount24h || a.name.localeCompare(b.name);
    return a.name.localeCompare(b.name);
  });

  return json({ countries: rows, total: rows.length, meta: metaFrom(cached, TTL.rollup) });
}

async function handlePrices(env: Env): Promise<Response> {
  const cached = await readCached<PriceQuote[]>(env, KEYS.prices);
  return json({
    prices: cached?.data ?? [],
    meta: metaFrom(cached, TTL.prices),
    note: 'Published spot prices, not live futures. Each carries its own source, unit and period.',
  });
}

async function handleHealth(env: Env): Promise<Response> {
  const [rollupC, leadersC, relationsC, conflictsC, pricesC, revision] = await Promise.all([
    readCached<Rollup>(env, KEYS.rollup),
    readCached<Leader[]>(env, KEYS.leaders),
    readCached<Relation[]>(env, KEYS.relations),
    readCached<{ byCountry: ConflictRecord[] }>(env, KEYS.conflicts),
    readCached<PriceQuote[]>(env, KEYS.prices),
    readRevision(env),
  ]);

  const blocks = {
    news: metaFrom(rollupC, TTL.rollup),
    leaders: metaFrom(leadersC, TTL.leaders),
    relations: metaFrom(relationsC, TTL.relations),
    conflicts: metaFrom(conflictsC, TTL.conflicts),
    prices: metaFrom(pricesC, TTL.prices),
  };

  const allSources = Object.values(blocks).flatMap((b) => b.sources);
  const down = allSources.filter((s) => !s.ok);

  return json({
    ok: down.length === 0,
    revision,
    counts: rollupC?.data.counts ?? null,
    blocks,
    sourcesDown: down,
    keysConfigured: {
      // Reported so a deployment can be diagnosed without exposing values.
      EIA_API_KEY: Boolean(env.EIA_API_KEY),
      UCDP_API_TOKEN: Boolean(env.UCDP_API_TOKEN),
      ACLED_API_KEY: Boolean(env.ACLED_API_KEY),
      GOOGLE_MAPS_API_KEY: Boolean(env.GOOGLE_MAPS_API_KEY),
      CESIUM_ION_TOKEN: Boolean(env.CESIUM_ION_TOKEN),
    },
  });
}

/** Static reference the UI needs: categories, statuses, score bands, regions. */
function handleMeta(env: Env): Response {
  return json(
    {
      categories: CATEGORY_ORDER.map((id) => ({ id, label: CATEGORY_LABELS[id] })),
      statuses: Object.entries(STATUS_LABELS).map(([id, label]) => ({ id, label })),
      accuracyBands: Object.entries(BAND_LABELS).map(([id, label]) => ({
        id,
        label,
        rule: BAND_RULES[id as keyof typeof BAND_RULES],
      })),
      regions: [...new Set(COUNTRY_LIST.map((c) => c.continent).filter(Boolean))].sort(),
      sourceTypes: [
        { id: 'news', label: 'News' },
        { id: 'reddit', label: 'Reddit (discussion)' },
        { id: 'tv', label: 'TV' },
        { id: 'press', label: 'Press conferences' },
      ],
      timeRanges: [
        { id: 1, label: '1 hour' },
        { id: 24, label: '24 hours' },
        { id: 168, label: '7 days' },
        { id: 720, label: '30 days' },
      ],
      imagery: {
        // Default needs no key. The others activate when their key is set.
        active: env.CESIUM_ION_TOKEN ? 'ion' : 'esri',
        google3dAvailable: Boolean(env.GOOGLE_MAPS_API_KEY),
        ionAvailable: Boolean(env.CESIUM_ION_TOKEN),
      },
    },
    200,
    { 'cache-control': 'public, max-age=300' },
  );
}

/** Outlets currently present in the cache, for the outlet filter. */
async function handleOutlets(env: Env): Promise<Response> {
  const { cached } = await loadRollup(env);
  const counts = new Map<string, { domain: string; name: string; owner: string; count: number }>();
  for (const s of cached?.data.stories ?? []) {
    for (const i of s.items) {
      const row = counts.get(i.outlet.domain) ?? {
        domain: i.outlet.domain,
        name: i.outlet.name,
        owner: i.outlet.owner,
        count: 0,
      };
      row.count += 1;
      counts.set(i.outlet.domain, row);
    }
  }
  return json({
    outlets: [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    meta: metaFrom(cached, TTL.rollup),
  });
}

/**
 * Live stream. Holds a Server-Sent Events connection and pushes a `revision`
 * event whenever the rollup is rewritten, so the UI refreshes as news lands
 * instead of polling on a timer.
 */
function handleStream(env: Env): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    async start(controller) {
      let last = await readRevision(env);
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send('hello', { revision: last, serverTime: new Date().toISOString() });

      timer = setInterval(async () => {
        try {
          const current = await readRevision(env);
          if (current !== last) {
            last = current;
            send('revision', { revision: current, serverTime: new Date().toISOString() });
          } else {
            // Comment frame keeps intermediaries from closing an idle stream.
            controller.enqueue(encoder.encode(`: keep-alive\n\n`));
          }
        } catch {
          // A transient KV error should not tear down the client's stream.
        }
      }, 5000);
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    },
  });
}

async function handleSearch(url: URL): Promise<Response> {
  const q = url.searchParams.get('q')?.trim().toLowerCase() ?? '';
  if (!q) return json({ results: [] });
  const scored = COUNTRY_LIST.map((c) => {
    const names = [c.name, ...c.match.names, c.capital ?? ''].filter(Boolean);
    let best = -1;
    for (const n of names) {
      const low = n.toLowerCase();
      if (low === q) best = Math.max(best, 100);
      else if (low.startsWith(q)) best = Math.max(best, 70 - low.length);
      else if (low.includes(q)) best = Math.max(best, 40 - low.length);
    }
    return { c, best };
  })
    .filter((r) => r.best > 0)
    .sort((a, b) => b.best - a.best)
    .slice(0, 12);

  return json({
    results: scored.map(({ c }) => ({
      iso2: c.iso2,
      name: c.name,
      capital: c.capital,
      continent: c.continent,
      centroid: c.centroid,
      bbox: c.bbox,
    })),
  });
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (!path.startsWith('/api/')) {
      // Everything else is the single-page app, served from Workers Assets.
      return env.ASSETS.fetch(request);
    }

    try {
      if (path === '/api/meta') return handleMeta(env);
      if (path === '/api/health') return await handleHealth(env);
      if (path === '/api/feed') return await handleFeed(env, url);
      if (path === '/api/countries') return await handleCountries(env, url);
      if (path === '/api/prices') return await handlePrices(env);
      if (path === '/api/outlets') return await handleOutlets(env);
      if (path === '/api/search') return await handleSearch(url);
      if (path === '/api/stream') return handleStream(env);

      const country = /^\/api\/country\/([A-Za-z]{2,3})$/.exec(path);
      if (country) {
        const resolved = findCountry(country[1]!);
        if (!resolved) return notFound();
        return await handleCountry(env, url, resolved.iso2);
      }

      // Manual refresh, used once after a deploy to fill empty caches.
      if (path === '/api/refresh' && request.method === 'POST') {
        ctx.waitUntil(bootstrap(env));
        return json({ started: true, note: 'Bootstrap running in the background.' });
      }
      if (path === '/api/rollup' && request.method === 'POST') {
        const written = await rollup(env);
        return json({ counts: written.data.counts, updatedAt: written.updatedAt });
      }

      return notFound();
    } catch (err) {
      // Surface the failure rather than an empty 200, so the UI can say the
      // API is down instead of silently rendering nothing.
      return json({ error: 'internal error', detail: (err as Error).message }, 500);
    }
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(env, event.scheduledTime));
  },
};
