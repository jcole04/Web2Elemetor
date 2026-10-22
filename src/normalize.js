// Turns the raw DOM measurement tree into the layout tree the Elementor
// builder consumes. Layout numbers (widths, vertical spacing, alignment,
// absolute offsets, grid tracks) are derived from the real on-screen boxes so
// the result matches the rendered page.

const round = (n) => Math.round(n * 10) / 10;

function hasVisual(node) {
  return !!(node.background || node.border?.style || node.border?.radius || node.shadow || node.overflow || node.opacity || node.transform || node.href);
}

function contentBox(node) {
  if (node.contentRect) return node.contentRect;
  const bw = node.border?.width || [0, 0, 0, 0];
  const p = node.padding || [0, 0, 0, 0];
  return {
    x: node.rect.x + bw[3] + p[3],
    y: node.rect.y + bw[0] + p[0],
    w: Math.max(1, node.rect.w - bw[1] - bw[3] - p[1] - p[3]),
    h: Math.max(0, node.rect.h - bw[0] - bw[2] - p[0] - p[2]),
  };
}

// Containers nested inside composite nodes (accordion and tab panels) need the same treatment.
// A panel always stays a container, even when it holds a single widget.
function eachNested(node, fn) {
  const keep = (panel) => {
    const out = fn(panel);
    return out.kind === 'container' ? out : { ...panel, children: [out], contentRect: null };
  };
  if (node.kind === 'accordion') node.items.forEach((it) => { if (it.content) it.content = keep(it.content); });
  else if (node.kind === 'tabs') node.panels = node.panels.map((p) => p && keep(p));
}

// Removes wrapper divs that only exist for CSS plumbing.
function collapse(node) {
  eachNested(node, collapse);
  if (node.kind !== 'container') return node;
  node.children = node.children.map(collapse).filter(Boolean);

  // Absolutely placed decorations (badges, ::before shapes) don't count as the "one child".
  const flowKids = (n) => n.children.filter((c) => !c.positioned);
  while (flowKids(node).length === 1 && flowKids(node)[0].kind === 'container' && !flowKids(node)[0].positioned && !node.grid) {
    const child = flowKids(node)[0];
    const floating = node.children.filter((c) => c.positioned);
    const centeredNarrower = child.rect.w < node.rect.w - 2 && Math.abs((child.rect.x - node.rect.x) - (node.rect.x + node.rect.w - child.rect.x - child.rect.w)) <= 2;
    if (hasVisual(child) && hasVisual(node)) break;
    if (centeredNarrower && hasVisual(child)) break;
    // Merge child into parent: parent keeps its background, child brings its layout.
    const merged = {
      ...node,
      direction: child.direction,
      wrap: child.wrap,
      grid: child.grid,
      justify: child.justify,
      alignItems: child.alignItems,
      gap: child.gap,
      textAlign: child.textAlign,
      background: node.background || child.background,
      border: hasVisual(node) ? node.border : child.border,
      shadow: node.shadow || child.shadow,
      overflow: node.overflow || child.overflow,
      href: node.href || child.href,
      minHeight: node.minHeight || child.minHeight,
      children: [...child.children, ...floating],
    };
    const outer = node.rect;
    const bw = node.border?.width || [0, 0, 0, 0];
    const cb = contentBox(child);
    merged.contentRect = cb;
    merged.padding = [
      round(cb.y - outer.y - bw[0]),
      round(outer.x + outer.w - bw[1] - (cb.x + cb.w)),
      round(outer.y + outer.h - bw[2] - (cb.y + cb.h)),
      round(cb.x - outer.x - bw[3]),
    ].map((v) => Math.max(0, v));
    if (centeredNarrower) {
      // Full-width band with centred content: Elementor's "boxed" container.
      merged.boxedWidth = cb.w;
      merged.padding[1] = node.padding[1];
      merged.padding[3] = node.padding[3];
    } else {
      merged.boxedWidth = node.boxedWidth || child.boxedWidth;
    }
    node = merged;
  }

  // A plain wrapper around a single widget is just the widget.
  if (node.children.length === 1 && node.children[0].kind !== 'container' && !hasVisual(node) && !node.isRoot && !node.positioned && !node.children[0].positioned && !node.grid) {
    return node.children[0];
  }
  return node;
}

function horizontalAlign(child, box) {
  const left = child.rect.x - box.x;
  const right = box.x + box.w - (child.rect.x + child.rect.w);
  if (Math.abs(left - right) <= 3 && left > 3) return 'center';
  if (right < left - 3) return 'end';
  return 'start';
}

