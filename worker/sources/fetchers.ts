import type { NewsItem, SourceHealth, SourceType } from '../types';
import { NEWS_FEEDS, TV_FEEDS, resolveOutlet, type FeedDef } from '../lib/outlets';
import { cleanText, hostOf, parseFeed, parseFeedDate } from '../lib/xml';
import { categorize } from '../lib/categorize';
import { matchCountries } from '../lib/match';
import { hash } from '../lib/dedupe';

const UA = 'WorldPulse/1.0 (+https://github.com/dxbzek/global-shit)';

/** Per-fetch ceiling. Cloudflare caps a request's total wall time, so each
 *  upstream gets a short leash and a failure is recorded rather than retried
 *  indefinitely. */
const FETCH_TIMEOUT_MS = 12_000;

export interface Fetched<T> {
  data: T;
  health: SourceHealth;
}

async function timedFetch(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: ac.signal,
      headers: { 'user-agent': UA, ...headers },
      // Let Cloudflare's own cache absorb repeat hits between cron runs.
      cf: { cacheTtl: 120, cacheEverything: true },
    } as RequestInit);
  } finally {
    clearTimeout(timer);
  }
}

const health = (
  id: string,
  name: string,
  url: string,
  started: number,
  ok: boolean,
  count: number,
  error: string | null,
): SourceHealth => ({
  id,
  name,
  url,
  ok,
  count,
  error,
  ms: Date.now() - started,
  checkedAt: new Date().toISOString(),
});

/** Turns one feed entry into a NewsItem, or null if it is unusable. */
function toNewsItem(
  entry: { title: string; link: string; publishedAt: string | null; summary: string | null; categories: string[] },
  feed: FeedDef,
): NewsItem | null {
  // An item with no readable date cannot be placed on a timeline, sorted, or
  // judged for staleness, so it is dropped rather than stamped with "now".
  if (!entry.publishedAt) return null;

  const summary = entry.summary ? cleanText(entry.summary).slice(0, 400) : null;
  const { categories } = categorize(entry.title, summary, [
    ...entry.categories,
    feed.forceCategory ?? '',
  ]);
  const { countries, matchedBy } = matchCountries(entry.title, summary);

  const sourceType: SourceType = feed.sourceType === 'tv'
    // A broadcaster video whose title reads as a briefing is filed as a press
    // conference; everything else from a channel feed stays 'tv'.
    ? (categories.includes('press') ? 'press' : 'tv')
    : 'news';

  const finalCategories = feed.forceCategory && !categories.includes(feed.forceCategory as never)
    ? ([feed.forceCategory, ...categories] as NewsItem['categories'])
    : categories;

  return {
    id: hash(entry.link),
    title: entry.title,
    url: entry.link,
    publishedAt: entry.publishedAt,
    outlet: feed.outlet,
    sourceType,
    countries,
    categories: finalCategories,
    summary,
    matchedBy,
  };
}

/** Fetches and parses one RSS/Atom feed. */
export async function fetchFeed(feed: FeedDef): Promise<Fetched<NewsItem[]>> {
  const started = Date.now();
  try {
    const res = await timedFetch(feed.url, {
      accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    });
    if (!res.ok) {
      return { data: [], health: health(feed.id, feed.outlet.name, feed.url, started, false, 0, `HTTP ${res.status}`) };
    }
    const xml = await res.text();
    const items = parseFeed(xml)
      .map((e) => toNewsItem(e, feed))
      .filter((i): i is NewsItem => i !== null);
    return {
      data: items,
      health: health(feed.id, feed.outlet.name, feed.url, started, true, items.length, null),
    };
  } catch (err) {
    const msg = err instanceof Error ? (err.name === 'AbortError' ? 'timed out' : err.message) : String(err);
    return { data: [], health: health(feed.id, feed.outlet.name, feed.url, started, false, 0, msg) };
  }
}

/**
 * Reddit, read through the Atom feed rather than the JSON API: the .json
 * endpoints return 403 to datacenter IPs, which is where this worker runs.
 *
 * Reddit is never treated as confirmation of anything. Items are tagged
 * sourceType 'reddit' and excluded from the independence count.
 */
export const SUBREDDITS = ['worldnews', 'geopolitics', 'UpliftingNews'] as const;

