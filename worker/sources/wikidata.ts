import type { Leader, Relation, SourceHealth } from '../types';
import type { Fetched } from './fetchers';
import { errorMessage, fetchJson, type FetchOptions } from '../lib/http';

/**
 * Wikidata SPARQL. The queries below are the ones verified by
 * scripts/verify-sources.mjs; the comments record why each is shaped as it is,
 * because the obvious formulations are subtly wrong.
 */

const ENDPOINT = 'https://query.wikidata.org/sparql';

type Bindings = Array<Record<string, { value: string }>>;

/** Wikidata rejects requests that do not carry a descriptive User-Agent. */
async function sparql(query: string, opts: FetchOptions, timeoutMs = 25_000): Promise<Bindings> {
  const json = await fetchJson<{ results?: { bindings?: Bindings } }>(
    `${ENDPOINT}?${new URLSearchParams({ query, format: 'json' })}`,
    {
      ...opts,
      timeoutMs,
      cacheTtl: 1800,
      headers: { accept: 'application/sparql-results+json' },
    },
  );
  const rows = json.results?.bindings;
  if (!Array.isArray(rows)) throw new Error('no results.bindings in response');
  return rows;
}

/** Wikidata intermittently answers 502; one retry clears it in practice. */
async function sparqlWithRetry(query: string, opts: FetchOptions, timeoutMs?: number): Promise<Bindings> {
  try {
    return await sparql(query, opts, timeoutMs);
  } catch (first) {
    await new Promise((r) => setTimeout(r, 1200));
    try {
      return await sparql(query, opts, timeoutMs);
    } catch {
      throw first;
    }
  }
}

const now = () => new Date().toISOString();

const mkHealth = (
  id: string,
  name: string,
  started: number,
  ok: boolean,
  count: number,
  error: string | null,
): SourceHealth => ({
  id,
  name,
  url: ENDPOINT,
  ok,
  count,
  error,
  ms: Date.now() - started,
  checkedAt: now(),
});

/**
 * Current heads of state and heads of government.
 *
 * Two queries rather than one UNION: combined they take around 40 seconds and
 * risk Wikidata's 60-second timeout, while each half returns in 3-9.
 *
 * The role is taken from the property used (P35 head of state, P6 head of
 * government) rather than from the country's designated-office property
 * (P1906 / P1313). Those two can disagree: for Iran, P1906 reads "President
 * of Iran" while the head-of-state statement names the Supreme Leader. The
 * property itself cannot mismatch.
 *
 * Statements carrying an end date (P582) are excluded, so a former holder
 * never appears as current.
 */
export async function fetchLeaders(opts: FetchOptions = {}): Promise<Fetched<Leader[]>> {
  const started = Date.now();
  const leaders: Leader[] = [];
  try {
    for (const [prop, role] of [
      ['P35', 'Head of state'],
      ['P6', 'Head of government'],
    ] as const) {
      const rows = await sparqlWithRetry(`
        SELECT ?iso ?person ?personLabel ?start WHERE {
          ?country wdt:P297 ?iso ; p:${prop} ?st .
          ?st ps:${prop} ?person .
          FILTER NOT EXISTS { ?st pq:P582 ?end }
          OPTIONAL { ?st pq:P580 ?start }
          SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
        }
      `, opts);
      for (const r of rows) {
        const iso2 = r.iso?.value;
        const name = r.personLabel?.value;
        const entity = r.person?.value;
        if (!iso2 || !/^[A-Z]{2}$/.test(iso2) || !name || !entity) continue;
        // An unresolved label comes back as the bare Q-id; showing that to a
        // reader is worse than showing nothing.
        if (/^Q\d+$/.test(name)) continue;
        const qid = entity.split('/').pop() ?? '';
        leaders.push({
          countryIso2: iso2,
          position: role,
          name,
          since: r.start?.value?.slice(0, 10) ?? null,
          wikidataId: qid,
          provenance: {
            source: 'Wikidata',
            url: `https://www.wikidata.org/wiki/${qid}`,
            retrievedAt: now(),
          },
        });
      }
    }
    return {
      data: leaders,
      health: mkHealth('wikidata-leaders', 'Wikidata (leaders)', started, true, leaders.length, null),
    };
  } catch (err) {
    return {
      data: [],
      health: mkHealth('wikidata-leaders', 'Wikidata (leaders)', started, false, 0, errorMessage(err)),
    };
  }
}

/** Bodies the app surfaces. Extending this list is the only change needed. */
const ORGS: Array<{ qid: string; abbreviation: string | null }> = [
  { qid: 'Q7184', abbreviation: 'NATO' },
  { qid: 'Q458', abbreviation: 'EU' },
  { qid: 'Q7172', abbreviation: 'OAS' },
  { qid: 'Q1065', abbreviation: 'UN' },
  { qid: 'Q170481', abbreviation: 'Arab League' },
  { qid: 'Q7825', abbreviation: 'AU' },
  { qid: 'Q7159', abbreviation: 'ASEAN' },
  { qid: 'Q188822', abbreviation: 'OPEC' },
  { qid: 'Q170304', abbreviation: 'CIS' },
  { qid: 'Q842490', abbreviation: 'CSTO' },
  { qid: 'Q1147410', abbreviation: 'SCO' },
  { qid: 'Q189255', abbreviation: 'BRICS' },
];