// Absolute children: offsets from the container's padding box, the way CSS
// and Elementor's "Position: Absolute" measure them.
function placeAbsolute(c, node) {
  const bw = node.border?.width || [0, 0, 0, 0];
  const originX = node.rect.x + bw[3];
  const originY = node.rect.y + bw[0];
  const innerW = node.rect.w - bw[1] - bw[3];
  const innerH = node.rect.h - bw[0] - bw[2];
  const left = c.rect.x - originX;
  const top = c.rect.y - originY;
  const right = innerW - left - c.rect.w;
  const bottom = innerH - top - c.rect.h;
  c.absolute = {
    h: right < left && right >= 0 ? 'end' : 'start',
    x: round(right < left && right >= 0 ? right : left),
    v: bottom < top && bottom >= 0 ? 'end' : 'start',
    y: round(bottom < top && bottom >= 0 ? bottom : top),
    // Also relative to the content box, for boxed containers whose inner wrapper is the reference.
    contentX: round(c.rect.x - contentBox(node).x),
    contentY: round(c.rect.y - contentBox(node).y),
    zIndex: c.positioned?.zIndex ?? null,
    // Spans the whole container (an overlaid header bar), so it can stay "boxed".
    fullWidth: Math.abs(left) <= 2 && Math.abs(c.rect.w - innerW) <= 2,
  };
  c.marginTop = 0;
  c.widthPx = c.rect.w;
}

// Grid containers: equal tracks become an Elementor grid; spans come from the boxes.
function gridLayout(node, box, flow) {
  const g = node.grid;
  const cols = g.columns.length;
  const colGap = g.columnGap || 0;
  const rowGap = g.rowGap || 0;
  const equal = g.columns.every((w) => Math.abs(w - g.columns[0]) <= 1);
  const ai = node.alignItems || 'normal';
  const alignItems = /center/.test(ai) ? 'center' : /end/.test(ai) ? 'end' : /start|baseline/.test(ai) ? 'start' : 'stretch';
  node.gridSpec = { columns: cols, equal, tracks: g.columns.map(round), rowTracks: (g.rows || []).map(round), columnGap: round(colGap), rowGap: round(rowGap), alignItems };
  // Map each item to its start track / span by its position.
  const starts = [];
  let x = box.x;
  for (const w of g.columns) { starts.push(x); x += w + colGap; }
  const rowStarts = [];
  let y = box.y;
  for (const h of g.rows || []) { rowStarts.push(y); y += h + rowGap; }
  for (const c of flow) {
    const col = starts.reduce((best, s, i) => (Math.abs(s - c.rect.x) < Math.abs(starts[best] - c.rect.x) ? i : best), 0);
    let end = col;
    while (end + 1 < cols && starts[end + 1] < c.rect.x + c.rect.w - 2) end++;
    let row = 0;
    let rowEnd = 0;
    if (rowStarts.length) {
      row = rowStarts.reduce((best, s, i) => (Math.abs(s - c.rect.y) < Math.abs(rowStarts[best] - c.rect.y) ? i : best), 0);
      rowEnd = row;
      while (rowEnd + 1 < rowStarts.length && rowStarts[rowEnd + 1] < c.rect.y + c.rect.h - 2) rowEnd++;
    }
    c.gridItem = { col: col + 1, colSpan: end - col + 1, row: row + 1, rowSpan: rowEnd - row + 1 };
    c.marginTop = 0;
  }
  node.gridSpec.hasSpans = flow.some((c) => c.gridItem.colSpan > 1 || c.gridItem.rowSpan > 1);
  node.gap = { column: round(colGap), row: round(rowGap) };
}

function isOneLine(c) {
  const lh = c.style?.lineHeight || (c.style?.fontSize || 16) * 1.3;
  return c.rect.h <= lh * 1.5 + (c.padding?.[0] || 0) + (c.padding?.[2] || 0) + 4;
}
function hugsText(c) {
  return c.textW != null && Math.abs(c.rect.w - (c.padding?.[1] || 0) - (c.padding?.[3] || 0) - c.textW) <= 3;
}
const oneLineHug = (c) => isOneLine(c) && hugsText(c);
// All items share one line: every box overlaps every other vertically.
const oneRow = (items) => items.length > 0 && Math.max(...items.map((c) => c.rect.y)) < Math.min(...items.map((c) => c.rect.y + c.rect.h));
const lead = (items, box) => Math.min(...items.map((c) => c.rect.x)) - box.x;
const trail = (items, box) => box.x + box.w - Math.max(...items.map((c) => c.rect.x + c.rect.w));

