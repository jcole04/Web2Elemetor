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

const page = `<!doctype html><html><head><style>
  body { margin: 0; font: 16px/1.5 Arial, sans-serif; color: #222; }
  main { width: 800px; margin: 0 auto; padding: 40px 0; }
  [role=tablist] { display: flex; gap: 4px; border-bottom: 1px solid #ccc; }
  [role=tab] { padding: 8px 16px; border: 0; background: #eee; color: #333; font: 600 15px/1.2 Arial, sans-serif; }
  [role=tab][aria-selected=true] { background: #1f5a3d; color: #fff; }
  [role=tabpanel] { padding: 16px; }
  .acc-item { border: 1px solid #ddd; }
  .acc-item + .acc-item { border-top: 0; }
  .acc-item button { display: block; width: 100%; text-align: left; padding: 12px 16px; border: 0; background: #fff; font: 600 16px/1.2 Arial, sans-serif; color: #111; }
  .acc-panel { padding: 0 16px 12px; }
  .links { list-style: none; margin: 24px 0 0; padding: 0; }
  .links li { margin-bottom: 6px; }
  .links a { color: #1f5a3d; text-decoration: none; }
  .close { width: 24px; height: 24px; border: 0; background: transparent url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='%23000'%3e%3cpath d='M.293.293a1 1 0 0 1 1.414 0L8 6.586 14.293.293a1 1 0 1 1 1.414 1.414L9.414 8l6.293 6.293a1 1 0 0 1-1.414 1.414L8 9.414l-6.293 6.293a1 1 0 0 1-1.414-1.414L6.586 8 .293 1.707a1 1 0 0 1 0-1.414z'/%3e%3c/svg%3e") center/1em auto no-repeat; }
  .crumbs { display: flex; list-style: none; padding: 0; margin: 24px 0 0; }
  .crumbs li + li::before { content: "/"; padding: 0 8px; color: #888; }
</style></head><body><main>
  <div role="tablist">
    <button role="tab" aria-selected="true" aria-controls="p1" id="t1">Light</button>
    <button role="tab" aria-selected="false" aria-controls="p2" id="t2">Water</button>
  </div>
  <div>
    <div role="tabpanel" id="p1"><p>Bright, indirect light suits most plants.</p></div>
    <div role="tabpanel" id="p2" hidden><p>Water when the top soil is dry.</p></div>
  </div>
  <div class="acc" style="margin-top:24px">
    <div class="acc-item"><h3 style="margin:0"><button aria-expanded="true" aria-controls="a1">Shipping</button></h3><div id="a1" class="acc-panel">We ship weekly.</div></div>
    <div class="acc-item"><h3 style="margin:0"><button aria-expanded="false" aria-controls="a2">Returns</button></h3><div id="a2" class="acc-panel" hidden>Thirty days.</div></div>
  </div>
  <ul class="links"><li><a href="/about">About us</a></li><li><a href="/jobs">Careers</a></li><li><a href="/press">Press</a></li></ul>
  <button class="close" type="button" aria-label="Close"></button>
  <ol class="crumbs"><li><a href="/">Home</a></li><li>Shop</li></ol>
</main></body></html>`;

