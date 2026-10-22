import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convert } from '../src/convert.js';
import { validateTemplate } from '../src/elementor/validate.js';

const walk = (els, fn) => els.forEach((el) => { fn(el); walk(el.elements, fn); });
const all = (template) => {
  const out = [];
  walk(template.content, (el) => out.push(el));
  return out;
};
const widgets = (template) => all(template).filter((el) => el.elType === 'widget');
// The container whose direct children include a widget matching the test.
const parentOf = (template, pred) => all(template).find((el) => el.elements.some(pred));

const page = `<!doctype html><html><head><style>
  body { margin: 0; font-family: Arial, sans-serif; font-size: 16px; line-height: 24px; color: #222; }
  .wrap { width: 800px; margin: 0 auto 40px; padding: 20px; background: #f4f4f4; }
  nav { display: flex; gap: 24px; }
  nav a { color: #333; text-decoration: none; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  .burger { width: 40px; height: 40px; border: 0; background: #fff; padding: 10px; display: flex; flex-direction: column; justify-content: space-between; }
  .burger span { display: block; height: 3px; background: #222; }
  .eyebrow { display: flex; align-items: center; gap: 12px; color: #c60; font-size: 14px; margin: 0 0 8px; }
  .eyebrow::before { content: ""; width: 24px; height: 2px; background: #c60; }
  .ttl { margin: 0 0 8px; font-size: 14px; }
  .ttl::before { content: ""; display: block; width: 40px; height: 3px; background: #06c; margin-bottom: 10px; }
  .ul a { color: #06c; text-decoration: none; border-bottom: 2px solid #06c; }
  .lbl { background: #036; color: #fff; padding: 3px 8px; font-size: 12px; }
  .ring { list-style: none; padding: 0; margin: 0; }
  .ring li::before { content: ""; display: inline-block; width: 8px; height: 8px; border: 2px solid #c00; border-radius: 50%; margin-right: 10px; vertical-align: middle; }
  .review { padding: 120px 0; }
  blockquote { position: relative; width: 700px; margin: 0 auto; text-align: center; }
  blockquote::before { content: '\\201C'; position: absolute; top: -78px; left: 50%; transform: translateX(-50%); font-family: Georgia, serif; font-size: 180px; line-height: 1; color: #c4552d; opacity: .16; }
  blockquote p { position: relative; font: italic 34px/1.45 Georgia, serif; margin: 0 0 32px; }
</style></head><body>
  <div class="wrap"><nav><a href="/about">About</a><a href="/blog">Blog</a><a href="/contact">Contact</a></nav></div>
  <div class="wrap"><h3 style="margin:0">Card</h3><a href="/more" style="display:block;color:#06c">Read more</a><p>after</p></div>
  <div class="wrap" style="display:flex;gap:20px;align-items:center">
    <button style="width:40px;height:40px;border:0;background:#eee;padding:0"><svg width="20" height="20" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="#000" stroke-width="2"/></svg><span class="sr-only">Close dialog</span></button>
    <button class="burger"><span></span><span></span><span></span></button>
    <p style="margin:0">After buttons</p>
  </div>
  <div class="wrap">
    <p class="eyebrow">Our services</p>
    <h2 style="margin:0 0 16px">Heading</h2>
    <p class="ttl">Section title with bar above</p>
    <p class="ul">Read the <a href="/docs">documentation</a> for details.</p>
    <span class="lbl">Label inline</span>
    <h3 style="margin:8px 0">After label</h3>
  </div>
  <div class="wrap"><ul class="ring"><li><a href="/a">First link</a></li><li><a href="/b">Second link</a></li><li><a href="/c">Third link</a></li></ul></div>
  <section class="review"><blockquote><p>The kind of place you want to keep to yourself.</p><footer>Marta</footer></blockquote></section>
</body></html>`;

