/** Shared shapes for every data type the worker caches and serves. */

export type Category =
  | 'war'
  | 'politics'
  | 'economy'
  | 'energy'
  | 'disasters'
  | 'good'
  | 'press';

export type SourceType = 'news' | 'reddit' | 'tv' | 'press';

export type ConflictStatus = 'war' | 'conflict' | 'tension' | 'peace' | 'unknown';

/** Every fact the app shows carries where it came from and when. */
export interface Provenance {
  /** Human-readable name of the originating dataset or outlet. */
  source: string;
  /** Link a reader can open to check the claim. */
  url: string | null;
  /** ISO 8601. When the source published or last revised the value. */
  retrievedAt: string;
}

export interface Outlet {
  /** Registrable domain, e.g. "bbc.co.uk". Used as the identity key. */
  domain: string;
  /** Display name, e.g. "BBC News". */
  name: string;
  /**
   * Ownership group. Two items only count as independent confirmation when
   * their owners differ, so wire copy republished across one group does not
   * masquerade as corroboration.
   */
  owner: string;
  country: string | null;
}

export interface NewsItem {
  /** Stable hash of the normalized title; survives cache rebuilds. */
  id: string;
  title: string;
  url: string;
  /** ISO 8601 publication time as reported by the source. */
  publishedAt: string;
  outlet: Outlet;
  sourceType: SourceType;
  /** ISO 3166-1 alpha-2 codes this item was matched to. */
  countries: string[];
  categories: Category[];
  summary: string | null;
  /** Which matcher rule attached this item to its countries. */
  matchedBy: string;
}

/**
 * A story is one event, with every outlet that covered it. Grouping happens on
 * title similarity, so "most reported" counts distinct owners, not articles.
 */
export interface Story {
  id: string;
  title: string;
  /** The earliest-published member, used as the canonical link. */
  primary: NewsItem;
  items: NewsItem[];
  countries: string[];
  categories: Category[];
  /** Distinct ownership groups covering this story. */
  outletCount: number;
  /** Newest publication time across members. */
  latestAt: string;
  /** Oldest publication time across members. */
  firstSeenAt: string;
  /**
   * 'confirmed' needs two or more independently owned news outlets.
   * Reddit and TV never raise confidence; they are discussion and broadcast
   * records respectively.
   */
  confidence: 'confirmed' | 'single-source';
  /** Blended recency and breadth score used by the "most relevant" sort. */
  relevance: number;
}

export interface Leader {
  countryIso2: string;
  /** Office label exactly as Wikidata gives it, e.g. "President of Ukraine". */
  position: string;
  name: string;
  /** ISO 8601 date the term began, when Wikidata records one. */
  since: string | null;
  wikidataId: string;
  provenance: Provenance;
}

export interface ConflictParty {
  name: string;
  /** Present when the party is a state we can place on the globe. */
  iso2: string | null;
}

export interface ConflictRecord {
  countryIso2: string;
  status: ConflictStatus;
  /** Named conflicts the dataset attributes to this country. */
  conflicts: Array<{
    name: string;
    sideA: ConflictParty[];
    sideB: ConflictParty[];
    /** Deaths recorded by the dataset for the window it covers. */
    deaths: number | null;
    /** Dataset's own classification, passed through unaltered. */
    typeOfViolence: string | null;
    startDate: string | null;
    latestEventDate: string | null;
  }>;
  /** Why this country carries this status. Shown to the reader verbatim. */
  basis: 'dataset' | 'two-outlet' | 'none';
  /** The dataset rows or story ids that justify `basis`. */
  evidence: Provenance[];
  provenance: Provenance;
}

export interface Relation {
  countryIso2: string;
  /** Multilateral bodies this country belongs to, from Wikidata P463. */
  organizations: Array<{ name: string; wikidataId: string; abbreviation: string | null }>;
  /** Diplomatic relations recorded by Wikidata (P530). */
  allies: Array<{ iso2: string; name: string; basis: string }>;
  /** Only populated where a named dataset puts the two on opposing sides. */
  adversaries: Array<{ iso2: string; name: string; basis: string }>;
  provenance: Provenance;
}

export interface PriceQuote {
  key: 'brent' | 'wti' | 'natgas';
  label: string;
  value: number;
  unit: string;
  currency: string;
  /** Change versus the previous close, when the source reports one. */
  changePct: number | null;
  /** ISO 8601 timestamp the source attaches to this value. */
  asOf: string;
  provenance: Provenance;
}

export interface CountryStatusEntry {
  iso2: string;
  status: ConflictStatus;
  basis: ConflictRecord['basis'];
  /** Story count in the last 24h, used for the "amount of news" sort. */
  newsCount24h: number;
}

/** Wrapper stamped on every cached blob so the UI can show and judge staleness. */
export interface Cached<T> {
  data: T;
  /** When the worker wrote this blob. */
  updatedAt: string;
  /** Seconds after which the UI marks this blob stale. */
  ttlSeconds: number;
  /** Per-source outcomes from the refresh that produced this blob. */
  sources: SourceHealth[];
}

export interface SourceHealth {
  id: string;
  name: string;
  url: string;
  ok: boolean;
  /** Records parsed from a successful fetch. */
  count: number;
  /** Populated only when ok is false. Surfaced to the reader. */
  error: string | null;
  ms: number;
  checkedAt: string;
}