test('tabs, ARIA accordions, link lists and icon-only buttons become native widgets', async () => {
  const { template } = await convert({ type: 'html', html: page, baseUrl: 'https://example.com/' }, { keepText: true, keepImages: true });
  assert.deepEqual(validateTemplate(template), []);
  const all = widgets(template);

  const tabs = all.find((w) => w.widgetType === 'nested-tabs');
  assert.ok(tabs, 'tabs widget');
  assert.deepEqual(tabs.settings.tabs.map((t) => t.tab_title), ['Light', 'Water']);
  assert.equal(tabs.elements.length, 2);
  assert.equal(tabs.settings.breakpoint_selector, 'none');
  assert.equal(tabs.settings.title_text_color_active, '#FFFFFF');
  assert.equal(tabs.settings.tabs_title_background_color_active_color, '#1F5A3D');
  // The hidden second panel is still converted.
  assert.match(JSON.stringify(tabs.elements[1]), /Water when the top soil is dry/);

  const acc = all.find((w) => w.widgetType === 'nested-accordion');
  assert.ok(acc, 'accordion widget');
  assert.deepEqual(acc.settings.items.map((i) => i.item_title), ['Shipping', 'Returns']);
  // Shared edges: the frame sits on the widget and each title keeps only the rule under it.
  assert.equal(acc.settings._border_border, 'solid');
  assert.equal(acc.settings.accordion_border_normal_width.top, '0');

  const list = all.find((w) => w.widgetType === 'icon-list');
  assert.ok(list, 'link list');
  assert.deepEqual(list.settings.icon_list.map((i) => i.text), ['About us', 'Careers', 'Press']);
  assert.deepEqual(list.settings.icon_list[0].selected_icon, { value: '', library: '' });
  assert.equal(list.settings.icon_list[1].link.url, 'https://example.com/jobs');

  const close = all.find((w) => w.widgetType === 'icon');
  assert.equal(close?.settings.selected_icon.value, 'fas fa-times');
  assert.ok(!all.some((w) => w.widgetType === 'button' && /^Button$/.test(w.settings.text)), 'no empty button');

  // The breadcrumb slash drawn by ::before is kept as text.
  assert.ok(all.some((w) => w.widgetType === 'text-editor' && /\/<\/span>Shop/.test(w.settings.editor)));
  assert.ok(!all.some((w) => w.widgetType === 'html'), 'no HTML widgets needed');
});

const article = `<!doctype html><html><head><style>
  body { margin: 0; font: 18px/1.6 Georgia, serif; color: #222; }
  main { width: 700px; margin: 0 auto; padding: 40px 0; }
  p { margin: 0 0 20px; }
  .chart { float: right; width: 200px; height: 240px; margin: 6px 0 16px 24px; border-radius: 8px; }
  .todo { padding-left: 24px; margin: 0 0 20px; }
  .todo > li { margin-bottom: 8px; }
  .todo ul { margin: 6px 0 2px; padding-left: 20px; list-style: circle; }
</style></head><body><main>
  <img class="chart" src="https://example.com/chart.png" alt="Sales chart" width="200" height="240">
  <p>Sales rose in every region this year, and the chart on the right shows how the spring months pulled ahead of the rest.</p>
  <p>Most of the growth came from repeat customers, who ordered more often and stayed longer than in any year before.</p>
  <p>Shipping times fell as well, because the new warehouse opened in March and took over the northern routes from the old one.</p>
  <p style="clear:both">After the chart.</p>
  <ul class="todo">
    <li>Plan the layout
      <ul><li>Same columns</li><li>Same image sizes</li></ul>
    </li>
    <li>Write the copy</li>
  </ul>
</main></body></html>`;

test('a floated image keeps its text wrap and nested lists stay one list', async () => {
  const { template } = await convert({ type: 'html', html: article, baseUrl: 'https://example.com/' }, { keepText: true, keepImages: true });
  assert.deepEqual(validateTemplate(template), []);
  const all = widgets(template);
  assert.ok(!all.some((w) => w.widgetType === 'html'), 'no HTML widgets needed');

  const wrap = all.find((w) => w.widgetType === 'text-editor' && /<img/.test(w.settings.editor));
  assert.ok(wrap, 'image and paragraphs share one Text Editor');
  assert.match(wrap.settings.editor, /^<img class="alignright" src="https:\/\/example\.com\/chart\.png"/);
  assert.match(wrap.settings.editor, /float:right;margin:6px 0px 16px 24px/);
  assert.equal((wrap.settings.editor.match(/<p\b/g) || []).length, 3);
  assert.equal(wrap.settings.paragraph_spacing.size, 20);

  const list = all.find((w) => w.widgetType === 'text-editor' && /Plan the layout/.test(w.settings.editor));
  assert.match(list.settings.editor, /^<ul style="padding-left:24px;margin:0"><li style="margin-bottom:8px">Plan the layout <ul style="margin:6px 0 2px;padding-left:20px;list-style-type:circle">/);
  assert.equal(list.settings._padding, undefined, 'indent is not doubled on the widget');

  const design = await convert({ type: 'html', html: article, baseUrl: 'https://example.com/' }, {});
  const placeholder = widgets(design.template).find((w) => w.widgetType === 'text-editor' && /<img/.test(w.settings.editor));
  assert.match(placeholder.settings.editor, /src="https:\/\/placehold\.co\/200x240\.png" alt=""/);
});