test('inline pieces keep their links, glyphs, bars, borders, label height, ring bullets and quote marks', async () => {
  const { template } = await convert({ type: 'html', html: page, baseUrl: 'https://example.com/' }, { keepText: true, keepImages: true });
  assert.deepEqual(validateTemplate(template), []);
  const ws = widgets(template);
  const text = (re) => ws.find((w) => w.widgetType === 'text-editor' && re.test(w.settings.editor));

  // Links shown as blocks (flex nav items, a display:block link) keep their link, in their own colour.
  assert.match(text(/About/).settings.editor, /^<p><a href="https:\/\/example\.com\/about" style="color:#333333;text-decoration:none">About<\/a><\/p>$/);
  assert.match(text(/Read more/).settings.editor, /<a href="https:\/\/example\.com\/more" style="color:#0066CC;text-decoration:underline">Read more<\/a>/);

  // An icon button with a screen-reader label stays an icon; drawn bars become the menu icon.
  const icons = ws.filter((w) => w.widgetType === 'icon').map((w) => w.settings.selected_icon.value);
  assert.deepEqual(icons, ['fas fa-times', 'fas fa-bars']);
  assert.ok(!ws.some((w) => w.widgetType === 'button'), 'no text buttons for glyph-only buttons');

  // A flex eyebrow: the bar sits at the row's start and the flex gap is the space before the words.
  const eyebrow = parentOf(template, (c) => c.widgetType === 'text-editor' && /Our services/.test(c.settings.editor));
  assert.equal(eyebrow.settings.flex_direction, 'row');
  assert.equal(eyebrow.settings.flex_gap.column, '12');
  assert.equal(eyebrow.elements[0].settings.margin.left, '0');

  // A block bar above the words stays above them, with its own spacing.
  const titled = parentOf(template, (c) => c.widgetType === 'text-editor' && /Section title/.test(c.settings.editor));
  assert.equal(titled.settings.flex_direction, 'column');
  assert.equal(titled.elements[0].settings.width.size, 40);
  assert.equal(titled.elements[0].settings.min_height.size, 3);
  assert.equal(titled.elements[1].settings._margin.top, '10');

  // A border-bottom underline stays on the bottom edge.
  const underline = text(/documentation/).settings.editor;
  assert.match(underline, /border-bottom:2px solid #0066CC/);
  assert.doesNotMatch(underline, /border:/);

  // An inline label keeps the height of its drawn box: 3px padding around 12px type is 20px.
  const label = parentOf(template, (c) => c.widgetType === 'text-editor' && /Label inline/.test(c.settings.editor));
  const lt = label.elements[0].settings;
  assert.equal(label.settings.min_height.size, 20);
  assert.ok(Number(lt.typography_line_height.size) * lt.typography_font_size.size <= 14.5, 'label text line fits its box');

  // Hollow ring bullets: Font Awesome's outlined circle in the border colour, border included in the size.
  const rings = ws.find((w) => w.widgetType === 'icon-list');
  assert.ok(rings.settings.icon_list.every((it) => it.selected_icon.value === 'far fa-circle'));
  assert.equal(rings.settings.icon_color, '#CC0000');
  assert.equal(rings.settings.icon_size.size, 12);

  // The large decorative quote mark is a placed text widget, faded by its opacity.
  const quote = text(/“/);
  assert.ok(quote, 'quote mark converted');
  assert.equal(quote.settings._position, 'absolute');
  assert.equal(quote.settings.typography_font_size.size, 180);
  // 78px above the quote, which starts below the section's 120px padding; centred by its translate(-50%).
  assert.equal(quote.settings._offset_y.size, 42);
  assert.ok(Math.abs(quote.settings._offset_x.size + quote.settings._element_custom_width.size / 2 - 720) <= 1);
  assert.match(quote.settings.text_color, /^#C4552D[0-9A-F]{2}$/);
});

test('in design-only mode block links point to # and the quote mark stays', async () => {
  const { template } = await convert({ type: 'html', html: page, baseUrl: 'https://example.com/' }, {});
  assert.deepEqual(validateTemplate(template), []);
  const editors = widgets(template).filter((w) => w.widgetType === 'text-editor').map((w) => w.settings.editor);
  assert.ok(editors.filter((e) => /^<p><a href="#" style="color:#333333;text-decoration:none">/.test(e)).length === 3, 'nav links are placeholders');
  assert.ok(!editors.some((e) => /Close dialog/.test(e)));
  assert.ok(editors.includes('<p>“</p>'));
});
