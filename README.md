# World Pulse

A live 3D globe of world news. Spin it, click any country, and see who runs it,
whether it is at war, who it shares alliances with, and what is being reported
there right now.

Every item on screen carries its source, a link and a timestamp. Nothing is
written from memory, and anything a source does not provide reads **No data**.

---

## Contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Deploying to Cloudflare](#deploying-to-cloudflare)
- [Keys](#keys)
- [How accuracy works](#how-accuracy-works)
- [How good news is labelled](#how-good-news-is-labelled)
- [Data sources](#data-sources)
- [Testing](#testing)
- [Architecture](#architecture)
- [Known limits](#known-limits)

---

## What it does

- **Globe.** CesiumJS with free satellite imagery and no API key. Countries are
  coloured by conflict status, conflict zones pulse, and clicking one flies the
  camera to frame it.
- **Country panel.** Current head of state and head of government, conflict
  status with the rule that produced it, multilateral memberships, lines drawn
  on the globe to co-members and to any opposing party, and the latest news
  grouped by category.
- **Accuracy score.** Every story gets a 0–100 score from five named
  components, shown with the score so it can be checked.
- **Live.** The worker ingests continuously and pushes an event when new data
  lands, so the page updates without a reload.
- **Filters.** Category, country, region, source type, outlet, time range,
  minimum score and confirmed-only — combinable, each removable as a chip, all
  stored in the URL so any view can be shared.

---

## Quick start

```bash
npm install
```

```bash
npm run verify-sources
```

That hits every upstream and prints a pass/fail table with a live sample from
each. Run it before anything else: if a source has changed or died, this is
where you find out.

Then, in two terminals:

```bash
npx wrangler dev
```

```bash
npm run dev
```

The Vite dev server proxies `/api` to `wrangler dev`, so open the Vite URL.

Cron does not fire under `wrangler dev`, so fill the caches once by hand:

```bash
curl -X POST http://127.0.0.1:8787/api/refresh
```

### If upstream fetches fail locally

`workerd` resolves DNS itself and ignores `HTTPS_PROXY`. Behind a proxy or in a
sandboxed container every upstream fetch fails with a DNS error even though the
same request works from Node. Run the relay and point the worker at it:

```bash
node scripts/dev-fetch-bridge.mjs
```

```bash
echo 'FETCH_BRIDGE=http://127.0.0.1:8788' >> .dev.vars
```

The bridge is development-only. `wrangler.toml` does not define `FETCH_BRIDGE`,
so it is never set in production.

---

## Deploying to Cloudflare

**1. Log in, and create a KV namespace if you need your own.**

```bash
npx wrangler login
```

`wrangler.toml` already points at a namespace on this repository's Cloudflare
account. Deploying to a different account needs your own:

```bash
npx wrangler kv namespace create world-pulse
```

Paste the printed `id` into `wrangler.toml`.

**2. Add your keys as secrets.** Only `EIA_API_KEY` is needed for the market
bar; the rest are optional. See [Keys](#keys).

```bash
npx wrangler secret put EIA_API_KEY
```

**3. Build and deploy.**

```bash
npm run deploy
```

That generates the country geometry, builds the front end into `dist/`, and
publishes the worker with `dist/` as its static assets.

**4. Fill the caches once.** The cron runs every minute, so the app fills
itself within a minute or two. To do it immediately:

```bash
curl -X POST https://world-pulse.<your-subdomain>.workers.dev/api/refresh
```

**5. Check it.**

```bash
curl https://world-pulse.<your-subdomain>.workers.dev/api/health
```

`/api/health` lists every data block with its last-updated time, whether it is
stale, and any source that is down with the reason. It also reports which keys
are configured, without revealing their values.

### Cron and cost

`wrangler.toml` schedules `* * * * *` — one tick a minute. Each tick fetches a
rotating shard of the feeds rather than all of them, so no upstream is polled
faster than it tolerates while new items still land every minute.

That is ~43,200 scheduled invocations a month. Cloudflare's free plan covers
100,000 requests a day, so this fits, but page views count against the same
budget. To cut it, change the cron to `*/5 * * * *` and raise `TTL.rollup` in
`worker/cache.ts` to match.

---

## Keys

All keys live on the server. None is ever sent to the browser. See
`.env.example` for the full list.

| Key | Needed for | Cost | Without it |
|---|---|---|---|
| `EIA_API_KEY` | Brent, WTI and natural gas prices | Free, instant — [register](https://www.eia.gov/opendata/register.php) | The market bar reads **No data** and says the key is missing |
| `UCDP_API_TOKEN` | Conflict dataset — [register](https://ucdp.uu.se/apidocs/) | Free | Conflict status falls back to the two-outlet rule, and **no country is ever shown as "At peace"** (see below) |
| `ACLED_API_KEY`, `ACLED_EMAIL` | Optional second conflict dataset | Free | Nothing; UCDP and the two-outlet rule are used |
| `CESIUM_ION_TOKEN` | Cesium World Imagery and terrain | Free tier | Esri World Imagery is used, which needs no key |
| `GOOGLE_MAPS_API_KEY` | Google Photorealistic 3D Tiles | **Paid, billed per request** | Esri World Imagery is used |

Locally, put them in `.dev.vars`. In production use `npx wrangler secret put`.

### Swapping the globe imagery

The default is Esri World Imagery — free satellite, no key. Setting
`CESIUM_ION_TOKEN` or `GOOGLE_MAPS_API_KEY` switches the globe over without a
code change; `/api/meta` tells the front end which sources are available.
Adding another provider means one more case in `setImagery()` in
`web/src/globe.ts`.

---

## How accuracy works

Accuracy is treated as the product requirement, not a feature. Three rules
govern everything on screen.

### 1. Country status needs a named source

A country is marked at war or in conflict only when:

- **a named conflict dataset says so** (UCDP, or ACLED if configured), or
- **two or more independently owned news outlets** reported conflict there in
  the last 7 days.

The panel always states which of the two produced the status, and lists the
dataset rows or the outlets behind it. A country with neither reads **No data**.

**"At peace" requires positive evidence.** It is shown only when a global
conflict dataset was loaded and does not list that country, so its absence is
itself a statement. Without a dataset, a quiet country reads **No data**, never
"At peace" — an absence of reporting is not evidence of peace.

### 2. Confirmation means independent ownership

Stories from many outlets are grouped into one item by headline similarity.
A story is **confirmed** when two or more *independently owned* text-news
outlets carried it. Outlets under the same owner cannot confirm each other, so
wire copy reprinted across one group does not masquerade as corroboration.

**Reddit is never confirmation.** It is carried as discussion, labelled as
such, and a Reddit-only story is capped at a score of 20.

### 3. The score is auditable

Every story carries a 0–100 score built from five components, each returned
with the total and shown in the UI:

| Component | Max | What it measures |
|---|---|---|
| Independent outlets | 40 | Distinct ownership groups carrying the story |
| Ownership known | 20 | Whether those owners are in the registry or inferred from the domain |
| Conflict dataset | 15 | A named dataset corroborates the country and subject |
| Freshness | 15 | Age of the newest report, decaying over 48h |
| Placed and classified | 10 | Whether it resolved to a country and a category |

The **band** is then gated on corroboration, not on points:

- **Verified** — 4+ independent owners, 70+
- **Corroborated** — 2+ independent owners, 50+
- **Reported** — one outlet, or owners that could not be established
- **Unconfirmed** — discussion only

The gate matters. Without it a single-source story reaches 55 on freshness and
attribution alone and gets labelled "Corroborated", which is a claim the word
must not make. Freshness is not corroboration.

### Leaders

Heads of state and government come from Wikidata, excluding any statement with
an end date, so a former holder never shows as current. The **role is taken
from the property used** (P35 head of state, P6 head of government) rather than
from the country's designated-office property (P1906/P1313). Those two can
disagree — for Iran, P1906 reads "President of Iran" while the head-of-state
statement names the Supreme Leader — and the property cannot mismatch.

### Alliances

The app does **not** claim two countries are allies; nothing in the sources
supports that. What it shows, and cites, is **shared membership** of a
multilateral body, using the most specific body both belong to — sharing a
12-member organisation is informative where sharing the UN is not. The body is
named next to every line drawn on the globe.

Organisations are discovered from Wikidata at runtime, not hardcoded. An
earlier version carried a hand-written QID map and was wrong: it labelled the
World Trade Organization as the African Union and the OPCW as a defence pact,
handing Ukraine a membership of the African Union. Reading the organisation,
its label and its short name straight from the source removed that whole class
of error.

Opposing parties come only from a conflict dataset naming both sides. They are
never inferred from reporting.

### Prices

Spot prices from the EIA, an official statistical source, with the unit,
period and series name shown exactly as returned. These are **published spot
prices, not live futures**: they settle on business days and lag a few days, so
each is labelled with its own period and marked stale against that.

The app shows **no country-level retail fuel prices**. No free source for them
was verified, so rather than present an international benchmark as a local pump
price, the panel says so.

---

## How good news is labelled

Good news is the narrowest rule in the app, because a loose one produces grim
results. An item is labelled good news only when **both** hold:

1. It contains a term from a list of **concrete positive outcomes** — `cure`,
   `rescued`, `peace deal`, `eradicated`, `exonerated`, `emissions fell`, and
   similar. Hopeful adjectives alone never qualify.
2. It contains **no term from a blocklist** naming harm — `killed`, `massacre`,
   `attack`, `crisis`, `convicted`, and similar.

The second test is what matters. Without it, "aid reaches survivors of the
massacre" and "breakthrough in murder investigation" both file as good news.

Items from r/UpliftingNews face the same two tests; the subreddit's own framing
is not treated as evidence. Both lists are in `worker/lib/categorize.ts`.

---

## Data sources

Every source below was tested live. `npm run verify-sources` re-runs those
tests and prints a sample from each.

**News (RSS)** — BBC World, Al Jazeera, The Guardian, NPR, Deutsche Welle,
France 24, UN News, South China Morning Post. Eight outlets under eight
distinct owners, which is what makes the two-owner rule reachable.

**News (API)** — GDELT DOC 2.0, which widens coverage to hundreds of outlets.
Best-effort: GDELT rate-limits hard and reports some errors as plain text with
HTTP 200, so a failure degrades coverage and is reported in `/api/health`
rather than breaking a refresh.

**Discussion** — Reddit r/worldnews, r/geopolitics, r/UpliftingNews, read
through the Atom feeds. The `.json` endpoints return 403 to datacenter IPs.

**TV and press conferences** — YouTube channel feeds for BBC News, Al Jazeera
English, DW News, the United Nations and the White House. Titles and links
only; no transcripts and no claims are taken from video.

**Leaders and memberships** — Wikidata SPARQL. The two leader queries are run
separately: combined they take ~40s and risk Wikidata's 60s timeout, while each
half returns in 3–9s.

**Conflicts** — UCDP (now requires a token), optionally ACLED.

**Prices** — EIA open data.

### Sources tested and rejected

Left out deliberately, rather than left in to fail quietly:

| Source | Why |
|---|---|
| Reuters | No public RSS feed; `reutersagency.com` redirects to a dead endpoint |
| Associated Press | No public RSS feed; third-party relays were unreliable |
| ABC Australia | World feed returns 404 |
| ReliefWeb | RSS returns 406, "Blocked due to bot activity" |
| CBC | World feed timed out on every attempt |
| Stooq | Connection reset on every request |
| Yahoo Finance | Returns 429 to any non-browser client. Working around a bot check to take data a service is refusing is not something this project does, so EIA is used instead |
| GDELT TV API | Returned no clips even with a station filter; YouTube channel feeds cover TV instead |

---

## Testing

```bash
npm run verify-sources
```

Hits every upstream, asserts the fields the app actually reads, and prints a
live sample. Non-zero exit if a required source fails.

```bash
npm run typecheck
```

The worker and the browser bundle are typechecked separately and must be:
`@cloudflare/workers-types` redefines DOM globals such as `Element.append`,
which silently breaks every DOM call in the front end if they share a config.

```bash
npm run test:ui
```

Needs a Chromium build: `npx playwright install chromium`. Where Playwright's
own build is unavailable, the script falls back to a system Chromium, and
`PLAYWRIGHT_CHROMIUM_PATH` points it at a specific binary.

Drives the real app in a real browser: clicks five countries, exercises every
filter and sort, checks the URL carries the state, resizes to a phone, swipes
the bottom sheet, verifies reduced motion, and fails on console errors or
failed requests. Screenshots are written to a temp directory.

```bash
node scripts/accuracy-check.mjs
```

Cross-checks what the app serves against the original sources. It does not read
the worker's caches or reuse its queries — it asks Wikidata and the outlets
directly, so a bug in the worker's query cannot hide behind itself.

---

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull request:

- **Typecheck and build** — both TypeScript projects, then the Vite build. The
  built `dist/` is handed to the next job rather than rebuilt.
- **Browser test** — starts `wrangler dev` against that build, fills the caches
  once (cron does not fire under `wrangler dev`), and runs the browser suite.
  Screenshots are uploaded whether it passes or fails.
- **Source health** — runs `verify-sources` on `main` and on demand, never on a
  pull request, and never blocks. Upstreams are third-party services that
  rate-limit and change without notice, so this reports rather than gates. Add
  `EIA_API_KEY` and `UCDP_API_TOKEN` as repository secrets to cover those too.

## Architecture

```
worker/
  index.ts          HTTP routes, SSE live stream, cron entry point
  pipeline.ts       Sharded ingestion, clustering, status derivation
  cache.ts          KV wrapper; every blob carries updatedAt, TTL and source health
  sources/          One module per upstream, each returning data + health
  lib/
    http.ts         Single outbound path: timeouts, UA, edge cache, dev bridge
    xml.ts          RSS, Atom and RDF reader (no DOMParser in Workers)
    match.ts        Attaches countries to text
    categorize.ts   Keyword classifier, including the good-news rule
    dedupe.ts       Story clustering and the independence rule
    status.ts       Conflict status derivation
    score.ts        Accuracy scoring and band gating
web/src/
  globe.ts          Cesium: imagery, status colouring, flight, arcs, pins
  state.ts          App state mirrored to the URL
  api.ts            Typed API client and the live subscription
  ui/               DOM builders for panel, stories and primitives
scripts/
  build-countries.mjs   Generates geometry and the country registry
  verify-sources.mjs    Live source tests
  accuracy-check.mjs    Cross-checks served facts against their sources
  ui-test.mjs           Browser test
  dev-fetch-bridge.mjs  Local relay for workerd's DNS limitation
```

**Ingestion** runs every minute. Feeds are split into shards and each tick
handles the fast wires plus one shard, so fresh items land every minute without
polling any upstream faster than it tolerates. Shard assignment comes from the
clock, so a missed tick never desynchronises the rotation.

**Country geometry** is generated from packaged reference datasets — Natural
Earth polygons, ISO 3166 codes, capitals and continents — so no geography is
hand-authored. Coordinates are quantised to three decimals (~110 m), which
roughly halves the file with no visible difference at globe scale.

---

## Known limits

- **GDELT rate-limits datacenter IPs.** It returns 429 regardless of request
  spacing from some hosts, including CI containers. It works from Cloudflare's
  edge. Check `/api/health` after deploying to confirm.
- **Without `UCDP_API_TOKEN`, no country shows "At peace".** That is deliberate
  — peace needs a dataset's negative evidence.
- **Confirmation needs breadth.** With only the eight RSS outlets, few stories
  reach two independent owners. GDELT is what makes the rule bite; if it is
  rate-limited, expect most stories to read "Reported".
- **Country tagging is keyword-based.** It matches names, capitals and
  demonyms, requiring a second signal for ambiguous ones (Turkey, Georgia,
  Chad). Every item shows which rule tagged it, under the score breakdown.
- **Wikidata completeness varies.** The African Union returns 54 of 55 members.
  The app shows what the source holds and links to it rather than patching
  gaps from memory.
- **Headlines are publish-time snapshots.** Outlets rewrite headlines after
  publication, live blogs and Q&A pieces especially. The app stores the
  headline as it stood at ingest, with the publish time and a link out; it does
  not claim the headline is still the current one. `accuracy-check.mjs` tests
  attribution, which must hold, and reports headline drift separately.
- **Cesium is a large bundle** (~1.1 MB gzipped). It is split into its own
  chunk so app changes do not force a re-download.