/**
 * Organisation membership and declared diplomatic relations.
 *
 * Membership is read from both directions, because Wikidata records some of it
 * on the country (P463 "member of") and some on the organisation (P527 "has
 * part"), and neither side alone is complete.
 *
 * The ISO code is resolved through P17 as well as directly, because some
 * members hold their membership on one item and their ISO code on another:
 * the Netherlands (Q55) carries NATO and EU membership while the Kingdom of
 * the Netherlands (Q29999) carries ISO "NL". Without the P17 hop this query
 * returns NATO 31 / EU 26 and silently drops the Netherlands.
 *
 * Excluding statements with an end date is what correctly removes the United
 * Kingdom from the EU.
 */
export async function fetchRelations(opts: FetchOptions = {}): Promise<Fetched<Relation[]>> {
  const started = Date.now();
  const byCountry = new Map<string, Relation>();
  const ensure = (iso2: string): Relation => {
    let rel = byCountry.get(iso2);
    if (!rel) {
      byCountry.set(iso2, (rel = {
        countryIso2: iso2,
        organizations: [],
        allies: [],
        adversaries: [],
        provenance: {
          source: 'Wikidata',
          url: `https://www.wikidata.org/wiki/Special:EntityData?id=${iso2}`,
          retrievedAt: now(),
        },
      }));
    }
    return rel;
  };

  try {
    const values = ORGS.map((o) => `wd:${o.qid}`).join(' ');
    const orgRows = await sparqlWithRetry(`
      SELECT DISTINCT ?iso ?org ?orgLabel WHERE {
        VALUES ?org { ${values} }
        { ?m p:P463 ?st . ?st ps:P463 ?org . FILTER NOT EXISTS { ?st pq:P582 ?e1 } }
        UNION
        { ?org p:P527 ?st . ?st ps:P527 ?m . FILTER NOT EXISTS { ?st pq:P582 ?e2 } }
        { ?m wdt:P297 ?iso } UNION { ?m wdt:P17 ?par . ?par wdt:P297 ?iso }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
      }
    `, opts, 40_000);

    const abbrevByQid = new Map(ORGS.map((o) => [o.qid, o.abbreviation]));
    for (const r of orgRows) {
      const iso2 = r.iso?.value;
      const label = r.orgLabel?.value;
      const qid = r.org?.value?.split('/').pop() ?? '';
      if (!iso2 || !/^[A-Z]{2}$/.test(iso2) || !label) continue;
      const rel = ensure(iso2);
      if (rel.organizations.some((o) => o.wikidataId === qid)) continue;
      rel.organizations.push({ name: label, wikidataId: qid, abbreviation: abbrevByQid.get(qid) ?? null });
    }

    /*
     * P530 "diplomatic relation" records that two states have relations at
     * all. It is not a claim of alliance, so it is surfaced under the honest
     * label "has diplomatic relations with" and never as "ally" on its own.
     * Real alignment shown in the UI comes from shared membership of a defence
     * body, which is a verifiable fact rather than an interpretation.
     */
    const relRows = await sparqlWithRetry(`
      SELECT ?iso ?otherIso WHERE {
        ?country wdt:P297 ?iso ; wdt:P530 ?other .
        ?other wdt:P297 ?otherIso .
      }
    `, opts, 40_000);

    const DEFENCE_BODIES = new Set(['Q7184', 'Q842490']);
    for (const r of relRows) {
      const a = r.iso?.value;
      const b = r.otherIso?.value;
      if (!a || !b || a === b) continue;
      if (!/^[A-Z]{2}$/.test(a) || !/^[A-Z]{2}$/.test(b)) continue;
      const rel = ensure(a);
      if (rel.allies.length >= 40) continue;
      if (rel.allies.some((x) => x.iso2 === b)) continue;
      rel.allies.push({ iso2: b, name: b, basis: 'Wikidata P530 diplomatic relation' });
    }

    // Promote shared defence-pact membership above bare diplomatic relations,
    // since that is the strongest alignment signal available from this source.
    for (const rel of byCountry.values()) {
      const pacts = rel.organizations.filter((o) => DEFENCE_BODIES.has(o.wikidataId));
      if (!pacts.length) continue;
      for (const other of byCountry.values()) {
        if (other.countryIso2 === rel.countryIso2) continue;
        const shared = pacts.find((p) => other.organizations.some((o) => o.wikidataId === p.wikidataId));
        if (!shared) continue;
        const existing = rel.allies.find((a) => a.iso2 === other.countryIso2);
        const basis = `Both members of ${shared.abbreviation ?? shared.name} (Wikidata)`;
        if (existing) existing.basis = basis;
        else rel.allies.unshift({ iso2: other.countryIso2, name: other.countryIso2, basis });
      }
    }

    const data = [...byCountry.values()];
    return {
      data,
      health: mkHealth('wikidata-relations', 'Wikidata (alliances)', started, true, data.length, null),
    };
  } catch (err) {
    return {
      data: [],
      health: mkHealth('wikidata-relations', 'Wikidata (alliances)', started, false, 0, errorMessage(err)),
    };
  }
}
