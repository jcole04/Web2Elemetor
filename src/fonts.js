import { readFileSync } from 'node:fs';

const GOOGLE = new Map(
  JSON.parse(readFileSync(new URL('../data/google-fonts.json', import.meta.url), 'utf8')).map((f) => [f.f.toLowerCase(), f]),
);

// Fonts Elementor offers out of the box as "system" fonts. They ship with the
// visitor's operating system, so no licence is needed to reference them.
const SYSTEM = ['Arial', 'Tahoma', 'Verdana', 'Helvetica', 'Times New Roman', 'Trebuchet MS', 'Georgia', 'Courier New'];

// Well-known commercial or platform-only fonts and a free, metrically close stand-in.
const ALTERNATIVES = {
  'helvetica neue': 'Inter',
  'sf pro': 'Inter', 'sf pro display': 'Inter', 'sf pro text': 'Inter', 'sf ui text': 'Inter', 'sf ui display': 'Inter', '-apple-system': 'Inter', 'blinkmacsystemfont': 'Inter', 'system-ui': 'Inter',
  'segoe ui': 'Open Sans', 'segoe ui variable': 'Open Sans',
  'proxima nova': 'Montserrat', 'gotham': 'Montserrat', 'gotham rounded': 'Nunito', 'avenir': 'Nunito Sans', 'avenir next': 'Nunito Sans',
  'futura': 'Jost', 'futura pt': 'Jost', 'gill sans': 'Lato', 'gill sans mt': 'Lato', 'myriad pro': 'PT Sans', 'frutiger': 'Hind',
  'univers': 'Roboto', 'din': 'Barlow', 'din pro': 'Barlow', 'din next': 'Barlow', 'circular': 'DM Sans', 'circular std': 'DM Sans',
  'graphik': 'Inter', 'gt walsheim': 'Outfit', 'gt america': 'Inter', 'apercu': 'Work Sans', 'brandon grotesque': 'Josefin Sans',
  'museo sans': 'Mulish', 'source sans pro': 'Source Sans 3', 'calibri': 'Carlito', 'cambria': 'Caladea', 'garamond': 'EB Garamond',
  'adobe garamond pro': 'EB Garamond', 'baskerville': 'Libre Baskerville', 'didot': 'Playfair Display', 'bodoni': 'Bodoni Moda',
  'caslon': 'Libre Caslon Text', 'minion pro': 'Crimson Pro', 'palatino': 'Domine', 'palatino linotype': 'Domine', 'tiempos': 'Source Serif 4',
  'menlo': 'JetBrains Mono', 'monaco': 'JetBrains Mono', 'consolas': 'Inconsolata', 'sf mono': 'JetBrains Mono', 'ui-monospace': 'JetBrains Mono',
};

const GENERIC = { 'sans-serif': 'Arial', serif: 'Georgia', monospace: 'Courier New', cursive: 'Dancing Script', 'ui-sans-serif': 'Inter', 'ui-serif': 'Georgia' };

function clean(name) {
  return name.trim().replace(/^["']|["']$/g, '').trim();
}

// Resolves a CSS font-family stack to a family Elementor can load, plus a
// licence note when the original font isn't free to use.
export function resolveFont(stack) {
  const families = String(stack || '').split(',').map(clean).filter(Boolean);
  const original = families[0] || '';
  for (const fam of families) {
    const key = fam.toLowerCase();
    const g = GOOGLE.get(key);
    if (g) {
      return { family: g.f, original, status: fam === original ? 'free' : 'fallback', note: fam === original ? null : `"${original}" isn't a free font, so the page's own fallback "${g.f}" (Google Fonts) is used.` };
    }
    const sys = SYSTEM.find((s) => s.toLowerCase() === key);
    if (sys) return { family: sys, original, status: fam === original ? 'system' : 'fallback', note: fam === original ? null : `"${original}" isn't a free font, so the page's own fallback "${sys}" is used.` };
    if (ALTERNATIVES[key]) {
      return { family: ALTERNATIVES[key], original, status: 'substituted', note: `"${fam}" is a commercial or platform font. Using the free look-alike "${ALTERNATIVES[key]}" (Google Fonts). If you hold a licence, you can upload the original in Elementor > Custom Fonts.` };
    }
  }
  const generic = families.find((f) => GENERIC[f.toLowerCase()]);
  const fallback = generic ? GENERIC[generic.toLowerCase()] : 'Arial';
  return {
    family: fallback,
    original,
    status: 'unknown',
    // A bare generic family ("monospace") names no font, so there is no licence to mention.
    note: original && original !== generic ? `"${original}" isn't on Google Fonts and its licence is unknown. Using "${fallback}" instead; upload the original via Elementor > Custom Fonts only if you hold a licence for it.` : null,
  };
}

// CSS-wide keywords and generic families name no font, so there is nothing to swap.
const KEYWORD = /^(inherit|initial|unset|revert|revert-layer|serif|sans-serif|monospace|cursive|fantasy|math|emoji)$/i;

// The same choice for a font-family written inside rich text or HTML markup, with
// `stack` set to the CSS to write instead (the chosen family, then the page's generic
// family) when the first family isn't free. Null when the stack names no font.
export function resolveInlineFont(stack) {
  const families = String(stack || '').split(',').map(clean).filter(Boolean);
  if (!families.length || KEYWORD.test(families[0]) || /var\(/i.test(stack)) return null;
  const font = resolveFont(stack);
  if (font.status === 'free' || font.status === 'system') return { ...font, stack: null };
  const generic = families.find((f) => KEYWORD.test(f) && !/^(inherit|initial|unset|revert)/i.test(f));
  const name = /^[\w-]+$/.test(font.family) ? font.family : `'${font.family}'`;
  return { ...font, stack: generic ? `${name}, ${generic}` : name };
}

export function isGoogleFont(name) {
  return GOOGLE.has(String(name).toLowerCase());
}

export function googleFontWeights(name) {
  return GOOGLE.get(String(name).toLowerCase())?.w || [400];
}
