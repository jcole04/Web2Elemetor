// Builds an Elementor template export (the JSON that Templates > Import
// accepts) from the normalized layout tree. Format verified against
// Elementor's own exporter: includes/template-library/sources/local.php
// (prepare_template_export) and DB::DB_VERSION = '0.4'.
//
// Everything is expressed with Elementor's built-in widgets and their own
// settings. The HTML widget is used only where no native widget exists
// (forms, tables, unknown embeds, audio, and inline SVG artwork the user owns).
import { randomBytes } from 'node:crypto';
import { resolveFont, resolveInlineFont, isGoogleFont } from '../fonts.js';
import { sanitizeMarkup, importableImageUrl, untexturize } from '../sanitize.js';

export const ELEMENTOR_DB_VERSION = '0.4';

const id = () => randomBytes(4).toString('hex').slice(0, 7);
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const slider = (size, unit = 'px') => ({ unit, size: r1(size), sizes: [] });
const dims = (arr, unit = 'px') => {
  const [top, right, bottom, left] = (arr || [0, 0, 0, 0]).map((v) => String(r1(v)));
  return { unit, top, right, bottom, left, isLinked: top === right && right === bottom && bottom === left };
};
const link = (url, external = false) => ({ url: url || '', is_external: external ? 'on' : '', nofollow: '', custom_attributes: '' });
const media = (url) => ({ url: importableImageUrl(url), id: '', size: '', alt: '', source: 'library' });

// The open-state icon: a different glyph if the page swaps it, otherwise the
// closed glyph turned the way the page rotates it (plus → ×, chevron down → up).
function openIconFor(closed, open) {
  if (!open?.fa) return closed.fa;
  if (open.fa.value !== closed.fa.value) return open.fa;
  const turn = ((Math.round((open.transform?.rotate || 0) - (closed.transform?.rotate || 0)) % 360) + 360) % 360;
  const name = closed.fa.value.replace(/^fa[srb] fa-/, '');
  const pick = (map) => (map[name] ? { value: `fas fa-${map[name]}`, library: 'fa-solid' } : closed.fa);
  if (turn === 45 || turn === 135) return /^plus/.test(name) ? { value: 'fas fa-times', library: 'fa-solid' } : closed.fa;
  if (turn === 180) return pick({ 'chevron-down': 'chevron-up', 'chevron-up': 'chevron-down', 'angle-down': 'angle-up', 'angle-up': 'angle-down', 'caret-down': 'caret-up', 'caret-up': 'caret-down', 'arrow-down': 'arrow-up', 'arrow-up': 'arrow-down', 'chevron-right': 'chevron-left', 'angle-right': 'angle-left' });
  if (turn === 90) return pick({ 'chevron-right': 'chevron-down', 'angle-right': 'angle-down', 'caret-right': 'caret-down', 'arrow-right': 'arrow-down', 'chevron-up': 'chevron-right', 'chevron-down': 'chevron-left' });
  if (turn === 270) return pick({ 'chevron-left': 'chevron-down', 'angle-left': 'angle-down', 'caret-left': 'caret-down', 'chevron-down': 'chevron-right', 'chevron-right': 'chevron-up' });
  return closed.fa;
}

// Artwork wider than a phone shrinks with its column and keeps its shape, as an <img> would.
function fluidSvg(svg) {
  return svg.replace(/^<svg\b[^>]*>/, (open) => {
    const w = open.match(/\swidth="([\d.]+)"/)?.[1], h = open.match(/\sheight="([\d.]+)"/)?.[1];
    if (!w || !h) return open;
    const css = `max-width:100%;height:auto;aspect-ratio:${w}/${h}`;
    return /\sstyle="/.test(open) ? open.replace(/\sstyle="/, ` style="${css};`) : open.replace(/^<svg/, `<svg style="${css}"`);
  });
}

function hasDescendant(n, pred) {
  return (n.children || []).some((c) => pred(c) || hasDescendant(c, pred)) || (n.items || []).some((it) => it.content && (pred(it.content) || hasDescendant(it.content, pred)));
}

const unlinkHtml = (html) => html && String(html).replace(/<a\b[^>]*>/gi, '<span>').replace(/<\/a\s*>/gi, '</span>');

// A widget inside a linked box: its own links are dropped (the box is the link).
function unlinked(n) {
  return {
    ...n,
    href: null,
    html: unlinkHtml(n.html),
    markup: unlinkHtml(n.markup),
    items: n.items && n.kind !== 'accordion' ? n.items.map((it) => ({ ...it, href: null })) : n.items,
  };
}

export function cssColorToHex(c) {
  if (!c) return null;
  if (c.startsWith('#')) return c.toUpperCase();
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (!m) return c;
  const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
  const hex = '#' + p.slice(0, 3).map((n) => Math.round(n).toString(16).padStart(2, '0')).join('').toUpperCase();
  return p.length > 3 && p[3] < 1 ? hex + Math.round(p[3] * 255).toString(16).padStart(2, '0').toUpperCase() : hex;
}

// Multiplies a colour's alpha (element opacity has no Elementor control, so it is folded into colours).
function fade(hex, opacity) {
  hex = cssColorToHex(hex);
  if (!hex || opacity == null || opacity >= 1 || !/^#[0-9A-F]{6}([0-9A-F]{2})?$/.test(hex)) return hex;
  const a = hex.length === 9 ? parseInt(hex.slice(7), 16) / 255 : 1;
  return hex.slice(0, 7) + Math.round(a * opacity * 255).toString(16).padStart(2, '0').toUpperCase();
}

function parseGradient(css) {
  if (!css) return null;
  const colors = css.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}\b/gi) || [];
  if (colors.length < 2) return null;
  let angle = 180;
  const deg = css.match(/(-?\d+(?:\.\d+)?)deg/);
  if (deg) angle = parseFloat(deg[1]);
  else if (/to right/.test(css)) angle = 90;
  else if (/to left/.test(css)) angle = 270;
  else if (/to top/.test(css)) angle = 0;
  // Stop positions ("red 20%").
  const stops = [...css.matchAll(/(rgba?\([^)]*\)|#[0-9a-f]{3,8})\s+(-?\d+(?:\.\d+)?)%/gi)].map((m) => parseFloat(m[2]));
  return {
    a: cssColorToHex(colors[0]),
    b: cssColorToHex(colors[colors.length - 1]),
    aStop: stops.length >= 2 ? stops[0] : 0,
    bStop: stops.length >= 2 ? stops[stops.length - 1] : 100,
    angle,
    radial: /^radial/.test(css.trim()),
    extraStops: colors.length > 2,
  };
}

// Splits a CSS list on top-level commas (not the ones inside rgb(...) or gradients).
function splitTop(str) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of str) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseShadow(css) {
  if (!css || css === 'none') return null;
  const layers = splitTop(css);
  const first = layers.find((l) => !/inset/.test(l));
  if (!first) return null;
  const color = (first.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}/i) || ['rgba(0,0,0,0.5)'])[0];
  const nums = first.replace(color, '').match(/-?\d+(\.\d+)?px/g)?.map(parseFloat) || [];
  const [horizontal = 0, vertical = 0, blur = 0, spread = 0] = nums;
  return { horizontal, vertical, blur, spread, color: cssColorToHex(color) };
}

function parseTextShadow(css) {
  if (!css || css === 'none') return null;
  const first = splitTop(css)[0];
  const color = (first.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}/i) || ['rgba(0,0,0,0.3)'])[0];
  const nums = first.replace(color, '').match(/-?\d+(\.\d+)?px/g)?.map(parseFloat) || [];
  const [horizontal = 0, vertical = 0, blur = 0] = nums;
  return { horizontal, vertical, blur, color: cssColorToHex(color) };
}

// CSS background-position → Elementor's preset names (or a custom x/y).
function bgPosition(pos) {
  if (!pos) return { preset: 'center center' };
  const [x = '50%', y = '50%'] = pos.split(/\s+/);
  const name = (v, axis) => ({ '0%': axis === 'x' ? 'left' : 'top', '50%': 'center', '100%': axis === 'x' ? 'right' : 'bottom' }[v]);
  const nx = name(x, 'x');
  const ny = name(y, 'y');
  if (nx && ny) return { preset: `${ny} ${nx}` };
  const val = (v) => ({ unit: /%/.test(v) ? '%' : 'px', size: parseFloat(v) || 0, sizes: [] });
  return { preset: 'initial', x: val(x), y: val(y) };
}

