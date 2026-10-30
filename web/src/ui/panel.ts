import type { CountryDetail } from '../api';
import { el, flag, timeEl, cite, dataRow, noData, skeleton, stagger, countUp, exactTime, clear } from './dom';
import { storyItem } from './story';

/**
 * The country panel.
 *
 * Order is deliberate: what the reader asked for first (where am I looking,
 * who runs it, is it at war), then the evidence for that, then the news. Every
 * block states its own source and last-updated time, and anything a source
 * did not provide reads "No data" rather than being quietly omitted.
 */

const CATEGORY_LABELS: Record<string, string> = {
  war: 'War and conflict',
  politics: 'Politics',
  economy: 'Economy',
  energy: 'Energy',
  disasters: 'Disasters',
  good: 'Good news',
  press: 'Press conferences',
};

const CATEGORY_ORDER = ['war', 'politics', 'economy', 'energy', 'disasters', 'good', 'press'];

export interface PanelCallbacks {
  onClose: () => void;
  onOpenCountry: (iso2: string) => void;
}

/** Shell with a loading skeleton, shown the moment a country is clicked. */
export function panelSkeleton(name: string, iso2: string, cb: PanelCallbacks): HTMLElement {
  const panel = el('aside', {
    class: 'panel panel-country',
    role: 'dialog',
    'aria-modal': 'false',
    'aria-label': `${name} detail`,
    tabindex: '-1',
  });

  panel.append(
    el('div', { class: 'sheet-handle', 'aria-hidden': 'true' }),
    el('header', { class: 'panel-head' }, [
      el('div', { class: 'panel-head-top' }, [
        flag(iso2, name),
        el('div', { class: 'panel-title' }, [
          el('h2', { text: name }),
          el('span', { class: 'sub', text: 'Loading' }),
        ]),
        closeButton(cb.onClose),
      ]),
    ]),
    el('div', { class: 'panel-body' }, [
      el('div', { class: 'section' }, [skeleton(14, '40%'), skeleton(40), skeleton(14, '70%')]),
      el('div', { class: 'section' }, [skeleton(14, '30%'), skeleton(60)]),
      el('div', { class: 'section' }, [skeleton(14, '35%'), skeleton(80)]),
    ]),
  );
  return panel;
}

function closeButton(onClose: () => void): HTMLElement {
  const btn = el('button', {
    class: 'panel-close',
    type: 'button',
    'aria-label': 'Close panel (Escape)',
    title: 'Close (Esc)',
  });
  // A real glyph rather than an icon font or emoji.
  btn.append(el('span', { 'aria-hidden': 'true', text: '×' }));
  btn.addEventListener('click', onClose);
  return btn;
}

export function renderPanel(detail: CountryDetail, cb: PanelCallbacks): HTMLElement {
  const { country } = detail;

  const panel = el('aside', {
    class: 'panel panel-country',
    role: 'dialog',
    'aria-modal': 'false',
    'aria-label': `${country.name} detail`,
    tabindex: '-1',
  });

  const body = el('div', { class: 'panel-body' });

  panel.append(
    el('div', { class: 'sheet-handle', 'aria-hidden': 'true' }),
    el('header', { class: 'panel-head' }, [
      el('div', { class: 'panel-head-top' }, [
        flag(country.iso2, country.name),
        el('div', { class: 'panel-title' }, [
          el('h2', { text: country.name }),
          el('span', {
            class: 'sub',
            text: [country.capital, country.continent].filter(Boolean).join(' · ') || country.iso3,
          }),
        ]),
        closeButton(cb.onClose),
      ]),
      statusBanner(detail),
    ]),
    body,
  );

  body.append(
    leadersSection(detail),
    conflictSection(detail),
    relationsSection(detail, cb),
    pricesSection(detail),
    newsSection(detail),
    confidenceSection(detail),
  );

  // Count the headline numbers up once the panel is in the document.
  requestAnimationFrame(() => {
    for (const node of panel.querySelectorAll<HTMLElement>('[data-countup]')) {
      const to = Number(node.dataset.countup);
      if (Number.isFinite(to)) countUp(node, to, { decimals: Number(node.dataset.decimals ?? 0) });
    }
  });

  return panel;
}

