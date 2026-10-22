// Screenshots a source page and the preview of its generated template.
// usage: node scripts/compare.js <source.html> <template.json> <outprefix>
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { renderPreview } from '../src/elementor/preview.js';
const [src, tpl, out] = process.argv.slice(2);
const html = renderPreview(JSON.parse(readFileSync(tpl, 'utf8')));
writeFileSync(out + '-preview.html', html);
const b = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.setContent(readFileSync(src, 'utf8')); await p.screenshot({ path: out + '-source.png', fullPage: true });
await p.setContent(html); await p.waitForTimeout(300); await p.screenshot({ path: out + '-template.png', fullPage: true });
await b.close();