const RATIOS = [['169', 16 / 9], ['219', 21 / 9], ['43', 4 / 3], ['32', 3 / 2], ['11', 1], ['916', 9 / 16]];
// One of the Video widget's presets when it is within 1% of the box, otherwise the
// exact ratio (the control prints any value into its aspect-ratio variable).
const nearestRatio = (w, h) => {
  const ratio = w / Math.max(1, h);
  const best = RATIOS.reduce((b, r) => (Math.abs(r[1] - ratio) < Math.abs(b[1] - ratio) ? r : b));
  return Math.abs(best[1] - ratio) / ratio <= 0.01 ? best[0] : String(Math.round(ratio * 10000) / 10000);
};

function youtubeId(src) {
  return src.match(/(?:embed\/|youtu\.be\/|[?&]v=)([\w-]{6,})/)?.[1] || null;
}
function vimeoId(src) {
  return src.match(/(?:video\/|vimeo\.com\/)(\d+)/)?.[1] || null;
}
const flag = (src, name) => new RegExp(`[?&]${name}=1`).test(src) ? 'yes' : '';

export class TemplateBuilder {
  constructor({ tagSource = false } = {}) {
    this.fontNotes = new Map();
    this.fontsUsed = new Set();
    // Google fonts written inside rich text or HTML markup (styled words, form and table snapshots).
    this.inlineFonts = new Set();
    this.notes = new Set();
    // Test mode: give every element a CSS ID that points back to the source box it came from.
    this.tagSource = tagSource;
    this.sourceMap = {};
  }

  tag(el, n) {
    if (!this.tagSource || !el) return el;
    const key = `w2e-${Object.keys(this.sourceMap).length + 1}`;
    el.settings._element_id = key;
    this.sourceMap[key] = { kind: n.kind, widgetType: el.widgetType || el.elType, rect: n.rect, text: n.text?.slice(0, 80), style: n.style || null, background: n.background || null, tag: n.tag };
    return el;
  }

  typography(style, prefix = 'typography') {
    if (!style) return {};
    const s = { [`${prefix}_typography`]: 'custom' };
    if (style.fontFamily) {
      const f = resolveFont(style.fontFamily);
      s[`${prefix}_font_family`] = f.family;
      this.fontsUsed.add(f.family);
      if (f.note) this.fontNotes.set(f.original, f.note);
    }
    if (style.fontSize) {
      s[`${prefix}_font_size`] = slider(style.fontSize);
      // Large type is scaled down on phones so headlines don't overflow.
      if (style.fontSize > 28) s[`${prefix}_font_size_mobile`] = slider(Math.max(24, style.fontSize * 0.7));
    }
    if (style.fontWeight) s[`${prefix}_font_weight`] = String(style.fontWeight);
    if (style.lineHeight) {
      // Unitless, so inline runs with their own font size scale the way they do on the source page.
      s[`${prefix}_line_height`] = style.fontSize
        ? { unit: 'custom', size: String(Math.round((style.lineHeight / style.fontSize) * 1000) / 1000), sizes: [] }
        : slider(style.lineHeight);
    }
    if (style.letterSpacing) s[`${prefix}_letter_spacing`] = slider(style.letterSpacing);
    if (style.wordSpacing) s[`${prefix}_word_spacing`] = slider(style.wordSpacing);
    if (style.textTransform) s[`${prefix}_text_transform`] = style.textTransform;
    if (style.fontStyle) s[`${prefix}_font_style`] = style.fontStyle;
    if (style.textDecoration && /underline|overline|line-through/.test(style.textDecoration)) s[`${prefix}_text_decoration`] = style.textDecoration.split(' ')[0];
    return s;
  }