function statusBanner(detail: CountryDetail): HTMLElement {
  const { status } = detail;
  const basisLabel =
    status.basis === 'dataset' ? 'Dataset' : status.basis === 'two-outlet' ? '2+ outlets' : 'No evidence';

  const banner = el('div', { class: 'status-banner', 'data-status': status.status }, [
    el('span', { class: 'dot', 'data-status': status.status }),
    el('span', { class: 'label', text: status.label }),
    el('span', { class: 'basis', text: basisLabel, title: 'What this status is based on' }),
  ]);

  // The rule that produced the status is always on screen, never hidden.
  const reason = el('p', { class: 'reason', text: status.reason });

  const evidence = status.evidence.length
    ? el('div', { class: 'evidence' }, [
        el('span', { class: 'eyebrow', text: 'Evidence' }),
        el('div', { class: 'evidence-links' }, status.evidence.map((e) => cite(e))),
      ])
    : null;

  return el('div', {}, [banner, reason, evidence]);
}

function leadersSection(detail: CountryDetail): HTMLElement {
  const rows = detail.leaders.length
    ? detail.leaders.map((l) =>
        dataRow(
          l.role,
          [
            el('span', { text: l.name }),
            l.since
              ? el('span', { class: 'since', text: ` since ${l.since}` })
              : el('span', { class: 'since', text: ' (start date not recorded)' }),
          ],
          l.source,
        ),
      )
    : [
        el('div', { class: 'row' }, [
          el('span', { class: 'k', text: 'Leader' }),
          el('span', { class: 'v' }, [
            noData('Wikidata has no current head-of-state or head-of-government statement without an end date for this country.'),
          ]),
        ]),
      ];

  return el('section', { class: 'section' }, [
    el('h3', { class: 'eyebrow', text: 'Leadership' }),
    ...rows,
    metaLine('Leaders', detail.meta.leaders),
  ]);
}

function conflictSection(detail: CountryDetail): HTMLElement {
  if (!detail.conflicts.length) {
    return el('section', { class: 'section' }, [
      el('h3', { class: 'eyebrow', text: 'Conflicts' }),
      el('div', { class: 'row' }, [
        el('span', { class: 'k', text: 'Named conflicts' }),
        el('span', { class: 'v' }, [
          noData(
            detail.status.basis === 'two-outlet'
              ? 'No conflict dataset row. The status above rests on reporting, which is listed as evidence.'
              : 'No conflict dataset is configured, or the dataset lists nothing for this country.',
          ),
        ]),
      ]),
    ]);
  }

  return el('section', { class: 'section' }, [
    el('h3', { class: 'eyebrow', text: 'Conflicts' }),
    ...detail.conflicts.map((c) => {
      const sides = el('div', { class: 'conflict-sides' }, [
        el('div', { class: 'side' }, [
          el('span', { class: 'eyebrow', text: 'Side A' }),
          el('span', { text: c.sideA.map((s) => s.name).join(', ') || 'Not recorded' }),
        ]),
        el('div', { class: 'versus', text: 'vs', 'aria-hidden': 'true' }),
        el('div', { class: 'side' }, [
          el('span', { class: 'eyebrow', text: 'Side B' }),
          el('span', { text: c.sideB.map((s) => s.name).join(', ') || 'Not recorded' }),
        ]),
      ]);

      return el('article', { class: 'conflict' }, [
        el('h4', { class: 'conflict-name', text: c.name }),
        sides,
        el('div', { class: 'conflict-stats' }, [
          c.deaths != null
            ? el('span', {}, [
                el('span', { class: 'num', 'data-countup': String(c.deaths), text: '0' }),
                el('span', { text: ' recorded deaths' }),
              ])
            : noData('The dataset records no death count for this conflict.'),
          c.typeOfViolence ? el('span', { text: c.typeOfViolence }) : null,
          c.latestEventDate
            ? el('span', { text: `latest event ${c.latestEventDate}`, title: 'As dated by the dataset' })
            : null,
        ]),
        el('div', {}, [cite(c.source)]),
      ]);
    }),
    metaLine('Conflict data', detail.meta.news),
  ]);
}

