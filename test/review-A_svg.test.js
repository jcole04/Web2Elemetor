import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { convert } from '../src/convert.js';
import { validateTemplate } from '../src/elementor/validate.js';
import { sanitizeMarkup } from '../src/sanitize.js';

const walk = (els, fn) => els.forEach((el) => { fn(el); walk(el.elements, fn); });
const widgets = (template) => {
  const out = [];
  walk(template.content, (el) => el.elType === 'widget' && out.push(el));
  return out;
};
const own = { keepText: true, keepImages: true };
const run = async (body, opts = own) => {
  const res = await convert({ type: 'html', html: `<!doctype html><html><head><style>body{margin:0;font:16px/1.5 Arial,sans-serif}main{width:800px;margin:0 auto;padding:40px 0}</style></head><body><main>${body}</main></body></html>`, baseUrl: 'https://example.com/' }, opts);
  assert.deepEqual(validateTemplate(res.template), []);
  return res;
};
const dataSvg = (svg) => `data:image/svg+xml,${encodeURIComponent(svg)}`;

// Puts every HTML widget of a template on one page, as WordPress does, and reads
// the fill each picked element ends up with.
async function fillsOnOnePage(htmls, selectors) {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><body>${htmls.map((h) => `<div>${h}</div>`).join('')}</body>`);
    return await page.evaluate((sels) => sels.map((s) => getComputedStyle(document.querySelector(s)).fill), selectors);
  } finally {
    await browser.close();
  }
}

test('SVG pictures in separate HTML widgets keep their own patterns and gradients', async () => {
  const tile = (colour) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><defs><pattern id="ln" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="${colour}"/></pattern></defs><rect id="a-${colour.slice(1)}" width="200" height="100" fill="url(#ln)"/></svg>`;
  const inline = (from, to) => `<svg width="200" height="100" viewBox="0 0 200 100"><defs><linearGradient id="bg"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="200" height="100" fill="url(#bg)"/><circle cx="20" cy="20" r="10" fill="#ffffff"/></svg>`;
  const { template } = await run(`<img src="${dataSvg(tile('#e6d8c0'))}" style="width:200px;height:100px" alt="bread"><img src="${dataSvg(tile('#55603a'))}" style="width:200px;height:100px" alt="olives">${inline('#4a2a2f', '#160b0d')}${inline('#120806', '#8a2f10')}`);
  const art = widgets(template).filter((w) => w.widgetType === 'html').map((w) => w.settings.html);
  assert.equal(art.length, 4);
  const ids = art.map((h) => [...h.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  assert.equal(new Set(ids.flat()).size, ids.flat().length, 'no id is defined twice on the page');
  art.forEach((h, i) => {
    for (const [, ref] of h.matchAll(/url\((?:&quot;|["'])?#([^"'&)]+)/g)) assert.ok(ids[i].includes(ref), `url(#${ref}) points inside its own widget`);
  });
  // Drawn together, each picture still uses its own pattern.
  const patternRect = (i) => `div:nth-child(${i}) pattern rect`;
  const fills = await fillsOnOnePage(art, [patternRect(1), patternRect(2)]);
  assert.deepEqual(fills, ['rgb(230, 216, 192)', 'rgb(85, 96, 58)']);
});

test('<style> rules inside SVG artwork become each shape\'s own colour and the block is dropped', async () => {
  const logo = (a, b) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><style>.cls-1{fill:${a}}.cls-2{fill:${b}}</style><rect class="cls-1" width="60" height="40"/><rect class="cls-2" x="60" width="60" height="40"/></svg>`;
  const { template } = await run(`<img src="${dataSvg(logo('#e11d48', '#0ea5e9'))}" style="width:120px;height:40px" alt="A"><img src="${dataSvg(logo('#16a34a', '#f59e0b'))}" style="width:120px;height:40px" alt="B">
    <svg width="120" height="40" viewBox="0 0 120 40"><style>.st0{fill:#7c3aed} .st1{fill:#f43f5e}</style><rect class="st0" width="60" height="40"/><rect class="st1" x="60" width="60" height="40"/></svg>`);
  const art = widgets(template).filter((w) => w.widgetType === 'html').map((w) => w.settings.html);
  assert.equal(art.length, 3);
  for (const h of art) {
    assert.doesNotMatch(h, /<style/i);
    assert.doesNotMatch(h, /\sclass=/);
  }
  const fills = await fillsOnOnePage(art, ['div:nth-child(1) rect', 'div:nth-child(2) rect', 'div:nth-child(3) rect']);
  assert.deepEqual(fills, ['rgb(225, 29, 72)', 'rgb(22, 163, 74)', 'rgb(124, 58, 237)']);

  // The last line of defence and the validator both refuse <style> in widget markup.
  assert.equal(sanitizeMarkup('<div><style>.a{color:red}</style><p>x</p></div>'), '<div><p>x</p></div>');
  const bad = { ...template, content: [{ id: 'abcdef1', elType: 'widget', widgetType: 'html', isInner: false, settings: { html: '<style>p{}</style>' }, elements: [] }] };
  assert.ok(validateTemplate(bad).some((e) => /<style>/.test(e)));
});

test('a sprite symbol styled by its own <style> keeps its paint without the block', async () => {
  const sprite = '<svg style="display:none"><symbol id="logo" viewBox="0 0 100 40"><style>.k{fill:url(#gr)}</style><defs><linearGradient id="gr"><stop offset="0" stop-color="#e11d48"/><stop offset="1" stop-color="#0ea5e9"/></linearGradient></defs><rect class="k" width="100" height="40"/><circle cx="20" cy="20" r="8" fill="#ffffff"/></symbol></svg>';
  const { template } = await run(`${sprite}<svg width="200" height="80"><use href="#logo"/></svg><svg width="200" height="80"><use href="#logo"/></svg>`);
  const art = widgets(template).filter((w) => w.widgetType === 'html').map((w) => w.settings.html);
  assert.equal(art.length, 2);
  for (const h of art) {
    assert.doesNotMatch(h, /<style|\sclass=/);
    const grad = h.match(/<linearGradient id="([^"]+)"/)[1];
    assert.match(h, new RegExp(`<rect[^>]*fill="url\\(&quot;#${grad}&quot;\\)"`));
  }
});

test('an SVG with its own viewBox is letterboxed, not stretched, by object-fit fill', async () => {
  const twoDots = (attrs) => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><circle cx="50" cy="50" r="50" fill="#0ea5e9"/><circle cx="50" cy="50" r="20" fill="#f43f5e"/></svg>`;
  const { template } = await run(`<img src="${dataSvg(twoDots('viewBox="0 0 100 100"'))}" style="width:240px;height:80px" alt="a">
    <img src="${dataSvg(twoDots('viewBox="0 0 100 100" preserveAspectRatio="xMinYMin meet"'))}" style="width:240px;height:80px" alt="b">
    <img src="${dataSvg(twoDots('width="100" height="100"'))}" style="width:240px;height:80px" alt="c">`);
  const [kept, own, stretched] = widgets(template).filter((w) => w.widgetType === 'html').map((w) => w.settings.html.match(/<svg\b[^>]*>/)[0]);
  assert.doesNotMatch(kept, /preserveAspectRatio/);
  assert.match(own, /preserveAspectRatio="xMinYMin meet"/);
  // Without a viewBox of its own, Chrome stretches the picture to the box.
  assert.match(stretched, /preserveAspectRatio="none"/);
});

test('one-colour artwork uses native widgets; only multi-colour artwork stays in an HTML widget', async () => {
  const chart = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/></svg>';
  const disc = dataSvg('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#4f46e5"/></svg>');
  const flag = '<svg width="24" height="16" viewBox="0 0 24 16"><rect width="12" height="16" fill="#1d4ed8"/><rect x="12" width="12" height="16" fill="#dc2626"/></svg>';
  const body = `<article><div style="display:inline-flex;padding:12px;border-radius:12px;background:#f5f3ff;color:#7c3aed">${chart}</div><h3>Content analytics</h3><p>See which pages get read.</p></article>
    <div><img src="${disc}" alt="fast" style="border-radius:50%"><h3>Fast</h3></div>
    <p>Language: <a href="/fr" style="display:inline-block">${flag}</a></p>`;
  for (const opts of [own, {}]) {
    const { template } = await run(body, opts);
    const all = widgets(template);
    // A stroke chart icon with no close shape match takes its glyph from the card's title.
    const icon = all.find((w) => w.widgetType === 'icon');
    assert.equal(icon?.settings.selected_icon.value, 'fas fa-chart-bar');
    assert.equal(icon.settings.primary_color, '#7C3AED');
    // A plain colour disc is a container with that background and a round crop.
    let swatch = null;
    walk(template.content, (el) => { if (el.elType === 'container' && el.settings.background_color === '#4F46E5') swatch = el; });
    assert.ok(swatch, 'disc container');
    assert.equal(swatch.settings.width.size, 48);
    assert.deepEqual([swatch.settings.border_radius.unit, swatch.settings.border_radius.top], ['%', '50']);
    const html = all.filter((w) => w.widgetType === 'html');
    if (opts === own) {
      // The two-colour flag in an icon-only link is artwork: it stays exact.
      assert.equal(html.length, 1);
      assert.match(html[0].settings.html, /<a href="https:\/\/example\.com\/fr"[^>]*><svg/);
    } else {
      assert.equal(html.length, 0);
    }
  }
});

test('audio players in HTML widgets are listed in the notes', async () => {
  const body = '<audio controls src="https://example.com/media/sample.mp3" style="width:100%">Your browser cannot play audio.</audio>';
  const owned = await run(body);
  assert.match(widgets(owned.template).find((w) => w.widgetType === 'html').settings.html, /<audio[^>]*src="https:\/\/example\.com\/media\/sample\.mp3"/);
  assert.ok(owned.notes.some((n) => /^Audio players were kept in HTML widgets/.test(n)));
  const design = await run(body, {});
  assert.doesNotMatch(widgets(design.template).find((w) => w.widgetType === 'html').settings.html, /\ssrc=/);
  assert.ok(design.notes.some((n) => /Audio players .* without their sound files\. Add a link to your own file/.test(n)));
});