  // Font stacks inside rich text or HTML markup get the same free look-alike and licence
  // note as widget typography. Style attributes are serialized with &quot; for quotes.
  swapInlineFonts(markup) {
    if (typeof markup !== 'string' || !/font-family/i.test(markup)) return markup;
    const swap = (stack) => {
      const f = resolveInlineFont(stack.replace(/&quot;|&#39;/g, "'"));
      if (!f) return null;
      // System fonts need no loading, so only Google fonts are listed.
      if (isGoogleFont(f.family)) this.inlineFonts.add(f.family);
      if (f.note) this.fontNotes.set(f.original, f.note);
      return f.stack;
    };
    return markup
      .replace(/(\sstyle=")([^"]*)/g, (m, attr, css) => attr + css.replace(/(^|;)(\s*font-family\s*:\s*)((?:&[#\w]+;|[^;])+)/gi, (d, sep, prop, stack) => {
        const out = swap(stack.trim());
        return out ? sep + prop + out : d;
      }))
      // SVG text can name its font as an attribute.
      .replace(/(\sfont-family=")([^"]*)"/g, (m, attr, stack) => {
        const out = swap(stack);
        return out ? `${attr}${out}"` : m;
      });
  }

  textShadow(css, prefix = 'text_shadow') {
    const sh = parseTextShadow(css);
    return sh ? { [`${prefix}_text_shadow_type`]: 'yes', [`${prefix}_text_shadow`]: sh } : {};
  }

  // Text colour; gradient text has no native control, so it falls back to the gradient's first colour.
  textColor(style, opacity) {
    if (style?.gradientText) {
      const g = parseGradient(style.gradientText);
      if (g) {
        this.notes.add('Gradient-filled text uses the gradient\'s main colour (Elementor has no built-in gradient text).');
        return fade(g.a, opacity);
      }
    }
    return fade(style?.color, opacity);
  }

  background(bg, prefix = 'background', { opacity = null, overlay = false } = {}) {
    if (!bg) return {};
    const s = {};
    const grad = parseGradient(bg.gradient);
    if (grad) {
      if (grad.extraStops) this.notes.add('Gradients with more than two colours use their first and last colour.');
      Object.assign(s, {
        [`${prefix}_background`]: 'gradient',
        [`${prefix}_color`]: fade(grad.a, opacity),
        [`${prefix}_color_stop`]: slider(grad.aStop, '%'),
        [`${prefix}_color_b`]: fade(grad.b, opacity),
        [`${prefix}_color_b_stop`]: slider(grad.bStop, '%'),
        [`${prefix}_gradient_type`]: grad.radial ? 'radial' : 'linear',
      });
      if (grad.radial) s[`${prefix}_gradient_position`] = 'center center';
      else s[`${prefix}_gradient_angle`] = slider(grad.angle, 'deg');
      return s;
    }
    if (bg.color || bg.image) s[`${prefix}_background`] = 'classic';
    if (bg.color) s[`${prefix}_color`] = fade(bg.color, opacity);
    if (bg.image) {
      if (/^data:|\.svg(\?|#|$)/i.test(bg.image)) this.notes.add('Some background images are inline data or SVG files, which Elementor cannot import by link. Upload them to the Media Library and pick them in the container\'s Background settings.');
      s[`${prefix}_image`] = media(bg.image);
      const pos = bgPosition(bg.position);
      s[`${prefix}_position`] = pos.preset;
      if (pos.x) Object.assign(s, { [`${prefix}_xpos`]: pos.x, [`${prefix}_ypos`]: pos.y });
      const size = (bg.size || 'cover').trim();
      if (size === 'cover' || size === 'contain' || size === 'auto') s[`${prefix}_size`] = size;
      else {
        const w = size.split(/\s+/)[0];
        s[`${prefix}_size`] = 'initial';
        s[`${prefix}_bg_width`] = { unit: /%/.test(w) ? '%' : 'px', size: parseFloat(w) || 100, sizes: [] };
      }
      s[`${prefix}_repeat`] = ['repeat', 'repeat-x', 'repeat-y', 'no-repeat'].includes(bg.repeat) ? bg.repeat : 'no-repeat';
      if (bg.attachment === 'fixed') s[`${prefix}_attachment`] = 'fixed';
    }
    return s;
  }

  // A gradient (or tint) drawn over a photo → the container's Background Overlay.
  overlay(bg) {
    if (!bg?.overlay) return {};
    const s = this.background({ gradient: bg.overlay }, 'background_overlay');
    if (!s.background_overlay_background) {
      const color = bg.overlay.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}/i)?.[0];
      if (!color) return {};
      Object.assign(s, { background_overlay_background: 'classic', background_overlay_color: cssColorToHex(color) });
    }
    s.background_overlay_opacity = slider(bg.overlayOpacity ?? 1);
    return s;
  }

  border(b, prefix = 'border', radiusKey = 'border_radius', opacity = null) {
    if (!b) return {};
    const s = {};
    if (b.style && b.width) {
      s[`${prefix}_border`] = ['solid', 'dashed', 'dotted', 'double', 'groove'].includes(b.style) ? b.style : 'solid';
      s[`${prefix}_width`] = dims(b.width);
      if (b.color) s[`${prefix}_color`] = fade(b.color, opacity);
    }
    if (b.radius) s[radiusKey] = dims(b.radius, b.radiusUnit || 'px');
    return s;
  }

  shadow(css, prefix) {
    const sh = parseShadow(css);
    if (!sh) return {};
    return { [`${prefix}_box_shadow_type`]: 'yes', [`${prefix}_box_shadow`]: sh };
  }

  // Rotation (Advanced > Transform), shared by widgets and containers.
  transform(n) {
    if (!n.transform?.rotate) return {};
    return { _transform_rotate_popover: 'transform', _transform_rotateZ_effect: { unit: 'deg', size: n.transform.rotate, sizes: [] } };
  }

  // Absolute placement (Advanced > Position), widgets use underscore keys.
  position(n, isContainer) {
    const a = n.absolute;
    if (!a) return {};
    const s = { [isContainer ? 'position' : '_position']: 'absolute', _offset_orientation_h: a.h, _offset_orientation_v: a.v };
    s[a.h === 'end' ? '_offset_x_end' : '_offset_x'] = slider(a.x);
    s[a.v === 'end' ? '_offset_y_end' : '_offset_y'] = slider(a.y);
    // Elementor lifts absolute elements to z-index 1; decorations meant to sit behind content stay at 0 or below.
    const z = a.zIndex != null ? a.zIndex : n.behind ? 0 : null;
    if (z != null) s[isContainer ? 'z_index' : '_z_index'] = z;
    return s;
  }

  // Settings every widget shares (Elementor's "Advanced" tab): spacing, width,
  // box styling, grid placement, position and rotation.
  // strut: [top, bottom] px of the theme's 24px text line box around inline-block widgets (icons, small images), cancelled with negative margins.
  common(n, ctx, { boxed = true, strut = null } = {}) {
    const [st, sb] = strut || [0, 0];
    const s = { _margin: dims([(n.marginTop || 0) - st, 0, -sb, n.marginLeft || 0]) };
    // Rows stack on phones, so the space kept before an item in its row goes there.
    if (n.marginLeft && ctx?.direction === 'row' && !ctx.grid) s._margin_mobile = dims([(n.marginTop || 0) - st, 0, -sb, 0]);
    const op = n.opacity;
    if (boxed) {
      if (n.padding && n.padding.some((v) => v > 0) && (n.background || n.border?.style || ['heading', 'text'].includes(n.kind))) s._padding = dims(n.padding);
      if (n.background) Object.assign(s, this.background(n.background, '_background', { opacity: op }));
      if (n.border) Object.assign(s, this.border(n.border, '_border', '_border_radius', op));
      Object.assign(s, this.shadow(n.shadow, '_box_shadow'));
    }
    if (n.absolute) {
      Object.assign(s, this.position(n, false));
      s._element_width = 'initial';
      s._element_custom_width = slider(n.rect.w);
    } else if (ctx?.grid) {
      if (n.gridItem?.colSpan > 1) Object.assign(s, { _grid_column: String(Math.min(12, n.gridItem.colSpan)), _grid_column_mobile: '1' });
      if (n.gridItem?.rowSpan > 1) s._grid_row = String(Math.min(12, n.gridItem.rowSpan));
    } else if (ctx?.direction === 'row') {
      if (n.autoWidth) s._element_width = 'auto';
      else if (n.widthPct) {
        s._element_width = 'initial';
        s._element_custom_width = n.widthCalc ? { unit: 'custom', size: n.widthCalc, sizes: [] } : slider(n.widthPct, '%');
        s._element_width_mobile = 'inherit';
      }
    } else if (n.alignSelf && n.autoWidth) {
      s._element_width = 'auto';
      s._flex_align_self = n.alignSelf === 'center' ? 'center' : n.alignSelf === 'end' ? 'flex-end' : 'flex-start';
    } else if (n.alignSelf && n.widthPct) {
      // Narrower than its column (inset text, small embeds): keep the width and side.
      s._element_width = 'initial';
      s._element_custom_width = slider(n.widthPct, '%');
      s._element_width_mobile = 'inherit';
      s._flex_align_self = n.alignSelf === 'center' ? 'center' : n.alignSelf === 'end' ? 'flex-end' : 'flex-start';
    }
    Object.assign(s, this.transform(n));
    return s;
  }

  widget(widgetType, settings, elements = []) {
    for (const k of ['title', 'editor', 'html']) if (settings[k]) settings[k] = this.swapInlineFonts(settings[k]);
    return { id: id(), elType: 'widget', settings: compact(settings), elements, widgetType };
  }

  node(n, ctx) {
    return this.tag(this.makeNode(n, ctx), n);
  }

  makeNode(n, ctx) {
    if (ctx?.inLink && n.kind !== 'container') n = unlinked(n);
    switch (n.kind) {
      case 'container': return this.container(n, ctx);
      case 'heading': return this.heading(n, ctx);
      case 'text': return this.text(n, ctx);
      case 'button': return this.button(n, ctx);
      case 'image': return this.image(n, ctx);
      case 'icon': return this.icon(n, ctx);
      case 'svg': return this.svg(n, ctx);
      case 'divider': return this.divider(n, ctx);
      case 'spacer': return this.widget('spacer', { space: slider(n.height || 20), ...this.common(n, ctx) });
      case 'embed': return this.embed(n, ctx);
      case 'video': return this.video(n, ctx);
      case 'audio': return this.html(n, ctx, n.markup || `<audio controls style="width:100%"></audio>`);
      case 'html': return n.role === 'table' ? this.table(n, ctx) : this.html(n, ctx, n.markup);
      case 'accordion': return this.accordion(n, ctx);
      case 'tabs': return this.tabs(n, ctx);
      case 'iconList': return this.iconList(n, ctx);
      case 'social': return this.social(n, ctx);
      case 'rating': return this.rating(n, ctx);
      case 'progress': return this.progress(n, ctx);
      default:
        this.notes.add(`An unrecognised element ("${n.kind}") was skipped.`);
        return null;
    }
  }

  heading(n, ctx) {
    const level = Math.min(6, Math.max(1, n.level || 2));
    return this.widget('heading', {
      title: n.html && /<(span|a|b|strong|em|i|br|sup|sub|u|mark)\b/.test(n.html) ? sanitizeMarkup(n.html) : n.text,
      header_size: `h${level}`,
      align: alignValue(n.align),
      title_color: this.textColor(n.style, n.opacity),
      link: n.href ? link(n.href) : null,
      ...this.typography(n.style),
      ...this.textShadow(n.style?.textShadow),
      ...this.common(n, ctx),
    });
  }

  text(n, ctx) {
    let html = n.html || n.text || '';
    let pad = n.padding;
    // Code blocks: the browser's 1em margins and the theme's plain monospace are cleared, so the widget's spacing and font show.
    if (n.pre) html = `<pre style="margin:0;font-family:inherit">${html}</pre>`;
    // The quote's spacing comes from the widget; the browser's default 40px blockquote indent is cleared.
    else if (n.quote) html = `<blockquote style="margin:0">${html}</blockquote>`;
    else if (/^<(ul|ol)\b/.test(html)) {
      // List indent and bullet style written on the list itself, the way the editor's own list tools store it.
      const st = [];
      // The indent lives on the list, not on the widget as well.
      if (n.listPadding != null) {
        st.push(`padding-left:${r1(n.listPadding)}px`);
        if (pad) pad = [pad[0], pad[1], pad[2], 0];
      }
      if (n.listStyle && !['disc', 'decimal'].includes(n.listStyle)) st.push(`list-style-type:${n.listStyle}`);
      st.push('margin:0');
      html = html.replace(/^<(ul|ol)\b([^>]*)>/, `<$1$2 style="${st.join(';')}">`);
    // Rich markup (an aligned image and the paragraphs wrapping around it) is already in blocks.
    } else if (!n.rich && !/^<p\b/.test(html)) {
      // A link shown as a block (a nav item, "Read more"): its words carry the link the way the
      // editor writes one, with their own colour so the theme's link colour doesn't show.
      if (n.href) html = `<a href="${n.href.replace(/"/g, '&quot;')}" style="color:${this.textColor(n.style, n.opacity)};text-decoration:${n.style?.textDecoration || 'none'}">${html}</a>`;
      html = `<p>${html}</p>`;
    }
    return this.widget('text-editor', {
      editor: untexturize(sanitizeMarkup(html)),
      align: alignValue(n.align),
      text_color: this.textColor(n.style, n.opacity),
      paragraph_spacing: slider(n.paragraphSpacing || 0),
      ...this.typography(n.style),
      ...this.textShadow(n.style?.textShadow),
      ...this.common({ ...n, padding: pad }, ctx),
    });
  }

  button(n, ctx) {
    const st = n.style || {};
    const bw = n.border?.width || [0, 0, 0, 0];
    const pad = [...(n.padding || [12, 24, 12, 24])];
    // Fixed-size buttons (height/min-width with centred text) keep their size through padding.
    const lh = st.lineHeight || (st.fontSize || 16) * 1.2;
    const vSpace = (n.rect?.h || 0) - bw[0] - bw[2] - lh;
    if (n.rect?.h && pad[0] + pad[2] < vSpace - 2) pad[0] = pad[2] = r1(vSpace / 2);
    const stretched = n.fullWidth || (ctx?.direction === 'row' && !n.autoWidth);
    if (n.textW && n.rect?.w && !stretched) {
      // Elementor draws button icons 1em wide (there is no size control), so that is what the padding makes room for.
      const iconW = n.icon ? (st.fontSize || 16) + (n.icon.gap || 0) : 0;
      const hSpace = n.rect.w - bw[1] - bw[3] - n.textW - iconW;
      if (pad[1] + pad[3] < hSpace - 2) pad[1] = pad[3] = r1(hSpace / 2);
    }
    const s = {
      text: n.text || 'Button',
      link: link(n.href && n.href !== '#' ? n.href : ctx?.cardHref || n.href || '#'),
      // Outline / text-only buttons: clear the theme's default button colour.
      ...(n.background ? {} : { background_background: 'classic', background_color: '#FFFFFF00' }),
      align: stretched ? 'justify' : n.align === 'center' ? 'center' : n.align === 'end' ? 'right' : 'left',
      button_text_color: this.textColor(st, n.opacity),
      ...this.typography(st),
      ...this.textShadow(st.textShadow, 'text_shadow'),
      ...this.background(n.background, 'background', { opacity: n.opacity }),
      ...this.border(n.border, 'border', 'border_radius', n.opacity),
      ...this.shadow(n.shadow, 'button_box_shadow'),
      text_padding: dims(pad),
      ...this.common({ ...n, background: null, border: null, shadow: null, padding: null }, ctx),
    };
    if (n.icon?.fa) {
      s.selected_icon = n.icon.fa;
      s.icon_align = n.icon.position === 'right' ? 'row-reverse' : 'row';
      s.icon_indent = slider(n.icon.gap || 8);
    }
    return this.widget('button', s);
  }

  image(n, ctx) {
    if (!n.src) {
      this.notes.add('Canvas drawings that could not be captured were replaced with image placeholders.');
      n = { ...n, src: `https://placehold.co/${Math.round(n.rect?.w || 300)}x${Math.round(n.rect?.h || 200)}.png` };
    }
    const s = {
      image: { ...media(n.src), alt: n.alt || '' },
      image_size: 'full',
      align: alignValue(n.align),
      // Linked images size against the link's own box, so they always get a pixel width.
      width: n.widthPx || n.href ? slider(n.widthPx || n.rect?.w || 300) : slider(100, '%'),
      space: slider(100, '%'),
      link_to: n.href ? 'custom' : null,
      link: n.href ? link(n.href) : null,
      opacity: n.opacity != null ? slider(n.opacity) : null,
      ...this.border(n.border, 'image_border', 'image_border_radius'),
      ...this.shadow(n.shadow, 'image_box_shadow'),
      ...this.common({ ...n, background: null, border: null, shadow: null }, ctx, { strut: n.rect?.h < 28 && !n.absolute ? [Math.max(0, 13.6 - n.rect.h / 2), Math.max(0, 10.4 - n.rect.h / 2)] : null }),
    };
    if (n.rect?.h) {
      s.height = slider(n.rect.h);
      s['object-fit'] = n.objectFit && n.objectFit !== 'fill' ? n.objectFit : 'cover';
      if (n.objectPosition && n.objectPosition !== '50% 50%') {
        const pos = bgPosition(n.objectPosition);
        if (pos.preset !== 'initial') s['object-position'] = pos.preset;
      }
      s.height_mobile = { unit: 'custom', size: 'auto', sizes: [] };
    }
    return this.widget('image', s);
  }

  // Icons become Elementor's Icon widget with the closest Font Awesome glyph.
  // When the user owns the artwork, the exact SVG goes in an HTML widget only where
  // no one-colour glyph can stand in: multi-colour artwork, or a logo with no close glyph.
  icon(n, ctx) {
    const weak = ['weak', 'none'].includes(n.faConfidence);
    if (n.svg && (n.artwork || (weak && /\blogo/.test(n.hints || '')))) return this.svg(n, ctx);
    if (weak) this.notes.add('Some icons have no close Font Awesome match, so the Icon widget shows the nearest one. Pick another there if it does not fit.');
    const size = Math.max(6, n.size || Math.max(n.rect?.w || 16, n.rect?.h || 16));
    const boxH = n.rect?.h || size;
    const s = {
      selected_icon: n.fa || { value: 'fas fa-circle', library: 'fa-solid' },
      align: alignValue(n.align),
      size: slider(size),
      link: n.href ? link(n.href) : null,
      ...this.common({ ...n, background: null, border: null, shadow: null, padding: null }, ctx, { strut: n.absolute ? null : [Math.max(0, 18 - boxH), 6] }),
    };
    const bg = n.background?.color;
    const bw = n.border?.width && Math.max(...n.border.width);
    if (bg || bw) {
      s.view = bg ? 'stacked' : 'framed';
      const boxW = n.rect?.w || size;
      s.icon_padding = slider(Math.max(0, (boxW - size - (bg ? 0 : 2 * bw)) / 2));
      const rad = n.border?.radius ? Math.max(...n.border.radius) : 0;
      const circle = n.border?.radiusUnit === '%' ? rad >= 50 : rad >= boxW / 2 - 1;
      s.shape = circle ? 'circle' : rad > 0 ? 'rounded' : 'square';
      if (s.shape === 'rounded') s.border_radius = dims(n.border.radius, n.border.radiusUnit || 'px');
      if (bg) {
        s.primary_color = fade(bg, n.opacity);
        s.secondary_color = fade(n.color, n.opacity);
      } else {
        s.primary_color = fade(n.color, n.opacity);
        s.border_width = dims(n.border.width);
      }
    } else {
      s.primary_color = fade(n.color, n.opacity) || '#333333';
      // An icon-only button keeps its click area: the glyph sits centred in the button's box.
      const padY = r1(((n.rect?.h || size) - size) / 2), padX = r1(((n.rect?.w || size) - size) / 2);
      if (n.buttonBox && (padX >= 1 || padY >= 1)) s._padding = dims([padY, padX, padY, padX]);
    }
    if (n.transform?.rotate) {
      s.rotate = { unit: 'deg', size: n.transform.rotate, sizes: [] };
      delete s._transform_rotate_popover;
      delete s._transform_rotateZ_effect;
    }
    return this.widget('icon', s);
  }

  svgHtml(n, ctx) {
    const align = n.align === 'center' ? 'center' : n.align === 'end' ? 'right' : 'left';
    let svg = sanitizeMarkup(n.svg);
    svg = fluidSvg(svg);
    // Rounded or circular crops of the artwork (an <img> with border-radius).
    const rad = n.border?.radius;
    if (rad?.some((r) => r > 0)) {
      const css = rad.map((r) => `${r}${n.border.radiusUnit || 'px'}`).join(' ');
      svg = `<span style="display:inline-block;overflow:hidden;border-radius:${css}">${svg}</span>`;
    }
    const href = n.href && /^(https?:|mailto:|tel:|#|\/)/i.test(n.href) ? n.href.replace(/"/g, '&quot;') : null;
    const s = {
      html: `<div style="line-height:0;text-align:${align}">${href ? `<a href="${href}" style="display:inline-block">${svg}</a>` : svg}</div>`,
      ...this.common({ ...n, background: null, border: null, shadow: null, padding: null }, ctx),
    };
    // In a column the widget box is as wide as the artwork, like the source element.
    if (n.widthPx && ctx?.direction !== 'row' && !n.absolute && !s._element_width) {
      Object.assign(s, { _element_width: 'initial', _element_custom_width: slider(n.widthPx), _element_width_mobile: 'inherit', _flex_align_self: align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start' });
    }
    return this.widget('html', s);
  }

  // Inline SVG artwork (illustrations, logos): kept as-is only when the user owns it.
  svg(n, ctx) {
    if (n.svg) {
      this.notes.add('Inline SVG artwork was kept in HTML widgets (no Elementor widget draws custom vector art).');
      return this.svgHtml(n, ctx);
    }
    return this.image({ ...n, kind: 'image' }, ctx);
  }

  divider(n, ctx) {
    return this.widget('divider', {
      style: ['solid', 'dashed', 'dotted', 'double'].includes(n.style) ? n.style : 'solid',
      weight: slider(n.weight || 1),
      color: fade(n.color, n.opacity) || '#000000',
      width: slider(100, '%'),
      align: n.align === 'center' ? 'center' : n.align === 'end' ? 'right' : 'left',
      gap: slider(0),
      _flex_align_self: ctx?.direction === 'row' ? 'center' : null,
      ...this.common({ ...n, padding: null, border: null }, ctx),
    });
  }

  embed(n, ctx) {
    if (n.provider === 'youtube' || n.provider === 'vimeo') return this.video({ ...n, kind: 'video' }, ctx);
    if (n.provider === 'maps') {
      const src = n.src || '';
      const dec = (v) => { try { return decodeURIComponent(v.replace(/\+/g, ' ')); } catch { return v; } };
      const q = src.match(/[?&]q=([^&]+)/)?.[1];
      // /maps/embed?pb=… links carry the place name (!2s) or the centre (!2d lng, !3d lat).
      const pbName = src.match(/!2s([^!&]+)/)?.[1];
      const lng = src.match(/!2d(-?[\d.]+)/)?.[1], lat = src.match(/!3d(-?[\d.]+)/)?.[1];
      const address = n.address ?? (q ? dec(q) : pbName && !/^0x/.test(pbName) ? dec(pbName) : lat && lng ? `${lat},${lng}` : null);
      return this.widget('google_maps', {
        address: address || 'London Eye, London, United Kingdom',
        zoom: slider(Number(src.match(/[?&]z(?:oom)?=(\d+)/)?.[1]) || 14),
        height: slider(n.rect?.h || 300),
        ...this.border(n.border, '_border', '_border_radius'),
        ...this.common({ ...n, border: null, padding: null }, ctx),
      });
    }
    const h = n.rect?.h || 400;
    const src = /^https?:\/\//i.test(n.src || '') ? n.src.replace(/"/g, '&quot;') : 'about:blank';
    this.notes.add('Embedded third-party frames were kept in HTML widgets (no native widget exists for them).');
    return this.html(n, ctx, `<iframe src="${src}" title="${(n.title || '').replace(/"/g, '&quot;')}" width="100%" height="${h}" style="border:0;display:block"${n.lazy ? ' loading="lazy"' : ''}></iframe>`, { allowIframe: true });
  }

  video(n, ctx) {
    const src = n.src || '';
    const s = {
      aspect_ratio: nearestRatio(n.rect?.w || 16, n.rect?.h || 9),
      ...this.border(n.border, '_border', '_border_radius'),
      ...this.common({ ...n, border: null, padding: null }, ctx),
    };
    if (n.placeholderMedia) {
      // Design-only copy: a same-size cover image with a play button; the user drops in their own video.
      Object.assign(s, { video_type: 'youtube', show_image_overlay: 'yes', image_overlay: media(n.placeholderMedia), show_play_icon: 'yes' });
      this.notes.add('Videos show a placeholder cover; paste your own video link in each Video widget.');
    } else if (n.provider === 'youtube' || youtubeId(src)) {
      const vid = youtubeId(src);
      Object.assign(s, { video_type: 'youtube', youtube_url: vid ? `https://www.youtube.com/watch?v=${vid}` : src, autoplay: flag(src, 'autoplay'), mute: flag(src, 'mute'), loop: flag(src, 'loop'), controls: /[?&]controls=0/.test(src) ? '' : 'yes', yt_privacy: /nocookie/.test(src) ? 'yes' : '' });
    } else if (n.provider === 'vimeo' || vimeoId(src)) {
      const off = (k) => (new RegExp(`[?&]${k}=(0|false)`).test(src) ? '' : 'yes');
      Object.assign(s, { video_type: 'vimeo', vimeo_url: `https://vimeo.com/${vimeoId(src) || ''}`, autoplay: flag(src, 'autoplay'), mute: flag(src, 'muted'), loop: flag(src, 'loop'), vimeo_title: off('title'), vimeo_byline: off('byline'), vimeo_portrait: off('portrait') });
    } else {
      Object.assign(s, {
        video_type: 'hosted', insert_url: 'yes', external_url: link(src),
        autoplay: n.autoplay ? 'yes' : '', mute: n.muted ? 'yes' : '', loop: n.loop ? 'yes' : '', controls: n.controls === false ? '' : 'yes',
        play_on_mobile: n.playsinline ? 'yes' : '',
        // A plain <video> offers download in its menu; Elementor hides it unless asked.
        download_button: 'yes',
        poster: n.poster ? media(n.poster) : null,
      });
    }
    return this.widget('video', s);
  }

  // Tables go into the Text Editor: it renders table markup natively, keeps it
  // editable, and survives imports by users who may not add raw HTML.
  table(n, ctx) {
    this.notes.add('Tables were rebuilt in Text Editor widgets with their original styling (Elementor has no table widget). Edit the cells there.');
    return this.widget('text-editor', {
      editor: untexturize(sanitizeMarkup(n.markup)),
      paragraph_spacing: slider(0),
      ...this.common({ ...n, background: null, border: null, shadow: null, padding: null }, ctx),
    });
  }

  html(n, ctx, markup, opts) {
    if (n.kind === 'audio') {
      // In design-only mode the sound file is not copied, so the player starts empty.
      this.notes.add(/\ssrc=/i.test(markup || '') ? 'Audio players were kept in HTML widgets (free Elementor has no audio widget).' : 'Audio players were kept in HTML widgets (free Elementor has no audio widget) without their sound files. Add a link to your own file in each one (the src attribute of <audio>).');
    }
    if (n.role === 'form') this.notes.add('Forms were kept in HTML widgets with their original styling (free Elementor has no form widget). Connect them to your form plugin.');
    if (n.role === 'image') {
      this.notes.add('Images embedded as inline data were kept in HTML widgets, because Elementor can only import images by link. Upload them to the Media Library and swap in an Image widget if you want to edit them.');
      const align = n.align === 'center' ? 'center' : n.align === 'end' ? 'right' : 'left';
      markup = `<div style="line-height:0;text-align:${align}">${markup || ''}</div>`;
    }
    return this.widget('html', { html: sanitizeMarkup(markup, opts), ...this.common({ ...n, background: null, border: null, shadow: null, padding: null }, ctx) });
  }

  accordion(n, ctx) {
    const first = n.items[0] || {};
    const ts = first.titleStyle || {};
    const s = {
      items: n.items.map((it) => ({ _id: id(), item_title: it.title, element_css_id: '' })),
      default_state: first.open ? 'expanded' : 'all_collapsed',
      max_items_expended: n.items.filter((it) => it.open).length > 1 ? 'multiple' : 'one',
      title_tag: 'div',
      accordion_item_title_space_between: slider(n.gap || 0),
      accordion_item_title_distance_from_content: slider(0),
      accordion_padding: dims(first.titlePadding || [0, 0, 0, 0]),
      ...this.typography(ts, 'title_typography'),
      normal_title_color: cssColorToHex(ts.color),
      hover_title_color: cssColorToHex(ts.color),
      active_title_color: cssColorToHex(first.titleStyleOpen?.color || ts.color),
      normal_icon_color: cssColorToHex(ts.color),
      hover_icon_color: cssColorToHex(ts.color),
      active_icon_color: cssColorToHex(first.titleStyleOpen?.color || ts.color),
      icon_size: slider(Math.round((ts.fontSize || 16) * 0.8)),
      ...this.common({ ...n, background: null, border: null, shadow: null, padding: null }, ctx),
    };
    const bg = first.titleBackground || first.itemBackground;
    const ib = first.itemBorder;
    const bgOpen = first.titleBackgroundOpen && (first.titleBackgroundOpen.color || first.titleBackgroundOpen.gradient) ? first.titleBackgroundOpen : bg;
    // Items stacked with shared edges (Bootstrap style: later items drop their top
    // border). Titles can only share one border, so the outer frame goes on the widget
    // and each item keeps just the rule under it.
    const joined = n.items.length > 1 && !n.gap && ib?.style && ib.width[0] > 0 && n.items[1].itemBorder?.width?.[0] === 0;
    for (const state of ['normal', 'hover', 'active']) {
      const fill = state === 'active' ? bgOpen : bg;
      Object.assign(s, this.background(fill && { color: fill.color, gradient: fill.gradient }, `accordion_background_${state}`));
      // A border around the whole item: the open title loses its bottom edge and the panel carries the rest.
      let w = ib?.width && state === 'active' ? [ib.width[0], ib.width[1], 0, ib.width[3]] : ib?.width;
      if (joined) w = [0, 0, state === 'active' ? 0 : ib.width[2], 0];
      Object.assign(s, this.border(ib && { ...ib, width: w, radius: null }, `accordion_border_${state}`));
    }
    if (joined) {
      Object.assign(s, this.border({ ...ib, width: [ib.width[0], ib.width[1], 0, ib.width[3]], radius: null }, '_border'));
      if (ib.radius) s._border_radius = dims([ib.radius[0], ib.radius[1], 0, 0], ib.radiusUnit || 'px');
      Object.assign(s, this.border({ ...ib, width: [0, 0, ib.width[2], 0], radius: null }, 'content_border'));
    } else if (ib?.style) {
      if (ib.radius) s.accordion_border_radius = dims(ib.radius, ib.radiusUnit || 'px');
      Object.assign(s, this.border({ ...ib, width: [0, ib.width[1], ib.width[2], ib.width[3]], radius: null }, 'content_border'));
      if (ib.radius) s.content_border_radius = dims([0, 0, ib.radius[2], ib.radius[3]], ib.radiusUnit || 'px');
    } else {
      if (ib?.radius) s.accordion_border_radius = dims(ib.radius, ib.radiusUnit || 'px');
      s.content_border_border = 'none';
    }
    if (first.itemBackground?.color) Object.assign(s, this.background({ color: first.itemBackground.color }, 'content_background'));
    // The browser's own disclosure triangle → caret icons at the start of the title.
    if (first.marker === 'caret') {
      Object.assign(s, {
        accordion_item_title_icon: { value: 'fas fa-caret-right', library: 'fa-solid' },
        accordion_item_title_icon_active: { value: 'fas fa-caret-down', library: 'fa-solid' },
        accordion_item_title_icon_position: 'start',
        icon_spacing: slider(first.markerGap ?? 8),
        icon_size: slider(Math.round(ts.fontSize || 16)),
      });
    } else if (first.marker === 'none') {
      Object.assign(s, { accordion_item_title_icon: { value: '', library: '' }, accordion_item_title_icon_active: { value: '', library: '' } });
    } else {
      // The summary's own icon (plus, chevron...) in its closed and open states.
      const closed = (n.items.find((it) => !it.open) || first).markerClosed;
      const open = (n.items.find((it) => it.open) || first).markerOpen;
      const end = first.markerEnd || !closed;
      Object.assign(s, {
        accordion_item_title_icon_position: end ? 'end' : 'start',
        accordion_item_title_position_horizontal: end ? 'stretch' : 'start',
      });
      if (closed?.fa) {
        Object.assign(s, {
          accordion_item_title_icon: closed.fa,
          accordion_item_title_icon_active: openIconFor(closed, open),
          icon_size: slider(closed.size || 16),
          normal_icon_color: cssColorToHex(closed.color) || s.normal_icon_color,
          hover_icon_color: cssColorToHex(closed.color) || s.hover_icon_color,
          active_icon_color: cssColorToHex(open?.color || closed.color) || s.active_icon_color,
        });
      } else {
        // Drawn by CSS (e.g. Bootstrap's ::after chevron): the closest stock pair.
        Object.assign(s, {
          accordion_item_title_icon: { value: 'fas fa-chevron-down', library: 'fa-solid' },
          accordion_item_title_icon_active: { value: 'fas fa-chevron-up', library: 'fa-solid' },
        });
      }
    }
    const panels = n.items.map((it) => {
      const c = it.content || { kind: 'container', rect: it.rect, direction: 'column', padding: [0, 0, 0, 0], children: [], gap: { column: 0, row: 0 } };
      const el = this.container({ ...c, marginTop: 0, absolute: null, widthPct: null, alignSelf: null }, { direction: 'column', nested: true });
      el.settings._title = it.title.slice(0, 60);
      el.settings.content_width = 'full';
      return el;
    });
    return this.widget('nested-accordion', s, panels);
  }

  tabs(n, ctx) {
    const ts = n.titleStyle || {};
    const as = n.activeStyle || ts;
    const vertical = n.direction === 'inline-start';
    const just = { center: 'center', 'flex-end': 'end', end: 'end', right: 'end' }[n.justify] || 'start';
    const s = {
      tabs: n.tabs.map((t) => ({ _id: id(), tab_title: t.title, tab_icon: { value: '', library: '' }, element_id: '' })),
      tabs_direction: vertical ? 'inline-start' : 'block-start',
      // The source keeps its tabs on phones, so they don't turn into an accordion.
      breakpoint_selector: 'none',
      title_alignment: n.titleAlign || 'start',
      tabs_title_space_between: slider(n.gap || 0),
      tabs_title_spacing: slider(n.spacing || 0),
      padding: dims(n.titlePadding || [0, 0, 0, 0]),
      ...this.typography(ts, 'title_typography'),
      title_text_color: cssColorToHex(ts.color),
      title_text_color_hover: cssColorToHex(ts.color),
      title_text_color_active: cssColorToHex(as.color || ts.color),
      ...this.common({ ...n, background: null, border: null, shadow: null, padding: null }, ctx),
    };
    if (vertical) Object.assign(s, { tabs_width: slider(n.headingWidth || 240), tabs_justify_vertical: 'start' });
    else s.tabs_justify_horizontal = n.fill ? 'stretch' : just;
    // Every state is written out, so Elementor's grey and accent-green defaults never show.
    const clear = '#FFFFFF00';
    const states = [['', n.titleBackground, n.titleBorder], ['_hover', n.titleBackground, n.titleBorder], ['_active', n.activeBackground, n.activeBorder]];
    for (const [state, bg, b] of states) {
      const prefix = `tabs_title_background_color${state}`;
      const fill = this.background(bg && { color: bg.color, gradient: bg.gradient }, prefix);
      Object.assign(s, fill[`${prefix}_background`] ? fill : { [`${prefix}_background`]: 'classic', [`${prefix}_color`]: clear });
      Object.assign(s, this.border(b && { ...b, radius: null }, `tabs_title_border${state}`));
    }
    const radius = n.titleBorder?.radius || n.activeBorder?.radius;
    if (radius) s.tabs_title_border_radius = dims(radius, (n.titleBorder?.radius ? n.titleBorder : n.activeBorder).radiusUnit || 'px');
    // The panels' shared frame. A rule under the tab strip has no control of its own,
    // so it becomes the top edge of the panel.
    const box = n.box || {};
    const hb = n.headingBorder;
    const rule = !vertical && hb?.width?.[2] > 0 && !(box.border?.width?.[0] > 0);
    if (box.border?.style || rule) {
      const b = box.border?.style ? { ...box.border } : { style: hb.style, width: [0, 0, 0, 0], color: hb.color };
      if (rule) b.width = [hb.width[2], ...(b.width || [0, 0, 0, 0]).slice(1)];
      Object.assign(s, this.border({ ...b, radius: null }, 'box_border'));
      if (box.border?.radius) s.box_border_radius = dims(box.border.radius, box.border.radiusUnit || 'px');
    }
    if (box.background) Object.assign(s, this.background({ color: box.background.color, gradient: box.background.gradient }, 'box_background_color'));
    const panels = n.panels.map((p, i) => {
      const c = p || { kind: 'container', rect: n.rect, direction: 'column', padding: [0, 0, 0, 0], children: [], gap: { column: 0, row: 0 } };
      const el = this.container({ ...c, marginTop: 0, absolute: null, widthPct: null, alignSelf: null }, { direction: 'column', nested: true });
      el.settings._title = n.tabs[i].title.slice(0, 60);
      el.settings.content_width = 'full';
      return el;
    });
    return this.widget('nested-tabs', s, panels);
  }

  iconList(n, ctx) {
    const first = n.items[0] || {};
    const st = first.style || {};
    return this.widget('icon-list', {
      view: n.layout === 'inline' ? 'inline' : 'traditional',
      icon_list: n.items.map((it) => ({ _id: id(), text: it.text, selected_icon: n.noIcons ? { value: '', library: '' } : it.icon?.fa || { value: 'fas fa-check', library: 'fa-solid' }, link: link(it.href || '') })),
      space_between: slider(n.space || 0),
      icon_align: alignValue(n.align),
      icon_color: fade(first.icon?.color, n.opacity),
      icon_size: slider(first.icon?.size || 14),
      // The widget already puts a quarter of the icon size plus 5px between icon and text.
      text_indent: slider(Math.max(0, (first.textGap ?? 8) - 0.25 * (first.icon?.size || 14) - 5)),
      text_color: this.textColor(st, n.opacity),
      // Each row is as tall as the text's line, so the source row height goes into the line height.
      ...this.typography(first.lineBox ? { ...st, lineHeight: first.lineBox } : st, 'icon_typography'),
      ...this.common({ ...n, background: null, border: null, shadow: null, padding: null }, ctx),
    });
  }

  social(n, ctx) {
    const it0 = n.items[0] || {};
    const iconSize = it0.icon?.size || 16;
    const box = it0.boxSize || iconSize + 16;
    const rad = it0.border?.radius ? Math.max(...it0.border.radius) : 0;
    const circle = it0.border?.radiusUnit === '%' ? rad >= 50 : rad >= box / 2 - 1;
    const shape = circle ? 'circle' : rad > 0 ? 'rounded' : 'square';
    const s = {
      social_icon_list: n.items.map((it) => ({ _id: id(), social_icon: it.icon?.fa || { value: 'fas fa-link', library: 'fa-solid' }, link: link(it.href, true), item_icon_color: 'default' })),
      shape,
      columns: '0',
      align: n.align === 'center' ? 'center' : n.align === 'end' ? 'right' : 'left',
      icon_color: 'custom',
      icon_primary_color: fade(it0.background?.color, n.opacity) || '#FFFFFF00',
      icon_secondary_color: fade(it0.icon?.color, n.opacity) || '#333333',
      icon_size: slider(iconSize),
      icon_padding: slider(Math.max(0, (box - iconSize - 2 * (it0.border?.width ? Math.max(...it0.border.width) : 0)) / 2)),
      icon_spacing: slider(n.gap ?? 8),
      ...this.border({ ...it0.border, radius: null }, 'image_border'),
      ...this.common({ ...n, background: null, border: null, shadow: null, padding: null }, ctx),
    };
    if (shape === 'rounded') s.border_radius = dims(it0.border.radius, it0.border.radiusUnit || 'px');
    return this.widget('social-icons', s);
  }

  rating(n, ctx) {
    const s = {
      rating_scale: slider(n.max || 5),
      rating_value: n.value ?? n.max ?? 5,
      rating_icon: { value: 'fas fa-star', library: 'fa-solid' },
      icon_size: slider(n.size || 16),
      icon_gap: slider(n.gap || 0),
      icon_color: fade(n.color, n.opacity) || '#F0AD4E',
      icon_unmarked_color: n.unmarkedColor ? cssColorToHex(n.unmarkedColor) : '#CCD6DF',
      icon_alignment: alignValue(n.align === 'left' ? 'start' : n.align === 'right' ? 'end' : n.align),
      ...this.common({ ...n, background: null, border: null, shadow: null, padding: null }, ctx),
    };
    // Stars typed as text sit in a taller line box; the extra height is kept as padding.
    // A box taller than its line (stretched by its row, or a set height) has the stars at
    // its top: in a column the rest goes below them, in a row the row stretches the widget.
    const h = n.rect?.h || 0;
    const line = Math.min(h, n.lineHeight || (n.size || 16) * 1.2);
    const extra = Math.max(0, r1((line - (n.size || 16)) / 2));
    const below = ctx?.direction === 'row' ? 0 : r1(h - line);
    if (extra >= 1 || below >= 1) s._padding = dims([extra, 0, extra + below, 0]);
    return this.widget('rating', s);
  }

  progress(n, ctx) {
    const label = (n.label || '').trim();
    const isPercent = /^\d+(\.\d+)?\s*%$/.test(label);
    return this.widget('progress', {
      title: '',
      percent: slider(n.percent ?? 50, '%'),
      display_percentage: isPercent ? 'show' : '',
      inner_text: isPercent ? '' : label,
      bar_color: fade(n.barColor, n.opacity),
      bar_bg_color: fade(n.trackColor, n.opacity),
      bar_height: slider(n.height || 20),
      bar_border_radius: slider(n.radius || 0),
      bar_inline_color: n.labelStyle?.color ? cssColorToHex(n.labelStyle.color) : null,
      ...(label ? this.typography(n.labelStyle, 'bar_inner_typography') : {}),
      ...this.common({ ...n, background: null, border: null, shadow: null, padding: null }, ctx),
    });
  }

  container(n, ctx) {
    const isTop = !ctx;
    const inRow = ctx?.direction === 'row' && !ctx?.grid;
    const op = n.opacity;
    if (op != null && n.children?.length) this.notes.add('See-through (opacity) boxes with content were made solid; their background colours keep the transparency.');
    // Blurred colour blobs: Elementor has no blur for boxes, so the colour fades out
    // from the middle instead (a radial gradient to transparent). The blur spreads the
    // colour past the shape's edge, so a placed blob grows by the blur on every side.
    const blurred = n.blur && n.background?.color && !n.background.image && !n.background.gradient && !n.children?.length;
    let bgSrc = n.background;
    if (blurred) {
      this.notes.add('Blurred decorative shapes are drawn as soft radial gradients (Elementor has no blur setting for boxes).');
      const r = Math.min(n.rect.w, n.rect.h) / 2;
      const e = n.absolute ? Math.round(n.blur * 1.5) : 0;
      if (e) n = { ...n, absolute: { ...n.absolute, x: n.absolute.x - e, y: n.absolute.y - e }, rect: { ...n.rect, w: n.rect.w + 2 * e, h: n.rect.h + 2 * e }, minHeight: (n.minHeight || n.rect.h) + 2 * e };
      // Stops are measured to the box corner (Elementor's radial gradients reach the farthest corner).
      const corner = (r + e) * Math.SQRT2;
      const from = r1((Math.max(0, r - (e || n.blur)) / corner) * 100);
      bgSrc = { gradient: `radial-gradient(${n.background.color} ${from}%, ${n.background.color.slice(0, 7)}00 ${r1(((r + e) / corner) * 100)}%)` };
    }
    const s = {
      padding: dims(n.padding),
      margin: dims([n.marginTop || 0, 0, 0, n.marginLeft || 0]),
      ...this.background(bgSrc, 'background', { opacity: op }),
      ...this.overlay(n.background),
      ...this.border(n.border, 'border', 'border_radius', op),
      ...this.shadow(n.shadow, 'box_shadow'),
      ...this.transform(n),
    };
    if (n.gridSpec) {
      const g = n.gridSpec;
      s.container_type = 'grid';
      s.grid_columns_grid = g.equal ? { unit: 'fr', size: g.columns, sizes: [] } : { unit: 'custom', size: g.tracks.map((t) => `${r1(t)}fr`).join(' '), sizes: [] };
      s.grid_columns_grid_mobile = { unit: 'fr', size: 1, sizes: [] };
      s.grid_rows_grid = { unit: 'custom', size: 'auto', sizes: [] };
      s.grid_gaps = { column: String(r1(g.columnGap)), row: String(r1(g.rowGap)), isLinked: false, unit: 'px' };
      s.grid_auto_flow = 'row';
      // Items centred (or pinned) in their row instead of stretched to its height.
      if (g.alignItems && g.alignItems !== 'stretch') s.grid_align_items = g.alignItems;
    } else {
      Object.assign(s, {
        flex_direction: n.direction === 'row' ? 'row' : 'column',
        flex_wrap: n.wrap ? 'wrap' : 'nowrap',
        flex_justify_content: n.justify || 'flex-start',
        flex_align_items: n.alignItems || 'stretch',
        flex_gap: { column: String(r1(n.gap?.column || 0)), row: String(r1(n.gap?.row || 0)), isLinked: false, unit: 'px', size: r1(n.gap?.column || 0) },
      });
    }
    if (n.absolute) {
      Object.assign(s, this.position(n, true));
      if (n.boxedWidth && n.absolute.fullWidth) {
        // A full-width overlay (a header over the hero) with centred content keeps it centred.
        s.content_width = 'boxed';
        s.boxed_width = slider(n.boxedWidth);
      } else {
        s.content_width = 'full';
        s.width = slider(n.rect.w);
        // A boxed width would make it as wide as its parent, so centred narrower content
        // is kept centred with the free space added to the side padding.
        const p = n.padding || [0, 0, 0, 0];
        const bw = n.border?.width || [0, 0, 0, 0];
        const side = n.boxedWidth ? (n.rect.w - bw[1] - bw[3] - p[1] - p[3] - n.boxedWidth) / 2 : 0;
        if (side >= 1) s.padding = dims([p[0], p[1] + side, p[2], p[3] + side]);
      }
    } else if (n.grow && inRow) {
      // Fills the space left in its row, like the original's flex-grow.
      Object.assign(s, { content_width: 'full', width: slider(n.grow.min), _flex_size: 'grow' });
    } else if (n.fixedWidth) {
      // A drawn mark (bar, dot, swatch) keeps its exact size.
      Object.assign(s, { content_width: 'full', width: slider(n.fixedWidth), _flex_size: 'none' });
    } else if (n.boxedWidth) {
      s.content_width = 'boxed';
      s.boxed_width = slider(n.boxedWidth);
    } else {
      s.content_width = 'full';
      // Boxes as wide as their one-line contents (badges, legend rows) size to them.
      const hugs = n.hug && (inRow || (n.alignSelf && !ctx?.grid));
      s.width = hugs ? { unit: 'custom', size: 'max-content', sizes: [] } : !isTop && !ctx?.grid && inRow && n.widthCalc ? { unit: 'custom', size: n.widthCalc, sizes: [] } : !isTop && !inRow && n.overhang ? { unit: 'custom', size: `calc(100% + ${n.overhang}px)`, sizes: [] } : slider(isTop || ctx?.grid ? 100 : n.widthPct || 100, '%');
      if (inRow) s.width_mobile = slider(100, '%');
    }
    if (ctx?.grid && n.gridItem) {
      if (n.gridItem.colSpan > 1) Object.assign(s, { grid_column: String(Math.min(12, n.gridItem.colSpan)), grid_column_mobile: '1' });
      if (n.gridItem.rowSpan > 1) s.grid_row = String(Math.min(12, n.gridItem.rowSpan));
    }
    // Rows stack on phones, so the space kept before an item in its row goes there.
    if (n.marginLeft && inRow) s.margin_mobile = dims([n.marginTop || 0, 0, 0, 0]);
    if (n.minHeight) s.min_height = slider(n.minHeight);
    if (n.alignSelf && !n.absolute) s._flex_align_self = n.alignSelf === 'center' ? 'center' : n.alignSelf === 'end' ? 'flex-end' : 'flex-start';
    if (n.overflow === 'hidden') s.overflow = 'hidden';
    if (n.sticky) this.notes.add('Sticky headers or bars were placed in the normal flow: free Elementor has no sticky setting (Elementor Pro adds it under Motion Effects).');
    // Links can't be nested: a linked box holding a button or social icons (which always
    // render as links) keeps the link on those instead, and nothing inside a linked box
    // gets a link of its own.
    let href = ctx?.inLink ? null : n.href;
    if (href && hasDescendant(n, (c) => c.kind === 'button' || c.kind === 'social')) {
      this.notes.add('Linked cards that contain buttons keep the link on the buttons, because links can\'t be nested.');
      href = null;
    }
    if (href) {
      s.html_tag = 'a';
      s.link = link(href);
    }
    // A child drawn behind its siblings (negative z-index) needs this box to be its own layer.
    if ((n.children || []).some((c) => c.absolute?.zIndex < 0)) s.z_index = 0;
    // Rows stack into a single column on phones.
    if (n.direction === 'row' && !n.gridSpec) {
      s.flex_direction_mobile = 'column';
      const g = Math.min(24, Math.max(12, n.gap?.column || 0));
      s.flex_gap_mobile = { column: String(g), row: String(g), isLinked: true, unit: 'px', size: g };
      if (n.wrap) s.flex_wrap_mobile = 'wrap';
    }
    // Keep content off the screen edges on phones.
    if (isTop) {
      const p = (n.padding || [0, 0, 0, 0]).map((v) => r1(v));
      s.padding_mobile = dims([Math.min(p[0], 48), Math.max(16, Math.min(p[1], 24)), Math.min(p[2], 48), Math.max(16, Math.min(p[3], 24))]);
    }

    const el = { id: id(), elType: 'container', settings: compact(s), elements: [], isInner: !isTop };
    if (isTop) this.tag(el, n);
    const childCtx = {
      direction: n.gridSpec ? 'row' : n.direction,
      grid: !!n.gridSpec,
      inLink: !!(ctx?.inLink || href),
      cardHref: n.href && !href && !ctx?.inLink ? n.href : ctx?.cardHref,
    };
    el.elements = paintOrder(n.children || []).map((c) => this.node(c, childCtx)).filter(Boolean);
    return el;
  }

  build(tree, { title, pageTemplate = 'elementor_canvas' } = {}) {
    const content = tree.sections.map((sec) => this.container(sec, null));
    const optical = (tree.opticalFonts || []).filter((f) => this.fontsUsed.has(f));
    if (optical.length) this.notes.add(`${optical.join(', ')} ${optical.length > 1 ? 'adjust' : 'adjusts'} letter shapes to the text size on the original page. Elementor loads one fixed version, so letters are a little wider and a long paragraph can break a line one word earlier.`);
    // Elementor loads a Google font only for widgets whose Typography uses it.
    const unloaded = [...this.inlineFonts].filter((f) => !this.fontsUsed.has(f));
    if (unloaded.length) {
      const it = unloaded.length > 1 ? 'them' : 'it';
      this.notes.add(`${unloaded.join(', ')} ${unloaded.length > 1 ? 'are' : 'is'} used only for some words inside text, forms or tables. Elementor loads a Google font only when a widget's Typography uses it, so add ${it} under Site Settings > Global Fonts for those words to show in ${it}.`);
    }
    if (tree.droppedPatterns) this.notes.add('Repeating CSS background patterns (dot or line grids) were left out: Elementor can only repeat an uploaded image. Add one as a background image if you need it.');
    const page_settings = { template: pageTemplate };
    if (tree.pageBackground) Object.assign(page_settings, { background_background: 'classic', background_color: cssColorToHex(tree.pageBackground) });
    return {
      template: {
        content,
        page_settings,
        version: ELEMENTOR_DB_VERSION,
        title: title || tree.title || 'Imported design',
        type: 'page',
      },
      fonts: [...new Set([...this.fontsUsed, ...this.inlineFonts])],
      fontNotes: [...this.fontNotes.values()],
      notes: [...this.notes],
      sourceMap: this.tagSource ? this.sourceMap : undefined,
    };
  }
}

// In Elementor every element is positioned, so later siblings paint on top.
// Decorations meant to sit behind content (::before, negative z-index) go first.
function paintOrder(children) {
  const behind = (c) => c.absolute && ((c.absolute.zIndex ?? 0) < 0 || (c.pseudo === '::before' && !(c.absolute.zIndex > 0)));
  children.forEach((c) => { if (behind(c)) c.behind = true; });
  return [...children.filter(behind), ...children.filter((c) => !behind(c))];
}

// Drops unset values so Elementor falls back to its own defaults.
function compact(settings) {
  return Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== null && v !== undefined));
}

function alignValue(a) {
  if (!a) return 'start';
  if (a === 'center') return 'center';
  if (a === 'right' || a === 'end') return 'end';
  if (a === 'justify') return 'justify';
  return 'start';
}

export function buildTemplate(tree, opts = {}) {
  return new TemplateBuilder({ tagSource: opts.tagSource }).build(tree, opts);
}
