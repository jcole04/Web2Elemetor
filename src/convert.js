import { extractFromHtml, extractFromUrl } from './extract/dom.js';
import { extractFromVisual } from './extract/vision.js';
import { normalize } from './normalize.js';
import { applyCopyrightMode } from './copyright.js';
import { buildTemplate } from './elementor/build.js';
import { validateTemplate } from './elementor/validate.js';

// input: { type: 'url'|'html'|'image'|'pdf', url?, html?, baseUrl?, buffer?, mimeType? }
// options: { keepText, keepImages, title, pageTemplate }
export async function convert(input, options = {}) {
  let tree;
  if (input.type === 'url') tree = normalize(await extractFromUrl(input.url));
  else if (input.type === 'html') tree = normalize(await extractFromHtml(input.html, input.baseUrl));
  else if (input.type === 'image' || input.type === 'pdf') tree = await extractFromVisual(input.buffer, input.mimeType, options);
  else throw new Error(`Unsupported input type "${input.type}".`);

  const copyrightNotes = applyCopyrightMode(tree, options);
  const { template, fonts, fontNotes, notes: buildNotes, sourceMap } = buildTemplate(tree, { title: options.title, pageTemplate: options.pageTemplate, tagSource: options.tagSource });
  const errors = validateTemplate(template);
  if (errors.length) throw new Error('Generated template failed validation: ' + errors.slice(0, 5).join(' '));
  return { template, fonts, notes: [...copyrightNotes, ...buildNotes, ...fontNotes], tree, sourceMap };
}
