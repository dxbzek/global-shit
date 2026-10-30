// Cesium resolves its workers and assets against this at runtime. It must be
// set before the engine is imported, which is why it leads the file.
window.CESIUM_BASE_URL = CESIUM_BASE_URL;

import './styles/base.css';
import './styles/app.css';
import './styles/extra.css';

import { Globe, type ImagerySource, type Status } from './globe';
import { api, subscribeLive, ApiError, type AppMeta, type CountryRow, type StoryView } from './api';
import { Store, toApiQuery, DEFAULT_STATE, type AppState } from './state';
import { el, clear, $, timeEl, flag } from './ui/dom';
import { tickerItem, priceChip, priceMissing } from './ui/story';
import { panelSkeleton, renderPanel } from './ui/panel';

declare global {
  interface Window {
    CESIUM_BASE_URL: string;
  }
}

/**
 * Application shell.
 *
 * Data flow is one-way: the URL holds the shareable state, the store notifies
 * on change, and each render function reads the state it needs. The SSE stream
 * only ever triggers a refetch; it never pushes data straight into the DOM, so
 * there is one code path for both first load and live updates.
 */

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const isSmall = () => window.matchMedia('(max-width: 900px)').matches;

const store = new Store();
let appMeta: AppMeta | null = null;
let countries: CountryRow[] = [];
let countryByIso = new Map<string, CountryRow>();
let globe: Globe | null = null;
let panelEl: HTMLElement | null = null;
/** Guards against an out-of-order country response overwriting a newer one. */
let panelToken = 0;
let feedToken = 0;

const root = $('#app');
const toasts = $('#toasts');
const liveEl = $('#live');
const marketsEl = $('#markets');
const tickerTrack = $('#ticker-track');
const railEl = $('#rail');
const legendEl = $('#legend');
const hintBar = $('#hint-bar');
const hoverCard = $('#hover-card');
const searchInput = $<HTMLInputElement>('#search-input');
const searchResults = $('#search-results');
const announcer = $('#announcer');

// ---------------------------------------------------------------------------
// Toasts: the only place the app reports a failure to the reader
// ---------------------------------------------------------------------------

const shown = new Set<string>();

function toast(message: string, kind: 'info' | 'warn' | 'error' = 'info', key = message): void {
  // One toast per distinct problem, so a failing source does not spam.
  if (shown.has(key)) return;
  shown.add(key);

  const node = el('div', { class: 'toast', 'data-kind': kind, role: 'status' }, [
    el('span', { class: 'dot', 'data-status': kind === 'error' ? 'war' : kind === 'warn' ? 'tension' : 'peace' }),
    el('span', { text: message }),
  ]);
  const dismiss = el('button', { type: 'button', 'aria-label': 'Dismiss', class: 'toast-x' }, [
    el('span', { 'aria-hidden': 'true', text: '×' }),
  ]);
  dismiss.addEventListener('click', () => {
    node.remove();
    shown.delete(key);
  });
  node.append(dismiss);
  toasts.append(node);

  window.setTimeout(() => {
    node.remove();
    shown.delete(key);
  }, kind === 'error' ? 12_000 : 7000);
}

/** Polite announcement for screen readers when content changes live. */
const announce = (message: string): void => {
  announcer.textContent = message;
};

// ---------------------------------------------------------------------------
// Live state indicator
// ---------------------------------------------------------------------------

