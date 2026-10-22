// Screenshots and PDFs have no DOM, so Claude reads the layout from the
// pixels: boxes, text, font families and colours. For screenshots the colours
// are then corrected by sampling the actual pixels, and the result is fed
// through the same normalizer as live pages.
import Anthropic from '@anthropic-ai/sdk';
import { chromium } from 'playwright';
import { normalize } from '../normalize.js';
import { iconFromHints, faIcon, hasIcon, faFromLibraryName } from '../icons.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';

const nullable = (type) => ({ type: [type, 'null'] });

// Flat list with parent ids: easier for the model than a deep recursive schema.
const NODE = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'parent', 'kind', 'page', 'x', 'y', 'w', 'h', 'direction', 'text', 'headingLevel', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'uppercase', 'italic', 'textColor', 'textAlign', 'backgroundColor', 'gradient', 'hasBackgroundImage', 'borderColor', 'borderWidth', 'borderRadius', 'shadow', 'padding', 'iconName', 'value'],
  properties: {
    id: { type: 'string', description: 'Unique id such as "n1".' },
    parent: { ...nullable('string'), description: 'Id of the enclosing container, null for top-level page sections.' },
    kind: { type: 'string', enum: ['container', 'heading', 'text', 'button', 'image', 'icon', 'divider', 'rating', 'progress', 'video', 'map'] },
    page: { type: 'integer', description: 'PDF page number starting at 1; always 1 for screenshots.' },
    x: { type: 'number', description: 'Left edge as a percentage (0-100) of the page width.' },
    y: { type: 'number', description: 'Top edge as a percentage (0-100) of the page (or PDF page) height.' },
    w: { type: 'number', description: 'Width as a percentage of the page width.' },
    h: { type: 'number', description: 'Height as a percentage of the page height.' },
    direction: { type: 'string', enum: ['row', 'column'], description: 'For containers: how children are laid out. Use "column" for widgets.' },
    text: { type: 'string', description: 'Exact visible text for heading/text/button. Use simple HTML (<strong>, <em>, <br>, <ul><li>) where needed. Empty for others.' },
    headingLevel: { ...nullable('integer'), description: '1-6 for headings by visual importance, else null.' },
    fontFamily: { ...nullable('string'), description: 'Closest typeface name. Prefer the exact font if recognisable, otherwise the closest Google Font.' },
    fontSize: { ...nullable('number'), description: 'Font size in CSS px at the page width given in pageWidthPx.' },
    fontWeight: { ...nullable('integer'), description: '100-900' },
    lineHeight: { ...nullable('number'), description: 'Line height in CSS px.' },
    letterSpacing: { ...nullable('number'), description: 'Letter spacing in px, 0 if normal.' },
    uppercase: { type: 'boolean' },
    italic: { type: 'boolean' },
    textColor: { ...nullable('string'), description: 'Hex colour such as #1F2937.' },
    textAlign: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
    backgroundColor: { ...nullable('string'), description: 'Hex fill colour of this box, null if transparent.' },
    gradient: { ...nullable('string'), description: 'CSS linear-gradient(...) if the fill is a gradient.' },
    hasBackgroundImage: { type: 'boolean', description: 'True if a photo or illustration fills this container behind its content.' },
    borderColor: nullable('string'),
    borderWidth: { type: 'number', description: '0 if none.' },
    borderRadius: { type: 'number', description: 'Corner radius in px, 0 if square.' },
    shadow: { type: 'boolean' },
    padding: { type: 'array', items: { type: 'number' }, description: 'Inner padding in px: [top, right, bottom, left].' },
    iconName: { ...nullable('string'), description: 'For icons, and for buttons that show an icon: the closest common icon name in Font Awesome / Lucide style, such as "phone", "envelope", "check", "arrow-right", "star", "facebook-f", "instagram". Null otherwise.' },
    value: { ...nullable('number'), description: 'For rating: filled stars out of 5 (halves allowed). For progress: the filled percentage 0-100. Null otherwise.' },
  },
};

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'pageWidthPx', 'pageHeights', 'pageBackground', 'nodes'],
  properties: {
    title: { type: 'string', description: 'Short descriptive name for the design.' },
    pageWidthPx: { type: 'number', description: 'Design width in CSS px (1440 for desktop pages unless clearly a 1280/1920/mobile design; 390 for phone screenshots).' },
    pageHeights: { type: 'array', items: { type: 'number' }, description: 'Height in CSS px of each page at pageWidthPx (one entry per PDF page; one entry for a screenshot).' },
    pageBackground: { type: 'string', description: 'Hex page background colour.' },
    nodes: { type: 'array', items: NODE },
  },
};

