#!/usr/bin/env node
/**
 * Builds a static, self-contained preview of the app.
 *
 * The real app needs the worker for every panel. This captures one moment of
 * the worker's actual output to JSON and ships it alongside the normal build,
 * with a shim that answers the app's own /api/ calls from those files. The app
 * code is untouched: it does not know it is reading a snapshot.
 *
 * The result is a faithful but FROZEN copy. It is labelled as such in the page,
 * because a preview that looks live would misrepresent when the news is from.
 *
 *   node scripts/build-preview.mjs [apiBase] [outDir]
 */

import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { argv, exit, env } from 'node:process';

const API = argv[2] ?? 'http://127.0.0.1:8787';
const OUT = resolve(argv[3] ?? 'preview');

const get = async (path) => {
  const res = await fetch(`${API}${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
};

const save = (name, data) => {
  const file = resolve(OUT, 'snapshot', name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
  return (readFileSync(file).length / 1024).toFixed(0);
};

console.log(`Capturing ${API} -> ${OUT}`);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/*
 * Built here rather than copied from dist/, and built with a relative base.
 *
 * dist/ is built for the worker, which serves the app at the origin root, so
 * it references '/assets/...'. A preview is served from a sub-path, where
 * those absolute paths resolve against the host root instead and every
 * stylesheet, script and data file 404s - the page then renders as unstyled
 * HTML with no globe, which is exactly what shipping the copied dist did.
 */
console.log('Building with a relative base...');
execFileSync('npx', ['vite', 'build'], {
  stdio: 'inherit',
  env: { ...env, BUILD_BASE: './', BUILD_OUTDIR: OUT },
});

const meta = await get('/api/meta');
const countries = await get('/api/countries?sort=status');
const prices = await get('/api/prices');
const outlets = await get('/api/outlets');
const health = await get('/api/health');

// A generous unfiltered feed. The shim filters and sorts this client-side,
// so the preview's filters do real work rather than being decorative.
const feed = await get('/api/feed?limit=300&since=720&sort=newest');

console.log(`  meta ${save('meta.json', meta)} KB`);
console.log(`  countries ${save('countries.json', countries)} KB`);
console.log(`  prices ${save('prices.json', prices)} KB`);
console.log(`  outlets ${save('outlets.json', outlets)} KB`);
console.log(`  health ${save('health.json', health)} KB`);
console.log(`  feed ${save('feed.json', feed)} KB (${feed.stories.length} stories)`);

/*
 * Country detail for the countries worth clicking: those with the most news,
 * plus any carrying a conflict status. Capturing all 235 would multiply the
 * payload for pages nobody opens; the shim explains the omission in-panel.
 */
const ranked = [...countries.countries]
  .sort((a, b) => b.newsCount24h - a.newsCount24h || a.name.localeCompare(b.name));
const withStatus = ranked.filter((c) => c.status !== 'unknown').map((c) => c.iso2);
const topByNews = ranked.filter((c) => c.newsCount24h > 0).slice(0, 60).map((c) => c.iso2);
const wanted = [...new Set([...withStatus, ...topByNews])];

let captured = 0;
let bytes = 0;
for (const iso2 of wanted) {
  try {
    const detail = await get(`/api/country/${iso2}?since=720&sort=newest`);
    bytes += Number(save(`country/${iso2}.json`, detail)) * 1024;
    captured += 1;
  } catch (err) {
    console.warn(`  skip ${iso2}: ${err.message}`);
  }
}
console.log(`  country details: ${captured} captured, ${(bytes / 1024 / 1024).toFixed(1)} MB`);

writeFileSync(
  resolve(OUT, 'snapshot', 'index.json'),
  JSON.stringify({
    capturedAt: new Date().toISOString(),
    countries: wanted,
    counts: health.counts,
    note: 'Static capture of the worker API. Not live.',
  }),
);

/*
 * The shim. It replaces window.fetch for /api/ paths only, so the app's own
 * code runs unchanged against the captured files.
 */
const shim = `
/*
 * Preview shim: answers this app's /api/ calls from a static capture.
 *
 * The app is unmodified. It still calls /api/feed, /api/country/XX and the
 * rest; those calls are intercepted here and served from snapshot/*.json,
 * with filtering and sorting applied locally so the controls still work.
 *
 * Everything shown is real output from a real run, frozen at the time in
 * SNAPSHOT_AT. Nothing is invented. The live stream is stubbed out, because
 * there is no server to stream from.
 */
(function () {
  var base = new URL('.', document.currentScript ? document.currentScript.src : location.href).href;
  var cache = {};
  var index = null;

  function load(path) {
    if (!cache[path]) {
      cache[path] = fetch(base + 'snapshot/' + path).then(function (r) {
        if (!r.ok) throw new Error('snapshot missing: ' + path);
        return r.json();
      });
    }
    return cache[path];
  }

  function json(body, status) {
    return new Response(JSON.stringify(body), {
      status: status || 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  var REGIONS = {};

  function matches(story, p) {
    var since = Number(p.get('since') || 720);
    if (Date.parse(story.latestAt) < Date.now() - since * 3600000) return false;

    if (p.get('confirmed') === '1' && story.confidence !== 'confirmed') return false;

    var minScore = Number(p.get('minScore') || 0);
    if (minScore && story.accuracy.total < minScore) return false;

    var cats = (p.get('category') || '').split(',').filter(Boolean);
    if (cats.length && !cats.some(function (c) { return story.categories.indexOf(c) >= 0; })) return false;

    var countries = (p.get('country') || '').split(',').filter(Boolean);
    if (countries.length && !countries.some(function (c) { return story.countries.indexOf(c) >= 0; })) return false;

    var regions = (p.get('region') || '').split(',').filter(Boolean);
    if (regions.length) {
      var ok = story.countries.some(function (iso) { return regions.indexOf(REGIONS[iso]) >= 0; });
      if (!ok) return false;
    }

    var types = (p.get('sourceType') || '').split(',').filter(Boolean);
    if (types.length && !types.some(function (t) { return story.sourceTypes.indexOf(t) >= 0; })) return false;

    var outlets = (p.get('outlet') || '').split(',').filter(Boolean);
    if (outlets.length) {
      var hit = story.citations.some(function (c) {
        return outlets.some(function (o) { return (c.url || '').indexOf(o) >= 0; });
      });
      if (!hit) return false;
    }

    var q = (p.get('q') || '').toLowerCase();
    if (q && (story.title + ' ' + (story.summary || '')).toLowerCase().indexOf(q) < 0) return false;

    return true;
  }

  function sortStories(list, how) {
    var out = list.slice();
    if (how === 'reported') {
      out.sort(function (a, b) {
        return b.outletCount - a.outletCount || Date.parse(b.latestAt) - Date.parse(a.latestAt);
      });
    } else if (how === 'relevant') {
      out.sort(function (a, b) {
        return b.relevance - a.relevance || Date.parse(b.latestAt) - Date.parse(a.latestAt);
      });
    } else {
      out.sort(function (a, b) { return Date.parse(b.latestAt) - Date.parse(a.latestAt); });
    }
    return out;
  }

  var realFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var path;
    try {
      path = new URL(url, location.href).pathname;
    } catch (e) {
      return realFetch(input, init);
    }
    if (path.indexOf('/api/') !== 0) return realFetch(input, init);

    var p = new URL(url, location.href).searchParams;

    if (path === '/api/meta') return load('meta.json').then(json);
    if (path === '/api/prices') return load('prices.json').then(json);
    if (path === '/api/outlets') return load('outlets.json').then(json);
    if (path === '/api/health') return load('health.json').then(json);

    if (path === '/api/countries') {
      return load('countries.json').then(function (d) {
        var rows = d.countries.slice();
        rows.forEach(function (c) { REGIONS[c.iso2] = c.continent; });
        var want = (p.get('status') || '').split(',').filter(Boolean);
        if (want.length) rows = rows.filter(function (c) { return want.indexOf(c.status) >= 0; });
        var sort = p.get('sort') || 'name';
        var rank = { war: 0, conflict: 1, tension: 2, peace: 3, unknown: 4 };
        rows.sort(function (a, b) {
          if (sort === 'status') return rank[a.status] - rank[b.status] || a.name.localeCompare(b.name);
          if (sort === 'news') return b.newsCount24h - a.newsCount24h || a.name.localeCompare(b.name);
          return a.name.localeCompare(b.name);
        });
        return json({ countries: rows, total: rows.length, meta: d.meta });
      });
    }

    if (path === '/api/feed') {
      return Promise.all([load('feed.json'), load('countries.json')]).then(function (both) {
        both[1].countries.forEach(function (c) { REGIONS[c.iso2] = c.continent; });
        var all = both[0].stories.filter(function (s) { return matches(s, p); });
        all = sortStories(all, p.get('sort'));
        var offset = Number(p.get('offset') || 0);
        var limit = Number(p.get('limit') || 60);
        return json({
          stories: all.slice(offset, offset + limit),
          total: all.length,
          counts: both[0].counts,
          meta: both[0].meta,
        });
      });
    }

    if (path === '/api/search') {
      var q = (p.get('q') || '').toLowerCase();
      if (!q) return Promise.resolve(json({ results: [] }));
      return load('countries.json').then(function (d) {
        var hits = d.countries
          .filter(function (c) { return c.name.toLowerCase().indexOf(q) >= 0; })
          .sort(function (a, b) {
            var ai = a.name.toLowerCase().indexOf(q);
            var bi = b.name.toLowerCase().indexOf(q);
            return ai - bi || a.name.length - b.name.length;
          })
          .slice(0, 12);
        return json({ results: hits });
      });
    }

    var m = /^\\/api\\/country\\/([A-Za-z]{2})$/.exec(path);
    if (m) {
      var iso = m[1].toUpperCase();
      return load('country/' + iso + '.json').then(json).catch(function () {
        // Not every country was captured. Say so rather than show an empty
        // panel that looks like missing data.
        return (index ? Promise.resolve(index) : (index = load('index.json'))).then(function () {
          return json(
            {
              error: 'not captured',
              message:
                'This preview captured the countries with news or a conflict status. ' +
                'Open one of those, or run the app for the full set.',
            },
            404
          );
        });
      });
    }

    // The live stream has no server here; leave it unconnected so the UI
    // honestly shows its offline state rather than faking a live badge.
    if (path === '/api/stream') return Promise.resolve(new Response('', { status: 501 }));

    return Promise.resolve(json({ error: 'not in preview' }, 404));
  };

  // EventSource would retry the stream forever against a 501.
  window.EventSource = function () {
    this.close = function () {};
    this.addEventListener = function () {};
    var self = this;
    setTimeout(function () { if (self.onerror) self.onerror(new Event('error')); }, 0);
  };
})();
`;

const shimPath = resolve(OUT, 'preview-shim.js');
writeFileSync(shimPath, shim);

/*
 * A banner stating what this is. Injected rather than built into the app,
 * because the app itself must never claim to be a snapshot when it is live.
 */
const capturedAt = new Date().toISOString();
const banner = `
    <div id="preview-banner" style="
      position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:9999;
      max-width:min(520px,88vw);padding:22px 24px;border-radius:16px;
      background:rgba(10,14,24,.97);border:1px solid rgba(142,164,200,.26);
      box-shadow:0 24px 64px rgba(0,0,0,.6);color:#e8edf7;
      font:14px/1.55 Inter,system-ui,sans-serif">
      <div style="font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#5f6c84;margin-bottom:8px">
        Static preview
      </div>
      <div style="font-size:17px;font-weight:560;letter-spacing:-.01em;margin-bottom:10px">
        World Pulse, frozen at one moment
      </div>
      <p style="margin:0 0 10px;color:#95a3bd">
        Every headline, leader, membership and score here is real output from a real run,
        captured on <strong style="color:#e8edf7">${capturedAt.slice(0, 16).replace('T', ' ')} UTC</strong>.
        It is not live: the ticker will not advance and the clock will not move.
      </p>
      <p style="margin:0 0 14px;color:#95a3bd">
        The globe, search, filters, sorting, the country panels and the accuracy
        breakdowns all work. Prices read &ldquo;No data&rdquo; because the run had no EIA key.
      </p>
      <button id="preview-dismiss" style="
        font:inherit;font-weight:560;color:#04060c;background:#5ad1f5;border:0;
        border-radius:8px;padding:9px 16px;cursor:pointer">Open the globe</button>
    </div>
    <script>
      document.getElementById('preview-dismiss').addEventListener('click', function () {
        document.getElementById('preview-banner').remove();
      });
    </script>
`;

const indexPath = resolve(OUT, 'index.html');
let html = readFileSync(indexPath, 'utf8');

// The shim must run before the app module, or the app's first fetch escapes it.
html = html.replace('<script type="module"', '<script src="./preview-shim.js"></script>\n    <script type="module"');
html = html.replace('</body>', `${banner}  </body>`);
html = html.replace('<title>', '<title>Preview: ');
writeFileSync(indexPath, html);

console.log(`\nPreview built in ${OUT}`);
console.log(`Captured at ${capturedAt}`);
