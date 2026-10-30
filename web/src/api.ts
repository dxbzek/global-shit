/** Typed client for the worker API, plus the live stream subscription. */

export interface Meta {
  updatedAt: string | null;
  ageSeconds: number | null;
  stale: boolean;
  ttlSeconds: number;
  sources: Array<{ id: string; name: string; ok: boolean; count: number; error: string | null; checkedAt: string }>;
}

export interface ScoreComponent {
  id: string;
  label: string;
  points: number;
  max: number;
  detail: string;
}

export interface Citation {
  outlet: string;
  owner: string;
  url: string;
  publishedAt: string;
  type: string;
}

export interface StoryView {
  id: string;
  title: string;
  url: string;
  outlet: { domain: string; name: string; owner: string; country: string | null };
  publishedAt: string;
  latestAt: string;
  firstSeenAt: string;
  countries: string[];
  categories: string[];
  outletCount: number;
  confidence: 'confirmed' | 'single-source';
  relevance: number;
  summary: string | null;
  sourceTypes: string[];
  accuracy: {
    total: number;
    band: 'verified' | 'corroborated' | 'reported' | 'unconfirmed';
    bandLabel: string;
    summary: string;
    components: ScoreComponent[];
  };
  citations: Citation[];
  matchedBy: string;
}

export interface CountryRow {
  iso2: string;
  iso3: string;
  name: string;
  capital: string | null;
  continent: string | null;
  centroid: [number, number];
  bbox: [number, number, number, number];
  status: 'war' | 'conflict' | 'tension' | 'peace' | 'unknown';
  statusLabel: string;
  basis: 'dataset' | 'two-outlet' | 'none';
  reason: string | null;
  newsCount24h: number;
}

export interface PriceView {
  key: string;
  label: string;
  value: number;
  unit: string;
  currency: string;
  changePct: number | null;
  asOf: string;
  provenance: { source: string; url: string | null; retrievedAt: string };
}

export interface CountryDetail {
  country: {
    iso2: string;
    iso3: string;
    name: string;
    capital: string | null;
    continent: string | null;
    centroid: [number, number];
    bbox: [number, number, number, number];
  };
  leaders: Array<{
    role: string;
    name: string;
    since: string | null;
    source: { source: string; url: string | null; retrievedAt: string };
  }>;
  status: {
    status: CountryRow['status'];
    label: string;
    basis: CountryRow['basis'];
    reason: string;
    evidence: Array<{ source: string; url: string | null; retrievedAt: string }>;
    conflictStories: number;
  };
  conflicts: Array<{
    name: string;
    sideA: Array<{ name: string; iso2: string | null }>;
    sideB: Array<{ name: string; iso2: string | null }>;
    deaths: number | null;
    typeOfViolence: string | null;
    startDate: string | null;
    latestEventDate: string | null;
    source: { source: string; url: string | null; retrievedAt: string };
  }>;
  relations: {
    organizations: Array<{ name: string; wikidataId: string; abbreviation: string | null }>;
    allies: Array<{ iso2: string; name: string; basis: string }>;
    source: { source: string; url: string | null; retrievedAt: string };
  } | null;
  lines: Array<{
    iso2: string;
    name: string;
    centroid: [number, number];
    basis: string;
    kind: 'pact' | 'relation' | 'adversary';
  }>;
  newsByCategory: Record<string, StoryView[]>;
  newsTotal: number;
  benchmarkPrices: PriceView[];
  localPrices: { available: boolean; note: string };
  confidence: {
    total: number;
    band: StoryView['accuracy']['band'];
    parts: Array<{ label: string; ok: boolean; detail: string }>;
  };
  meta: { news: Meta; leaders: Meta; relations: Meta; prices: Meta };
}

export interface AppMeta {
  categories: Array<{ id: string; label: string }>;
  statuses: Array<{ id: string; label: string }>;
  accuracyBands: Array<{ id: string; label: string; rule: string }>;
  regions: string[];
  sourceTypes: Array<{ id: string; label: string }>;
  timeRanges: Array<{ id: number; label: string }>;
  imagery: { active: string; google3dAvailable: boolean; ionAvailable: boolean };
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string; detail?: string };
      detail = body.message ?? body.detail ?? body.error ?? detail;
    } catch {
      // Keep the status-only message.
    }
    throw new ApiError(detail, res.status);
  }
  return (await res.json()) as T;
}

export const api = {
  meta: () => get<AppMeta>('/api/meta'),
  feed: (query: string) =>
    get<{ stories: StoryView[]; total: number; counts: { items: number; stories: number; confirmed: number } | null; meta: Meta }>(
      `/api/feed?${query}`,
    ),
  countries: (query = '') => get<{ countries: CountryRow[]; total: number; meta: Meta }>(`/api/countries?${query}`),
  country: (iso2: string, query = '') => get<CountryDetail>(`/api/country/${iso2}?${query}`),
  prices: () => get<{ prices: PriceView[]; meta: Meta; note: string }>('/api/prices'),
  outlets: () => get<{ outlets: Array<{ domain: string; name: string; owner: string; count: number }>; meta: Meta }>('/api/outlets'),
  search: (q: string) => get<{ results: Array<Pick<CountryRow, 'iso2' | 'name' | 'capital' | 'continent' | 'centroid' | 'bbox'>> }>(
    `/api/search?q=${encodeURIComponent(q)}`,
  ),
  health: () => get<{ ok: boolean; revision: number; blocks: Record<string, Meta>; sourcesDown: Meta['sources'] }>('/api/health'),
};

/**
 * Subscribes to the worker's SSE stream and calls back whenever new data has
 * landed, so the UI refreshes as news arrives rather than on a timer.
 *
 * EventSource reconnects on its own, but a repeatedly failing stream should
 * not reconnect forever at full speed, so the connection state is reported and
 * the caller can fall back to polling.
 */
export function subscribeLive(handlers: {
  onRevision: (revision: number) => void;
  onState: (state: 'connecting' | 'live' | 'down') => void;
}): () => void {
  let source: EventSource | null = null;
  let retries = 0;
  let retryTimer: number | undefined;
  let closed = false;

  const connect = () => {
    if (closed) return;
    handlers.onState(retries === 0 ? 'connecting' : 'connecting');
    source = new EventSource('/api/stream');

    source.addEventListener('hello', () => {
      retries = 0;
      handlers.onState('live');
    });

    source.addEventListener('revision', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent<string>).data) as { revision: number };
        handlers.onRevision(data.revision);
      } catch {
        // A malformed frame is not worth tearing the stream down for.
      }
    });

    source.onerror = () => {
      source?.close();
      source = null;
      if (closed) return;
      handlers.onState('down');
      // Back off to a minute, so a down worker is not hammered.
      const delay = Math.min(60_000, 2000 * 2 ** retries);
      retries += 1;
      retryTimer = window.setTimeout(connect, delay);
    };
  };

  connect();

  return () => {
    closed = true;
    if (retryTimer) window.clearTimeout(retryTimer);
    source?.close();
  };
}
