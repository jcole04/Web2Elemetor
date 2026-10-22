import { chromium } from 'playwright';
import { randomBytes } from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { extractLayout } from './page-script.js';
import { iconFromHints, faShapes, faIcon, hasIcon, libraryIconBySignature, libraryShapes, faFromLibraryName } from '../icons.js';
import { signatureFromMarkup } from '../icon-sig.js';
import { sanitizeMarkup } from '../sanitize.js';

const VIEWPORT = { width: 1440, height: 900 };

function launchOptions() {
  const opts = { headless: true };
  if (process.env.CHROMIUM_PATH) opts.executablePath = process.env.CHROMIUM_PATH;
  return opts;
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  return v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6.startsWith('::ffff:127.') || v6 === '::';
}

// Refuses URLs that point at this machine or a private network, so the
// converter can't be used to read internal services.
export async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('That does not look like a valid URL.');
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Only http and https links are supported.');
  if (process.env.ALLOW_PRIVATE_URLS === '1') return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (addrs.some(isPrivateAddress)) throw new Error('Links to private or local addresses are not allowed.');
  return url;
}

async function withPage(fn) {
  const browser = await chromium.launch(launchOptions());
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, bypassCSP: true });
    const page = await context.newPage();
    return await fn(page);
  } finally {
    await browser.close();
  }
}

async function settle(page) {
  // Trigger lazy-loaded content, then return to the top.
  // Instant jumps: pages with smooth scrolling would otherwise still be moving
  // (and sticky headers sitting mid-page) when the layout is measured.
  await page.evaluate(async () => {
    const step = innerHeight;
    for (let y = 0; y < document.body.scrollHeight && y < 20000; y += step) {
      scrollTo({ top: y, behavior: 'instant' });
      await new Promise((r) => setTimeout(r, 120));
    }
    scrollTo({ top: 0, behavior: 'instant' });
    for (let i = 0; i < 20 && scrollY !== 0; i++) await new Promise((r) => setTimeout(r, 50));
  });
  // fonts.ready can settle before a web font is even requested; load every declared
  // face (with a time limit) so text is measured in its real font.
  await page.evaluate(async () => {
    if (!document.fonts) return;
    const all = Promise.all([...document.fonts].map((f) => (f.status === 'unloaded' ? f.load() : f.loaded).catch(() => {})));
    await Promise.race([all, new Promise((r) => setTimeout(r, 8000))]);
    await document.fonts.ready;
  });
  await page.waitForTimeout(300);
}

export async function extractFromUrl(rawUrl) {
  const url = await assertPublicUrl(rawUrl);
  return withPage(async (page) => {
    if (process.env.ALLOW_PRIVATE_URLS !== '1') {
      // Re-check every request the page makes, including redirects.
      await page.route('**/*', async (route) => {
        try {
          await assertPublicUrl(route.request().url());
          await route.continue();
        } catch {
          await route.abort();
        }
      });
    }
    await page.goto(url.href, { waitUntil: 'networkidle', timeout: 45000 }).catch(async (e) => {
      if (!/Timeout/.test(e.message)) throw e;
    });
    await settle(page);
    const layout = await extract(page);
    layout.source = { type: 'url', url: url.href };
    return layout;
  });
}

export async function extractFromHtml(html, baseUrl) {
  return withPage(async (page) => {
    // Pasted HTML is untrusted: block scripts and only allow remote styles, fonts and images.
    await page.route('**/*', async (route) => {
      const type = route.request().resourceType();
      if (['stylesheet', 'font', 'image'].includes(type)) {
        try {
          await assertPublicUrl(route.request().url());
          return route.continue();
        } catch {
          return route.abort();
        }
      }
      if (type === 'document') return route.continue();
      return route.abort();
    });
    let doc = html;
    if (baseUrl && !/<base\s/i.test(doc)) {
      // After the doctype (or inside <head>), or the page falls into quirks mode.
      const base = `<base href="${baseUrl.replace(/"/g, '')}">`;
      const at = doc.match(/<head\b[^>]*>/i) || doc.match(/^\s*<!doctype[^>]*>/i);
      doc = at ? doc.slice(0, at.index + at[0].length) + base + doc.slice(at.index + at[0].length) : base + doc;
    }
    await page.setContent(doc, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
    await settle(page);
    const layout = await extract(page);
    layout.source = { type: 'html' };
    return layout;
  });
}

// Every icon-bearing node in the tree (icons, icon-list bullets, social links, button icons).
function collectIcons(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.kind === 'icon' || (node.hints !== undefined && 'svg' in node && node.kind !== 'svg')) out.push(node);
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach((x) => collectIcons(x, out));
    else if (v && typeof v === 'object' && v !== node) collectIcons(v, out);
  }
  return out;
}