function layout(node) {
  eachNested(node, (c) => { layout(c); return c; });
  if (node.kind !== 'container') return node;
  const box = contentBox(node);
  const kids = node.children;
  const flow = kids.filter((c) => !c.positioned);
  kids.filter((c) => c.positioned).forEach((c) => placeAbsolute(c, node));

  if (node.grid && node.grid.columns.length > 1) {
    gridLayout(node, box, flow);
  } else if (node.direction === 'row') {
    // Lines of items that share a row (they overlap vertically), each left to right.
    // Sorted by top, so an item joins a line when it starts above that line's bottom; boxes
    // that only touch (a wrapping row with no row gap) start a new one.
    const sorted = [...flow].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    const lines = [];
    for (const c of sorted) {
      // Same top, or starting above another item's bottom (1px allowed for rounding; a hairline rule still joins).
      const line = lines.find((l) => l.some((o) => Math.abs(c.rect.y - o.rect.y) < 1 || c.rect.y < o.rect.y + o.rect.h - 1));
      if (line) line.push(c); else lines.push([c]);
    }
    lines.forEach((l) => l.sort((a, b) => a.rect.x - b.rect.x));
    // Horizontal gap: measured from the boxes (works for floats and flex alike).
    const gaps = lines.flatMap((l) => l.slice(1).map((b, i) => b.rect.x - (l[i].rect.x + l[i].rect.w)));
    const colGap = gaps.length ? Math.max(0, Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length)) : node.gap?.column || 0;
    const uniformGap = gaps.every((g) => Math.abs(g - colGap) <= 2);
    node.gap = { column: colGap, row: node.gap?.row || 0 };
    for (const c of flow) {
      // Short one-line items (nav links, labels, buttons) size to their content.
      const oneLine = isOneLine(c);
      // Text whose box hugs its words keeps them on one line however wide it is.
      const hugs = hugsText(c);
      c.autoWidth = (['text', 'heading'].includes(c.kind) && oneLine && (hugs || (c.textW == null && c.rect.w < box.w * 0.5))) ||
        // Buttons keep their exact width through padding, so one-line buttons always size themselves.
        (c.kind === 'button' && oneLine && (c.textW != null || c.rect.w < box.w * 0.5)) ||
        // Fixed-size pieces (icons, icon rows, star ratings, buttons with a set height) size themselves.
        (['button', 'icon', 'social', 'rating', 'svg'].includes(c.kind) && c.rect.w < box.w * 0.5);
      // Round down so rounding never pushes the last item onto a new line.
      c.widthPct = c.grow ? null : Math.floor(Math.min(100, (c.rect.w / box.w) * 100) * 10) / 10;
      c.marginTop = 0;
    }
    // A wrapping row that fits on one line is just a row.
    if (node.wrap && lines.length <= 1) node.wrap = false;
    if (node.wrap) {
      const bottom = Math.max(...lines[0].map((c) => c.rect.y + c.rect.h));
      node.gap.row = Math.max(0, Math.round(Math.min(...lines[1].map((c) => c.rect.y)) - bottom));
    }
    // Vertical alignment of row items.
    node.alignItems = /center/.test(node.alignItems) ? 'center' : /end/.test(node.alignItems) ? 'flex-end' : /start|baseline/.test(node.alignItems) ? 'flex-start' : node.alignItems === 'normal' || node.alignItems === 'stretch' ? 'stretch' : 'flex-start';
    // Horizontal distribution.
    if (/space-between|space-around|space-evenly|center|end|right/.test(node.justify)) {
      node.justify = node.justify.replace('normal', 'flex-start').replace(/^end$|right/, 'flex-end').replace(/^start$|left/, 'flex-start');
      if (/space-/.test(node.justify)) node.gap.column = 0;
    } else if (oneRow(flow) && lead(flow, box) > 2 && Math.abs(lead(flow, box) - trail(flow, box)) <= 2) {
      // Equal space on both ends: centred (or spread evenly when the gaps match the ends).
      node.justify = Math.abs(lead(flow, box) - colGap) <= 2 && flow.length > 1 ? 'space-evenly' : 'center';
      if (node.justify === 'space-evenly') node.gap.column = 0;
    } else if ((!uniformGap && flow.length > 1) || (oneRow(flow) && lead(flow, box) > 2)) {
      // Uneven spacing, or space before the first item (auto margins): keep exact positions with per-item left margins.
      node.gap.column = 0;
      for (const line of lines) {
        let prevRight = box.x;
        for (const c of line) {
          c.marginLeft = round(c.rect.x - prevRight);
          prevRight = c.rect.x + c.rect.w;
        }
      }
      node.justify = 'flex-start';
    } else {
      node.justify = 'flex-start';
    }
    // Percentage widths don't leave room for the gap in Elementor, so each width subtracts its share of it.
    if (node.gap.column > 0) {
      for (const line of lines) {
        if (line.length < 2) continue;
        const G = node.gap.column;
        const free = box.w - (line.length - 1) * G;
        for (const c of line) {
          if (c.grow) continue;
          const f = c.rect.w / free;
          c.widthCalc = `calc(${Math.floor(f * 100000) / 1000}% - ${Math.round(f * (line.length - 1) * G * 100) / 100}px)`;
        }
      }
    }
    // Items that sit lower than their row's top keep that offset (in a stretched row,
    // the offset they all share, e.g. Bootstrap's row gutter).
    if (node.alignItems === 'flex-start' && !node.wrap) {
      for (const c of flow) c.marginTop = round(c.rect.y - box.y);
    } else if (node.alignItems === 'stretch' && !node.wrap && flow.length) {
      const top = Math.min(...flow.map((c) => c.rect.y - box.y));
      if (top >= 1) for (const c of flow) c.marginTop = round(top);
    } else if (node.alignItems === 'center' && !node.wrap && flow.length) {
      // Centred items with a shared top margin sit half that margin lower; recover it from each item.
      const ms = flow.map((c) => 2 * (c.rect.y - box.y) - (box.h - c.rect.h));
      if (ms[0] >= 1 && ms.every((m) => Math.abs(m - ms[0]) <= 2)) for (const c of flow) c.marginTop = round(ms.reduce((a, b) => a + b, 0) / ms.length);
    }
  } else {
    // Column: turn real vertical distances into top margins, so collapsing
    // CSS margins, overlaps (negative margins) and odd spacing come out right.
    node.gap = { column: 0, row: 0 };
    let prevBottom = box.y;
    flow.forEach((c, i) => {
      const top = c.rect.y;
      c.marginTop = round(top - (i === 0 ? box.y : prevBottom));
      prevBottom = Math.max(prevBottom, top + c.rect.h);
      const narrower = c.rect.w < box.w - 4;
      if (c.kind === 'container' && c.rect.x < box.x - 1 && c.rect.w > box.w + 1) {
        // Wider than its parent with negative side margins (Bootstrap's .row inside .container).
        c.marginLeft = round(c.rect.x - box.x);
        c.overhang = round(c.rect.w - box.w);
      } else if (c.kind === 'container' && narrower) {
        c.widthPct = round((c.rect.w / box.w) * 100);
        c.alignSelf = horizontalAlign(c, box);
      } else if (c.kind === 'button' && !narrower) {
        c.fullWidth = true;
      } else if (['button', 'image', 'icon', 'video', 'embed', 'svg', 'social', 'rating', 'html', 'accordion', 'tabs', 'iconList', 'progress', 'divider'].includes(c.kind) && narrower) {
        c.align = horizontalAlign(c, box);
        c.widthPx = c.rect.w;
        if (['embed', 'video', 'html', 'accordion', 'tabs', 'iconList', 'progress', 'divider'].includes(c.kind)) {
          c.widthPct = round((c.rect.w / box.w) * 100);
          c.alignSelf = horizontalAlign(c, box);
        }
      }
      // Off-centre / inset widgets (e.g. text with a left offset) keep their horizontal position.
      if (narrower && ['heading', 'text'].includes(c.kind)) {
        const left = c.rect.x - box.x;
        const right = box.x + box.w - c.rect.x - c.rect.w;
        if (left > 2 || right > 2) {
          // One-line labels (badges, eyebrows) size to their words: a rounded-down
          // percentage would wrap them onto a second line.
          if (oneLineHug(c)) c.autoWidth = true;
          else c.widthPct = round((c.rect.w / box.w) * 100);
          c.alignSelf = horizontalAlign(c, box);
        }
      }
    });
    node.justify = 'flex-start';
    node.alignItems = 'stretch';
  }

  // Keep the measured height (headers with centred content, equal-height cards...).
  // Elementor sizes boxes border-box, so the height includes the border.
  node.minHeight = Math.max(node.minHeight || 0, node.rect.h);
  kids.forEach((c) => layout(c));
  return node;
}