function relationsSection(detail: CountryDetail, cb: PanelCallbacks): HTMLElement {
  const rel = detail.relations;
  const orgs = rel?.organizations ?? [];
  const shared = detail.lines.filter((l) => l.kind === 'pact');
  const adversaries = detail.lines.filter((l) => l.kind === 'adversary');
  const anchor = rel?.anchorOrganization ?? null;

  const countryButton = (iso2: string, name: string, title: string) => {
    const btn = el('button', { class: 'chip', type: 'button', title }, [
      flag(iso2, name, 32),
      el('span', { text: name }),
    ]);
    btn.addEventListener('click', () => cb.onOpenCountry(iso2));
    return btn;
  };

  return el('section', { class: 'section' }, [
    el('h3', { class: 'eyebrow', text: 'Memberships and relations' }),

    el('div', { class: 'row' }, [
      el('span', { class: 'k', text: 'Memberships' }),
      el('span', { class: 'v' }, [
        orgs.length
          ? el(
              'div',
              { class: 'rail-chips' },
              orgs.map((o) =>
                el('span', {
                  class: 'chip',
                  text: o.abbreviation ?? o.name,
                  title: `${o.name} - from Wikidata (P463 / P527)`,
                }),
              ),
            )
          : noData('Wikidata records no membership of the bodies this app tracks.'),
        rel ? el('div', {}, [cite(rel.source)]) : null,
      ]),
    ]),

    el('div', { class: 'row' }, [
      el('span', {
        class: 'k',
        text: anchor ? `Also in ${anchor.abbreviation ?? anchor.name}` : 'Shares a body with',
      }),
      el('span', { class: 'v' }, [
        shared.length
          ? el(
              'div',
              { class: 'rail-chips' },
              shared.slice(0, 12).map((p) => countryButton(p.iso2, p.name, p.basis)),
            )
          : noData('No shared multilateral membership found in Wikidata.'),
        shared.length > 12
          ? el('div', { class: 'detail', text: `and ${shared.length - 12} more` })
          : null,
        // Stated plainly: shared membership is not the same as alliance.
        anchor
          ? el('div', {
              class: 'detail',
              text:
                `Countries sharing this country's most specific multilateral body. ` +
                `A shared membership is not an alliance, and none is claimed.`,
            })
          : null,
      ]),
    ]),

    el('div', { class: 'row' }, [
      el('span', { class: 'k', text: 'Opposing parties' }),
      el('span', { class: 'v' }, [
        adversaries.length
          ? el(
              'div',
              { class: 'rail-chips' },
              adversaries.slice(0, 10).map((a) => countryButton(a.iso2, a.name, a.basis)),
            )
          : noData(
              'No conflict dataset names an opposing state. This app does not infer adversaries from reporting.',
            ),
      ]),
    ]),

    metaLine('Alliances', detail.meta.relations),
  ]);
}

