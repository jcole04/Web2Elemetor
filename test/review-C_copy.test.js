import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convert } from '../src/convert.js';
import { applyCopyrightMode } from '../src/copyright.js';
import { buildTemplate } from '../src/elementor/build.js';
import { resolveFont, resolveInlineFont } from '../src/fonts.js';
import { validateTemplate } from '../src/elementor/validate.js';

const walk = (els, fn) => els.forEach((el) => { fn(el); walk(el.elements, fn); });
const widgets = (template) => {
  const out = [];
  walk(template.content, (el) => el.elType === 'widget' && out.push(el));
  return out;
};
const convertHtml = (html, opts) => convert({ type: 'html', html, baseUrl: 'https://example.com/' }, opts);

// The commercial fonts are mapped to locally installed faces so the browser draws them
// (a web font that never loads falls through to the next family in the stack).
const fontsPage = `<!doctype html><html><head><style>
  @font-face { font-family: "Proxima Nova"; src: local("DejaVu Sans"), local("Liberation Sans"), local("Arial"); }
  body { margin: 0; font: 16px/1.5 Arial, sans-serif; color: #222; }
  main { width: 800px; margin: 0 auto; padding: 40px 0; }
  .brand { font-family: "Proxima Nova", sans-serif; color: #c33; }
  .wrap { display: flow-root; margin-top: 24px; }
  .wrap h2 { font-family: "Proxima Nova", Montserrat, sans-serif; margin: 0 0 8px; }
  table { border-collapse: collapse; width: 100%; font-family: Gotham, Georgia, serif; margin-top: 24px; }
  td, th { border: 1px solid #ddd; padding: 8px; }
</style></head><body><main>
  <p>Order the <span class="brand">Harvest Platter</span> before Thursday evening.</p>
  <div class="wrap">
    <img src="https://example.com/z.jpg" width="160" height="120" alt="Plate" style="float:left;margin:0 16px 8px 0">
    <h2>Seasonal heading</h2>
    <p style="margin:0">Paragraph text beside the image.</p>
  </div>
  <table><tr><th>Course</th><th>Price</th></tr><tr><td>Tartare</td><td>12</td></tr></table>
</main></body></html>`;

test('commercial fonts inside rich text and table markup get the free look-alike and a note', async () => {
  for (const own of [true, false]) {
    const { template, fonts, notes } = await convertHtml(fontsPage, { keepText: own, keepImages: own });
    assert.deepEqual(validateTemplate(template), []);
    const markup = widgets(template).map((w) => w.settings.editor || w.settings.html || w.settings.title || '').join('\n');
    assert.doesNotMatch(markup, /Proxima|Gotham/, 'no commercial family is written into markup');
    // The span, the heading beside the float and the table all use the stand-in.
    assert.match(markup, /<span style="[^"]*font-family:Montserrat, sans-serif/);
    assert.match(markup, /<h2 style="font-family:Montserrat, sans-serif;/);
    assert.match(markup, /<table style="[^"]*font-family:Montserrat, serif/);
    assert.ok(fonts.includes('Montserrat'), 'the stand-in is listed with the fonts');
    assert.ok(notes.some((n) => /"Proxima Nova" is a commercial or platform font/.test(n)));
    assert.ok(notes.some((n) => /"Gotham" is a commercial or platform font/.test(n)));
    // No widget's Typography uses Montserrat, so Elementor would not load it without help.
    assert.ok(notes.some((n) => /^Montserrat is used only for some words inside text/.test(n)));
  }
});

test('inline font stacks only swap families that are not free', () => {
  assert.equal(resolveInlineFont('inherit'), null);
  assert.equal(resolveInlineFont('monospace'), null);
  assert.equal(resolveInlineFont('Inter, Arial, sans-serif').stack, null);
  assert.equal(resolveInlineFont("'Proxima Nova', sans-serif").stack, 'Montserrat, sans-serif');
  assert.equal(resolveInlineFont('Menlo, monospace').stack, "'JetBrains Mono', monospace");
  // A bare generic family is not a font with a licence.
  assert.equal(resolveFont('monospace').note, null);
});

