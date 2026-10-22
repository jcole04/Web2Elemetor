import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convert } from '../src/convert.js';
import { validateTemplate } from '../src/elementor/validate.js';
import { renderPreview } from '../src/elementor/preview.js';

const walk = (els, fn) => els.forEach((el) => { fn(el); walk(el.elements, fn); });
const all = (template) => {
  const out = [];
  walk(template.content, (el) => out.push(el));
  return out;
};
const run = async (html) => {
  const { template } = await convert({ type: 'html', html, baseUrl: 'https://example.com/' }, { keepText: true, keepImages: true });
  assert.deepEqual(validateTemplate(template), []);
  return template;
};
const head = 'body{margin:0;font-family:Arial,sans-serif;font-size:16px;line-height:24px;color:#222}';

test('a wrapping row whose lines touch (no row gap) stays a wrapping row', async () => {
  const card = (t) => `<div class="col"><div class="card"><h4 style="margin:0">${t}</h4><p>Card ${t}</p></div></div>`;
  const template = await run(`<!doctype html><html><head><style>${head}
    .container{width:960px;margin:0 auto;padding:0 12px}
    .row{display:flex;flex-wrap:wrap;margin:0 -12px}
    .col{flex:0 0 auto;width:33.3333%;padding:0 12px;box-sizing:border-box}
    .card{background:#fff;border:1px solid #ddd;padding:16px;box-sizing:border-box;height:150px}
  </style></head><body><div class="container"><h2>Grid</h2><div class="row">${['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map(card).join('')}</div></div></body></html>`);
  const row = all(template).find((el) => el.elType === 'container' && el.settings.flex_direction === 'row');
  assert.ok(row, 'the cards share one row container');
  assert.equal(row.settings.flex_wrap, 'wrap');
  assert.equal(row.settings.flex_gap.row, '0');
  assert.equal(row.elements.length, 6);
  // No item is pulled back under the first line with a negative margin.
  for (const col of row.elements) assert.ok(Number(col.settings.margin.left) >= 0, `left margin ${col.settings.margin.left}`);
});

test('a narrow image and button in a centred article column keep their width and side', async () => {
  const template = await run(`<!doctype html><html><body style="margin:0;font-family:Arial;font-size:16px;line-height:24px">
    <main style="max-width:720px;margin:0 auto;padding:24px">
      <h1>Article title</h1><p>Intro paragraph text for the article.</p>
      <img src="https://example.com/photo.jpg" width="300" height="200" alt="Photo" style="display:block">
      <p>More text after the photo.</p>
      <a href="/btn" style="display:inline-block;background:#06c;color:#fff;padding:10px 20px;text-decoration:none">Call to action</a>
    </main></body></html>`);
  const section = (type) => template.content.find((s) => s.elements.some((el) => el.widgetType === type));
  const imgSection = section('image');
  assert.equal(imgSection.settings.content_width, 'boxed');
  assert.equal(imgSection.settings.boxed_width.size, 720);
  const img = imgSection.elements[0];
  assert.deepEqual([img.settings.width.size, img.settings.width.unit], [300, 'px']);
  assert.equal(img.settings.align, 'start');
  const btnSection = section('button');
  assert.equal(btnSection.settings.content_width, 'boxed');
  assert.equal(btnSection.elements[0].settings.align, 'left');
});

test('stars in a stretched flex row are padded by their line box, not the row height', async () => {
  const template = await run(`<!doctype html><html><head><style>${head}
    .wrap{width:800px;margin:0 auto;padding:20px;background:#f4f4f4;display:flex;gap:16px}
    .stars{color:#f90;font-size:16px;letter-spacing:2px}
  </style></head><body><div class="wrap"><img src="https://example.com/av.jpg" width="64" height="120" alt="av"><div><strong>Jane</strong><div>Role</div></div><div class="stars" aria-label="Rated 4 out of 5">★★★★☆</div></div></body></html>`);
  const rating = all(template).find((el) => el.widgetType === 'rating');
  assert.ok(rating);
  // A 24px line around 16px stars: 4px above and below, so they sit at the top of the 120px row like the source.
  assert.deepEqual([rating.settings._padding.top, rating.settings._padding.bottom], ['4', '4']);
});

test('stars in a box taller than their line keep the extra height below them', async () => {
  const template = await run(`<!doctype html><html><head><style>${head}</style></head><body><div style="width:800px;margin:0 auto">
    <div style="color:#f90;font-size:16px;line-height:30px;height:60px" aria-label="Rated 3 out of 5">★★★☆☆</div><p style="margin:0">After the stars</p></div></body></html>`);
  const rating = all(template).find((el) => el.widgetType === 'rating');
  assert.deepEqual([rating.settings._padding.top, rating.settings._padding.bottom], ['7', '37']);
});

test('an absolutely placed box keeps its narrower content centred', async () => {
  const template = await run(`<!doctype html><html><head><style>${head}
    .wrap{width:800px;margin:0 auto;padding:20px;background:#ddd;position:relative;height:140px}
    .ov{position:absolute;left:100px;top:10px;width:600px;height:100px;background:#fff}
    .ov .inner{max-width:300px;margin:0 auto}
  </style></head><body><div class="wrap"><div class="ov"><div class="inner"><p style="margin:0">Overlay centred text inside a narrower box</p><p style="margin:0">Second line</p></div></div></div></body></html>`);
  const ov = all(template).find((el) => el.elType === 'container' && el.settings.position === 'absolute');
  assert.ok(ov);
  assert.equal(ov.settings.content_width, 'full');
  assert.equal(ov.settings.width.size, 600);
  assert.deepEqual([ov.settings.padding.left, ov.settings.padding.right], ['150', '150']);
});

test('left margins that place items in a row are dropped on phones, where the row stacks', async () => {
  const template = await run(`<!doctype html><html><head><style>${head}
    .hdr{width:800px;margin:0 auto;padding:20px;background:#f4f4f4;display:flex;align-items:center}
    .cta{margin-left:auto;background:#06c;color:#fff;padding:8px 16px;text-decoration:none;border-radius:4px}
    .box{width:150px;height:40px;background:#cde}
  </style></head><body><div class="hdr"><strong style="font-size:20px">Brand</strong><a href="/x" style="margin-left:24px">Home</a><a href="/y" style="margin-left:24px">Menu</a><a class="cta" href="/book">Book now</a></div>
  <div class="hdr"><div class="box"></div><div class="box" style="margin-left:24px"></div><div class="box" style="margin-left:auto"></div></div></body></html>`);
  const els = all(template);
  const btn = els.find((el) => el.widgetType === 'button');
  assert.ok(Number(btn.settings._margin.left) > 400);
  assert.equal(btn.settings._margin_mobile.left, '0');
  const box = els.find((el) => el.elType === 'container' && Number(el.settings.margin?.left) > 100);
  assert.ok(box, 'the pushed-right box keeps its desktop offset');
  assert.equal(box.settings.margin_mobile.left, '0');
  // The preview's phone rules follow the setting.
  assert.match(renderPreview(template), new RegExp(`\\[data-id="${btn.id}"\\]\\{margin:0px 0px 0px 0px!important\\}`));
});
