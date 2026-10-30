/**
 * Small DOM helpers.
 *
 * Everything is built with createElement and textContent rather than
 * innerHTML, because every string rendered here comes from a news feed or a
 * SPARQL label. Treating that as markup would be an injection waiting to
 * happen, so it is never parsed as HTML.
 */

type Attrs = Record<string, string | number | boolean | null | undefined>;
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'style') node.setAttribute('style', String(value));
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export const frag = (children: Child[]): DocumentFragment => {
  const f = document.createDocumentFragment();
  for (const c of children) {
    if (c == null || c === false) continue;
    f.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return f;
};

export function clear(node: Element): void {
  node.replaceChildren();
}

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T => {
  const found = root.querySelector<T>(sel);
  if (!found) throw new Error(`missing element: ${sel}`);
  return found;
};

/** Relative time, e.g. "4m ago". Short enough for a dense list. */
export function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'unknown time';
  const s = Math.round(ms / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Absolute time for the title attribute, so the exact moment is available. */
export function exactTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** A <time> element carrying both the relative and the exact time. */
export const timeEl = (iso: string): HTMLElement =>
  el('time', { datetime: iso, title: exactTime(iso), text: timeAgo(iso) });

/**
 * Real national flag, from flagcdn's SVG set. Falls back to hiding itself
 * rather than showing a broken-image glyph.
 */
export function flag(iso2: string, name: string, size = 64): HTMLImageElement {
  const img = el('img', {
    class: 'flag',
    src: `https://flagcdn.com/w${size}/${iso2.toLowerCase()}.png`,
    srcset: `https://flagcdn.com/w${size * 2}/${iso2.toLowerCase()}.png 2x`,
    alt: `Flag of ${name}`,
    width: String(Math.round(size / 2)),
    height: String(Math.round(size / 2 * 0.75)),
    loading: 'lazy',
    decoding: 'async',
  });
  img.addEventListener('error', () => {
    img.style.visibility = 'hidden';
  });
  return img;
}

/** Source link shown beside a fact. Always carries the source's own name. */
export function cite(source: { source: string; url: string | null; retrievedAt?: string }): HTMLElement {
  const label = source.source;
  if (!source.url) {
    return el('span', { class: 'cite', text: label, title: 'This source provides no direct link.' });
  }
  return el(
    'a',
    {
      class: 'cite',
      href: source.url,
      target: '_blank',
      rel: 'noopener noreferrer',
      title: source.retrievedAt ? `${label} - retrieved ${exactTime(source.retrievedAt)}` : label,
    },
    [label],
  );
}

/** Row of key and value, with an optional citation under the value. */
export function dataRow(key: string, value: Child[], source?: { source: string; url: string | null }): HTMLElement {
  return el('div', { class: 'row' }, [
    el('span', { class: 'k', text: key }),
    el('span', { class: 'v' }, [...value, source ? el('div', {}, [cite(source)]) : null]),
  ]);
}

/** Consistent "No data" treatment, used anywhere a source gave nothing. */
export const noData = (why: string): HTMLElement =>
  el('span', { class: 'no-data', title: why, text: 'No data' });

/** Skeleton block for loading states. */
export const skeleton = (height: number, width = '100%'): HTMLElement =>
  el('div', { class: 'skeleton', style: `height:${height}px;width:${width}` });

/**
 * Applies a capped stagger to a list of freshly rendered nodes. Capped so a
 * long list finishes arriving quickly instead of trickling.
 */
export function stagger(nodes: Iterable<Element>, step = 28, cap = 320): void {
  let i = 0;
  for (const node of nodes) {
    const delay = Math.min(cap, i * step);
    (node as HTMLElement).style.animationDelay = `${delay}ms`;
    node.classList.add('rise');
    i += 1;
  }
}

/**
 * Counts a number up to its value on mount.
 *
 * Respects reduced motion by writing the final value immediately, and uses
 * one rAF loop per element rather than a timer, so it stays in step with the
 * compositor.
 */
export function countUp(node: HTMLElement, to: number, opts: { duration?: number; decimals?: number } = {}): void {
  const { duration = 650, decimals = 0 } = opts;
  const format = (v: number) => v.toFixed(decimals);
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || duration <= 0) {
    node.textContent = format(to);
    return;
  }
  const from = 0;
  const start = performance.now();
  const tick = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    // Ease-out cubic, so the number settles rather than stopping dead.
    const eased = 1 - Math.pow(1 - t, 3);
    node.textContent = format(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