const PROMPT = `You are converting a visual design into a precise layout tree that will be rebuilt as an Elementor page.

List every visible element as nodes. Rules:
- Top-level nodes (parent null) are full-width horizontal bands of the page, top to bottom (header, hero, feature rows, footer...).
- Group elements the way a front-end developer would with flexbox: a container with direction "row" for side-by-side items (columns, nav links, card grids), "column" for stacked items. Nest containers as needed.
- Leaves are heading, text (paragraphs, labels, lists, nav links), button (text in a filled or outlined pill/box), image (photos, logos, illustrations), icon (small glyphs, including social network logos), divider (thin rules), rating (a row of stars), progress (a progress or skill bar: textColor is the filled bar colour, backgroundColor the track), video (a video player or a thumbnail with a play button), map (an embedded map; put the place name or address in text if one is visible).
- For every icon give iconName. A small coloured circle or square behind an icon is the icon's backgroundColor and borderRadius.
- Coordinates are percentages of the page width (x, w) and of the page height (y, h). Be precise: the layout is rebuilt from these boxes.
- Measure font sizes, weights, line heights, colours and corner radii as exactly as you can. Colours are hex.
- Copy text exactly as shown.
- Order siblings in reading order (top-to-bottom, then left-to-right).
Return only the JSON.`;

function imageSize(buf) {
  // PNG
  if (buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  // JPEG: scan for a SOF marker
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  // WebP (VP8X / VP8 / VP8L)
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

async function askClaude(buffer, mimeType) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error('Screenshots and PDFs need a Claude API key. Set ANTHROPIC_API_KEY before starting the server.');
  }
  const client = new Anthropic();
  const data = buffer.toString('base64');
  const media = mimeType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
    : { type: 'image', source: { type: 'base64', media_type: mimeType, data } };

  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: [media, { type: 'text', text: PROMPT }] }],
  });
  let message;
  try {
    message = await stream.finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error('The Claude API key was rejected. Check ANTHROPIC_API_KEY.');
    if (err instanceof Anthropic.RateLimitError) throw new Error('The Claude API is rate limiting requests. Try again in a minute.');
    if (err instanceof Anthropic.APIError) throw new Error(`Claude API error: ${err.message}`);
    throw err;
  }
  if (message.stop_reason === 'refusal') throw new Error('Claude declined to analyse this file.');
  if (message.stop_reason === 'max_tokens') throw new Error('The design is too large to analyse in one pass. Try a shorter screenshot or fewer PDF pages.');
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

// Replaces guessed colours with real pixel colours sampled from the screenshot.
export async function sampleColours(buffer, mimeType, nodes, imgW, imgH) {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  try {
    const page = await browser.newPage();
    const boxes = nodes.map((n) => ({ id: n.id, kind: n.kind, x: n.x / 100 * imgW, y: n.y / 100 * imgH, w: n.w / 100 * imgW, h: n.h / 100 * imgH }));
    return await page.evaluate(async ({ src, boxes, imgW, imgH }) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = new OffscreenCanvas(imgW, imgH);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const hex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
      const out = {};
      for (const b of boxes) {
        const x = Math.max(0, Math.floor(b.x)), y = Math.max(0, Math.floor(b.y));
        const w = Math.min(imgW - x, Math.ceil(b.w)), h = Math.min(imgH - y, Math.ceil(b.h));
        if (w < 3 || h < 3) continue;
        const d = ctx.getImageData(x, y, w, h).data;
        const counts = new Map();
        const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 40000)));
        for (let yy = 0; yy < h; yy += step) {
          for (let xx = 0; xx < w; xx += step) {
            const i = (yy * w + xx) * 4;
            // Quantise lightly so antialiasing doesn't split one colour into many.
            const key = (d[i] >> 2) << 16 | (d[i + 1] >> 2) << 8 | (d[i + 2] >> 2);
            const e = counts.get(key) || { n: 0, r: d[i], g: d[i + 1], b: d[i + 2] };
            e.n++;
            counts.set(key, e);
          }
        }
        const ranked = [...counts.values()].sort((a, b2) => b2.n - a.n);
        const bg = ranked[0];
        // Text colour: the most common colour that clearly differs from the background.
        const far = ranked.find((e) => Math.abs(e.r - bg.r) + Math.abs(e.g - bg.g) + Math.abs(e.b - bg.b) > 120 && e.n > 2);
        out[b.id] = { bg: hex(bg.r, bg.g, bg.b), bgShare: bg.n / ranked.reduce((s, e) => s + e.n, 0), fg: far ? hex(far.r, far.g, far.b) : null };
      }
      return out;
    }, { src: `data:${mimeType};base64,${buffer.toString('base64')}`, boxes, imgW, imgH });
  } finally {
    await browser.close();
  }
}

