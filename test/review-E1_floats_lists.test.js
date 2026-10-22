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
const textOf = (el) => {
  let t = '';
  walk([el], (e) => { t += ` ${e.settings?.editor || e.settings?.title || e.settings?.text || ''}`; });
  return t;
};

const floats = `<!doctype html><html><head><style>
  body { margin: 0; font: 16px/24px Arial, sans-serif; color: #222; }
  .wrap { width: 800px; margin: 0 auto 40px; padding: 20px; background: #f4f4f4; display: flow-root; }
  .f3 { float: left; width: 33.333%; box-sizing: border-box; padding: 0 10px; margin-bottom: 20px; }
  .f3 .c { background: #fff; border: 1px solid #ccc; height: 100px; padding: 10px; box-sizing: border-box; }
  .row { display: flex; gap: 20px; }
  .col { float: left; flex: 1; background: #eef; padding: 12px; }
</style></head><body>
<div class="wrap"><div class="f3"><div class="c">Card one</div></div><div class="f3"><div class="c">Card two</div></div><div class="f3"><div class="c">Card three</div></div><div class="f3"><div class="c">Card four</div></div><div class="f3"><div class="c">Card five</div></div><div class="f3"><div class="c">Card six</div></div></div>
<div class="wrap"><div class="row"><div class="col">Alpha col</div><div class="col">Beta col</div><div class="col">Gamma col</div></div></div>
<div class="wrap"><p><img src="https://example.com/p.jpg" width="160" height="120" alt="Post photo" style="float:left;margin:0 16px 8px 0">WordPress style paragraph with a floated image inside the paragraph and a <a href="/l">link</a> and <strong>bold words</strong> continuing for a while so that it wraps around the image on several lines of text here.</p></div>
<div class="wrap"><img src="https://example.com/q.jpg" width="160" height="120" alt="Q" style="float:left;margin:0 16px 8px 0"><div style="background:#fff;border:1px solid #ccc;padding:10px">Box beside float <button>Go</button></div></div>
</body></html>`;

test('float grids and floated flex items stay rows; an image floated in a paragraph stays in its Text Editor', async () => {
  const { template } = await convert({ type: 'html', html: floats, baseUrl: 'https://example.com/' }, { keepText: true, keepImages: true });
  assert.deepEqual(validateTemplate(template), []);
  const els = all(template);
  assert.ok(!els.some((el) => Number((el.settings._margin || el.settings.margin)?.left) < 0), 'nothing is pulled back with a negative margin');

  // The six floated cards are one row of six, not [first card, column of the rest].
  const grid = els.find((el) => el.elType === 'container' && el.elements.length === 6);
  assert.ok(grid, 'one container holds all six cards');
  ['one', 'two', 'three', 'four', 'five', 'six'].forEach((n, i) => assert.match(textOf(grid.elements[i]), new RegExp(`Card ${n}`)));
  assert.equal(grid.settings.flex_direction, 'row');
  assert.equal(grid.settings.flex_wrap, 'wrap');

  // Float has no effect on flex items: the flex row lays them out with its gap.
  const row = els.find((el) => el.elType === 'container' && el.elements.length === 3 && /Alpha col/.test(textOf(el.elements[0])));
  assert.ok(row, 'the flex row keeps its three items side by side');
  assert.match(textOf(row.elements[1]), /Beta col/);
  assert.match(textOf(row.elements[2]), /Gamma col/);
  assert.ok(Math.abs(Number(row.settings.flex_gap.column) - 20) <= 1, 'the row keeps its 20px gap');

  // WordPress's <p><img class="alignleft">words</p>: one Text Editor, the image aligned, links and bold kept.
  const wp = widgets(template).filter((w) => /wraps around the image/.test(textOf(w)));
  assert.equal(wp.length, 1);
  assert.equal(wp[0].widgetType, 'text-editor');
  assert.match(wp[0].settings.editor, /^<p><img class="alignleft" src="https:\/\/example\.com\/p\.jpg" alt="Post photo"[^>]*style="float:left;margin:0px 16px 8px 0px;width:160px;height:120px">WordPress style/);
  assert.match(wp[0].settings.editor, /<a href="https:\/\/example\.com\/l"[^>]*>link<\/a> and <strong[^>]*>bold words<\/strong>/);
  assert.ok(!widgets(template).some((w) => w.widgetType === 'image' && /p\.jpg/.test(JSON.stringify(w.settings))), 'the image is not also a separate widget');

  // A box beside a float starts under it; its text is not pushed right a second time.
  const beside = widgets(template).find((w) => /Box beside float/.test(textOf(w)));
  assert.equal(Number(beside.settings._margin?.left || 0), 0);
  const box = els.find((el) => el.elType === 'container' && el.elements.includes(beside));
  assert.ok(Number(box.settings.padding.left) <= 11, 'the box keeps at most its own padding');

  const design = await convert({ type: 'html', html: floats, baseUrl: 'https://example.com/' }, {});
  const placeholder = widgets(design.template).find((w) => w.widgetType === 'text-editor' && /alignleft/.test(w.settings.editor));
  assert.match(placeholder.settings.editor, /src="https:\/\/placehold\.co\/160x120\.png" alt=""/);
  assert.ok(!/WordPress style|Post photo/.test(placeholder.settings.editor), 'no source words or alt text');
});

