import type { StoryView } from '../api';
import { el, timeEl, cite, exactTime } from './dom';

/**
 * A single story in a list.
 *
 * Every row shows its outlet, its accuracy band and how many independently
 * owned outlets carried it, so a reader never has to open anything to judge
 * how well evidenced a headline is. The full score breakdown and the citation
 * list expand in place.
 */

const SOURCE_TYPE_LABEL: Record<string, string> = {
  news: 'News',
  reddit: 'Reddit discussion',
  tv: 'TV',
  press: 'Press conference',
};

export function storyItem(story: StoryView, opts: { showCountries?: boolean } = {}): HTMLElement {
  const expanded = el('div', { class: 'story-detail', hidden: 'hidden' });
  let built = false;

  const toggle = el(
    'button',
    {
      class: 'cite',
      type: 'button',
      'aria-expanded': 'false',
      title: 'Show how this score was calculated and every outlet that carried it',
    },
    [`${story.outletCount || story.citations.length} source${(story.outletCount || story.citations.length) === 1 ? '' : 's'}`],
  );

  toggle.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const open = expanded.hidden;
    // Built lazily: a feed of 60 stories should not render 60 breakdowns.
    if (open && !built) {
      expanded.append(scoreBreakdown(story));
      built = true;
    }
    expanded.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  });

  const title = el('a', {
    class: 'news-title',
    href: story.url,
    target: '_blank',
    rel: 'noopener noreferrer',
    text: story.title,
  });

  return el('article', { class: 'news-item' }, [
    el('div', { class: 'news-top' }, [
      el('span', { class: 'news-outlet', text: story.outlet.name }),
      el('span', { text: '·' }),
      timeEl(story.latestAt),
      el('span', {
        class: 'news-badge',
        'data-band': story.accuracy.band,
        text: story.accuracy.bandLabel,
        title: `Accuracy ${story.accuracy.total}/100 - ${story.accuracy.summary}`,
      }),
      el('span', { class: 'num', text: `${story.accuracy.total}`, title: 'Accuracy score out of 100' }),
    ]),
    title,
    el('div', { class: 'news-foot' }, [
      toggle,
      ...[...new Set(story.sourceTypes)].map((t) =>
        el('span', { text: SOURCE_TYPE_LABEL[t] ?? t, title: 'Kind of source' }),
      ),
      opts.showCountries && story.countries.length
        ? el('span', { text: story.countries.join(' · '), title: `Matched by: ${story.matchedBy}` })
        : null,
    ]),
    expanded,
  ]);
}

/** The auditable part: every component of the score, then every citation. */
export function scoreBreakdown(story: StoryView): DocumentFragment {
  const parts = el(
    'div',
    { class: 'score-parts' },
    story.accuracy.components.map((c) =>
      el('div', { class: 'score-part' }, [
        el('div', { class: 'score-part-top' }, [
          el('span', { text: c.label }),
          el('span', { class: 'pts num', text: `${c.points}/${c.max}` }),
        ]),
        el('div', { class: 'meter' }, [
          el('span', {
            style: `width:${c.max ? Math.round((c.points / c.max) * 100) : 0}%`,
          }),
        ]),
        el('div', { class: 'detail', text: c.detail }),
      ]),
    ),
  );

  const citations = el('div', { class: 'citation-list' }, [
    el('div', { class: 'eyebrow', text: `Sources (${story.citations.length})` }),
    ...story.citations.map((c) =>
      el('div', { class: 'citation' }, [
        el(
          'a',
          { href: c.url, target: '_blank', rel: 'noopener noreferrer', class: 'citation-outlet' },
          [c.outlet],
        ),
        el('span', { class: 'citation-owner', text: c.owner, title: 'Ownership group used for the independence check' }),
        el('time', { datetime: c.publishedAt, title: exactTime(c.publishedAt), class: 'citation-time', text: exactTime(c.publishedAt) }),
        el('span', { class: 'citation-type', text: SOURCE_TYPE_LABEL[c.type] ?? c.type }),
      ]),
    ),
  ]);

  const f = document.createDocumentFragment();
  f.append(
    el('div', { class: 'score-head' }, [
      el('span', { class: 'score num', text: String(story.accuracy.total) }),
      el('span', { class: 'band', 'data-band': story.accuracy.band, text: story.accuracy.bandLabel }),
      el('span', { class: 'score-note', text: story.accuracy.summary }),
    ]),
    parts,
    citations,
    el('div', { class: 'detail', text: `Country match: ${story.matchedBy || 'none'}` }),
  );
  return f;
}

/** Ticker entry: headline, outlet, and nothing else. */
export function tickerItem(story: StoryView): HTMLElement {
  return el(
    'a',
    {
      class: 'ticker-item',
      href: story.url,
      target: '_blank',
      rel: 'noopener noreferrer',
      'data-status': story.categories.includes('war') ? 'war' : undefined,
    },
    [
      el('span', { class: 'dot', 'data-status': story.categories.includes('war') ? 'war' : 'unknown' }),
      el('span', { text: story.title }),
      el('span', { class: 'outlet', text: story.outlet.name }),
    ],
  );
}

/** Market bar entry. Shows "No data" rather than a stale or guessed number. */
export function priceChip(price: {
  key: string;
  label: string;
  value: number;
  unit: string;
  changePct: number | null;
  asOf: string;
  provenance: { source: string; url: string | null };
}): HTMLElement {
  const dir = price.changePct == null ? null : price.changePct >= 0 ? 'up' : 'down';
  const short = price.label.replace(/ \(.*\)$/, '').replace('Natural gas', 'Nat gas');

  return el(
    'a',
    {
      class: 'price',
      href: price.provenance.url ?? '#',
      target: '_blank',
      rel: 'noopener noreferrer',
      // The unit, the exact period and the source all live in the tooltip, so
      // the bar stays compact without hiding where the number came from.
      title: `${price.label}: ${price.value} ${price.unit}\nAs of ${exactTime(price.asOf)}\nSource: ${price.provenance.source}`,
    },
    [
      el('span', { class: 'price-label', text: short }),
      el('span', { class: 'price-value num', text: price.value.toFixed(2) }),
      dir
        ? el('span', {
            class: 'price-change num',
            'data-dir': dir,
            text: `${price.changePct! >= 0 ? '+' : ''}${price.changePct!.toFixed(2)}%`,
          })
        : null,
    ],
  );
}

export function priceMissing(label: string, why: string): HTMLElement {
  return el('span', { class: 'price' }, [
    el('span', { class: 'price-label', text: label }),
    el('span', { class: 'price-missing', text: 'No data', title: why }),
  ]);
}

export { cite };
