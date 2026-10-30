import type { ConflictRecord, Story } from '../types';
import { independentOwners } from './dedupe';
import { isOwnerInferred } from './outlets';

/**
 * Accuracy scoring.
 *
 * Every story gets a 0-100 score built from named components, each of which
 * is returned alongside the total so the UI can show the reader exactly how
 * the number was reached. Nothing here is a model judgement about whether a
 * claim is true: the score measures how well *corroborated and attributable*
 * the reporting is, which is the only thing this app can actually observe.
 *
 * The components, and why each is weighted as it is:
 *
 *   breadth (0-40)      Independently owned outlets carrying the story. This
 *                       dominates, because independent corroboration is the
 *                       strongest signal available without reading the pieces.
 *   attribution (0-20)  Whether those outlets' ownership is known from the
 *                       registry or merely inferred from the domain. An
 *                       inferred owner means the independence check for that
 *                       outlet rests on the domain alone, so it scores lower.
 *   dataset (0-15)      A named conflict dataset corroborates the country and
 *                       subject. Only reachable for conflict stories.
 *   recency (0-15)      How fresh the newest report is. Decays over 48h.
 *   specificity (0-10)  Whether the story resolved to a specific country and
 *                       category, rather than landing in the global bucket.
 *
 * Reddit contributes nothing to breadth or attribution. A Reddit-only story
 * is capped (see REDDIT_ONLY_CEILING) and labelled discussion, because the
 * app never treats a forum post as corroboration.
 */

export type AccuracyBand = 'verified' | 'corroborated' | 'reported' | 'unconfirmed';

export interface ScoreComponent {
  id: 'breadth' | 'attribution' | 'dataset' | 'recency' | 'specificity';
  label: string;
  points: number;
  max: number;
  /** One line a reader can check against the story's own source list. */
  detail: string;
}

export interface AccuracyScore {
  total: number;
  band: AccuracyBand;
  components: ScoreComponent[];
  /** Named sources behind the score, every one with a link and a timestamp. */
  citations: Array<{ outlet: string; owner: string; url: string; publishedAt: string; type: string }>;
  /** Stated plainly, e.g. "3 independently owned outlets, oldest 2h ago". */
  summary: string;
}

/** A story carried only by Reddit cannot score above this, whatever else holds. */
const REDDIT_ONLY_CEILING = 20;

const BANDS: Array<{ band: AccuracyBand; min: number; label: string }> = [
  { band: 'verified', min: 70, label: 'Verified' },
  { band: 'corroborated', min: 50, label: 'Corroborated' },
  { band: 'reported', min: 30, label: 'Reported' },
  { band: 'unconfirmed', min: 0, label: 'Unconfirmed' },
];

export const BAND_LABELS: Record<AccuracyBand, string> = {
  verified: 'Verified',
  corroborated: 'Corroborated',
  reported: 'Reported',
  unconfirmed: 'Unconfirmed',
};

/** Human description of each band, shown in the legend. */
export const BAND_RULES: Record<AccuracyBand, string> = {
  verified: 'Four or more independently owned outlets, ownership known, reported recently.',
  corroborated: 'Two or more independently owned outlets.',
  reported: 'One outlet, or outlets whose independence could not be established.',
  unconfirmed: 'Discussion only, or a single source with unknown ownership.',
};

