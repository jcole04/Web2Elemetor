(() => {
  const $ = (id) => document.getElementById(id);
  const form = $('form');
  let type = 'url';
  let imageFile = null;
  let pdfFile = null;
  let htmlFile = null;
  let downloadUrl = null;

  // Tabs
  const tabs = [...document.querySelectorAll('.tabs button')];
  function selectTab(t) {
    type = t;
    tabs.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.type === t)));
    document.querySelectorAll('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== t));
    const visual = t === 'image' || t === 'pdf';
    $('keepImages').closest('label').style.display = visual ? 'none' : '';
    hideError();
  }
  tabs.forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.type)));

  // Rights confirmation unlocks keeping the original content.
  $('rights').addEventListener('change', (e) => {
    const on = e.target.checked;
    $('keepOpts').setAttribute('aria-disabled', String(!on));
    ['keepText', 'keepImages'].forEach((id) => {
      $(id).disabled = !on;
      if (!on) $(id).checked = false;
    });
  });

  // File pickers and drag & drop
  function setImage(file) {
    if (!file || !file.type.startsWith('image/')) return showError('That file is not an image.');
    imageFile = file;
    const img = $('imagePreview');
    img.src = URL.createObjectURL(file);
    img.hidden = false;
    hideError();
  }
  function setPdf(file) {
    if (!file || file.type !== 'application/pdf') return showError('That file is not a PDF.');
    pdfFile = file;
    $('pdfName').textContent = file.name;
    hideError();
  }
  function wireDrop(zone, input, onFile) {
    zone.addEventListener('click', (e) => { if (e.target !== input) input.click(); });
    zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', () => input.files[0] && onFile(input.files[0]));
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('over');
      if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
    });
  }
  wireDrop($('dropImage'), $('imageFile'), setImage);
  wireDrop($('dropPdf'), $('pdfFile'), setPdf);
  $('htmlFile').addEventListener('change', (e) => { htmlFile = e.target.files[0] || null; });

  // Paste a screenshot from the clipboard anywhere on the page; pasted links also work.
  document.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) {
      e.preventDefault();
      selectTab('image');
      setImage(item.getAsFile());
      return;
    }
    const text = e.clipboardData?.getData('text') || '';
    if (document.activeElement === document.body && /^https?:\/\/\S+$/.test(text.trim())) {
      selectTab('url');
      $('url').value = text.trim();
    }
  });

  function showError(msg) { $('error').textContent = msg; $('error').hidden = false; }
  function hideError() { $('error').hidden = true; }

  const BUSY = {
    url: 'Opening the page and measuring fonts, colours and spacing…',
    html: 'Rendering your HTML and measuring it…',
    image: 'Reading the screenshot. This takes about a minute…',
    pdf: 'Reading the PDF. This can take a minute or two…',
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();
    const fd = new FormData();
    fd.append('type', type);
    if (type === 'url') {
      const url = $('url').value.trim();
      if (!url) return showError('Enter a link to convert.');
      fd.append('url', /^https?:\/\//i.test(url) ? url : `https://${url}`);
    } else if (type === 'html') {
      if (htmlFile) fd.append('file', htmlFile);
      else if ($('html').value.trim()) fd.append('html', $('html').value);
      else return showError('Paste some HTML or upload an .html file.');
      if ($('baseUrl').value.trim()) fd.append('baseUrl', $('baseUrl').value.trim());
    } else if (type === 'image') {
      if (!imageFile) return showError('Add a screenshot first.');
      fd.append('file', imageFile);
    } else if (type === 'pdf') {
      if (!pdfFile) return showError('Add a PDF first.');
      fd.append('file', pdfFile);
    }
    fd.append('rightsConfirmed', String($('rights').checked));
    fd.append('keepText', String($('keepText').checked));
    fd.append('keepImages', String($('keepImages').checked));
    fd.append('title', $('title').value);
    fd.append('pageTemplate', $('pageTemplate').value);

    $('busyText').textContent = BUSY[type];
    $('busy').hidden = false;
    $('go').disabled = true;
    try {
      const res = await fetch('/api/convert', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({ error: 'The server sent an unexpected reply.' }));
      if (!res.ok) throw new Error(data.error || 'Conversion failed.');
      showResult(data);
    } catch (err) {
      showError(err.message);
    } finally {
      $('busy').hidden = true;
      $('go').disabled = false;
    }
  });

  function showResult(data) {
    $('result').hidden = false;
    $('resultTitle').textContent = data.template.title;
    const count = (els) => els.reduce((n, el) => n + 1 + count(el.elements || []), 0);
    $('resultMeta').textContent = `${data.template.content.length} sections, ${count(data.template.content)} elements · Fonts: ${data.fonts.join(', ') || 'default'}`;
    const notes = $('notes');
    notes.innerHTML = '';
    for (const n of data.notes) {
      const li = document.createElement('li');
      li.textContent = n;
      notes.appendChild(li);
    }
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(new Blob([JSON.stringify(data.template)], { type: 'application/json' }));
    $('download').href = downloadUrl;
    $('download').download = data.filename;
    $('preview').srcdoc = data.preview;
    fitPreview();
    $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // The preview renders at real device width and is scaled down to fit the panel.
  let previewWidth = 1440;
  function fitPreview() {
    const wrap = document.querySelector('.frame-wrap');
    const frame = $('preview');
    const scale = Math.min(1, wrap.clientWidth / previewWidth);
    frame.style.width = `${previewWidth}px`;
    frame.style.height = `${Math.round(640 / scale)}px`;
    frame.style.transform = `scale(${scale})`;
    wrap.style.height = `${640}px`;
  }
  window.addEventListener('resize', fitPreview);
  document.querySelectorAll('.seg button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      previewWidth = Number(b.dataset.w);
      fitPreview();
    }),
  );
})();
