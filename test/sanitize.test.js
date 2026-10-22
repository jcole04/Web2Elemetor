import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeMarkup, importableImageUrl } from '../src/sanitize.js';
import { buildTemplate } from '../src/elementor/build.js';

test('markup for HTML widgets loses scripts, handlers and script URLs', () => {
  const out = sanitizeMarkup('<svg onload="x()"><script>alert(1)</script><a href="javascript:alert(1)">a</a><foreignObject><div>x</div></foreignObject><image href="data:image/png;base64,AA"/><path d="M0 0"/></svg>');
  assert.doesNotMatch(out, /script|onload|javascript:|foreignObject/i);
  assert.match(out, /data:image\/png/);
  assert.match(out, /<path d="M0 0"\/>/);
  assert.equal(sanitizeMarkup('<iframe src="https://example.com/embed"></iframe>'), '');
  assert.equal(sanitizeMarkup('<iframe src="https://example.com/embed" onload="x"></iframe>', { allowIframe: true }), '<iframe src="https://example.com/embed"></iframe>');
});

test('image links Elementor would not import get a file extension', () => {
  assert.equal(importableImageUrl('https://a.com/p.jpg'), 'https://a.com/p.jpg');
  assert.equal(importableImageUrl('https://a.com/p.jpg?w=800'), 'https://a.com/p.jpg?w=800#.jpg');
  assert.equal(importableImageUrl('https://cdn.com/abc?fm=webp&w=3'), 'https://cdn.com/abc?fm=webp&w=3#.webp');
  assert.equal(importableImageUrl('https://a.com/photo'), 'https://a.com/photo#.jpg');
});

test('links are never nested inside a linked card', () => {
  const rect = { x: 0, y: 0, w: 300, h: 200 };
  const style = { fontFamily: 'Arial', fontSize: 16, fontWeight: '400', color: '#111111' };
  const card = {
    kind: 'container', rect, padding: [0, 0, 0, 0], direction: 'column', href: 'https://example.com/post',
    children: [
      { kind: 'heading', rect, level: 3, text: 'Title', html: 'Title <a href="https://example.com/x">more</a>', href: 'https://example.com/x', style },
      { kind: 'image', rect, src: 'https://example.com/p.jpg', href: 'https://example.com/post' },
    ],
  };
  const { template } = buildTemplate({ title: 't', sections: [card] }, {});
  const [c] = template.content;
  assert.equal(c.settings.html_tag, 'a');
  const [h, img] = c.elements;
  assert.equal(h.settings.link, undefined);
  assert.doesNotMatch(h.settings.title, /<a\b/);
  assert.equal(img.settings.link_to, undefined);

  // A card holding a button keeps the link on the button instead.
  const withButton = { ...card, children: [{ kind: 'button', rect, text: 'Read', style, href: null }] };
  const out = buildTemplate({ title: 't', sections: [withButton] }, {}).template.content[0];
  assert.notEqual(out.settings.html_tag, 'a');
  assert.equal(out.elements[0].settings.link.url, 'https://example.com/post');
});
