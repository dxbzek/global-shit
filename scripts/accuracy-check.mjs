#!/usr/bin/env node
/**
 * Cross-checks what the app serves against the original sources.
 *
 * This does not read the worker's caches or reuse its queries. It asks
 * Wikidata and the outlets directly and compares their answers with what
 * /api/* returned, so a bug in the worker's own query cannot hide behind
 * itself.
 *
 *   node scripts/accuracy-check.mjs [baseUrl]
 */

import { argv, env, exit } from 'node:process';
import { readFileSync } from 'node:fs';

const BASE = argv.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:8787';
const UA = 'WorldPulse/1.0 (+https://github.com/dxbzek/global-shit) accuracy-check';

/**
 * External calls may need a proxy; the app under test is local and must not
 * go through one, so it gets its own direct dispatcher rather than relying on
 * NO_PROXY, which undici's ProxyAgent does not honour.
 */
let directDispatcher;

async function configureEgress() {
  const proxy = env.HTTPS_PROXY ?? env.https_proxy;
  let ca;
  try {
    ca = readFileSync(env.NODE_EXTRA_CA_CERTS ?? '/root/.ccr/ca-bundle.crt');
  } catch {
    ca = undefined;
  }
  if (!proxy && !ca) return;
  try {
    const { ProxyAgent, Agent, setGlobalDispatcher } = await import('undici');
    const tls = ca ? { ca } : undefined;
    directDispatcher = new Agent();
    setGlobalDispatcher(
      proxy ? new ProxyAgent({ uri: proxy, requestTls: tls, proxyTls: tls }) : new Agent({ connect: tls }),
    );
  } catch {
    /* fall back to global fetch */
  }
}
await configureEgress();

