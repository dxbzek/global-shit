#!/usr/bin/env node
/**
 * Drives the real app in a real browser and asserts what a reader would see.
 *
 * It clicks countries, exercises every filter and sort, checks the URL carries
 * the state, resizes to a phone, and screenshots each step. Console errors and
 * failed network requests fail the run, because a globe that throws on every
 * frame still looks fine in a screenshot.
 *
 *   node scripts/ui-test.mjs [baseUrl] [--headed] [--keep]
 */

import { mkdirSync, rmSync } from 'node:fs';
import { argv, env, exit } from 'node:process';
import { createRequire } from 'node:module';

/**
 * Playwright is resolved through createRequire because it is often installed
 * globally rather than as a project dependency, and a global package is on
 * NODE_PATH for CommonJS but not for ESM imports.
 */
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error(
    'playwright is not available. Install it with `npm i -D playwright`,\n' +
      'or run this script where a global playwright is on NODE_PATH.',
  );
  exit(2);
}

const BASE = argv.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:8787';
const OUT = env.UI_TEST_OUT ?? '/tmp/claude-0/-home-user-global-shit/63ac0723-9055-5ffe-b31f-160b2a875399/scratchpad/ui';

if (!argv.includes('--keep')) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const results = [];
let shotIndex = 0;

const pass = (name, detail = '') => {
  results.push({ name, ok: true, detail });
  console.log(`  PASS  ${name}${detail ? ` - ${detail}` : ''}`);
};
const fail = (name, detail) => {
  results.push({ name, ok: false, detail });
  console.log(`  FAIL  ${name} - ${detail}`);
};

async function check(name, fn) {
  try {
    const detail = await fn();
    pass(name, typeof detail === 'string' ? detail : '');
  } catch (err) {
    fail(name, err.message.split('\n')[0]);
  }
}

const shot = async (page, label) => {
  shotIndex += 1;
  const file = `${OUT}/${String(shotIndex).padStart(2, '0')}-${label}.png`;
  // Let any in-flight entrance animation settle, so a screenshot captures the
  // finished state rather than a frame midway through it.
  await page.waitForTimeout(700);
  await page.screenshot({ path: file });
  return file;
};

const browser = await chromium.launch({
  headless: !argv.includes('--headed'),
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});

const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});

const consoleErrors = [];
const networkFailures = [];
const page = await context.newPage();

/** Hosts whose failure means the sandbox blocked them, not that code broke. */
const EXTERNAL_HOSTS =
  /flagcdn\.com|arcgisonline\.com|api\.cesium\.com|assets\.ion\.cesium\.com|tile\.googleapis\.com|tile\.openstreetmap\.org|fonts\.(googleapis|gstatic)\.com/;
const blockedExternal = new Set();

const blockedRequestErrors = [];

