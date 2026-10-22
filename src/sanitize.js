// Last line of defence for markup that goes into Elementor HTML widgets. The
// extractor already cleans markup inside the page, but a hostile page could
// tamper with that, so everything is cleaned again here before it is written
// into the template. <style> blocks go too: in a widget they would restyle the
// whole page (an SVG logo's .cls-1 rule recolouring another logo).
const DROP_BLOCKS = /<(script|style|foreignObject|iframe|object|embed|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const DROP_TAGS = /<\/?(script|style|foreignObject|iframe|object|embed|link|meta|base|noscript|template|frame|frameset|applet)\b[^>]*>/gi;
const EVENT_ATTRS = /\s(?:on[a-z]+|formaction|srcdoc)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const URL_ATTRS = /\s((?:xlink:)?href|src|action|poster|data)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;

function safeUrl(v) {
  const u = v.replace(/[\u0000- ]/g, '').toLowerCase();
  if (/^(javascript|vbscript|livescript):/.test(u)) return false;
  if (u.startsWith('data:') && !/^data:image\/(png|jpe?g|gif|webp|avif)[;,]/.test(u)) return false;
  return true;
}

export function sanitizeMarkup(html, { allowIframe = false } = {}) {
  if (!html) return '';
  let out = String(html);
  const keepIframes = [];
  if (allowIframe) {
    // Embeds the builder writes itself: keep the iframe tag but still strip its attributes below.
    out = out.replace(/<iframe\b[^>]*>\s*<\/iframe>/gi, (m) => `\u0000${keepIframes.push(m) - 1}\u0000`);
  }
  for (let i = 0; i < 3; i++) out = out.replace(DROP_BLOCKS, '');
  out = out.replace(DROP_TAGS, '');
  out = out.replace(/\u0000(\d+)\u0000/g, (m, i) => keepIframes[Number(i)]);
  // The converter's own form guard is the one handler that is kept.
  out = out.replace(EVENT_ATTRS, (m) => (/^\s+onsubmit="return false"$/.test(m) ? m : ''));
  out = out.replace(URL_ATTRS, (m, name, quoted, dq, sq, bare) => (safeUrl(dq ?? sq ?? bare ?? '') ? m : ''));
  // CSS that can pull in remote code or run script in old engines.
  out = out.replace(/expression\s*\(|@import\b|behavior\s*:|-moz-binding/gi, '');
  return out;
}

const RASTER_EXT = /\.(jpe?g|png|gif|webp|avif)$/i;

// Elementor's importer sideloads each image by URL and names the file after the
// last path segment. URLs without a raster extension (CDN resizers, query
// strings) fall back to a placeholder, so a fragment carrying the extension is
// added; it is never sent to the server, and WordPress corrects the extension
// from the real file type if the guess is wrong.
export function importableImageUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return url;
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (RASTER_EXT.test(u.pathname) && !u.search && !u.hash) return url;
  const fmt = (u.searchParams.get('format') || u.searchParams.get('fm') || u.searchParams.get('f') || '').toLowerCase();
  const ext = u.pathname.match(RASTER_EXT)?.[1]?.toLowerCase() || (/^(jpe?g|png|gif|webp|avif)$/.test(fmt) ? fmt : 'jpg');
  u.hash = '';
  return `${u.href}#.${ext === 'jpeg' ? 'jpg' : ext}`;
}

// The Text Editor widget runs WordPress's wptexturize, which turns straight
// quotes into curly ones, -- into dashes and ... into an ellipsis. Escaping
// those characters in text (not tags, not <pre>/<code>) keeps them as written.
export function untexturize(html) {
  if (!html) return html;
  let raw = 0;
  return String(html).split(/(<[^>]*>)/).map((part) => {
    if (part.startsWith('<')) {
      if (/^<(pre|code|kbd|tt|samp)\b/i.test(part)) raw++;
      else if (/^<\/(pre|code|kbd|tt|samp)\b/i.test(part)) raw = Math.max(0, raw - 1);
      return part;
    }
    if (raw) return part;
    return part
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/--/g, '-&#45;')
      .replace(/\.\.\./g, '&#46;&#46;&#46;')
      .replace(/(\d)x(?=\d)/g, '$1&#120;');
  }).join('');
}
