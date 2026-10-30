import type { ConflictParty, ConflictRecord, Provenance, SourceHealth } from '../types';
import type { Fetched } from './fetchers';
import { COUNTRY_LIST, findCountry } from '../lib/match';
import { errorMessage, fetchJson, type FetchOptions } from '../lib/http';

/**
 * Conflict datasets.
 *
 * UCDP is the primary source. It used to be open; it now requires an access
 * token, so without one this returns nothing and the app falls back to the
 * two-independent-outlet rule in lib/status.ts. That fallback is why a missing
 * token degrades the app rather than breaking it, and why country colours
 * always state which basis produced them.
 */

const UCDP_BASE = 'https://ucdpapi.pcr.uu.se/api';

/**
 * UCDP dataset version in the URL path. It changes each release, so the
 * newest known version is tried first and older ones after, rather than
 * pinning one that will silently 404 in a year.
 */
const UCDP_VERSIONS = ['25.1', '24.1', '23.1'];

interface GedRow {
  country?: string;
  country_id?: number;
  conflict_name?: string;
  conflict_new_id?: number;
  side_a?: string;
  side_b?: string;
  date_start?: string;
  date_end?: string;
  best?: number;
  type_of_violence?: number;
}

/** UCDP's own numbering for violence type, mapped to its published labels. */
const VIOLENCE_TYPE: Record<number, string> = {
  1: 'State-based conflict',
  2: 'Non-state conflict',
  3: 'One-sided violence',
};

const nameToIso = (() => {
  const index = new Map<string, string>();
  for (const c of COUNTRY_LIST) {
    for (const n of c.match.names) index.set(n.toLowerCase(), c.iso2);
  }
  return (name: string): string | null => {
    const direct = index.get(name.trim().toLowerCase());
    if (direct) return direct;
    return findCountry(name)?.iso2 ?? null;
  };
})();

/** Resolves a conflict party name to a state when it is one. */
function toParty(name: string): ConflictParty {
  const trimmed = name.trim();
  // UCDP names governments as "Government of X".
  const gov = /^Government of (.+)$/i.exec(trimmed);
  const candidate = gov?.[1] ?? trimmed;
  return { name: trimmed, iso2: nameToIso(candidate) };
}

export async function fetchConflicts(
  token: string | undefined,
  opts: FetchOptions = {},
): Promise<Fetched<{ byCountry: ConflictRecord[]; coversWorld: boolean; provenance: Provenance | null }>> {
  const started = Date.now();
  const base: SourceHealth = {
    id: 'ucdp-ged',
    name: 'UCDP Georeferenced Event Dataset',
    url: `${UCDP_BASE}/gedevents`,
    ok: false,
    count: 0,
    error: null,
    ms: 0,
    checkedAt: new Date().toISOString(),
  };
  const empty = { byCountry: [], coversWorld: false, provenance: null };

  if (!token) {
    return {
      data: empty,
      health: {
        ...base,
        ms: Date.now() - started,
        error:
          'UCDP_API_TOKEN is not set (UCDP now requires one). Country status falls back ' +
          'to the two-independent-outlet rule. Register at https://ucdp.uu.se/apidocs/',
      },
    };
  }

  let lastError = 'no UCDP version responded';
  for (const version of UCDP_VERSIONS) {
    const url = `${UCDP_BASE}/gedevents/${version}?pagesize=1000`;
    try {
      const json = await fetchJson<{ Result?: GedRow[]; TotalCount?: number }>(url, {
        ...opts,
        timeoutMs: 20_000,
        cacheTtl: 3600,
        headers: { 'x-ucdp-access-token': token },
      });
      const rows = json.Result ?? [];
      if (!rows.length) {
        lastError = `version ${version} returned no rows`;
        continue;
      }

      // Group events into one record per country, keeping each named conflict
      // distinct so the panel can list who is fighting whom.
      const byCountry = new Map<string, ConflictRecord>();
      for (const row of rows) {
        if (!row.country) continue;
        const iso2 = nameToIso(row.country);
        if (!iso2) continue;

        let rec = byCountry.get(iso2);
        if (!rec) {
          byCountry.set(iso2, (rec = {
            countryIso2: iso2,
            status: 'conflict',
            conflicts: [],
            basis: 'dataset',
            evidence: [],
            provenance: {
              source: `UCDP GED v${version}`,
              url: 'https://ucdp.uu.se/',
              retrievedAt: new Date().toISOString(),
            },
          }));
        }

        const name = row.conflict_name ?? 'Unnamed conflict';
        let conflict = rec.conflicts.find((c) => c.name === name);
        if (!conflict) {
          conflict = {
            name,
            sideA: row.side_a ? [toParty(row.side_a)] : [],
            sideB: row.side_b ? [toParty(row.side_b)] : [],
            deaths: 0,
            typeOfViolence: row.type_of_violence != null ? VIOLENCE_TYPE[row.type_of_violence] ?? null : null,
            startDate: row.date_start ?? null,
            latestEventDate: row.date_end ?? row.date_start ?? null,
          };
          rec.conflicts.push(conflict);
        } else {
          // Merge further parties reported for the same named conflict.
          if (row.side_a && !conflict.sideA.some((p) => p.name === row.side_a)) {
            conflict.sideA.push(toParty(row.side_a));
          }
          if (row.side_b && !conflict.sideB.some((p) => p.name === row.side_b)) {
            conflict.sideB.push(toParty(row.side_b));
          }
        }

        conflict.deaths = (conflict.deaths ?? 0) + (row.best ?? 0);
        const when = row.date_end ?? row.date_start;
        if (when && (!conflict.latestEventDate || when > conflict.latestEventDate)) {
          conflict.latestEventDate = when;
        }
        if (row.date_start && (!conflict.startDate || row.date_start < conflict.startDate)) {
          conflict.startDate = row.date_start;
        }
      }

      for (const rec of byCountry.values()) {
        rec.evidence = rec.conflicts.slice(0, 5).map((c) => ({
          source: `UCDP GED v${version}: ${c.name}`,
          url: 'https://ucdp.uu.se/',
          retrievedAt: c.latestEventDate ?? new Date().toISOString(),
        }));
      }

      return {
        data: {
          byCountry: [...byCountry.values()],
          // GED is global, so a country's absence from it is meaningful and
          // can support an "at peace" reading.
          coversWorld: true,
          provenance: {
            source: `UCDP GED v${version}`,
            url: 'https://ucdp.uu.se/',
            retrievedAt: new Date().toISOString(),
          },
        },
        health: {
          ...base,
          url,
          ok: true,
          count: byCountry.size,
          ms: Date.now() - started,
        },
      };
    } catch (err) {
      lastError = `${version}: ${errorMessage(err)}`;
    }
  }

  return { data: empty, health: { ...base, ms: Date.now() - started, error: lastError } };
}
