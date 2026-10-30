import type { ConflictRecord, ConflictStatus, Provenance, Story } from '../types';
import { independentOwners } from './dedupe';
import { COUNTRY_LIST } from './countries.generated';

/**
 * Derives each country's conflict status.
 *
 * The rule, which the UI states next to every coloured country:
 *
 *   dataset     a named conflict dataset (UCDP, ACLED) lists an active
 *               conflict for the country. This always wins.
 *   two-outlet  no dataset row, but two or more independently owned news
 *               outlets reported war or conflict there in the last 7 days.
 *   none        neither. The country is shown as "no data", never as at peace
 *               by assumption.
 *
 * Nothing here draws on prior knowledge of who is at war. A country with no
 * supporting evidence gets no status, which is the honest answer.
 */

/** Stories mentioning conflict terms count towards the two-outlet rule. */
const CONFLICT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many confirmed conflict stories separate "war" from lesser states.
 * These are presentation bands over the evidence, not claims of their own:
 * the UI always shows the underlying count and the outlets.
 */
const WAR_STORY_FLOOR = 6;
const CONFLICT_STORY_FLOOR = 2;

/** Deaths in the dataset window that mark a conflict as a war. */
const WAR_DEATH_FLOOR = 1000;

export interface StatusInput {
  /** Conflict dataset rows, keyed by ISO alpha-2. Empty when no key is set. */
  datasetByCountry: Map<string, ConflictRecord>;
  /** Every story in the cache, used for the two-outlet fallback. */
  stories: Story[];
  /**
   * Set when a conflict dataset was fetched successfully and is global in
   * coverage. Only then can a country's absence from it be read as "no active
   * conflict", which is the only way this app will show "at peace".
   *
   * Without a dataset, a quiet country is 'unknown' / "No data" rather than
   * at peace: an absence of reporting is not evidence of peace.
   */
  datasetCoversWorld: boolean;
  /** Dataset identity, used in the provenance line on peaceful countries. */
  datasetProvenance?: Provenance;
}

export interface StatusResult {
  iso2: string;
  status: ConflictStatus;
  basis: ConflictRecord['basis'];
  /** The rows or stories that justify the status. */
  evidence: Provenance[];
  /** Plain-language statement of the rule that produced this status. */
  reason: string;
  /** Confirmed conflict stories in the window. */
  conflictStories: number;
}