function setLive(state: 'connecting' | 'live' | 'stale' | 'down', detail?: string): void {
  liveEl.dataset.state = state === 'connecting' ? 'stale' : state;
  const label = { connecting: 'Connecting', live: 'Live', stale: 'Stale', down: 'Offline' }[state];
  $('#live-label', liveEl).textContent = label;
  liveEl.title = detail ?? `Data stream: ${label.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Market bar
// ---------------------------------------------------------------------------

async function renderMarkets(): Promise<void> {
  try {
    const { prices, meta } = await api.prices();
    clear(marketsEl);

    if (!prices.length) {
      const why =
        meta.sources.find((s) => !s.ok)?.error ??
        'No price source configured. Set EIA_API_KEY on the worker.';
      for (const label of ['Brent', 'WTI', 'Nat gas']) marketsEl.append(priceMissing(label, why));
      toast('Oil and gas prices unavailable: ' + why, 'warn', 'prices-down');
      return;
    }

    const order: Record<string, number> = { brent: 0, wti: 1, natgas: 2 };
    for (const p of [...prices].sort((a, b) => (order[a.key] ?? 9) - (order[b.key] ?? 9))) {
      marketsEl.append(priceChip(p));
    }

    // The bar carries its own updated time, since prices refresh on a slower
    // cadence than news and a reader should see which they are looking at.
    marketsEl.append(
      el('span', { class: 'market-meta', 'data-stale': meta.stale ? 'true' : undefined }, [
        meta.updatedAt ? timeEl(meta.updatedAt) : el('span', { text: 'never' }),
      ]),
    );
  } catch (err) {
    toast(`Could not load prices: ${(err as Error).message}`, 'warn', 'prices-error');
  }
}

// ---------------------------------------------------------------------------
// Ticker
// ---------------------------------------------------------------------------

function renderTicker(stories: StoryView[]): void {
  clear(tickerTrack);
  if (!stories.length) {
    tickerTrack.append(el('span', { class: 'ticker-item', text: 'No headlines match the current filters' }));
    tickerTrack.style.animation = 'none';
    return;
  }

  const items = stories.slice(0, 26);
  // The track holds two copies so the -50% marquee keyframe loops seamlessly.
  for (let pass = 0; pass < 2; pass++) {
    for (const s of items) {
      const node = tickerItem(s);
      if (pass === 1) node.setAttribute('aria-hidden', 'true');
      tickerTrack.append(node);
    }
  }

  if (reducedMotion) {
    tickerTrack.style.animation = 'none';
    return;
  }

  // Constant scroll speed regardless of how much text is in the track, so the
  // ticker never races or crawls depending on the news.
  requestAnimationFrame(() => {
    const width = tickerTrack.scrollWidth / 2;
    const pxPerSecond = 55;
    tickerTrack.style.animation = `marquee ${Math.max(28, width / pxPerSecond)}s linear infinite`;
  });
}

// ---------------------------------------------------------------------------
// Filter rail
// ---------------------------------------------------------------------------

function renderRail(state: AppState): void {
  if (!appMeta) return;
  clear(railEl);

  const group = (label: string, children: Node[]) =>
    el('div', { class: 'rail-group' }, [el('h3', { class: 'eyebrow', text: label }), ...children]);

  const chipRow = (
    items: Array<{ id: string; label: string }>,
    active: string[],
    onToggle: (id: string) => void,
    attr?: string,
  ) =>
    el(
      'div',
      { class: 'rail-chips' },
      items.map((item) => {
        const on = active.includes(item.id);
        const btn = el('button', {
          class: `chip${on ? ' is-active' : ''}`,
          type: 'button',
          'aria-pressed': String(on),
          ...(attr ? { [attr]: item.id } : {}),
        }, [el('span', { text: item.label })]);
        btn.addEventListener('click', () => onToggle(item.id));
        return btn;
      }),
    );

  // Active filters as removable chips, so what is applied is never a mystery.
  const active: Array<{ label: string; clear: () => void }> = [];
  for (const c of state.categories) {
    active.push({
      label: appMeta.categories.find((x) => x.id === c)?.label ?? c,
      clear: () => store.toggleIn('categories', c),
    });
  }
  for (const r of state.regions) active.push({ label: r, clear: () => store.toggleIn('regions', r) });
  for (const s of state.statuses) {
    active.push({
      label: appMeta.statuses.find((x) => x.id === s)?.label ?? s,
      clear: () => store.toggleIn('statuses', s),
    });
  }
  for (const t of state.sourceTypes) {
    active.push({
      label: appMeta.sourceTypes.find((x) => x.id === t)?.label ?? t,
      clear: () => store.toggleIn('sourceTypes', t),
    });
  }
  for (const o of state.outlets) active.push({ label: o, clear: () => store.toggleIn('outlets', o) });
  if (state.since !== DEFAULT_STATE.since) {
    active.push({
      label: appMeta.timeRanges.find((x) => x.id === state.since)?.label ?? `${state.since}h`,
      clear: () => store.set({ since: DEFAULT_STATE.since }),
    });
  }
  if (state.confirmedOnly) {
    active.push({ label: 'Confirmed only', clear: () => store.set({ confirmedOnly: false }) });
  }
  if (state.minScore != null) {
    active.push({ label: `Score ${state.minScore}+`, clear: () => store.set({ minScore: null }) });
  }
  if (state.search) {
    active.push({ label: `"${state.search}"`, clear: () => store.set({ search: '' }) });
  }

  if (active.length) {
    railEl.append(
      el('div', { class: 'rail-group' }, [
        el('div', { class: 'rail-group-head' }, [
          el('h3', { class: 'eyebrow', text: `${active.length} filter${active.length === 1 ? '' : 's'}` }),
          (() => {
            const btn = el('button', { class: 'clear-all', type: 'button', text: 'Clear all' });
            btn.addEventListener('click', () => store.clearFilters());
            return btn;
          })(),
        ]),
        el(
          'div',
          { class: 'active-filters' },
          active.map((f) =>
            el('span', { class: 'filter-chip' }, [
              el('span', { text: f.label }),
              (() => {
                const x = el('button', { type: 'button', 'aria-label': `Remove ${f.label} filter` }, [
                  el('span', { 'aria-hidden': 'true', text: '×' }),
                ]);
                x.addEventListener('click', f.clear);
                return x;
              })(),
            ]),
          ),
        ),
      ]),
    );
  }

  railEl.append(
    group('Category', [
      chipRow(appMeta.categories, state.categories, (id) => store.toggleIn('categories', id), 'data-cat'),
    ]),
    group('Time range', [
      chipRow(
        appMeta.timeRanges.map((t) => ({ id: String(t.id), label: t.label })),
        [String(state.since)],
        (id) => store.set({ since: Number(id) }),
      ),
    ]),
    group('Sort', [
      chipRow(
        [
          { id: 'newest', label: 'Newest' },
          { id: 'reported', label: 'Most reported' },
          { id: 'relevant', label: 'Most relevant' },
        ],
        [state.sort],
        (id) => store.set({ sort: id as AppState['sort'] }),
      ),
    ]),
    group('Accuracy', [
      chipRow(
        [
          { id: 'confirmed', label: 'Confirmed only' },
          { id: '50', label: 'Score 50+' },
          { id: '70', label: 'Score 70+' },
        ],
        [
          ...(state.confirmedOnly ? ['confirmed'] : []),
          ...(state.minScore != null ? [String(state.minScore)] : []),
        ],
        (id) => {
          if (id === 'confirmed') store.set({ confirmedOnly: !state.confirmedOnly });
          else store.set({ minScore: state.minScore === Number(id) ? null : Number(id) });
        },
      ),
    ]),
    group('Source type', [
      chipRow(appMeta.sourceTypes, state.sourceTypes, (id) => store.toggleIn('sourceTypes', id)),
    ]),
    group('Region', [
      chipRow(
        appMeta.regions.map((r) => ({ id: r, label: r })),
        state.regions,
        (id) => store.toggleIn('regions', id),
      ),
    ]),
    group('Country status', [
      chipRow(
        appMeta.statuses.filter((s) => s.id !== 'peace' || true),
        state.statuses,
        (id) => store.toggleIn('statuses', id),
      ),
    ]),
  );

  railEl.append(countryListGroup(state));
}

/** Sortable, filterable country list. Doubles as the globe's text equivalent. */
function countryListGroup(state: AppState): HTMLElement {
  const rows = countries
    .filter((c) => !state.statuses.length || state.statuses.includes(c.status))
    .filter((c) => !state.regions.length || (c.continent && state.regions.includes(c.continent)));

  const sorted = [...rows].sort((a, b) => {
    if (state.countrySort === 'news') return b.newsCount24h - a.newsCount24h || a.name.localeCompare(b.name);
    if (state.countrySort === 'status') {
      const rank: Record<string, number> = { war: 0, conflict: 1, tension: 2, peace: 3, unknown: 4 };
      return (rank[a.status] ?? 5) - (rank[b.status] ?? 5) || a.name.localeCompare(b.name);
    }
    return a.name.localeCompare(b.name);
  });

  const list = el('div', { class: 'country-list', role: 'list' });
  for (const c of sorted.slice(0, 80)) {
    const btn = el(
      'button',
      {
        class: `country-row${state.country === c.iso2 ? ' is-active' : ''}`,
        type: 'button',
        role: 'listitem',
        'data-status': c.status,
        title: c.reason ?? c.statusLabel,
      },
      [
        el('span', { class: 'dot', 'data-status': c.status }),
        el('span', { class: 'country-name', text: c.name }),
        el('span', { class: 'country-count num', text: c.newsCount24h ? String(c.newsCount24h) : '' }),
      ],
    );
    btn.addEventListener('click', () => selectCountry(c.iso2, { push: true }));
    list.append(btn);
  }

  const sortChips = el(
    'div',
    { class: 'rail-chips' },
    (
      [
        ['status', 'Status'],
        ['news', 'News'],
        ['name', 'Name'],
      ] as const
    ).map(([id, label]) => {
      const on = state.countrySort === id;
      const btn = el('button', { class: `chip${on ? ' is-active' : ''}`, type: 'button', 'aria-pressed': String(on) }, [
        el('span', { text: label }),
      ]);
      btn.addEventListener('click', () => store.set({ countrySort: id }));
      return btn;
    }),
  );

  return el('div', { class: 'rail-group' }, [
    el('div', { class: 'rail-group-head' }, [
      el('h3', { class: 'eyebrow', text: `Countries (${sorted.length})` }),
    ]),
    sortChips,
    list,
    sorted.length > 80 ? el('div', { class: 'detail', text: `Showing 80 of ${sorted.length}. Use search or filters.` }) : null,
  ]);
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

function renderLegend(state: AppState): void {
  if (!appMeta) return;
  clear(legendEl);

  const counts = new Map<string, number>();
  for (const c of countries) counts.set(c.status, (counts.get(c.status) ?? 0) + 1);

  legendEl.append(
    el('h3', { class: 'eyebrow', text: 'Country status' }),
    ...appMeta.statuses.map((s) => {
      const on = state.statuses.includes(s.id);
      const btn = el(
        'button',
        {
          class: `legend-row${on ? ' is-active' : ''}`,
          type: 'button',
          'data-status': s.id,
          'aria-pressed': String(on),
          title: `Show only countries marked "${s.label}"`,
        },
        [
          el('span', { class: 'dot', 'data-status': s.id }),
          el('span', { text: s.label }),
          el('span', { class: 'count num', text: String(counts.get(s.id) ?? 0) }),
        ],
      );
      btn.addEventListener('click', () => store.toggleIn('statuses', s.id));
      return btn;
    }),
    el('p', {
      class: 'legend-note',
      text:
        'Status comes from a named conflict dataset, or from two or more independently owned outlets. ' +
        '"No data" means neither supported a status. Click a country for the exact rule and its sources.',
    }),
  );
}

// ---------------------------------------------------------------------------
// Globe data
// ---------------------------------------------------------------------------

function statusMap(state: AppState): Map<string, Status> {
  const map = new Map<string, Status>();
  // Filtering the globe means dimming what is filtered out, not recolouring
  // it: a country excluded by a filter is shown as having no status rather
  // than being given a false one.
  const statusAllowed = (s: string) => !state.statuses.length || state.statuses.includes(s);
  const regionAllowed = (c: CountryRow) =>
    !state.regions.length || (c.continent != null && state.regions.includes(c.continent));

  for (const c of countries) {
    map.set(c.iso2, statusAllowed(c.status) && regionAllowed(c) ? c.status : 'unknown');
  }
  return map;
}

async function refreshCountries(state: AppState): Promise<void> {
  try {
    const { countries: rows } = await api.countries(`sort=${state.countrySort}`);
    countries = rows;
    countryByIso = new Map(rows.map((r) => [r.iso2, r]));
    globe?.setStatuses(statusMap(state));
    renderLegend(state);
    renderRail(state);
  } catch (err) {
    toast(`Could not load country status: ${(err as Error).message}`, 'error', 'countries-error');
  }
}

// ---------------------------------------------------------------------------
// Feed (ticker + pins)
// ---------------------------------------------------------------------------

async function refreshFeed(state: AppState): Promise<void> {
  const token = ++feedToken;
  try {
    const { stories, meta } = await api.feed(toApiQuery(state, { limit: '120' }));
    if (token !== feedToken) return;

    renderTicker(stories);

    // Pins: the countries with the most coverage right now, so the globe
    // shows where the news is without becoming a field of dots.
    const byCountry = new Map<string, { count: number; title: string }>();
    for (const s of stories) {
      for (const iso of s.countries) {
        const row = byCountry.get(iso) ?? { count: 0, title: s.title };
        row.count += 1;
        byCountry.set(iso, row);
      }
    }
    const pins = [...byCountry.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 40)
      .flatMap(([iso, row]) => {
        const country = countryByIso.get(iso);
        if (!country) return [];
        return [{
          iso2: iso,
          centroid: country.centroid,
          title: row.title,
          status: country.status as Status,
          count: row.count,
        }];
      });
    globe?.setPins(pins);

    setLive(meta.stale ? 'stale' : 'live', meta.updatedAt
      ? `News last updated ${new Date(meta.updatedAt).toLocaleTimeString()}`
      : undefined);

    const down = meta.sources.filter((s) => !s.ok);
    if (down.length) {
      toast(
        `${down.length} source${down.length === 1 ? '' : 's'} down: ${down.slice(0, 3).map((s) => s.name).join(', ')}`,
        'warn',
        `sources-down-${down.length}`,
      );
    }
  } catch (err) {
    if (token !== feedToken) return;
    if (err instanceof ApiError && err.status === 503) {
      setLive('stale', 'Waiting for the first ingest');
      renderTicker([]);
      toast('No data cached yet. The first ingest runs within a minute of deploy.', 'warn', 'no-data-yet');
      return;
    }
    setLive('down');
    toast(`Feed unavailable: ${(err as Error).message}`, 'error', 'feed-error');
  }
}

// ---------------------------------------------------------------------------
// Country selection
// ---------------------------------------------------------------------------

function closePanel(): void {
  panelEl?.remove();
  panelEl = null;
  globe?.select(null);
  globe?.clearLines();
  globe?.flyHome();
  store.set({ country: null }, true);
  searchInput.focus({ preventScroll: true });
}

async function selectCountry(iso2: string, opts: { push?: boolean; fly?: boolean } = {}): Promise<void> {
  const token = ++panelToken;
  const row = countryByIso.get(iso2);
  const name = row?.name ?? iso2;

  store.set({ country: iso2 }, opts.push ?? false);
  globe?.select(iso2);
  globe?.setIdleSpin(false);
  hintBar.hidden = true;

  if (opts.fly !== false && row) globe?.flyTo(row.bbox, row.centroid);

  // Skeleton first, so the click feels instant even on a slow network.
  const skeletonPanel = panelSkeleton(name, iso2, { onClose: closePanel, onOpenCountry: (c) => selectCountry(c, { push: true }) });
  panelEl?.remove();
  panelEl = skeletonPanel;
  root.append(skeletonPanel);
  installSheetDrag(skeletonPanel);

  try {
    const detail = await api.country(iso2, toApiQuery(store.get()));
    if (token !== panelToken) return;

    const rendered = renderPanel(detail, {
      onClose: closePanel,
      onOpenCountry: (c) => selectCountry(c, { push: true }),
    });
    panelEl?.remove();
    panelEl = rendered;
    root.append(rendered);
    installSheetDrag(rendered);
    rendered.focus({ preventScroll: true });

    // Alliance and adversary lines draw themselves onto the globe.
    if (detail.lines.length) {
      globe?.drawLines(detail.country.centroid, detail.lines.map((l) => ({ centroid: l.centroid, kind: l.kind })));
    } else {
      globe?.clearLines();
    }

    announce(`${detail.country.name}: ${detail.status.label}. ${detail.newsTotal} stories.`);
  } catch (err) {
    if (token !== panelToken) return;
    const message = err instanceof ApiError && err.status === 404
      ? 'No data for that country.'
      : `Could not load ${name}: ${(err as Error).message}`;
    toast(message, 'error', `country-${iso2}`);
    panelEl?.remove();
    panelEl = null;
  }
}

/**
 * Bottom-sheet drag on small screens. Dragging the handle down past a
 * threshold dismisses; a shorter drag snaps between a peek and a tall height.
 */
function installSheetDrag(panel: HTMLElement): void {
  if (!isSmall()) return;
  const handle = panel.querySelector<HTMLElement>('.sheet-handle');
  if (!handle) return;

  let startY = 0;
  let startH = 0;
  let dragging = false;

  const onDown = (event: PointerEvent) => {
    dragging = true;
    startY = event.clientY;
    startH = panel.getBoundingClientRect().height;
    panel.classList.add('is-dragging');
    handle.setPointerCapture(event.pointerId);
  };

  const onMove = (event: PointerEvent) => {
    if (!dragging) return;
    const delta = event.clientY - startY;
    const next = Math.max(90, Math.min(window.innerHeight * 0.86, startH - delta));
    panel.style.setProperty('--sheet-h', `${next}px`);
  };

  const onUp = (event: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove('is-dragging');
    handle.releasePointerCapture(event.pointerId);
    const height = panel.getBoundingClientRect().height;
    // Swiped most of the way down: treat as a dismiss.
    if (height < window.innerHeight * 0.2) {
      closePanel();
      return;
    }
    // Otherwise snap to whichever of the two heights is nearer.
    const peek = window.innerHeight * 0.42;
    const tall = window.innerHeight * 0.82;
    panel.style.setProperty('--sheet-h', `${Math.abs(height - peek) < Math.abs(height - tall) ? peek : tall}px`);
  };

  handle.addEventListener('pointerdown', onDown);
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
}

// ---------------------------------------------------------------------------
// Search with autocomplete
// ---------------------------------------------------------------------------

function installSearch(): void {
  let timer: number | undefined;
  let results: Array<{ iso2: string; name: string; capital: string | null }> = [];
  let cursor = -1;

  const render = () => {
    clear(searchResults);
    cursor = Math.min(cursor, results.length - 1);
    results.forEach((r, i) => {
      const btn = el(
        'button',
        {
          class: 'search-result',
          type: 'button',
          role: 'option',
          'aria-selected': String(i === cursor),
          id: `search-opt-${i}`,
        },
        [
          flag(r.iso2, r.name, 32),
          el('span', { class: 'name', text: r.name }),
          el('span', { class: 'meta', text: r.capital ?? r.iso2 }),
        ],
      );
      btn.addEventListener('click', () => choose(i));
      searchResults.append(btn);
    });
    searchInput.setAttribute('aria-expanded', String(results.length > 0));
  };

  const choose = (index: number) => {
    const picked = results[index];
    if (!picked) return;
    searchInput.value = '';
    results = [];
    cursor = -1;
    render();
    void selectCountry(picked.iso2, { push: true });
  };

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    window.clearTimeout(timer);
    if (q.length < 2) {
      results = [];
      render();
      return;
    }
    // Debounced, so typing a country name is one request, not seven.
    timer = window.setTimeout(async () => {
      try {
        const { results: found } = await api.search(q);
        results = found;
        cursor = found.length ? 0 : -1;
        render();
      } catch {
        results = [];
        render();
      }
    }, 160);
  });

  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!results.length) return;
      event.preventDefault();
      cursor = (cursor + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      render();
      searchResults.children[cursor]?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      if (cursor >= 0) {
        event.preventDefault();
        choose(cursor);
      }
    } else if (event.key === 'Escape') {
      if (results.length) {
        event.stopPropagation();
        results = [];
        render();
      } else {
        searchInput.blur();
      }
    }
  });

  // Dismiss the list on outside click, but not on a click inside it.
  document.addEventListener('pointerdown', (event) => {
    if (searchResults.contains(event.target as Node) || event.target === searchInput) return;
    if (!results.length) return;
    results = [];
    render();
  });
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

function installKeyboard(): void {
  document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';

    if (event.key === 'Escape' && !typing) {
      if (panelEl) {
        event.preventDefault();
        closePanel();
      }
      return;
    }

    if (typing) return;

    // "/" focuses search, the convention readers already expect.
    if (event.key === '/') {
      event.preventDefault();
      searchInput.focus();
      return;
    }
    if (event.key === '?') {
      event.preventDefault();
      toast(
        'Keys: / search · Esc close · c clear filters · r reset view · 1-7 toggle a category',
        'info',
        'help',
      );
      return;
    }
    if (event.key === 'c') {
      store.clearFilters();
      return;
    }
    if (event.key === 'r') {
      globe?.flyHome();
      return;
    }
    // Number keys toggle categories, in the order the rail shows them.
    const digit = Number(event.key);
    if (appMeta && Number.isInteger(digit) && digit >= 1 && digit <= appMeta.categories.length) {
      store.toggleIn('categories', appMeta.categories[digit - 1]!.id);
    }
  });
}

// ---------------------------------------------------------------------------
// Hover card
// ---------------------------------------------------------------------------

function showHover(info: { iso2: string; x: number; y: number } | null): void {
  if (!info || isSmall()) {
    hoverCard.hidden = true;
    return;
  }
  const row = countryByIso.get(info.iso2);
  if (!row) {
    hoverCard.hidden = true;
    return;
  }
  clear(hoverCard);
  hoverCard.append(
    el('span', { class: 'dot', 'data-status': row.status }),
    el('span', { text: row.name }),
    el('span', { class: 'hint', text: row.statusLabel }),
  );
  if (row.newsCount24h) {
    hoverCard.append(el('span', { class: 'hint num', text: `${row.newsCount24h} stories` }));
  }
  hoverCard.hidden = false;
  // Keep the card on screen near the cursor without covering it.
  const pad = 14;
  const rect = hoverCard.getBoundingClientRect();
  const left = Math.min(window.innerWidth - rect.width - pad, info.x + pad);
  const top = Math.min(window.innerHeight - rect.height - pad, info.y + pad);
  hoverCard.style.transform = `translate(${Math.max(pad, left)}px, ${Math.max(pad, top)}px)`;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  installSearch();
  installKeyboard();
  setLive('connecting');

  try {
    appMeta = await api.meta();
  } catch (err) {
    toast(`Could not reach the API: ${(err as Error).message}`, 'error', 'meta-error');
    setLive('down');
    return;
  }

  const state = store.get();

  // The globe is created before data arrives so the reader sees the world
  // immediately rather than a blank screen.
  globe = new Globe({
    container: $('#globe'),
    lowDetail: isSmall(),
    reducedMotion,
    imagery: (appMeta.imagery.active as ImagerySource) ?? 'esri',
    onPick: (iso2) => {
      if (iso2) void selectCountry(iso2, { push: true });
      else if (panelEl) closePanel();
    },
    onHover: showHover,
  });

  await refreshCountries(state);
  await globe.loadCountries(statusMap(state));

  await Promise.all([refreshFeed(state), renderMarkets()]);

  // Restore a shared link's country without re-pushing history.
  if (state.country) await selectCountry(state.country, { push: false });
  else hintBar.hidden = false;

  // Live updates: the stream tells us a new rollup landed; we refetch.
  subscribeLive({
    onRevision: () => {
      const current = store.get();
      void refreshFeed(current);
      void refreshCountries(current);
      // The open panel refreshes too, so a country's news stays current
      // without the reader reopening it.
      if (current.country) void selectCountry(current.country, { push: false, fly: false });
    },
    onState: (s) => {
      if (s === 'live') setLive('live');
      else if (s === 'down') setLive('down', 'Live stream disconnected; retrying');
    },
  });

  // Prices move on their own slower cadence than the news stream.
  window.setInterval(() => void renderMarkets(), 5 * 60 * 1000);

  store.subscribe((next, previous) => {
    const filtersChanged =
      next.categories !== previous.categories ||
      next.regions !== previous.regions ||
      next.sourceTypes !== previous.sourceTypes ||
      next.outlets !== previous.outlets ||
      next.statuses !== previous.statuses ||
      next.since !== previous.since ||
      next.sort !== previous.sort ||
      next.minScore !== previous.minScore ||
      next.confirmedOnly !== previous.confirmedOnly ||
      next.search !== previous.search;

    renderRail(next);
    renderLegend(next);
    globe?.setStatuses(statusMap(next));

    if (filtersChanged) {
      void refreshFeed(next);
      if (next.country) void selectCountry(next.country, { push: false, fly: false });
    }

    // Back/forward that clears the country should close the panel.
    if (!next.country && panelEl) {
      panelEl.remove();
      panelEl = null;
      globe?.select(null);
      globe?.clearLines();
    } else if (next.country && next.country !== previous.country && !panelEl) {
      void selectCountry(next.country, { push: false });
    }
  });

  announce('World Pulse ready. Use the search box or click a country.');
}

void boot().catch((err) => {
  toast(`Startup failed: ${(err as Error).message}`, 'error', 'boot');
});