const padX = (n) => (n.padding?.[1] || 0) + (n.padding?.[3] || 0) + (n.border?.width?.[1] || 0) + (n.border?.width?.[3] || 0);

// A box exactly as wide as its one-line contents (icon + label, avatar + name and
// role) sizes to them, so a fraction of a pixel can't wrap a label. Bottom-up, so a
// row can hug a column that hugs its text.
function markHug(node) {
  eachNested(node, (c) => { markHug(c); return c; });
  if (node.kind !== 'container') return;
  node.children.forEach(markHug);
  const flow = node.children.filter((c) => !c.positioned);
  if (!flow.length || node.wrap || node.gridSpec) return;
  // How wide each child would be on its own (one-line text: its words; a box: its contents).
  const natural = (c) => {
    if (c.hug || c.autoWidth || c.fixedWidth || ['image', 'icon', 'svg', 'social', 'rating'].includes(c.kind)) return c.rect.w;
    if (['text', 'heading'].includes(c.kind) && c.textW != null) {
      const lh = c.style?.lineHeight || (c.style?.fontSize || 16) * 1.3;
      if (c.rect.h <= lh * 1.5 + (c.padding?.[0] || 0) + (c.padding?.[2] || 0) + 4) return c.textW + padX(c);
    }
    if (c.kind === 'container' && c.naturalW != null) return c.naturalW;
    return null;
  };
  const widths = flow.map(natural);
  if (widths.some((w) => w == null)) return;
  const contentW = node.direction === 'row'
    ? widths.reduce((t, w, i) => t + w + (flow[i].marginLeft || 0), 0) + (flow.length - 1) * (node.gap?.column || 0)
    : Math.max(...widths);
  // A block wider than its one-line contents still only needs their width when its parent shrinks to fit.
  node.naturalW = contentW + padX(node);
  if (node.direction === 'row' && flow.some((c, i) => Math.abs(c.rect.w - widths[i]) > 3)) return;
  node.hug = Math.abs(node.rect.w - padX(node) - contentW) <= 3;
}

