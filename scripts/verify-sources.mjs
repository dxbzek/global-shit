#!/usr/bin/env node
/**
 * Source test harness.
 *
 * Hits every upstream World Pulse depends on, asserts the response really
 * carries the fields the app reads, and prints a pass/fail table with one
 * live sample per source so the data can be eyeballed against the original.
 *
 *   npm run verify-sources              # all sources
 *   npm run verify-sources -- news      # only ids containing "news"
 *   npm run verify-sources -- --json    # machine-readable
 *
 * Exit code is non-zero when a source marked required fails, so this is
 * usable as a pre-deploy gate.
 */

import { argv, env, exit } from 'node:process';
import { readFileSync } from 'node:fs';

/**
 * Node's global fetch ignores HTTPS_PROXY and the system CA store. Sandboxed
 * CI containers often route egress through a TLS-terminating proxy, so when
 * one is configured, install a matching dispatcher. On an ordinary machine
 * neither variable is set and this is a no-op.
 */
async function configureEgress() {
  const proxy = env.HTTPS_PROXY ?? env.https_proxy;
  const caPath = env.NODE_EXTRA_CA_CERTS ?? '/root/.ccr/ca-bundle.crt';
  let ca;
  try {
    ca = readFileSync(caPath);
  } catch {
    ca = undefined;
  }
  if (!proxy && !ca) return null;
  try {
    const { ProxyAgent, Agent, setGlobalDispatcher } = await import('undici');
    const tls = ca ? { ca } : undefined;
    setGlobalDispatcher(
      proxy
        ? new ProxyAgent({ uri: proxy, requestTls: tls, proxyTls: tls })
        : new Agent({ connect: tls }),
    );
    return proxy ?? 'system CA override';
  } catch {
    // undici absent: fall through and let global fetch try on its own.
    return null;
  }
}

const egress = await configureEgress();

const UA =
  'WorldPulse/1.0 (+https://github.com/dxbzek/global-shit) source-verification';

const args = argv.slice(2);
const asJson = args.includes('--json');
const filters = args.filter((a) => !a.startsWith('--'));