const codePage = `<!doctype html><html><head><style>
  body { margin: 0; font: 16px/1.5 Arial, sans-serif; color: #222; }
  main { width: 800px; margin: 0 auto; padding: 40px 0; }
  pre { background: #272822; color: #f8f8f2; padding: 12px; font: 15px/1.6 "Courier New", monospace; }
  pre code { font: inherit; }
  .addr { white-space: pre-line; }
</style></head><body><main>
  <pre><code><span style="color:#f92672">const</span> total = <span style="color:#ae81ff">1</span>;
if (total) {
  console.log(<span style="color:#e6db74">'ready to ship'</span>);
}</code></pre>
  <p class="addr">12 Main Street
Springfield
IL 62701</p>
</main></body></html>`;

test('code blocks keep their colours and lines, pre-line text keeps its breaks', async () => {
  const own = await convertHtml(codePage, { keepText: true, keepImages: true });
  assert.deepEqual(validateTemplate(own.template), []);
  const all = widgets(own.template);
  const code = all.find((w) => /<pre\b/.test(w.settings.editor || ''));
  assert.ok(code, 'code block in a Text Editor');
  assert.equal(code.settings.editor, `<pre style="margin:0;font-family:inherit"><span style="color:#F92672">const</span> total = <span style="color:#AE81FF">1</span>;
if (total) {
  console.log(<span style="color:#E6DB74">'ready to ship'</span>);
}</pre>`);
  const addr = all.find((w) => /Main Street/.test(w.settings.editor || ''));
  assert.equal(addr.settings.editor, '<p>12 Main Street<br>Springfield<br>IL 62701</p>');

  // Placeholders keep the line count, the indentation and the colour spans.
  const design = await convertHtml(codePage, {});
  const dAll = widgets(design.template);
  const dCode = dAll.find((w) => /<pre\b/.test(w.settings.editor || '')).settings.editor;
  assert.doesNotMatch(dCode, /total|console|ready|ship/);
  assert.equal(dCode.split('\n').length, 4);
  assert.match(dCode, /\n {2}\S/);
  assert.equal((dCode.match(/<span style="color:#/g) || []).length, 3);
  const dAddr = dAll.find((w) => /^<p>[^<]+<br>[^<]+<br>[^<]+<\/p>$/.test(w.settings.editor || ''));
  assert.ok(dAddr, 'address placeholder keeps its two line breaks');
  assert.doesNotMatch(dAddr.settings.editor, /Main|Springfield/);
});

test('with only the images kept, alt text, SVG labels and frame titles are still replaced', () => {
  const tree = {
    title: 'Page',
    sections: [{
      kind: 'container', rect: { x: 0, y: 0, w: 800, h: 600 }, children: [
        { kind: 'image', rect: { w: 200, h: 200 }, src: 'https://example.com/maya.jpg', alt: 'Portrait of Maya Okafor' },
        { kind: 'svg', rect: { w: 200, h: 200 }, svg: '<svg viewBox="0 0 10 10" role="img" aria-label="Donut chart: 72 percent completed"><title>Completion rate</title><desc>Most people finished</desc><circle cx="5" cy="5" r="4"/></svg>' },
        { kind: 'embed', provider: 'other', rect: { w: 600, h: 300 }, src: 'https://player.example.com/embed', title: 'Echofield embeddable player preview' },
      ],
    }],
  };
  applyCopyrightMode(tree, { keepText: false, keepImages: true });
  const { template } = buildTemplate(tree);
  assert.deepEqual(validateTemplate(template), []);
  const out = JSON.stringify(template);
  assert.doesNotMatch(out, /Maya|Okafor|Donut|72 percent|Completion|finished|Echofield/);
  // The pictures themselves are kept.
  assert.match(out, /https:\/\/example\.com\/maya\.jpg/);
  assert.match(out, /<circle cx=\\"5\\" cy=\\"5\\" r=\\"4\\"\/>/);
  assert.match(out, /<iframe src=\\"https:\/\/player\.example\.com\/embed\\" title=\\"\w/);
  const img = widgets(template).find((w) => w.widgetType === 'image');
  assert.ok(img.settings.image.alt.length > 0, 'alt text is a placeholder, not dropped');
});