async function extract(page) {
  const layout = await page.evaluate(extractLayout);
  await inlineImages(page, layout);
  await resolveIcons(page, layout);
  return layout;
}

function collectKind(node, kind, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.kind === kind) out.push(node);
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach((x) => collectKind(x, kind, out));
    else if (v && typeof v === 'object' && v !== node) collectKind(v, kind, out);
  }
  return out;
}

const SVG_LIMIT = 400 * 1024;

// Downloads an SVG file the page shows with <img>. Each hop is checked the same
// way page requests are, so a redirect can't reach a private address.
async function fetchSvg(page, src) {
  if (/^data:image\/svg\+xml/i.test(src)) {
    const [head, body = ''] = src.split(/,(.*)/s);
    return /;base64/i.test(head) ? Buffer.from(body, 'base64').toString('utf8') : decodeURIComponent(body);
  }
  let url = src;
  for (let hop = 0; hop < 4; hop++) {
    await assertPublicUrl(url);
    const res = await page.context().request.get(url, { maxRedirects: 0, timeout: 10000, failOnStatusCode: false });
    if (res.status() >= 300 && res.status() < 400 && res.headers().location) {
      url = new URL(res.headers().location, url).href;
      continue;
    }
    if (!res.ok()) return null;
    const body = await res.body();
    return body.length <= SVG_LIMIT ? body.toString('utf8') : null;
  }
  return null;
}