// Icon names from the model → Font Awesome (the glyph set Elementor ships).
function iconForName(name) {
  const n = String(name || '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!n) return { icon: faIcon('circle'), confidence: 'none' };
  const hit = iconFromHints(`icon-${n} ${n.replace(/-/g, ' ')}`);
  if (hit) return hit;
  const lib = faFromLibraryName(n, '', 'fill');
  if (lib) return { icon: lib, confidence: 'name' };
  for (const l of ['solid', 'regular', 'brands']) if (hasIcon(n, l)) return { icon: faIcon(n, l), confidence: 'name' };
  return { icon: faIcon('circle'), confidence: 'none' };
}

// Converts Claude's flat node list into the same raw shape the DOM extractor produces.
function toRawLayout(res) {
  const W = res.pageWidthPx || 1440;
  const heights = res.pageHeights?.length ? res.pageHeights : [W * 1.5];
  const offsets = heights.map((_, i) => heights.slice(0, i).reduce((s, h) => s + h, 0));
  const totalH = heights.reduce((s, h) => s + h, 0);

  const rectOf = (n) => {
    const p = Math.max(1, Math.min(heights.length, n.page || 1)) - 1;
    return { x: Math.round(n.x / 100 * W), y: Math.round(offsets[p] + n.y / 100 * heights[p]), w: Math.max(1, Math.round(n.w / 100 * W)), h: Math.max(1, Math.round(n.h / 100 * heights[p])) };
  };
  const style = (n) => ({
    fontFamily: n.fontFamily || 'Arial',
    fontSize: n.fontSize || 16,
    fontWeight: String(n.fontWeight || 400),
    lineHeight: n.lineHeight || null,
    letterSpacing: n.letterSpacing || 0,
    textTransform: n.uppercase ? 'uppercase' : null,
    fontStyle: n.italic ? 'italic' : null,
    color: n.textColor || '#000000',
  });
  const bg = (n) => {
    const b = {};
    if (n.gradient) b.gradient = n.gradient;
    else if (n.backgroundColor) b.color = n.backgroundColor;
    if (n.hasBackgroundImage) b.image = 'placeholder';
    return Object.keys(b).length ? b : null;
  };
  const border = (n) => ({
    style: n.borderWidth > 0 ? 'solid' : null,
    width: n.borderWidth > 0 ? [n.borderWidth, n.borderWidth, n.borderWidth, n.borderWidth] : null,
    color: n.borderWidth > 0 ? n.borderColor : null,
    radius: n.borderRadius > 0 ? [n.borderRadius, n.borderRadius, n.borderRadius, n.borderRadius] : null,
  });
  const pad = (n) => (Array.isArray(n.padding) && n.padding.length === 4 ? n.padding : [0, 0, 0, 0]);

  const byParent = new Map();
  for (const n of res.nodes) {
    const k = n.parent || null;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(n);
  }
  const build = (n, seen = new Set()) => {
    if (seen.has(n.id)) return null;
    seen.add(n.id);
    const rect = rectOf(n);
    const base = { rect, margin: [0, 0, 0, 0], padding: pad(n) };
    switch (n.kind) {
      case 'container': {
        const kids = (byParent.get(n.id) || []).map((c) => build(c, seen)).filter(Boolean)
          .sort((a, b) => (n.direction === 'row' ? a.rect.x - b.rect.x : a.rect.y - b.rect.y));
        return { kind: 'container', tag: 'div', ...base, direction: n.direction, wrap: n.direction === 'row' && kids.some((k) => k.rect.y > kids[0].rect.y + kids[0].rect.h), justify: 'normal', alignItems: 'normal', gap: { column: 0, row: 0 }, background: bg(n), border: border(n), shadow: n.shadow ? '0px 4px 12px rgba(0,0,0,0.12)' : null, textAlign: n.textAlign, children: kids };
      }
      case 'heading':
        return { kind: 'heading', ...base, padding: [0, 0, 0, 0], level: n.headingLevel || 2, text: n.text.replace(/<[^>]+>/g, ''), html: n.text, align: n.textAlign, style: style(n) };
      case 'text':
        return { kind: 'text', ...base, padding: [0, 0, 0, 0], html: n.text, text: n.text.replace(/<[^>]+>/g, ''), align: n.textAlign, style: style(n) };
      case 'button': {
        const fa = n.iconName && iconForName(n.iconName);
        const icon = fa && fa.confidence !== 'none' ? { fa: fa.icon, faConfidence: fa.confidence, svg: null, hints: n.iconName, size: Math.round((n.fontSize || 16) * 1.1), color: n.textColor, position: 'right', gap: 8 } : null;
        return { kind: 'button', ...base, text: n.text.replace(/<[^>]+>/g, ''), href: '#', style: style(n), background: bg(n), border: border(n), shadow: null, icon };
      }
      case 'image':
        return { kind: 'image', ...base, src: 'placeholder', alt: '', border: border(n) };
      case 'icon': {
        const fa = iconForName(n.iconName);
        const glyph = Math.round(Math.min(rect.w, rect.h) * (n.backgroundColor ? 0.5 : 1));
        return { kind: 'icon', ...base, hints: n.iconName || '', fa: fa.icon, faConfidence: fa.confidence, svg: null, color: n.textColor || '#000000', size: glyph, background: n.backgroundColor ? { color: n.backgroundColor } : null, border: border(n) };
      }
      case 'rating':
        return { kind: 'rating', ...base, value: n.value ?? 5, max: 5, size: rect.h, gap: Math.round(Math.max(0, (rect.w - rect.h * 5) / 4)), color: n.textColor || '#F59E0B' };
      case 'progress':
        return { kind: 'progress', ...base, percent: Math.max(0, Math.min(100, n.value ?? 50)), barColor: n.textColor, trackColor: n.backgroundColor, height: rect.h, radius: n.borderRadius || 0, label: n.text || '', labelStyle: style(n) };
      case 'video':
        return { kind: 'video', ...base, src: '', placeholderMedia: 'placeholder', border: border(n) };
      case 'map':
        return { kind: 'embed', ...base, provider: 'maps', src: '', address: n.text?.replace(/<[^>]+>/g, '').trim() || null, border: border(n) };
      case 'divider':
        return { kind: 'divider', ...base, color: n.borderColor || n.backgroundColor || '#E5E7EB', weight: Math.max(1, n.borderWidth || rect.h), style: 'solid' };
      default:
        return null;
    }
  };
  const sections = (byParent.get(null) || []).map((n) => build(n)).filter(Boolean).sort((a, b) => a.rect.y - b.rect.y);
  const children = sections.map((s) => (s.kind === 'container' ? s : { kind: 'container', tag: 'div', rect: s.rect, margin: [0, 0, 0, 0], padding: [0, 0, 0, 0], direction: 'column', gap: { column: 0, row: 0 }, children: [s] }));
  return {
    title: res.title,
    viewport: { width: W, height: 900 },
    pageBackground: res.pageBackground,
    baseTypography: null,
    root: { kind: 'container', tag: 'body', rect: { x: 0, y: 0, w: W, h: totalH }, padding: [0, 0, 0, 0], margin: [0, 0, 0, 0], direction: 'column', gap: { column: 0, row: 0 }, children },
  };
}

export async function extractFromVisual(buffer, mimeType) {
  const isPdf = mimeType === 'application/pdf';
  if (!isPdf && !/^image\/(png|jpeg|webp|gif)$/.test(mimeType)) throw new Error('Upload a PNG, JPEG, WebP or GIF screenshot, or a PDF.');
  const res = await askClaude(buffer, mimeType);

  if (!isPdf) {
    const size = imageSize(buffer);
    if (size) {
      // Pixel-true colours beat the model's estimates.
      const samples = await sampleColours(buffer, mimeType, res.nodes, size.width, size.height).catch(() => ({}));
      for (const n of res.nodes) {
        const s = samples[n.id];
        if (!s) continue;
        if (n.kind === 'container' && n.backgroundColor && !n.gradient && s.bgShare > 0.4) n.backgroundColor = s.bg;
        if (n.kind === 'button' && n.backgroundColor && s.bgShare > 0.4) n.backgroundColor = s.bg;
        if (['heading', 'text', 'button'].includes(n.kind) && n.textColor && s.fg) n.textColor = s.fg;
      }
      res.pageHeights = [Math.round((res.pageWidthPx || 1440) * size.height / size.width)];
    }
  }

  return layoutFromVisionResult(res, isPdf ? 'pdf' : 'image');
}

export function layoutFromVisionResult(res, sourceType = 'image') {
  const raw = toRawLayout(res);
  raw.source = { type: sourceType };
  return normalize(raw);
}
