// Shape signature of an SVG icon: its drawn shapes with numbers rounded,
// order-independent, so the same icon copied from a library matches exactly.
const num = (v) => {
  const n = Math.round(parseFloat(v) * 10) / 10;
  return Object.is(n, -0) ? '0' : String(n);
};
const nums = (s) => (String(s || '').match(/-?\d*\.?\d+(?:e-?\d+)?/gi) || []).map(num).join(' ');

function pathSig(d) {
  return (String(d).match(/[a-df-z]|-?\d*\.?\d+(?:e-?\d+)?/gi) || []).map((t) => (/^[a-z]$/i.test(t) ? t : num(t))).join(' ');
}

const ATTRS = {
  path: (a) => `p:${pathSig(a.d)}`,
  circle: (a) => `c:${nums([a.cx || 0, a.cy || 0, a.r].join(' '))}`,
  ellipse: (a) => `e:${nums([a.cx || 0, a.cy || 0, a.rx, a.ry].join(' '))}`,
  rect: (a) => `r:${nums([a.x || 0, a.y || 0, a.width, a.height, a.rx || 0, a.ry || a.rx || 0].join(' '))}`,
  line: (a) => `l:${nums([a.x1, a.y1, a.x2, a.y2].join(' '))}`,
  polyline: (a) => `pl:${nums(a.points)}`,
  polygon: (a) => `pg:${nums(a.points)}`,
};

// shapes: [[tag, attrs], ...]
export function signatureFromNodes(shapes) {
  const parts = shapes
    .filter(([tag, a]) => ATTRS[tag] && !(tag === 'path' && /^M0 0h24v24H0z$/i.test(String(a.d || '').replace(/\s/g, ''))))
    .map(([tag, a]) => ATTRS[tag](a));
  return parts.length ? parts.sort().join('|') : null;
}

// Parses the drawn shapes out of serialized SVG markup (no DOM needed).
export function shapesFromMarkup(svg) {
  const shapes = [];
  const re = /<(path|circle|ellipse|rect|line|polyline|polygon)\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(svg))) {
    const attrs = {};
    for (const a of m[2].matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1]] = a[2];
    if (attrs.fill === 'none' && (attrs.stroke === 'none' || !attrs.stroke) && m[1] !== 'path') continue;
    shapes.push([m[1].toLowerCase(), attrs]);
  }
  return shapes;
}

export function signatureFromMarkup(svg) {
  return signatureFromNodes(shapesFromMarkup(svg));
}
