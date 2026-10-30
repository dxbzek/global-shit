// Generates country geometry + a country registry from packaged reference datasets.
// Sources: world-atlas (Natural Earth polygons), i18n-iso-countries (ISO 3166),
// countries-list (capital + continent). Nothing here is hand-authored except
// scripts/aliases.json, which holds name variants used for article matching.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as topojson from 'topojson-client';
import iso from 'i18n-iso-countries';
import { countries as cl, continents } from 'countries-list';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const aliases = JSON.parse(readFileSync(resolve(root, 'scripts/aliases.json'), 'utf8'));

const ringArea = (ring) => {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
};

const ringCentroid = (ring) => {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    const f = x1 * y2 - x2 * y1;
    a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f;
  }
  a *= 0.5;
  if (!a) {
    const s = ring.reduce((p, c) => [p[0] + c[0], p[1] + c[1]], [0, 0]);
    return [s[0] / ring.length, s[1] / ring.length];
  }
  return [cx / (6 * a), cy / (6 * a)];
};

// Outer rings of a geometry, flattened across MultiPolygon parts.
const outerRings = (geom) =>
  geom.type === 'Polygon' ? [geom.coordinates[0]]
  : geom.type === 'MultiPolygon' ? geom.coordinates.map((p) => p[0])
  : [];

// Coordinate precision caps file size. 3 decimals is ~110 m at the equator,
// finer than a globe at any sane zoom, and cuts the 50m set by roughly 60%.
const quantize = (coords, dp) => {
  if (typeof coords[0] === 'number') return [Number(coords[0].toFixed(dp)), Number(coords[1].toFixed(dp))];
  return coords.map((c) => quantize(c, dp));
};

// Drops consecutive duplicate points left behind by quantization, and any ring
// that collapses to fewer than 4 points (too small to draw at this precision).
const dedupeRings = (geom) => {
  const clean = (ring) => {
    const out = [];
    for (const pt of ring) {
      const prev = out[out.length - 1];
      if (!prev || prev[0] !== pt[0] || prev[1] !== pt[1]) out.push(pt);
    }
    if (out.length && (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1])) out.push(out[0]);
    return out.length >= 4 ? out : null;
  };
  if (geom.type === 'Polygon') {
    const rings = geom.coordinates.map(clean).filter(Boolean);
    return rings.length ? { type: 'Polygon', coordinates: rings } : null;
  }
  const polys = geom.coordinates
    .map((poly) => poly.map(clean).filter(Boolean))
    .filter((poly) => poly.length);
  return polys.length ? { type: 'MultiPolygon', coordinates: polys } : null;
};

const build = (resolution) => {
  const topo = JSON.parse(readFileSync(resolve(root, `node_modules/world-atlas/countries-${resolution}.json`), 'utf8'));
  return topojson.feature(topo, topo.objects.countries);
};

const registry = {};
const emit = (resolution, outFile, dp) => {
  const fc = build(resolution);
  const features = [];
  for (const f of fc.features) {
    const isoNum = String(f.id).padStart(3, '0');
    const a2 = iso.numericToAlpha2(isoNum);
    if (!a2) { console.warn(`  skip (no ISO alpha-2 for numeric ${isoNum}): ${f.properties?.name}`); continue; }
    const a3 = iso.alpha2ToAlpha3(a2);
    const name = iso.getName(a2, 'en') || f.properties?.name || a2;
    const meta = cl[a2] || {};
    const rings = outerRings(f.geometry);
    if (!rings.length) continue;

    // Camera target: centroid of the largest landmass, not of all territories,
    // so countries with distant islands still frame their mainland.
    const biggest = rings.reduce((p, c) => (ringArea(c) > ringArea(p) ? c : p), rings[0]);
    const [clon, clat] = ringCentroid(biggest);
    let minLon = 180, minLat = 90, maxLon = -180, maxLat = -90;
    for (const [lon, lat] of biggest) {
      if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    }

    const geometry = dedupeRings({ ...f.geometry, coordinates: quantize(f.geometry.coordinates, dp) });
    if (geometry) features.push({ type: 'Feature', id: a2, properties: { iso2: a2, iso3: a3, name }, geometry });

    if (!registry[a2]) {
      const al = aliases[a2] || {};
      const names = [...new Set([name, meta.name, ...(al.alias || [])].filter(Boolean))];
      registry[a2] = {
        iso2: a2, iso3: a3, isoNum, name,
        capital: meta.capital || null,
        continent: meta.continent ? continents[meta.continent] : null,
        centroid: [Number(clon.toFixed(4)), Number(clat.toFixed(4))],
        bbox: [minLon, minLat, maxLon, maxLat].map((v) => Number(v.toFixed(4))),
        areaRank: Number(rings.reduce((s, r) => s + ringArea(r), 0).toFixed(4)),
        match: {
          names,
          demonyms: al.demonym || [],
          // Short or dictionary-word names (Chad, Chile, Georgia, Jordan, Mali,
          // Niger, Turkey) produce false positives alone, so they are only
          // matched when another country signal is present in the same text.
          requireContext: Boolean(al.requireContext) || name.length <= 4,
        },
      };
    }
  }
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify({ type: 'FeatureCollection', features }));
  const kb = (readFileSync(outFile).length / 1024).toFixed(0);
  console.log(`  ${outFile.replace(root + '/', '')}: ${features.length} countries, ${kb} KB`);
};

console.log('Building country geometry...');
emit('50m', resolve(root, 'web/public/data/countries-50m.geojson'), 3);
emit('110m', resolve(root, 'web/public/data/countries-110m.geojson'), 2);

const out = resolve(root, 'worker/lib/countries.generated.ts');
writeFileSync(out, `// GENERATED by scripts/build-countries.mjs - do not edit.
// Reference geography only (ISO codes, names, capitals, centroids). No event data.
export interface CountryRef {
  iso2: string; iso3: string; isoNum: string; name: string;
  capital: string | null; continent: string | null;
  centroid: [number, number]; bbox: [number, number, number, number];
  areaRank: number;
  match: { names: string[]; demonyms: string[]; requireContext: boolean };
}
export const COUNTRIES: Record<string, CountryRef> = ${JSON.stringify(registry, null, 0)};
export const COUNTRY_LIST: CountryRef[] = Object.values(COUNTRIES);
`);
console.log(`  worker/lib/countries.generated.ts: ${Object.keys(registry).length} entries`);
