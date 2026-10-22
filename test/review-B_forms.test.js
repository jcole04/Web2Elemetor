import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convert } from '../src/convert.js';
import { validateTemplate } from '../src/elementor/validate.js';

const walk = (els, fn) => els.forEach((el) => { fn(el); walk(el.elements, fn); });
const widgets = (template) => {
  const out = [];
  walk(template.content, (el) => el.elType === 'widget' && out.push(el));
  return out;
};
const containers = (template) => {
  const out = [];
  walk(template.content, (el) => el.elType === 'container' && out.push(el));
  return out;
};

const page = `<!doctype html><html><head><style>
  body { margin: 0; font: 16px/1.5 Arial, sans-serif; color: #222; }
  main { width: 800px; margin: 0 auto; padding: 40px 0; }
  .card { background: #f7f2e9; padding: 40px; border-radius: 10px; box-shadow: 0 20px 40px -20px rgba(0, 0, 0, 0.4); }
  .card h3 { margin: 0 0 24px; font-size: 28px; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .row3 { display: grid; grid-template-columns: 1.3fr 1fr 1fr; gap: 20px; }
  .placed { display: grid; grid-template-columns: 200px 400px; gap: 10px; }
  .placed .wide { grid-column: 1 / 3; }
  label { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
  input { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 4px; }
  .send { padding: 14px 30px; background: #c2532b; color: #fff; border: 0; }
  .note { margin: 16px 0 0; font-size: 13px; text-align: center; }
  table { border-collapse: collapse; width: 100%; margin-top: 40px; }
  td, th { padding: 8px; border-bottom: 1px solid #ddd; }
  tbody tr:nth-child(odd) > td { box-shadow: inset 0 0 0 9999px rgba(0, 0, 0, 0.05); }
  td.photo { background: url(img/cover.jpg) center / cover; }
  .search { width: 300px; background: #fff url(img/logo.svg) no-repeat 8px center; background-size: 20px 20px; }
  .art { display: block; margin-top: 40px; }
</style></head><body><main>
<form class="card">
  <h3>Book a table</h3>
  <div class="row"><label>Name<input type="text" placeholder="Ana Ferreira"></label><label>Email<input type="email" value="ana@example.com"></label></div>
  <div class="row3"><label>Date<input type="date" value="2026-11-14"></label><label>Time<input type="time" value="19:30"></label><label>Guests<input type="number" value="2"></label></div>
  <div class="placed"><label class="wide">Notes<input type="text"></label><label>Colour<input type="color" value="#2a9d8f"></label><label>Level<input type="range" value="20"></label></div>
  <button class="send" type="submit">Request reservation</button>
  <p class="note">We confirm every booking by email within two hours.</p>
</form>
<table>
  <thead><tr><th>Course</th><th>Badge</th><th>Picture</th></tr></thead>
  <tbody>
    <tr><td>Pomegranate tartare</td><td><svg role="img" aria-label="Zanzibar award badge" id="Zanzibar_Logo" data-name="Zanzibar Logo" width="90" height="40" viewBox="0 0 90 40"><defs><linearGradient id="g1"><stop offset="0" stop-color="#e63946"/><stop offset="1" stop-color="#2a9d8f"/></linearGradient></defs><rect width="40" height="40" fill="url(#g1)"/><circle cx="65" cy="20" r="18" fill="#2a9d8f"/></svg></td><td class="photo"></td></tr>
    <tr><td>Lamb shoulder</td><td>Yes</td><td>Kumquat</td></tr>
  </tbody>
</table>
<form style="margin-top:40px"><input class="search" type="search" placeholder="Search recipes"></form>
<svg class="art" width="600" height="200" viewBox="0 0 600 200"><rect width="300" height="200" fill="#e63946"/><circle cx="450" cy="100" r="90" fill="#2a9d8f"/></svg>
</main></body></html>`;

const source = { type: 'html', html: page, baseUrl: 'https://example.com/' };
const owned = convert(source, { keepText: true, keepImages: true });
const design = convert(source, {});
const formHtml = (all) => all.find((w) => w.widgetType === 'html' && /type="date"/.test(w.settings.html)).settings.html;
const tableHtml = (all) => all.find((w) => w.widgetType === 'text-editor' && /<table/.test(w.settings.editor)).settings.editor;

test('a form card becomes a container with native heading and note around a smaller form widget', async () => {
  const { template } = await owned;
  assert.deepEqual(validateTemplate(template), []);
  const all = widgets(template);
  const html = formHtml(all);
  assert.ok(!/Book a table|We confirm/.test(html), 'heading and note are not in the code');
  assert.ok(!/background-color:rgb\(247, 242, 233\)|box-shadow:rgba|padding:40px/.test(html), 'the card look is not in the code');
  assert.ok(all.some((w) => w.widgetType === 'heading' && w.settings.title === 'Book a table'));
  assert.ok(all.some((w) => w.widgetType === 'text-editor' && /We confirm every booking/.test(w.settings.editor)));
  const card = containers(template).find((c) => c.settings.background_color === '#F7F2E9');
  assert.ok(card, 'the card is a container');
  assert.equal(card.settings.padding.top, '40');
  assert.equal(card.settings.border_radius.top, '10');
  assert.equal(card.settings.box_shadow_box_shadow_type, 'yes');
  const kinds = card.elements.map((e) => e.widgetType);
  assert.deepEqual(kinds, ['heading', 'html', 'text-editor']);
});

