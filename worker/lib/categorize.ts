import type { Category } from '../types';

/**
 * Keyword classifier. Every category is a published, inspectable rule rather
 * than a model judgement, so a reader can see exactly why an item was filed
 * where it was. Items can carry more than one category.
 */

interface Rule {
  category: Category;
  /** Matched on word boundaries against title + summary. */
  terms: string[];
  /** Score added per distinct term found. */
  weight: number;
}

const RULES: Rule[] = [
  {
    category: 'war',
    weight: 3,
    terms: [
      'war', 'warfare', 'invasion', 'invade', 'invaded', 'offensive', 'airstrike',
      'air strike', 'strikes', 'shelling', 'bombardment', 'bombing', 'missile',
      'drone strike', 'drone attack', 'ceasefire', 'truce', 'front line',
      'frontline', 'troops', 'soldiers', 'military operation', 'insurgent',
      'insurgency', 'militant', 'militants', 'rebel', 'rebels', 'militia',
      'armed group', 'combat', 'killed in fighting', 'casualties', 'artillery',
      'occupied', 'occupation', 'siege', 'conflict', 'clashes', 'gunmen',
      'massacre', 'atrocities', 'war crimes', 'genocide', 'coup',
    ],
  },
  {
    category: 'politics',
    weight: 2,
    terms: [
      'election', 'elections', 'vote', 'voters', 'ballot', 'referendum',
      'parliament', 'congress', 'senate', 'president', 'prime minister',
      'chancellor', 'minister', 'cabinet', 'government', 'opposition',
      'coalition', 'impeachment', 'resign', 'resignation', 'sworn in',
      'inauguration', 'legislation', 'bill passed', 'policy', 'diplomat',
      'diplomacy', 'summit', 'treaty', 'sanctions', 'ambassador',
      'foreign ministry', 'state visit', 'protest', 'protests', 'demonstration',
      'strike action', 'court ruled', 'supreme court', 'indicted',
    ],
  },
  {
    category: 'economy',
    weight: 2,
    terms: [
      'economy', 'economic', 'inflation', 'interest rate', 'central bank',
      'recession', 'gdp', 'unemployment', 'jobs report', 'stocks', 'shares',
      'markets', 'bond', 'currency', 'exchange rate', 'devaluation', 'tariff',
      'tariffs', 'trade deal', 'trade war', 'exports', 'imports', 'debt',
      'default', 'bailout', 'budget', 'deficit', 'imf', 'world bank',
      'investment', 'merger', 'acquisition', 'bankruptcy', 'layoffs',
    ],
  },
  {
    category: 'energy',
    weight: 3,
    terms: [
      'oil', 'crude', 'brent', 'wti', 'opec', 'natural gas', 'lng', 'pipeline',
      'refinery', 'barrel', 'petrol', 'gasoline', 'diesel', 'fuel price',
      'electricity', 'power grid', 'blackout', 'power cut', 'nuclear plant',
      'nuclear reactor', 'renewable', 'solar power', 'wind farm', 'coal',
      'energy crisis', 'energy prices', 'gazprom', 'saudi aramco',
    ],
  },
  {
    category: 'disasters',
    weight: 3,
    terms: [
      'earthquake', 'quake', 'aftershock', 'tsunami', 'hurricane', 'typhoon',
      'cyclone', 'tornado', 'flood', 'flooding', 'flash flood', 'landslide',
      'mudslide', 'drought', 'famine', 'wildfire', 'bushfire', 'forest fire',
      'volcano', 'volcanic', 'eruption', 'heatwave', 'heat wave', 'blizzard',
      'storm surge', 'evacuated', 'evacuation', 'state of emergency',
      'death toll', 'rescuers', 'epidemic', 'outbreak', 'cholera', 'ebola',
      'humanitarian crisis', 'displaced',
    ],
  },
  {
    category: 'press',
    weight: 4,
    terms: [
      'press conference', 'press briefing', 'news conference', 'briefing room',
      'press secretary', 'addresses the nation', 'address to the nation',
      'statement to reporters', 'spokesperson said', 'live: ', 'speech at',
      'remarks at', 'testimony', 'testifies', 'hearing on', 'joint statement',
      'in his own words', 'full speech', 'q&a with',
    ],
  },
];

/**
 * Good news is deliberately the narrowest rule in the app, because a loose
 * one produces grim results. An item is only labelled good news when BOTH:
 *
 *   1. it contains a term from GOOD_SIGNALS below (a concrete positive
 *      outcome, not merely a hopeful adjective), and
 *   2. it contains no term from GOOD_BLOCKERS, which name harm. This stops
 *      "aid reaches survivors of the massacre" and "breakthrough in murder
 *      investigation" from being filed as good news.
 *
 * Items from r/UpliftingNews still have to clear the same two tests; the
 * subreddit's own framing is not treated as evidence.
 *
 * This rule is documented in the README under "How good news is labelled".
 */
