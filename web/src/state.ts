/**
 * App state, mirrored into the URL.
 *
 * The URL is the single source of truth for anything shareable: the selected
 * country, every filter, the sort order and the time range. That makes "copy
 * link" work for any view without a separate share mechanism, and makes back
 * and forward behave the way a reader expects.
 */

export type SortKey = 'newest' | 'reported' | 'relevant';

export interface AppState {
  country: string | null;
  categories: string[];
  regions: string[];
  sourceTypes: string[];
  outlets: string[];
  statuses: string[];
  /** Hours: 1, 24, 168, 720. */
  since: number;
  sort: SortKey;
  minScore: number | null;
  confirmedOnly: boolean;
  search: string;
  /** Country list ordering in the rail. */
  countrySort: 'name' | 'status' | 'news';
}

export const DEFAULT_STATE: AppState = {
  country: null,
  categories: [],
  regions: [],
  sourceTypes: [],
  outlets: [],
  statuses: [],
  since: 24,
  sort: 'newest',
  minScore: null,
  confirmedOnly: false,
  search: '',
  countrySort: 'status',
};

const LIST_KEYS = ['categories', 'regions', 'sourceTypes', 'outlets', 'statuses'] as const;

/** Short query-string names, so a shared link stays readable. */
const PARAM = {
  country: 'c',
  categories: 'cat',
  regions: 'region',
  sourceTypes: 'src',
  outlets: 'outlet',
  statuses: 'status',
  since: 'since',
  sort: 'sort',
  minScore: 'score',
  confirmedOnly: 'confirmed',
  search: 'q',
  countrySort: 'csort',
} as const satisfies Record<keyof AppState, string>;

const VALID_SINCE = new Set([1, 24, 168, 720]);
const VALID_SORT = new Set<SortKey>(['newest', 'reported', 'relevant']);
const VALID_COUNTRY_SORT = new Set(['name', 'status', 'news']);

export function readState(search = window.location.search): AppState {
  const p = new URLSearchParams(search);
  const list = (key: string) =>
    (p.get(key) ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  const since = Number(p.get(PARAM.since));
  const sort = p.get(PARAM.sort) as SortKey | null;
  const csort = p.get(PARAM.countrySort);
  const score = Number(p.get(PARAM.minScore));
  const country = p.get(PARAM.country);

  return {
    // ISO codes are uppercase everywhere internally, whatever the link said.
    country: country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : null,
    categories: list(PARAM.categories),
    regions: list(PARAM.regions),
    sourceTypes: list(PARAM.sourceTypes),
    outlets: list(PARAM.outlets),
    statuses: list(PARAM.statuses),
    since: VALID_SINCE.has(since) ? since : DEFAULT_STATE.since,
    sort: sort && VALID_SORT.has(sort) ? sort : DEFAULT_STATE.sort,
    minScore: Number.isFinite(score) && score > 0 ? Math.min(100, score) : null,
    confirmedOnly: p.get(PARAM.confirmedOnly) === '1',
    search: p.get(PARAM.search) ?? '',
    countrySort: csort && VALID_COUNTRY_SORT.has(csort)
      ? (csort as AppState['countrySort'])
      : DEFAULT_STATE.countrySort,
  };
}

/** Serialises state to a query string, omitting anything at its default. */
export function toSearch(state: AppState): string {
  const p = new URLSearchParams();
  if (state.country) p.set(PARAM.country, state.country);
  for (const key of LIST_KEYS) {
    const v = state[key];
    if (v.length) p.set(PARAM[key]!, v.join(','));
  }
  if (state.since !== DEFAULT_STATE.since) p.set(PARAM.since, String(state.since));
  if (state.sort !== DEFAULT_STATE.sort) p.set(PARAM.sort, state.sort);
  if (state.minScore != null) p.set(PARAM.minScore, String(state.minScore));
  if (state.confirmedOnly) p.set(PARAM.confirmedOnly, '1');
  if (state.search) p.set(PARAM.search, state.search);
  if (state.countrySort !== DEFAULT_STATE.countrySort) p.set(PARAM.countrySort, state.countrySort);
  const s = p.toString();
  return s ? `?${s}` : '';
}

type Listener = (state: AppState, previous: AppState) => void;

/**
 * Holds state, writes it to the URL and notifies subscribers.
 *
 * Navigations that change the selected country push a history entry, so Back
 * closes the panel. Filter changes replace the entry instead, so Back is not
 * a trail of every chip the reader tapped.
 */
export class Store {
  private state: AppState;
  private listeners = new Set<Listener>();

  constructor() {
    this.state = readState();
    window.addEventListener('popstate', () => {
      const previous = this.state;
      this.state = readState();
      this.emit(previous);
    });
  }

  get(): AppState {
    return this.state;
  }

  /** Merges a patch. `push` controls whether a history entry is created. */
  set(patch: Partial<AppState>, push = false): void {
    const previous = this.state;
    const next = { ...this.state, ...patch };
    const search = toSearch(next);
    if (search === toSearch(previous) ) {
      // Nothing shareable changed; skip the history write but still notify,
      // since non-URL-backed internals may have moved.
      this.state = next;
      this.emit(previous);
      return;
    }
    this.state = next;
    const url = `${window.location.pathname}${search}`;
    if (push) window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
    this.emit(previous);
  }

  /** Clears every filter but keeps the selected country. */
  clearFilters(): void {
    this.set({
      categories: [],
      regions: [],
      sourceTypes: [],
      outlets: [],
      statuses: [],
      since: DEFAULT_STATE.since,
      sort: DEFAULT_STATE.sort,
      minScore: null,
      confirmedOnly: false,
      search: '',
    });
  }

  /** Adds or removes one value from a list filter. */
  toggleIn(key: (typeof LIST_KEYS)[number], value: string): void {
    const current = this.state[key];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    this.set({ [key]: next } as Partial<AppState>);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(previous: AppState): void {
    for (const fn of this.listeners) fn(this.state, previous);
  }
}

/** True when any filter is away from its default. */
export function hasActiveFilters(s: AppState): boolean {
  return (
    s.categories.length > 0 ||
    s.regions.length > 0 ||
    s.sourceTypes.length > 0 ||
    s.outlets.length > 0 ||
    s.statuses.length > 0 ||
    s.since !== DEFAULT_STATE.since ||
    s.sort !== DEFAULT_STATE.sort ||
    s.minScore != null ||
    s.confirmedOnly ||
    s.search.length > 0
  );
}

/** Builds the query string the API expects from app state. */
export function toApiQuery(s: AppState, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  if (s.categories.length) p.set('category', s.categories.join(','));
  if (s.regions.length) p.set('region', s.regions.join(','));
  if (s.sourceTypes.length) p.set('sourceType', s.sourceTypes.join(','));
  if (s.outlets.length) p.set('outlet', s.outlets.join(','));
  p.set('since', String(s.since));
  p.set('sort', s.sort);
  if (s.minScore != null) p.set('minScore', String(s.minScore));
  if (s.confirmedOnly) p.set('confirmed', '1');
  if (s.search) p.set('q', s.search);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p.toString();
}