const C = process.stdout.isTTY && !asJson
  ? { dim: '\u001b[2m', red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m', bold: '\u001b[1m', off: '\u001b[0m' }
  : { dim: '', red: '', green: '', yellow: '', bold: '', off: '' };

/** Hosts that rate-limit. Requests to these are spaced by at least this gap. */
const HOST_THROTTLE_MS = {
  // GDELT documents one request every 5 seconds but returns 429 at that rate,
  // so requests are spaced further apart than the stated limit.
  'api.gdeltproject.org': 11_000,
  'query.wikidata.org': 1500,
  // Reddit rate-limits unauthenticated clients hard, and 6s still drew a 429
  // on the third subreddit feed.
  'www.reddit.com': 10_000,
};
const lastHit = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchThrottled(url, init = {}) {
  const host = new URL(url).host;
  const gap = HOST_THROTTLE_MS[host];
  if (gap) {
    const since = Date.now() - (lastHit.get(host) ?? 0);
    if (since < gap) await sleep(gap - since);
    lastHit.set(host, Date.now());
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), init.timeout ?? 30_000);
  try {
    return await fetch(url, {
      ...init,
      signal: ac.signal,
      headers: { 'user-agent': UA, ...(init.headers ?? {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Thrown by a check to report a clean, readable failure. */
class CheckFailed extends Error {}
const fail = (msg) => {
  throw new CheckFailed(msg);
};
const expect = (cond, msg) => {
  if (!cond) fail(msg);
};

// ---------------------------------------------------------------------------
// Shared helpers, kept deliberately simple so the harness has no dependencies.
// ---------------------------------------------------------------------------

const stripTags = (s) =>
  String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

const firstTag = (block, ...names) => {
  for (const n of names) {
    const m = new RegExp(
      `<(?:[\\w-]+:)?${n}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${n}>`,
      'i',
    ).exec(block);
    if (m?.[1]) {
      const t = stripTags(m[1]);
      if (t) return t;
    }
  }
  return null;
};

const feedEntries = (xml) => {
  const atom = /<entry[\s>]/i.test(xml) && !/<item[\s>]/i.test(xml);
  const re = atom
    ? /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi
    : /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  return [...xml.matchAll(re)].map((m) => m[1]).filter(Boolean);
};

const entryLink = (block) => {
  const inline = firstTag(block, 'link');
  if (inline && /^https?:/i.test(inline)) return inline;
  const href = /<(?:[\w-]+:)?link\b[^>]*href\s*=\s*["']([^"']+)["']/i.exec(block);
  return href?.[1] ?? null;
};

const ageHours = (iso) => (Date.now() - new Date(iso).getTime()) / 3_600_000;

/** A feed probe: fetch, parse, assert there is a titled, linked, dated item. */
const feedCheck = (url, { maxAgeHours = 72, headers, timeout } = {}) => async () => {
  const res = await fetchThrottled(url, { headers, timeout });
  expect(res.ok, `HTTP ${res.status} ${res.statusText}`);
  const body = await res.text();
  expect(/<(rss|feed|rdf:RDF)/i.test(body), `body is not RSS/Atom/RDF (starts: ${body.slice(0, 80)})`);

  const blocks = feedEntries(body);
  expect(blocks.length > 0, 'no <item> or <entry> elements found');

  const items = blocks.map((b) => ({
    title: firstTag(b, 'title'),
    link: entryLink(b),
    date: firstTag(b, 'pubDate', 'published', 'updated', 'date', 'issued'),
  }));

  const usable = items.filter((i) => i.title && i.link);
  expect(usable.length > 0, 'items present but none had both a title and a link');

  const dated = usable.filter((i) => i.date && !Number.isNaN(new Date(i.date).getTime()));
  expect(dated.length > 0, `no item had a parseable date (first raw: ${items[0]?.date ?? 'none'})`);

  const newest = dated
    .map((i) => new Date(i.date).toISOString())
    .sort()
    .at(-1);
  const hrs = ageHours(newest);
  expect(
    hrs <= maxAgeHours,
    `newest item is ${hrs.toFixed(1)}h old, over the ${maxAgeHours}h freshness limit`,
  );

  return {
    count: usable.length,
    newest,
    note: `newest ${hrs.toFixed(1)}h ago, date format "${dated[0].date}"`,
    sample: { title: usable[0].title, url: usable[0].link, published: dated[0].date },
  };
};

// ---------------------------------------------------------------------------
// Source registry
// ---------------------------------------------------------------------------

const GDELT_DOC = 'https://api.gdeltproject.org/api/v2/doc/doc';
const WD = 'https://query.wikidata.org/sparql';

const sparql = async (query) => {
  const res = await fetchThrottled(`${WD}?${new URLSearchParams({ query, format: 'json' })}`, {
    headers: { accept: 'application/sparql-results+json' },
    timeout: 60_000,
  });
  // Read the body once: a response body cannot be consumed twice, so it must
  // not be read inside an assertion message that may never be evaluated.
  const text = await res.text();
  expect(res.ok, `HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    fail(`response was not JSON: ${text.slice(0, 200)}`);
  }
  expect(Array.isArray(json?.results?.bindings), 'response had no results.bindings array');
  return json;
};

const SOURCES = [
  // ---- News: GDELT -------------------------------------------------------
  {
    id: 'gdelt-doc',
    name: 'GDELT DOC 2.0 (article search)',
    // Optional because GDELT returns 429 to datacenter IP ranges regardless of
    // request spacing, so this cannot pass from a CI container even though it
    // works from ordinary networks and from Cloudflare's edge. The worker
    // treats GDELT as best-effort for the same reason.
    required: false,
    note: 'rate-limits datacenter IPs; verify from the deployed worker via /api/health',
    doc: 'https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/',
    async run() {
      const url = `${GDELT_DOC}?${new URLSearchParams({
        query: 'conflict sourcelang:eng',
        mode: 'artlist',
        maxrecords: '20',
        format: 'json',
        sort: 'datedesc',
        timespan: '24h',
      })}`;
      const res = await fetchThrottled(url);
      const text = await res.text();
      expect(res.ok, `HTTP ${res.status}: ${text.slice(0, 200)}`);
      // GDELT reports some errors as plain text with a 200 status.
      expect(
        text.trim().startsWith('{'),
        `expected JSON, got: ${text.slice(0, 200)}`,
      );
      const json = JSON.parse(text);
      expect(Array.isArray(json.articles), `no "articles" array (keys: ${Object.keys(json)})`);
      expect(json.articles.length > 0, 'articles array was empty');

      const a = json.articles[0];
      for (const f of ['url', 'title', 'seendate', 'domain']) {
        expect(a[f] != null, `article missing "${f}" (fields: ${Object.keys(a)})`);
      }
      expect(
        /^\d{8}T\d{6}Z$/.test(a.seendate),
        `seendate "${a.seendate}" is not the expected YYYYMMDDTHHMMSSZ form`,
      );
      return {
        count: json.articles.length,
        note: `fields: ${Object.keys(a).join(', ')}`,
        sample: { title: a.title, url: a.url, domain: a.domain, seendate: a.seendate, country: a.sourcecountry },
      };
    },
  },
  {
    id: 'gdelt-doc-country',
    name: 'GDELT DOC 2.0 (per-country query)',
    required: false,
    async run() {
      // Verifies the name-based query the worker uses for a single country.
      const url = `${GDELT_DOC}?${new URLSearchParams({
        query: '"Ukraine" sourcelang:eng',
        mode: 'artlist',
        maxrecords: '10',
        format: 'json',
        sort: 'datedesc',
        timespan: '24h',
      })}`;
      const res = await fetchThrottled(url);
      const text = await res.text();
      expect(res.ok, `HTTP ${res.status}: ${text.slice(0, 200)}`);
      expect(text.trim().startsWith('{'), `expected JSON, got: ${text.slice(0, 200)}`);
      const json = JSON.parse(text);
      expect(json.articles?.length > 0, 'no articles for a phrase query');
      return {
        count: json.articles.length,
        note: 'phrase queries work; worker matches countries on text, not GDELT country codes',
        sample: { title: json.articles[0].title, domain: json.articles[0].domain },
      };
    },
  },

  // ---- News: RSS ---------------------------------------------------------
  { id: 'rss-bbc', name: 'BBC News World (RSS)', required: true, run: feedCheck('https://feeds.bbci.co.uk/news/world/rss.xml') },
  { id: 'rss-aljazeera', name: 'Al Jazeera (RSS)', required: true, run: feedCheck('https://www.aljazeera.com/xml/rss/all.xml') },
  { id: 'rss-guardian', name: 'The Guardian World (RSS)', required: false, run: feedCheck('https://www.theguardian.com/world/rss') },
  { id: 'rss-npr', name: 'NPR World (RSS)', required: false, run: feedCheck('https://feeds.npr.org/1004/rss.xml') },
  { id: 'rss-dw', name: 'Deutsche Welle World (RDF)', required: false, run: feedCheck('https://rss.dw.com/rdf/rss-en-world') },
  { id: 'rss-france24', name: 'France 24 (RSS)', required: false, run: feedCheck('https://www.france24.com/en/rss') },
  { id: 'rss-un', name: 'UN News (RSS)', required: false, run: feedCheck('https://news.un.org/feed/subscribe/en/news/all/rss.xml') },
  { id: 'rss-scmp', name: 'South China Morning Post (RSS)', required: false, run: feedCheck('https://www.scmp.com/rss/91/feed') },

  // ---- Reddit (discussion only) -----------------------------------------
  ...['worldnews', 'geopolitics', 'UpliftingNews'].map((sub) => ({
    id: `reddit-${sub.toLowerCase()}`,
    name: `Reddit r/${sub} (Atom)`,
    required: false,
    note: 'the .json endpoint 403s from datacenter IPs; .rss is used instead',
    run: feedCheck(`https://www.reddit.com/r/${sub}/new/.rss?limit=25`),
  })),

  // ---- TV / press conferences -------------------------------------------
  { id: 'yt-bbc', name: 'BBC News YouTube channel (Atom)', required: false, run: feedCheck('https://www.youtube.com/feeds/videos.xml?channel_id=UC16niRr50-MSBwiO3YDb3RA') },
  { id: 'yt-aljazeera', name: 'Al Jazeera English YouTube (Atom)', required: false, run: feedCheck('https://www.youtube.com/feeds/videos.xml?channel_id=UCNye-wNBqNL5ZzHSJj3l8Bg') },
  { id: 'yt-un', name: 'United Nations YouTube (Atom)', required: false, run: feedCheck('https://www.youtube.com/feeds/videos.xml?channel_id=UC07-dOwgza1IguKA86jqxNA') },
  {
    id: 'gdelt-tv',
    name: 'GDELT TV 2.0 (broadcast clips)',
    required: false,
    note: 'requires a station: filter; without one it returns an error string',
    async run() {
      const url = `https://api.gdeltproject.org/api/v2/tv/tv?${new URLSearchParams({
        query: 'conflict (station:CNN OR station:BBCNEWS OR station:MSNBC)',
        mode: 'clipgallery',
        format: 'json',
        datanorm: 'raw',
        timespan: '7d',
      })}`;
      const res = await fetchThrottled(url);
      const text = await res.text();
      expect(res.ok, `HTTP ${res.status}: ${text.slice(0, 200)}`);
      expect(text.trim().startsWith('{'), `expected JSON, got: ${text.slice(0, 200)}`);
      const json = JSON.parse(text);
      const clips = json.clips ?? [];
      expect(Array.isArray(clips), `no "clips" array (keys: ${Object.keys(json)})`);
      expect(clips.length > 0, 'clips array was empty for a 7-day window');
      return {
        count: clips.length,
        note: `fields: ${Object.keys(clips[0]).join(', ')}`,
        sample: clips[0],
      };
    },
  },

  // ---- Leaders and alliances --------------------------------------------
  {
    id: 'wikidata-leaders',
    name: 'Wikidata SPARQL (current office holders)',
    required: true,
    doc: 'https://query.wikidata.org/',
    async run() {
      // P35 head of state, P6 head of government.
      //
      // The role comes from the property used, not from the country's
      // designated-office property (P1906/P1313). Those two can disagree:
      // for Iran, P1906 reads "President of Iran" while the head-of-state
      // statement names the Supreme Leader. The property cannot mismatch.
      //
      // Statements carrying an end date (P582) are excluded, so only the
      // sitting holder is returned.
      //
      // The two properties are queried separately rather than as a UNION:
      // combined, the query takes ~40s and risks Wikidata's 60s timeout,
      // while each half returns in 3-9s. The worker splits them the same way.
      const b = [];
      for (const [prop, role] of [['P35', 'head of state'], ['P6', 'head of government']]) {
        const json = await sparql(`
          SELECT ?iso ?countryLabel ?person ?personLabel ?start WHERE {
            ?country wdt:P297 ?iso ; p:${prop} ?st .
            ?st ps:${prop} ?person .
            FILTER NOT EXISTS { ?st pq:P582 ?end }
            OPTIONAL { ?st pq:P580 ?start }
            SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
          }
        `);
        for (const row of json.results.bindings) b.push({ ...row, role: { value: role } });
      }
      expect(b.length > 0, 'query returned zero rows');
      const row = b[0];
      for (const f of ['iso', 'personLabel', 'role']) {
        expect(row[f]?.value, `row missing "${f}" (keys: ${Object.keys(row)})`);
      }
      const named = b.filter((r) => /^[A-Z]{2}$/.test(r.iso.value));
      expect(named.length > 100, `only ${named.length} rows carried a two-letter ISO code`);
      return {
        count: b.length,
        note: `${new Set(named.map((r) => r.iso.value)).size} distinct countries`,
        sample: ['UA', 'US', 'FR'].flatMap((iso) =>
          named
            .filter((r) => r.iso.value === iso)
            .map((r) => ({
              iso,
              role: r.role.value,
              holder: r.personLabel.value,
              since: r.start?.value?.slice(0, 10) ?? null,
            })),
        ),
      };
    },
  },
  {
    id: 'wikidata-orgs',
    name: 'Wikidata SPARQL (organisation membership)',
    required: true,
    async run() {
      // Membership is read from both directions, because Wikidata records
      // some of it on the country (P463 "member of") and some on the
      // organisation (P527 "has part"), and neither side alone is complete.
      //
      // The ISO code is resolved through P17 as well as directly, because a
      // few members hold membership on one item and their ISO code on
      // another: the Netherlands (Q55) carries NATO and EU membership while
      // the Kingdom of the Netherlands (Q29999) carries ISO "NL". Without the
      // P17 hop this returns NATO 31 / EU 26 and silently drops NL.
      //
      // Excluding statements with an end date is what correctly removes the
      // United Kingdom from the EU.
      const json = await sparql(`
        SELECT DISTINCT ?iso ?orgLabel WHERE {
          VALUES ?org { wd:Q7184 wd:Q458 wd:Q7172 wd:Q1065 wd:Q170481 }
          { ?m p:P463 ?st . ?st ps:P463 ?org . FILTER NOT EXISTS { ?st pq:P582 ?e1 } }
          UNION
          { ?org p:P527 ?st . ?st ps:P527 ?m . FILTER NOT EXISTS { ?st pq:P582 ?e2 } }
          { ?m wdt:P297 ?iso } UNION { ?m wdt:P17 ?par . ?par wdt:P297 ?iso }
          SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
        }
      `);
      const b = json.results.bindings;
      expect(b.length > 0, 'query returned zero rows');
      const byOrg = {};
      for (const r of b) {
        const k = r.orgLabel?.value ?? 'unlabelled';
        (byOrg[k] ??= new Set()).add(r.iso.value);
      }
      const nato = Object.entries(byOrg).find(([k]) => /NATO|North Atlantic/i.test(k));
      expect(nato, `no NATO rows returned (orgs seen: ${Object.keys(byOrg).join(', ')})`);
      // NATO has 32 members and the EU 27. A lower count means the ISO
      // resolution above regressed, which is what this assertion catches.
      expect(nato[1].size === 32, `NATO returned ${nato[1].size} members, expected 32`);
      const eu = Object.entries(byOrg).find(([k]) => /European Union/i.test(k));
      expect(!eu || eu[1].size === 27, `EU returned ${eu?.[1].size} members, expected 27`);
      return {
        count: b.length,
        note: Object.entries(byOrg).map(([k, v]) => `${k}=${v.size}`).join(', '),
        sample: { organisation: nato[0], members: [...nato[1]].sort().join(' ') },
      };
    },
  },
  {
    id: 'wikidata-relations',
    name: 'Wikidata SPARQL (diplomatic relations)',
    required: false,
    async run() {
      const json = await sparql(`
        SELECT ?iso ?otherIso WHERE {
          ?country wdt:P31 wd:Q3624078; wdt:P297 ?iso; wdt:P530 ?other .
          ?other wdt:P297 ?otherIso .
          FILTER(?iso = "UA")
        } LIMIT 50
      `);
      const b = json.results.bindings;
      expect(b.length > 0, 'no diplomatic-relation rows for the probe country');
      return {
        count: b.length,
        note: 'P530 gives declared relations, not alignment; used only as "has relations with"',
        sample: { country: 'UA', relatedTo: b.slice(0, 12).map((r) => r.otherIso.value).join(' ') },
      };
    },
  },

  // ---- Conflict datasets -------------------------------------------------
  {
    id: 'ucdp-ged',
    name: 'UCDP GED (georeferenced events)',
    required: false,
    note: 'needs UCDP_API_TOKEN; without it the app falls back to the two-outlet rule',
    async run() {
      const token = env.UCDP_API_TOKEN;
      const url = 'https://ucdpapi.pcr.uu.se/api/gedevents/25.1?pagesize=5';
      const res = await fetchThrottled(url, {
        headers: token ? { 'x-ucdp-access-token': token } : {},
      });
      const text = await res.text();
      if (res.status === 401) {
        fail(
          token
            ? `token rejected (401): ${text.slice(0, 150)}`
            : 'UCDP now requires an access token (401). Register at https://ucdp.uu.se/apidocs/ and set UCDP_API_TOKEN',
        );
      }
      expect(res.ok, `HTTP ${res.status}: ${text.slice(0, 200)}`);
      const json = JSON.parse(text);
      const rows = json.Result ?? json.result ?? [];
      expect(Array.isArray(rows) && rows.length > 0, `no Result rows (keys: ${Object.keys(json)})`);
      const r = rows[0];
      for (const f of ['country', 'date_start', 'side_a', 'side_b']) {
        expect(r[f] != null, `row missing "${f}" (fields: ${Object.keys(r)})`);
      }
      return {
        count: json.TotalCount ?? rows.length,
        note: `fields: ${Object.keys(r).slice(0, 14).join(', ')}...`,
        sample: {
          country: r.country,
          conflict: r.conflict_name,
          sideA: r.side_a,
          sideB: r.side_b,
          date: r.date_start,
          deaths: r.best,
        },
      };
    },
  },
  {
    id: 'acled',
    name: 'ACLED API',
    required: false,
    note: 'needs ACLED_API_KEY + ACLED_EMAIL; optional second conflict dataset',
    async run() {
      const key = env.ACLED_API_KEY;
      const email = env.ACLED_EMAIL;
      if (!key || !email) fail('ACLED_API_KEY / ACLED_EMAIL not set (optional source, skipped)');
      const url = `https://api.acleddata.com/acled/read?${new URLSearchParams({
        key,
        email,
        limit: '5',
      })}`;
      const res = await fetchThrottled(url);
      const text = await res.text();
      expect(res.ok, `HTTP ${res.status}: ${text.slice(0, 200)}`);
      const json = JSON.parse(text);
      expect(json.success !== false, `ACLED reported an error: ${text.slice(0, 200)}`);
      const rows = json.data ?? [];
      expect(rows.length > 0, 'no data rows returned');
      return { count: json.count ?? rows.length, note: `fields: ${Object.keys(rows[0]).slice(0, 10).join(', ')}`, sample: rows[0] };
    },
  },

  // ---- Markets -----------------------------------------------------------
  // EIA is the price source: official US government spot prices, documented
  // for programmatic use, with an explicit unit and period on every row.
  // Each series is checked on its own so a single retired series is visible.
  ...[
    ['brent', 'RBRTE', 'Brent crude spot (Europe FOB)'],
    ['wti', 'RWTC', 'WTI crude spot (Cushing OK FOB)'],
    ['natgas', 'RNGWHHD', 'Henry Hub natural gas spot'],
  ].map(([key, series, label]) => ({
    id: `price-${key}`,
    name: `${label} - EIA ${series}`,
    required: true,
    note: 'needs a free EIA_API_KEY from https://www.eia.gov/opendata/register.php',
    async run() {
      const apiKey = env.EIA_API_KEY;
      if (!apiKey) {
        fail('EIA_API_KEY not set. Register free at https://www.eia.gov/opendata/register.php');
      }
      const qs = new URLSearchParams({
        api_key: apiKey,
        frequency: 'daily',
        'data[0]': 'value',
        'facets[series][]': series,
        'sort[0][column]': 'period',
        'sort[0][direction]': 'desc',
        length: '5',
      });
      const res = await fetchThrottled(`https://api.eia.gov/v2/petroleum/pri/spt/data/?${qs}`);
      const text = await res.text();
      expect(res.ok, `HTTP ${res.status}: ${text.slice(0, 250)}`);
      const json = JSON.parse(text);
      const rows = json?.response?.data ?? [];
      expect(rows.length > 0, `no rows for series ${series}: ${text.slice(0, 200)}`);

      const row = rows[0];
      for (const f of ['period', 'value', 'units']) {
        expect(row[f] != null, `row missing "${f}" (fields: ${Object.keys(row)})`);
      }
      expect(Number.isFinite(Number(row.value)), `value "${row.value}" is not numeric`);

      // Spot series publish on business days and lag by a few days, so the
      // bar is "within two weeks", not "today".
      const days = (Date.now() - new Date(`${row.period}T00:00:00Z`).getTime()) / 86_400_000;
      expect(days < 21, `latest period ${row.period} is ${days.toFixed(0)} days old`);

      return {
        count: json.response.total ?? rows.length,
        note: `unit "${row.units}", latest period ${row.period} (${days.toFixed(0)} days back)`,
        sample: {
          series: row['series-description'] ?? series,
          period: row.period,
          value: Number(row.value),
          units: row.units,
        },
      };
    },
  })),
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const selected = filters.length
  ? SOURCES.filter((s) => filters.some((f) => s.id.includes(f) || s.name.toLowerCase().includes(f.toLowerCase())))
  : SOURCES;

if (!selected.length) {
  console.error(`No source matched ${filters.join(', ')}`);
  exit(2);
}

if (!asJson) {
  console.log(`\n${C.bold}World Pulse source verification${C.off}`);
  console.log(`${C.dim}${new Date().toISOString()} - ${selected.length} sources${C.off}`);
  if (egress) console.log(`${C.dim}egress via ${egress}${C.off}`);
  console.log();
}

const results = [];
for (const src of selected) {
  const started = Date.now();
  let out;
  try {
    const r = await src.run();
    out = { ...src, ok: true, ms: Date.now() - started, ...r };
  } catch (err) {
    out = {
      ...src,
      ok: false,
      ms: Date.now() - started,
      error: err instanceof CheckFailed ? err.message : `${err.name}: ${err.message}`,
    };
  }
  delete out.run;
  results.push(out);

  if (!asJson) {
    const mark = out.ok ? `${C.green}PASS${C.off}` : out.required ? `${C.red}FAIL${C.off}` : `${C.yellow}SKIP${C.off}`;
    const req = out.required ? '' : `${C.dim} (optional)${C.off}`;
    console.log(`${mark}  ${out.name}${req}`);
    console.log(`${C.dim}      ${out.id} - ${out.ms} ms${out.ok ? ` - ${out.count} records` : ''}${C.off}`);
    if (out.note) console.log(`${C.dim}      note: ${out.note}${C.off}`);
    if (out.ok && out.sample) {
      const s = JSON.stringify(out.sample);
      console.log(`${C.dim}      sample: ${s.length > 320 ? `${s.slice(0, 320)}...` : s}${C.off}`);
    }
    if (!out.ok) console.log(`      ${out.required ? C.red : C.yellow}${out.error}${C.off}`);
    console.log();
  }
}

const passed = results.filter((r) => r.ok);
const brokeRequired = results.filter((r) => !r.ok && r.required);

if (asJson) {
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
} else {
  console.log(`${C.bold}${passed.length}/${results.length} passed${C.off}`);
  if (brokeRequired.length) {
    console.log(`${C.red}${brokeRequired.length} required source(s) failing:${C.off}`);
    for (const r of brokeRequired) console.log(`  - ${r.name}: ${r.error}`);
  }
  const optional = results.filter((r) => !r.ok && !r.required);
  if (optional.length) {
    console.log(`${C.yellow}${optional.length} optional source(s) unavailable:${C.off}`);
    for (const r of optional) console.log(`  - ${r.name}: ${r.error}`);
  }
  console.log();
}

exit(brokeRequired.length ? 1 : 0);
