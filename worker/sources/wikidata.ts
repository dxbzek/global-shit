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

/**
 * Minimum country members for a body to count as multilateral. Below this, a
 * "membership" is usually a bilateral or technical arrangement that says
 * nothing useful about alignment.
 */
const MIN_ORG_MEMBERS = 8;

/**
 * Organisations are discovered from the data rather than hardcoded.
 *
 * An earlier version carried a hand-written map of QIDs to abbreviations. It
 * was wrong: Q7825 is the World Trade Organization, not the African Union, and
 * Q842490 is the OPCW, not a defence pact, so countries were shown memberships
 * they do not hold. Reading the organisation, its label and its short name
 * straight from Wikidata removes that whole class of error.
 */
async function discoverOrganisations(
  opts: FetchOptions,
): Promise<Array<{ qid: string; label: string; short: string | null; members: number }>> {
  const rows = await sparqlWithRetry(`
    SELECT ?org ?orgLabel ?short (COUNT(DISTINCT ?iso) AS ?n) WHERE {
      ?m wdt:P297 ?iso ; wdt:P463 ?org .
      OPTIONAL { ?org wdt:P1813 ?short . FILTER(LANG(?short) = "en") }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
    }
    GROUP BY ?org ?orgLabel ?short
    HAVING (COUNT(DISTINCT ?iso) >= ${MIN_ORG_MEMBERS})
    ORDER BY DESC(?n)
  `, opts, 40_000);

  const out: Array<{ qid: string; label: string; short: string | null; members: number }> = [];
  for (const r of rows) {
    const qid = r.org?.value?.split('/').pop();
    const label = r.orgLabel?.value;
    if (!qid || !label || /^Q\d+$/.test(label)) continue;
    out.push({
      qid,
      label,
      short: r.short?.value ?? null,
      members: Number(r.n?.value ?? 0),
    });
  }
  return out;
}

export async function fetchRelations(opts: FetchOptions = {}): Promise<Fetched<Relation[]>> {
  const started = Date.now();
  try {
    const orgs = await discoverOrganisations(opts);
    if (!orgs.length) throw new Error('no multilateral organisations discovered');
    const byQid = new Map(orgs.map((o) => [o.qid, o]));

    /*
     * Membership is read from both directions, because Wikidata records some
     * of it on the country (P463 "member of") and some on the organisation
     * (P527 "has part"), and neither side alone is complete.
     *
     * The ISO code is resolved through P17 as well as directly, because some
     * members hold membership on one item and their ISO code on another: the
     * Netherlands (Q55) carries NATO and EU membership while the Kingdom of
     * the Netherlands (Q29999) carries ISO "NL". Without that hop this query
     * returns NATO 31 / EU 26 and silently drops the Netherlands.
     *
     * The hop is gated on the member being `instance of country` (Q6256) and
     * having no ISO code of its own. Ungated, any entity with P17 pointing at
     * a country inherited that country's ISO code, which handed Ukraine a
     * membership of the African Union.
     *
     * Excluding statements with an end date is what correctly removes the
     * United Kingdom from the EU.
     */
    const values = orgs.map((o) => `wd:${o.qid}`).join(' ');
    const rows = await sparqlWithRetry(`
      SELECT DISTINCT ?iso ?org WHERE {
        VALUES ?org { ${values} }
        { ?m p:P463 ?st . ?st ps:P463 ?org . FILTER NOT EXISTS { ?st pq:P582 ?e1 } }
        UNION
        { ?org p:P527 ?st . ?st ps:P527 ?m . FILTER NOT EXISTS { ?st pq:P582 ?e2 } }
        { ?m wdt:P297 ?iso }
        UNION
        {
          ?m wdt:P31 wd:Q6256 ; wdt:P17 ?par .
          ?par wdt:P297 ?iso .
          FILTER NOT EXISTS { ?m wdt:P297 ?own }
        }
      }
    `, opts, 60_000);

    const byCountry = new Map<string, Relation>();
    for (const r of rows) {
      const iso2 = r.iso?.value;
      const qid = r.org?.value?.split('/').pop();
      if (!iso2 || !/^[A-Z]{2}$/.test(iso2) || !qid) continue;
      const org = byQid.get(qid);
      if (!org) continue;

      let rel = byCountry.get(iso2);
      if (!rel) {
        byCountry.set(iso2, (rel = {
          countryIso2: iso2,
          organizations: [],
          allies: [],
          adversaries: [],
          provenance: {
            source: 'Wikidata',
            url: 'https://query.wikidata.org/',
            retrievedAt: now(),
          },
        }));
      }
      if (rel.organizations.some((o) => o.wikidataId === qid)) continue;
      rel.organizations.push({ name: org.label, wikidataId: qid, abbreviation: org.short });
    }

    /*
     * Memberships are listed smallest-first. A shared membership of a
     * 20-member body says far more about alignment than a shared membership of
     * the UN, so the panel and the globe lines both lead with the specific.
     *
     * Allies are not asserted here. Who shares a body with whom is computed
     * when a country is requested, from these lists, and is labelled as
     * exactly that: a shared membership, never an inferred alliance.
     */
    const memberCount = (qid: string) => byQid.get(qid)?.members ?? Number.MAX_SAFE_INTEGER;
    for (const rel of byCountry.values()) {
      rel.organizations.sort((a, b) => memberCount(a.wikidataId) - memberCount(b.wikidataId));
    }

    const data = [...byCountry.values()];
    return {
      data,
      health: mkHealth(
        'wikidata-relations',
        'Wikidata (memberships)',
        started,
        true,
        data.length,
        null,
      ),
    };
  } catch (err) {
    return {
      data: [],
      health: mkHealth('wikidata-relations', 'Wikidata (memberships)', started, false, 0, errorMessage(err)),
    };
  }
}