export async function fetchSubreddit(sub: string): Promise<Fetched<NewsItem[]>> {
  const started = Date.now();
  const url = `https://www.reddit.com/r/${sub}/new/.rss?limit=50`;
  const id = `reddit-${sub.toLowerCase()}`;
  try {
    const res = await timedFetch(url);
    if (!res.ok) {
      return { data: [], health: health(id, `r/${sub}`, url, started, false, 0, `HTTP ${res.status}`) };
    }
    const entries = parseFeed(await res.text());
    const items: NewsItem[] = [];
    for (const e of entries) {
      if (!e.publishedAt) continue;
      const summary = e.summary ? cleanText(e.summary).slice(0, 300) : null;
      const { categories } = categorize(e.title, summary);
      const { countries, matchedBy } = matchCountries(e.title, summary);
      items.push({
        id: hash(e.link),
        title: e.title,
        url: e.link,
        publishedAt: e.publishedAt,
        outlet: { domain: `reddit.com/r/${sub}`, name: `r/${sub}`, owner: 'reddit', country: null },
        sourceType: 'reddit',
        countries,
        categories,
        summary,
        matchedBy,
      });
    }
    return { data: items, health: health(id, `r/${sub}`, url, started, true, items.length, null) };
  } catch (err) {
    const msg = err instanceof Error ? (err.name === 'AbortError' ? 'timed out' : err.message) : String(err);
    return { data: [], health: health(id, `r/${sub}`, url, started, false, 0, msg) };
  }
}

/**
 * GDELT DOC 2.0. Broadens outlet coverage well beyond the hand-picked feeds,
 * which is what makes the two-independent-outlet rule reachable for countries
 * the big English outlets ignore.
 *
 * GDELT rate-limits hard and returns plain-text errors with HTTP 200, so this
 * is strictly best-effort: a failure degrades coverage and is reported in
 * /api/health, but never breaks a refresh.
 */
export async function fetchGdelt(query: string, maxRecords = 75): Promise<Fetched<NewsItem[]>> {
  const started = Date.now();
  const url =
    'https://api.gdeltproject.org/api/v2/doc/doc?' +
    new URLSearchParams({
      query: `${query} sourcelang:eng`,
      mode: 'artlist',
      maxrecords: String(maxRecords),
      format: 'json',
      sort: 'datedesc',
      timespan: '24h',
    });
  try {
    const res = await timedFetch(url);
    const text = await res.text();
    if (!res.ok) {
      return { data: [], health: health('gdelt-doc', 'GDELT DOC 2.0', url, started, false, 0, `HTTP ${res.status}`) };
    }
    // GDELT answers malformed or throttled queries with a bare message.
    if (!text.trimStart().startsWith('{')) {
      return {
        data: [],
        health: health('gdelt-doc', 'GDELT DOC 2.0', url, started, false, 0, text.slice(0, 120).trim()),
      };
    }
    const json = JSON.parse(text) as {
      articles?: Array<{ url?: string; title?: string; seendate?: string; domain?: string; sourcecountry?: string }>;
    };
    const items: NewsItem[] = [];
    for (const a of json.articles ?? []) {
      if (!a.url || !a.title || !a.seendate) continue;
      const publishedAt = parseFeedDate(a.seendate);
      if (!publishedAt) continue;
      const domain = a.domain ?? hostOf(a.url);
      if (!domain) continue;
      const title = cleanText(a.title);
      if (!title) continue;
      const { categories } = categorize(title, null);
      const { countries, matchedBy } = matchCountries(title, null);
      items.push({
        id: hash(a.url),
        title,
        url: a.url,
        publishedAt,
        // sourcecountry is where the publisher sits, so it is recorded on the
        // outlet, not used to decide what the story is about.
        outlet: resolveOutlet(domain, a.sourcecountry ?? null),
        sourceType: 'news',
        countries,
        categories,
        summary: null,
        matchedBy,
      });
    }
    return { data: items, health: health('gdelt-doc', 'GDELT DOC 2.0', url, started, true, items.length, null) };
  } catch (err) {
    const msg = err instanceof Error ? (err.name === 'AbortError' ? 'timed out' : err.message) : String(err);
    return { data: [], health: health('gdelt-doc', 'GDELT DOC 2.0', url, started, false, 0, msg) };
  }
}

/** All text-news feeds, fetched together. */
export const newsFeeds = () => NEWS_FEEDS;
/** All broadcaster channel feeds. */
export const tvFeeds = () => TV_FEEDS;