export function scoreStory(
  story: Story,
  conflict?: ConflictRecord | null,
): AccuracyScore {
  const newsItems = story.items.filter((i) => i.sourceType === 'news');
  const owners = independentOwners(story);
  const components: ScoreComponent[] = [];

  // --- breadth -------------------------------------------------------------
  const breadthPoints =
    owners.length >= 4 ? 40 : owners.length === 3 ? 32 : owners.length === 2 ? 25 : owners.length === 1 ? 10 : 0;
  components.push({
    id: 'breadth',
    label: 'Independent outlets',
    points: breadthPoints,
    max: 40,
    detail:
      owners.length === 0
        ? 'No text-news outlet carried this; discussion or broadcast only.'
        : `${owners.length} independently owned outlet${owners.length === 1 ? '' : 's'}: ${owners.slice(0, 5).join(', ')}${owners.length > 5 ? ', and others' : ''}.`,
  });

  // --- attribution ---------------------------------------------------------
  const known = newsItems.filter((i) => !isOwnerInferred(i.outlet));
  const inferred = newsItems.length - known.length;
  const attributionPoints = newsItems.length
    ? Math.round((known.length / newsItems.length) * 20)
    : 0;
  components.push({
    id: 'attribution',
    label: 'Ownership known',
    points: attributionPoints,
    max: 20,
    detail: newsItems.length
      ? `${known.length} of ${newsItems.length} reports come from outlets with a known owner` +
        (inferred ? `; ${inferred} had ownership inferred from the domain alone.` : '.')
      : 'No text-news reports to attribute.',
  });

  // --- dataset corroboration ----------------------------------------------
  const datasetHit =
    conflict && story.categories.includes('war')
      ? conflict.conflicts.find(Boolean)
      : null;
  components.push({
    id: 'dataset',
    label: 'Conflict dataset',
    points: datasetHit ? 15 : 0,
    max: 15,
    detail: datasetHit
      ? `${conflict!.provenance.source} lists "${datasetHit.name}" for this country.`
      : story.categories.includes('war')
        ? 'No conflict-dataset row corroborates this country.'
        : 'Not a conflict story; dataset corroboration does not apply.',
  });

  // --- recency -------------------------------------------------------------
  const ageHours = Math.max(0, (Date.now() - Date.parse(story.latestAt)) / 3_600_000);
  const recencyPoints = Math.round(15 * Math.max(0, 1 - ageHours / 48));
  components.push({
    id: 'recency',
    label: 'Freshness',
    points: recencyPoints,
    max: 15,
    detail:
      ageHours < 1
        ? 'Newest report is under an hour old.'
        : `Newest report is ${ageHours < 24 ? `${Math.round(ageHours)}h` : `${Math.round(ageHours / 24)}d`} old.`,
  });

  // --- specificity ---------------------------------------------------------
  const hasCountry = story.countries.length > 0;
  const hasCategory = story.categories.length > 0;
  const specificityPoints = (hasCountry ? 6 : 0) + (hasCategory ? 4 : 0);
  components.push({
    id: 'specificity',
    label: 'Placed and classified',
    points: specificityPoints,
    max: 10,
    detail: `${hasCountry ? `Matched to ${story.countries.join(', ')}` : 'No country matched'}; ${hasCategory ? `filed under ${story.categories.join(', ')}` : 'no category matched'}.`,
  });

  let total = components.reduce((sum, c) => sum + c.points, 0);

  // A story nobody reported in text is discussion, however fresh or specific.
  const redditOnly = newsItems.length === 0;
  if (redditOnly) total = Math.min(total, REDDIT_ONLY_CEILING);

  const band = BANDS.find((b) => total >= b.min)!.band;

  const citations = story.items.map((i) => ({
    outlet: i.outlet.name,
    owner: isOwnerInferred(i.outlet) ? `${i.outlet.domain} (owner not in registry)` : i.outlet.owner,
    url: i.url,
    publishedAt: i.publishedAt,
    type: i.sourceType,
  }));

  const summary = redditOnly
    ? `Discussion only (${story.items.length} post${story.items.length === 1 ? '' : 's'}), capped at ${REDDIT_ONLY_CEILING}.`
    : `${owners.length} independently owned outlet${owners.length === 1 ? '' : 's'}, newest ${ageHours < 1 ? 'under 1h' : `${Math.round(ageHours)}h`} ago${datasetHit ? ', dataset corroborated' : ''}.`;

  return { total: Math.max(0, Math.min(100, total)), band, components, citations, summary };
}

/**
 * Country-level confidence: how well evidenced that country's panel is.
 * Separate from story scoring because a country's status, leader and prices
 * come from different sources with different reliability.
 */
export interface CountryConfidence {
  total: number;
  band: AccuracyBand;
  parts: Array<{ label: string; ok: boolean; detail: string }>;
}

export function scoreCountry(input: {
  hasLeader: boolean;
  leaderSource: string | null;
  statusBasis: 'dataset' | 'two-outlet' | 'none';
  statusReason: string;
  storyCount: number;
  confirmedCount: number;
  hasRelations: boolean;
}): CountryConfidence {
  const parts = [
    {
      label: 'Leader',
      ok: input.hasLeader,
      detail: input.hasLeader
        ? `Current office holder from ${input.leaderSource ?? 'Wikidata'}, with no end date on the statement.`
        : 'No current office holder found in Wikidata.',
    },
    {
      label: 'Conflict status',
      ok: input.statusBasis !== 'none',
      detail: input.statusReason,
    },
    {
      label: 'Confirmed reporting',
      ok: input.confirmedCount > 0,
      detail: `${input.confirmedCount} of ${input.storyCount} stories have two or more independently owned outlets.`,
    },
    {
      label: 'Alliances',
      ok: input.hasRelations,
      detail: input.hasRelations
        ? 'Memberships and relations from Wikidata.'
        : 'No membership or relation records found.',
    },
  ];

  const weights = { Leader: 30, 'Conflict status': 30, 'Confirmed reporting': 25, Alliances: 15 } as Record<string, number>;
  const total = parts.reduce((sum, p) => sum + (p.ok ? weights[p.label]! : 0), 0);
  const band = BANDS.find((b) => total >= b.min)!.band;
  return { total, band, parts };
}
