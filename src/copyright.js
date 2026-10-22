// Copyright safeguards. By default only the design (layout, spacing, colours,
// type scale) is carried over. The source's words, photos and logos are
// swapped for neutral placeholders unless the user confirms they own them.

const LOREM = ('lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt in culpa qui officia deserunt mollit anim id est laborum').split(' ');

let cursor = 0;
// Placeholder ids count up across the whole template, so two widgets never share one.
let idCount = 0;
// Placeholder words that never run longer than the original, so the layout keeps its line breaks.
function lorem(length) {
  if (length <= 0) return '';
  const words = [];
  let len = 0;
  for (let tries = 0; tries < LOREM.length; tries++) {
    const w = LOREM[cursor++ % LOREM.length];
    const add = (words.length ? 1 : 0) + w.length;
    if (len + add > length) {
      if (length - len >= 4) continue; // look for a shorter word that fits
      break;
    }
    words.push(w);
    len += add;
    if (len >= length - 1) break;
  }
  if (!words.length) words.push(LOREM[cursor++ % LOREM.length].slice(0, Math.max(1, length)));
  const s = words.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function placeholderText(text, kind) {
  const t = String(text || '').trim();
  if (!t) return t;
  let out = lorem(t.length);
  // Button labels read as labels: every word capitalised.
  if (kind === 'button') out = out.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  if (t === t.toUpperCase() && /[A-Z]/.test(t)) out = out.toUpperCase();
  if (/[.!?]$/.test(t) && !/[.!?]$/.test(out)) out += '.';
  return out;
}

// Swaps one text run, keeping the spaces around it so inline tags stay separated.
// A run with its own line breaks (a code block) is swapped line by line, so the
// placeholder keeps the line count and indentation.
function swapRun(t) {
  if (t.includes('\n')) return t.split('\n').map(swapRun).join('\n');
  if (!/[\p{L}\p{N}]/u.test(t)) return t;
  const lead = t.match(/^\s*/)[0];
  const trail = t.match(/\s*$/)[0];
  // An entity (&lt;) counts as the one character it shows.
  return lead + placeholderText(t.replace(/&[#\w]+;/g, '_')) + trail;
}

// Keeps the HTML structure (lists, bold, line breaks) but replaces each text run.
function placeholderHtml(html) {
  return String(html || '')
    .replace(/>([^<]+)</g, (_, t) => `>${swapRun(t)}<`)
    .replace(/^([^<]+)/, (_, t) => swapRun(t))
    .replace(/>([^<]+)$/, (_, t) => `>${swapRun(t)}`)
    .replace(/href="[^"]*"/g, 'href="#"');
}

// Vector artwork the user keeps: its drawing stays, but its accessible name and
// tooltip (aria-label, title, <title>, <desc>) are source words.
function placeholderSvgWords(svg) {
  return String(svg || '')
    .replace(/\s(aria-label|title)="([^"]*)"/g, (m, a, v) => (v.trim() ? ` ${a}="${placeholderText(v)}"` : m))
    .replace(/(<(title|desc)\b[^>]*>)([^<]*)(?=<\/\2>)/g, (m, open, tag, t) => open + swapRun(t));
}

export function placeholderImage(w, h) {
  const width = Math.max(16, Math.min(2400, Math.round(w || 600)));
  const height = Math.max(16, Math.min(2400, Math.round(h || 400)));
  // Plain grey box with its size; no query string so Elementor's importer can sideload it.
  return `https://placehold.co/${width}x${height}.png`;
}

// Elementor's importer can only sideload ordinary http(s) image URLs.
const isImportable = (src) => /^https?:\/\//.test(src || '');

// Inputs whose value is a date, a number or a colour, not words: a browser empties any other value there.
const TYPED_INPUT = /\stype="(date|time|datetime-local|month|week|number|range|color)"/;

// Ids can spell out names (design tools write layer names): numbered ones instead, references included.
function neutralIds(html) {
  const ids = new Map();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) if (!ids.has(m[1])) ids.set(m[1], `ph-${++idCount}`);
  if (!ids.size) return html;
  return html.replace(/(\sid=")([^"]+)(?=")|#([^\s"'()&;,]+)/g, (m, attr, id, ref) => (attr ? attr + ids.get(id) : ids.has(ref) ? `#${ids.get(ref)}` : m));
}

// Form/table snapshots: swap visible words and field hints, keep structure and styling.
function placeholderMarkup(html, { keepText, keepImages }) {
  let out = String(html || '');
  if (!keepText) {
    out = placeholderHtml(out).replace(/<[a-z][^>]*>/g, (tag) => tag
      .replace(/\s(placeholder|value|title|alt|aria-label)="([^"]*)"/g, (m, a, v) => (!v.trim() || (a === 'value' && TYPED_INPUT.test(tag)) ? m : ` ${a}="${placeholderText(v)}"`))
      .replace(/\sdata-[\w-]+="[^"]*"/g, ''));
    out = neutralIds(out);
  }
  if (!keepImages) {
    out = out.replace(/<img\b([^>]*?)\ssrc="[^"]*"([^>]*?)>/g, (m, pre, post) => {
      const w = (m.match(/width:\s*(\d+)/) || m.match(/width="(\d+)"/) || [])[1];
      const h = (m.match(/height:\s*(\d+)/) || m.match(/height="(\d+)"/) || [])[1];
      return `<img${pre} src="${placeholderImage(w || 200, h || 150)}"${post}>`;
    });
    // Inline artwork becomes a grey box of its size (innermost first, so a nested <svg> goes with its parent).
    const svg = /<svg\b(?:(?!<svg\b)[\s\S])*?<\/svg>/;
    while (svg.test(out)) {
      out = out.replace(svg, (m) => {
        const open = m.match(/^<svg\b[^>]*>/)[0];
        const w = Math.round(Number(open.match(/\swidth="([\d.]+)/)?.[1]) || 24), h = Math.round(Number(open.match(/\sheight="([\d.]+)/)?.[1]) || 24);
        return `<img src="${placeholderImage(w, h)}" alt="" width="${w}" height="${h}">`;
      });
    }
    out = out.replace(/<(audio|video|source|iframe)\b[^>]*>/g, (tag) => tag.replace(/\s(src|poster)="[^"]*"/g, ''));
    // Photos, logos and drawn glyphs in CSS backgrounds: a grey box at the size they are drawn, else the element's.
    out = out.replace(/\sstyle="([^"]*)"/g, (m, st) => {
      if (!/url\(/.test(st)) return m;
      const size = st.match(/background-size:([\d.]+)px ([\d.]+)px/) || [null, st.match(/(?:^|;)width:([\d.]+)px/)?.[1], st.match(/(?:^|;)height:([\d.]+)px/)?.[1]];
      const swapped = st.replace(/url\(&quot;.*?&quot;\)|url\([^)]*\)/g, `url(${placeholderImage(size[1], size[2])})`)
        .replace(/cursor:url\([^)]*\)[^;,]*,\s*/g, 'cursor:');
      return ` style="${swapped}"`;
    });
  }
  return out;
}

