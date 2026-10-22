// Builds data/outline-icons.json from the open-source icon sets most sites use
// (Lucide ISC, Feather MIT, Heroicons MIT, Tabler MIT), so inline SVG icons can be
// recognised by name and mapped to Elementor's Font Awesome icons.
// Usage: node scripts/build-icon-data.mjs <dir with unpacked npm packages>
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { signatureFromNodes, shapesFromMarkup } from '../src/icon-sig.js';

const root = process.argv[2];
const pkg = (name) => path.join(root, readdirSync(root).find((d) => d.startsWith(name)), 'package');
const toMarkup = (nodes) => nodes.map(([t, a]) => `<${t} ${Object.entries(a).filter(([k]) => k !== 'key').map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('');

const icons = [];
const add = (set, name, style, nodes, tags = []) => {
  const sig = signatureFromNodes(nodes);
  if (!sig) return;
  icons.push({ set, name, style, sig, tags, markup: toMarkup(nodes) });
};

const lucide = JSON.parse(readFileSync(path.join(pkg('lucide-static'), 'icon-nodes.json'), 'utf8'));
const lucideTags = JSON.parse(readFileSync(path.join(pkg('lucide-static'), 'tags.json'), 'utf8'));
for (const [name, nodes] of Object.entries(lucide)) add('lucide', name, 'stroke', nodes, lucideTags[name] || []);

const feather = JSON.parse(readFileSync(path.join(pkg('feather-icons'), 'dist', 'icons.json'), 'utf8'));
for (const [name, inner] of Object.entries(feather)) add('feather', name, 'stroke', shapesFromMarkup(inner));

for (const style of ['outline', 'solid']) {
  const dir = path.join(pkg('heroicons'), '24', style);
  for (const f of readdirSync(dir)) add('heroicons', f.replace(/\.svg$/, ''), style === 'outline' ? 'stroke' : 'fill', shapesFromMarkup(readFileSync(path.join(dir, f), 'utf8')));
}

for (const [file, style] of [['tabler-nodes-outline.json', 'stroke'], ['tabler-nodes-filled.json', 'fill']]) {
  const nodes = JSON.parse(readFileSync(path.join(pkg('tabler-icons'), file), 'utf8'));
  for (const [name, n] of Object.entries(nodes)) add('tabler', name, style, n);
}

// Exact lookups for every set; drawable markup only for the sets used in shape matching.
const SHAPE_SETS = new Set(['lucide', 'heroicons']);
const out = {
  license: 'Icon names and shapes from Lucide (ISC), Feather (MIT), Heroicons (MIT) and Tabler Icons (MIT). Used only to recognise icons; the converter outputs Font Awesome names.',
  bySig: {},
  shapes: [],
};
for (const ic of icons) {
  out.bySig[ic.sig] ??= [ic.set, ic.name, ic.style, ic.tags.slice(0, 8).join(' ')];
  if (SHAPE_SETS.has(ic.set)) out.shapes.push([ic.set, ic.name, ic.style, ic.markup]);
}
writeFileSync(new URL('../data/outline-icons.json', import.meta.url), JSON.stringify(out));
console.log(`${icons.length} icons, ${Object.keys(out.bySig).length} signatures, ${out.shapes.length} drawable`);