export function normalize(raw) {
  if (!raw.root) throw new Error('Nothing visible was found on that page.');
  const root = raw.root;
  root.isRoot = true;
  const collapsed = collapse(root);
  const top = collapsed.kind === 'container' ? collapsed : { kind: 'container', rect: collapsed.rect, padding: [0, 0, 0, 0], children: [collapsed], direction: 'column' };

  // Every child of <body> becomes one top-level Elementor section.
  // A widget's section spans the column it sits in (or the widget, when it hangs out of
  // the column), so a narrow image or button keeps its width and side instead of filling the page.
  const col = contentBox(top);
  const wrap = (s) => {
    const x = Math.min(col.x, s.rect.x);
    const w = Math.max(col.x + col.w, s.rect.x + s.rect.w) - x;
    return { kind: 'container', rect: { ...s.rect, x, w }, padding: [0, 0, 0, 0], margin: [0, 0, 0, 0], direction: 'column', children: [s], gap: { column: 0, row: 0 } };
  };
  const topKids = top.direction === 'column' && !top.grid ? top.children : [top];
  const flowSections = [];
  const floating = [];
  for (const s of topKids) {
    if (s.positioned) floating.push(s);
    else flowSections.push(s.kind === 'container' ? s : wrap(s));
  }
  // Absolutely positioned page-level pieces attach to the section they overlap.
  for (const f of floating) {
    const host = flowSections.find((s) => f.rect.y >= s.rect.y && f.rect.y < s.rect.y + s.rect.h) || flowSections[0];
    if (host) host.children.push(f);
  }
  let prevBottom = top.rect.y + (top.padding?.[0] || 0);
  for (const s of flowSections) {
    s.marginTop = round(s.rect.y - prevBottom);
    prevBottom = s.rect.y + s.rect.h;
    s.isSection = true;
    if (!s.boxedWidth) {
      // A section whose content is narrower than the page and centred is "boxed".
      const box = contentBox(s);
      if (box.w < raw.viewport.width - 40 && Math.abs(box.x - (raw.viewport.width - box.x - box.w)) <= 4) {
        s.boxedWidth = box.w;
      }
    }
    layout(s);
    markHug(s);
  }
  return {
    title: raw.title,
    pageBackground: raw.pageBackground,
    baseTypography: raw.baseTypography,
    droppedPatterns: raw.droppedPatterns || 0,
    opticalFonts: raw.opticalFonts || [],
    viewportWidth: raw.viewport.width,
    sections: flowSections,
    source: raw.source,
  };
}