const lists = `<!doctype html><html><head><style>
  body { margin: 0; font: 16px/24px Arial, sans-serif; color: #222; }
  .wrap { width: 800px; margin: 0 auto 40px; padding: 20px; display: flow-root; }
  .features li { font-size: 20px; line-height: 32px; color: #0a6; font-weight: 700; }
  .a li + li { margin-top: 14px; }
  .b { list-style: none; padding: 0; }
  .b li { padding: 10px 0; border-bottom: 1px solid #ccc; }
  .mixed li:first-child { color: #a00; }
</style></head><body>
<div class="wrap"><ul class="features"><li>Fast delivery</li><li>Fresh ingredients</li><li>Local farms</li></ul><p>After features</p></div>
<div class="wrap"><ul class="a"><li>Item one</li><li>Item two</li><li>Item three</li></ul><p>After list A</p></div>
<div class="wrap"><ul class="b"><li>Row one</li><li>Row two</li><li>Row three</li></ul><p>After list B</p></div>
<div class="wrap"><ul class="mixed"><li>Red first</li><li>Plain second</li></ul></div>
<div class="wrap"><p>Steps continue:</p><ol start="5"><li>Fifth step</li><li>Sixth step</li></ol><ol><li value="3">Third</li><li>Fourth</li></ol><ol reversed><li>Two left <ol start="7"><li>Nested seven</li></ol></li><li>One left</li></ol></div>
<div class="wrap"><img src="https://example.com/d.jpg" width="160" height="200" alt="D" style="float:left;margin:0 16px 8px 0"><p>Paragraph beside a floated image.</p><ol start="3"><li>Beside three</li><li>Beside four</li></ol></div>
</body></html>`;

test('plain lists keep their item styling and numbering', async () => {
  const { template } = await convert({ type: 'html', html: lists, baseUrl: 'https://example.com/' }, { keepText: true, keepImages: true });
  assert.deepEqual(validateTemplate(template), []);
  const editor = (re) => widgets(template).find((w) => w.widgetType === 'text-editor' && re.test(w.settings.editor));

  // Items that all share their own type give the widget its typography.
  const features = editor(/Fast delivery/);
  assert.equal(features.settings.typography_font_size.size, 20);
  assert.equal(String(features.settings.typography_font_weight), '700');
  assert.equal(features.settings.text_color, '#00AA66');
  assert.match(features.settings.editor, /<li>Fast delivery<\/li><li>Fresh ingredients<\/li>/);

  // Spacing between items, padding and rules between them.
  assert.match(editor(/Item two/).settings.editor, /<li>Item one<\/li><li style="margin-top:14px">Item two<\/li><li style="margin-top:14px">Item three<\/li>/);
  assert.match(editor(/Row one/).settings.editor, /<li style="padding:10px 0px 10px 0px;border-bottom:1px solid #CCCCCC">Row one<\/li>/);
  // An item that differs from the others keeps its own colour.
  assert.match(editor(/Red first/).settings.editor, /<li style="color:#AA0000">Red first<\/li><li>Plain second<\/li>/);

  // Numbering that starts, jumps or counts down.
  assert.match(editor(/Fifth step/).settings.editor, /^<ol start="5" style="padding-left:40px;margin:0">/);
  assert.match(editor(/Third/).settings.editor, /<li value="3">Third<\/li>/);
  assert.match(editor(/Two left/).settings.editor, /^<ol reversed style="[^"]*">/);
  assert.match(editor(/Two left/).settings.editor, /<ol start="7" style="[^"]*">/);
  assert.match(editor(/Beside three/).settings.editor, /<img class="alignleft"[^>]*>.*<ol start="3" style="[^"]*">/);
});