test('form rows wrap on phones instead of keeping desktop pixel widths', async () => {
  const html = formHtml(widgets((await owned).template));
  // Rows of fields that fill the form become wrapping flex rows: each field keeps its desktop width as a basis.
  assert.match(html, /display:flex;flex-wrap:wrap;gap:20px/);
  assert.match(html, /flex:1 1 350px/);
  assert.match(html, /flex:1 1 206px/);
  // Fields that fill their box stay that wide on any screen.
  for (const type of ['text" placeholder="Ana Ferreira', 'email', 'date', 'time', 'number']) {
    assert.match(html, new RegExp(`<input type="${type}"[^>]*style="[^"]*;width:100%;`), type);
  }
  // A grid that can't wrap (a field spans two columns) keeps its tracks, which may still shrink, and so may its fields.
  assert.match(html, /grid-template-columns:minmax\(0,200px\) minmax\(0,400px\)/);
  assert.match(html, /grid-column:1 \/ 3/);
  assert.match(html, /<input type="color"[^>]*style="[^"]*;width:200px;max-width:100%/);
  // The button keeps its own width but can shrink.
  assert.match(html, /<button type="submit" style="[^"]*max-width:100%/);
  const all = widgets((await owned).template);
  const search = all.find((w) => w.widgetType === 'html' && /type="search"/.test(w.settings.html)).settings.html;
  assert.match(search, /style="width:300px;max-width:100%/);
  // Wide SVG artwork shrinks with its column and keeps its shape.
  const art = all.find((w) => w.widgetType === 'html' && /<svg[^>]*width="600"/.test(w.settings.html));
  assert.match(art.settings.html, /<svg style="max-width:100%;height:auto;aspect-ratio:600\/200"/);
});

test('tables keep only declarations that change the look, and stripes become background colours', async () => {
  const html = tableHtml(widgets((await owned).template));
  assert.ok(!/9999px|box-shadow/.test(html), 'no inset-shadow stripes');
  assert.match(html, /<td style="[^"]*background-color:rgba\(0, 0, 0, 0\.05\)[^"]*">Pomegranate tartare/);
  assert.match(html, /<td style="[^"]*background-color:rgba\(0, 0, 0, 0\)[^"]*">Lamb shoulder/);
  for (const noop of ['box-sizing:border-box', 'outline:', 'list-style-type', 'white-space:normal', 'border-spacing', 'border-top:0px']) {
    assert.ok(!html.includes(noop), `no ${noop}`);
  }
  // Theme borders on cells are still reset, in one short declaration per side.
  assert.match(html, /<td style="[^"]*border-top:0;border-right:0;border-bottom:1px solid rgb\(221, 221, 221\);border-left:0/);
  assert.ok(!/<(tr|tbody|thead)\b[^>]*style=/.test(html), 'rows and row groups need no styling');
});

test('by default form and table code carries no source images, artwork or words', async () => {
  const { template, notes } = await design;
  assert.deepEqual(validateTemplate(template), []);
  const text = JSON.stringify(template);
  for (const leak of ['img/cover.jpg', 'img/logo.svg', '<svg', 'Zanzibar', 'Ana Ferreira', 'ana@example.com', 'Pomegranate']) {
    assert.ok(!text.includes(leak), `no ${leak}`);
  }
  assert.ok(notes.some((n) => /Photos and logos were replaced/.test(n)));
  const all = widgets(template);
  const table = tableHtml(all);
  assert.match(table, /<img src="https:\/\/placehold\.co\/90x40\.png" alt="" width="90" height="40">/);
  assert.match(table, /background-image:url\(https:\/\/placehold\.co\/\d+x\d+\.png\)/);
  const search = all.find((w) => w.widgetType === 'html' && /type="search"/.test(w.settings.html)).settings.html;
  assert.match(search, /background-image:url\(https:\/\/placehold\.co\/20x20\.png\)/);
});

test('by default typed field values (dates, times, numbers, colours) are kept, not swapped for words', async () => {
  const html = formHtml(widgets((await design).template));
  assert.match(html, /type="date" value="2026-11-14"/);
  assert.match(html, /type="time" value="19:30"/);
  assert.match(html, /type="number" value="2"/);
  assert.match(html, /type="color" value="#2a9d8f"/);
  assert.match(html, /type="range" value="20"/);
  assert.match(html, /type="email" value="[A-Z][a-z]/, 'words in a text-like field are still swapped');
});

test('owned artwork with placeholder text keeps its drawing but not its names', async () => {
  const { template } = await convert(source, { keepText: false, keepImages: true });
  const table = tableHtml(widgets(template));
  assert.match(table, /<svg\b/);
  assert.ok(!/Zanzibar|data-name/.test(table), 'no names in labels, ids or data attributes');
  assert.match(table, /aria-label="[A-Z][a-z]/);
  // Renamed ids still link the gradient to the shape that uses it.
  const id = table.match(/<linearGradient id="([^"]+)"/)[1];
  assert.match(table, new RegExp(`fill="url\\(&quot;#${id}&quot;\\)"`));
});
