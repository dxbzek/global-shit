/**
 * Minimal feed reader for RSS 2.0, RDF/RSS 1.0 and Atom.
 *
 * Workers have no DOMParser, and a full XML library costs more CPU than the
 * cron budget allows across ~20 feeds, so this walks the markup with regexes.
 * That is tolerable because the shape it needs is shallow: a repeated item
 * element with a handful of leaf children.
 */

export interface FeedEntry {
  title: string;
  link: string;
  /** Raw date string exactly as the feed gave it, before parsing. */
  dateRaw: string | null;
  /** Parsed ISO 8601, or null when the feed's date could not be read. */
  publishedAt: string | null;
  summary: string | null;
  categories: string[];
  author: string | null;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ccedil: 'ç',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  szlig: 'ß',
  pound: '£',
  euro: '€',
  deg: '°',
  times: '×',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Strips tags, unwraps CDATA, decodes entities and collapses whitespace. */
export function cleanText(raw: string | null | undefined): string {
  if (!raw) return '';
  return decodeEntities(
    raw
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** First matching leaf element's inner text, namespace prefix optional. */
function tag(block: string, ...names: string[]): string | null {
  for (const name of names) {
    const re = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i');
    const m = re.exec(block);
    if (m?.[1] != null) {
      const text = cleanText(m[1]);
      if (text) return text;
    }
  }
  return null;
}

/** All matching leaf elements' inner texts. */
function tagAll(block: string, name: string): string[] {
  const re = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'gi');
  const out: string[] = [];
  for (const m of block.matchAll(re)) {
    const text = cleanText(m[1]);
    if (text) out.push(text);
  }
  return out;
}

/** An attribute value from the first element of the given name. */
function attr(block: string, name: string, attribute: string): string | null {
  const re = new RegExp(`<(?:[\\w-]+:)?${name}\\b([^>]*)>`, 'i');
  const m = re.exec(block);
  if (!m?.[1]) return null;
  const am = new RegExp(`${attribute}\\s*=\\s*["']([^"']*)["']`, 'i').exec(m[1]);
  return am?.[1] ? decodeEntities(am[1]) : null;
}

/**
 * Atom links appear several times per entry with different rel values; the
 * readable article is rel="alternate" or the first link with no rel at all.
 */
function atomLink(block: string): string | null {
  const links = [...block.matchAll(/<(?:[\w-]+:)?link\b([^>]*)\/?>/gi)];
  let fallback: string | null = null;
  for (const m of links) {
    const raw = m[1] ?? '';
    const href = /href\s*=\s*["']([^"']*)["']/i.exec(raw)?.[1];
    if (!href) continue;
    const rel = /rel\s*=\s*["']([^"']*)["']/i.exec(raw)?.[1];
    if (!rel || rel === 'alternate') return decodeEntities(href);
    fallback ??= decodeEntities(href);
  }
  return fallback;
}

/**
 * Parses a feed date. Covers RFC 822 (RSS), ISO 8601 (Atom) and the
 * loose variants outlets actually emit. Returns null rather than guessing,
 * so an unreadable date surfaces as missing instead of as "now".
 */
export function parseFeedDate(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const direct = new Date(trimmed);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();

  // GDELT's compact form: 20261030T143000Z
  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(trimmed);
  if (compact) {
    const [, y, mo, d, h, mi, s] = compact;
    const dt = new Date(Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!));
    if (!Number.isNaN(dt.getTime())) return dt.toISOString();
  }

  // Bare date, e.g. "2026-10-30". Treated as UTC midnight.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const dt = new Date(`${trimmed}T00:00:00Z`);
    if (!Number.isNaN(dt.getTime())) return dt.toISOString();
  }

  // Timezone names some feeds use that Date rejects.
  const named = trimmed.replace(/\b(GMT|UTC|UT|Z)\b\s*$/i, '+0000');
  if (named !== trimmed) {
    const dt = new Date(named);
    if (!Number.isNaN(dt.getTime())) return dt.toISOString();
  }

  return null;
}

/**
 * Splits a feed document into entries and reads the fields the app needs.
 * Unknown or malformed entries are dropped rather than half-populated.
 */
export function parseFeed(xml: string): FeedEntry[] {
  const isAtom = /<entry[\s>]/i.test(xml) && !/<item[\s>]/i.test(xml);
  const itemRe = isAtom
    ? /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi
    : /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;

  const out: FeedEntry[] = [];
  for (const m of xml.matchAll(itemRe)) {
    const block = m[1];
    if (!block) continue;

    const title = tag(block, 'title');
    if (!title) continue;

    // RSS puts the URL in <link>text</link>; Atom in <link href="...">.
    const link = isAtom
      ? atomLink(block)
      : tag(block, 'link') ?? attr(block, 'link', 'href') ?? tag(block, 'guid');
    if (!link || !/^https?:\/\//i.test(link)) continue;

    const dateRaw =
      tag(block, 'pubDate', 'published', 'updated', 'date', 'issued') ?? null;

    out.push({
      title,
      link,
      dateRaw,
      publishedAt: parseFeedDate(dateRaw),
      summary: tag(block, 'description', 'summary', 'content', 'encoded') || null,
      categories: tagAll(block, 'category'),
      author: tag(block, 'creator', 'author', 'name'),
    });
  }
  return out;
}

/** Registrable-ish domain from a URL, or null if the URL will not parse. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}