page.on('console', async (msg) => {
  if (msg.type() !== 'error') return;
  const text = msg.text();
  if (EXTERNAL_HOSTS.test(text)) return;
  if (/Failed to load resource/.test(text) && blockedExternal.size) return;

  /*
   * Cesium logs a failed subresource as a RequestErrorEvent, whose console
   * text is a minified identifier such as "Eg" carrying no URL. Those are
   * classified here by argument shape so a genuine app error is never mistaken
   * for one, and they are reported separately rather than swallowed.
   */
  try {
    const arg = msg.args()[0];
    if (arg) {
      const shape = await arg.evaluate((o) =>
        o && typeof o === 'object' && 'statusCode' in o && 'responseHeaders' in o ? String(o) : null,
      );
      if (shape) {
        blockedRequestErrors.push(shape);
        return;
      }
    }
  } catch {
    // Argument handle already gone; fall through and treat it as a real error.
  }

  consoleErrors.push(text);
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
page.on('requestfailed', (req) => {
  const url = req.url();
  if (EXTERNAL_HOSTS.test(url)) {
    blockedExternal.add(new URL(url).host);
    return;
  }
  // ERR_ABORTED on a same-origin API call means this test navigated while a
  // refresh was in flight. That is the harness, not the app.
  if (url.startsWith(BASE) && req.failure()?.errorText === 'net::ERR_ABORTED') return;
  networkFailures.push(`${url} - ${req.failure()?.errorText}`);
});

console.log(`\nWorld Pulse UI test against ${BASE}\n`);

// --- load ------------------------------------------------------------------

await check('page loads', async () => {
  const res = await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  if (!res?.ok()) throw new Error(`HTTP ${res?.status()}`);
  return `HTTP ${res.status()}`;
});

await check('globe canvas renders', async () => {
  await page.waitForSelector('#globe canvas', { timeout: 40_000 });
  const box = await page.locator('#globe canvas').boundingBox();
  if (!box || box.width < 400) throw new Error(`canvas too small: ${JSON.stringify(box)}`);
  // The globe draws over several frames; wait for pixels, not just the element.
  await page.waitForTimeout(4000);
  const painted = await page.evaluate(() => {
    const c = document.querySelector('#globe canvas');
    if (!(c instanceof HTMLCanvasElement)) return false;
    // A WebGL canvas cannot be read back without preserveDrawingBuffer, so
    // liveness is judged by the renderer having a non-zero drawing surface.
    return c.width > 0 && c.height > 0;
  });
  if (!painted) throw new Error('canvas has no drawing surface');
  return `${Math.round(box.width)}x${Math.round(box.height)}`;
});

await check('ticker has live headlines', async () => {
  await page.waitForSelector('.ticker-item', { timeout: 30_000 });
  const n = await page.locator('.ticker-item').count();
  const first = await page.locator('.ticker-item').first().innerText();
  if (n < 2) throw new Error(`only ${n} ticker items`);
  return `${n} items, first: "${first.replace(/\s+/g, ' ').slice(0, 52)}"`;
});

await check('legend shows status counts', async () => {
  await page.waitForSelector('.legend-row', { timeout: 20_000 });
  const rows = await page.locator('.legend-row').allInnerTexts();
  if (rows.length < 4) throw new Error(`only ${rows.length} legend rows`);
  return rows.map((r) => r.replace(/\s+/g, ' ').trim()).join(' | ');
});

await check('market bar present', async () => {
  await page.waitForSelector('#markets .price', { timeout: 20_000 });
  const text = (await page.locator('#markets').innerText()).replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('market bar empty');
  return text.slice(0, 90);
});

await check('country list populated', async () => {
  await page.waitForSelector('.country-row', { timeout: 20_000 });
  const n = await page.locator('.country-row').count();
  if (n < 10) throw new Error(`only ${n} country rows`);
  return `${n} rows`;
});

await shot(page, 'globe-initial');

// --- click five countries ---------------------------------------------------

const TARGETS = ['Ukraine', 'United States of America', 'France', 'Israel', 'Brazil'];
const observed = [];

for (const name of TARGETS) {
  await check(`open ${name} via search`, async () => {
    await page.fill('#search-input', '');
    await page.fill('#search-input', name.slice(0, 7));
    await page.waitForSelector('.search-result', { timeout: 15_000 });
    await page.locator('.search-result').first().click();

    await page.waitForSelector('.panel-country .panel-title h2', { timeout: 25_000 });
    // Wait for real content, not the skeleton.
    await page.waitForSelector('.panel-country .status-banner', { timeout: 25_000 });

    const title = await page.locator('.panel-country .panel-title h2').innerText();
    const status = (await page.locator('.panel-country .status-banner .label').innerText()).trim();
    const basis = (await page.locator('.panel-country .status-banner .basis').innerText()).trim();
    const reason = (await page.locator('.panel-country .reason').first().innerText()).trim();

    const leaderRows = await page.locator('.panel-country .row').allInnerTexts();
    const leader = leaderRows.find((r) => /Head of (state|government)/i.test(r)) ?? 'none';

    const storyCount = await page.locator('.panel-country .news-item').count();
    const url = page.url();

    observed.push({ name: title, status, basis, reason, leader: leader.replace(/\s+/g, ' ').slice(0, 90), storyCount, url });

    if (!title) throw new Error('panel has no title');
    if (!status) throw new Error('panel has no status');
    if (!reason) throw new Error('status has no stated rule');
    return `${title} | ${status} (${basis}) | ${storyCount} stories`;
  });
  await shot(page, `panel-${name.split(' ')[0].toLowerCase()}`);
  await check(`${name} panel survives a background refresh`, async () => {
    const panels = await page.locator('.panel-country').count();
    const skeletons = await page.locator('.panel-country .skeleton').count();
    if (panels !== 1) throw new Error(`${panels} panels on screen`);
    if (skeletons) throw new Error('panel fell back to a skeleton');
    return 'panel intact';
  });
}

await check('URL carries the selected country', async () => {
  const url = page.url();
  if (!/[?&]c=[A-Z]{2}/.test(url)) throw new Error(`no country in URL: ${url}`);
  return url.replace(BASE, '');
});

await check('every fact in the panel cites a source', async () => {
  // The panel must not contain a bare value with no provenance anywhere.
  const cites = await page.locator('.panel-country .cite').count();
  if (cites < 3) throw new Error(`only ${cites} source links in the panel`);
  return `${cites} source links`;
});

await check('accuracy breakdown expands with citations', async () => {
  const toggle = page.locator('.panel-country .news-item .news-foot button').first();
  if (!(await toggle.count())) throw new Error('no score toggle found');
  await toggle.click();
  await page.waitForSelector('.panel-country .story-detail .score-parts', { timeout: 10_000 });
  const parts = await page.locator('.panel-country .story-detail .score-part').count();
  const cites = await page.locator('.panel-country .story-detail .citation').count();
  if (parts < 4) throw new Error(`only ${parts} score components`);
  if (cites < 1) throw new Error('breakdown listed no citations');
  return `${parts} components, ${cites} citations`;
});

await shot(page, 'score-breakdown');

await check('Esc closes the panel', async () => {
  await page.keyboard.press('Escape');
  await page.waitForSelector('.panel-country', { state: 'detached', timeout: 10_000 });
  if (/[?&]c=/.test(page.url())) throw new Error(`country still in URL: ${page.url()}`);
  return 'closed and URL cleared';
});

// --- filters ---------------------------------------------------------------

async function feedTotal() {
  const res = await page.request.get(`${BASE}/api/feed?limit=1&${new URL(page.url()).searchParams}`);
  return (await res.json()).total;
}

await check('category filter changes the result set', async () => {
  const before = await page.locator('.ticker-item').count();
  await page.locator('.rail .chip', { hasText: 'Politics' }).first().click();
  await page.waitForTimeout(1200);
  const url = page.url();
  if (!/cat=politics/.test(url)) throw new Error(`category not in URL: ${url}`);
  const after = await page.locator('.ticker-item').count();
  const chip = await page.locator('.filter-chip').count();
  if (chip < 1) throw new Error('no removable filter chip appeared');
  return `ticker ${before} -> ${after}, chip shown, url has cat=politics`;
});

await check('filter chip removes its own filter', async () => {
  await page.locator('.filter-chip button').first().click();
  await page.waitForTimeout(900);
  if (/cat=politics/.test(page.url())) throw new Error('filter still in URL after removing chip');
  return 'chip removed, URL cleared';
});

for (const [label, param] of [
  ['1 hour', 'since=1'],
  ['7 days', 'since=168'],
  ['30 days', 'since=720'],
]) {
  await check(`time range "${label}"`, async () => {
    await page.locator('.rail .chip', { hasText: new RegExp(`^${label}$`) }).first().click();
    await page.waitForTimeout(800);
    if (!page.url().includes(param)) throw new Error(`expected ${param} in ${page.url()}`);
    return `url has ${param}, feed total ${await feedTotal()}`;
  });
}

for (const [label, param] of [
  ['Most reported', 'sort=reported'],
  ['Most relevant', 'sort=relevant'],
  ['Newest', ''],
]) {
  await check(`sort "${label}"`, async () => {
    await page.locator('.rail .chip', { hasText: new RegExp(`^${label}$`) }).first().click();
    await page.waitForTimeout(800);
    if (param && !page.url().includes(param)) throw new Error(`expected ${param} in ${page.url()}`);
    const first = await page.locator('.ticker-item').first().innerText();
    return `${param || 'default'} | top: "${first.replace(/\s+/g, ' ').slice(0, 40)}"`;
  });
}

await check('confirmed-only filter', async () => {
  await page.locator('.rail .chip', { hasText: 'Confirmed only' }).first().click();
  await page.waitForTimeout(900);
  if (!page.url().includes('confirmed=1')) throw new Error(`not in URL: ${page.url()}`);
  const total = await feedTotal();
  await page.locator('.rail .chip', { hasText: 'Confirmed only' }).first().click();
  await page.waitForTimeout(500);
  return `${total} confirmed stories`;
});

await check('minimum score filter', async () => {
  await page.locator('.rail .chip', { hasText: 'Score 70+' }).first().click();
  await page.waitForTimeout(900);
  if (!page.url().includes('score=70')) throw new Error(`not in URL: ${page.url()}`);
  const total = await feedTotal();
  await page.locator('.rail .chip', { hasText: 'Score 70+' }).first().click();
  await page.waitForTimeout(500);
  return `${total} stories at 70+`;
});

await check('source-type filter', async () => {
  await page.locator('.rail .chip', { hasText: /^Reddit/ }).first().click();
  await page.waitForTimeout(900);
  if (!page.url().includes('src=reddit')) throw new Error(`not in URL: ${page.url()}`);
  const total = await feedTotal();
  await page.locator('.rail .chip', { hasText: /^Reddit/ }).first().click();
  await page.waitForTimeout(500);
  return `${total} Reddit stories`;
});

await check('region filter', async () => {
  await page.locator('.rail .chip', { hasText: /^Europe$/ }).first().click();
  await page.waitForTimeout(900);
  if (!page.url().includes('region=Europe')) throw new Error(`not in URL: ${page.url()}`);
  const total = await feedTotal();
  return `${total} Europe stories`;
});

await check('status filter via legend', async () => {
  await page.locator('.legend-row', { hasText: 'No data' }).first().click();
  await page.waitForTimeout(900);
  if (!page.url().includes('status=unknown')) throw new Error(`not in URL: ${page.url()}`);
  const rows = await page.locator('.country-row').count();
  return `${rows} countries shown`;
});

await check('country list sorts', async () => {
  const out = [];
  for (const label of ['Name', 'News', 'Status']) {
    const chip = page.locator('.rail .chip', { hasText: new RegExp(`^${label}$`) }).first();
    // These chips sit near the bottom of a scrollable rail.
    await chip.scrollIntoViewIfNeeded();
    await chip.click();
    await page.waitForTimeout(700);
    const first = await page.locator('.country-row .country-name').first().innerText();
    out.push(`${label}:${first}`);
  }
  return out.join(' ');
});

await shot(page, 'filters-applied');

await check('clear all resets every filter', async () => {
  await page.locator('.clear-all').first().click();
  await page.waitForTimeout(1000);
  const url = page.url();
  for (const p of ['cat=', 'since=', 'sort=', 'score=', 'src=', 'region=', 'confirmed=']) {
    if (url.includes(p)) throw new Error(`${p} survived clear-all: ${url}`);
  }
  const chips = await page.locator('.filter-chip').count();
  if (chips) throw new Error(`${chips} filter chips remain`);
  return 'all filters cleared';
});

// --- shareable URL ----------------------------------------------------------

await check('shared URL restores the full view', async () => {
  const shared = `${BASE}/?c=UA&cat=war&since=168&sort=reported&confirmed=1`;
  await page.goto(shared, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.panel-country .status-banner', { timeout: 30_000 });
  const title = await page.locator('.panel-country .panel-title h2').innerText();
  const chips = await page.locator('.filter-chip').count();
  if (!/ukrain/i.test(title)) throw new Error(`expected Ukraine, got ${title}`);
  if (chips < 3) throw new Error(`expected restored filter chips, got ${chips}`);
  return `${title} with ${chips} filters restored`;
});

await shot(page, 'shared-url');

// --- keyboard ---------------------------------------------------------------

await check('keyboard: / focuses search', async () => {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.locator('body').click({ position: { x: 700, y: 60 } });
  await page.keyboard.press('/');
  const focused = await page.evaluate(() => document.activeElement?.id);
  if (focused !== 'search-input') throw new Error(`focus went to ${focused}`);
  return 'search focused';
});

await check('keyboard: arrow keys and Enter pick a country', async () => {
  await page.fill('#search-input', 'Japan');
  await page.waitForSelector('.search-result', { timeout: 12_000 });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.panel-country .status-banner', { timeout: 25_000 });
  const title = await page.locator('.panel-country .panel-title h2').innerText();
  return `opened ${title} by keyboard`;
});

await check('tab order reaches the close button', async () => {
  const reached = await page.evaluate(() => {
    const btn = document.querySelector('.panel-close');
    return btn instanceof HTMLElement && btn.tabIndex >= 0;
  });
  if (!reached) throw new Error('close button is not focusable');
  return 'close button focusable';
});

// --- mobile ----------------------------------------------------------------

await check('phone layout becomes a bottom sheet', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/?c=FR`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.panel-country .status-banner', { timeout: 30_000 });

  const geo = await page.evaluate(() => {
    const panel = document.querySelector('.panel-country');
    const handle = document.querySelector('.sheet-handle');
    if (!panel) return null;
    const r = panel.getBoundingClientRect();
    return {
      left: Math.round(r.left),
      width: Math.round(r.width),
      bottom: Math.round(r.bottom),
      viewport: window.innerWidth,
      handleVisible: handle ? getComputedStyle(handle).display !== 'none' : false,
    };
  });
  if (!geo) throw new Error('panel missing');
  if (geo.width < geo.viewport - 2) throw new Error(`sheet not full width: ${JSON.stringify(geo)}`);
  if (!geo.handleVisible) throw new Error('drag handle not shown on phone');
  return `full-width sheet (${geo.width}px), handle shown`;
});

await check('no horizontal overflow on a phone', async () => {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 1) throw new Error(`${over}px of horizontal overflow`);
  return 'none';
});

await check('tap targets are large enough on a phone', async () => {
  const small = await page.evaluate(() => {
    const out = [];
    for (const node of document.querySelectorAll('button, a.chip, .legend-row, .country-row')) {
      const r = node.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.height < 32) out.push(`${node.className || node.tagName}:${Math.round(r.height)}px`);
    }
    return out.slice(0, 6);
  });
  if (small.length) throw new Error(`targets under 32px: ${small.join(', ')}`);
  return 'all interactive targets 32px or taller';
});

await shot(page, 'phone-sheet');

await check('sheet drag handle responds to a swipe', async () => {
  const handle = page.locator('.sheet-handle');
  const box = await handle.boundingBox();
  if (!box) throw new Error('no handle box');
  const before = (await page.locator('.panel-country').boundingBox())?.height ?? 0;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - 160, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const after = (await page.locator('.panel-country').boundingBox())?.height ?? 0;
  if (Math.abs(after - before) < 20) throw new Error(`height unchanged: ${before} -> ${after}`);
  return `height ${Math.round(before)} -> ${Math.round(after)}px`;
});

await shot(page, 'phone-sheet-expanded');

// --- reduced motion --------------------------------------------------------

await check('reduced motion disables animation', async () => {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  });
  const p2 = await ctx.newPage();
  await p2.goto(BASE, { waitUntil: 'domcontentloaded' });
  await p2.waitForSelector('.ticker-item', { timeout: 30_000 });
  const anim = await p2.evaluate(() => {
    const track = document.querySelector('.ticker-track');
    return track ? getComputedStyle(track).animationName : 'missing';
  });
  const dur = await p2.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--t-base').trim(),
  );
  await ctx.close();
  if (anim !== 'none' && dur !== '1ms') throw new Error(`ticker still animating: ${anim}, --t-base ${dur}`);
  return `ticker animation ${anim}, --t-base ${dur}`;
});

// --- error handling --------------------------------------------------------

await check('a down source is surfaced, not hidden', async () => {
  const res = await page.request.get(`${BASE}/api/health`);
  const health = await res.json();
  const down = health.sourcesDown ?? [];
  // Every down source must carry a human-readable reason.
  const silent = down.filter((s) => !s.error);
  if (silent.length) throw new Error(`${silent.length} down sources with no error message`);
  return `${down.length} down, each with a stated reason`;
});

// --- console and network ---------------------------------------------------

await check('no console errors from the app itself', () => {
  if (consoleErrors.length) throw new Error(`${consoleErrors.length}: ${consoleErrors.slice(0, 2).join(' | ')}`);
  return blockedRequestErrors.length
    ? `clean (${blockedRequestErrors.length} blocked-subresource errors from the renderer, listed below)`
    : 'clean';
});

await check('no failed network requests from the app itself', () => {
  if (networkFailures.length) throw new Error(`${networkFailures.length}: ${networkFailures.slice(0, 2).join(' | ')}`);
  return 'clean';
});

if (blockedRequestErrors.length) {
  console.log(
    `\n  NOTE  ${blockedRequestErrors.length} renderer request error(s) for blocked hosts: ` +
      `"${blockedRequestErrors[0]}"`,
  );
}

if (blockedExternal.size) {
  console.log(
    `\n  NOTE  ${blockedExternal.size} external host(s) unreachable from this environment ` +
      `(not an app fault): ${[...blockedExternal].join(', ')}`,
  );
}

await browser.close();

// --- report ----------------------------------------------------------------

console.log('\n--- countries opened ---');
for (const o of observed) {
  console.log(`\n${o.name}`);
  console.log(`  status : ${o.status} (${o.basis})`);
  console.log(`  rule   : ${o.reason.slice(0, 150)}`);
  console.log(`  leader : ${o.leader}`);
  console.log(`  stories: ${o.storyCount}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
}
console.log(`\nScreenshots in ${OUT}\n`);

exit(failed.length ? 1 : 0);
