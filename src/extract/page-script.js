// Runs inside the rendered page (via Playwright's page.evaluate).
// Walks the visible DOM and returns a layout tree (the "IR") built from
// real computed styles and on-screen boxes. Every visible element ends up as
// a node: layout boxes, text, buttons, media, icons, embeds, accordions,
// lists, ratings, and — only when nothing native fits — an HTML snapshot.
export function extractLayout() {
  const INLINE_TAGS = new Set([
    'A', 'ABBR', 'B', 'BDI', 'BDO', 'BR', 'CITE', 'CODE', 'DATA', 'DFN', 'EM', 'I', 'KBD',
    'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR', 'WBR', 'LABEL', 'DEL', 'INS', 'FONT',
  ]);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD', 'MAP', 'PARAM', 'SOURCE', 'TRACK', 'DIALOG']);
  const KEEP_HTML_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'A', 'BR', 'UL', 'OL', 'LI', 'SUB', 'SUP', 'S', 'DEL', 'INS', 'SMALL', 'CODE', 'MARK', 'SPAN', 'KBD', 'Q', 'ABBR', 'CITE']);
  const MEDIA_TAGS = new Set(['IMG', 'PICTURE', 'SVG', 'IFRAME', 'VIDEO', 'AUDIO', 'CANVAS', 'OBJECT', 'EMBED']);
  const FORM_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

  // Splits a CSS list on top-level commas (not the ones inside rgb(...) or gradients).
  const splitTop = (str) => {
    const out = [];
    let depth = 0, cur = '';
    for (const ch of str) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };

  const px = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  };
  const isTransparent = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function rgbToHex(c) {
    if (!c) return null;
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return c;
    const parts = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
    const [r, g, b] = parts;
    const a = parts.length > 3 ? parts[3] : 1;
    const hex = '#' + [r, g, b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('').toUpperCase();
    if (a >= 1) return hex;
    return hex + Math.round(a * 255).toString(16).padStart(2, '0').toUpperCase();
  }

  function isVisible(el, cs) {
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
    if (cs.display === 'contents') return true;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) {
      // Zero-size wrappers can still have visible overflowing children.
      return [...el.children].some((c) => { const b = c.getBoundingClientRect(); return b.width >= 1 && b.height >= 1; });
    }
    // Screen-reader-only helpers (1px clipped boxes).
    if (r.width <= 1 && r.height <= 1) return false;
    if (cs.clip && cs.clip !== 'auto' && /rect\(0(px)?,\s*0(px)?,\s*0(px)?,\s*0(px)?\)/.test(cs.clip)) return false;
    return true;
  }

  function textShadow(cs) {
    return cs.textShadow && cs.textShadow !== 'none' ? cs.textShadow : null;
  }

  // The font actually on screen: the first family in the stack the browser could use
  // (a listed web font that never loaded falls through to the next one, as visitors see it).
  const GENERIC_FAMILIES = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|-apple-system|blinkmacsystemfont|emoji|math)$/i;
  const fontCache = new Map();
  let measureCtx = null;
  function fontAvailable(fam) {
    if (GENERIC_FAMILIES.test(fam)) return true;
    if (fontCache.has(fam)) return fontCache.get(fam);
    measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
    const sample = 'mmmmmmmmmmlli1WQ@#&AaBbGg';
    let ok = false;
    for (const base of ['monospace', 'serif', 'sans-serif']) {
      measureCtx.font = `72px ${base}`;
      const w0 = measureCtx.measureText(sample).width;
      measureCtx.font = `72px "${fam.replace(/"/g, '')}", ${base}`;
      if (measureCtx.measureText(sample).width !== w0) { ok = true; break; }
    }
    fontCache.set(fam, ok);
    return ok;
  }
  function renderedStack(stack) {
    const fams = splitTop(stack).map((f) => f.replace(/^["']|["']$/g, '').trim()).filter(Boolean);
    const i = fams.findIndex(fontAvailable);
    return i <= 0 ? stack : fams.slice(i).map((f) => (GENERIC_FAMILIES.test(f) ? f : `"${f}"`)).join(', ');
  }

  // The weight actually drawn. Pages often load only some weights of a web font, and
  // the browser then picks the nearest loaded face (CSS font matching), so a heading
  // set to 300 with only 600/700 loaded shows at 600. Elementor loads every weight,
  // so the weight on screen is the one to keep. Missing bold is faked by the browser
  // (synthetic bold), so a lighter face under a bold request keeps the bold request.
  const weightCache = new Map();
  function renderedWeight(cs) {
    const want = Number(cs.fontWeight) || 400;
    const fam = splitTop(renderedStack(cs.fontFamily))[0]?.replace(/^["']|["']$/g, '').trim();
    const italic = cs.fontStyle !== 'normal';
    const key = `${fam}|${want}|${italic}`;
    if (weightCache.has(key)) return weightCache.get(key);
    let faces = [...document.fonts].filter((f) => f.family.replace(/^["']|["']$/g, '') === fam);
    const styled = faces.filter((f) => (f.style !== 'normal') === italic);
    if (styled.length) faces = styled;
    const ranges = faces.map((f) => String(f.weight).split(/\s+/).map(Number)).filter((r) => r.every((n) => n > 0)).map(([a, b = a]) => [a, b]);
    let got = want;
    if (ranges.length && !ranges.some(([a, b]) => want >= a && want <= b)) {
      const below = ranges.filter(([, b]) => b < want).map(([, b]) => b).sort((x, y) => y - x);
      const above = ranges.filter(([a]) => a > want).map(([a]) => a).sort((x, y) => x - y);
      const inBand = want >= 400 && want <= 500 ? above.filter((w) => w <= 500) : [];
      const order = want < 400 ? [...below, ...above] : want <= 500 ? [...inBand, ...below, ...above.filter((w) => w > 500)] : [...above, ...below];
      got = order[0] ?? want;
      if (got < want && want >= 600 && got <= 500) got = want;
    }
    weightCache.set(key, got);
    return got;
  }

  function typography(cs) {
    return {
      // The stack the CSS asks for: fonts.js picks the first family Elementor can load
      // (or a free look-alike), which is what the author intended even when this
      // browser lacks the font.
      fontFamily: cs.fontFamily,
      fontSize: px(cs.fontSize),
      fontWeight: String(renderedWeight(cs)),
      // "normal" is roughly 1.2 for most fonts; pin it so theme defaults can't change it.
      lineHeight: cs.lineHeight === 'normal' ? Math.round(px(cs.fontSize) * 1.2 * 100) / 100 : px(cs.lineHeight),
      letterSpacing: cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing),
      wordSpacing: cs.wordSpacing === 'normal' || px(cs.wordSpacing) === 0 ? 0 : px(cs.wordSpacing),
      textTransform: cs.textTransform !== 'none' ? cs.textTransform : null,
      fontStyle: cs.fontStyle !== 'normal' ? cs.fontStyle : null,
      textDecoration: cs.textDecorationLine && cs.textDecorationLine !== 'none' ? cs.textDecorationLine : null,
      color: rgbToHex(cs.color),
      textShadow: textShadow(cs),
      gradientText: cs.webkitBackgroundClip === 'text' || cs.backgroundClip === 'text' ? cs.backgroundImage : null,
    };
  }

  function box(cs, prefix) {
    return ['Top', 'Right', 'Bottom', 'Left'].map((s) => px(cs[prefix + s]));
  }

  function border(cs) {
    const sides = ['Top', 'Right', 'Bottom', 'Left'];
    const widths = sides.map((s) => (cs['border' + s + 'Style'] !== 'none' ? px(cs['border' + s + 'Width']) : 0));
    const styleSide = sides.find((s, i) => widths[i] > 0);
    const radius = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map((r) => {
      // Percentages (e.g. 50% circles) are kept as such.
      if (/%/.test(r)) return { pct: parseFloat(r) };
      return px(r);
    });
    const hasBorder = !!styleSide;
    const pctRadius = radius.some((r) => typeof r === 'object');
    return {
      style: hasBorder ? cs['border' + styleSide + 'Style'] : null,
      width: hasBorder ? widths : null,
      color: hasBorder ? rgbToHex(cs['border' + styleSide + 'Color']) : null,
      radius: pctRadius ? radius.map((r) => (typeof r === 'object' ? r.pct : r)) : radius.some((r) => r > 0) ? radius : null,
      radiusUnit: pctRadius ? '%' : 'px',
    };
  }

  function background(cs, el) {
    const bg = {};
    if (!isTransparent(cs.backgroundColor)) bg.color = rgbToHex(cs.backgroundColor);
    const img = cs.backgroundImage;
    if (img && img !== 'none' && !(cs.webkitBackgroundClip === 'text' || cs.backgroundClip === 'text')) {
      const layers = splitTop(img);
      for (const layer of layers) {
        const url = layer.match(/url\(["']?([^"')]+)["']?\)/);
        if (url && !bg.image) {
          try { bg.image = new URL(url[1], document.baseURI).href; } catch { bg.image = url[1]; }
          bg.size = splitTop(cs.backgroundSize)[layers.indexOf(layer)] || cs.backgroundSize;
          bg.position = cs.backgroundPosition.split(',')[layers.indexOf(layer)]?.trim() || cs.backgroundPosition;
          bg.repeat = cs.backgroundRepeat.split(',')[layers.indexOf(layer)]?.trim() || cs.backgroundRepeat;
          bg.attachment = cs.backgroundAttachment.split(',')[0].trim();
        } else if (/gradient/.test(layer)) {
          // A gradient layered above a photo acts as an overlay.
          if (layers.some((l) => /url\(/.test(l))) bg.overlay = layer;
          else if (!bg.gradient) bg.gradient = layer;
        }
      }
    }
    return Object.keys(bg).length ? bg : null;
  }

  function shadow(cs) {
    return cs.boxShadow && cs.boxShadow !== 'none' ? cs.boxShadow : null;
  }

  function rect(el) {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
  }

  function hasVisualBox(cs) {
    return !isTransparent(cs.backgroundColor) || (cs.backgroundImage && cs.backgroundImage !== 'none' && cs.webkitBackgroundClip !== 'text') ||
      ['Top', 'Right', 'Bottom', 'Left'].some((s) => cs['border' + s + 'Style'] !== 'none' && px(cs['border' + s + 'Width']) > 0) ||
      (cs.boxShadow && cs.boxShadow !== 'none');
  }

  // Out-of-flow placement (absolute/fixed), relative to the element's on-screen box.
  function positioning(el, cs) {
    if (cs.position !== 'absolute' && cs.position !== 'fixed') return null;
    return { mode: 'absolute', zIndex: cs.zIndex !== 'auto' ? Number(cs.zIndex) : null };
  }

  function transformOf(cs) {
    if (!cs.transform || cs.transform === 'none') return null;
    const m = cs.transform.match(/matrix\(([^)]+)\)/);
    if (!m) return null;
    const [a, b] = m[1].split(',').map(parseFloat);
    const rotate = Math.round((Math.atan2(b, a) * 180) / Math.PI);
    return rotate ? { rotate } : null;
  }

  // ---------- icons ----------
  const ICON_CLASS = /\b(fa[srlbdk]?|fa-(solid|regular|brands|light|thin|duotone)|bi|icon|icons?-[\w-]+|material-icons(-\w+)?|material-symbols-\w+|lucide|feather|ti|ri-[\w-]+|la[srb]?|glyphicon|dashicons|ion-[\w-]+)\b/;

  // ownOnly: just the icon's own names, without the classes and labels of the boxes around it.
  function iconHints(el, ownOnly = false) {
    const hints = [];
    const add = (v) => v && hints.push(String(v).toLowerCase());
    add(el.getAttribute('class'));
    add(el.getAttribute('data-icon'));
    add(el.getAttribute('data-prefix'));
    add(el.getAttribute('data-lucide'));
    add(el.getAttribute('data-feather'));
    add(el.getAttribute('aria-label'));
    add(el.getAttribute('title'));
    add(el.getAttribute('name'));
    const t = el.querySelector?.('title');
    if (t) add(t.textContent);
    const use = el.querySelector?.('use');
    if (use) add(use.getAttribute('href') || use.getAttribute('xlink:href'));
    for (let p = el.parentElement, i = 0; p && i < 3 && !ownOnly; p = p.parentElement, i++) {
      add(p.getAttribute('aria-label'));
      add(p.getAttribute('class'));
      if (p.tagName === 'A') add(p.getAttribute('href'));
    }
    if (/material/.test(el.className?.baseVal ?? el.className ?? '')) add(el.textContent);
    return hints.join(' ').slice(0, 600);
  }

  function isFontIcon(el, cs) {
    if (!['I', 'SPAN'].includes(el.tagName)) return false;
    const cls = el.getAttribute('class') || '';
    const before = getComputedStyle(el, '::before');
    const glyph = before.content && before.content !== 'none' && before.content !== 'normal' && before.content.length <= 4;
    const iconFont = /awesome|icons|material|glyph|dashicons|ionicons|remixicon|tabler|lucide|feather|bootstrap-icons/i.test(cs.fontFamily + ' ' + before.fontFamily);
    if (/material-(icons|symbols)/.test(cls)) return true;
    return (ICON_CLASS.test(cls) && (glyph || iconFont)) || (glyph && iconFont);
  }

  function svgColor(svg) {
    const cs = getComputedStyle(svg);
    const shape = svg.querySelector('path,circle,rect,polygon,line,polyline,ellipse');
    const scs = shape ? getComputedStyle(shape) : cs;
    const fill = scs.fill && scs.fill !== 'none' ? scs.fill : null;
    const stroke = scs.stroke && scs.stroke !== 'none' ? scs.stroke : null;
    return rgbToHex(fill || stroke || cs.color);
  }

  // Logos and illustrations drawn with gradients or several colours are artwork,
  // not glyphs: a one-colour Font Awesome icon can't stand in for them.
  function isSvgArtwork(svg) {
    if (svg.querySelector('linearGradient, radialGradient, pattern, image, mask, filter')) return true;
    const paints = new Set();
    for (const sh of svg.querySelectorAll('path, circle, rect, polygon, line, polyline, ellipse, text')) {
      const scs = getComputedStyle(sh);
      for (const v of [scs.fill, scs.stroke]) if (v && v !== 'none' && !isTransparent(v)) paints.add(rgbToHex(v).slice(0, 7));
    }
    return paints.size > 1;
  }

  // Every SVG written out gets its own id prefix: once in one WordPress page, two
  // pictures that both define id="bg" would otherwise share the first one's gradient.
  const svgScope = Math.random().toString(36).slice(2, 6);
  let svgCount = 0;
  function scopeSvgIds(clone) {
    const prefix = `s${svgScope}${++svgCount}-`;
    const all = [clone, ...clone.querySelectorAll('*')];
    const ids = new Set(all.map((n) => n.getAttribute('id')).filter(Boolean));
    if (!ids.size) return;
    const ref = (id) => (ids.has(id) ? prefix + id : id);
    for (const n of all) {
      for (const a of [...n.attributes]) {
        if (a.name === 'id') a.value = prefix + a.value;
        else if (/^(xlink:)?href$/.test(a.name) && a.value.startsWith('#')) a.value = '#' + ref(a.value.slice(1));
        else if (/^aria-(labelledby|describedby)$/.test(a.name)) a.value = a.value.split(/\s+/).map(ref).join(' ');
        else if (a.value.includes('url(')) a.value = a.value.replace(/url\((['"]?)#([^'")]+)\1\)/g, (m, q, id) => `url(${q}#${ref(id)}${q})`);
      }
    }
  }

  const SVG_PAINT = ['fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin'];

  // Serializes an inline SVG with its computed paint so it renders the same anywhere.
  function svgMarkup(svg) {
    const clone = svg.cloneNode(true);
    const src = [svg, ...svg.querySelectorAll('*')];
    const dst = [clone, ...clone.querySelectorAll('*')];
    src.forEach((node, i) => {
      const cs = getComputedStyle(node);
      const d = dst[i];
      if (!d.setAttribute) return;
      SVG_PAINT.forEach((p) => {
        const v = cs.getPropertyValue(p);
        if (v && v !== 'normal' && !(p === 'opacity' && v === '1')) d.setAttribute(p, v);
      });
      // Gradient stops coloured by a class rule.
      if (node.tagName.toLowerCase() === 'stop') ['stop-color', 'stop-opacity'].forEach((p) => d.setAttribute(p, cs.getPropertyValue(p)));
      d.removeAttribute('class');
      d.removeAttribute('style');
      [...d.attributes].forEach((a) => /^on/i.test(a.name) && d.removeAttribute(a.name));
    });
    const r = svg.getBoundingClientRect();
    clone.setAttribute('width', Math.round(r.width));
    clone.setAttribute('height', Math.round(r.height));
    if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    // Resolve <use href="#id"> references against the page's sprite sheet.
    clone.querySelectorAll('use').forEach((u) => {
      const ref = (u.getAttribute('href') || u.getAttribute('xlink:href') || '').replace(/^.*#/, '#');
      const target = ref.length > 1 && document.querySelector(ref);
      if (target) {
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.innerHTML = target.innerHTML;
        // Paint that CSS rules (the page's, or a <style> in the sprite) give the symbol's own
        // shapes. Attributes are copied as they are, and inherited paint comes from the <use>,
        // so values equal to the parent's are left out.
        const from = [...target.querySelectorAll('*')], to = [...g.querySelectorAll('*')];
        from.forEach((node, i) => {
          if (to[i]?.localName !== node.localName) return;
          const cs = getComputedStyle(node), pcs = getComputedStyle(node.parentElement);
          const ruled = (p) => !node.hasAttribute(p) && cs.getPropertyValue(p) !== (p === 'opacity' ? '1' : pcs.getPropertyValue(p));
          [...SVG_PAINT, ...(node.localName === 'stop' ? ['stop-color', 'stop-opacity'] : [])].forEach((p) => ruled(p) && to[i].setAttribute(p, cs.getPropertyValue(p)));
          to[i].removeAttribute('class');
        });
        if (target.getAttribute('viewBox') && !clone.getAttribute('viewBox')) clone.setAttribute('viewBox', target.getAttribute('viewBox'));
        u.replaceWith(g);
      }
    });
    // Its <style> rules are now attributes; left in, the block would restyle the whole page.
    clone.querySelectorAll('style, script').forEach((n) => n.remove());
    scopeSvgIds(clone);
    return clone.outerHTML;
  }

  function makeIcon(el, cs, extra = {}) {
    const isSvg = el.tagName.toLowerCase() === 'svg';
    const r = rect(el);
    let color = isSvg ? svgColor(el) : rgbToHex(cs.color);
    let size = Math.round(Math.max(r.w, r.h));
    if (!isSvg) {
      const before = getComputedStyle(el, '::before');
      size = Math.round(px(before.fontSize) || px(cs.fontSize) || size);
    }
    return {
      ...widgetBase(el, cs, 'icon'),
      hints: iconHints(el),
      ownHints: iconHints(el, true),
      svg: isSvg ? svgMarkup(el) : null,
      // Several colours (a flag, a logo in an icon-only link): no one-colour glyph can stand in.
      artwork: isSvg && isSvgArtwork(el) ? true : undefined,
      color,
      size,
      background: background(cs),
      border: border(cs),
      ...extra,
    };
  }

  // ---------- HTML snapshot (last resort: forms, tables, unknown widgets) ----------
  const SNAP_PROPS = [
    'display', 'box-sizing', 'width', 'height', 'min-height', 'max-width', 'margin', 'padding',
    'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-transform', 'text-align', 'text-decoration-line', 'color',
    'background-color', 'background-image', 'background-position-x', 'background-position-y', 'background-size', 'background-repeat', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-radius', 'box-shadow',
    'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'gap', 'flex', 'grid-template-columns', 'grid-column',
    'vertical-align', 'white-space', 'list-style-type', 'border-collapse', 'border-spacing', 'outline', 'appearance', 'accent-color', 'cursor', 'opacity',
    'flex-grow', 'flex-shrink', 'flex-basis', 'align-self', 'object-fit', 'float', 'clear',
  ];
  // Browser defaults per tag, measured in a blank frame so the page's own CSS doesn't leak in.
  const DEFAULTS = {};
  let probeDoc = null;
  function defaultFor(tag) {
    if (DEFAULTS[tag]) return DEFAULTS[tag];
    if (!probeDoc) {
      const fr = document.createElement('iframe');
      fr.style.cssText = 'position:absolute;left:-9999px;top:0;width:10px;height:10px;border:0';
      document.documentElement.appendChild(fr);
      probeDoc = fr.contentDocument;
      probeDoc.open();
      probeDoc.write('<!doctype html><html><body></body></html>');
      probeDoc.close();
    }
    const probe = probeDoc.createElement(tag);
    probeDoc.body.appendChild(probe);
    const cs = probeDoc.defaultView.getComputedStyle(probe);
    const out = {};
    SNAP_PROPS.forEach((p) => (out[p] = cs.getPropertyValue(p)));
    probe.remove();
    return (DEFAULTS[tag] = out);
  }
  // Inherited properties are written only where they change, plus once on the outer element.
  const INHERITED = new Set(['font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-transform', 'text-align', 'color', 'white-space', 'list-style-type', 'border-collapse', 'border-spacing', 'cursor']);
  // WordPress themes restyle these elements, so their look is always written out in full.
  const THEMED = {
    INPUT: ['box-sizing', 'width', 'height', 'padding', 'margin', 'color', 'background-color', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-radius', 'box-shadow', 'font-size', 'font-family', 'font-weight', 'line-height', 'outline'],
    TEXTAREA: ['box-sizing', 'width', 'height', 'padding', 'margin', 'color', 'background-color', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-radius', 'box-shadow', 'font-size', 'font-family', 'line-height'],
    SELECT: ['box-sizing', 'width', 'height', 'padding', 'margin', 'color', 'background-color', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-radius', 'font-size', 'font-family', 'display'],
    BUTTON: ['box-sizing', 'width', 'height', 'padding', 'margin', 'color', 'background-color', 'background-image', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-radius', 'box-shadow', 'font-size', 'font-family', 'font-weight', 'line-height', 'text-transform', 'letter-spacing'],
    TABLE: ['margin', 'border-collapse', 'border-spacing', 'font-size', 'line-height'],
    TH: ['padding', 'text-align', 'vertical-align', 'background-color', 'border-top', 'border-right', 'border-bottom', 'border-left', 'font-weight', 'font-size', 'line-height', 'color'],
    TD: ['padding', 'text-align', 'vertical-align', 'background-color', 'border-top', 'border-right', 'border-bottom', 'border-left', 'font-weight', 'font-size', 'line-height', 'color'],
    A: ['color', 'text-decoration-line'],
    LABEL: ['display', 'margin', 'font-weight', 'line-height', 'vertical-align'],
    UL: ['margin', 'padding', 'list-style-type'],
    OL: ['margin', 'padding', 'list-style-type'],
    P: ['margin'],
    H1: ['margin', 'font-size', 'font-weight', 'line-height'], H2: ['margin', 'font-size', 'font-weight', 'line-height'], H3: ['margin', 'font-size', 'font-weight', 'line-height'],
    H4: ['margin', 'font-size', 'font-weight', 'line-height'], H5: ['margin', 'font-size', 'font-weight', 'line-height'], H6: ['margin', 'font-size', 'font-weight', 'line-height'],
  };
  // Inherited values no theme sets around a widget: the browser's own need not be repeated on the outer element.
  const UNTHEMED = new Set(['white-space', 'list-style-type', 'border-collapse', 'border-spacing', 'cursor']);
  // A form's card is drawn by its container when the form is split (see formOf).
  const CARD_PROPS = new Set(['min-height', 'max-width', 'padding', 'background-color', 'background-image', 'background-position-x', 'background-position-y', 'background-size', 'background-repeat', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-radius', 'box-shadow', 'outline']);
  const FIELDS = ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'];
  // A border side or an outline of width 0 draws nothing.
  const drawsNothing = (v) => /(^|\s)0px(\s|$)/.test(v || '');
  const contentWidth = (el, cs) => el.getBoundingClientRect().width - px(cs.paddingLeft) - px(cs.paddingRight) - px(cs.borderLeftWidth) - px(cs.borderRightWidth);

  // Colour a laid over colour b.
  function blend(a, b) {
    const rgba = (c) => { const n = (c.match(/[\d.]+/g) || []).map(Number); return n.length >= 3 ? [n[0], n[1], n[2], n[3] ?? 1] : [0, 0, 0, 0]; };
    const [ra, ga, ba, aa] = rgba(a), [rb, gb, bb, ab] = rgba(b);
    const alpha = aa + ab * (1 - aa);
    const mix = (x, y) => (alpha ? Math.round((x * aa + y * ab * (1 - aa)) / alpha) : 0);
    const rgb = `${mix(ra, rb)}, ${mix(ga, gb)}, ${mix(ba, bb)}`;
    return alpha >= 0.999 ? `rgb(${rgb})` : `rgba(${rgb}, ${Math.round(alpha * 1000) / 1000})`;
  }

  // Bootstrap paints table stripes and hovers with an inset shadow that covers the cell:
  // on screen that is a background colour laid over the cell's own.
  function shadowFill(cs, r) {
    const m = cs.boxShadow.match(/^(rgba?\([^)]*\)) 0px 0px 0px ([\d.]+)px inset$/);
    return m && px(m[2]) >= Math.max(r.width, r.height) / 2 ? m[1] : null;
  }

  // Pixel tracks that can shrink to fit a phone: shares of the row when they fill it, else
  // capped at their size. Narrow tracks (an icon column) keep their size.
  function fluidTracks(el, cs) {
    const v = cs.gridTemplateColumns;
    if (!/^[\d.]+px( [\d.]+px)*$/.test(v)) return v;
    const widths = v.split(' ').map(px);
    const full = Math.abs(widths.reduce((a, b) => a + b, 0) + px(cs.columnGap) * (widths.length - 1) - contentWidth(el, cs)) <= 1;
    const unit = Math.min(...widths.filter((w) => w >= 64));
    return widths.map((w) => (w < 64 ? `${w}px` : full ? `minmax(0,${Math.round((w / unit) * 100) / 100}fr)` : `minmax(0,${w}px)`)).join(' ');
  }

  // A grid of fields becomes a wrapping flex row: each item keeps its width as its basis, so
  // the rows look the same on desktop and stack on a phone, as the page's own media queries
  // do. Only when flex places every item where the grid does (in order, every row full).
  // Returns each item's basis.
  function wrapGrid(el, cs) {
    if (!/^(inline-)?grid$/.test(cs.display) || !/^[\d.]+px( [\d.]+px)+$/.test(cs.gridTemplateColumns)) return null;
    const r = el.getBoundingClientRect();
    const left = r.left + px(cs.borderLeftWidth) + px(cs.paddingLeft);
    const inner = contentWidth(el, cs);
    const gap = px(cs.columnGap);
    const basis = new Map();
    let x = 0;
    for (const c of el.childNodes) {
      if (c.nodeType === Node.TEXT_NODE && c.textContent.trim()) return null;
      if (c.nodeType !== Node.ELEMENT_NODE || SKIP_TAGS.has(c.tagName.toUpperCase())) continue;
      const ccs = getComputedStyle(c);
      if (ccs.display === 'none' || /^(absolute|fixed)$/.test(ccs.position)) continue;
      const cr = c.getBoundingClientRect();
      const w = cr.width + px(ccs.marginLeft) + px(ccs.marginRight);
      if (basis.size && x + gap + w > inner + 1) {
        if (Math.abs(x - inner) > 1) return null;
        x = 0;
      }
      const at = basis.size && x ? x + gap : 0;
      if (Math.abs(cr.left - px(ccs.marginLeft) - left - at) > 1) return null;
      x = at + w;
      basis.set(c, Math.floor(ccs.boxSizing === 'border-box' ? cr.width : px(ccs.width)));
    }
    return basis.size && Math.abs(x - inner) <= 1 ? basis : null;
  }

  // only: the outer element's children to keep (the fields of a split form card).
  function snapshot(root, only) {
    const ALLOWED_ATTRS = { A: ['href'], IMG: ['src', 'alt', 'width', 'height'], INPUT: ['type', 'placeholder', 'value', 'name', 'checked', 'disabled'], TEXTAREA: ['placeholder', 'rows', 'name'], SELECT: ['name'], OPTION: ['value', 'selected'], LABEL: [], BUTTON: ['type'], FORM: [], TH: ['colspan', 'rowspan'], TD: ['colspan', 'rowspan'], IFRAME: ['src', 'width', 'height', 'title', 'allow', 'allowfullscreen', 'loading'], AUDIO: ['src', 'controls', 'loop'], VIDEO: ['src', 'poster', 'controls', 'loop', 'muted'], SOURCE: ['src', 'type'] };
    // Flex basis of each item of a wrapped grid, and the boxes whose width the snapshot keeps.
    const basis = new Map();
    const fluid = new Set();
    const walkSnap = (node, isRoot, parentCs) => {
      if (node.nodeType === Node.TEXT_NODE) return esc(node.textContent.replace(/\s+/g, ' '));
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const tag = node.tagName.toUpperCase();
      if (SKIP_TAGS.has(tag) && tag !== 'SOURCE') return '';
      const cs = getComputedStyle(node);
      if (cs.display === 'none') return '';
      if (tag === 'SVG') return svgMarkup(node);
      const t = tag.toLowerCase();
      // Screen-reader-only text (visually hidden labels) stays hidden the same way.
      const nr = node.getBoundingClientRect();
      if (!isRoot && cs.position === 'absolute' && nr.width <= 1 && nr.height <= 1 && (cs.overflow === 'hidden' || cs.clip !== 'auto' || cs.clipPath !== 'none')) {
        return `<${t} style="position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0">${esc(node.textContent.replace(/\s+/g, ' ').trim())}</${t}>`;
      }
      const def = defaultFor(t);
      const always = new Set(THEMED[tag] || []);
      const styles = [];
      const wrapped = wrapGrid(node, cs);
      if (wrapped) wrapped.forEach((w, c) => basis.set(c, w));
      const stripe = shadowFill(cs, nr);
      const edges = {};
      let shared = false;
      // As wide as its box on the page, and that box keeps its width.
      const fills = () => !isRoot && fluid.has(node.parentElement) && /^(block|flex|grid|list-item|flow-root)$/.test(parentCs.display) &&
        nr.width + px(cs.marginLeft) + px(cs.marginRight) >= contentWidth(node.parentElement, parentCs) - 1;
      for (const p of SNAP_PROPS) {
        if (p === 'box-sizing') continue;
        let v = cs.getPropertyValue(p);
        // The card of a split form is its container's look.
        if (isRoot && only && CARD_PROPS.has(p)) continue;
        if (p === 'width' && !isRoot && parentCs && /flex/.test(parentCs.display) && !parentCs.flexDirection.startsWith('column') && cs.flexGrow === '0' && !['IMG', 'INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'IFRAME', 'VIDEO', 'AUDIO'].includes(tag) && !isInlineContent(node)) {
          // Columns in a flex row (Bootstrap's col-md-6): their share of the row, so they stay side by side.
          // Labels and other runs of words size to their text instead.
          const inner = contentWidth(node.parentElement, parentCs);
          const share = inner > 0 ? (cs.boxSizing === 'border-box' ? nr.width : px(cs.width)) / inner : 0;
          shared = share >= 0.2 && share <= 1.001;
          if (shared) styles.push(`width:${Math.round(share * 10000) / 100}%`);
          continue;
        }
        if (p === 'width' || p === 'height') {
          // Fixed sizes only for replaced/form elements; flow boxes size themselves.
          if (!['IMG', 'INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'IFRAME', 'VIDEO', 'AUDIO'].includes(tag) && !isRoot) continue;
          if (isRoot && p === 'height') continue;
          if (isRoot && p === 'width') v = '100%';
          // Inputs that stretch in a flex row (or a wrapped grid) keep stretching rather than freezing their pixel width,
          // and may shrink below their default size on a phone.
          if (p === 'width' && !isRoot && (/^[1-9]/.test(cs.flexGrow) || basis.has(node))) {
            if (FIELDS.includes(tag)) styles.push(`min-width:${cs.minWidth === 'auto' ? '0' : cs.minWidth}`);
            continue;
          }
          // A field as wide as its box stays as wide on any screen; a narrower one can still shrink to fit a phone.
          if (p === 'width' && !isRoot && FIELDS.includes(tag) && fills()) v = '100%';
          else if (p === 'width' && !isRoot && FIELDS.includes(tag) && nr.width > 100 && cs.maxWidth === 'none') { styles.push(`width:${v}`, 'max-width:100%'); continue; }
        }
        // The outer element's spacing comes from the widget; zero it so theme margins (e.g. on tables) don't add any.
        if (p === 'margin' && isRoot) { styles.push('margin:0'); continue; }
        // So is its place in the row around it.
        if (isRoot && /^(flex|flex-grow|flex-shrink|flex-basis|align-self|grid-column|float|clear)$/.test(p)) continue;
        if (wrapped && p === 'display') { styles.push('display:flex', 'flex-wrap:wrap'); continue; }
        if (p === 'grid-template-columns') v = wrapped ? '' : fluidTracks(node, cs);
        if (p === 'background-color' && stripe) v = blend(stripe, v);
        if (p === 'box-shadow' && stripe) continue;
        if (/^flex-(grow|shrink|basis)$/.test(p) && styles.some((d) => d.startsWith('flex:'))) continue;
        // Borders and outlines that draw nothing are left out, unless a theme draws one there.
        if (/^(border-(top|right|bottom|left)|outline)$/.test(p) && !always.has(p) && drawsNothing(v) && drawsNothing(def[p])) continue;
        // Spacing between cells only shows when they are drawn apart.
        if (p === 'border-spacing' && cs.borderCollapse === 'collapse') continue;
        // A row takes its vertical alignment from its row group.
        if (p === 'vertical-align' && tag === 'TR' && v === parentCs?.verticalAlign) continue;
        if (isRoot && UNTHEMED.has(p) && !always.has(p) && v === def[p]) continue;
        if (!v || v === 'auto' && !always.has(p)) continue;
        if (INHERITED.has(p) && !isRoot && !always.has(p) && parentCs && v === parentCs.getPropertyValue(p)) continue;
        if (!always.has(p) && !INHERITED.has(p) && v === def[p]) continue;
        if (!always.has(p) && v === 'normal' && !(isRoot && INHERITED.has(p))) continue;
        if (/^border-(top|right|bottom|left)$/.test(p)) { edges[p] = drawsNothing(v) ? '0' : v; continue; }
        if (p === 'outline' && drawsNothing(v)) v = '0';
        // Quotes inside url(...) stay as they are (data: SVGs hold single quotes); the attribute escape covers them.
        styles.push(`${p}:${/url\(/.test(v) ? v : v.replace(/"/g, "'")}`);
      }
      // Four equal border sides as one shorthand.
      const sides = Object.values(edges);
      if (sides.length === 4 && sides.every((e) => e === sides[0])) styles.push(`border:${sides[0]}`);
      else Object.entries(edges).forEach(([p, e]) => styles.push(`${p}:${e}`));
      if (basis.has(node)) styles.push(`flex:1 1 ${basis.get(node)}px`);
      // Elementor sizes every element border-box; another box model matters only where a size is written.
      if (cs.boxSizing !== 'border-box' && !isRoot && styles.some((d) => /^(width|height|min-height|max-width|flex):/.test(d))) styles.unshift('box-sizing:' + cs.boxSizing);
      // A box that fills one the snapshot keeps (auto width in normal flow) keeps its width too.
      const inFlow = cs.float === 'none' && !/^(absolute|fixed)$/.test(cs.position) && /^(block|flex|grid|list-item|flow-root)$/.test(cs.display);
      if (isRoot || basis.has(node) || shared || (!FIELDS.includes(tag) && inFlow && fills())) fluid.add(node);
      let attrs = '';
      for (const a of ALLOWED_ATTRS[tag] || []) {
        if (!node.hasAttribute(a)) continue;
        let v = a === 'href' ? '#' : node.getAttribute(a);
        if (a === 'src') v = node.currentSrc || node.src || v;
        attrs += v === '' ? ` ${a}` : ` ${a}="${esc(v)}"`;
      }
      if (tag === 'FORM') attrs += ' action="#" onsubmit="return false"';
      if (styles.length) attrs += ` style="${esc(styles.join(';'))}"`;
      const kids = isRoot && only ? [...node.childNodes].filter((c) => c.nodeType !== Node.ELEMENT_NODE || only.includes(c)) : [...node.childNodes];
      const inner = kids.map((c) => walkSnap(c, false, cs)).join('');
      if (['INPUT', 'IMG', 'BR', 'HR', 'SOURCE'].includes(tag)) return `<${t}${attrs}>`;
      return `<${t}${attrs}>${inner}</${t}>`;
    };
    return walkSnap(root, true, null).replace(/\s{2,}/g, ' ');
  }

  function makeHtml(el, cs, role) {
    return { ...widgetBase(el, cs, 'html'), role, markup: snapshot(el), text: textOf(el).slice(0, 200) };
  }

  // A form card: its box (background, border, shadow, padding) becomes a container and the
  // heading and notes above and below the fields become native widgets, so only the fields
  // and the submit button stay in code.
  function formOf(el, cs, depth) {
    const kids = [...el.children].filter((c) => !SKIP_TAGS.has(c.tagName.toUpperCase()) && isVisible(c, getComputedStyle(c)));
    const prose = (c) => /^(H[1-6]|P)$/.test(c.tagName) && !!textOf(c) && isInlineContent(c) && !looksLikeButton(c, getComputedStyle(c));
    let a = 0, b = kids.length;
    while (a < b && prose(kids[a])) a++;
    while (b > a && prose(kids[b - 1])) b--;
    const fields = kids.slice(a, b);
    const card = hasVisualBox(cs) || box(cs, 'padding').some((v) => v > 0);
    const looseText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    if (!fields.length || looseText || (fields.length === kids.length && !card)) return makeHtml(el, cs, 'form');
    // The fields' block, margins included (they stay inside the widget).
    const top = Math.min(...fields.map((f) => f.getBoundingClientRect().top - px(getComputedStyle(f).marginTop)));
    const bottom = Math.max(...fields.map((f) => f.getBoundingClientRect().bottom + px(getComputedStyle(f).marginBottom)));
    // Only a heading or note stacked above or below the fields (not beside them).
    if (kids.slice(0, a).some((k) => k.getBoundingClientRect().bottom > top + 1) || kids.slice(b).some((k) => k.getBoundingClientRect().top < bottom - 1)) return makeHtml(el, cs, 'form');
    const r = el.getBoundingClientRect();
    const left = r.left + px(cs.borderLeftWidth) + px(cs.paddingLeft);
    const form = {
      ...widgetBase(el, cs, 'html'), role: 'form', markup: snapshot(el, fields), text: fields.map(textOf).join(' ').slice(0, 200),
      rect: { x: Math.round(left + scrollX), y: Math.round(top + scrollY), w: Math.round(contentWidth(el, cs)), h: Math.round(bottom - top) },
      margin: [0, 0, 0, 0], padding: [0, 0, 0, 0], positioned: null, transform: null, opacity: null,
    };
    const children = [...kids.slice(0, a).map((k) => walk(k, depth + 1)), form, ...kids.slice(b).map((k) => walk(k, depth + 1))].filter(Boolean);
    return { ...withOverlay(container(el, cs, [...children, ...pseudoNodes(el, cs)])), direction: 'column', wrap: false, grid: null };
  }

  // ---------- text ----------
  // A node is "inline content" when it only holds text and inline elements
  // (and, for list items, nested lists of such items; with floats, images floated among the words).
  function isInlineContent(el, lists = false, floats = false) {
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      if (SKIP_TAGS.has(child.tagName.toUpperCase())) continue;
      const cs = getComputedStyle(child);
      if (cs.display === 'none') continue;
      const tag = child.tagName.toUpperCase();
      if (lists && /^(UL|OL)$/.test(tag) && plainList(child, cs)) continue;
      if (floats && /^(left|right)$/.test(cs.float) && floatImageOf(child)) continue;
      if (MEDIA_TAGS.has(tag) || FORM_TAGS.has(tag)) return false;
      if (isFontIcon(child, cs)) return false;
      if (!INLINE_TAGS.has(tag)) return false;
      if (!cs.display.startsWith('inline') && cs.display !== 'contents') return false;
      if (cs.position === 'absolute' || cs.position === 'fixed') return false;
      if (looksLikeButton(child, cs)) return false;
      if (!isInlineContent(child, false, floats)) return false;
    }
    return true;
  }

  function plainList(el, cs) {
    return !/flex|grid/.test(cs.display) && el.children.length > 0 && [...el.children].every((li) => li.tagName === 'LI' && isInlineContent(li, true));
  }

  // Where a numbered list starts or jumps (<ol start="5" reversed>, <li value="3">).
  function listAttrs(el) {
    const tag = el.tagName.toUpperCase();
    const num = (a) => parseInt(el.getAttribute(a), 10);
    let out = '';
    if (tag === 'OL' && Number.isFinite(num('start'))) out += ` start="${num('start')}"`;
    if (tag === 'OL' && el.hasAttribute('reversed')) out += ' reversed';
    if (tag === 'LI' && Number.isFinite(num('value'))) out += ` value="${num('value')}"`;
    return out;
  }

  // List items with their own look where it differs from base (the style the widget's
  // typography comes from): type, spacing, padding, rules between items, tinted rows.
  // The first item's top and the last item's bottom margin belong to the list's own margin.
  function listItemsHtml(el, base = getComputedStyle(el)) {
    const items = [...el.children];
    return items.map((li, i) => {
      const lcs = getComputedStyle(li);
      const st = [];
      if (lcs.color !== base.color) st.push(`color:${rgbToHex(lcs.color)}`);
      if (lcs.fontSize !== base.fontSize) st.push(`font-size:${lcs.fontSize}`);
      if (lcs.fontWeight !== base.fontWeight) st.push(`font-weight:${lcs.fontWeight}`);
      if (lcs.fontStyle !== base.fontStyle) st.push(`font-style:${lcs.fontStyle}`);
      if (lcs.lineHeight !== base.lineHeight) st.push(`line-height:${lcs.lineHeight}`);
      const mt = i > 0 ? px(lcs.marginTop) : 0;
      const mb = i < items.length - 1 ? px(lcs.marginBottom) : 0;
      if (mt) st.push(`margin-top:${mt}px`);
      if (mb) st.push(`margin-bottom:${mb}px`);
      const pad = box(lcs, 'padding');
      if (pad.some((v) => v > 0)) st.push(`padding:${pad.map((v) => v + 'px').join(' ')}`);
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
        const w = px(lcs['border' + side + 'Width']);
        if (w && lcs['border' + side + 'Style'] !== 'none') st.push(`border-${side.toLowerCase()}:${w}px ${lcs['border' + side + 'Style']} ${rgbToHex(lcs['border' + side + 'Color'])}`);
      }
      if (!isTransparent(lcs.backgroundColor)) st.push(`background-color:${rgbToHex(lcs.backgroundColor)}`);
      return `<li${listAttrs(li)}${st.length ? ` style="${st.join(';')}"` : ''}>${cleanHtml(li)}</li>`;
    }).join('');
  }

  // Rich text with inline styles only where a run differs from its block (colour, weight, size, font...).
  // pre: a code block, whose spaces and line breaks are kept as they are.
  // floats: an image floated among the words stays where it is, aligned (WordPress's alignleft).
  function cleanHtml(el, { pre = false, floats = false } = {}) {
    const base = getComputedStyle(el);
    const gradientColor = (cs) => {
      if (cs.webkitBackgroundClip !== 'text' && cs.backgroundClip !== 'text') return null;
      return (cs.backgroundImage.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}/i) || [])[0] || null;
    };
    const diffStyle = (cs, parentCs, tag) => {
      const out = [];
      // Tags that carry their own look (em is italic, strong bold, mark yellow): when the
      // page resets that look, the reset is written out or the tag's default comes back.
      if (/^(EM|I|CITE|VAR|DFN|ADDRESS)$/.test(tag) && cs.fontStyle === 'normal') out.push('font-style:normal');
      if (/^(STRONG|B)$/.test(tag) && Number(cs.fontWeight) <= Number(parentCs.fontWeight)) out.push(`font-weight:${cs.fontWeight}`);
      if (/^(U|INS|S|DEL)$/.test(tag) && cs.textDecorationLine === 'none') out.push('text-decoration:none');
      if (tag === 'MARK' && isTransparent(cs.backgroundColor)) out.push('background-color:transparent');
      // Nested lists keep their indent, bullet and spacing.
      if (/^(UL|OL)$/.test(tag)) out.push(`margin:${px(cs.marginTop)}px 0 ${px(cs.marginBottom)}px`, `padding-left:${px(cs.paddingLeft)}px`, `list-style-type:${cs.listStyleType}`);
      if (tag === 'LI' && px(cs.marginBottom)) out.push(`margin-bottom:${px(cs.marginBottom)}px`);
      // Gradient-filled words: Elementor has no gradient text, so use the gradient's first colour.
      const gc = gradientColor(cs);
      if (gc) out.push(`color:${rgbToHex(gc)}`);
      else if (cs.color !== parentCs.color) out.push(`color:${rgbToHex(cs.color)}`);
      if (cs.fontWeight !== parentCs.fontWeight && !out.some((d) => d.startsWith('font-weight'))) out.push(`font-weight:${cs.fontWeight}`);
      if (cs.fontSize !== parentCs.fontSize) out.push(`font-size:${cs.fontSize}`);
      if (cs.fontStyle !== parentCs.fontStyle && !out.some((d) => d.startsWith('font-style')) && !(/^(EM|I|CITE|VAR|DFN|ADDRESS)$/.test(tag) && cs.fontStyle === 'italic')) out.push(`font-style:${cs.fontStyle}`);
      if (cs.fontFamily !== parentCs.fontFamily) out.push(`font-family:${renderedStack(cs.fontFamily).replace(/"/g, "'")}`);
      if (cs.textDecorationLine !== parentCs.textDecorationLine) out.push(`text-decoration:${cs.textDecorationLine}`);
      if (cs.textTransform !== parentCs.textTransform) out.push(`text-transform:${cs.textTransform}`);
      if (cs.letterSpacing !== parentCs.letterSpacing) out.push(`letter-spacing:${cs.letterSpacing}`);
      // Highlighted or outlined words (code, badges, "V" tags): their box, as the editor stores it.
      const fill = !isTransparent(cs.backgroundColor) && cs.backgroundColor !== parentCs.backgroundColor;
      const br = border(cs);
      if (fill || br.style) {
        if (fill) out.push(`background-color:${rgbToHex(cs.backgroundColor)}`);
        // A one-sided border (a link's border-bottom underline) stays on its own side, not a box.
        if (br.style && br.width.every((v) => v === br.width[0])) out.push(`border:${br.width[0]}px ${br.style} ${br.color}`);
        else if (br.style) ['top', 'right', 'bottom', 'left'].forEach((side, i) => br.width[i] && out.push(`border-${side}:${br.width[i]}px ${br.style} ${br.color}`));
        const pad = box(cs, 'padding');
        if (pad.some((v) => v > 0)) out.push(`padding:${pad.map((v) => v + 'px').join(' ')}`);
        if (br.radius) out.push(`border-radius:${br.radius.map((v) => v + br.radiusUnit).join(' ')}`);
        if (cs.display === 'inline-block') out.push('display:inline-block');
        if (cs.display === 'inline-block' && cs.lineHeight !== parentCs.lineHeight) out.push(`line-height:${cs.lineHeight}`);
        if (cs.verticalAlign !== 'baseline') out.push(`vertical-align:${cs.verticalAlign}`);
        const ml = px(cs.marginLeft), mr = px(cs.marginRight);
        if (ml || mr) out.push(`margin:0 ${mr}px 0 ${ml}px`);
      }
      return out.join(';');
    };
    const walkText = (node, parentCs) => {
      let out = '';
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const t = child.textContent.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
          // Text set with white-space: pre, pre-wrap or pre-line keeps its line breaks.
          out += !pre && /^(pre|pre-wrap|pre-line|break-spaces)$/.test(parentCs.whiteSpace) ? t.replace(/\r?\n/g, '<br>') : t;
        } else if (child.nodeType === Node.ELEMENT_NODE && !SKIP_TAGS.has(child.tagName.toUpperCase())) {
          const cs = getComputedStyle(child);
          if (cs.display === 'none') continue;
          const tag = child.tagName.toUpperCase();
          // Icons are converted separately, never as text.
          if (tag === 'SVG' || isFontIcon(child, cs)) continue;
          if (/^(left|right)$/.test(cs.float) && floatImageOf(child)) {
            if (floats) out += alignedImgHtml(child, cs, floatImageOf(child), box(cs, 'margin'));
            continue;
          }
          const inner = walkText(child, cs);
          if (tag === 'BR') { out += '<br>'; continue; }
          const style = diffStyle(cs, parentCs, tag);
          // Inside a code block <code> would only bring back the theme's plain monospace font.
          const keep = KEEP_HTML_TAGS.has(tag) && !(pre && tag === 'CODE') ? tag.toLowerCase() : style ? 'span' : null;
          if (!keep) { out += inner; continue; }
          const href = tag === 'A' && child.getAttribute('href') ? ` href="${esc(child.href)}"` : '';
          const num = listAttrs(child);
          // Links always carry their colour, or the theme's link colour takes over.
          let st = style;
          if (tag === 'A' && !/(^|;)color:/.test(st)) st = (st ? st + ';' : '') + `color:${rgbToHex(gradientColor(cs) || cs.color)}`;
          if (tag === 'A' && !/text-decoration/.test(st)) st += `;text-decoration:${cs.textDecorationLine === 'none' ? 'none' : cs.textDecorationLine}`;
          // Plain <span>s without a visible difference add nothing.
          if (keep === 'span' && !style) { out += inner; continue; }
          out += `<${keep}${href}${num}${st ? ` style="${esc(st)}"` : ''}>${inner}</${keep}>`;
        }
      }
      return out;
    };
    const html = walkText(el, base);
    return pre ? html : html.replace(/\s+/g, ' ').trim();
  }

  function textOf(el) {
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // Screen-reader-only labels: 1px clipped boxes taken out of the flow.
  function srOnly(el) {
    const ecs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return /^(absolute|fixed)$/.test(ecs.position) && r.width <= 1 && r.height <= 1 && (ecs.overflow === 'hidden' || ecs.clip !== 'auto' || ecs.clipPath !== 'none');
  }

  // The words a visitor sees: screen-reader-only labels are left out.
  function shownText(el) {
    const hidden = [...el.querySelectorAll('*')].filter(srOnly);
    if (!hidden.length) return textOf(el);
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let out = '';
    for (let t = tw.nextNode(); t; t = tw.nextNode()) {
      if (!hidden.some((h) => h.contains(t)) && !t.parentElement.closest('svg') && t.parentElement.getClientRects().length) out += t.textContent;
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  // Two or more thin horizontal lines drawn by CSS (a hamburger made of empty spans,
  // or of one span and its ::before / ::after): their colour and width.
  function drawnBars(el) {
    const bars = [];
    for (const c of [el, ...el.querySelectorAll('*')]) {
      const ccs = getComputedStyle(c);
      if (ccs.display === 'none' || ccs.visibility === 'hidden') continue;
      const r = c.getBoundingClientRect();
      if (c !== el && !isTransparent(ccs.backgroundColor) && !transformOf(ccs) && r.width >= 8 && r.height >= 1 && r.height <= r.width / 3) bars.push({ w: r.width, color: rgbToHex(ccs.backgroundColor) });
      for (const which of ['::before', '::after']) {
        const p = getComputedStyle(c, which);
        const pw = px(p.width), ph = px(p.height);
        if (p.content && p.content !== 'none' && p.content !== 'normal' && p.display !== 'none' && !isTransparent(p.backgroundColor) && !transformOf(p) && pw >= 8 && ph >= 1 && ph <= pw / 3) bars.push({ w: pw, color: rgbToHex(p.backgroundColor) });
      }
    }
    if (bars.length < 2 || bars.some((b) => b.color !== bars[0].color)) return null;
    return { w: Math.max(...bars.map((b) => b.w)), color: bars[0].color };
  }

  function looksLikeButton(el, cs) {
    const tag = el.tagName.toUpperCase();
    const text = textOf(el);
    if (tag === 'BUTTON' || (tag === 'INPUT' && /^(submit|button|reset)$/i.test(el.type))) return true;
    if (tag !== 'A' && !/\b(btn|button)\b/i.test(el.getAttribute('class') || '')) return false;
    if (!text || text.length > 60) return false;
    if (el.querySelector('a, button, img, input')) return false;
    if (tag !== 'A') return hasVisualBox(cs);
    const padded = px(cs.paddingLeft) + px(cs.paddingRight) >= 12 && px(cs.paddingTop) + px(cs.paddingBottom) >= 4;
    // Fixed-size links (height/width set, text centred) drawn as a box are buttons too.
    const r = el.getBoundingClientRect();
    const sized = hasVisualBox(cs) && /flex|inline-block|block|grid/.test(cs.display) && r.height >= 24 && r.height <= 96 && r.width <= 480;
    return (padded && (hasVisualBox(cs) || /\b(btn|button)\b/i.test(el.getAttribute('class') || ''))) || sized;
  }

  // A button or link with no words, just a glyph (close ×, menu, arrows): an Icon
  // widget keeps its shape, colour, box and link instead of an empty button.
  // A screen-reader-only label is not a visible word; it names the glyph instead.
  function iconButtonOf(el, cs) {
    const tag = el.tagName.toUpperCase();
    if (!(tag === 'BUTTON' || tag === 'A' || el.getAttribute('role') === 'button') || shownText(el) || el.querySelector('img, picture, video, canvas')) return null;
    const r = el.getBoundingClientRect();
    if (r.width > 72 || r.height > 72 || r.width < 8 || r.height < 8) return null;
    const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${textOf(el)}`.trim();
    const base = { ...widgetBase(el, cs, 'icon'), href: tag === 'A' ? el.href : null, background: { color: background(cs)?.color }, border: border(cs), shadow: shadow(cs), buttonBox: true };
    const glyph = [...el.querySelectorAll('svg, i, span')].find((c) => (c.tagName.toLowerCase() === 'svg' || isFontIcon(c, getComputedStyle(c))) && !c.parentElement.closest('svg'));
    if (glyph) {
      const ic = makeIcon(glyph, getComputedStyle(glyph));
      return { ...ic, ...base, hints: `${ic.hints} ${label}`, ownHints: `${ic.ownHints} ${label}` };
    }
    // A menu toggle drawn as bars: Font Awesome's bars glyph is 7/8 of the icon size wide.
    const bars = drawnBars(el);
    if (bars) return { ...base, hints: `fa-bars ${label}`, ownHints: 'fa-bars', svg: null, color: bars.color, size: Math.round(bars.w / 0.875) };
    // Glyph drawn as the button's background image (Bootstrap's close button).
    // Computed values always quote the URL with double quotes; the SVG inside may hold single ones.
    const uri = cs.backgroundImage.match(/url\("(data:image\/svg\+xml[^"]+)"\)/)?.[1];
    if (!uri) return null;
    let svg = null;
    try {
      svg = uri.includes(';base64,') ? atob(uri.slice(uri.indexOf(',') + 1)) : decodeURIComponent(uri.slice(uri.indexOf(',') + 1));
    } catch {
      return null;
    }
    const fill = svg.match(/\bfill=['"]([^'"]+)['"]/)?.[1];
    const probe = document.createElement('span');
    probe.style.color = fill && fill !== 'none' ? fill : cs.color;
    document.body.appendChild(probe);
    const color = rgbToHex(getComputedStyle(probe).color);
    probe.remove();
    const hints = `${el.getAttribute('class') || ''} ${label}`.toLowerCase();
    return { ...base, hints, ownHints: hints, svg, color, size: Math.round(px(cs.backgroundSize.split(' ')[0]) || Math.min(r.width, r.height)) };
  }

  function widgetBase(el, cs, kind) {
    return { kind, tag: el.tagName.toLowerCase(), rect: rect(el), margin: box(cs, 'margin'), padding: box(cs, 'padding'), positioned: positioning(el, cs), transform: transformOf(cs), opacity: parseFloat(cs.opacity) < 1 ? parseFloat(cs.opacity) : null };
  }

  // An inline element that sits between blocks (a <span> label above a heading)
  // gets a line box at least as tall as its parent's line height, while its own
  // rect only covers the glyphs. Use the line box, so the spacing comes out right.
  function fitToLineBox(el, node) {
    const parent = el.parentElement;
    if (!parent) return;
    const lines = new Set([...el.getClientRects()].map((r) => Math.round(r.top))).size;
    if (lines !== 1) return;
    const pcs = getComputedStyle(parent);
    const prev = el.previousElementSibling, next = el.nextElementSibling;
    // Only when it is alone on its line between block siblings.
    const inlineSib = (e) => e && (getComputedStyle(e).display.startsWith('inline') || /^(absolute|fixed)$/.test(getComputedStyle(e).position));
    if (inlineSib(prev) || inlineSib(next)) return;
    const pr = parent.getBoundingClientRect();
    const top = prev ? prev.getBoundingClientRect().bottom + px(getComputedStyle(prev).marginBottom) : pr.top + px(pcs.borderTopWidth) + px(pcs.paddingTop);
    const bottom = next ? next.getBoundingClientRect().top - px(getComputedStyle(next).marginTop) : pr.bottom - px(pcs.borderBottomWidth) - px(pcs.paddingBottom);
    const h = bottom - top;
    const own = node.style.lineHeight || node.style.fontSize * 1.2;
    if (h < own - 0.5 || h > own * 3) return;
    node.rect = { ...node.rect, y: Math.round(top + scrollY), h: Math.round(h) };
    if (h > own + 0.5) node.style = { ...node.style, lineHeight: Math.round(h * 100) / 100 };
  }

  // The words of a pseudo element's content: "..." (escapes decoded); empty for
  // anything else, blank text and icon-font glyphs.
  function contentText(p) {
    const m = p.content && p.content.match(/^"((?:[^"\\]|\\.)*)"$/);
    if (!m) return '';
    const text = m[1].replace(/\\([0-9a-f]{1,6})\s?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/\\(.)/g, '$1');
    return !text.trim() || /[\ue000-\uf8ff]/.test(text) ? '' : text;
  }

  // Text a stylesheet adds with ::before / ::after (breadcrumb slashes, list dashes),
  // kept as a styled span so it shows in the Text Editor. Icon-font glyphs and
  // positioned decorations are handled elsewhere.
  function pseudoSpan(el, cs, which) {
    const p = getComputedStyle(el, which);
    if (p.display === 'none' || /^(absolute|fixed)$/.test(p.position)) return '';
    const text = contentText(p);
    if (!text) return '';
    const st = [];
    if (p.color !== cs.color) st.push(`color:${rgbToHex(p.color)}`);
    if (p.fontWeight !== cs.fontWeight) st.push(`font-weight:${p.fontWeight}`);
    if (p.fontSize !== cs.fontSize) st.push(`font-size:${p.fontSize}`);
    for (const side of ['Left', 'Right']) {
      const v = px(p['padding' + side]) + px(p['margin' + side]);
      if (v) st.push(`padding-${side.toLowerCase()}:${Math.round(v * 10) / 10}px`);
    }
    return st.length ? `<span style="${st.join(';')}">${esc(text)}</span>` : esc(text);
  }

  function makeText(el, cs) {
    const tag = el.tagName.toUpperCase();
    const range = document.createRange();
    range.selectNodeContents(el);
    let textW = Math.round(range.getBoundingClientRect().width * 10) / 10;
    let html = cleanHtml(el, { pre: tag === 'PRE' });
    const before = pseudoSpan(el, cs, '::before'), after = pseudoSpan(el, cs, '::after');
    if (before || after) {
      html = `${before}${html}${after}`;
      // The added text widens the line; the box (less its padding) is the line's width.
      const r = el.getBoundingClientRect();
      textW = Math.round((r.width - px(cs.paddingLeft) - px(cs.paddingRight) - px(cs.borderLeftWidth) - px(cs.borderRightWidth)) * 10) / 10;
    }
    // A link shown as a block (a nav item, "Read more"): cleanHtml only sees its words, so the link goes on the node.
    const href = tag === 'A' && el.getAttribute('href') ? el.href : null;
    const base = { html, text: textOf(el), textW, align: cs.textAlign, style: typography(cs), background: background(cs), border: border(cs), shadow: shadow(cs), whiteSpace: cs.whiteSpace, href };
    if (/^H[1-6]$/.test(tag)) return { ...widgetBase(el, cs, 'heading'), level: Number(tag[1]), ...base };
    // Code blocks keep their syntax colours and line breaks.
    if (tag === 'PRE') return { ...widgetBase(el, cs, 'text'), ...base, pre: true };
    if (tag === 'BLOCKQUOTE') return { ...widgetBase(el, cs, 'text'), ...base, quote: true };
    return { ...widgetBase(el, cs, 'text'), ...base };
  }

  function makeButton(el, cs) {
    // Typography from the element that actually holds the label.
    let textEl = el;
    while (textEl.children.length === 1 && textOf(textEl.children[0]) === textOf(textEl)) textEl = textEl.children[0];
    const tcs = getComputedStyle(textEl);
    // Icons inside the button (svg or icon font), before or after the label.
    const icons = [...el.querySelectorAll('svg, i, span')].filter((c) => (c.tagName.toLowerCase() === 'svg' || isFontIcon(c, getComputedStyle(c))) && !c.parentElement.closest('svg'));
    let icon = null;
    if (icons.length) {
      const ic = icons[0];
      const ir = ic.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(el);
      const textRects = [...range.getClientRects()].filter((r) => r.width > 0);
      const left = !textRects.length || ir.left < Math.min(...textRects.map((r) => r.left)) + 2;
      const gap = left ? Math.max(0, Math.round((textRects.find((r) => r.left >= ir.right - 1)?.left ?? ir.right) - ir.right)) : Math.max(0, Math.round(ir.left - (textRects.some((r) => r.right <= ir.left + 1) ? Math.max(...textRects.filter((r) => r.right <= ir.left + 1).map((r) => r.right)) : ir.left)));
      icon = { ...makeIcon(ic, getComputedStyle(ic)), position: left ? 'left' : 'right', gap };
    }
    // Width of the label itself, so fixed-width buttons can keep their size through padding.
    let textW = null;
    if (el.tagName !== 'INPUT') {
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let x0 = Infinity, x1 = -Infinity;
      for (let t = tw.nextNode(); t; t = tw.nextNode()) {
        if (!t.textContent.trim() || t.parentElement.closest('svg') || srOnly(t.parentElement)) continue;
        const r = document.createRange();
        r.selectNodeContents(t);
        for (const b of r.getClientRects()) if (b.width > 0) { x0 = Math.min(x0, b.left); x1 = Math.max(x1, b.right); }
      }
      if (x1 > x0) textW = Math.round((x1 - x0) * 10) / 10;
    }
    return {
      ...widgetBase(el, cs, 'button'),
      textW,
      text: el.tagName === 'INPUT' ? el.value : shownText(el),
      href: el.tagName === 'A' ? el.href : null,
      style: typography(tcs),
      background: background(cs),
      border: border(cs),
      shadow: shadow(cs),
      icon,
      display: cs.display,
      justify: cs.justifyContent,
    };
  }

  function makeImage(el, cs) {
    const img = el.tagName === 'PICTURE' ? el.querySelector('img') || el : el;
    const ics = img === el ? cs : getComputedStyle(img);
    const href = img.closest('a')?.href || null;
    return {
      ...widgetBase(img, ics, 'image'),
      src: img.currentSrc || img.src || null,
      alt: img.getAttribute('alt') || '',
      objectFit: ics.objectFit,
      objectPosition: ics.objectPosition,
      border: border(ics),
      shadow: shadow(ics),
      href,
    };
  }

  function makeDivider(el, cs) {
    const b = border(cs);
    return { ...widgetBase(el, cs, 'divider'), color: b.color || rgbToHex(cs.backgroundColor) || '#000000', weight: (b.width && Math.max(...b.width)) || rect(el).h || 1, style: b.style || 'solid' };
  }

  function makeEmbed(el, cs) {
    const src = el.src || el.getAttribute('data') || el.getAttribute('src') || '';
    let provider = 'other';
    if (/youtube(-nocookie)?\.com\/embed|youtu\.be/.test(src)) provider = 'youtube';
    else if (/player\.vimeo\.com/.test(src)) provider = 'vimeo';
    else if (/google\.[a-z.]+\/maps|maps\.google\./.test(src)) provider = 'maps';
    return { ...widgetBase(el, cs, 'embed'), provider, src, title: el.getAttribute('title') || '', lazy: el.getAttribute('loading') === 'lazy', border: border(cs) };
  }

  function makeVideo(el, cs) {
    return {
      ...widgetBase(el, cs, 'video'),
      src: el.currentSrc || el.src || el.querySelector('source')?.src || '',
      poster: el.poster || '',
      autoplay: el.autoplay, loop: el.loop, muted: el.muted, controls: el.controls, playsinline: el.playsInline,
      objectFit: cs.objectFit,
      border: border(cs),
    };
  }

  // A run of <details> siblings becomes one accordion.
  function makeAccordion(detailsList, parentCs) {
    const items = detailsList.map((d) => {
      const dcs = getComputedStyle(d);
      const summary = d.querySelector(':scope > summary');
      const scs = summary ? getComputedStyle(summary) : dcs;
      const wasOpen = d.open;
      d.open = true;
      const children = [];
      for (const c of d.children) {
        if (c === summary) continue;
        const n = walk(c, 3);
        if (n) children.push(n);
      }
      // The panel is the part of the open <details> below its summary. Elementor pads
      // the title the same way open or closed, so the item's own padding goes on the
      // title, and the panel starts that far below the summary (its first child gets a
      // negative top margin when the source spacing is tighter).
      const dr = rect(d);
      const ip = box(dcs, 'padding');
      const sb = summary ? Math.round(summary.getBoundingClientRect().bottom + scrollY) + ip[2] : dr.y;
      const dbw = border(dcs).width || [0, 0, 0, 0];
      const panel = { x: dr.x + dbw[3], y: sb, w: dr.w - dbw[1] - dbw[3], h: Math.max(0, dr.y + dr.h - dbw[2] - sb) };
      const content = children.length ? { kind: 'container', tag: 'div', rect: panel, direction: 'column', wrap: false, justify: 'normal', alignItems: 'normal', gap: { column: 0, row: 0 }, padding: [0, ip[1], 0, ip[3]], margin: [0, 0, 0, 0], children } : null;
      // An icon inside the summary (plus, chevron) becomes the accordion's own icon, open and closed.
      const markerEl = summary && [...summary.querySelectorAll('svg, i, span')].find((c) => c.tagName.toLowerCase() === 'svg' || isFontIcon(c, getComputedStyle(c)));
      const markerOpen = markerEl ? makeIcon(markerEl, getComputedStyle(markerEl)) : null;
      d.open = false;
      const markerClosed = markerEl ? makeIcon(markerEl, getComputedStyle(markerEl)) : null;
      d.open = wasOpen;
      // Disclosure marker: the browser triangle, a custom icon, or nothing.
      let marker = 'custom';
      let markerGap = null;
      if (summary) {
        const mk = getComputedStyle(summary, '::marker');
        if (scs.display === 'list-item' && scs.listStyleType !== 'none' && mk.content !== 'none') {
          marker = 'caret';
          markerGap = Math.round(px(scs.fontSize) * 0.5);
        } else if (!summary.querySelector('svg, i') && !['::before', '::after'].some((w) => { const p = getComputedStyle(summary, w); return p.content && p.content !== 'none' && p.content !== 'normal'; })) marker = 'none';
      }
      const sp = box(scs, 'padding');
      return {
        title: summary ? textOf(summary) : 'Item',
        marker,
        markerGap,
        markerClosed,
        markerOpen,
        markerEnd: !!markerEl && /space-between/.test(scs.justifyContent),
        open: wasOpen,
        titleStyle: typography(scs),
        titlePadding: [sp[0] + ip[0], sp[1] + ip[1], sp[2] + ip[2], sp[3] + ip[3]],
        titleBackground: background(scs),
        itemBorder: border(dcs),
        itemBackground: background(dcs),
        itemPadding: box(dcs, 'padding'),
        rect: rect(d),
        content,
      };
    });
    const first = detailsList[0];
    const last = detailsList[detailsList.length - 1];
    const r1 = first.getBoundingClientRect();
    const r2 = last.getBoundingClientRect();
    const gap = detailsList.length > 1 ? Math.max(0, Math.round(detailsList[1].getBoundingClientRect().top - r1.bottom)) : 0;
    const fcs = getComputedStyle(first);
    return {
      kind: 'accordion', tag: 'details', rect: { x: Math.round(r1.left + scrollX), y: Math.round(r1.top + scrollY), w: Math.round(r1.width), h: Math.round(r2.bottom - r1.top) },
      margin: box(fcs, 'margin'), padding: [0, 0, 0, 0], items, gap, positioned: null,
    };
  }


  // ---------- script-driven tabs and accordions (Bootstrap, ARIA) ----------
  function toggleTarget(btn) {
    const raw = btn.getAttribute('aria-controls') || btn.getAttribute('data-bs-target') || btn.getAttribute('data-target') || btn.getAttribute('href') || '';
    const id = raw.replace(/^#/, '');
    if (!id || (!btn.getAttribute('aria-controls') && !raw.startsWith('#')) || !/^[\w:.-]+$/.test(id)) return null;
    return document.getElementById(id);
  }

  // Shows one hidden panel while it is measured; returns a function that undoes it.
  function reveal(panel, display) {
    const saved = panel.getAttribute('style');
    panel.style.setProperty('display', display || 'block', 'important');
    panel.style.setProperty('opacity', '1', 'important');
    panel.style.setProperty('visibility', 'visible', 'important');
    panel.style.setProperty('height', 'auto', 'important');
    panel.style.setProperty('transition', 'none', 'important');
    return () => (saved == null ? panel.removeAttribute('style') : panel.setAttribute('style', saved));
  }
  function conceal(panel) {
    const saved = panel.getAttribute('style');
    panel.style.setProperty('display', 'none', 'important');
    return () => (saved == null ? panel.removeAttribute('style') : panel.setAttribute('style', saved));
  }

  const panelBox = (r, children, padding = [0, 0, 0, 0]) => ({ kind: 'container', tag: 'div', rect: r, direction: 'column', wrap: false, justify: 'normal', alignItems: 'normal', gap: { column: 0, row: 0 }, padding, margin: [0, 0, 0, 0], children });

  // .accordion-item style blocks: each holds one toggle button and the panel it opens.
  function ariaAccordionOf(el) {
    const items = [...el.children].filter((c) => !SKIP_TAGS.has(c.tagName.toUpperCase()) && isVisible(c, getComputedStyle(c)));
    if (items.length < 2) return null;
    const entries = [];
    for (const item of items) {
      const toggles = [...item.querySelectorAll('[aria-expanded][aria-controls], [data-bs-toggle="collapse"], [data-toggle="collapse"]')];
      if (toggles.length !== 1) return null;
      const btn = toggles[0];
      const panel = toggleTarget(btn);
      if (!panel || !item.contains(panel) || panel.contains(btn) || btn.contains(panel)) return null;
      const header = [...item.children].find((c) => c.contains(btn));
      if (!header || header.contains(panel)) return null;
      entries.push({ item, btn, panel, header });
    }
    const isOpen = (e) => e.btn.getAttribute('aria-expanded') === 'true' || isVisible(e.panel, getComputedStyle(e.panel));
    const openEntry = entries.find(isOpen);
    const closedEntry = entries.find((e) => !isOpen(e));
    const openCs = openEntry ? getComputedStyle(openEntry.btn) : null;
    const openStyle = openCs ? { titleStyleOpen: typography(openCs), titleBackgroundOpen: background(openCs) } : {};
    const closedCs = closedEntry ? getComputedStyle(closedEntry.btn) : null;
    const out = entries.map((e) => {
      const open = isOpen(e);
      const undo = open ? () => {} : reveal(e.panel);
      const ics = getComputedStyle(e.item);
      const bcs = closedCs || getComputedStyle(e.btn);
      const ir = rect(e.item);
      const hb = Math.round(e.header.getBoundingClientRect().bottom + scrollY);
      const ibw = border(ics).width || [0, 0, 0, 0];
      const node = walk(e.panel, 3);
      const panelRect = { x: ir.x + ibw[3], y: hb, w: ir.w - ibw[1] - ibw[3], h: Math.max(0, ir.y + ir.h - ibw[2] - hb) };
      const content = node ? panelBox(panelRect, [node]) : null;
      undo();
      const after = getComputedStyle(e.btn, '::after'), before = getComputedStyle(e.btn, '::before');
      const pseudo = [after, before].some((p) => p.content && p.content !== 'none' && p.content !== 'normal');
      const markerEl = [...e.btn.querySelectorAll('svg, i, span')].find((c) => c.tagName.toLowerCase() === 'svg' || isFontIcon(c, getComputedStyle(c)));
      const marker = markerEl ? makeIcon(markerEl, getComputedStyle(markerEl)) : null;
      return {
        title: textOf(e.btn),
        marker: markerEl || pseudo ? 'custom' : 'none',
        markerGap: null,
        markerClosed: open ? null : marker,
        markerOpen: open ? marker : null,
        markerEnd: true,
        open,
        titleStyle: typography(bcs),
        ...openStyle,
        titlePadding: box(bcs, 'padding'),
        titleBackground: background(bcs),
        itemBorder: border(ics),
        itemBackground: background(ics),
        itemPadding: box(ics, 'padding'),
        rect: ir,
        content,
      };
    });
    const r1 = entries[0].item.getBoundingClientRect(), r2 = entries[entries.length - 1].item.getBoundingClientRect();
    const gap = Math.max(0, Math.round(entries[1].item.getBoundingClientRect().top - r1.bottom));
    return {
      kind: 'accordion', tag: 'div', rect: { x: Math.round(r1.left + scrollX), y: Math.round(r1.top + scrollY), w: Math.round(r1.width), h: Math.round(r2.bottom - r1.top) },
      margin: box(getComputedStyle(el), 'margin'), padding: [0, 0, 0, 0], items: out, gap, positioned: null,
    };
  }

  const TABLIST = '[role="tablist"], .nav-tabs, .nav-pills';
  const TAB = '[role="tab"], [data-bs-toggle="tab"], [data-bs-toggle="pill"], [data-toggle="tab"], [data-toggle="pill"]';

  // A tab strip (child, or inside child) whose panels follow it: the panels'
  // wrapper (or the panels themselves) are later siblings. Returns the tabs node and
  // the sibling elements it replaces.
  function tabsAt(child, siblings) {
    const list = child.matches(TABLIST) ? child : child.querySelector(TABLIST);
    if (!list) return null;
    const tabEls = [...list.querySelectorAll(TAB)].filter((t) => isVisible(t, getComputedStyle(t)));
    if (tabEls.length < 2) return null;
    const panels = tabEls.map(toggleTarget);
    if (panels.some((p) => !p) || panels.some((p) => child.contains(p))) return null;
    const parent = panels[0].parentElement;
    if (panels.some((p) => p.parentElement !== parent)) return null;
    const after = siblings.slice(siblings.indexOf(child) + 1);
    let wrapper = null, consumed;
    if (after.includes(parent)) { wrapper = parent; consumed = [parent]; }
    else if (panels.every((p) => after.includes(p))) consumed = panels;
    else return null;

    const activeIdx = Math.max(0, tabEls.findIndex((t) => t.getAttribute('aria-selected') === 'true' || t.classList.contains('active')));
    const active = tabEls[activeIdx], inactive = tabEls.find((t, i) => i !== activeIdx) || active;
    const acs = getComputedStyle(active), ics = getComputedStyle(inactive);
    const activePanel = panels[activeIdx];
    const shownDisplay = getComputedStyle(activePanel).display === 'none' ? 'block' : getComputedStyle(activePanel).display;
    const lr = rect(list);
    const wcs = wrapper ? getComputedStyle(wrapper) : null;
    const area = rect(wrapper || activePanel);
    const wb = wcs ? border(wcs) : null;
    const wpad = wcs ? box(wcs, 'padding') : [0, 0, 0, 0];
    const wbw = wb?.width || [0, 0, 0, 0];

    const panelNodes = panels.map((p, i) => {
      const undo = panels.map((q, j) => (j === i ? reveal(q, shownDisplay) : conceal(q)));
      const pr = rect(wrapper || p);
      const inner = { x: pr.x + wbw[3], y: pr.y + wbw[0], w: pr.w - wbw[1] - wbw[3], h: pr.h - wbw[0] - wbw[2] };
      let node = walk(p, 3);
      if (node && node.kind === 'container' && !wrapper) node = { ...node, rect: inner };
      else if (node && node.kind === 'container') node = { ...node, rect: inner, padding: node.padding.map((v, k) => v + wpad[k] + (k === 0 ? rect(p).y - pr.y - wbw[0] - wpad[0] : 0)) };
      else node = panelBox(inner, node ? [node] : [], wpad);
      undo.reverse().forEach((u) => u());
      return node;
    });
    const tr0 = tabEls[0].getBoundingClientRect(), tr1 = tabEls[1].getBoundingClientRect();
    const vertical = Math.abs(tr1.left - tr0.left) < 2;
    const sideBySide = area.x >= lr.x + lr.w - 2;
    const lb = border(getComputedStyle(list));
    return {
      consumed,
      node: {
        kind: 'tabs', tag: 'div',
        rect: { x: Math.min(lr.x, area.x), y: Math.min(lr.y, area.y), w: Math.max(lr.x + lr.w, area.x + area.w) - Math.min(lr.x, area.x), h: Math.max(lr.y + lr.h, area.y + area.h) - Math.min(lr.y, area.y) },
        margin: box(getComputedStyle(child), 'margin'), padding: [0, 0, 0, 0], positioned: null,
        tabs: tabEls.map((t, i) => ({ title: textOf(t), active: i === activeIdx })),
        activeIndex: activeIdx,
        direction: sideBySide ? 'inline-start' : 'block-start',
        headingWidth: lr.w,
        justify: getComputedStyle(list).justifyContent,
        fill: Math.abs((tabEls[tabEls.length - 1].getBoundingClientRect().right - tr0.left) - list.getBoundingClientRect().width) < 3 && !vertical,
        gap: vertical ? Math.max(0, Math.round(tr1.top - tr0.bottom)) : Math.max(0, Math.round(tr1.left - tr0.right)),
        spacing: sideBySide ? Math.max(0, Math.round(area.x - (lr.x + lr.w))) : Math.max(0, Math.round(area.y - (lr.y + lr.h))),
        titleStyle: typography(ics),
        activeStyle: typography(acs),
        titlePadding: box(ics, 'padding'),
        titleAlign: ics.display.includes('flex')
          ? ({ center: 'center', 'flex-end': 'end', end: 'end', right: 'end' }[ics.justifyContent] || 'start')
          : ({ center: 'center', right: 'end', end: 'end' }[ics.textAlign] || 'start'),
        titleBackground: background(ics),
        activeBackground: background(acs),
        titleBorder: border(ics),
        activeBorder: border(acs),
        headingBorder: lb,
        box: wcs ? { border: wb, background: background(wcs) } : null,
        panels: panelNodes,
      },
    };
  }

  // <ul>/<ol> whose items each start with an icon → icon list.
  function iconListOf(el, cs) {
    const lis = [...el.children].filter((c) => c.tagName === 'LI');
    if (lis.length < 2 || lis.length !== el.children.length) return null;
    const parsed = [];
    for (const li of lis) {
      const first = [...li.childNodes].find((n) => n.nodeType === Node.ELEMENT_NODE || n.textContent.trim());
      if (!first || first.nodeType !== Node.ELEMENT_NODE) return null;
      const fcs = getComputedStyle(first);
      const isIcon = first.tagName.toLowerCase() === 'svg' || isFontIcon(first, fcs) || (first.children.length === 1 && first.children[0].tagName.toLowerCase() === 'svg' && !textOf(first));
      if (!isIcon) return null;
      const iconEl = first.tagName.toLowerCase() === 'svg' || isFontIcon(first, fcs) ? first : first.children[0];
      if (!li.textContent.trim()) return null;
      // Text styles from the first text-bearing descendant.
      const textHolder = [...li.querySelectorAll('*')].find((n) => n !== iconEl && !iconEl.contains(n) && textOf(n) && !n.querySelector('svg')) || li;
      const ir = iconEl.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(li);
      const tr = [...range.getClientRects()].filter((r) => r.width > 0 && r.left >= ir.right - 1);
      parsed.push({
        icon: makeIcon(iconEl, getComputedStyle(iconEl)),
        href: li.querySelectorAll('a').length === 1 ? li.querySelector('a').href : null,
        text: textOf(li),
        html: cleanHtml(li),
        style: typography(getComputedStyle(textHolder)),
        rect: rect(li),
        textGap: tr.length ? Math.max(0, Math.round(tr[0].left - ir.right)) : 8,
      });
    }
    const gaps = parsed.slice(1).map((p, i) => p.rect.y - (parsed[i].rect.y + parsed[i].rect.h));
    const inline = parsed.length > 1 && Math.abs(parsed[1].rect.y - parsed[0].rect.y) < 4;
    const hgaps = parsed.slice(1).map((p, i) => p.rect.x - (parsed[i].rect.x + parsed[i].rect.w));
    return {
      ...widgetBase(el, cs, 'iconList'),
      items: parsed,
      layout: inline ? 'inline' : 'traditional',
      space: inline ? Math.max(0, Math.round(hgaps.reduce((a, b) => a + b, 0) / hgaps.length)) : Math.max(0, Math.round(gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length))),
    };
  }

  // A bullet-less column of one-line items (footer link lists, contact lines) →
  // icon list without icons: Elementor's own way to space and link such rows.
  function linkListOf(el, cs) {
    if (cs.display.includes('grid') || (cs.display.includes('flex') && !cs.flexDirection.startsWith('column'))) return null;
    const lis = [...el.children];
    if (lis.length < 2 || lis.some((c) => c.tagName !== 'LI')) return null;
    const items = [];
    for (const li of lis) {
      const lcs = getComputedStyle(li);
      if (lcs.display === 'list-item' && lcs.listStyleType !== 'none') return null;
      if (!isInlineContent(li) || !textOf(li)) return null;
      const links = li.querySelectorAll('a');
      if (links.length > 1 || (links[0] && textOf(links[0]) !== textOf(li))) return null;
      const holder = links[0] || li;
      const style = typography(getComputedStyle(holder));
      const r = rect(li);
      const lh = Math.max(style.lineHeight || style.fontSize * 1.2, lcs.lineHeight === 'normal' ? px(lcs.fontSize) * 1.2 : px(lcs.lineHeight));
      if (r.h > lh * 1.5) return null;
      const mark = inlineMark(li, '::before');
      items.push({ icon: null, mark, text: textOf(li), html: cleanHtml(li), href: links[0]?.href || null, style, rect: r, lineBox: r.h });
    }
    // Every item opens with the same drawn dot: Font Awesome's circle in that colour and size
    // (the outlined circle for a hollow ring). The hints name it, so icon matching keeps it.
    const m0 = items[0].mark;
    const dots = m0?.round && items.every((it) => it.mark?.round && Math.abs(it.mark.w - m0.w) < 1 && it.mark.color === m0.color && it.mark.ring === m0.ring);
    const dot = m0?.ring ? { value: 'far fa-circle', library: 'fa-regular' } : { value: 'fas fa-circle', library: 'fa-solid' };
    for (const it of items) {
      if (dots) Object.assign(it, { icon: { kind: 'icon', fa: dot, hints: dot.value, faConfidence: 'exact', color: m0.color, size: Math.round(m0.w) }, textGap: m0.gap });
      delete it.mark;
    }
    const key = (st) => [st.fontFamily, st.fontSize, st.fontWeight, st.color, st.textTransform, st.letterSpacing].join('|');
    if (items.some((it) => key(it.style) !== key(items[0].style))) return null;
    const gaps = items.slice(1).map((it, i) => it.rect.y - (items[i].rect.y + items[i].rect.h));
    return {
      ...widgetBase(el, cs, 'iconList'),
      items,
      layout: 'traditional',
      noIcons: !dots,
      space: Math.max(0, Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)),
    };
  }

  const SOCIAL = /(facebook\.com|fb\.com|twitter\.com|x\.com|instagram\.com|linkedin\.com|youtube\.com|youtu\.be|tiktok\.com|github\.com|pinterest\.|whatsapp\.com|wa\.me|dribbble\.com|behance\.net|discord\.(gg|com)|t\.me|telegram\.|threads\.net|reddit\.com|medium\.com|twitch\.tv|vimeo\.com|snapchat\.com|spotify\.com|soundcloud\.com|mastodon|bsky\.app|tumblr\.com|skype|slack\.com|stackoverflow\.com|yelp\.|tripadvisor\.|etsy\.com|vk\.com|weibo\.com|xing\.com|flickr\.com|rss)/i;

  // A row of icon-only links to social networks → social icons widget.
  function socialOf(el, cs) {
    const all = el.querySelectorAll('a');
    if (all.length < 2 || all.length > 12) return null;
    if (textOf(el).replace(/\s/g, '').length > all.length * 3) return null;
    if (![...all].every((a) => SOCIAL.test(a.href))) return null;
    const links = [...all].filter((a) => isVisible(a, getComputedStyle(a)));
    if (links.length < 2) return null;
    const items = [];
    for (const a of links) {
      if (!SOCIAL.test(a.href)) return null;
      const iconEl = a.querySelector('svg') || [...a.querySelectorAll('i,span')].find((c) => isFontIcon(c, getComputedStyle(c)));
      if (!iconEl) return null;
      const acs = getComputedStyle(a);
      const ar = a.getBoundingClientRect();
      const icon = makeIcon(iconEl, getComputedStyle(iconEl));
      items.push({ href: a.href, icon, rect: rect(a), background: background(acs), border: border(acs), padding: box(acs, 'padding'), boxSize: Math.round(Math.max(ar.width, ar.height)) });
    }
    // Other content mixed in means it's not a pure icon row.
    const nonLinkText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    if (nonLinkText) return null;
    const gaps = items.slice(1).map((it, i) => it.rect.x - (items[i].rect.x + items[i].rect.w));
    return { ...widgetBase(el, cs, 'social'), items, gap: gaps.length ? Math.max(0, Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)) : 8, align: cs.justifyContent };
  }

  // Five stars (svg / icon font / ★ characters) → star rating widget.
  function ratingOf(el, cs) {
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').toLowerCase();
    const text = textOf(el);
    const starText = text.match(/^[★☆✩✭⭐]{3,10}$/u);
    const kids = [...el.children];
    const iconKids = kids.filter((k) => k.tagName.toLowerCase() === 'svg' || isFontIcon(k, getComputedStyle(k)));
    const starish = (k) => /star/.test(iconHints(k)) || (k.tagName.toLowerCase() === 'svg' && (k.querySelector('polygon') || /M\s*12\s*2|l3\.09|star/i.test(k.innerHTML)));
    if (!starText && !(iconKids.length >= 3 && iconKids.length <= 10 && iconKids.length === kids.length && iconKids.every(starish))) return null;
    if (!starText && !/star|rating|rated/.test(label + ' ' + iconKids.map(iconHints).join(' ')) && !iconKids.every(starish)) return null;
    let max = starText ? [...starText[0]].length : iconKids.length;
    let value = max;
    const m = label.match(/([\d.]+)\s*(out of|\/|of)\s*([\d.]+)/);
    if (m) { value = parseFloat(m[1]); max = parseFloat(m[3]); }
    else if (starText) value = [...starText[0]].filter((c) => c !== '☆' && c !== '✩').length;
    const first = iconKids[0];
    const color = first ? (first.tagName.toLowerCase() === 'svg' ? svgColor(first) : rgbToHex(getComputedStyle(first).color)) : rgbToHex(cs.color);
    const size = first ? Math.round(first.getBoundingClientRect().height) : Math.round(px(cs.fontSize));
    let gap = iconKids.length > 1 ? Math.max(0, Math.round(iconKids[1].getBoundingClientRect().left - iconKids[0].getBoundingClientRect().right)) : 0;
    if (starText && max > 1) {
      // Star characters: spread the icons over the same width (glyphs plus letter spacing).
      const range = document.createRange();
      range.selectNodeContents(el);
      const w = range.getBoundingClientRect().width - (px(cs.letterSpacing) || 0);
      gap = Math.max(0, Math.round((w - max * size) / (max - 1)));
    }
    // The line box the stars sit in ('normal' gives null): a stretched flex item's box is taller.
    return { ...widgetBase(el, cs, 'rating'), value, max, color, size, gap, align: cs.textAlign, lineHeight: px(cs.lineHeight) || null };
  }

  // A filled bar inside a track → progress bar widget.
  function progressOf(el, cs) {
    const isBar = el.getAttribute('role') === 'progressbar' || el.classList.contains('progress') || el.tagName === 'PROGRESS';
    if (!isBar) return null;
    let track = el;
    let fill = el.querySelector('[role=progressbar], .progress-bar, [class*="fill"], [class*="bar"]');
    if (el.getAttribute('role') === 'progressbar' && el.parentElement && el.children.length === 0 && el.parentElement.children.length === 1) { track = el.parentElement; fill = el; }
    if (el.tagName === 'PROGRESS') {
      const pct = Math.round((el.value / (el.max || 1)) * 100);
      return { ...widgetBase(el, cs, 'progress'), percent: pct, barColor: rgbToHex(cs.accentColor) || '#0D6EFD', trackColor: '#E9ECEF', height: rect(el).h, radius: 4, label: '' };
    }
    if (!fill || fill === track) return null;
    const tr = track.getBoundingClientRect();
    const fr = fill.getBoundingClientRect();
    const tcs = getComputedStyle(track);
    const fcs = getComputedStyle(fill);
    return {
      ...widgetBase(track, tcs, 'progress'),
      percent: Math.round((fr.width / Math.max(1, tr.width)) * 100),
      barColor: rgbToHex(fcs.backgroundColor),
      trackColor: rgbToHex(tcs.backgroundColor),
      height: Math.round(tr.height),
      radius: px(tcs.borderTopLeftRadius),
      label: textOf(fill),
      labelStyle: typography(fcs),
    };
  }

  // An empty ::before / ::after drawn inline next to the text (an eyebrow's bar, a
  // list item's dot): its size, look and the space it leaves before the text.
  // A ::before drawn as a block sits above the text instead (marked "above").
  function inlineMark(el, which) {
    const p = getComputedStyle(el, which);
    if (p.content !== '""' || p.display === 'none' || /^(absolute|fixed)$/.test(p.position) || p.float !== 'none' && p.float) return null;
    const draws = !isTransparent(p.backgroundColor) || ['Top', 'Right', 'Bottom', 'Left'].some((d) => p['border' + d + 'Style'] !== 'none' && px(p['border' + d + 'Width']) > 0);
    const b = border(p);
    // The size on screen, border included (a hollow ring is mostly border).
    const bw = b.width || [0, 0, 0, 0];
    const contentBox = p.boxSizing !== 'border-box';
    const w = px(p.width) + (contentBox ? bw[1] + bw[3] + px(p.paddingLeft) + px(p.paddingRight) : 0);
    const h = px(p.height) + (contentBox ? bw[0] + bw[2] + px(p.paddingTop) + px(p.paddingBottom) : 0);
    // In a flex row the mark is an item beside the text, and the row's gap is part of the space.
    const ecs = getComputedStyle(el);
    const flexRow = /flex/.test(ecs.display) && ecs.flexDirection.startsWith('row');
    const beside = p.display.startsWith('inline') || flexRow;
    if (!draws || !(w >= 1 && h >= 1) || (beside && w > 80) || h > 40 || (!beside && which !== '::before')) return null;
    const round = b.radius && (b.radiusUnit === '%' ? Math.min(...b.radius) >= 50 : Math.min(...b.radius) >= Math.min(w, h) / 2 - 0.5);
    // Only a border drawn (a hollow ring): the border is its colour.
    const ring = isTransparent(p.backgroundColor);
    const mark = { w, h, color: rgbToHex(ring ? b.color : p.backgroundColor), ring, background: background(p), border: b, round: !!round && Math.abs(w - h) < 1, which };
    if (beside) return { ...mark, gap: px(which === '::before' ? p.marginRight : p.marginLeft) + (flexRow ? px(ecs.columnGap) : 0) };
    return { ...mark, above: true, marginTop: px(p.marginTop), marginBottom: px(p.marginBottom), marginLeft: px(p.marginLeft) };
  }

  // A small fixed box (bar, dot, swatch) as a container of its own.
  function markBox(mark, x, y) {
    return {
      kind: 'container', tag: 'span', rect: { x: Math.round(x), y: Math.round(y), w: Math.round(mark.w), h: Math.round(mark.h) },
      direction: 'column', wrap: false, justify: 'normal', alignItems: 'normal', gap: { column: 0, row: 0 },
      padding: [0, 0, 0, 0], margin: [0, 0, 0, 0], background: mark.background, border: mark.border, shadow: null,
      positioned: null, minHeight: Math.round(mark.h), fixedWidth: Math.round(mark.w), children: [],
    };
  }

  let droppedPatterns = 0;
  // ::before / ::after boxes that draw something become real (decorative) containers.
  // Positioned words (a large decorative quote mark, a "New" tag) become a placed text widget, or the box's text.
  function pseudoNodes(el, cs) {
    const out = [];
    for (const which of ['::before', '::after']) {
      const p = getComputedStyle(el, which);
      if (!p.content || p.content === 'none' || p.content === 'normal' || p.display === 'none') continue;
      const draws = !isTransparent(p.backgroundColor) || (p.backgroundImage && p.backgroundImage !== 'none') || ['Top', 'Right', 'Bottom', 'Left'].some((s) => p['border' + s + 'Style'] !== 'none' && px(p['border' + s + 'Width']) > 0);
      const text = p.visibility === 'visible' && parseFloat(p.opacity) > 0 && px(p.fontSize) > 0 ? contentText(p) : '';
      const w = px(p.width), h = px(p.height);
      if (!(draws || text) || w < 1 || h < 1) continue;
      if (p.position !== 'absolute') continue;
      // Tiled CSS patterns (dot grids drawn with a small repeating gradient) have no
      // Elementor equivalent; one stretched gradient would smudge the section instead.
      const tiled = /gradient\(/.test(p.backgroundImage) && !/url\(/.test(p.backgroundImage) && !/^(auto|auto auto|cover|contain|100% 100%)$/.test(p.backgroundSize) && isTransparent(p.backgroundColor);
      if (tiled) { droppedPatterns++; continue; }
      const er = el.getBoundingClientRect();
      const left = p.left !== 'auto' ? px(p.left) : p.right !== 'auto' ? er.width - px(p.right) - w : 0;
      const top = p.top !== 'auto' ? px(p.top) : p.bottom !== 'auto' ? er.height - px(p.bottom) - h : 0;
      const bl = px(cs.borderLeftWidth), bt = px(cs.borderTopWidth);
      // A translate (centring with translate(-50%)) moves the box; Elementor only rotates, so it goes into the offsets.
      const shift = p.transform.match(/^matrix\((?:[^,]+,){4}\s*([^,]+),\s*([^)]+)\)$/);
      const x = er.left + scrollX + bl + left + (shift ? px(shift[1]) : 0), y = er.top + scrollY + bt + top + (shift ? px(shift[2]) : 0);
      const positioned = { mode: 'absolute', zIndex: p.zIndex !== 'auto' ? Number(p.zIndex) : null };
      const opacity = parseFloat(p.opacity) < 1 ? parseFloat(p.opacity) : null;
      // The box on screen (padding and border included) and the content box its words sit in.
      const pad = box(p, 'padding'), bw = border(p).width || [0, 0, 0, 0];
      const inset = [pad[0] + bw[0], pad[1] + bw[1], pad[2] + bw[2], pad[3] + bw[3]];
      const outerW = p.boxSizing === 'border-box' ? w : w + inset[1] + inset[3], outerH = p.boxSizing === 'border-box' ? h : h + inset[0] + inset[2];
      const words = text && {
        kind: 'text', tag: 'p', html: esc(text), text, align: p.textAlign, style: typography(p), margin: [0, 0, 0, 0], padding: [0, 0, 0, 0],
        rect: { x: Math.round(x + inset[3]), y: Math.round(y + inset[0]), w: Math.round(outerW - inset[1] - inset[3]), h: Math.round(outerH - inset[0] - inset[2]) },
        textW: Math.round((outerW - inset[1] - inset[3]) * 10) / 10,
      };
      if (!draws) {
        out.push({ ...words, pseudo: which, positioned, transform: transformOf(p), opacity });
        continue;
      }
      out.push({
        kind: 'container', tag: 'div', pseudo: which,
        rect: { x: Math.round(x), y: Math.round(y), w: Math.round(outerW), h: Math.round(outerH) },
        direction: 'column', wrap: false, justify: 'normal', alignItems: 'normal', gap: { column: 0, row: 0 },
        padding: words ? pad : [0, 0, 0, 0], margin: [0, 0, 0, 0], background: background(p), border: border(p), shadow: shadow(p),
        positioned, transform: transformOf(p), opacity,
        minHeight: Math.round(outerH), children: words ? [words] : [],
      });
    }
    return out;
  }

  // ---------- floats ----------
  // A floated image with paragraphs wrapping around it becomes one Text Editor:
  // the image aligned left or right (the WordPress editor's own Align setting)
  // followed by the paragraphs, so the words wrap around it the same way.
  function floatImageOf(el) {
    const tag = el.tagName.toUpperCase();
    if (tag === 'IMG') return el;
    if (tag === 'PICTURE') return el.querySelector('img');
    if (textOf(el)) return null;
    const imgs = el.querySelectorAll('img');
    if (imgs.length !== 1) return null;
    const a = el.getBoundingClientRect(), b = imgs[0].getBoundingClientRect();
    return Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1 ? imgs[0] : null;
  }

  function flowBlock(el, cs, floats = false) {
    const tag = el.tagName.toUpperCase();
    if (!/^(P|DIV|H[1-6]|UL|OL)$/.test(tag) || hasVisualBox(cs) || /flex|grid/.test(cs.display) || /^(absolute|fixed)$/.test(cs.position) || cs.float !== 'none') return false;
    if (tag === 'UL' || tag === 'OL') return plainList(el, cs) && !iconListOf(el, cs) && !linkListOf(el, cs);
    return isInlineContent(el, false, floats) && !!textOf(el) && !looksLikeButton(el, cs);
  }

  // The <img> a Text Editor shows for a floated image, aligned the way WordPress's editor stores it.
  function alignedImgHtml(el, cs, img, m) {
    const ir = img.getBoundingClientRect();
    const ics = getComputedStyle(img);
    const ist = [`float:${cs.float}`, `margin:${m.map((v) => v + 'px').join(' ')}`, `width:${Math.round(ir.width)}px`, `height:${Math.round(ir.height)}px`];
    const ib = border(ics);
    if (ib.radius) ist.push(`border-radius:${ib.radius.map((v) => v + ib.radiusUnit).join(' ')}`);
    if (ics.objectFit !== 'fill') ist.push(`object-fit:${ics.objectFit}`);
    const html = `<img class="align${cs.float}" src="${esc(img.currentSrc || img.src)}" alt="${esc(img.getAttribute('alt') || '')}" width="${Math.round(ir.width)}" height="${Math.round(ir.height)}" style="${esc(ist.join(';'))}">`;
    const link = img.closest('a');
    return link && el.contains(link) ? `<a href="${esc(link.href)}">${html}</a>` : html;
  }

  // An image floated among the words of a paragraph (WordPress puts its alignleft image
  // inside the <p>), when that image is all that keeps the block from being plain text.
  function inlineFloatOf(el, cs) {
    if (!/^(P|DIV|LI|BLOCKQUOTE)$/.test(el.tagName.toUpperCase()) || /flex|grid/.test(cs.display) || !el.querySelector('img')) return null;
    if (isInlineContent(el) || !isInlineContent(el, false, true) || !textOf(el)) return null;
    return [...el.querySelectorAll('*')].find((d) => {
      const dcs = getComputedStyle(d);
      return /^(left|right)$/.test(dcs.float) && isVisible(d, dcs) && floatImageOf(d);
    }) || null;
  }

  // Such a paragraph on its own: one Text Editor, the image aligned where it sits in the words.
  function floatText(el, cs, f) {
    const img = floatImageOf(f);
    const ir = img.getBoundingClientRect();
    const node = { ...makeText(el, cs), html: cleanHtml(el, { floats: true }), floatImage: { src: img.currentSrc || img.src, w: Math.round(ir.width), h: Math.round(ir.height) } };
    // A float taller than the words still takes its room.
    const bottom = Math.round(f.getBoundingClientRect().bottom + px(getComputedStyle(f).marginBottom) + scrollY);
    if (bottom > node.rect.y + node.rect.h) node.rect = { ...node.rect, h: bottom - node.rect.y };
    return node;
  }

  // The siblings that sit beside a float (their top is above its bottom edge). For an image
  // floated inside a paragraph, that paragraph comes first and the blocks after it follow.
  function besideFloat(el, cs, para = null) {
    if ((cs.float !== 'left' && cs.float !== 'right') || /^(absolute|fixed)$/.test(cs.position)) return null;
    const first = para || el;
    // Flex and grid items ignore float: their container lays them out.
    if (first.parentElement && /flex|grid/.test(getComputedStyle(first.parentElement).display)) return null;
    const bottom = el.getBoundingClientRect().bottom + px(cs.marginBottom);
    const blocks = [];
    for (let n = first.nextSibling; n; n = n.nextSibling) {
      if (n.nodeType === Node.TEXT_NODE) {
        if (n.textContent.trim()) return null;
        continue;
      }
      if (n.nodeType !== Node.ELEMENT_NODE || SKIP_TAGS.has(n.tagName.toUpperCase())) continue;
      const ncs = getComputedStyle(n);
      if (!isVisible(n, ncs)) continue;
      if (n.getBoundingClientRect().top >= bottom - 1) break;
      // Floats side by side (a float grid of cards) are a row, not text around one float.
      if (ncs.float !== 'none') return null;
      blocks.push([n, ncs]);
    }
    if (para && blocks.length) blocks.unshift([para, getComputedStyle(para)]);
    return blocks.length ? blocks : null;
  }

  // A block beside a float starts under it (only its lines move aside): in the column
  // beside the float, it and what it holds are cut to the column, padding included.
  function clipToColumn(node, left, right) {
    const r = node.rect;
    const x0 = Math.max(r.x, left), x1 = Math.min(r.x + r.w, right);
    if ((x0 <= r.x && x1 >= r.x + r.w) || x1 - x0 < 1) return;
    if (node.padding) node.padding = [node.padding[0], Math.max(0, node.padding[1] - (r.x + r.w - x1)), node.padding[2], Math.max(0, node.padding[3] - (x0 - r.x))];
    node.rect = { ...r, x: Math.round(x0), w: Math.round(x1 - x0) };
    for (const c of node.children || []) if (!c.positioned) clipToColumn(c, left, right);
  }

  function floatGroup(el, cs, depth, para = null) {
    // An image floated inside a paragraph only takes the blocks below along when the paragraph is plain text.
    if (para && !flowBlock(para, getComputedStyle(para), true)) return null;
    const blocks = besideFloat(el, cs, para);
    if (!blocks) return null;
    const fr = el.getBoundingClientRect();
    const outer = { top: fr.top - px(cs.marginTop), right: fr.right + px(cs.marginRight), bottom: fr.bottom + px(cs.marginBottom), left: fr.left - px(cs.marginLeft) };
    const rects = blocks.map(([b]) => b.getBoundingClientRect());
    const img = floatImageOf(el);
    // A paragraph that holds its own floated image keeps it in place, aligned.
    if (!img || !blocks.every(([b, bcs]) => flowBlock(b, bcs, true))) {
      // Anything else (a floated card, a quote box): the float and what sits beside it become a row.
      const floatNode = walk(el, depth + 1);
      // The paragraph the image was floated in keeps just its words.
      const besides = blocks.map(([b, bcs], i) => (para && i === 0 ? makeText(b, bcs) : walk(b, depth + 1))).filter(Boolean);
      if (!floatNode || !besides.length) return null;
      const top = Math.min(...rects.map((r) => r.top));
      const colLeft = cs.float === 'left' ? outer.right : Math.min(...rects.map((r) => r.left));
      const colRight = cs.float === 'left' ? Math.max(...rects.map((r) => r.right)) : outer.left;
      besides.forEach((n) => clipToColumn(n, colLeft + scrollX, colRight + scrollX));
      const col = panelBox({ x: Math.round(colLeft + scrollX), y: Math.round(top + scrollY), w: Math.round(colRight - colLeft), h: Math.round(Math.max(...rects.map((r) => r.bottom)) - top) }, besides);
      const x0 = Math.min(fr.left, colLeft), x1 = Math.max(fr.right, colRight), y0 = Math.min(fr.top, top), y1 = Math.max(fr.bottom, ...rects.map((r) => r.bottom));
      const row = panelBox({ x: Math.round(x0 + scrollX), y: Math.round(y0 + scrollY), w: Math.round(x1 - x0), h: Math.round(y1 - y0) }, cs.float === 'left' ? [floatNode, col] : [col, floatNode]);
      return { node: { ...row, direction: 'row', alignItems: 'flex-start' }, consumed: blocks.map(([b]) => b) };
    }

    // Spacing between the blocks; the most common gap after a paragraph is the widget's paragraph spacing.
    const isPara = (b) => /^(P|DIV)$/.test(b.tagName.toUpperCase());
    const gaps = rects.map((r, i) => (i + 1 < rects.length ? Math.round(rects[i + 1].top - r.bottom) : null));
    const counts = {};
    blocks.forEach(([b], i) => { if (gaps[i] != null && isPara(b)) counts[gaps[i]] = (counts[gaps[i]] || 0) + 1; });
    const pGap = Number(Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || 0);
    const [baseEl, baseCs] = blocks.find(([b]) => isPara(b)) || blocks[0];
    const top = Math.min(outer.top, rects[0].top);
    const lastPara = isPara(blocks[blocks.length - 1][0]);

    const ir = img.getBoundingClientRect();
    // The image moves to the start of the text, and its margins keep it where it was
    // (floated inside the first paragraph, it is already in place there).
    const m = [ir.top - top, outer.right - ir.right, outer.bottom - ir.bottom, ir.left - outer.left].map((v) => Math.round(Math.max(0, v) * 10) / 10);
    const imgHtml = para ? '' : alignedImgHtml(el, cs, img, m);

    // Each block keeps its own type only where it differs from the paragraphs (headings always
    // carry theirs, or the theme's heading styles would show through).
    const html = blocks.map(([b, bcs], i) => {
      const tag = b.tagName.toUpperCase();
      const heading = /^H[1-6]$/.test(tag);
      const st = [];
      const diff = (prop, val, baseVal) => { if (heading || val !== baseVal) st.push(`${prop}:${val}`); };
      diff('font-family', renderedStack(bcs.fontFamily).replace(/"/g, "'"), renderedStack(baseCs.fontFamily).replace(/"/g, "'"));
      diff('font-size', bcs.fontSize, baseCs.fontSize);
      diff('font-weight', String(renderedWeight(bcs)), String(renderedWeight(baseCs)));
      diff('line-height', bcs.lineHeight, baseCs.lineHeight);
      diff('color', rgbToHex(bcs.color), rgbToHex(baseCs.color));
      if (bcs.fontStyle !== baseCs.fontStyle) st.push(`font-style:${bcs.fontStyle}`);
      if (bcs.letterSpacing !== baseCs.letterSpacing) st.push(`letter-spacing:${bcs.letterSpacing}`);
      if (bcs.textTransform !== baseCs.textTransform) st.push(`text-transform:${bcs.textTransform}`);
      if (bcs.textAlign !== baseCs.textAlign) st.push(`text-align:${bcs.textAlign}`);
      const gap = i === 0 && rects[0].top > top + 0.5 ? Math.round(rects[0].top - top) : 0;
      const after = i === blocks.length - 1 ? (lastPara ? pGap : 0) : gaps[i];
      if (!isPara(b) || after !== pGap || gap) st.push(`margin:${gap}px 0 ${after}px`);
      if (tag === 'UL' || tag === 'OL') {
        st.push(`padding-left:${px(bcs.paddingLeft)}px`);
        if (!['disc', 'decimal'].includes(bcs.listStyleType)) st.push(`list-style-type:${bcs.listStyleType}`);
        return `<${tag.toLowerCase()}${listAttrs(b)} style="${esc(st.join(';'))}">${listItemsHtml(b)}</${tag.toLowerCase()}>`;
      }
      const t = heading ? tag.toLowerCase() : 'p';
      return `<${t}${st.length ? ` style="${esc(st.join(';'))}"` : ''}>${cleanHtml(b, { floats: true })}</${t}>`;
    }).join('');

    // The last paragraph's spacing (the widget sets it on every paragraph) is part of the box.
    const bottom = Math.max(outer.bottom, rects[rects.length - 1].bottom + (lastPara ? pGap : 0));
    const left = Math.min(outer.left, ...rects.map((r) => r.left));
    const right = Math.max(outer.right, ...rects.map((r) => r.right));
    const node = {
      ...widgetBase(baseEl, baseCs, 'text'),
      rect: { x: Math.round(left + scrollX), y: Math.round(top + scrollY), w: Math.round(right - left), h: Math.round(bottom - top) },
      margin: [0, 0, 0, 0], padding: [0, 0, 0, 0],
      html: imgHtml + html, rich: true, paragraphSpacing: pGap,
      text: blocks.map(([b]) => textOf(b)).join(' '),
      align: baseCs.textAlign, style: typography(baseCs),
      floatImage: { src: img.currentSrc || img.src, w: Math.round(ir.width), h: Math.round(ir.height) },
    };
    return { node, consumed: blocks.map(([b]) => b) };
  }

  function walk(el, depth) {
    if (el.nodeType !== Node.ELEMENT_NODE) return null;
    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return null;
    const cs = getComputedStyle(el);
    if (!isVisible(el, cs)) return null;
    if (cs.position === 'fixed' && depth > 0) {
      // Cookie banners, chat bubbles and floating buttons are not part of the page layout.
      const r = el.getBoundingClientRect();
      if (r.height < innerHeight * 0.5 && r.top > 80) return null;
    }

    if (tag === 'SVG') {
      const r = el.getBoundingClientRect();
      return r.width <= 64 && r.height <= 64 && !isSvgArtwork(el) ? makeIcon(el, cs) : { ...widgetBase(el, cs, 'svg'), svg: svgMarkup(el), hints: iconHints(el), color: svgColor(el) };
    }
    if (tag === 'IMG' || tag === 'PICTURE') return makeImage(el, cs);
    if (tag === 'IFRAME' || tag === 'OBJECT' || tag === 'EMBED') return makeEmbed(el, cs);
    if (tag === 'VIDEO') return makeVideo(el, cs);
    if (tag === 'AUDIO') return { ...widgetBase(el, cs, 'audio'), src: el.currentSrc || el.src || el.querySelector('source')?.src || '', markup: snapshot(el) };
    if (tag === 'CANVAS') {
      // Charts and drawings: keep what is drawn right now as a PNG (fails for canvases showing other sites' images).
      let src = null;
      try {
        const data = el.toDataURL('image/png');
        if (data.length > 30 && data.length < 3e6) src = data;
      } catch {}
      return { ...widgetBase(el, cs, 'image'), src, canvas: true, alt: el.getAttribute('aria-label') || '', objectFit: 'fill', border: border(cs) };
    }
    if (tag === 'HR') return makeDivider(el, cs);
    if (tag === 'FORM') return formOf(el, cs, depth);
    if (tag === 'TABLE') return makeHtml(el, cs, 'table');
    if (FORM_TAGS.has(tag)) return makeHtml(el, cs, 'field');
    if (isFontIcon(el, cs)) return makeIcon(el, cs);

    const progress = progressOf(el, cs);
    if (progress) return progress;
    const rating = ratingOf(el, cs);
    if (rating) return rating;
    const iconButton = iconButtonOf(el, cs);
    if (iconButton) return iconButton;
    if (looksLikeButton(el, cs)) return makeButton(el, cs);
    if (/^H[1-6]$/.test(tag)) return textOf(el) ? makeText(el, cs) : null;
    if (tag === 'PRE') return makeText(el, cs);
    if (tag === 'UL' || tag === 'OL') {
      const iconList = iconListOf(el, cs) || linkListOf(el, cs);
      if (iconList) return iconList;
      if (plainList(el, cs)) {
        // Items that all share their own type (".features li { font-size: 20px }") give the widget its typography.
        const items = [...el.children].map((li) => getComputedStyle(li));
        const typeKey = (c) => [c.fontFamily, c.fontSize, c.fontWeight, c.fontStyle, c.lineHeight, c.color, c.letterSpacing, c.textTransform].join('|');
        const base = items.every((c) => typeKey(c) === typeKey(items[0])) ? items[0] : cs;
        return { ...makeText(el, cs), style: typography(base), html: `<${tag.toLowerCase()}${listAttrs(el)}>${listItemsHtml(el, base)}</${tag.toLowerCase()}>`, listStyle: cs.listStyleType, listPadding: px(cs.paddingLeft) };
      }
    }
    const social = socialOf(el, cs);
    if (social) return social;
    const ariaAccordion = !isInlineContent(el) && ariaAccordionOf(el);
    if (ariaAccordion) return hasVisualBox(cs) ? container(el, cs, [ariaAccordion]) : ariaAccordion;
    const inlineFloat = inlineFloatOf(el, cs);
    if (inlineFloat) return floatText(el, cs, inlineFloat);

    if (isInlineContent(el)) {
      if (!textOf(el)) {
        // Empty box: keep it only if it draws something (a coloured bar, a decorative dot, a placed glyph).
        if (!hasVisualBox(cs) && !pseudoNodes(el, cs).length) return null;
        const boxNode = withOverlay(container(el, cs, pseudoNodes(el, cs)));
        const pcs = el.parentElement && getComputedStyle(el.parentElement);
        if (!boxNode.children.length && pcs && /flex/.test(pcs.display) && !pcs.flexDirection.startsWith('column') && parseFloat(cs.flexGrow) > 0) {
          // A filler that stretches between items (the dotted leader between a dish and its price).
          boxNode.grow = { min: px(cs.minWidth) || 0 };
        } else if (!boxNode.children.length && (cs.display.startsWith('inline') || boxNode.rect.w <= 64)) {
          // Small drawn shapes (status dots, swatches) keep their exact size.
          Object.assign(boxNode, { fixedWidth: boxNode.rect.w, minHeight: boxNode.minHeight || boxNode.rect.h });
        }
        return boxNode;
      }
      const textNode = makeText(el, cs);
      const boxed = (hasVisualBox(cs) || pseudoNodes(el, cs).length) && depth > 0;
      // A styled inline label draws its box around the glyphs, not the line box, so it keeps its own height.
      if (cs.display === 'inline' && depth > 0 && !boxed) fitToLineBox(el, textNode);
      const mark = depth > 0 && !hasVisualBox(cs) && el.tagName !== 'LI' ? inlineMark(el, '::before') : null;
      if (mark?.above) {
        // A bar drawn as a block above the words (a section title's accent line): the bar, then the text.
        // (Marks are only taken from boxes without a border, so the padding is all that insets them.)
        const [pt, pr, pb, pl] = box(cs, 'padding');
        const er = el.getBoundingClientRect();
        const left = er.left + scrollX + pl, barY = er.top + scrollY + pt + mark.marginTop, textY = barY + mark.h + mark.marginBottom;
        const textRect = { x: Math.round(left), y: Math.round(textY), w: Math.round(er.width - pl - pr), h: Math.round(er.bottom + scrollY - pb - textY) };
        return container(el, cs, [markBox(mark, left + mark.marginLeft, barY), { ...textNode, rect: textRect, margin: [0, 0, 0, 0], padding: [0, 0, 0, 0], positioned: null, transform: null, opacity: null }]);
      }
      if (mark) {
        // An eyebrow with a short bar before it: the bar becomes a small box beside the text.
        const r = textNode.rect;
        const range = document.createRange();
        range.selectNodeContents(el);
        const tr = range.getBoundingClientRect();
        const markX = tr.left + scrollX - mark.gap - mark.w;
        const textRect = { ...r, x: Math.round(tr.left + scrollX), w: Math.round(tr.width) };
        const midY = r.y + r.h / 2;
        return {
          ...container(el, cs, [markBox(mark, markX, midY - mark.h / 2), { ...textNode, rect: textRect, textW: Math.round(tr.width * 10) / 10, margin: [0, 0, 0, 0], padding: [0, 0, 0, 0], positioned: null, transform: null, opacity: null }]),
          direction: 'row', wrap: false, alignItems: 'center', justify: cs.textAlign === 'center' ? 'center' : 'flex-start', gap: { column: mark.gap, row: 0 },
        };
      }
      // Text inside a styled box (badge, pill, callout): keep the box as a container around the text.
      if (boxed) {
        const [pt, pr, pb, pl] = box(cs, 'padding');
        const bt = px(cs.borderTopWidth), br = px(cs.borderRightWidth), bb = px(cs.borderBottomWidth), bl = px(cs.borderLeftWidth);
        const r = textNode.rect;
        textNode.rect = { x: r.x + bl + pl, y: r.y + bt + pt, w: r.w - bl - pl - br - pr, h: r.h - bt - pt - bb - pb };
        // An inline label's box is only as tall as its glyphs: a taller line height would grow it.
        if (cs.display === 'inline' && new Set([...el.getClientRects()].map((cr) => Math.round(cr.top))).size === 1 && textNode.rect.h < textNode.style.lineHeight) {
          textNode.style = { ...textNode.style, lineHeight: textNode.rect.h };
        }
        Object.assign(textNode, { padding: [0, 0, 0, 0], margin: [0, 0, 0, 0], background: null, border: null, shadow: null, positioned: null, transform: null, opacity: null });
        return withOverlay(container(el, cs, [textNode, ...pseudoNodes(el, cs)]));
      }
      return textNode;
    }

    const children = [];
    const kids = [...el.childNodes];
    const elKids = [...el.children];
    const consumed = new Set();
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (child.nodeType === Node.TEXT_NODE) {
        const t = child.textContent.replace(/\s+/g, ' ').trim();
        if (!t) continue;
        const range = document.createRange();
        range.selectNode(child);
        const r = range.getBoundingClientRect();
        children.push({
          kind: 'text', tag: 'p', html: esc(t), text: t, align: cs.textAlign, style: typography(cs), margin: [0, 0, 0, 0], padding: [0, 0, 0, 0],
          rect: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) },
          textW: Math.round(r.width * 10) / 10,
        });
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (consumed.has(child)) continue;
        // A tab strip and the panels it switches → one tabs widget.
        if (!SKIP_TAGS.has(child.tagName.toUpperCase()) && isVisible(child, getComputedStyle(child))) {
          const tabs = tabsAt(child, elKids);
          if (tabs) {
            tabs.consumed.forEach((c) => consumed.add(c));
            children.push(tabs.node);
            continue;
          }
        }
        // Consecutive <details> → one accordion.
        if (child.tagName === 'DETAILS') {
          const run = [child];
          while (i + 1 < kids.length && (kids[i + 1].nodeType === Node.TEXT_NODE ? !kids[i + 1].textContent.trim() : kids[i + 1].tagName === 'DETAILS')) {
            i++;
            if (kids[i].nodeType === Node.ELEMENT_NODE) run.push(kids[i]);
          }
          const visibleRun = run.filter((d) => isVisible(d, getComputedStyle(d)));
          if (visibleRun.length) children.push(makeAccordion(visibleRun, cs));
          continue;
        }
        const childCs = getComputedStyle(child);
        // A floated image with text wrapping around it (or floated inside the first paragraph).
        const floated = childCs.float !== 'none' ? child : inlineFloatOf(child, childCs);
        if (floated && isVisible(child, childCs)) {
          const group = floatGroup(floated, getComputedStyle(floated), depth, floated === child ? null : child);
          if (group) {
            group.consumed.forEach((c) => consumed.add(c));
            children.push(group.node);
            continue;
          }
        }
        if (childCs.display === 'contents') {
          for (const g of child.children) {
            const n = walk(g, depth + 1);
            if (n) children.push(n);
          }
          continue;
        }
        const n = walk(child, depth + 1);
        if (n) children.push(n);
      }
    }
    children.push(...pseudoNodes(el, cs));
    if (!children.length && !hasVisualBox(cs)) return null;
    return withOverlay(container(el, cs, children));
  }

  // A plain tint stretched over the whole box (".band::after { inset: 0; background:
  // rgba(...) }") is what Elementor calls a Background Overlay: it sits above the
  // background and below the content.
  function withOverlay(node) {
    const r = node.rect;
    const bw = node.border?.width || [0, 0, 0, 0];
    const cover = node.children.find((c) => c.pseudo && !c.children?.length && !c.border?.style &&!(c.positioned?.zIndex > 0) &&
      (c.background?.color || c.background?.gradient) && !c.background?.image &&
      Math.abs(c.rect.x - r.x - bw[3]) <= 2 && Math.abs(c.rect.y - r.y - bw[0]) <= 2 && Math.abs(c.rect.w - (r.w - bw[1] - bw[3])) <= 2 && Math.abs(c.rect.h - (r.h - bw[0] - bw[2])) <= 2);
    if (!cover || node.background?.overlay) return node;
    node.background = { ...(node.background || {}), overlay: cover.background.gradient || cover.background.color, overlayOpacity: cover.opacity };
    node.children = node.children.filter((c) => c !== cover);
    return node;
  }

  function gridInfo(cs, el) {
    if (!cs.display.includes('grid')) return null;
    const cols = cs.gridTemplateColumns.split(' ').filter(Boolean).map(px);
    const rows = cs.gridTemplateRows.split(' ').filter(Boolean).map(px);
    return { columns: cols, rows, columnGap: px(cs.columnGap), rowGap: px(cs.rowGap), autoFlow: cs.gridAutoFlow };
  }

  function container(el, cs, children) {
    const r = rect(el);
    let direction = 'column';
    let wrap = false;
    const grid = gridInfo(cs, el);
    if (cs.display.includes('flex')) {
      direction = cs.flexDirection.startsWith('row') ? 'row' : 'column';
      wrap = cs.flexWrap === 'wrap';
    } else if (grid) {
      direction = grid.columns.length > 1 ? 'row' : 'column';
      wrap = grid.columns.length > 1;
    } else {
      // Floats / inline-blocks laid out side by side.
      const flow = children.filter((c) => !c.positioned);
      if (flow.length > 1) {
        const sameRow = flow.every((c) => Math.abs(c.rect.y - flow[0].rect.y) < 4);
        if (sameRow && flow[1].rect.x > flow[0].rect.x) direction = 'row';
        else if (flow.some((c, i) => i > 0 && Math.abs(c.rect.y - flow[i - 1].rect.y) < 4 && c.rect.x > flow[i - 1].rect.x)) { direction = 'row'; wrap = true; }
      }
    }
    const gapCol = cs.columnGap && cs.columnGap !== 'normal' ? px(cs.columnGap) : 0;
    const gapRow = cs.rowGap && cs.rowGap !== 'normal' ? px(cs.rowGap) : 0;
    return {
      kind: 'container',
      tag: el.tagName.toLowerCase(),
      rect: r,
      direction,
      wrap,
      grid,
      justify: cs.justifyContent,
      alignItems: cs.alignItems,
      gap: { column: gapCol, row: gapRow },
      padding: box(cs, 'padding'),
      margin: box(cs, 'margin'),
      maxWidth: cs.maxWidth !== 'none' ? cs.maxWidth : null,
      minHeight: px(cs.minHeight) || null,
      background: background(cs, el),
      border: border(cs),
      shadow: shadow(cs),
      textAlign: cs.textAlign,
      overflow: cs.overflow === 'hidden' || cs.overflowX === 'hidden' ? 'hidden' : null,
      sticky: cs.position === 'sticky' || undefined,
      positioned: positioning(el, cs),
      transform: transformOf(cs),
      opacity: parseFloat(cs.opacity) < 1 ? parseFloat(cs.opacity) : null,
      blur: px(cs.filter.match(/blur\(([^)]+)\)/)?.[1] || '0') || null,
      href: el.tagName === 'A' ? el.href : null,
      children,
    };
  }

  const root = walk(document.body, 0);
  if (probeDoc) probeDoc.defaultView.frameElement?.remove();
  // Google Fonts loaded with their optical-size axis (Elementor loads one fixed size of these).
  const fontCss = [...document.querySelectorAll('link[rel~="stylesheet"]')].map((l) => l.href);
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) if (rule.href) fontCss.push(rule.href);
    } catch {}
  }
  const opticalFonts = [...new Set(fontCss.filter((h) => /fonts\.googleapis\.com\/css2/.test(h))
    .flatMap((h) => [...h.matchAll(/family=([^:&]+):[^&]*opsz/g)].map((m) => decodeURIComponent(m[1]).replace(/\+/g, ' '))))];
  const bodyCs = getComputedStyle(document.body);
  const htmlCs = getComputedStyle(document.documentElement);
  return {
    title: document.title || '',
    viewport: { width: innerWidth, height: innerHeight },
    pageWidth: document.documentElement.scrollWidth,
    pageHeight: document.documentElement.scrollHeight,
    pageBackground: !isTransparent(bodyCs.backgroundColor) ? rgbToHex(bodyCs.backgroundColor) : !isTransparent(htmlCs.backgroundColor) ? rgbToHex(htmlCs.backgroundColor) : '#FFFFFF',
    baseTypography: typography(bodyCs),
    droppedPatterns,
    opticalFonts,
    root,
  };
}