function pricesSection(detail: CountryDetail): HTMLElement {
  const prices = detail.benchmarkPrices;
  return el('section', { class: 'section' }, [
    el('h3', { class: 'eyebrow', text: 'Oil and gas' }),
    prices.length
      ? el(
          'div',
          { class: 'price-grid' },
          prices.map((p) =>
            el('div', { class: 'price-cell' }, [
              el('span', { class: 'eyebrow', text: p.label }),
              el('span', { class: 'price-value num', 'data-countup': String(p.value), 'data-decimals': '2', text: '0' }),
              el('span', { class: 'detail', text: p.unit }),
              el('span', { class: 'detail', text: `as of ${p.asOf.slice(0, 10)}` }),
              el('div', {}, [cite(p.provenance)]),
            ]),
          ),
        )
      : noData('No price source is configured. Set EIA_API_KEY on the worker.'),
    // Stated plainly, because presenting a benchmark as a local pump price
    // would be exactly the kind of invention this app is built to avoid.
    el('p', { class: 'reason', text: detail.localPrices.note }),
    metaLine('Prices', detail.meta.prices),
  ]);
}

function newsSection(detail: CountryDetail): HTMLElement {
  const groups = CATEGORY_ORDER.map((cat) => ({ cat, stories: detail.newsByCategory[cat] ?? [] })).filter(
    (g) => g.stories.length,
  );

  const section = el('section', { class: 'section' }, [
    el('div', { class: 'section-head' }, [
      el('h3', { class: 'eyebrow', text: 'Latest news' }),
      el('span', { class: 'detail num', text: `${detail.newsTotal} stories` }),
    ]),
  ]);

  if (!groups.length) {
    section.append(
      noData(
        'No story in the cache matched this country for the current filters. Widen the time range or clear filters.',
      ),
    );
    return section;
  }

  for (const group of groups) {
    const list = el('div', { class: 'news-list' }, group.stories.map((s) => storyItem(s)));
    section.append(
      el('div', { class: 'news-group' }, [
        el('div', { class: 'news-group-head' }, [
          el('h4', { class: 'eyebrow', text: CATEGORY_LABELS[group.cat] ?? group.cat }),
          el('span', { class: 'detail num', text: String(group.stories.length) }),
        ]),
        list,
      ]),
    );
    stagger(list.children);
  }

  section.append(metaLine('News', detail.meta.news));
  return section;
}

function confidenceSection(detail: CountryDetail): HTMLElement {
  const c = detail.confidence;
  return el('section', { class: 'section' }, [
    el('h3', { class: 'eyebrow', text: 'How well evidenced is this page' }),
    el('div', { class: 'score-head' }, [
      el('span', { class: 'score num', 'data-countup': String(c.total), text: '0' }),
      el('span', { class: 'band', 'data-band': c.band, text: c.band }),
    ]),
    el(
      'div',
      { class: 'score-parts' },
      c.parts.map((p) =>
        el('div', { class: 'score-part' }, [
          el('div', { class: 'score-part-top' }, [
            el('span', { class: 'dot', 'data-status': p.ok ? 'peace' : 'unknown' }),
            el('span', { text: p.label }),
            el('span', { class: 'pts', text: p.ok ? 'present' : 'missing' }),
          ]),
          el('div', { class: 'detail', text: p.detail }),
        ]),
      ),
    ),
  ]);
}

/** Last-updated line, with a stale marker when the data is past its window. */
function metaLine(label: string, meta: CountryDetail['meta']['news']): HTMLElement {
  if (!meta.updatedAt) {
    return el('div', { class: 'meta-line' }, [
      el('span', { text: `${label}: never updated` }),
    ]);
  }
  const down = meta.sources.filter((s) => !s.ok);
  return el('div', { class: 'meta-line', 'data-stale': meta.stale ? 'true' : undefined }, [
    el('span', { text: `${label} updated ` }),
    timeEl(meta.updatedAt),
    meta.stale
      ? el('span', {
          class: 'stale-flag',
          text: 'stale',
          title: `Older than its ${meta.ttlSeconds}s refresh window`,
        })
      : null,
    down.length
      ? el('span', {
          class: 'stale-flag',
          text: `${down.length} source${down.length === 1 ? '' : 's'} down`,
          title: down.map((s) => `${s.name}: ${s.error}`).join('\n'),
        })
      : null,
  ]);
}

export { clear, exactTime };