// Fits a downloaded SVG to the box it was drawn in, keeping its proportions the
// way <img> does.
function fitSvg(text, w, h, objectFit = 'fill') {
  let svg = text.replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->/gi, '').trim();
  const open = svg.match(/<svg\b[^>]*>/i);
  if (!open) return null;
  let tag = open[0];
  const attr = (name) => tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1];
  const ownViewBox = !!attr('viewBox');
  if (!ownViewBox) {
    const ow = parseFloat(attr('width')), oh = parseFloat(attr('height'));
    if (ow && oh) tag = tag.replace(/<svg\b/i, `<svg viewBox="0 0 ${ow} ${oh}"`);
  }
  const vb = (attr('viewBox') || '').split(/[\s,]+/).map(Number);
  tag = tag.replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  tag = tag.replace(/<svg\b/i, `<svg width="${Math.round(w)}" height="${Math.round(h)}"`);
  if (vb[2] > 0 && vb[3] > 0 && Math.abs(vb[2] / vb[3] - w / h) > 0.02 * (w / h)) {
    // Drawn into a box of another shape: the <img>'s object-fit in SVG terms (cover crops, contain fits).
    // fill stretches only a file without a viewBox; one with a viewBox keeps its own
    // preserveAspectRatio (centred and letterboxed by default), as Chrome draws it.
    const fit = { cover: 'xMidYMid slice', contain: 'xMidYMid meet', 'scale-down': 'xMidYMid meet', none: 'xMidYMid slice' }[objectFit] || (ownViewBox ? null : 'none');
    if (fit) tag = tag.replace(/\spreserveAspectRatio\s*=\s*("[^"]*"|'[^']*')/i, '').replace(/<svg\b/i, `<svg preserveAspectRatio="${fit}"`);
  }
  if (!/\sxmlns=/.test(tag)) tag = tag.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  svg = svg.replace(open[0], tag);
  // Classes only served the file's own <style> rules (already written onto each shape);
  // in a page they could pick up the theme's CSS.
  svg = svg.replace(/\sclass\s*=\s*("[^"]*"|'[^']*')/gi, '');
  return sanitizeMarkup(scopeIds(svg, `i${randomBytes(3).toString('hex')}-`));
}

// Gives the SVG's ids a prefix of their own (svgMarkup does the same in the page).
// Every HTML widget ends up in one page, where a second id="bg" would draw with
// the first picture's gradient.
function scopeIds(svg, prefix) {
  const ids = new Set([...svg.matchAll(/\sid\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]));
  if (!ids.size) return svg;
  const ref = (id) => (ids.has(id) ? prefix + id : id);
  return svg
    .replace(/(\sid\s*=\s*["'])([^"']+)/gi, (m, a, id) => a + prefix + id)
    .replace(/(\s(?:xlink:)?href\s*=\s*["'])#([^"']+)/gi, (m, a, id) => `${a}#${ref(id)}`)
    .replace(/(\saria-(?:labelledby|describedby)\s*=\s*["'])([^"']+)/gi, (m, a, v) => a + v.split(/\s+/).map(ref).join(' '))
    .replace(/url\(\s*(['"]|&quot;|&#39;)?#([^'")&\s]+)/gi, (m, q = '', id) => `url(${q}#${ref(id)}`);
}

// Runs in the page: draws an SVG file in a blank frame (away from the page's own
// CSS) and writes whatever its <style> rules set on each shape into the shape's
// own style attribute, so the block itself can be dropped: in an HTML widget it
// would restyle every SVG on the page.
function inlineSvgStyles(text) {
  const PROPS = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
    'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'stop-color', 'stop-opacity', 'clip-path', 'clip-rule', 'mask', 'filter', 'display', 'visibility',
    'mix-blend-mode', 'isolation', 'transform', 'transform-origin', 'transform-box', 'paint-order', 'vector-effect', 'font-size', 'font-weight', 'font-style',
    'letter-spacing', 'text-anchor'];
  const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = parsed.documentElement;
  if (root.localName !== 'svg' || parsed.querySelector('parsererror')) return null;
  // Nothing in the file may run once it is in a live document.
  root.querySelectorAll('script, foreignObject').forEach((n) => n.remove());
  for (const n of [root, ...root.querySelectorAll('*')]) for (const a of [...n.attributes]) if (/^on/i.test(a.name)) n.removeAttribute(a.name);
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:absolute;left:-9999px;top:0;width:10px;height:10px;border:0';
  document.documentElement.appendChild(frame);
  try {
    const doc = frame.contentDocument;
    doc.open();
    doc.write('<!doctype html><html><body></body></html>');
    doc.close();
    const svg = doc.importNode(root, true);
    doc.body.appendChild(svg);
    const nodes = [...svg.querySelectorAll('*')].filter((n) => n.localName !== 'style');
    const read = () => nodes.map((n) => {
      const cs = doc.defaultView.getComputedStyle(n);
      return PROPS.map((p) => cs.getPropertyValue(p));
    });
    const styled = read();
    svg.querySelectorAll('style').forEach((n) => n.remove());
    nodes.forEach((n) => n.removeAttribute('class'));
    const plain = read();
    let changed = false;
    nodes.forEach((n, i) => PROPS.forEach((p, j) => {
      if (styled[i][j] !== plain[i][j]) {
        n.style.setProperty(p, styled[i][j]);
        changed = true;
      }
    }));
    return changed ? new XMLSerializer().serializeToString(svg) : null;
  } catch {
    return null;
  } finally {
    frame.remove();
  }
}

// #rgb, #rrggbb and opaque rgb() colours as #RRGGBB; null for anything else.
function hexColor(v) {
  v = String(v || '').trim().toLowerCase();
  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/)?.[1];
  if (hex) return '#' + (hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex).toUpperCase();
  const rgb = v.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[,/]\s*1\s*)?\)$/);
  return rgb ? '#' + rgb.slice(1, 4).map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('').toUpperCase() : null;
}

// A plain colour swatch: one rect or circle filling the whole picture, in one colour.
// A container with that background (round for the circle) draws it natively.
function swatchOf(svg, w, h) {
  const root = svg.match(/<svg\b[^>]*>/i)?.[0] || '';
  const inner = svg.slice(svg.indexOf(root) + root.length).replace(/<\/svg>\s*$/i, '').replace(/<(title|desc)\b[\s\S]*?<\/\1>/gi, '').trim();
  const shape = inner.match(/^<(rect|circle)\b([^>]*?)\/?>(?:\s*<\/\1>)?$/i);
  if (!shape || /\s(style|opacity|fill-opacity|stroke|filter|mask|clip-path|transform)\s*=/i.test(root)) return null;
  const attrs = Object.fromEntries([...shape[2].matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map((m) => [m[1].toLowerCase(), m[2]]));
  if (Object.keys(attrs).some((a) => !['x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'fill', 'id'].includes(a))) return null;
  const [, , vw, vh] = (root.match(/\sviewBox\s*=\s*["']([^"']*)["']/i)?.[1] || '').split(/[\s,]+/).map(Number);
  if (!(vw > 0 && vh > 0) || Math.abs(vw / vh - w / h) > 0.02 * (w / h)) return null;
  const is = (v, full) => v === '100%' || Math.abs(parseFloat(v) - full) < 0.01;
  const at0 = (v) => v == null || parseFloat(v) === 0;
  const circle = shape[1].toLowerCase() === 'circle';
  if (circle ? !(Math.abs(vw - vh) < 0.01 && is(attrs.r, vw / 2) && is(attrs.cx, vw / 2) && is(attrs.cy, vh / 2)) : !(at0(attrs.x) && at0(attrs.y) && is(attrs.width, vw) && is(attrs.height, vh))) return null;
  const color = hexColor(attrs.fill ?? root.match(/\sfill\s*=\s*["']([^"']*)["']/i)?.[1] ?? '#000');
  return color && { color, circle };
}

// The paint colours an SVG uses, ignoring none/transparent. currentColor in an
// <img> resolves to black.
function svgPaints(svg) {
  const found = new Set();
  const add = (v) => {
    v = v.trim().toLowerCase();
    if (!v || v === 'none' || v === 'transparent' || v.startsWith('url(')) return;
    found.add(v === 'currentcolor' ? '#000000' : hexColor(v) || v);
  };
  for (const m of svg.matchAll(/\s(?:fill|stroke)\s*=\s*["']([^"']*)["']/gi)) add(m[1]);
  for (const m of svg.matchAll(/(?:^|[;\s"'{])(?:fill|stroke)\s*:\s*([^;"'}]+)/gi)) add(m[1]);
  if (/<(linearGradient|radialGradient|pattern|image)\b/i.test(svg)) found.add('mixed');
  return [...found];
}

// <img> elements whose source Elementor can't import by link: SVG files (the
// importer only takes raster images) and inline data: images.
async function inlineImages(page, layout) {
  const images = collectKind(layout.root, 'image');
  for (const n of images) {
    const src = n.src || '';
    const w = n.rect?.w || 0, h = n.rect?.h || 0;
    if (/^data:image\/svg\+xml/i.test(src) || /^https?:\/\/[^#?]+\.svg([?#]|$)/i.test(src)) {
      let text = await fetchSvg(page, src).catch(() => null);
      // If this fails, sanitizeMarkup still drops the <style> block (and its colours).
      if (text && /<style\b/i.test(text)) text = (await page.evaluate(inlineSvgStyles, text).catch(() => null)) || text;
      const svg = text && w && h && fitSvg(text, w, h, n.objectFit);
      if (!svg) continue;
      const swatch = !(n.padding || []).some((p) => p > 0) && !n.border?.width && swatchOf(svg, w, h);
      if (swatch) {
        // Drawn like the page's coloured dots and bars: a fixed-size box with a background.
        Object.assign(n, {
          kind: 'container', src: null, children: [], direction: 'column', wrap: false, justify: 'normal', alignItems: 'normal', gap: { column: 0, row: 0 },
          background: { color: swatch.color }, border: swatch.circle ? { ...n.border, radius: [50, 50, 50, 50], radiusUnit: '%' } : n.border,
          fixedWidth: Math.round(w), minHeight: Math.round(h),
        });
        continue;
      }
      const paints = svgPaints(svg);
      const file = decodeURIComponent((src.startsWith('data:') ? '' : new URL(src).pathname.split('/').pop() || '').replace(/\.svg$/i, '')).replace(/[-_]+/g, ' ');
      const rounded = (n.border?.radius || []).some((r) => r > 0);
      if (w <= 64 && h <= 64 && Math.max(w, h) <= Math.min(w, h) * 1.25 && paints.length <= 1 && !rounded) {
        // Alt text describes the image, not the glyph, so only the file name counts as a hint.
        Object.assign(n, { kind: 'icon', svg, hints: file, color: paints[0] || '#000000', size: Math.round(Math.max(w, h)), fromImage: true });
      } else {
        Object.assign(n, { kind: 'svg', svg, hints: `${n.alt || ''} ${file}`.trim() });
      }
    } else if (/^data:image\//i.test(src)) {
      const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
      const rad = n.border?.radius || [];
      const radius = rad.some((r) => r > 0) ? `border-radius:${rad.map((r) => `${r}${n.border.radiusUnit || 'px'}`).join(' ')};` : '';
      Object.assign(n, {
        kind: 'html', role: 'image',
        markup: `<img src="${esc(src)}" alt="${esc(n.alt || '')}" width="${Math.round(w)}" height="${Math.round(h)}" style="display:inline-block;vertical-align:top;width:100%;max-width:${Math.round(w)}px;height:auto;aspect-ratio:${Math.round(w)}/${Math.round(h)};object-fit:${n.objectFit || 'fill'};${radius}">`,
      });
    }
  }
}

// Names first (class names, sprite ids, aria-labels, link targets); then an exact
// shape match against the open-source icon sets sites copy from (Lucide, Feather,
// Heroicons, Tabler); otherwise the closest shape by pixel comparison.
async function resolveIcons(page, layout) {
  const icons = [...new Set(collectIcons(layout.root))];
  const titles = iconTitles(layout.root);
  const unresolved = [];
  for (const ic of icons) {
    const href = (ic.hints || '').match(/https?:\/\/\S+/)?.[0];
    // The icon's own names come first. Names from the boxes around it ("alert",
    // "card") describe the box, so for drawn icons they only break ties the
    // shape can't settle; brand links and icon fonts still go by them.
    let hit = iconFromHints(ic.ownHints ?? ic.hints, { href });
    const around = !hit && ic.ownHints != null ? iconFromHints(ic.hints, { href }) : null;
    if (around && (!ic.svg || around.icon.library === 'fa-brands')) hit = around;
    if (hit) { Object.assign(ic, { fa: withCircle(hit.icon, ic.svg), faConfidence: hit.confidence }); continue; }
    if (around) ic.aroundHit = around;
    // Failing that, the title beside it ("Content analytics" on a feature card) does.
    else if (ic.svg && titles.has(ic)) ic.aroundHit = iconFromHints(titles.get(ic));
    const lib = ic.svg && libraryIconBySignature(signatureFromMarkup(ic.svg));
    const fromLib = lib && faFromLibraryName(lib.name, lib.tags, lib.style);
    if (fromLib) Object.assign(ic, { fa: fromLib, faConfidence: 'library', libraryIcon: `${lib.set}:${lib.name}` });
    else if (ic.svg) unresolved.push(ic);
    else Object.assign(ic, { fa: faIcon('circle'), faConfidence: 'none' });
  }
  if (!unresolved.length) return;
  const shapes = faShapes().filter((s) => s.lib !== 'brands');
  const outlines = libraryShapes();
  const matches = await page.evaluate(matchShapes, { svgs: unresolved.map((i) => i.svg), shapes, outlines }).catch(() => []);
  unresolved.forEach((ic, i) => {
    const m = matches[i];
    let fa = null;
    let score = m?.score;
    if (m?.outline) fa = faFromLibraryName(m.name, '', m.style);
    if (!fa && m?.outline && m.fa) {
      fa = faIcon(m.fa.name, m.fa.lib);
      score = m.fa.score;
    } else if (!fa && m && !m.outline) fa = faIcon(m.name, m.lib);
    if ((!fa || score <= 0.82) && ic.aroundHit) Object.assign(ic, { fa: ic.aroundHit.icon, faConfidence: 'name' });
    else if (fa) Object.assign(ic, { fa, faConfidence: score > 0.82 ? 'shape' : 'weak', faScore: score });
    else Object.assign(ic, { fa: faIcon('circle'), faConfidence: 'none' });
  });
}

// The heading that sits beside an icon, or beside the tile holding it (a feature
// card's title), for each such icon.
function iconTitles(node, out = new Map()) {
  if (!node || typeof node !== 'object') return out;
  const kids = Array.isArray(node.children) ? node.children : [];
  const title = kids.find((c) => c?.kind === 'heading')?.text;
  for (const c of title ? kids : []) {
    const ic = c?.kind === 'icon' ? c : c?.kind === 'container' && c.children?.length === 1 && c.children[0]?.kind === 'icon' ? c.children[0] : null;
    if (ic) out.set(ic, title);
  }
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach((x) => iconTitles(x, out));
    else if (v && typeof v === 'object' && v !== node) iconTitles(v, out);
  }
  return out;
}

// A glyph named by its class ("check") but drawn on a filled disc is Font Awesome's
// circled version of it, when there is one (check → check-circle).
function withCircle(icon, svg) {
  if (!svg || icon.library !== 'fa-solid' || /-circle$/.test(icon.value)) return icon;
  const vb = svg.match(/viewBox="[\d.\s-]+?\s([\d.]+)\s([\d.]+)"/);
  const size = vb ? Math.min(Number(vb[1]), Number(vb[2])) : 24;
  const disc = [...svg.matchAll(/<circle\b[^>]*>/g)].some((m) => Number(m[0].match(/\br="([\d.]+)"/)?.[1]) >= size * 0.4 && !/fill="none"/.test(m[0]));
  const name = `${icon.value.replace(/^fas fa-/, '')}-circle`;
  return disc && hasIcon(name, 'solid') ? faIcon(name) : icon;
}

// Runs in the page: rasterises each SVG and every Font Awesome shape to a
// small normalised mask and picks the most similar shape.
async function matchShapes({ svgs, shapes, outlines = [] }) {
  const N = 28;
  const blur = (m) => {
    const out = new Float32Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy >= 0 && yy < N && xx >= 0 && xx < N) { s += m[yy * N + xx]; c++; }
      }
      out[y * N + x] = s / c;
    }
    return out;
  };
  const norm = (m) => {
    let s = 0;
    for (const v of m) s += v * v;
    s = Math.sqrt(s) || 1;
    return m.map((v) => v / s);
  };
  // Crop to the drawn area, then fit it into an N×N square.
  const toMask = (canvas) => {
    const ctx = canvas.getContext('2d');
    const { width: W, height: H } = canvas;
    const d = ctx.getImageData(0, 0, W, H).data;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return null;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1, s = Math.max(bw, bh);
    const c2 = new OffscreenCanvas(N, N);
    const x2 = c2.getContext('2d');
    x2.drawImage(canvas, x0 - (s - bw) / 2, y0 - (s - bh) / 2, s, s, 0, 0, N, N);
    const d2 = x2.getImageData(0, 0, N, N).data;
    const m = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) m[i] = d2[i * 4 + 3] / 255;
    return norm(blur(m));
  };
  const lib = shapes.map((sh) => {
    const c = new OffscreenCanvas(96, 96);
    const ctx = c.getContext('2d');
    const sc = 96 / Math.max(sh.w, sh.h);
    ctx.setTransform(sc, 0, 0, sc, (96 - sh.w * sc) / 2, (96 - sh.h * sc) / 2);
    ctx.fill(new Path2D(sh.d));
    return { ...sh, mask: toMask(c) };
  }).filter((s) => s.mask);
  // Library outline icons drawn the way those sets ship (24-unit grid, round strokes).
  const drawSvg = async (markup) => {
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
    await img.decode();
    const c = new OffscreenCanvas(96, 96);
    c.getContext('2d').drawImage(img, 0, 0, 96, 96);
    return c;
  };
  for (let i = 0; i < outlines.length; i += 250) {
    await Promise.all(outlines.slice(i, i + 250).map(async (o) => {
      const paint = o.style === 'stroke' ? `fill="none" stroke="#000" stroke-width="${o.set === 'heroicons' ? 1.5 : 2}" stroke-linecap="round" stroke-linejoin="round"` : 'fill="#000"';
      try {
        const mask = toMask(await drawSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="96" height="96" ${paint}>${o.markup}</svg>`));
        if (mask) lib.push({ name: o.name, lib: o.set, style: o.style, outline: true, mask });
      } catch {}
    }));
  }
  const out = [];
  for (const svg of svgs) {
    try {
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace(/(<svg[^>]*?)\swidth="[^"]*"/, '$1 width="96"').replace(/(<svg[^>]*?)\sheight="[^"]*"/, '$1 height="96"'));
      await img.decode();
      const c = new OffscreenCanvas(96, 96);
      c.getContext('2d').drawImage(img, 0, 0, 96, 96);
      const m = toMask(c);
      if (!m) { out.push(null); continue; }
      let best = null, bestFa = null;
      for (const s of lib) {
        let dot = 0;
        for (let i = 0; i < m.length; i++) dot += m[i] * s.mask[i];
        const hit = { name: s.name, lib: s.lib, style: s.style, outline: !!s.outline, score: Math.round(dot * 1000) / 1000 };
        if (!best || dot > best.score) best = hit;
        if (!s.outline && (!bestFa || dot > bestFa.score)) bestFa = hit;
      }
      // The closest Font Awesome shape is kept too, for outline matches with no Font Awesome name.
      out.push(best && { ...best, fa: bestFa });
    } catch {
      out.push(null);
    }
  }
  return out;
}
