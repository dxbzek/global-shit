import { COUNTRY_LIST, COUNTRIES, type CountryRef } from './countries.generated';

/**
 * Attaches countries to a piece of text.
 *
 * Country tagging is done here rather than taken from an upstream field,
 * because the upstream fields available mean different things: GDELT's
 * sourcecountry is where the *publisher* sits, not what the story is about,
 * and RSS feeds carry no country at all. Matching the text gives one
 * consistent, explainable rule across every source.
 */

interface Matcher {
  iso2: string;
  /** Lowercased needle. */
  needle: string;
  /**
   * Confidence weight. Full country names and capitals are strong signals;
   * demonyms are slightly weaker because they also appear in compounds.
   */
  weight: number;
  kind: 'name' | 'capital' | 'demonym';
  /** When true, this needle only counts alongside another country signal. */
  requireContext: boolean;
}

/**
 * Needles that are ordinary English words or that collide with places
 * elsewhere. Matching these alone produces obvious nonsense ("turkey" in a
 * food story, "Chad" as a given name), so they never stand on their own.
 */
const AMBIGUOUS = new Set([
  'chad', 'chile', 'georgia', 'jordan', 'mali', 'niger', 'turkey', 'china',
  'guinea', 'india', 'iran', 'oman', 'palau', 'samoa', 'tonga', 'malta',
  'cuba', 'fiji', 'laos', 'peru', 'togo', 'iraq', 'cyprus', 'jersey',
  'union', 'victoria', 'santiago', 'san marino', 'canada', 'panama',
  'armenia', 'colombia', 'nigeria', 'somalia', 'romania', 'slovenia',
]);

const MATCHERS: Matcher[] = (() => {
  const out: Matcher[] = [];
  const seen = new Set<string>();

  const push = (iso2: string, raw: string | null, kind: Matcher['kind'], weight: number, force = false) => {
    if (!raw) return;
    const needle = raw.trim().toLowerCase();
    // One- and two-character needles match far too much to be useful.
    if (needle.length < 3) return;
    const key = `${iso2}|${needle}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      iso2,
      needle,
      weight,
      kind,
      requireContext: force || AMBIGUOUS.has(needle),
    });
  };

  for (const c of COUNTRY_LIST) {
    for (const n of c.match.names) push(c.iso2, n, 'name', 3, c.match.requireContext);
    push(c.iso2, c.capital, 'capital', 2);
    for (const d of c.match.demonyms) push(c.iso2, d, 'demonym', 2);
  }

  // Longest first, so "South Korea" wins over "Korea" and "South Sudan" over
  // "Sudan" when both would match the same span.
  return out.sort((a, b) => b.needle.length - a.needle.length);
})();

/** True when the needle sits on word boundaries, not inside a longer word. */
function hasWord(haystack: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? ' ' : haystack[at - 1]!;
    const after = at + needle.length >= haystack.length ? ' ' : haystack[at + needle.length]!;
    // Allow possessives and plurals: "Ukraine's", "Israelis".
    if (!/[a-z0-9]/.test(before) && (!/[a-z0-9]/.test(after) || after === 's')) return true;
    from = at + 1;
  }
}

export interface MatchResult {
  countries: string[];
  /**
   * The leading country matched in the TITLE, or null when every match came
   * from the summary. This is the only country a story can be evidence
   * *about*: a country named in the summary is context, and one named second
   * in the headline is usually a destination, a commentator or a bystander.
   */
  primary: string | null;
  /** Short description of why, shown in the UI so a tag can be judged. */
  matchedBy: string;
}

/**
 * Finds the countries a headline is about.
 *
 * The title is weighted above the summary: a country named in the headline is
 * usually the subject, while one named deep in a summary is often incidental.
 */
export function matchCountries(title: string, summary?: string | null): MatchResult {
  const t = ` ${title.toLowerCase()} `;
  const s = summary ? ` ${summary.toLowerCase().slice(0, 600)} ` : '';

  const scores = new Map<string, number>();
  const reasons = new Map<string, string>();
  const titleHits = new Map<string, number>();
  const contextual: Matcher[] = [];

  for (const m of MATCHERS) {
    const inTitle = hasWord(t, m.needle);
    const inSummary = !inTitle && s ? hasWord(s, m.needle) : false;
    if (!inTitle && !inSummary) continue;

    if (m.requireContext) {
      contextual.push(m);
      continue;
    }
    const gain = m.weight * (inTitle ? 2 : 1);
    scores.set(m.iso2, (scores.get(m.iso2) ?? 0) + gain);
    if (inTitle) titleHits.set(m.iso2, (titleHits.get(m.iso2) ?? 0) + m.weight);
    if (!reasons.has(m.iso2)) {
      reasons.set(m.iso2, `${m.kind} "${m.needle}" in ${inTitle ? 'title' : 'summary'}`);
    }
  }

  // Ambiguous needles count only once something unambiguous has already
  // matched, or when the needle appears in the headline with another
  // ambiguous one (two weak signals together are worth one real signal).
  const unambiguousHits = scores.size;
  for (const m of contextual) {
    const inTitle = hasWord(t, m.needle);
    const supported = unambiguousHits > 0 || contextual.length > 1;
    if (!supported) continue;
    const gain = (m.weight - 1) * (inTitle ? 2 : 1);
    scores.set(m.iso2, (scores.get(m.iso2) ?? 0) + gain);
    if (!reasons.has(m.iso2)) {
      reasons.set(m.iso2, `${m.kind} "${m.needle}" in ${inTitle ? 'title' : 'summary'} (with other country signals)`);
    }
  }

  if (!scores.size) return { countries: [], primary: null, matchedBy: 'no country matched' };

  // Keep the strong matches. A story mentioning eight countries in passing is
  // not "about" all eight, so only those within range of the best score stay.
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const best = ranked[0]![1];
  const kept = ranked.filter(([, v]) => v >= Math.max(2, best * 0.4)).slice(0, 6);

  // The leading title match, by title score alone; ties break on overall score.
  const primary =
    [...titleHits.entries()].sort((a, b) => b[1] - a[1] || (scores.get(b[0]) ?? 0) - (scores.get(a[0]) ?? 0))[0]?.[0] ?? null;

  return {
    countries: kept.map(([iso]) => iso),
    primary: primary && kept.some(([iso]) => iso === primary) ? primary : null,
    matchedBy: kept.map(([iso]) => `${iso}: ${reasons.get(iso)}`).join('; '),
  };
}

/** Case-insensitive lookup of a country by name, ISO alpha-2 or alpha-3. */
export function findCountry(query: string): CountryRef | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const upper = q.toUpperCase();
  if (COUNTRIES[upper]) return COUNTRIES[upper]!;
  for (const c of COUNTRY_LIST) {
    if (c.iso3.toLowerCase() === q) return c;
    if (c.match.names.some((n) => n.toLowerCase() === q)) return c;
  }
  return null;
}

export { COUNTRIES, COUNTRY_LIST };
export type { CountryRef };