const GOOD_SIGNALS = [
  'cure', 'cured', 'vaccine approved', 'breakthrough treatment', 'recovery',
  'recovered', 'rescued', 'saved', 'survived', 'reunited', 'freed', 'released',
  'peace deal', 'peace agreement', 'truce holds', 'aid delivered',
  'donated', 'donation', 'fundraiser', 'record low poverty', 'lifted out of poverty',
  'eradicated', 'declared free of', 'conservation success', 'population rebounds',
  'species recovery', 'reforestation', 'cleaned up', 'restored', 'milestone',
  'first time in', 'record number of', 'graduated', 'scholarship', 'award',
  'prize', 'honoured', 'honored', 'breakthrough', 'discovery', 'successful launch',
  'returns home', 'charges dropped', 'exonerated', 'acquitted', 'pardoned',
  'life expectancy rose', 'emissions fell', 'crime fell', 'unemployment fell',
];

const GOOD_BLOCKERS = [
  'killed', 'dead', 'death', 'deaths', 'died', 'dies', 'murder', 'murdered',
  'massacre', 'genocide', 'atrocity', 'atrocities', 'war crime', 'rape',
  'assault', 'abuse', 'torture', 'kidnap', 'kidnapped', 'hostage', 'shooting',
  'shot', 'stabbed', 'bomb', 'bombing', 'explosion', 'attack', 'attacked',
  'crash', 'collapse', 'disaster', 'outbreak', 'epidemic', 'famine', 'starving',
  'injured', 'wounded', 'casualties', 'toll', 'missing', 'fraud', 'corruption',
  'convicted', 'sentenced', 'jailed', 'arrested', 'war', 'strike', 'invasion',
  'lawsuit', 'sues', 'banned', 'warning', 'warns', 'threat', 'threatens',
  'crisis', 'scandal', 'resign', 'layoffs', 'bankruptcy', 'protest',
];

/** Word-boundary term test that tolerates multi-word phrases. */
function contains(haystack: string, term: string): boolean {
  const at = haystack.indexOf(term);
  if (at < 0) return false;
  // Re-scan every occurrence so a boundary failure does not mask a later hit.
  let from = at;
  for (;;) {
    const i = haystack.indexOf(term, from);
    if (i < 0) return false;
    const before = i === 0 ? ' ' : haystack[i - 1]!;
    const afterIdx = i + term.length;
    const after = afterIdx >= haystack.length ? ' ' : haystack[afterIdx]!;
    if (!/[a-z0-9]/.test(before) && (!/[a-z0-9]/.test(after) || /[sd]/.test(after))) return true;
    from = i + 1;
  }
}

export interface Classification {
  categories: Category[];
  /** Per-category explanation of the terms that triggered it. */
  why: Record<string, string[]>;
}

export function categorize(
  title: string,
  summary?: string | null,
  hints: string[] = [],
): Classification {
  const text = ` ${title.toLowerCase()} ${(summary ?? '').toLowerCase().slice(0, 800)} ${hints.join(' ').toLowerCase()} `;

  const scores = new Map<Category, number>();
  const why: Record<string, string[]> = {};

  for (const rule of RULES) {
    const hit = rule.terms.filter((t) => contains(text, t));
    if (!hit.length) continue;
    scores.set(rule.category, (scores.get(rule.category) ?? 0) + hit.length * rule.weight);
    why[rule.category] = hit.slice(0, 5);
  }

  // The good-news rule, applied last so it can see nothing else first.
  const goodHits = GOOD_SIGNALS.filter((t) => contains(text, t));
  const blockers = GOOD_BLOCKERS.filter((t) => contains(text, t));
  if (goodHits.length > 0 && blockers.length === 0) {
    scores.set('good', 4 * goodHits.length);
    why.good = goodHits.slice(0, 5);
  }

  const categories = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([c]) => c);

  return { categories, why };
}

/** The full category list, in the order the UI shows them. */
export const CATEGORY_ORDER: Category[] = [
  'war',
  'politics',
  'economy',
  'energy',
  'disasters',
  'good',
  'press',
];

export const CATEGORY_LABELS: Record<Category, string> = {
  war: 'War and conflict',
  politics: 'Politics',
  economy: 'Economy',
  energy: 'Energy',
  disasters: 'Disasters',
  good: 'Good news',
  press: 'Press conferences',
};
