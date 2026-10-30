import type { PriceQuote, SourceHealth } from '../types';
import type { Fetched } from './fetchers';

/**
 * Oil and gas prices from the EIA's open data API.
 *
 * EIA was chosen over the free finance endpoints because it is an official
 * statistical source, documented for programmatic use, and stamps every value
 * with its own unit and period. The app shows those verbatim: the unit, the
 * period and the series name all come from the response, never from here.
 *
 * These are published spot prices, not live futures. They settle on business
 * days and lag by a few days, so the UI labels each one with its own period
 * and marks it stale against that, rather than pretending it is a live tick.
 */

const BASE = 'https://api.eia.gov/v2/petroleum/pri/spt/data/';
const GAS_BASE = 'https://api.eia.gov/v2/natural-gas/pri/fut/data/';

interface SeriesDef {
  key: PriceQuote['key'];
  label: string;
  /** EIA series id. */
  series: string;
  base: string;
}

const SERIES: SeriesDef[] = [
  { key: 'brent', label: 'Brent crude', series: 'RBRTE', base: BASE },
  { key: 'wti', label: 'WTI crude', series: 'RWTC', base: BASE },
  { key: 'natgas', label: 'Natural gas (Henry Hub)', series: 'RNGWHHD', base: GAS_BASE },
];

interface EiaRow {
  period?: string;
  value?: number | string | null;
  units?: string;
  'series-description'?: string;
}

/**
 * Fetches the latest two observations for one series. Two, not one, so the
 * change against the previous published value can be computed from the source
 * rather than estimated.
 */
async function fetchSeries(def: SeriesDef, apiKey: string): Promise<{ quote: PriceQuote | null; error: string | null; url: string }> {
  const url = `${def.base}?${new URLSearchParams({
    api_key: apiKey,
    frequency: 'daily',
    'data[0]': 'value',
    'facets[series][]': def.series,
    'sort[0][column]': 'period',
    'sort[0][direction]': 'desc',
    length: '2',
  })}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12_000);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { 'user-agent': 'WorldPulse/1.0' },
      cf: { cacheTtl: 600, cacheEverything: true },
    } as RequestInit);
    const text = await res.text();
    if (!res.ok) return { quote: null, error: `HTTP ${res.status}: ${text.slice(0, 120)}`, url };

    const json = JSON.parse(text) as { response?: { data?: EiaRow[] } };
    const rows = json.response?.data ?? [];
    const latest = rows[0];
    if (!latest?.period || latest.value == null) {
      return { quote: null, error: `no observations returned for series ${def.series}`, url };
    }

    const value = Number(latest.value);
    if (!Number.isFinite(value)) {
      return { quote: null, error: `non-numeric value "${latest.value}"`, url };
    }

    const prev = rows[1]?.value != null ? Number(rows[1].value) : null;
    const changePct =
      prev != null && Number.isFinite(prev) && prev !== 0
        ? Number((((value - prev) / prev) * 100).toFixed(2))
        : null;

    // EIA periods are plain dates. Treated as UTC midnight on that day, which
    // is what the UI then displays as the "as of" date.
    const asOf = new Date(`${latest.period}T00:00:00Z`).toISOString();

    return {
      quote: {
        key: def.key,
        label: def.label,
        value,
        unit: latest.units ?? 'unknown',
        // EIA publishes these series in US dollars; the unit string it returns
        // ("dollars per barrel") carries the currency, and is shown as given.
        currency: 'USD',
        changePct,
        asOf,
        provenance: {
          source: `U.S. Energy Information Administration (${latest['series-description'] ?? def.series})`,
          url: 'https://www.eia.gov/opendata/browser/petroleum/pri/spt',
          retrievedAt: new Date().toISOString(),
        },
      },
      error: null,
      url,
    };
  } catch (err) {
    const msg = err instanceof Error ? (err.name === 'AbortError' ? 'timed out' : err.message) : String(err);
    return { quote: null, error: msg, url };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPrices(apiKey: string | undefined): Promise<Fetched<PriceQuote[]>> {
  const started = Date.now();
  const base: SourceHealth = {
    id: 'eia-prices',
    name: 'U.S. Energy Information Administration',
    url: 'https://www.eia.gov/opendata/',
    ok: false,
    count: 0,
    error: null,
    ms: 0,
    checkedAt: new Date().toISOString(),
  };

  if (!apiKey) {
    return {
      data: [],
      health: {
        ...base,
        ms: Date.now() - started,
        error: 'EIA_API_KEY is not set. Register free at https://www.eia.gov/opendata/register.php',
      },
    };
  }

  const settled = await Promise.all(SERIES.map((s) => fetchSeries(s, apiKey)));
  const quotes = settled.map((s) => s.quote).filter((q): q is PriceQuote => q !== null);
  const errors = settled
    .map((s, i) => (s.error ? `${SERIES[i]!.series}: ${s.error}` : null))
    .filter((e): e is string => e !== null);

  return {
    data: quotes,
    health: {
      ...base,
      ok: quotes.length > 0,
      count: quotes.length,
      // Partial failure is reported rather than hidden, so a retired series
      // shows up in /api/health instead of silently vanishing from the bar.
      error: errors.length ? errors.join('; ') : null,
      ms: Date.now() - started,
    },
  };
}
