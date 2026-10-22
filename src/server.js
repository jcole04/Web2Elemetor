import express from 'express';
import multer from 'multer';
import { fileURLToPath } from 'node:url';
import { convert } from './convert.js';
import { renderPreview } from './elementor/preview.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const PORT = Number(process.env.PORT) || 3000;

// Rendering pages is heavy; run a couple at a time and queue the rest.
let running = 0;
const queue = [];
const MAX_JOBS = Number(process.env.MAX_JOBS) || 2;
async function limited(fn) {
  if (running >= MAX_JOBS) await new Promise((r) => queue.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    queue.shift()?.();
  }
}

app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

app.post('/api/convert', upload.single('file'), async (req, res) => {
  const b = req.body || {};
  const rights = b.rightsConfirmed === 'true';
  try {
    let input;
    if (b.type === 'url') {
      if (!b.url) throw new Error('Enter a link to convert.');
      input = { type: 'url', url: b.url.trim() };
    } else if (b.type === 'html') {
      const html = req.file ? req.file.buffer.toString('utf8') : b.html;
      if (!html || !html.trim()) throw new Error('Paste some HTML or upload an .html file.');
      input = { type: 'html', html, baseUrl: b.baseUrl || undefined };
    } else if (b.type === 'image' || b.type === 'pdf') {
      if (!req.file) throw new Error('Choose a file to upload.');
      input = { type: b.type, buffer: req.file.buffer, mimeType: req.file.mimetype };
    } else {
      throw new Error('Pick what you are converting: a link, HTML, a screenshot or a PDF.');
    }
    const options = {
      // The source's own words and pictures are only kept when the user confirms they hold the rights.
      keepText: rights && b.keepText === 'true',
      keepImages: rights && b.keepImages === 'true',
      title: b.title?.trim() || undefined,
      pageTemplate: b.pageTemplate || 'elementor_canvas',
    };
    const result = await limited(() => convert(input, options));
    const name = (result.template.title || 'template').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'template';
    res.json({
      template: result.template,
      preview: renderPreview(result.template),
      notes: result.notes,
      fonts: result.fonts,
      filename: `elementor-${name}.json`,
    });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message || 'Conversion failed.' });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Files can be up to 25 MB.' : err.message });
  next(err);
});

app.listen(PORT, () => console.log(`Web to Elementor running at http://localhost:${PORT}`));
