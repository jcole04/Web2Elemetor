import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { convert } from '../src/convert.js';
import { validateTemplate } from '../src/elementor/validate.js';
import { assertPublicUrl } from '../src/extract/dom.js';
import { resolveFont } from '../src/fonts.js';

const html = readFileSync(new URL('./fixtures/landing.html', import.meta.url), 'utf8');
const walk = (els, fn) => els.forEach((el) => { fn(el); walk(el.elements, fn); });

test('HTML converts to a valid Elementor template with measured styles', async () => {
  const { template, fonts } = await convert({ type: 'html', html }, { keepText: true, keepImages: true });
  assert.deepEqual(validateTemplate(template), []);
  assert.equal(template.version, '0.4');
  assert.equal(template.type, 'page');
  assert.equal(template.content.length, 4, 'header, hero, features, footer');

  const widgets = [];
  walk(template.content, (el) => el.elType === 'widget' && widgets.push(el));
  const h1 = widgets.find((w) => w.widgetType === 'heading' && w.settings.header_size === 'h1');
  assert.equal(h1.settings.title, 'Build faster with Acme');
  assert.equal(h1.settings.typography_font_family, 'Poppins');
  assert.equal(h1.settings.typography_font_size.size, 56);
  assert.equal(h1.settings.typography_font_weight, '800');
  assert.equal(h1.settings.title_color, '#FFFFFF');

  const btn = widgets.find((w) => w.widgetType === 'button');
  assert.equal(btn.settings.background_color, '#F59E0B');
  assert.equal(btn.settings.border_radius.top, '8');

  const hero = template.content[1].settings;
  assert.equal(hero.background_background, 'gradient');
  assert.equal(hero.background_color, '#4F46E5');
  assert.equal(hero.background_color_b, '#06B6D4');

  const cards = template.content[2];
  assert.equal(cards.settings.container_type, 'grid', 'CSS grid becomes an Elementor grid container');
  assert.equal(cards.settings.grid_columns_grid.size, 3);
  assert.equal(cards.elements.length, 3);
  // A one-colour SVG swatch with a circular crop is drawn natively: a container with
  // that background, crop included (no HTML widget).
  assert.equal(widgets.filter((w) => w.widgetType === 'html').length, 0);
  const swatch = cards.elements[1].elements[0];
  assert.equal(swatch.elType, 'container');
  assert.equal(swatch.settings.background_color, '#06B6D4');
  assert.equal(swatch.settings.width.size, 48);
  assert.deepEqual([swatch.settings.border_radius.unit, swatch.settings.border_radius.top], ['%', '50']);
  assert.ok(fonts.includes('Inter'), 'Helvetica Neue is swapped for a free look-alike');
});

test('by default the source text and images are not copied', async () => {
  const { template, notes } = await convert({ type: 'html', html }, {});
  const text = JSON.stringify(template);
  assert.ok(!text.includes('Build faster with Acme'));
  assert.ok(!text.includes('data:image'));
  assert.ok(!text.includes('<svg'), 'source artwork is not copied');
  assert.ok(notes.some((n) => /placeholder text/.test(n)));
});

test('links to private addresses are refused', async () => {
  await assert.rejects(assertPublicUrl('http://127.0.0.1:8080/'), /private or local/);
  await assert.rejects(assertPublicUrl('file:///etc/passwd'), /http and https/);
});

test('commercial fonts get a free stand-in with a licence note', () => {
  const f = resolveFont('"Proxima Nova", sans-serif');
  assert.equal(f.family, 'Montserrat');
  assert.match(f.note, /commercial/);
  assert.equal(resolveFont('Roboto, sans-serif').note, null);
});