export function deriveStatuses(input: StatusInput): Map<string, StatusResult> {
  const { datasetByCountry, stories, datasetCoversWorld, datasetProvenance } = input;
  const out = new Map<string, StatusResult>();

  // --- Pass 1: dataset evidence, which outranks reporting ------------------
  for (const [iso2, record] of datasetByCountry) {
    const deaths = record.conflicts.reduce((sum, c) => sum + (c.deaths ?? 0), 0);
    const status: ConflictStatus = deaths >= WAR_DEATH_FLOOR ? 'war' : 'conflict';
    out.set(iso2, {
      iso2,
      status,
      basis: 'dataset',
      evidence: record.evidence,
      reason:
        `${record.provenance.source} lists ${record.conflicts.length} active ` +
        `conflict${record.conflicts.length === 1 ? '' : 's'}` +
        (deaths ? ` with ${deaths.toLocaleString('en')} recorded deaths` : '') +
        `, which is ${status === 'war' ? 'at or above' : 'below'} the ` +
        `${WAR_DEATH_FLOOR.toLocaleString('en')}-death threshold for "at war".`,
      conflictStories: 0,
    });
  }

  // --- Pass 2: the two-independent-outlet fallback -------------------------
  const cutoff = Date.now() - CONFLICT_WINDOW_MS;
  const perCountry = new Map<string, Story[]>();

  for (const story of stories) {
    if (!story.categories.includes('war')) continue;
    if (Date.parse(story.latestAt) < cutoff) continue;
    // Only confirmed stories can establish a status. A single outlet, or a
    // Reddit thread, is never enough.
    if (story.confidence !== 'confirmed') continue;
    for (const iso2 of story.countries) {
      let list = perCountry.get(iso2);
      if (!list) perCountry.set(iso2, (list = []));
      list.push(story);
    }
  }

  for (const [iso2, matched] of perCountry) {
    const existing = out.get(iso2);
    if (existing?.basis === 'dataset') {
      // Keep the dataset verdict, but record the reporting alongside it.
      existing.conflictStories = matched.length;
      continue;
    }

    const owners = new Set(matched.flatMap(independentOwners));
    if (owners.size < 2) continue;

    const status: ConflictStatus =
      matched.length >= WAR_STORY_FLOOR
        ? 'war'
        : matched.length >= CONFLICT_STORY_FLOOR
          ? 'conflict'
          : 'tension';

    out.set(iso2, {
      iso2,
      status,
      basis: 'two-outlet',
      evidence: matched.slice(0, 8).map((s) => ({
        source: `${s.primary.outlet.name} (+${Math.max(0, s.outletCount - 1)} more)`,
        url: s.primary.url,
        retrievedAt: s.latestAt,
      })),
      reason:
        `No conflict-dataset row. ${matched.length} confirmed conflict ` +
        `${matched.length === 1 ? 'story' : 'stories'} in the last 7 days across ` +
        `${owners.size} independently owned outlets (${[...owners].slice(0, 4).join(', ')}` +
        `${owners.size > 4 ? ', and others' : ''}).`,
      conflictStories: matched.length,
    });
  }

  // --- Pass 3: peace, but only on a dataset's negative evidence ------------
  // A country is marked at peace only when a global conflict dataset was
  // loaded and does not list it. Reporting silence is never enough, so
  // without a dataset every quiet country stays 'unknown'.
  if (datasetCoversWorld) {
    for (const country of COUNTRY_LIST) {
      if (out.has(country.iso2)) continue;
      out.set(country.iso2, {
        iso2: country.iso2,
        status: 'peace',
        basis: 'dataset',
        evidence: datasetProvenance ? [datasetProvenance] : [],
        reason:
          `${datasetProvenance?.source ?? 'The conflict dataset'} covers every country ` +
          `and lists no active conflict here.`,
        conflictStories: 0,
      });
    }
  }

  return out;
}

/**
 * Countries with reporting that falls short of the conflict bar but shows
 * sustained political friction are marked 'tension'. Kept separate from
 * deriveStatuses so the conflict rule stays easy to audit on its own.
 */
export function deriveTension(stories: Story[], already: Map<string, StatusResult>): void {
  const cutoff = Date.now() - CONFLICT_WINDOW_MS;
  const counts = new Map<string, Set<string>>();

  for (const story of stories) {
    if (Date.parse(story.latestAt) < cutoff) continue;
    if (story.confidence !== 'confirmed') continue;
    const tense = story.categories.includes('war') || story.categories.includes('politics');
    if (!tense) continue;
    // Only headlines naming friction, not routine politics.
    if (!/sanction|tension|dispute|standoff|stand-off|border|threat|ultimatum|expel|recall(ed)? (its )?ambassador|airspace|incursion|mobilis|mobiliz|war of words|cut ties|sever(ed)? (diplomatic )?(ties|relations)/i.test(story.title)) {
      continue;
    }
    for (const iso2 of story.countries) {
      if (already.get(iso2)) continue;
      let set = counts.get(iso2);
      if (!set) counts.set(iso2, (set = new Set()));
      for (const owner of independentOwners(story)) set.add(owner);
    }
  }

  for (const [iso2, owners] of counts) {
    if (owners.size < 2 || already.has(iso2)) continue;
    already.set(iso2, {
      iso2,
      status: 'tension',
      basis: 'two-outlet',
      evidence: [],
      reason:
        `No conflict evidence. ${owners.size} independently owned outlets reported ` +
        `diplomatic or border friction in the last 7 days.`,
      conflictStories: 0,
    });
  }
}

export const STATUS_LABELS: Record<ConflictStatus, string> = {
  war: 'At war',
  conflict: 'Active conflict',
  tension: 'Tension',
  peace: 'At peace',
  unknown: 'No data',
};

/**
 * Status order for sorting, most severe first. 'unknown' sorts after 'peace'
 * so countries with evidence always surface above those without.
 */
export const STATUS_RANK: Record<ConflictStatus, number> = {
  war: 0,
  conflict: 1,
  tension: 2,
  peace: 3,
  unknown: 4,
};
