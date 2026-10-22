// Fidelity check: converts a reference page, imports the template into a real
// WordPress + Elementor install, renders it, and compares it with the reference.
//
// usage: node scripts/fidelity/run.js <page.html | url> [--out dir] [--design-only] [--width 1440]
// env:   WP_PATH  WordPress root    WP_URL  its address (e.g. http://localhost:8890)
//        WP_CLI   command that runs WP-CLI (default "wp"), e.g. "php wp-cli.phar --allow-root"
//
// Reports, per converted element, how far its box and text styles are from the
// reference; lists reference content that never made it into the template; and
// gives an overall pixel-match score with a diff image.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { convert } from '../../src/convert.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const input = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && ['--out', '--width'].includes(argv[i - 1])));
const outDir = path.resolve(flag('--out', 'fidelity-out'));
const width = Number(flag('--width', 1440));
const designOnly = argv.includes('--design-only');
const WP_PATH = process.env.WP_PATH;
const WP_URL = process.env.WP_URL;
const WP_CLI = process.env.WP_CLI || 'wp';
if (!input || !WP_PATH || !WP_URL) {
  console.error('usage: WP_PATH=... WP_URL=... node scripts/fidelity/run.js <page.html|url> [--out dir]');
  process.exit(2);
}

// Serve a local file's folder so relative stylesheets and images resolve like on a real site.
async function serveLocal(file) {
  const root = path.dirname(path.resolve(file));
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.gif': 'image/gif', '.mp4': 'video/mp4' };
  const server = createServer(async (req, res) => {
    const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(root) || !existsSync(p) || statSync(p).isDirectory()) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
    res.end(await readFile(p));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/${path.basename(file)}`, close: () => server.close() };
}

// Visible content of a page: text runs and media boxes, used to spot anything the conversion lost.
function inventory() {
  const out = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode;
    const text = t.textContent.replace(/\s+/g, ' ').trim();
    if (!text || text.length < 2) continue;
    const el = t.parentElement;
    if (!el || el.closest('script,style,noscript,template')) continue;
    // Answers inside closed FAQ items aren't on screen on either page.
    if (el.closest('details:not([open])') && !el.closest('summary')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const r = document.createRange();
    r.selectNodeContents(t);
    const b = r.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) continue;
    out.push({ type: 'text', text, x: b.left + scrollX, y: b.top + scrollY, w: b.width, h: b.height });
  }
  for (const el of document.querySelectorAll('img,svg,video,iframe,canvas,input,select,textarea,button,table,picture')) {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    if (el.closest('details:not([open])') && !el.closest('summary')) continue;
    if (el.tagName.toLowerCase() === 'img' && el.closest('picture') && seen.has(el.closest('picture'))) continue;
    seen.add(el);
    const b = el.getBoundingClientRect();
    if (b.width < 2 || b.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;
    out.push({ type: el.tagName.toLowerCase(), x: b.left + scrollX, y: b.top + scrollY, w: b.width, h: b.height });
  }
  return out;
}

function measure(map) {
  const out = {};
  const pick = (el) => {
    const cs = getComputedStyle(el);
    return { fontFamily: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(), fontSize: parseFloat(cs.fontSize), fontWeight: cs.fontWeight, color: cs.color, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing };
  };
  for (const key of map) {
    const el = document.getElementById(key);
    if (!el) { out[key] = null; continue; }
    if (el.closest('details:not([open])') && !el.closest('summary')) { out[key] = { hidden: true }; continue; }
    // Inactive tab panels are hidden on both pages (the reference was measured with each panel shown).
    if (el.closest('.e-n-tabs-content > .e-con') && !el.getClientRects().length) { out[key] = { hidden: true }; continue; }
    // Compare like with like: the button / image itself, not the full-width widget wrapper.
    const inner = { button: '.elementor-button', image: 'img', icon: '.elementor-icon', divider: '.elementor-divider-separator' }[(el.dataset.widget_type || '').split('.')[0]];
    const box = (inner && el.querySelector(inner)) || el;
    let b = box.getBoundingClientRect();
    // Boxed containers: the outer box is full width; compare the centred content area plus its side padding.
    if (el.classList.contains('e-con-boxed')) {
      const ib = el.querySelector(':scope > .e-con-inner')?.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (ib) b = { left: ib.left - parseFloat(cs.paddingLeft) - parseFloat(cs.borderLeftWidth), top: b.top, width: ib.width + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth), height: b.height, alt: { left: b.left, width: b.width } };
    }
    const textEl = el.querySelector('.elementor-heading-title, .elementor-button, .elementor-text-editor p, .elementor-widget-container p, .elementor-widget-container li, .elementor-widget-container') || el;
    out[key] = { rect: { x: b.left + scrollX, y: b.top + scrollY, w: b.width, h: b.height }, alt: b.alt ? { x: b.alt.left + scrollX, w: b.alt.width } : null, style: pick(textEl), bg: getComputedStyle(el).backgroundColor };
  }
  return out;
}

async function pixelDiff(page, a, b) {
  return page.evaluate(async ({ a, b }) => {
    const load = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = src; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const w = Math.max(ia.width, ib.width), h = Math.max(ia.height, ib.height);
    const ca = new OffscreenCanvas(w, h), cb = new OffscreenCanvas(w, h);
    const xa = ca.getContext('2d'), xb = cb.getContext('2d');
    xa.fillStyle = xb.fillStyle = '#ff00ff'; xa.fillRect(0, 0, w, h); xb.fillRect(0, 0, w, h);
    xa.drawImage(ia, 0, 0); xb.drawImage(ib, 0, 0);
    const da = xa.getImageData(0, 0, w, h), db = xb.getImageData(0, 0, w, h);
    const out = new ImageData(w, h);
    let diff = 0;
    for (let i = 0; i < da.data.length; i += 4) {
      const d = Math.abs(da.data[i] - db.data[i]) + Math.abs(da.data[i + 1] - db.data[i + 1]) + Math.abs(da.data[i + 2] - db.data[i + 2]);
      const g = (da.data[i] + da.data[i + 1] + da.data[i + 2]) / 3;
      if (d > 48) { diff++; out.data[i] = 255; out.data[i + 1] = 0; out.data[i + 2] = 0; out.data[i + 3] = 255; }
      else { out.data[i] = out.data[i + 1] = out.data[i + 2] = 200 + g / 5; out.data[i + 3] = 255; }
    }
    const co = new OffscreenCanvas(w, h);
    co.getContext('2d').putImageData(out, 0, 0);
    const blob = await co.convertToBlob({ type: 'image/png' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { match: 1 - diff / (w * h), w, h, heightA: ia.height, heightB: ib.height, png: btoa(bin) };
  }, { a, b });
}

function rgbHex(c) {
  const m = String(c).match(/[\d.]+/g);
  if (!m) return c;
  return '#' + m.slice(0, 3).map((v) => Math.round(Number(v)).toString(16).padStart(2, '0')).join('').toUpperCase();
}

async function main() {
  await mkdir(outDir, { recursive: true });
  let local = null;
  let url = input;
  if (!/^https?:/.test(input)) {
    local = await serveLocal(input);
    url = local.url;
    process.env.ALLOW_PRIVATE_URLS = '1';
  }
  const result = await convert({ type: 'url', url }, { keepText: !designOnly, keepImages: !designOnly, tagSource: true });
  const tplPath = path.join(outDir, 'template.json');
  await writeFile(tplPath, JSON.stringify(result.template, null, 1));
  // Async on purpose: WordPress fetches the page's images from the local server running in this process.
  const { stdout } = await promisify(exec)(`${WP_CLI} --path=${JSON.stringify(WP_PATH)} --user=admin eval-file ${JSON.stringify(path.join(here, 'make-page.php'))} ${JSON.stringify(tplPath)}`, { encoding: 'utf8' });
  const pageId = stdout.match(/^PAGE_ID=(\d+)$/m)?.[1];
  if (!pageId) throw new Error(`Import failed:\n${stdout}`);
  // PHP notices while saving mean a widget setting Elementor could not render.
  const notices = stdout.replace(/^PAGE_ID=\d+$/m, '').trim();
  if (notices) console.warn(`PHP output during import:\n${notices.slice(0, 2000)}`);
  const wpPage = `${WP_URL.replace(/\/$/, '')}/?page_id=${pageId}`;

  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  const open = async (u) => {
    await page.goto(u, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += innerHeight) { scrollTo({ top: y, behavior: 'instant' }); await new Promise((r) => setTimeout(r, 60)); } scrollTo({ top: 0, behavior: 'instant' }); await Promise.race([Promise.all([...document.fonts].map((f) => (f.status === 'unloaded' ? f.load() : f.loaded).catch(() => {}))), new Promise((r) => setTimeout(r, 8000))]); await document.fonts.ready; });
    // Progress bars and counters animate in for about a second after they scroll into view.
    await page.waitForTimeout(1500);
  };

  await open(url);
  const refPng = await page.screenshot({ fullPage: true });
  const refInv = await page.evaluate(inventory);

  await open(wpPage);
  const outPng = await page.screenshot({ fullPage: true });
  const outInv = await page.evaluate(inventory);
  const measured = await page.evaluate(measure, Object.keys(result.sourceMap));

  await writeFile(path.join(outDir, 'reference.png'), refPng);
  await writeFile(path.join(outDir, 'elementor.png'), outPng);
  const diff = await pixelDiff(page, `data:image/png;base64,${refPng.toString('base64')}`, `data:image/png;base64,${outPng.toString('base64')}`);
  await writeFile(path.join(outDir, 'diff.png'), Buffer.from(diff.png, 'base64'));
  await browser.close();
  local?.close();

  // Per-element comparison
  const elements = [];
  for (const [key, src] of Object.entries(result.sourceMap)) {
    const m = measured[key];
    if (!m) { elements.push({ key, kind: src.kind, text: src.text, missing: true }); continue; }
    if (m.hidden) continue;
    // A boxed section can stand for either the full-width band or the centred wrapper; take the closer match.
    if (m.alt && Math.abs(m.alt.w - src.rect.w) < Math.abs(m.rect.w - src.rect.w)) Object.assign(m.rect, { x: m.alt.x, w: m.alt.w });
    const d = { dx: Math.round(m.rect.x - src.rect.x), dy: Math.round(m.rect.y - src.rect.y), dw: Math.round(m.rect.w - src.rect.w), dh: Math.round(m.rect.h - src.rect.h) };
    const issues = [];
    if (src.style && ['heading', 'text', 'button'].includes(src.kind)) {
      if (Math.abs(m.style.fontSize - src.style.fontSize) > 0.5) issues.push(`font-size ${src.style.fontSize}→${m.style.fontSize}`);
      if (String(m.style.fontWeight) !== String(src.style.fontWeight)) issues.push(`weight ${src.style.fontWeight}→${m.style.fontWeight}`);
      if (src.style.color && rgbHex(m.style.color) !== src.style.color.slice(0, 7)) issues.push(`color ${src.style.color}→${rgbHex(m.style.color)}`);
    }
    elements.push({ key, kind: src.kind, widget: src.widgetType, text: src.text, ...d, issues });
  }

  // Lost content: reference text runs / media with no counterpart in the Elementor page.
  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const outText = norm(outInv.filter((i) => i.type === 'text').map((i) => i.text).join(' '));
  const lost = [];
  if (!designOnly) {
    for (const r of refInv.filter((i) => i.type === 'text')) if (!outText.includes(norm(r.text))) lost.push({ type: 'text', text: r.text.slice(0, 80), y: Math.round(r.y) });
  }
  const media = (inv) => inv.filter((i) => i.type !== 'text');
  for (const r of media(refInv)) {
    const hit = media(outInv).some((o) => Math.abs(o.x - r.x) < 40 && Math.abs(o.y - r.y) < 120 && Math.abs(o.w - r.w) < 40 && Math.abs(o.h - r.h) < 40);
    if (!hit) lost.push({ type: r.type, box: [r.x, r.y, r.w, r.h].map(Math.round) });
  }

  const off = (e, t) => !e.missing && (Math.abs(e.dx) > t || Math.abs(e.dy) > t || Math.abs(e.dw) > t || Math.abs(e.dh) > t);
  const report = {
    input, wpPage, width,
    pixelMatch: Number(diff.match.toFixed(4)),
    heights: { reference: diff.heightA, elementor: diff.heightB },
    elements: elements.length,
    missingInRender: elements.filter((e) => e.missing).length,
    offBy4px: elements.filter((e) => off(e, 4)).length,
    offBy16px: elements.filter((e) => off(e, 16)).length,
    styleIssues: elements.filter((e) => e.issues?.length).length,
    lostContent: lost.length,
    lost,
    worst: [...elements].filter((e) => !e.missing).sort((a, b) => (Math.abs(b.dy) + Math.abs(b.dh) + Math.abs(b.dx) + Math.abs(b.dw)) - (Math.abs(a.dy) + Math.abs(a.dh) + Math.abs(a.dx) + Math.abs(a.dw))).slice(0, 20),
    details: elements,
    notes: result.notes,
  };
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1));
  const { details, worst, lost: l, ...summary } = report;
  console.log(JSON.stringify(summary, null, 1));
  console.log('worst:', worst.slice(0, 8).map((e) => `${e.key} ${e.widget} "${(e.text || '').slice(0, 30)}" dx${e.dx} dy${e.dy} dw${e.dw} dh${e.dh} ${e.issues.join('; ')}`).join('\n  '));
  if (l.length) console.log('lost:', l.slice(0, 12).map((x) => JSON.stringify(x)).join('\n  '));
}

main().catch((e) => { console.error(e); process.exit(1); });
