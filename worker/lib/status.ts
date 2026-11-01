import type { ConflictRecord, ConflictStatus, Provenance, Story } from '../types';
import { independentOwners } from './dedupe';
import { COUNTRY_LIST } from './countries.generated';
import { activeHostilityTerms, hostilityOwnerPhrases, SUPRANATIONAL } from './categorize';
import { findCountry } from './match';

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
 * Bands over the evidence, not claims of their own.
 *
 * These measure how widely and how heavily independent outlets are reporting
 * active hostilities, which is evidence strength - not a measurement of a
 * war's intensity, which this app cannot observe. The UI always shows the
 * underlying outlet count and the stories behind a band.
 *
 * Two independently owned outlets is the floor for any status at all, which
 * is the rule as specified. In live data that floor is what separates genuine
 * conflict reporting from metaphor: "fighting for its economic life" and
 * 'coup' in scare quotes each appeared in exactly one outlet.
 */
const WAR_OWNER_FLOOR = 4;
const WAR_STORY_FLOOR = 8;
/*
 * Two independently owned outlets reporting active hostilities is the bar, as
 * specified. An extra third-story requirement sat on top of it and was
 * demoting real wars: Sudan (Guardian on paramilitary drone strikes, BBC on
 * hospitals being targeted) and Yemen (UN News, Guardian on besieged Taiz)
 * each had two independent owners and were being shown as mere "tension".
 */
const CONFLICT_STORY_FLOOR = 2;
const MIN_INDEPENDENT_OWNERS = 2;

