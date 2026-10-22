import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { layoutFromVisionResult, sampleColours } from '../src/extract/vision.js';
import { applyCopyrightMode } from '../src/copyright.js';
import { buildTemplate } from '../src/elementor/build.js';
import { validateTemplate } from '../src/elementor/validate.js';

const node = (o) => ({
  parent: null, page: 1, direction: 'column', text: '', headingLevel: null, fontFamily: null, fontSize: null, fontWeight: null,
  lineHeight: null, letterSpacing: 0, uppercase: false, italic: false, textColor: null, textAlign: 'left', backgroundColor: null,
  gradient: null, hasBackgroundImage: false, borderColor: null, borderWidth: 0, borderRadius: 0, shadow: false, padding: [0, 0, 0, 0], iconName: null, value: null, ...o,
});

// A response shaped like Claude's structured output for a simple hero + two columns.
const result = {
  title: 'Sample',
  pageWidthPx: 1440,
  pageHeights: [900],
  pageBackground: '#FFFFFF',
  nodes: [
    node({ id: 'hero', kind: 'container', x: 0, y: 0, w: 100, h: 50, backgroundColor: '#112233', padding: [80, 150, 80, 150] }),
    node({ id: 'h', parent: 'hero', kind: 'heading', x: 10.4, y: 10, w: 79, h: 8, text: 'Hello world', headingLevel: 1, fontFamily: 'Montserrat', fontSize: 48, fontWeight: 700, textColor: '#FFFFFF', textAlign: 'center' }),
    node({ id: 'b', parent: 'hero', kind: 'button', x: 44, y: 30, w: 12, h: 6, text: 'Go', backgroundColor: '#FF6600', textColor: '#000000', borderRadius: 6, padding: [12, 24, 12, 24] }),
    node({ id: 'cols', kind: 'container', direction: 'row', x: 10, y: 55, w: 80, h: 40 }),
    node({ id: 'c1', parent: 'cols', kind: 'text', x: 10, y: 56, w: 38, h: 10, text: 'Left column', fontSize: 16 }),
    node({ id: 'c2', parent: 'cols', kind: 'image', x: 52, y: 56, w: 38, h: 30 }),
  ],
};

test('vision layout becomes a valid template with placeholders', () => {
  const tree = layoutFromVisionResult(result);
  applyCopyrightMode(tree, {});
  const { template } = buildTemplate(tree, {});
  assert.deepEqual(validateTemplate(template), []);
  assert.equal(template.content.length, 2);
  assert.equal(template.content[0].settings.background_color, '#112233');
  assert.equal(template.content[1].settings.flex_direction, 'row');
  assert.match(JSON.stringify(template), /placehold\.co\/547x270\.png/);
});

test('colours are sampled from real pixels', async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 400, height: 200 } });
  await page.setContent('<body style="margin:0"><div style="width:400px;height:200px;background:#3366CC;color:#FFEE00;font:bold 60px Arial">Text</div></body>');
  const png = await page.screenshot();
  await browser.close();
  const out = await sampleColours(png, 'image/png', [{ id: 'a', x: 0, y: 0, w: 100, h: 100 }], 400, 200);
  assert.equal(out.a.bg, '#3366CC');
  assert.equal(out.a.fg, '#FFEE00');
});

test('icons, ratings, progress bars, videos and maps from screenshots use native widgets', () => {
  const res = {
    title: 'Widgets', pageWidthPx: 1440, pageHeights: [900], pageBackground: '#FFFFFF',
    nodes: [
      node({ id: 's', kind: 'container', x: 0, y: 0, w: 100, h: 100, padding: [40, 40, 40, 40] }),
      node({ id: 'i', parent: 's', kind: 'icon', x: 3, y: 5, w: 2, h: 3, iconName: 'phone', textColor: '#0EA5E9' }),
      node({ id: 'f', parent: 's', kind: 'icon', x: 3, y: 10, w: 2, h: 3, iconName: 'facebook-f', textColor: '#111111' }),
      node({ id: 'r', parent: 's', kind: 'rating', x: 3, y: 15, w: 8, h: 2, value: 4.5, textColor: '#F59E0B' }),
      node({ id: 'p', parent: 's', kind: 'progress', x: 3, y: 20, w: 40, h: 1, value: 72, textColor: '#4F46E5', backgroundColor: '#E5E7EB', borderRadius: 6 }),
      node({ id: 'v', parent: 's', kind: 'video', x: 3, y: 25, w: 40, h: 30 }),
      node({ id: 'm', parent: 's', kind: 'map', x: 3, y: 60, w: 40, h: 30, text: 'Eiffel Tower, Paris' }),
      node({ id: 'b', parent: 's', kind: 'button', x: 50, y: 5, w: 10, h: 5, text: 'Next', iconName: 'arrow-right', backgroundColor: '#111111', textColor: '#FFFFFF' }),
    ],
  };
  const tree = layoutFromVisionResult(res);
  applyCopyrightMode(tree, { keepText: true });
  const { template } = buildTemplate(tree, {});
  assert.deepEqual(validateTemplate(template), []);
  const widgets = [];
  const walk = (els) => els.forEach((el) => { if (el.elType === 'widget') widgets.push(el); walk(el.elements); });
  walk(template.content);
  const types = widgets.map((w) => w.widgetType);
  for (const t of ['icon', 'rating', 'progress', 'video', 'google_maps', 'button']) assert.ok(types.includes(t), `${t} widget`);
  assert.ok(!types.includes('html'), 'nothing falls back to code');
  const icons = widgets.filter((w) => w.widgetType === 'icon');
  assert.match(icons[0].settings.selected_icon.value, /^fas fa-phone/);
  assert.equal(icons[1].settings.selected_icon.value, 'fab fa-facebook-f');
  assert.equal(widgets.find((w) => w.widgetType === 'rating').settings.rating_value, 4.5);
  assert.equal(widgets.find((w) => w.widgetType === 'progress').settings.percent.size, 72);
  assert.equal(widgets.find((w) => w.widgetType === 'google_maps').settings.address, 'Eiffel Tower, Paris');
  assert.equal(widgets.find((w) => w.widgetType === 'button').settings.selected_icon.value, 'fas fa-arrow-right');
});