const SOCIAL_ROOT = (href) => {
  try {
    const u = new URL(href);
    return `${u.protocol}//${u.hostname}/`;
  } catch {
    return '#';
  }
};

export function applyCopyrightMode(tree, { keepText = false, keepImages = false } = {}) {
  cursor = 0;
  idCount = 0;
  const notes = new Set();
  const opts = { keepText, keepImages };
  const swapBgImage = (n) => {
    if (n.background?.image && (!keepImages || !isImportable(n.background.image))) {
      n.background.image = placeholderImage(n.rect?.w || 1440, n.rect?.h || 600);
      notes.add('Background images were replaced with grey placeholders.');
    }
  };
  const visit = (n) => {
    if (!n) return;
    swapBgImage(n);
    if (!keepText && n.href) n.href = '#';
    switch (n.kind) {
      case 'container':
        n.children.forEach(visit);
        return;
      case 'heading':
      case 'text':
        if (!keepText) {
          n.html = placeholderHtml(n.html || n.text).replace(/\salt="([^"]*)"/g, (m, v) => (v.trim() ? ` alt="${placeholderText(v)}"` : m));
          n.text = placeholderText(n.text);
          notes.add('Headings and body copy were replaced with placeholder text of the same length.');
        }
        // An image the text wraps around lives inside the Text Editor.
        if (n.floatImage) {
          if (!keepImages || !isImportable(n.floatImage.src)) {
            n.html = placeholderMarkup(n.html, { keepText: true, keepImages: false }).replace(/\salt="[^"]*"/g, ' alt=""');
            notes.add('Photos and logos were replaced with placeholders.');
          } else {
            notes.add('Images that text wraps around are placed in the Text Editor (aligned left or right) and still load from their original address. Upload them to your Media Library and swap them in.');
          }
        }
        return;
      case 'button':
        if (!keepText) {
          n.text = placeholderText(n.text, 'button');
          n.href = '#';
        }
        if (!keepImages && n.icon) n.icon.svg = null;
        return;
      case 'image':
        if (n.canvas || (n.src && (!keepImages || !isImportable(n.src)))) {
          n.src = placeholderImage(n.rect?.w, n.rect?.h);
          n.alt = '';
          notes.add('Photos and logos were replaced with placeholders.');
        } else if (!keepText && n.alt) n.alt = placeholderText(n.alt);
        return;
      case 'svg':
        if (!keepImages) {
          Object.assign(n, { kind: 'image', src: placeholderImage(n.rect?.w, n.rect?.h), svg: null, alt: '' });
          notes.add('Vector artwork (inline SVG) was replaced with placeholders.');
        } else if (!keepText) n.svg = placeholderSvgWords(n.svg);
        return;
      case 'icon':
        // Icons always become Font Awesome look-alikes unless the user owns the original artwork.
        if (!keepImages) n.svg = null;
        else if (!keepText && n.svg) n.svg = placeholderSvgWords(n.svg);
        return;
      case 'iconList':
        n.items.forEach((it) => {
          if (!keepImages && it.icon) it.icon.svg = null;
          if (!keepText) {
            it.text = placeholderText(it.text);
            it.html = placeholderHtml(it.html);
            it.href = it.href ? '#' : it.href;
          }
        });
        if (!keepText) notes.add('Headings and body copy were replaced with placeholder text of the same length.');
        return;
      case 'social':
        n.items.forEach((it) => {
          if (!keepImages && it.icon) it.icon.svg = null;
          if (!keepText) it.href = SOCIAL_ROOT(it.href);
        });
        if (!keepText) notes.add('Social links point to each network\'s home page; add your own profile links.');
        return;
      case 'accordion':
        n.items.forEach((it) => {
          if (!keepText) it.title = placeholderText(it.title);
          visit(it.content);
        });
        return;
      case 'tabs':
        n.tabs.forEach((t) => { if (!keepText) t.title = placeholderText(t.title); });
        n.panels.forEach((p) => visit(p));
        return;
      case 'progress':
        if (!keepText && n.label && !/^\d+(\.\d+)?\s*%$/.test(n.label.trim())) n.label = placeholderText(n.label);
        return;
      case 'html':
      case 'audio':
        if (n.role === 'image' && !keepImages) {
          Object.assign(n, { kind: 'image', src: placeholderImage(n.rect?.w, n.rect?.h), alt: '', markup: null });
          notes.add('Photos and logos were replaced with placeholders.');
          return;
        }
        if (!keepImages && /<(img|svg)\b|url\(/.test(n.markup || '')) notes.add('Photos and logos were replaced with placeholders.');
        n.markup = placeholderMarkup(n.markup, opts);
        if (!keepText && n.text) n.text = placeholderText(n.text);
        return;
      case 'embed':
        if (!keepText && n.title) n.title = placeholderText(n.title);
        if (n.provider === 'maps') {
          if (!keepText) n.address = 'London Eye, London, United Kingdom';
        } else if (!keepImages) {
          if (n.provider === 'youtube' || n.provider === 'vimeo') {
            n.placeholderMedia = placeholderImage(n.rect?.w, n.rect?.h);
          } else {
            Object.assign(n, { kind: 'image', src: placeholderImage(n.rect?.w, n.rect?.h), alt: '' });
            notes.add('Embedded third-party content was replaced with placeholders.');
          }
        }
        return;
      case 'video':
        if (!keepImages) n.placeholderMedia = placeholderImage(n.rect?.w, n.rect?.h);
        return;
      default:
    }
  };
  tree.sections.forEach(visit);
  if (!keepText) tree.title = tree.title ? 'Template' : tree.title;
  return [...notes];
}