/*
 * Status is attributed only to a story's PRIMARY country: the leading country
 * matched in the headline. Using the whole match list, even trimmed to the
 * first two, attributed hostilities to the wrong place - "Evacuated Ukrainians
 * from Russian-occupied Oleshky arrive in Belarus" made Belarus a conflict
 * zone, and a story about people killed in Ethiopia did the same to France,
 * which was only named in the summary.
 */

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

  /*
   * --- Pass 2: the two-independent-outlet rule --------------------------
   *
   * The rule as specified is that at least two independent outlets support
   * the status. An earlier version required two independent outlets on the
   * *same* clustered story, and then two such stories; that is a far higher
   * bar than asked for, and with the working feed list it produced a status
   * for no country at all - every country on the globe read "No data".
   *
   * What counts here is distinct independently owned outlets reporting
   * active hostilities involving the country, across the window. A story
   * qualifies only when its HEADLINE carries an active-hostility term and the
   * country is a leading match, so arms sales, defence policy, war history
   * and political metaphor do not colour a country as a war zone.
   */
  const cutoff = Date.now() - CONFLICT_WINDOW_MS;

  interface Evidence {
    owners: Set<string>;
    stories: Story[];
    terms: Set<string>;
  }
  const perCountry = new Map<string, Evidence>();

  for (const story of stories) {
    if (Date.parse(story.latestAt) < cutoff) continue;

    const terms = activeHostilityTerms(story.title);
    if (!terms.length) continue;

    const owners = independentOwners(story);
    if (!owners.length) continue;

    /*
     * A war named in a headline often belongs somewhere else, and the country
     * the headline leads with is a bystander. "Chinese firm agrees to build
     * rail tunnels in Qatar amid Iran war" was making Qatar a conflict zone,
     * and "Tunisians drawn into Russia's war in Ukraine" did the same to
     * Tunisia. Where the headline binds the hostilities to a named place, the
     * country must be one of those places.
     */
    const phrases = hostilityOwnerPhrases(story.title);
    let attributedTo: Set<string> | null = null;
    if (phrases.length) {
      /*
       * Resolved by exact name, not by the headline matcher. The matcher
       * holds "iran" and "china" as ambiguous words that need supporting
       * context, which is right for a headline and wrong here: an owner
       * phrase is already an explicit place name, and leaving them
       * unresolved let "rail tunnels in Qatar amid Iran war" through.
       */
      const resolved = new Set(
        phrases
          .map((phrase) => findCountry(phrase.replace(/['\u2019]s$/, '').trim())?.iso2)
          .filter((iso2): iso2 is string => Boolean(iso2)),
      );
      if (resolved.size) {
        // The headline names the countries whose war this is.
        attributedTo = resolved;
      } else if (phrases.some((phrase) => SUPRANATIONAL.test(phrase.trim()))) {
        // A war belonging to a whole region is evidence about no one country.
        continue;
      }
      // Otherwise the place is unresolvable and usually sub-national (Tigray,
      // Darfur), so it does not override the country the headline is about.
    }

    for (const iso2 of story.primaryCountries) {
      if (attributedTo && !attributedTo.has(iso2)) continue;
      let ev = perCountry.get(iso2);
      if (!ev) perCountry.set(iso2, (ev = { owners: new Set(), stories: [], terms: new Set() }));
      for (const owner of owners) ev.owners.add(owner);
      for (const term of terms) ev.terms.add(term);
      ev.stories.push(story);
    }
  }

  for (const [iso2, ev] of perCountry) {
    const existing = out.get(iso2);
    if (existing?.basis === 'dataset') {
      // Keep the dataset verdict; record the reporting beside it.
      existing.conflictStories = ev.stories.length;
      continue;
    }

    if (ev.owners.size < MIN_INDEPENDENT_OWNERS) continue;

    const status: ConflictStatus =
      ev.owners.size >= WAR_OWNER_FLOOR && ev.stories.length >= WAR_STORY_FLOOR
        ? 'war'
        : ev.stories.length >= CONFLICT_STORY_FLOOR
          ? 'conflict'
          : 'tension';

    const outletList = [...ev.owners].slice(0, 4).join(', ');
    const termList = [...ev.terms].slice(0, 4).join(', ');

    out.set(iso2, {
      iso2,
      status,
      basis: 'two-outlet',
      evidence: ev.stories
        .sort((a, b) => Date.parse(b.latestAt) - Date.parse(a.latestAt))
        .slice(0, 8)
        .map((story) => ({
          source: `${story.primary.outlet.name}: ${story.title}`,
          url: story.primary.url,
          retrievedAt: story.latestAt,
        })),
      reason:
        `No conflict-dataset row. ${ev.owners.size} independently owned outlets ` +
        `(${outletList}${ev.owners.size > 4 ? ', and others' : ''}) reported active ` +
        `hostilities involving this country in ${ev.stories.length} ` +
        `${ev.stories.length === 1 ? 'story' : 'stories'} over the last 7 days, on terms ` +
        `including "${termList}". This reflects how widely the fighting is being ` +
        `reported, not a measurement of its scale.`,
      conflictStories: ev.stories.length,
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

  /*
   * Friction named in a headline, not routine politics. The same two-outlet
   * rule applies, and for the same reason: a single outlet's framing of a
   * disagreement as a "standoff" is not evidence that one exists.
   *
   * This counts distinct owners across the country's friction stories rather
   * than requiring two owners on one story - the stricter reading produced a
   * tension status for no country at all.
   */
  const FRICTION =
    /\bsanction|\btension|\bdispute|\bstandoff|\bstand-off|\bultimatum|\bexpel|recall(ed)? (its )?ambassador|\bairspace (violation|incursion)|\bincursion|\bmobilis|\bmobiliz|war of words|cut ties|sever(ed)? (diplomatic )?(ties|relations)|border (clash|dispute|closure)/i;

  interface Friction {
    owners: Set<string>;
    stories: Story[];
  }
  const counts = new Map<string, Friction>();

  for (const story of stories) {
    if (Date.parse(story.latestAt) < cutoff) continue;
    if (!FRICTION.test(story.title)) continue;

    const owners = independentOwners(story);
    if (!owners.length) continue;

    for (const iso2 of story.primaryCountries) {
      // A country that already has a conflict status keeps it; tension is
      // only for countries with friction and no fighting.
      if (already.has(iso2)) continue;
      let f = counts.get(iso2);
      if (!f) counts.set(iso2, (f = { owners: new Set(), stories: [] }));
      for (const owner of owners) f.owners.add(owner);
      f.stories.push(story);
    }
  }

  for (const [iso2, f] of counts) {
    if (f.owners.size < MIN_INDEPENDENT_OWNERS || already.has(iso2)) continue;
    already.set(iso2, {
      iso2,
      status: 'tension',
      basis: 'two-outlet',
      evidence: f.stories
        .sort((a, b) => Date.parse(b.latestAt) - Date.parse(a.latestAt))
        .slice(0, 6)
        .map((story) => ({
          source: `${story.primary.outlet.name}: ${story.title}`,
          url: story.primary.url,
          retrievedAt: story.latestAt,
        })),
      reason:
        `No reporting of active hostilities. ${f.owners.size} independently owned outlets ` +
        `(${[...f.owners].slice(0, 3).join(', ')}) reported diplomatic or border friction ` +
        `in ${f.stories.length} ${f.stories.length === 1 ? 'story' : 'stories'} over the last 7 days.`,
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
