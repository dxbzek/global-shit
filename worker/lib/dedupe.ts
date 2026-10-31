import type { NewsItem, Story } from '../types';

/**
 * Collapses many outlets' coverage of one event into a single Story.
 *
 * This matters twice over: it stops the feed repeating itself, and it is what
 * makes "covered by N outlets" meaningful. Without it, wire copy republished
 * by thirty sites would read as thirty separate events.
 */

/** Words too common to help identify a story. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for',
  'with', 'from', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'has',
  'have', 'had', 'will', 'would', 'can', 'could', 'may', 'might', 'this',
  'that', 'these', 'those', 'it', 'its', 'he', 'she', 'they', 'them', 'his',
  'her', 'their', 'after', 'before', 'over', 'under', 'into', 'about', 'says',
  'said', 'say', 'new', 'more', 'than', 'up', 'down', 'out', 'off', 'who',
  'what', 'when', 'where', 'why', 'how', 'not', 'no', 'all', 'live', 'video',
  'watch', 'latest', 'update', 'updates', 'breaking', 'news', 'report',
  'reports', 'analysis', 'opinion', 'exclusive',
]);

/** Significant lowercase tokens from a headline. */
function tokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[‘’“”]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/** Jaccard overlap of two token sets. */
function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Small stable hash, used for ids that survive cache rebuilds. */
export function hash(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (((h2 >>> 0) * 4294967296 + (h1 >>> 0)) >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

/** Normalized title used to spot exact duplicates cheaply. */
export function titleKey(title: string): string {
  return tokens(title).sort().join(' ');
}

/**
 * Two headlines are the same story at >= 0.42 token overlap. The threshold was
 * chosen to merge the same event across outlets ("Russia launches drone attack
 * on Kyiv" / "Drone attack on Kyiv kills two, Ukraine says") while keeping
 * separate events in one country apart.
 */
const MERGE_THRESHOLD = 0.42;

/** Items this far apart in time are different events even if worded alike. */
const MERGE_WINDOW_MS = 36 * 60 * 60 * 1000;

export function clusterStories(items: NewsItem[]): Story[] {
  // Newest first, so the earliest-published member is appended last and the
  // cluster's canonical link can be chosen deterministically.
  const sorted = [...items].sort(
    (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
  );

  interface Cluster {
    members: NewsItem[];
    tokens: Set<string>;
    newestMs: number;
  }
  const clusters: Cluster[] = [];
  const byExactTitle = new Map<string, Cluster>();

  /*
   * Inverted index from token to the clusters containing it.
   *
   * Comparing each item against every open cluster is O(items x clusters),
   * which was fine at a few hundred items and is not at several thousand. Two
   * headlines cannot reach the merge threshold without sharing at least one
   * significant token, so only clusters that share a token are candidates.
   * That turns the scan into roughly linear work.
   */
  const index = new Map<string, Set<Cluster>>();
  const addToIndex = (cluster: Cluster, tokenSet: Iterable<string>) => {
    for (const token of tokenSet) {
      let bucket = index.get(token);
      if (!bucket) index.set(token, (bucket = new Set()));
      bucket.add(cluster);
    }
  };

  for (const item of sorted) {
    const key = titleKey(item.title);
    const exact = byExactTitle.get(key);
    if (exact) {
      exact.members.push(item);
      continue;
    }

    const tk = new Set(tokens(item.title));
    const ms = Date.parse(item.publishedAt);

    // Candidates: clusters sharing at least one token with this headline.
    const candidates = new Set<Cluster>();
    for (const token of tk) {
      const bucket = index.get(token);
      if (!bucket) continue;
      for (const cluster of bucket) candidates.add(cluster);
    }

    let best: Cluster | null = null;
    let bestScore = 0;
    for (const c of candidates) {
      if (Math.abs(c.newestMs - ms) > MERGE_WINDOW_MS) continue;
      const score = similarity(tk, c.tokens);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }

    if (best && bestScore >= MERGE_THRESHOLD) {
      best.members.push(item);
      // Widen the cluster's vocabulary so later variants still match, and
      // index the new tokens so they can be found by it.
      const added: string[] = [];
      for (const t of tk) {
        if (!best.tokens.has(t)) {
          best.tokens.add(t);
          added.push(t);
        }
      }
      addToIndex(best, added);
      continue;
    }

    const fresh: Cluster = { members: [item], tokens: tk, newestMs: ms };
    clusters.push(fresh);
    byExactTitle.set(key, fresh);
    addToIndex(fresh, tk);
  }

  return clusters.map(toStory);
}

function toStory(cluster: { members: NewsItem[] }): Story {
  const members = cluster.members;
  const byTime = [...members].sort(
    (a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt),
  );
  const earliest = byTime[0]!;
  const latest = byTime[byTime.length - 1]!;

  // Prefer a text-news member as the canonical item, so a story's main link
  // is an article rather than a Reddit thread or a video.
  const primary = members.find((m) => m.sourceType === 'news') ?? earliest;

  /*
   * Independence rule. Only text news counts towards confirmation, and only
   * one vote per ownership group: outlets under a single owner, and wire copy
   * reprinted across a group, are not corroboration. Reddit is discussion and
   * TV entries are broadcast records; neither ever raises confidence.
   */
  const newsOwners = new Set(
    members.filter((m) => m.sourceType === 'news').map((m) => m.outlet.owner),
  );
  const confidence: Story['confidence'] = newsOwners.size >= 2 ? 'confirmed' : 'single-source';

  const countries = [...new Set(members.flatMap((m) => m.countries))];
  const primaryCountries = [
    ...new Set(members.map((m) => m.primaryCountry).filter((c): c is string => c !== null)),
  ];
  const categories = [...new Set(members.flatMap((m) => m.categories))];

  /*
   * Relevance blends breadth with recency: how many independent owners carried
   * it, decayed by age with a 12-hour half-life. A story everyone ran an hour
   * ago outranks one a single outlet ran yesterday.
   */
  const ageHours = (Date.now() - Date.parse(latest.publishedAt)) / 3_600_000;
  const recency = Math.pow(0.5, Math.max(0, ageHours) / 12);
  const relevance = Number(((newsOwners.size + 1) * recency).toFixed(4));

  return {
    id: hash(titleKey(primary.title) || primary.url),
    title: primary.title,
    primary,
    items: [...members].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)),
    countries,
    primaryCountries,
    categories,
    outletCount: newsOwners.size,
    latestAt: latest.publishedAt,
    firstSeenAt: earliest.publishedAt,
    confidence,
    relevance,
  };
}

/** Distinct ownership groups among a story's text-news members. */
export function independentOwners(story: Story): string[] {
  return [
    ...new Set(story.items.filter((i) => i.sourceType === 'news').map((i) => i.outlet.owner)),
  ];
}