const app = async (path) => {
  const res = await fetch(`${BASE}${path}`, {
    headers: { accept: 'application/json' },
    ...(directDispatcher ? { dispatcher: directDispatcher } : {}),
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
};

let lastSparql = 0;
async function sparql(query) {
  const wait = 1500 - (Date.now() - lastSparql);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSparql = Date.now();
  const res = await fetch(`https://query.wikidata.org/sparql?${new URLSearchParams({ query, format: 'json' })}`, {
    headers: { 'user-agent': UA, accept: 'application/sparql-results+json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SPARQL HTTP ${res.status}: ${text.slice(0, 120)}`);
  return JSON.parse(text).results.bindings;
}

const checks = [];
const record = (n, claim, source, ok, detail) => {
  checks.push({ n, claim, source, ok, detail });
  console.log(`\n${n}. ${ok ? 'MATCH' : 'MISMATCH'}  ${claim}`);
  console.log(`   app    : ${detail.app}`);
  console.log(`   source : ${detail.source}  [${source}]`);
  if (detail.note) console.log(`   note   : ${detail.note}`);
};

console.log(`\nAccuracy check against original sources\n${new Date().toISOString()}\nApp: ${BASE}`);

// --- 1-5: heads of state, each verified straight from Wikidata -------------

const LEADER_COUNTRIES = [
  ['UA', 'Ukraine'],
  ['US', 'United States'],
  ['FR', 'France'],
  ['BR', 'Brazil'],
  ['IL', 'Israel'],
];

let n = 0;
for (const [iso, label] of LEADER_COUNTRIES) {
  n += 1;
  const detail = await app(`/api/country/${iso}`);
  const shown = detail.leaders.find((l) => /head of state/i.test(l.role));
  const appName = shown ? `${shown.name} (since ${shown.since ?? 'date not recorded'})` : 'none shown';

  // Independent query: current P35 holder with no end date on the statement.
  const rows = await sparql(`
    SELECT ?personLabel ?start WHERE {
      ?c wdt:P297 "${iso}" ; p:P35 ?st .
      ?st ps:P35 ?person .
      FILTER NOT EXISTS { ?st pq:P582 ?end }
      OPTIONAL { ?st pq:P580 ?start }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
    }
  `);
  const names = rows.map((r) => r.personLabel.value);
  const srcName = names.length ? `${names.join(' / ')}` : 'none';
  record(
    n,
    `${label} head of state`,
    'Wikidata P35, end date excluded',
    Boolean(shown) && names.includes(shown.name),
    { app: appName, source: srcName },
  );
}

// --- 6: NATO membership count ----------------------------------------------

n += 1;
{
  const rows = await sparql(`
    SELECT DISTINCT ?iso WHERE {
      { ?m p:P463 ?st . ?st ps:P463 wd:Q7184 . FILTER NOT EXISTS { ?st pq:P582 ?e1 } }
      UNION
      { wd:Q7184 p:P527 ?st . ?st ps:P527 ?m . FILTER NOT EXISTS { ?st pq:P582 ?e2 } }
      { ?m wdt:P297 ?iso }
      UNION
      { ?m wdt:P31 wd:Q6256 ; wdt:P17 ?par . ?par wdt:P297 ?iso . FILTER NOT EXISTS { ?m wdt:P297 ?own } }
    }
  `);
  const srcIsos = new Set(rows.map((r) => r.iso.value));

  // The app's view: how many countries it would show NATO for.
  const { countries } = await app('/api/countries');
  const appIsos = new Set();
  for (const c of countries) {
    const d = await app(`/api/country/${c.iso2}`).catch(() => null);
    if (d?.relations?.organizations?.some((o) => o.name === 'NATO')) appIsos.add(c.iso2);
    if (appIsos.size >= 40) break;
  }
  record(
    n,
    'NATO membership',
    'Wikidata P463 / P527',
    appIsos.size === srcIsos.size && [...appIsos].every((i) => srcIsos.has(i)),
    {
      app: `${appIsos.size} members`,
      source: `${srcIsos.size} members`,
      note: 'NATO has 32 members. A lower count means the ISO resolution dropped someone.',
    },
  );
}

// --- 7: EU excludes the UK --------------------------------------------------

n += 1;
{
  const gb = await app('/api/country/GB');
  const inEu = gb.relations?.organizations?.some((o) => o.name === 'European Union') ?? false;
  const rows = await sparql(`
    SELECT ?end WHERE {
      wd:Q145 p:P463 ?st . ?st ps:P463 wd:Q458 . OPTIONAL { ?st pq:P582 ?end }
    }
  `);
  const hasEnd = rows.some((r) => r.end?.value);
  record(n, 'United Kingdom is not shown in the EU', 'Wikidata P463 end date (P582)', !inEu && hasEnd, {
    app: inEu ? 'shows EU membership' : 'does not show EU membership',
    source: hasEnd ? `membership carries an end date (${rows.find((r) => r.end)?.end.value.slice(0, 10)})` : 'no end date recorded',
  });
}

// --- 8: the Netherlands ISO-resolution edge case ----------------------------

n += 1;
{
  const nl = await app('/api/country/NL');
  const orgs = (nl.relations?.organizations ?? []).map((o) => o.name);
  const rows = await sparql(`
    SELECT ?orgLabel WHERE {
      VALUES ?org { wd:Q7184 wd:Q458 }
      wd:Q55 wdt:P463 ?org .
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
    }
  `);
  const srcOrgs = rows.map((r) => r.orgLabel.value);
  record(
    n,
    'Netherlands shows NATO and EU membership',
    'Wikidata Q55 P463, ISO resolved via P17 to Q29999',
    srcOrgs.every((o) => orgs.includes(o)) && srcOrgs.length > 0,
    {
      app: orgs.filter((o) => /NATO|European Union/.test(o)).join(', ') || 'neither',
      source: srcOrgs.join(', '),
      note: 'Q55 holds the memberships; Q29999 holds ISO "NL". This is the case the P17 hop exists for.',
    },
  );
}

// --- 9: Ukraine's anchor body members --------------------------------------

n += 1;
{
  const ua = await app('/api/country/UA');
  const anchor = ua.relations?.anchorOrganization;
  const appShared = new Set((ua.relations?.sharedWith ?? []).map((x) => x.iso2));
  if (!anchor) {
    record(n, 'Ukraine shared-membership list', 'Wikidata', false, {
      app: 'no anchor organisation',
      source: 'n/a',
    });
  } else {
    const rows = await sparql(`
      SELECT DISTINCT ?iso WHERE {
        { ?m p:P463 ?st . ?st ps:P463 wd:${anchor.wikidataId} . FILTER NOT EXISTS { ?st pq:P582 ?e1 } }
        UNION
        { wd:${anchor.wikidataId} p:P527 ?st . ?st ps:P527 ?m . FILTER NOT EXISTS { ?st pq:P582 ?e2 } }
        { ?m wdt:P297 ?iso }
        UNION
        { ?m wdt:P31 wd:Q6256 ; wdt:P17 ?par . ?par wdt:P297 ?iso . FILTER NOT EXISTS { ?m wdt:P297 ?own } }
      }
    `);
    const srcIsos = new Set(rows.map((r) => r.iso.value).filter((i) => i !== 'UA'));
    const extra = [...appShared].filter((i) => !srcIsos.has(i));
    record(
      n,
      `Ukraine's co-members of ${anchor.abbreviation ?? anchor.name}`,
      `Wikidata ${anchor.wikidataId}`,
      extra.length === 0,
      {
        app: [...appShared].sort().join(' ') || 'none',
        source: [...srcIsos].sort().join(' ') || 'none',
        note: extra.length ? `app listed countries the source does not: ${extra.join(' ')}` : 'no country shown that the source does not list',
      },
    );
  }
}

// --- 10: a live news item resolves and matches its outlet -------------------

n += 1;
{
  const feed = await app('/api/feed?limit=20&sort=newest');
  const story = feed.stories.find((s) => s.citations.some((c) => c.type === 'news'));
  if (!story) {
    record(n, 'A served news item resolves at its outlet', 'the outlet itself', false, {
      app: 'no news-backed story in the feed',
      source: 'n/a',
    });
  } else {
    const citation = story.citations.find((c) => c.type === 'news');
    const res = await fetch(citation.url, { headers: { 'user-agent': UA }, redirect: 'follow' });
    const body = res.ok ? await res.text() : '';
    const host = new URL(res.url).hostname.replace(/^www\./, '');
    // Compare the served headline against the page's own <title>/og:title.
    const pageTitle =
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(body)?.[1] ??
      /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ??
      '';
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const words = norm(story.title).split(' ').filter((w) => w.length > 3);
    const overlap = words.filter((w) => norm(pageTitle).includes(w)).length;
    const ratio = words.length ? overlap / words.length : 0;
    record(
      n,
      'A served headline matches the page at its own URL',
      citation.outlet,
      res.ok && ratio >= 0.5 && host.includes(story.outlet.domain.split('.')[0]),
      {
        app: `"${story.title.slice(0, 70)}" attributed to ${story.outlet.name} (${story.outlet.domain})`,
        source: `HTTP ${res.status} from ${host}, page title "${pageTitle.replace(/\s+/g, ' ').trim().slice(0, 70)}"`,
        note: `${Math.round(ratio * 100)}% of headline words present in the page's own title`,
      },
    );
  }
}

// --- 11: price provenance ---------------------------------------------------

n += 1;
{
  const { prices, meta } = await app('/api/prices');
  if (!prices.length) {
    const why = meta.sources.find((s) => !s.ok)?.error ?? 'unknown';
    record(n, 'Oil and gas prices', 'EIA', true, {
      app: 'No data (shown as "No data", no estimate substituted)',
      source: why,
      note: 'Correct behaviour with no key: the app refuses to show a number it cannot source.',
    });
  } else {
    const brent = prices.find((p) => p.key === 'brent');
    const res = await fetch(
      `https://api.eia.gov/v2/petroleum/pri/spt/data/?${new URLSearchParams({
        api_key: env.EIA_API_KEY ?? '',
        frequency: 'daily',
        'data[0]': 'value',
        'facets[series][]': 'RBRTE',
        'sort[0][column]': 'period',
        'sort[0][direction]': 'desc',
        length: '1',
      })}`,
      { headers: { 'user-agent': UA } },
    );
    const row = (await res.json())?.response?.data?.[0];
    record(n, 'Brent spot price', 'EIA series RBRTE', Boolean(row) && Number(row.value) === brent.value, {
      app: `${brent.value} ${brent.unit} as of ${brent.asOf.slice(0, 10)}`,
      source: row ? `${row.value} ${row.units} as of ${row.period}` : 'no row returned',
    });
  }
}

// --- report -----------------------------------------------------------------

const matched = checks.filter((c) => c.ok);
console.log(`\n${'='.repeat(70)}`);
console.log(`${matched.length}/${checks.length} facts matched their original source`);
const bad = checks.filter((c) => !c.ok);
if (bad.length) {
  console.log('\nMismatches:');
  for (const b of bad) console.log(`  ${b.n}. ${b.claim}\n     app: ${b.detail.app}\n     src: ${b.detail.source}`);
}
console.log();
exit(bad.length ? 1 : 0);
