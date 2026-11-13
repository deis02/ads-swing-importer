'use strict';
/*
  ADS Swing Importer, Figma plugin main thread.

  Reads CSS custom properties (--name: value) and writes them into the current
  Figma file:
    colors, numbers, font families  -> Variables (one collection, CSS modes -> Figma modes)
    font shorthand  (--type-*)      -> Text styles
    box-shadow lists (--elevation-*)-> Effect styles

  Re-running is safe: everything is matched by name and updated in place.
  Nothing in the file is ever deleted.
*/

var WEIGHT_STYLE = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium',
  600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };
var VAR_TYPES = { COLOR: 1, FLOAT: 1, STRING: 1 };

/* ================= CSS scanning ================= */

function stripComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, ''); }

// Flat list of {sel, body, media}. Rules nested in @media/@supports are lifted out.
function splitRules(css, media) {
  var out = [], i = 0, n = css.length;
  while (i < n) {
    var open = css.indexOf('{', i);
    if (open < 0) break;
    var sel = css.slice(i, open);
    var semi = sel.lastIndexOf(';');           // drops "@import url(...);" before the selector
    if (semi >= 0) sel = sel.slice(semi + 1);
    sel = sel.trim();
    var depth = 1, j = open + 1;
    while (j < n && depth > 0) {
      var c = css.charAt(j);
      if (c === '{') depth++; else if (c === '}') depth--;
      j++;
    }
    var body = css.slice(open + 1, depth === 0 ? j - 1 : j);
    if (sel.charAt(0) === '@') out = out.concat(splitRules(body, sel));
    else out.push({ sel: sel, body: body, media: media || '' });
    i = j;
  }
  return out;
}

// Split on sep at paren depth 0, outside quotes. sep ' ' means any whitespace.
function splitTop(s, sep) {
  var parts = [], buf = '', depth = 0, q = '';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (q) { buf += c; if (c === q) q = ''; continue; }
    if (c === '"' || c === "'") { q = c; buf += c; continue; }
    if (c === '(') depth++; else if (c === ')') depth--;
    var hit = sep === ' ' ? /\s/.test(c) : c === sep;
    if (depth === 0 && hit) { if (buf.trim()) parts.push(buf.trim()); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

function declarations(body) {
  return splitTop(body, ';').map(function (d) {
    var k = d.indexOf(':');
    return k < 0 ? null : [d.slice(0, k).trim(), d.slice(k + 1).trim()];
  }).filter(Boolean);
}

// Which Figma mode a rule feeds, or null when it is not a token block.
function modeOf(rule) {
  var s = rule.sel, m;
  if ((m = s.match(/data-theme\s*=\s*["']?([\w-]+)/))) return m[1];
  if ((m = s.match(/\.(?:theme-)?(dark|light)\b/))) return m[1];
  if (/prefers-color-scheme\s*:\s*dark/.test(rule.media)) return 'dark';
  if (/^(:root|html)$/.test(s)) return 'Default';
  return null;
}

function readTokens(css) {
  var rules = splitRules(stripComments(css));
  var T = { modes: ['Default'], vals: { Default: {} }, order: [], seen: {}, upper: {}, ignored: 0 };
  rules.forEach(function (r) {
    var decl = declarations(r.body), mode = modeOf(r), font = null, up = false;
    decl.forEach(function (d) {
      var prop = d[0], val = d[1];
      if (prop.indexOf('--') === 0) {
        if (!mode) { T.ignored++; return; }
        if (!T.vals[mode]) { T.vals[mode] = {}; T.modes.push(mode); }
        if (!T.seen[prop]) { T.seen[prop] = 1; T.order.push(prop); }
        T.vals[mode][prop] = val;
      } else if (prop === 'font') {
        var v = findVar(val, 0);
        if (v && v.start === 0) font = v.name;
      } else if (prop === 'text-transform' && /uppercase/i.test(val)) {
        up = true;
      }
    });
    // utility class like .lbl-l { font: var(--type-lbl-l); text-transform: uppercase }
    if (font && up) T.upper[font] = true;
  });
  return T;
}

/* ================= var() resolution ================= */

function findVar(s, from) {
  var i = s.indexOf('var(', from);
  if (i < 0) return null;
  var depth = 0, j = i + 3;
  for (; j < s.length; j++) {
    var c = s.charAt(j);
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) break; }
  }
  var inner = s.slice(i + 4, j), k = -1, d = 0;
  for (var x = 0; x < inner.length; x++) {
    var ch = inner.charAt(x);
    if (ch === '(') d++; else if (ch === ')') d--;
    else if (ch === ',' && d === 0) { k = x; break; }
  }
  return { start: i, end: j + 1, name: (k < 0 ? inner : inner.slice(0, k)).trim(),
    fallback: k < 0 ? null : inner.slice(k + 1).trim() };
}

function lookup(T, name, mode) {
  var m = T.vals[mode];
  if (m && Object.prototype.hasOwnProperty.call(m, name)) return m[name];
  for (var i = 0; i < T.modes.length; i++) {
    var mm = T.vals[T.modes[i]];
    if (Object.prototype.hasOwnProperty.call(mm, name)) return mm[name];
  }
  return null;
}

function resolve(T, value, mode, depth) {
  depth = depth || 0;
  if (depth > 25) return value;
  var out = '', pos = 0, v;
  while ((v = findVar(value, pos))) {
    out += value.slice(pos, v.start);
    var raw = lookup(T, v.name, mode);
    if (raw != null) out += resolve(T, raw, mode, depth + 1);
    else if (v.fallback != null) out += resolve(T, v.fallback, mode, depth + 1);
    else out += 'var(' + v.name + ')';
    pos = v.end;
  }
  return out + value.slice(pos);
}

// "--x" when the whole value is exactly one var(--x), else null.
function aliasOf(raw) {
  var s = raw.trim(), v = findVar(s, 0);
  return v && v.start === 0 && v.end === s.length ? v.name : null;
}

/* ================= value parsers ================= */

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) return { r: l, g: l, b: l };
  var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  function f(t) {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }
  return { r: f(h + 1 / 3), g: f(h), b: f(h - 1 / 3) };
}

function parseColor(str) {
  var s = String(str).trim(), low = s.toLowerCase(), m;
  if (low === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (low === 'white') return { r: 1, g: 1, b: 1, a: 1 };
  if (low === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  if ((m = s.match(/^#([0-9a-f]{3,8})$/i))) {
    var h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map(function (c) { return c + c; }).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255,
      b: parseInt(h.slice(4, 6), 16) / 255, a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  var fn = s.match(/^(rgba?|hsla?)\(([\s\S]*)\)$/i);
  if (fn) {
    var p = fn[2].replace(/\s*\/\s*/, ',').split(/\s*,\s*|\s+/).filter(Boolean);
    if (p.length < 3) return null;
    var alpha = p[3] == null ? 1 : (/%$/.test(p[3]) ? parseFloat(p[3]) / 100 : parseFloat(p[3]));
    var c;
    if (/^rgb/i.test(fn[1])) {
      var ch = function (x) { return /%$/.test(x) ? parseFloat(x) / 100 : parseFloat(x) / 255; };
      c = { r: ch(p[0]), g: ch(p[1]), b: ch(p[2]) };
    } else {
      c = hslToRgb(parseFloat(p[0]), parseFloat(p[1]) / 100, parseFloat(p[2]) / 100);
    }
    c.a = alpha;
    if ([c.r, c.g, c.b, c.a].some(isNaN)) return null;
    return { r: clamp01(c.r), g: clamp01(c.g), b: clamp01(c.b), a: clamp01(c.a) };
  }
  if ((m = s.match(/^color-mix\(([\s\S]*)\)$/i))) return colorMix(m[1]);
  return null;
}

// color-mix(in srgb, A p%, B q%) with premultiplied alpha, like the browser.
function colorMix(inner) {
  var parts = splitTop(inner, ',');
  if (parts.length !== 3 || !/^in\s+srgb$/i.test(parts[0])) return null;
  function side(x) {
    var t = splitTop(x, ' '), pct = null;
    if (t.length > 1 && /%$/.test(t[t.length - 1])) pct = parseFloat(t.pop()) / 100;
    return { c: parseColor(t.join(' ')), p: pct };
  }
  var A = side(parts[1]), B = side(parts[2]);
  if (!A.c || !B.c) return null;
  var pa = A.p, pb = B.p;
  if (pa == null && pb == null) { pa = 0.5; pb = 0.5; }
  else if (pa == null) pa = 1 - pb;
  else if (pb == null) pb = 1 - pa;
  var sum = pa + pb;
  if (sum <= 0) return null;
  var keep = Math.min(sum, 1);
  pa /= sum; pb /= sum;
  var a = A.c.a * pa + B.c.a * pb;
  function mix(k) { return a === 0 ? 0 : (A.c[k] * A.c.a * pa + B.c[k] * B.c.a * pb) / a; }
  return { r: mix('r'), g: mix('g'), b: mix('b'), a: a * keep };
}

function parseLength(str) {
  var m = String(str).trim().match(/^(-?\d*\.?\d+)(px|rem)?$/i);
  if (!m) return null;
  var n = parseFloat(m[1]);
  return m[2] && m[2].toLowerCase() === 'rem' ? n * 16 : n;
}

function parseShadow(s) {
  if (/gradient\(/i.test(s)) return null;
  var layers = splitTop(s, ','), fx = [];
  for (var i = 0; i < layers.length; i++) {
    var t = splitTop(layers[i], ' '), inset = false, color = null, len = [];
    for (var k = 0; k < t.length; k++) {
      var tok = t[k];
      if (tok === 'inset') { inset = true; continue; }
      if (/^-?\d*\.?\d+(px|rem)?$/i.test(tok)) { len.push(parseLength(tok)); continue; }
      var c = parseColor(tok);
      if (!c || color) return null;
      color = c;
    }
    if (len.length < 2 || len.length > 4 || !color) return null;
    fx.push({ type: inset ? 'INNER_SHADOW' : 'DROP_SHADOW', color: color,
      offset: { x: len[0], y: len[1] }, radius: len[2] || 0, spread: len[3] || 0,
      visible: true, blendMode: 'NORMAL' });
  }
  return fx.length ? fx : null;
}

function firstFamily(stack) {
  var f = splitTop(String(stack), ',')[0];
  return f ? f.replace(/^["']|["']$/g, '').trim() : null;
}

// CSS font shorthand: [style] [weight] size[/line-height] family
function parseFont(s) {
  var m = String(s).trim().match(/^(?:(italic|oblique)\s+)?(?:(normal|bold|\d{3})\s+)?(?:(italic)\s+)?(\d*\.?\d+)(px|rem)\s*(?:\/\s*(\d*\.?\d+)(px|rem|%)?)?\s+([\s\S]+)$/i);
  if (!m) return null;
  var w = m[2];
  w = !w || w === 'normal' ? 400 : w === 'bold' ? 700 : parseInt(w, 10);
  var size = parseFloat(m[4]) * (m[5].toLowerCase() === 'rem' ? 16 : 1), lh = null;
  if (m[6]) {
    var v = parseFloat(m[6]), u = (m[7] || '').toLowerCase();
    lh = u === 'px' ? { unit: 'PIXELS', value: v }
      : u === 'rem' ? { unit: 'PIXELS', value: v * 16 }
      : u === '%' ? { unit: 'PERCENT', value: v }
      : { unit: 'PERCENT', value: v * 100 };
  }
  var fam = firstFamily(m[8]);
  if (fam && /^-?\d/.test(fam)) fam = null;   // "12px 16px" is a padding shorthand, not a font
  return fam ? { family: fam, weight: w, italic: !!(m[1] || m[3]), size: size, lineHeight: lh } : null;
}

function fontStyleName(weight, italic) {
  var base = WEIGHT_STYLE[Math.round(weight / 100) * 100] || 'Regular';
  if (!italic) return base;
  return base === 'Regular' ? 'Italic' : base + ' Italic';
}

/* ================= calc() and shorthands ================= */

// env(safe-area-inset-*) has no meaning on a Figma canvas: 0, or its fallback.
function stripEnv(s) {
  return String(s).replace(/env\(\s*[\w-]+\s*(?:,\s*([^)]*))?\)/g, function (_, fb) { return fb ? fb.trim() : '0px'; });
}

// Small arithmetic parser for calc()/min()/max()/clamp() over px, rem and plain numbers.
function evalCalc(src) {
  var s = stripEnv(src).replace(/\s+/g, ' ').trim(), i = 0;
  function ws() { while (s.charAt(i) === ' ') i++; }
  function num() {
    ws();
    var m = s.slice(i).match(/^(-?\d*\.?\d+)(px|rem)?/i);
    if (!m) return null;
    i += m[0].length;
    return parseFloat(m[1]) * (m[2] && m[2].toLowerCase() === 'rem' ? 16 : 1);
  }
  function args() {
    var list = [];
    for (;;) { var v = expr(); if (v == null) return null; list.push(v); ws();
      if (s.charAt(i) === ',') { i++; continue; }
      if (s.charAt(i) === ')') { i++; return list; }
      return null; }
  }
  function atom() {
    ws();
    var m = s.slice(i).match(/^(calc|min|max|clamp)?\(/i);
    if (m) {
      i += m[0].length;
      var fn = (m[1] || '').toLowerCase();
      if (fn === 'min' || fn === 'max' || fn === 'clamp') {
        var a = args();
        if (!a) return null;
        if (fn === 'min') return Math.min.apply(null, a);
        if (fn === 'max') return Math.max.apply(null, a);
        return a.length === 3 ? Math.min(Math.max(a[0], a[1]), a[2]) : null;
      }
      var v = expr(); ws();
      if (s.charAt(i) !== ')') return null;
      i++;
      return v;
    }
    return num();
  }
  function term() {
    var v = atom();
    for (;;) { ws(); var c = s.charAt(i);
      if (v == null || (c !== '*' && c !== '/')) return v;
      i++; var r = atom(); if (r == null) return null; v = c === '*' ? v * r : v / r; }
  }
  function expr() {
    var v = term();
    for (;;) { ws(); var c = s.charAt(i);
      if (v == null || (c !== '+' && c !== '-')) return v;
      i++; var r = term(); if (r == null) return null; v = c === '+' ? v + r : v - r; }
  }
  var out = expr(); ws();
  return i === s.length && out != null && isFinite(out) ? Math.round(out * 1000) / 1000 : null;
}

function evalLength(s) {
  var v = parseLength(s);
  return v != null ? v : evalCalc(s);
}

// padding-style shorthand -> named sides
var SIDES = { 2: ['y', 'x'], 3: ['top', 'x', 'bottom'], 4: ['top', 'right', 'bottom', 'left'] };

/* ================= gradients -> Figma paints ================= */

function invert(m) {   // 2x3 affine
  var a = m[0][0], b = m[0][1], c = m[0][2], d = m[1][0], e = m[1][1], f = m[1][2], det = a * e - b * d;
  if (!det) return [[1, 0, 0], [0, 1, 0]];
  var ia = e / det, ib = -b / det, id = -d / det, ie = a / det;
  return [[ia, ib, -(ia * c + ib * f)], [id, ie, -(id * c + ie * f)]];
}

function parseStops(parts) {
  var stops = parts.map(function (p) {
    var t = splitTop(p, ' '), pos = null;
    if (t.length > 1 && /%$/.test(t[t.length - 1])) pos = parseFloat(t.pop()) / 100;
    var c = parseColor(t.join(' '));
    return c ? { color: c, position: pos } : null;
  });
  if (!stops.length || stops.some(function (x) { return !x; })) return null;
  if (stops[0].position == null) stops[0].position = 0;
  if (stops[stops.length - 1].position == null) stops[stops.length - 1].position = 1;
  for (var i = 1; i < stops.length; i++) {          // spread stops that have no position
    if (stops[i].position != null) continue;
    var j = i; while (stops[j].position == null) j++;
    var a = stops[i - 1].position, b = stops[j].position;
    for (var k = i; k < j; k++) stops[k].position = a + (b - a) * (k - i + 1) / (j - i + 1);
  }
  return stops.map(function (x) { return { position: clamp01(x.position), color: x.color }; });
}

function angleOf(s) {
  var m = s.match(/^(-?\d*\.?\d+)(deg|turn|rad|grad)$/i);
  if (m) {
    var v = parseFloat(m[1]), u = m[2].toLowerCase();
    return u === 'deg' ? v : u === 'turn' ? v * 360 : u === 'rad' ? v * 180 / Math.PI : v * 0.9;
  }
  var to = s.match(/^to\s+(.+)$/i);
  if (!to) return null;
  var w = to[1].toLowerCase(), x = /left/.test(w) ? -1 : /right/.test(w) ? 1 : 0, y = /top/.test(w) ? -1 : /bottom/.test(w) ? 1 : 0;
  return Math.atan2(x, -y) * 180 / Math.PI;
}

// CSS angle: 0deg points up, clockwise. Figma linear: gradient space (0,.5) -> (1,.5).
// Assumes a square box (the CSS gradient line length depends on the box ratio).
function linearPaint(inner) {
  var parts = splitTop(inner, ','), ang = angleOf(parts[0].trim());
  if (ang == null) ang = 180; else parts.shift();
  var stops = parseStops(parts);
  if (!stops) return null;
  var r = ang * Math.PI / 180, dx = Math.sin(r), dy = -Math.cos(r);
  var L = Math.abs(dx) + Math.abs(dy);
  var gx = dx * L, gy = dy * L, sx = 0.5 - gx / 2, sy = 0.5 - gy / 2, nx = -gy, ny = gx;
  var toNode = [[gx, nx, sx - 0.5 * nx], [gy, ny, sy - 0.5 * ny]];
  return { type: 'GRADIENT_LINEAR', gradientTransform: invert(toNode), gradientStops: stops, visible: true, opacity: 1, blendMode: 'NORMAL' };
}

function posValue(t, axis) {
  var k = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 }[t];
  if (k != null) return k;
  if (/%$/.test(t)) return parseFloat(t) / 100;
  return null;
}

function radialPaint(inner) {
  var parts = splitTop(inner, ','), first = parts[0].trim(), cx = 0.5, cy = 0.5, rx = null, ry = null;
  if (!parseColor(splitTop(first, ' ')[0])) {
    parts.shift();
    var at = first.split(/\s+at\s+/i), size = at[0].trim(), pos = at[1] ? splitTop(at[1].trim(), ' ') : [];
    if (/^at\s+/i.test(first)) { size = ''; pos = splitTop(first.replace(/^at\s+/i, ''), ' '); }
    if (pos.length) {
      var p0 = posValue(pos[0]), p1 = pos.length > 1 ? posValue(pos[1]) : 0.5;
      if (pos.length === 1 && /^(top|bottom)$/.test(pos[0])) { p1 = p0; p0 = 0.5; }
      if (p0 != null) cx = p0;
      if (p1 != null) cy = p1;
    }
    var sz = splitTop(size.replace(/\b(ellipse|circle)\b/gi, '').trim(), ' ').filter(function (x) { return /%$/.test(x); });
    if (sz.length) { rx = parseFloat(sz[0]) / 100; ry = parseFloat(sz[1] || sz[0]) / 100; }
  }
  if (rx == null) {   // farthest-corner
    rx = Math.max(cx, 1 - cx) * Math.SQRT2; ry = Math.max(cy, 1 - cy) * Math.SQRT2;
  }
  var stops = parseStops(parts);
  if (!stops) return null;
  var toNode = [[2 * rx, 0, cx - rx], [0, 2 * ry, cy - ry]];
  return { type: 'GRADIENT_RADIAL', gradientTransform: invert(toNode), gradientStops: stops, visible: true, opacity: 1, blendMode: 'NORMAL' };
}

// CSS background layers (first = top) -> Figma paints (last = top)
function parsePaints(val) {
  var layers = splitTop(val, ','), paints = [];   // commas inside gradient() stay with their layer
  for (var i = 0; i < layers.length; i++) {
    var l = layers[i].trim(), m;
    if ((m = l.match(/^(repeating-)?(linear|radial)-gradient\(([\s\S]*)\)$/i))) {
      if (m[1]) return null;
      var p = m[2].toLowerCase() === 'linear' ? linearPaint(m[3]) : radialPaint(m[3]);
      if (!p) return null;
      paints.push(p);
    } else {
      var c = parseColor(l);
      if (!c) return null;
      paints.push({ type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a, visible: true, blendMode: 'NORMAL' });
    }
  }
  return paints.length ? paints.reverse() : null;
}

/* ================= naming ================= */

// Category first, then family, then step. Every item also keeps its CSS name
// in the description, which is how a re-import finds and renames it.
function title(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
var SIZE_WORD = { xs: 'XS', s: 'Small', m: 'Medium', l: 'Large', xl: 'XL' };

// Semantic color: --color-text-muted -> Text/muted, --color-bg -> Background/default
var SEM_GROUP = { text: 'Text', bg: 'Background', background: 'Background', surface: 'Background', band: 'Background',
  line: 'Border', border: 'Border', divider: 'Border', primary: 'Brand', secondary: 'Brand', brand: 'Brand', accent: 'Brand',
  success: 'Status', alert: 'Status', warning: 'Status', error: 'Status', danger: 'Status', destructive: 'Status', info: 'Status' };
var ROLE_OF_GROUP = { Brand: 'Primary', Status: 'Status', Text: 'Neutral', Background: 'Neutral', Border: 'Neutral' };
var ROLE_RANK = { Primary: 3, Status: 2, Neutral: 1 };

function semanticName(rest) {
  var k = rest.indexOf('-'), head = k < 0 ? rest : rest.slice(0, k), tail = k < 0 ? '' : rest.slice(k + 1);
  var g = SEM_GROUP[head];
  if (!g) return 'Other/' + rest;
  if (g === 'Brand' || g === 'Status') return g + '/' + rest;             // Status/success, Brand/primary
  if (head === 'band') return g + '/band' + (tail ? '-' + tail : '');      // Background/band
  return g + '/' + (tail || 'default');                                   // Text/muted, Background/default
}

// ctx.ramps: color prefixes with 3+ numbered steps. ctx.roles: ramp -> Primary/Status/Neutral/Secondary
function variableName(css, type, ctx) {
  var s = css.replace(/^--/, ''), m;
  if (type === 'COLOR') {
    if ((m = s.match(/^color-(.+)$/))) return 'Color/Semantic/' + semanticName(m[1]);
    if ((m = s.match(/^([a-z]+)-(.+)$/)) && ctx.ramps[m[1]])
      return 'Color/' + (ctx.roles[m[1]] || 'Secondary') + '/' + title(m[1]) + '/' + m[2];   // Color/Primary/Purple/500
    if (/scrim|overlay/.test(s)) return 'Color/Overlay/' + s;
    if ((m = s.match(/^([a-z]+)-(.+)$/))) return 'Color/' + title(m[1]) + '/' + m[2];       // Color/Glass/line
    return 'Color/Other/' + s;
  }
  if (type === 'STRING') {
    if (/^(font-family|font|family)$/.test(s)) return 'Typography/Family';
    return (/font|family/.test(s) ? 'Typography/' : 'Text/') + s;
  }
  if ((m = s.match(/^z-(.+)$/))) return 'Z-index/' + m[1];
  if ((m = s.match(/^opacity-(.+)$/))) return 'Opacity/' + m[1];                 // --opacity-50 -> Opacity/50
  if ((m = s.match(/^(track|tracking|letter-spacing)-(.+)$/))) return 'Typography/Tracking/' + m[2];
  if ((m = s.match(/^([a-z]+)-pad(?:ding)?-(.+)$/))) return 'Spacing/' + title(m[1]) + '/' + m[2];   // --bar-pad top
  if ((m = s.match(/^space-(.+)$/))) return 'Spacing/Scale/' + m[1];         // --space-16
  if ((m = s.match(/^(gap|page|inset)-(.+)$/))) return 'Spacing/' + title(m[1]) + '/' + m[2];
  if ((m = s.match(/^radius-(.+)$/))) return 'Radius/' + m[1];
  if ((m = s.match(/^([a-z]+)-radius-(.+)$/))) return 'Radius/' + m[2];     // --ads-radius-4 -> Radius/4 (one flat group)
  if ((m = s.match(/^([a-z]+)-(gap|space)-(.+)$/)))                         // --ads-gap-14 -> Spacing/ADS/14
    return 'Spacing/' + m[1].toUpperCase() + '/' + m[3];
  if ((m = s.match(/^(fw|font-weight)-(.+)$/))) return 'Typography/Weight/' + m[2];
  if ((m = s.match(/^(.+)-(h|w)$/))) return 'Size/' + title(m[1]) + '/' + (m[2] === 'h' ? 'height' : 'width');   // Size/Header/height
  if ((m = s.match(/^([a-z]+)-(min|max)$/))) return 'Size/' + title(m[1]) + '/' + m[2];                   // Size/Tap/min
  if (/height|width|size/.test(s)) return 'Size/' + s;
  return 'Number/' + s;
}

// --type-h1 -> Heading/H1, --type-s1s -> Subheading/Semibold/S1, --type-b2 -> Body/Regular/B2
// ("s" suffix = fw-bold 700, which ADS Figma calls Semibold)
function textName(css) {
  var s = css.replace(/^--(type|text|font)-/, ''), m;
  if ((m = s.match(/^desktop-(.+)$/))) return 'Desktop/' + textName('--type-' + m[1]);   // --type-desktop-h1 -> Desktop/Heading/H1
  if ((m = s.match(/^h(\d)$/))) return 'Heading/H' + m[1];
  if ((m = s.match(/^(s|b)(\d)(s?)$/)))
    return (m[1] === 's' ? 'Subheading' : 'Body') + '/' + (m[3] ? 'Semibold' : 'Regular') + '/' + m[1].toUpperCase() + m[2];
  if ((m = s.match(/^(cta|btn|button)-(.+)$/))) return 'CTA/' + (SIZE_WORD[m[2]] || m[2]);
  if ((m = s.match(/^(lbl|label)-(.+)$/))) return 'Label/' + (SIZE_WORD[m[2]] || m[2]);
  return 'Text/' + s;
}

// --elevation-2 -> Elevation/Scale/2, --elevation-brand-s -> Elevation/Brand/s,
// --elevation-card-s -> Elevation/Component/card-s, --ring-focus -> Focus/ring, --line-sticky -> Line/sticky
function effectName(css) {
  var s = css.replace(/^--/, ''), m;
  if ((m = s.match(/^(elevation|shadow)-(.+)$/))) {
    var r = m[2];
    if (/^\d+$/.test(r)) return 'Elevation/Scale/' + r;
    if ((m = r.match(/^brand(?:-(.+))?$/))) return 'Elevation/Brand/' + (m[1] ? (SIZE_WORD[m[1]] || m[1]) : 'Default');
    return 'Elevation/Component/' + r;
  }
  if (s === 'ring-focus' || s === 'focus-ring') return 'Focus/ring';
  if ((m = s.match(/^([a-z]+)-(.+)$/))) return title(m[1]) + '/' + m[2];
  return 'Effect/' + s;
}

// --gradient-purple -> Gradient/Brand/purple, --glass-fill -> Gradient/Surface/glass-fill,
// --deal-scrim -> Gradient/Overlay/deal-scrim
// Paint style names the file already uses (Ghais 11 Nov: the Swing Pass gradient is "Gradient/Brand/purple-sp")
var PAINT_NAMES = { '--gradient-swing-pass': 'Gradient/Brand/purple-sp' };
function paintName(css) {
  if (PAINT_NAMES[css]) return PAINT_NAMES[css];
  var s = css.replace(/^--/, '').replace(/^gradient-|-gradient$/g, '');
  var g = /scrim|overlay|fade/.test(s) ? 'Overlay' : /glass|card|surface|bg|background/.test(s) ? 'Surface' : 'Brand';
  return 'Gradient/' + g + '/' + s;
}

function scopesFor(css, type) {
  if (/^--z(-|$)/.test(css) || /(^--|-)(track|tracking|letter-spacing)-/.test(css)) return [];   // hidden from pickers
  if (/^--[a-z]+-pad(ding)?-/.test(css)) return ['GAP'];
  if (type === 'STRING') return /font|family/.test(css) ? ['FONT_FAMILY'] : ['ALL_SCOPES'];
  if (type !== 'FLOAT') return ['ALL_SCOPES'];
  if (/^--opacity-/.test(css)) return ['OPACITY'];
  if (/radius/.test(css)) return ['CORNER_RADIUS'];
  if (/^--(fw|font-weight)(-|$)/.test(css)) return ['FONT_WEIGHT'];
  if (/^--(space|gap|inset|page)(-|$)|-gap-/.test(css)) return ['GAP'];
  if (/(-h|-w|height|width|size|tap-min)$/.test(css)) return ['WIDTH_HEIGHT'];
  return ['ALL_SCOPES'];
}

/* ================= analysis ================= */

function analyze(css) {
  var T = readTokens(css);
  var plan = { modes: T.modes, variables: [], text: [], effects: [], paints: [], skipped: [], folded: [], ignored: T.ignored };
  var memo = {};

  function classify(name, stack) {
    if (memo[name]) return memo[name];
    stack = stack || {};
    if (stack[name]) return { k: 'SKIP', why: 'Circular var() reference.' };
    stack[name] = 1;
    var raw = (lookup(T, name, 'Default') || '').trim();
    var r = classifyRaw(name, raw, stack);
    memo[name] = r;
    return r;
  }

  var NOTE_Z = 'z-index: Figma has no stacking property, so this is kept for Dev Mode handoff and hidden from pickers.';
  var NOTE_TRACK = 'Letter spacing in %, from CSS em x 100. Figma reads a bound variable as px, so this is hidden from pickers; the text styles carry the same % value.';
  var NOTE_ENV = 'env(safe-area-inset-*) counts as 0 on the canvas. Add the device safe area (iPhone home indicator 34) yourself when a frame shows it.';
  var NOTE_OPACITY = 'Opacity in % (CSS 0.5 = Figma 50), for layer opacity.';

  function classifyRaw(name, raw, stack) {
    var val = resolve(T, raw, 'Default').trim();
    if (/^--z(-|$)/.test(name) && parseLength(val) != null) return { k: 'FLOAT', note: NOTE_Z };
    if (/^--opacity-/.test(name) && parseLength(val) != null) return { k: 'FLOAT', opacity: true, note: NOTE_OPACITY };
    if (/(^--|-)(track|tracking|letter-spacing)-/.test(name) && !/-track$/.test(name)) {
      if (/^-?\d*\.?\d+(em)?$/i.test(val)) return { k: 'FLOAT', track: true, note: NOTE_TRACK };
    }
    var a = aliasOf(raw);
    if (a) {
      if (T.seen[a]) {
        var t = classify(a, stack);
        if (VAR_TYPES[t.k]) return { k: t.k, alias: a, note: t.note, track: t.track };
        if (t.k === 'SKIP') return { k: 'SKIP', why: 'Points to ' + a + ', which is skipped.' };
      } else if (findVar(raw, 0).fallback == null) {
        return { k: 'SKIP', why: 'Points to ' + a + ', which is not defined.' };
      }
    }
    if (/var\(--/.test(val)) return { k: 'SKIP', why: 'Uses a var() that is not defined.' };
    if (/gradient\(/i.test(val)) return parsePaints(val) ? { k: 'PAINT' } : { k: 'SKIP', why: 'Gradient form not supported (repeating or conic).' };
    if (parseColor(val)) return { k: 'COLOR' };
    if (/^color-mix\(/i.test(val)) return { k: 'SKIP', why: 'color-mix() outside srgb is not supported.' };
    if (parseLength(val) != null) return { k: 'FLOAT' };
    if (parseFont(val)) return { k: 'TEXT' };
    if (parseShadow(val)) return { k: 'EFFECT' };
    if (val === 'none' && /elevation|shadow/.test(name)) return { k: 'EFFECT', none: true };
    var parts = splitTop(raw.trim(), ' ');
    if (SIDES[parts.length] && parts.every(function (p) { return evalLength(resolve(T, p, 'Default').trim()) != null; }))
      return { k: 'SPLIT', note: /env\(/.test(raw) ? NOTE_ENV : null };
    if (evalCalc(val) != null) return { k: 'FLOAT', calc: true, note: /env\(/.test(val) ? NOTE_ENV : null };
    if (/font|family/.test(name) || /^["']/.test(val)) return { k: 'STRING' };
    return { k: 'SKIP', why: 'Value type not supported: ' + val };
  }

  function literal(type, value, c) {
    if (type === 'COLOR') return parseColor(value);
    if (type === 'FLOAT') {
      if (c && c.track) { var em = value.match(/^(-?\d*\.?\d+)em$/i); return em ? Math.round(parseFloat(em[1]) * 10000) / 100 : parseFloat(value); }
      if (c && c.opacity) { var op = evalLength(value); return op == null ? null : Math.round(op * 10000) / 100; }   // 0.5 -> 50
      return evalLength(value);
    }
    if (type === 'STRING') return firstFamily(value);
    return null;
  }

  // One value per mode: alias when the CSS value is exactly var(--known-same-type), else a literal.
  function valuesFor(rawOf, type, c) {
    var values = {};
    T.modes.forEach(function (m) {
      var raw = (rawOf(m) || '').trim(), a = aliasOf(raw);
      if (a && T.seen[a] && classify(a).k === type) values[m] = { alias: a };
      else {
        var v = literal(type, resolve(T, raw, m).trim(), c);
        if (v != null) values[m] = { value: v };
      }
    });
    return values;
  }

  T.order.forEach(function (name) {
    // --type-h1-track and --type-h1-para are consumed by the --type-h1 text style
    var base = name.replace(/-(track|para)$/, '');
    if (base !== name && T.seen[base] && classify(base).k === 'TEXT') { plan.folded.push(name); return; }
    var c = classify(name);
    if (c.k === 'SKIP') { plan.skipped.push({ css: name, why: c.why }); return; }
    if (VAR_TYPES[c.k]) {
      plan.variables.push({ css: name, key: name, code: 'var(' + name + ')', note: c.note || null, name: null, type: c.k,
        scopes: scopesFor(name, c.k), values: valuesFor(function (m) { return lookup(T, name, m); }, c.k, c) });
    } else if (c.k === 'SPLIT') {
      var n = splitTop(lookup(T, name, 'Default').trim(), ' ').length;
      SIDES[n].forEach(function (side, idx) {
        var sub = name + '-' + side;
        plan.variables.push({ css: sub, key: name + ':' + side, code: 'var(' + name + ') ' + side, note: c.note || null,
          name: null, type: 'FLOAT', scopes: ['GAP'], values: valuesFor(function (m) {
            var p = splitTop((lookup(T, name, m) || '').trim(), ' ');
            return p.length === n ? p[idx] : null;
          }, 'FLOAT') });
      });
    } else if (c.k === 'TEXT') {
      var f = parseFont(resolve(T, lookup(T, name, 'Default'), 'Default'));
      var trackRaw = lookup(T, name + '-track', 'Default'), track = null;
      if (trackRaw != null) {
        var tv = resolve(T, trackRaw, 'Default').trim(), em = tv.match(/^(-?\d*\.?\d+)em$/i);
        if (em) track = { unit: 'PERCENT', value: parseFloat(em[1]) * 100 };
        else if (parseLength(tv) != null) track = parseLength(tv) === 0 ? { unit: 'PERCENT', value: 0 } : { unit: 'PIXELS', value: parseLength(tv) };
      }
      plan.text.push({ css: name, name: textName(name), family: f.family, style: fontStyleName(f.weight, f.italic),
        size: f.size, lineHeight: f.lineHeight, letterSpacing: track, upper: !!T.upper[name] });
      // Typography variables for this style. Figma reads a number variable on line height and letter
      // spacing as pixels (no percent), so tracking (-0.02em) becomes px at this style's size.
      var rawFont = lookup(T, name, 'Default') || '', refs = [], fv;
      var reV = /var\(\s*(--[\w-]+)/g;
      while ((fv = reV.exec(rawFont))) refs.push(fv[1]);
      var t0 = plan.text[plan.text.length - 1];
      t0.weightVar = refs.filter(function (r) { return /^--(fw|font-weight)(-|$)/.test(r); })[0] || null;
      t0.familyVar = refs.filter(function (r) { return /(^--font-family|family)/.test(r); })[0] || null;
      var px = function (x) { return Math.round(x * 100) / 100; };
      var lhPx = !f.lineHeight ? null : f.lineHeight.unit === 'PIXELS' ? f.lineHeight.value : f.size * f.lineHeight.value / 100;
      var lsPx = !track ? 0 : track.unit === 'PIXELS' ? track.value : f.size * track.value / 100;
      [['size', f.size, 'FONT_SIZE', 'var(' + name + ')'], ['line-height', lhPx, 'LINE_HEIGHT', 'var(' + name + ')'],
        ['letter-spacing', lsPx, 'LETTER_SPACING', 'var(' + name + '-track)']].forEach(function (x) {
        if (x[1] == null) return;
        var key = name + ':' + x[0], vals = {};
        vals[T.modes[0]] = { value: px(x[1]) };
        plan.variables.push({ css: key, key: key, code: x[3], note: x[0] === 'letter-spacing' && track && track.unit === 'PERCENT' ? track.value + '% of ' + f.size + 'px, in px because Figma variables have no percent' : null,
          name: null, fixedName: 'Typography/' + t0.name + '/' + x[0], type: 'FLOAT', scopes: [x[2]], values: vals });
        t0[x[0] === 'size' ? 'sizeVar' : x[0] === 'line-height' ? 'lhVar' : 'lsVar'] = key;
      });
      // Paragraph spacing (--type-b1-para): the style's own variable, an alias of the spacing step it uses
      var paraRaw = lookup(T, name + '-para', 'Default');
      if (paraRaw != null) {
        var pa = aliasOf(paraRaw.trim()), pval = evalLength(resolve(T, paraRaw, 'Default').trim());
        if (pval != null) {
          var pkey = name + ':paragraph-spacing', pvals = {};
          pvals[T.modes[0]] = pa && T.seen[pa] && classify(pa).k === 'FLOAT' ? { alias: pa } : { value: px(pval) };
          plan.variables.push({ css: pkey, key: pkey, code: 'var(' + name + '-para)', note: null, name: null,
            fixedName: 'Typography/' + t0.name + '/paragraph-spacing', type: 'FLOAT', scopes: ['PARAGRAPH_SPACING'], values: pvals });
          t0.paragraph = px(pval); t0.paraVar = pkey;
        }
      }
    } else if (c.k === 'EFFECT') {
      plan.effects.push({ css: name, name: effectName(name),
        effects: c.none ? [] : parseShadow(resolve(T, lookup(T, name, 'Default'), 'Default').trim()) });
    } else if (c.k === 'PAINT') {
      plan.paints.push({ css: name, name: paintName(name), paints: parsePaints(resolve(T, lookup(T, name, 'Default'), 'Default').trim()) });
    }
  });

  // A ramp is a color prefix with 3+ numbered steps (purple-50 ... purple-700).
  var steps = {}, ramps = {};
  plan.variables.forEach(function (v) {
    var m = v.type === 'COLOR' && v.css.match(/^--([a-z]+)-\d+$/);
    if (m && m[1] !== 'color') steps[m[1]] = (steps[m[1]] || 0) + 1;
  });
  wireKeys(steps).forEach(function (k) { if (steps[k] >= 3) ramps[k] = true; });
  // A ramp's role comes from the semantic tokens that point at it:
  // --color-primary -> purple = Primary, --color-success -> green = Status, --color-text -> dark = Neutral.
  // Ramps nobody points at are Secondary.
  var roles = {};
  plan.variables.forEach(function (v) {
    var m = v.type === 'COLOR' && v.css.match(/^--color-([a-z]+)/), a = v.values.Default && v.values.Default.alias;
    if (!m || !a) return;
    var g = SEM_GROUP[m[1]], role = g && ROLE_OF_GROUP[g], fam = (a.match(/^--([a-z]+)-/) || [])[1];
    if (role && fam && ramps[fam] && (!roles[fam] || ROLE_RANK[role] > ROLE_RANK[roles[fam]])) roles[fam] = role;
  });
  plan.variables.forEach(function (v) { v.name = v.fixedName || variableName(v.css, v.type, { ramps: ramps, roles: roles }); });
  // two tokens on one name (e.g. --radius-4 and --ads-radius-4): keep the second apart by its CSS name
  var taken = {};
  plan.variables.forEach(function (v) {
    if (taken[v.name]) v.name = v.name.replace(/[^/]+$/, v.css.replace(/^--/, ''));
    taken[v.name] = 1;
  });
  return plan;
}

function summary(plan) {
  function count(t) { return plan.variables.filter(function (v) { return v.type === t; }).length; }
  return { modes: plan.modes, colors: count('COLOR'), numbers: count('FLOAT'), strings: count('STRING'),
    hidden: plan.variables.filter(function (v) { return !v.scopes.length; }).length,
    text: plan.text.length, textDesktop: plan.text.filter(function (t) { return /^Desktop\//.test(t.name); }).length,
    effects: plan.effects.length, paints: plan.paints.length, folded: plan.folded.length,
    skipped: plan.skipped, ignored: plan.ignored };
}

/* ================= writing to Figma ================= */

async function importPlan(plan, opts) {
  var res = { created: 0, updated: 0, renamed: 0, errors: [], notes: [] };

  if (opts.variables && plan.variables.length) {
    var cols = await figma.variables.getLocalVariableCollectionsAsync();
    var col = cols.filter(function (c) { return c.name === opts.collection; })[0];
    var fresh = !col;
    if (fresh) col = figma.variables.createVariableCollection(opts.collection);

    var modeId = {};
    plan.modes.forEach(function (m, i) {
      var found = col.modes.filter(function (x) { return x.name === m; })[0];
      if (found) modeId[m] = found.modeId;
      else if (i === 0) {
        modeId[m] = col.defaultModeId;
        if (fresh) col.renameMode(col.defaultModeId, m);
      } else {
        try { modeId[m] = col.addMode(m); }
        catch (e) { res.notes.push('Mode "' + m + '" not added (' + e.message + '). Its values were skipped.'); }
      }
    });

    var existing = {}, byDesc = {};
    var olds = await Promise.all(col.variableIds.map(function (id) { return figma.variables.getVariableByIdAsync(id); }));
    olds.forEach(function (v) {
      if (!v) return;
      existing[v.name] = v;
      var k = (v.description || '').split('\n')[0];
      if (/^--/.test(k)) byDesc[k] = v;
    });

    var byCss = {};
    plan.variables.forEach(function (t) {
      var v = byDesc[t.key] || existing[t.name];
      if (v && v.resolvedType !== t.type) {
        res.errors.push(t.css + ': already exists as ' + v.resolvedType + ', not ' + t.type + '.');
        return;
      }
      if (v) {
        res.updated++;
        if (v.name !== t.name) {
          try { v.name = t.name; res.renamed++; }
          catch (e) { res.errors.push(t.css + ': could not rename to ' + t.name + ' (' + e.message + ')'); }
        }
      }
      else { v = figma.variables.createVariable(t.name, col, t.type); res.created++; }
      v.description = t.key + (t.note ? '\n' + t.note : '');
      try { v.setVariableCodeSyntax('WEB', t.code); } catch (e) { /* older API */ }
      try { v.scopes = t.scopes; } catch (e) { /* scope not valid for this type */ }
      byCss[t.css] = v;
    });

    plan.variables.forEach(function (t) {
      var v = byCss[t.css];
      if (!v) return;
      var def = t.values[plan.modes[0]];
      plan.modes.forEach(function (m) {
        if (!modeId[m]) return;
        var val = t.values[m] || def;
        if (!val) return;
        try {
          if (val.alias) {
            var target = byCss[val.alias];
            if (target) v.setValueForMode(modeId[m], figma.variables.createVariableAlias(target));
          } else {
            v.setValueForMode(modeId[m], val.value);
          }
        } catch (e) { res.errors.push(t.css + ' [' + m + ']: ' + e.message); }
      });
    });
  }

  if (opts.text && plan.text.length) {
    var styles = await figma.getLocalTextStylesAsync(), tmap = {}, tdesc = {};
    styles.forEach(function (s) { tmap[s.name] = s; if (/^--/.test(s.description)) tdesc[s.description] = s; });
    // variables by their --token key (this run's or an earlier import's), for the typography bindings
    var tvars = {}, bindFail = [];
    (await figma.variables.getLocalVariablesAsync()).forEach(function (v) { var k = (v.description || '').split('\n')[0]; if (/^--/.test(k)) tvars[k] = v; });
    for (var i = 0; i < plan.text.length; i++) {
      var t = plan.text[i], font = { family: t.family, style: t.style };
      try { await figma.loadFontAsync(font); }
      catch (e) { res.errors.push(t.css + ': font "' + t.family + ' ' + t.style + '" is not available in Figma.'); continue; }
      var st = tdesc[t.css] || tmap[t.name];
      if (st) {
        await figma.loadFontAsync(st.fontName); res.updated++;
        if (st.name !== t.name) { st.name = t.name; res.renamed++; }
      }
      else { st = figma.createTextStyle(); st.name = t.name; res.created++; }
      st.fontName = font;
      st.fontSize = t.size;
      st.lineHeight = t.lineHeight || { unit: 'AUTO' };
      if (t.letterSpacing) st.letterSpacing = t.letterSpacing;
      st.textCase = t.upper ? 'UPPER' : 'ORIGINAL';
      st.description = t.css;
      st.paragraphSpacing = t.paragraph || 0;
      [['fontFamily', t.familyVar], ['fontWeight', t.weightVar], ['fontSize', t.sizeVar], ['lineHeight', t.lhVar], ['letterSpacing', t.lsVar], ['paragraphSpacing', t.paraVar]].forEach(function (b) {
        var v = b[1] && tvars[b[1]];
        if (!v) return;
        try { st.setBoundVariable(b[0], v); } catch (e) { bindFail.push(t.name + ' ' + b[0] + ' (' + e.message + ')'); }
      });
    }
    if (bindFail.length) res.notes.push('Some text style fields could not be bound to variables: ' + bindFail.slice(0, 4).join('; ') + (bindFail.length > 4 ? ' and ' + (bindFail.length - 4) + ' more' : '') + '. Their values are still set.');
    else if (Object.keys(tvars).length) res.notes.push('Text styles: family, weight, size, line height and letter spacing are bound to the Typography variables. Line height and letter spacing are in px, because Figma variables have no percent.');
  }

  if (opts.effects && plan.effects.length) {
    var eff = await figma.getLocalEffectStylesAsync(), emap = {}, edesc = {};
    eff.forEach(function (s) { emap[s.name] = s; if (/^--/.test(s.description)) edesc[s.description] = s; });
    plan.effects.forEach(function (t) {
      try {
        var st = edesc[t.css] || emap[t.name];
        if (st) { res.updated++; if (st.name !== t.name) { st.name = t.name; res.renamed++; } }
        else { st = figma.createEffectStyle(); st.name = t.name; res.created++; }
        st.effects = t.effects;
        st.description = t.css;
      } catch (e) { res.errors.push(t.css + ': ' + e.message); }
    });
  }

  if (opts.paints && plan.paints.length) {
    var ps = await figma.getLocalPaintStylesAsync(), pmap = {}, pdesc = {};
    ps.forEach(function (s) { pmap[s.name] = s; var k = (s.description || '').split('\n')[0]; if (/^--/.test(k)) pdesc[k] = s; });
    plan.paints.forEach(function (t) {
      try {
        var st = pdesc[t.css] || pmap[t.name];
        // a style the file made itself under the agreed name (Gradient/Brand/purple-sp is the ADS fill): use it, never overwrite it
        if (PAINT_NAMES[t.css] && pmap[t.name] && pmap[t.name] !== pdesc[t.css]) return;
        if (st) { res.updated++; if (st.name !== t.name) { st.name = t.name; res.renamed++; } }
        else { st = figma.createPaintStyle(); st.name = t.name; res.created++; }
        st.paints = t.paints;
        st.description = t.css + (t.paints.some(function (p) { return p.type === 'GRADIENT_LINEAR'; })
          ? '\nLinear angle is converted for a square box; on wide frames CSS stretches the gradient line slightly differently.' : '');
      } catch (e) { res.errors.push(t.css + ': ' + e.message); }
    });
  }
  return res;
}

/* ================= tokens already in the file ================= */

// Everything this plugin writes keeps its CSS name on the first line of the
// description, so components can ask for "--purple-500" and get the variable.
async function loadRegistry() {
  var R = { vars: {}, text: {}, effects: {}, paints: {}, missing: {}, color: {} };
  var vs = await figma.variables.getLocalVariablesAsync();
  var cols = await figma.variables.getLocalVariableCollectionsAsync(), defMode = {}, byId = {};
  cols.forEach(function (c) { defMode[c.id] = c.defaultModeId; });
  vs.forEach(function (v) { byId[v.id] = v; var k = (v.description || '').split('\n')[0]; if (/^--/.test(k)) R.vars[k] = v; });
  // the colour each variable shows in its collection's default mode, aliases followed
  function resolved(v, depth) {
    if (!v || depth > 12) return null;
    var val = v.valuesByMode[defMode[v.variableCollectionId]];
    if (val && val.type === 'VARIABLE_ALIAS') return resolved(byId[val.id], depth + 1);
    return val && typeof val === 'object' && 'r' in val ? val : null;
  }
  wireKeys(R.vars).forEach(function (k) { if (R.vars[k].resolvedType === 'COLOR') R.color[k] = resolved(R.vars[k], 0); });
  (await figma.getLocalTextStylesAsync()).forEach(function (s) { if (/^--/.test(s.description)) R.text[s.description.split('\n')[0]] = s; });
  (await figma.getLocalEffectStylesAsync()).forEach(function (s) { if (/^--/.test(s.description)) R.effects[s.description.split('\n')[0]] = s; });
  R.v = function (css) { var v = R.vars[css]; if (!v) R.missing[css] = 1; return v || null; };
  return R;
}

function solid(c) { return { type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a == null ? 1 : c.a }; }

// css: a token name ('--purple-500'), a literal color object, or null for no fill
function paintFor(R, css) {
  if (!css) return [];
  if (typeof css === 'object') return [solid(css)];
  var v = R.v(css);
  if (!v) return [solid({ r: 1, g: 0, b: 0.6, a: 1 })];   // magenta = token missing, easy to spot
  // The base colour is the variable's own value, so the paint still looks right
  // if Figma shows the base instead of the binding (seen on min-width auto layout).
  var base = R.color[css] || { r: 0, g: 0, b: 0, a: 1 };
  return [figma.variables.setBoundVariableForPaint(solid(base), 'color', v)];
}

function bindNumber(R, node, field, css, fallback) {
  var v = R.v(css);
  node[field] = fallback;
  if (v) node.setBoundVariable(field, v);
}

function bindRadius(R, node, css, fallback) {
  ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius'].forEach(function (f) { bindNumber(R, node, f, css, fallback); });
}

// Pills (CSS radius-full): Figma renders auto-layout frames with a bound 9999 radius wrong
// (fill black or missing, seen on Counter and Tag 09 Nov). Use half the height, unbound,
// which is how a pill is drawn in Figma anyway.
function pillRadius(node, h) {
  ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius'].forEach(function (f) {
    try { node.setBoundVariable(f, null); } catch (e) { /* was not bound */ }
    node[f] = h / 2;
  });
}

async function pageNamed(name) {
  var p = figma.root.children.filter(function (x) { return x.name === name; })[0];
  if (!p) { p = figma.createPage(); p.name = name; }
  await p.loadAsync();
  return p;
}

/* ================= icons ================= */

var ICON_COLS = 32, ICON_CELL = 48;
var iconRun = null;

async function iconSection(page, title, R) {
  var s = page.children.filter(function (n) { return n.type === 'SECTION' && n.name === title; })[0];
  if (!s) {
    s = figma.createSection();
    s.name = title;
    page.appendChild(s);
    var others = page.children.filter(function (n) { return n !== s; });
    s.x = 0;
    s.y = others.reduce(function (y, n) { return Math.max(y, n.y + n.height + 120); }, 0);
  }
  s.fills = paintFor(R, '--color-bg-subtle');   // soft white (light-200), not Figma's default grey
  return s;
}

async function importIconBatch(items) {
  if (!iconRun) {
    var page = await pageNamed('Icons');
    var have = {};
    page.findAllWithCriteria({ types: ['COMPONENT'] }).forEach(function (c) { have[c.name] = c; });
    iconRun = { page: page, have: have, sections: {}, made: 0, skipped: 0, failed: [], R: await loadRegistry() };
    page.children.forEach(function (n) { if (n.type === 'SECTION') n.fills = paintFor(iconRun.R, '--color-bg-subtle'); });
  }
  var run = iconRun;
  for (var i = 0; i < items.length; i++) {
    var it = items[i], set = it.set === 'solid' ? 'Solid' : 'Line', name = 'Icon/' + set + '/' + it.name;
    if (run.have[name]) { run.skipped++; continue; }
    try {
      var frame = figma.createNodeFromSvg(it.svg);
      run.page.appendChild(frame);
      var shapes = frame.children.slice();
      if (!shapes.length) { frame.remove(); run.failed.push(it.set + '/' + it.name + ': empty svg'); continue; }
      var vec = figma.flatten(shapes, frame);
      var comp = figma.createComponent();
      run.page.appendChild(comp);
      comp.resizeWithoutConstraints(24, 24);
      comp.fills = [];
      comp.appendChild(vec);
      frame.remove();
      vec.name = 'Icon';
      vec.constraints = { horizontal: 'SCALE', vertical: 'SCALE' };
      vec.strokes = [];
      vec.fills = paintFor(run.R, '--color-text');
      comp.name = name;
      comp.description = it.cat || '';
      var sec = run.sections[set] || (run.sections[set] = { node: await iconSection(run.page, set, run.R), n: 0 });
      sec.n = sec.node.children.length;
      sec.node.appendChild(comp);
      comp.x = 40 + (sec.n % ICON_COLS) * ICON_CELL;
      comp.y = 40 + Math.floor(sec.n / ICON_COLS) * ICON_CELL;
      var rows = Math.ceil((sec.n + 1) / ICON_COLS);
      sec.node.resizeWithoutConstraints(80 + ICON_COLS * ICON_CELL - 24, 80 + rows * ICON_CELL - 24);
      run.have[name] = comp;
      run.made++;
    } catch (e) { run.failed.push(it.set + '/' + it.name + ': ' + e.message); }
  }
  return { made: run.made, skipped: run.skipped, failed: run.failed.length };
}

function endIconRun() {
  var r = iconRun;
  iconRun = null;
  return r ? { made: r.made, skipped: r.skipped, failed: r.failed.slice(0, 20), failedCount: r.failed.length } : null;
}

async function findIcon(name) {
  if (LIB) return libComponent(name);   // library mode: the icon comes from the published DS
  var p = figma.root.children.filter(function (x) { return x.name === 'Icons'; })[0];
  if (!p) return null;
  await p.loadAsync();
  return p.findOne(function (n) { return n.type === 'COMPONENT' && n.name === name; });
}

/* ================= library mode =================
   A file that has the DS as a published library (and no local tokens) builds screens from it.
   Figma can only import a library asset by its key, so the DS file runs "Export library keys"
   once: every component set, component, style and variable key is saved in the plugin's
   clientStorage (per user, shared by all files). A build in the other file reads those keys. */
var LIB = null, LIB_CACHE = {};
async function libComponent(name) {
  var k = LIB.comps[name];
  if (!k) return null;
  if (!LIB_CACHE['c:' + k]) { try { LIB_CACHE['c:' + k] = await withTimeout(figma.importComponentByKeyAsync(k), 30000); } catch (e) { return null; } }
  return LIB_CACHE['c:' + k];
}
async function libSet(setName, pageName) {
  var names = (LIB.logical || {})[setName];
  if (names && names.length) {
    var got = [];
    for (var i = 0; i < names.length; i++) got.push(await libSetOne(names[i], pageName, setName));
    return names.length > 1 || (LIB.split || {})[setName] ? splitView(setName, got) : got[0];
  }
  return libSetOne(setName, pageName);
}
async function libSetOne(setName, pageName, logical) {
  var s = LIB.sets[setName];
  if (logical) setName = setName + ' (' + logical + ')';   // swing_app_bar_home (AppBar): name the part the screen asked for too
  if (!s) throw new Error(setName + ' is not in the library keys. Build the ' + pageName + ' page in the DS file, publish the library, then run Export library keys there again.');
  if (!LIB_CACHE['s:' + s.key]) {
    figma.ui.postMessage({ type: 'build-progress', set: 'Library: ' + setName, done: 0, total: 1, phase: 'variants' });
    try { LIB_CACHE['s:' + s.key] = await withTimeout(figma.importComponentSetByKeyAsync(s.key), 60000); }
    catch (e) { throw new Error(setName + ' could not be loaded from the library (' + (e.message === 'timeout' ? 'Figma did not answer in 60s' : e.message) + '). Publish the DS file, and check the library is added to this file.'); }
    figma.ui.postMessage({ type: 'build-progress', set: 'Library: ' + setName, done: 1, total: 1, phase: 'variants' });
  }
  return LIB_CACHE['s:' + s.key];
}
async function exportLibraryKeys() {
  var R = await loadRegistry();
  if (!Object.keys(R.vars).length) throw new Error('This file has no tokens, so it is not the DS file. Run Export library keys in the file that has the DS pages.');
  var out = { v: 2, file: figma.root.name, at: Date.now(), sets: {}, logical: {}, split: {}, comps: {}, vars: {}, color: {}, text: {}, effects: {}, paints: {} };
  for (var i = 0; i < figma.root.children.length; i++) {
    var pg = figma.root.children[i];
    if (/^Screen \//.test(pg.name) || UI_PARTS[pg.name]) continue;   // screens and UI components are not base library parts
    await pg.loadAsync();
    pg.findAllWithCriteria({ types: ['COMPONENT_SET'] }).forEach(function (s) {
      if (out.sets[s.name]) return;
      out.sets[s.name] = { key: s.key, page: pg.name };
      var t = setTag(s);   // swing names: the code asks for the logical part (Button) and gets every kind
      if (t.logical) { (out.logical[t.logical] = out.logical[t.logical] || []).push(s.name); if (t.prop) out.split[t.logical] = t.prop; }
    });
    pg.findAllWithCriteria({ types: ['COMPONENT'] }).forEach(function (c) {
      if (c.parent && c.parent.type === 'COMPONENT_SET') return;
      if (!out.comps[c.name]) out.comps[c.name] = c.key;
    });
  }
  // per-style typography variables ride inside the text styles, so a library file does not import them one by one
  wireKeys(R.vars).forEach(function (k) { if (/:(size|line-height|letter-spacing)$/.test(k)) return; out.vars[k] = R.vars[k].key; if (R.color[k]) out.color[k] = R.color[k]; });
  wireKeys(R.text).forEach(function (k) { out.text[k] = R.text[k].key; });
  wireKeys(R.effects).forEach(function (k) { out.effects[k] = R.effects[k].key; });
  var lps = await figma.getLocalPaintStylesAsync(), pnames = {};
  lps.forEach(function (s) { var k = (s.description || '').split('\n')[0]; if (/^--/.test(k)) out.paints[k] = s.key; pnames[s.name] = s.key; });
  wireKeys(PAINT_NAMES).forEach(function (css) { if (pnames[PAINT_NAMES[css]]) out.paints[css] = pnames[PAINT_NAMES[css]]; });
  await figma.clientStorage.setAsync('libKeys', out);
  return { file: out.file, sets: Object.keys(out.sets).length, comps: Object.keys(out.comps).length, vars: Object.keys(out.vars).length,
    styles: Object.keys(out.text).length + Object.keys(out.effects).length + Object.keys(out.paints).length };
}
// The registry (R) of a library file: imported variables and styles under the same --token keys.
// Figma fetches each one from the library, so this reports progress and gives up on an import that
// does not answer (an unpublished asset or a library that is not added can leave the promise pending).
var LIB_IMPORT_TIMEOUT = 15000;
function withTimeout(p, ms) {
  return new Promise(function (res, rej) {
    var t = setTimeout(function () { rej(new Error('timeout')); }, ms);
    p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
  });
}
async function loadLibraryRegistry(keys, report) {
  var R = { vars: {}, text: {}, effects: {}, paints: {}, missing: {}, color: keys.color || {}, pstyles: {} };
  var total = ['vars', 'text', 'effects', 'paints'].reduce(function (a, k) { return a + Object.keys(keys[k] || {}).length; }, 0);
  var done = 0, failed = 0, timedOut = 0, failedNames = [];
  if (report) report(0, total);
  async function batch(map, load, into) {
    var ks = Object.keys(map || {});
    for (var i = 0; i < ks.length; i += 20) {
      await Promise.all(ks.slice(i, i + 20).map(async function (css) {
        try { into[css] = await withTimeout(load(map[css]), LIB_IMPORT_TIMEOUT); }
        catch (e) { failed++; if (failedNames.length < 6) failedNames.push(css); if (e.message === 'timeout') timedOut++; /* not published: reported as a missing token if a part needs it */ }
        done++;
      }));
      if (report) report(done, total);
      // the first batch never answered: Figma cannot reach the library, so stop instead of waiting minutes
      if (done === Math.min(20, total) && timedOut === done) {
        throw new Error('Figma did not answer when importing from the ' + keys.file + ' library (' + (LIB_IMPORT_TIMEOUT / 1000) + 's per item). In this file open Assets > Libraries and check ' + keys.file + ' is added, and in the DS file check the library is published with its variables and styles. Then build again.');
      }
    }
  }
  await batch(keys.vars, function (k) { return figma.variables.importVariableByKeyAsync(k); }, R.vars);
  await batch(keys.text, function (k) { return figma.importStyleByKeyAsync(k); }, R.text);
  await batch(keys.effects, function (k) { return figma.importStyleByKeyAsync(k); }, R.effects);
  await batch(keys.paints, function (k) { return figma.importStyleByKeyAsync(k); }, R.pstyles);
  R.failed = failed; R.timedOut = timedOut; R.failedNames = failedNames;
  R.v = function (css) { var v = R.vars[css]; if (!v) R.missing[css] = 1; return v || null; };
  return R;
}

/* ================= components ================= */

// Find a component property by its plain name, or add it. Returns the full key ("Label#12:3").
function ensureProp(set, name, type, def, legacy) {
  var defs = set.componentPropertyDefinitions, k;
  for (k in defs) {
    if (k.split('#')[0] !== name || defs[k].type !== type) continue;
    if (defs[k].defaultValue !== def) return set.editComponentProperty(k, { defaultValue: def });   // keep the default in sync
    return k;
  }
  if (legacy) for (k in defs) {   // same property under its old name: rename it, instances keep their values
    if (k.split('#')[0] !== legacy || defs[k].type !== type) continue;
    var o = { name: name };
    if (type === 'INSTANCE_SWAP') o.defaultValue = def;
    return set.editComponentProperty(k, o);
  }
  return set.addComponentProperty(name, type, def);
}

/* ----- Swing names (Ghais 11 Nov) -----
   Every component set is named swing_<part> in snake case: Button -> swing_btn, TextField -> swing_text_field,
   Home/ProductCard -> Home/swing_product_card (the screen folder stays, it groups the Assets panel).
   A set with a kind property (type, kind or control, more than one value) is split into one set per kind:
   TextField -> swing_text_field_text, swing_text_field_password, ... The variant names inside keep the kind,
   so the code below that finds a variant by its full name keeps working, and the kind still reads in Dev Mode.
   Each set carries plugin data { logical, prop, value }: the code keeps asking for "TextField" and gets every kind.
   tone is NOT split (Ghais 13 Nov): Button, Tag, Badge, ... are one set each (swing_btn) with tone as a property,
   so a designer switches primary / neutral / danger on the instance. A file built while tone was split is merged
   back by buildSet: the first tone's set is kept and renamed, the other tones' variants move into it. */
var SWING_BASE = { Button: 'btn', IconButton: 'icon_btn', SwingLoader: 'loader', SwingPass: 'pass' };
var SPLIT_PROPS = ['type', 'kind', 'control'];
function snakeName(s) { return String(s).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase(); }
function swingBase(logical) {
  var parts = String(logical).split('/'), b = parts.pop();
  if (/^swing_/.test(b)) return logical;
  parts.push('swing_' + (SWING_BASE[b] || snakeName(b)));
  return parts.join('/');
}
function variantValue(vname, prop) {
  var kv = String(vname).split(',').map(function (s) { return s.trim().split('='); }).filter(function (p) { return p[0] === prop; })[0];
  return kv ? kv[1] : null;
}
function splitPropOf(setName, variants) {
  for (var i = 0; i < SPLIT_PROPS.length; i++) {
    var seen = {}, n = 0;
    variants.forEach(function (v) { var x = variantValue(v.name, SPLIT_PROPS[i]); if (x !== null && !seen[x]) { seen[x] = 1; n++; } });
    if (n > 1 && variants.every(function (v) { return variantValue(v.name, SPLIT_PROPS[i]) !== null; })) return SPLIT_PROPS[i];
  }
  return null;
}
function setTag(s) { try { return JSON.parse(s.getPluginData('swing') || '{}'); } catch (e) { return {}; } }
function tagSet(s, logical, prop, value) { s.setPluginData('swing', JSON.stringify({ logical: String(logical).split('/').pop(), prop: prop, value: value })); }
// The sets of one logical part, as one object: children are every variant of every kind (full names).
function splitView(logical, sets) {
  return { __split: true, logical: logical, name: swingBase(logical), sets: sets, type: 'SPLIT_VIEW',
    get children() { return [].concat.apply([], sets.map(function (s) { return s.children; })); },
    get parent() { return sets[0] && sets[0].parent; },
    get description() { return sets[0] ? sets[0].description : ''; },
    set description(d) { sets.forEach(function (s) { s.description = d; }); },
    findChild: function (f) { return this.children.filter(f)[0] || null; },
    findOne: function (f) { for (var i = 0; i < sets.length; i++) { var r = sets[i].findOne(f); if (r) return r; } return null; },
    findAll: function (f) { return [].concat.apply([], sets.map(function (s) { return s.findAll(f); })); } };
}
function firstSetOf(s) { return s && s.__split ? s.sets[0] : s; }
// Is this variant one of the part's (any of its kinds, when the part is split)?
function inPart(comp, set) { return !!comp && !!set && (set.__split ? set.sets.indexOf(comp.parent) >= 0 : comp.parent === set); }
// Find the set(s) of a logical part on a page: tagged sets first, then an untagged set built before the rename.
function findLogical(pg, logical, alt) {
  var base = String(logical).split('/').pop();
  var all = pg.findAllWithCriteria({ types: ['COMPONENT_SET'] });
  var tagged = all.filter(function (n) { return setTag(n).logical === base; });
  if (tagged.length) return tagged.length > 1 || setTag(tagged[0]).prop ? splitView(logical, tagged) : tagged[0];
  var names = [logical, swingBase(logical), base, alt].filter(Boolean);
  return all.filter(function (n) { return names.indexOf(n.name) >= 0; })[0] || null;
}

// Builds or updates a component set. Variants are matched by name, so instances
// that already use them stay linked when the set is rebuilt.
// A set with a kind property is built as one set per kind (see Swing names): the result is then a split view.
async function buildSet(page, setName, variants, buildVariant, wire, layout, R, legacySetName) {
  var prop = splitPropOf(setName, variants);
  var olds = [setName, swingBase(setName), legacySetName].filter(Boolean);
  var old = page.findOne(function (n) { return n.type === 'COMPONENT_SET' && olds.indexOf(n.name) >= 0 && !setTag(n).prop; });
  if (!prop) {
    // Built split before (swing_btn_primary, swing_btn_neutral, ...): keep the first kind's set (its property keys
    // stay, so overrides on that kind's instances stay), move every other kind's variants into it, drop the empty sets.
    // The component nodes move, so every placed instance stays linked.
    var base = String(setName).split('/').pop();
    var splits = old ? [] : page.findAllWithCriteria({ types: ['COMPONENT_SET'] })
      .filter(function (n) { var t = setTag(n); return t.logical === base && !!t.prop; });
    var keep = old || splits[0] || null;
    var from = splits.length > 1 ? splitView(setName, splits) : keep;
    var r1 = await buildOneSet(page, swingBase(setName), variants, buildVariant, R, keep, from, setName);
    splits.forEach(function (s) { try { if (s !== r1.set && !s.removed && !s.children.length) s.remove(); } catch (e) { /* Figma removed it */ } });
    tagSet(r1.set, setName, null, null);
    wireIn(r1.set, wire, layout, r1.comps);
    return r1.set;
  }
  var order = [], by = {};
  variants.forEach(function (v) { var x = variantValue(v.name, prop); if (!by[x]) { by[x] = []; order.push(x); } by[x].push(v); });
  var sets = [];
  for (var g = 0; g < order.length; g++) {
    var name = swingBase(setName) + '_' + snakeName(order[g]);
    var mine = page.findOne(function (n) { return n.type === 'COMPONENT_SET' && (n.name === name || (setTag(n).logical === String(setName).split('/').pop() && setTag(n).value === order[g])); });
    // the first kind keeps the set from before the split (renamed): its property keys stay, so overrides on placed instances of that kind stay
    var reuse = !mine && g === 0 && old ? old : null;
    var r = await buildOneSet(page, name, by[order[g]], buildVariant, R, mine || reuse, mine || old, name);
    tagSet(r.set, setName, prop, order[g]);
    wireIn(r.set, wire, layout, r.comps);   // wire only reaches the variants of this set (wireKeys)
    sets.push(r.set);
  }
  // the set from before the split, when it was not reused: every variant moved out, so it is empty now (Figma may already have removed it)
  try { if (old && sets.indexOf(old) < 0 && !old.removed && !old.children.length) old.remove(); } catch (e) { /* already gone */ }
  return splitView(setName, sets);
}
// One set. `set` is this set when it exists already; `from` is where existing variants are looked up
// (this set on an update, the set from before the split the first time a part is split).
async function buildOneSet(page, setName, variants, buildVariant, R, set, from, label) {
  if (set) set.name = setName;
  var comps = [], lastPost = 0;
  function progress(done, phase) {
    var now = Date.now();
    if (phase !== 'variants' || done === variants.length || now - lastPost > 60) {
      lastPost = now;
      figma.ui.postMessage({ type: 'build-progress', set: label || setName, done: done, total: variants.length, phase: phase });
    }
  }
  progress(0, 'variants');
  for (var i = 0; i < variants.length; i++) {
    var vname = variants[i].name, oldName = variants[i].legacy;
    var comp = from && (from.findChild(function (c) { return c.name === vname; }) || (oldName && from.findChild(function (c) { return c.name === oldName; })));
    if (comp) {
      comp.name = vname; comp.children.slice().forEach(function (c) { c.remove(); });
      // From another set (a split or a merge): move the node straight into this set when it exists, so the set it
      // came from or this one never goes empty mid-build (Figma deletes an empty set). The node stays, so instances stay linked.
      if (from !== set && comp.parent !== set) { if (set) set.appendChild(comp); else page.appendChild(comp); }
    } else { comp = figma.createComponent(); page.appendChild(comp); comp.name = vname; }
    await buildVariant(comp, variants[i]);
    comps.push(comp);
    progress(i + 1, 'variants');
  }
  progress(variants.length, 'artboard');
  if (!set) {
    set = figma.combineAsVariants(comps, page);
    set.name = setName;
    var others = page.children.filter(function (n) { return n !== set; });
    set.x = 0;
    set.y = others.reduce(function (y, n) { return Math.max(y, n.y + n.height + 160); }, 0);
  } else {
    comps.forEach(function (c) { if (c.parent !== set) set.appendChild(c); });
  }
  // Layer order = the order of the values in the instance panel's dropdowns (Figma lists a property's
  // values in the order its variants come in the set). An update keeps the old order and appends new
  // variants at the end (l, m, s, xl, xs), so put the children back in the order the variants are listed.
  comps.forEach(function (c, i) { if (set.children[i] !== c) set.insertChild(i, c); });
  if (R) set.fills = paintFor(R, '--color-bg-subtle');
  return { set: set, comps: comps };
}
// While a set is being wired (WIRE_SET), wireKeys skips map entries whose node sits in ANOTHER component set:
// a split part calls wire once per kind, and a property can only be bound inside its own set.
// Outside wire (WIRE_SET null) it is exactly Object.keys.
var WIRE_SET = null;
function wireKeys(map) {
  var ks = Object.keys(map);
  if (!WIRE_SET) return ks;
  function firstNode(e) {
    if (!e || typeof e !== 'object') return null;
    if (e.type && 'parent' in e) return e;
    if (Array.isArray(e)) return e.length && e[0] && typeof e[0] === 'object' && e[0].type && 'parent' in e[0] ? e[0] : null;
    for (var k in e) { var x = e[k]; if (x && typeof x === 'object' && x.type && 'parent' in x) return x; }
    return null;
  }
  function elsewhere(n) { for (var p = n; p; p = p.parent) { if (p === WIRE_SET) return false; if (p.type === 'COMPONENT_SET') return true; } return false; }
  return ks.filter(function (k) { var n = firstNode(map[k]); return !n || !elsewhere(n); });
}
function wireIn(set, wire, layout, comps) { WIRE_SET = set; try { wire(set, comps); layout(set, comps); } finally { WIRE_SET = null; } }

// A failed build can leave variant components loose on whatever page was open.
// Remove those (only loose ones matching this set's variant names, and only if nothing uses them).
async function removeOrphans(variants, notes) {
  var names = {}, removed = 0;
  variants.forEach(function (v) { names[v.name] = 1; if (v.legacy) names[v.legacy] = 1; });
  for (var i = 0; i < figma.root.children.length; i++) {
    var pg = figma.root.children[i];
    await pg.loadAsync();
    var loose = pg.findAll(function (n) { return n.type === 'COMPONENT' && names[n.name] && (!n.parent || n.parent.type !== 'COMPONENT_SET'); });
    for (var k = 0; k < loose.length; k++) {
      var used = await loose[k].getInstancesAsync();
      if (!used.length) { loose[k].remove(); removed++; }
    }
  }
  if (removed) notes.push('Cleaned up ' + removed + ' loose variants left by an earlier failed build.');
}

/* ----- documentation artboard around a component set -----
   A component set may only contain components, so labels live in a frame around it.
   spec = { title, description,
            colGroups: [{ label, cols: [label, ...] }],   e.g. Large · 48 -> Default Pressed Disabled
            rowGroups: [{ label, rows: [label, ...] }],   e.g. Primary -> Solid Soft Ghost Tertiary
            place: function (variant) -> { cg, c, rg, r } }                                       */
async function makeText(R, styleCss, colorCss, chars, parent) {
  var t = figma.createText(), st = R.text[styleCss];
  if (st) { await figma.loadFontAsync(st.fontName); await t.setTextStyleIdAsync(st.id); }
  else { R.missing[styleCss] = 1; await figma.loadFontAsync(t.fontName); }
  t.characters = chars;
  t.fills = paintFor(R, colorCss);
  t.textAutoResize = 'WIDTH_AND_HEIGHT';
  parent.appendChild(t);
  return t;
}

async function docArtboard(R, page, set, comps, variants, spec) {
  if (!set.__split) {
    // Merged back from a split (tone, 13 Nov): the kept set still sits in its kind's artboard (swing_btn_primary).
    // Reuse that frame for the one set, then drop the other kinds' artboards once they hold no set.
    var home = set.parent && set.parent.type === 'FRAME' && set.parent.parent === page && set.parent.name !== set.name ? set.parent : null;
    if (home && !page.findChild(function (n) { return n.type === 'FRAME' && n.name === set.name; })) home.name = set.name;
    var one = await docArtboardOne(R, page, set, comps, variants, Object.assign({}, spec, { title: set.name || spec.title, oldTitle: spec.title }));
    page.findChildren(function (n) { return n.type === 'FRAME' && n.name.indexOf(set.name + '_') === 0; }).forEach(function (f) {
      if (!f.findOne(function (n) { return n.type === 'COMPONENT_SET'; })) f.remove();
    });
    return one;
  }
  var res = null;
  for (var si = 0; si < set.sets.length; si++) {
    var s = set.sets[si], cs = [], vs = [];
    comps.forEach(function (c, i) { if (c.parent === s) { cs.push(c); vs.push(variants[i]); } });
    if (!cs.length) continue;
    // only the row and column groups this kind uses, renumbered
    var P0 = vs.map(function (v) { return spec.place(v); });
    var cgs = [], rgs = [], cols = {}, rows = {};
    P0.forEach(function (p) {
      if (cgs.indexOf(p.cg) < 0) cgs.push(p.cg);
      if (rgs.indexOf(p.rg) < 0) rgs.push(p.rg);
      (cols[p.cg] = cols[p.cg] || []).indexOf(p.c) < 0 && cols[p.cg].push(p.c);
      (rows[p.rg] = rows[p.rg] || []).indexOf(p.r) < 0 && rows[p.rg].push(p.r);
    });
    var num = function (a, b) { return a - b; };
    cgs.sort(num); rgs.sort(num); wireKeys(cols).forEach(function (k) { cols[k].sort(num); }); wireKeys(rows).forEach(function (k) { rows[k].sort(num); });
    var sub = Object.assign({}, spec, {
      title: s.name, legacyTitle: null,
      colGroups: cgs.map(function (g) { return { label: spec.colGroups[g].label, cols: cols[g].map(function (c) { return spec.colGroups[g].cols[c]; }) }; }),
      rowGroups: rgs.map(function (g) { return { label: spec.rowGroups[g].label, rows: rows[g].map(function (r) { return spec.rowGroups[g].rows[r]; }) }; }),
      place: function (v) { var p = spec.place(v); return { cg: cgs.indexOf(p.cg), c: cols[p.cg].indexOf(p.c), rg: rgs.indexOf(p.rg), r: rows[p.rg].indexOf(p.r) }; }
    });
    if (spec.examples) sub.examples = spec.examples.map(function (E) { return Object.assign({}, E, { items: E.items.filter(function (it) { return s.children.some(function (c) { return c.name === it.variant; }); }) }); }).filter(function (E) { return E.items.length; });
    res = await docArtboardOne(R, page, s, cs, vs, sub);
  }
  // the artboard from before the split held the one set: drop it once it holds no set
  page.findChildren(function (n) { return n.type === 'FRAME' && (n.name === spec.title || n.name === spec.legacyTitle); }).forEach(function (f) {
    if (!f.findOne(function (n) { return n.type === 'COMPONENT_SET'; })) f.remove();
  });
  return res;
}
async function docArtboardOne(R, page, set, comps, variants, spec) {
  var P = 64, LABEL_W = 176, CELL_GAP = 24, GROUP_GAP_X = 56, ROW_GAP = 16, GROUP_BAND = 40, GROUP_GAP_Y = 40, SET_PAD = 24;

  var frame = page.findChild(function (n) { return n.type === 'FRAME' && (n.name === spec.title || (spec.legacyTitle && n.name === spec.legacyTitle) || (spec.oldTitle && n.name === spec.oldTitle)); });
  if (frame) frame.name = spec.title;
  if (!frame) {
    frame = figma.createFrame();
    page.appendChild(frame);
    frame.name = spec.title;
    var others = page.children.filter(function (n) { return n !== frame && n !== set && n.type === 'FRAME'; });
    frame.x = 0;
    frame.y = others.reduce(function (y, n) { return Math.max(y, n.y + n.height + 160); }, 0);
  }
  frame.children.slice().forEach(function (n) { if (n !== set) n.remove(); });   // labels are rebuilt each time
  frame.layoutMode = 'NONE';
  frame.clipsContent = false;
  frame.fills = paintFor(R, '--color-bg-subtle');
  frame.appendChild(set);
  set.fills = [];

  // header
  var title = await makeText(R, '--type-h3', '--color-text', spec.title, frame);
  title.x = P; title.y = P;
  var desc = await makeText(R, '--type-b2', '--color-text-secondary', spec.description, frame);
  desc.textAutoResize = 'HEIGHT';
  desc.resize(640, desc.height);
  desc.x = P; desc.y = title.y + title.height + 8;
  var below = desc;
  for (var ci = 0; ci < (spec.code || []).length; ci++) {
    var cl0 = await makeText(R, ci ? '--type-b3' : '--type-b2s', ci ? '--color-text-muted' : '--color-text', spec.code[ci], frame);
    cl0.textAutoResize = 'HEIGHT';
    cl0.resize(860, cl0.height);
    cl0.x = P; cl0.y = below.y + below.height + (ci ? 4 : 16);
    below = cl0;
  }

  // column widths: widest variant in each column
  var colW = {}, rowH = 0;
  comps.forEach(function (c, i) {
    var p = spec.place(variants[i]), k = p.cg + ':' + p.c;
    colW[k] = Math.max(colW[k] || 0, c.width, spec.minCell || 0);   // tiny parts (dots, stars) get a readable cell
    rowH = Math.max(rowH, c.height, spec.minRow || 0);
  });

  var headTop = below.y + below.height + 48, gridLeft = P + LABEL_W, colX = {}, x = 0;
  for (var g = 0; g < spec.colGroups.length; g++) {
    if (g) x += GROUP_GAP_X;
    var gx = x;
    for (var c = 0; c < spec.colGroups[g].cols.length; c++) {
      colX[g + ':' + c] = x;
      x += (colW[g + ':' + c] || 0) + (c < spec.colGroups[g].cols.length - 1 ? CELL_GAP : 0);
    }
    var gl = await makeText(R, '--type-lbl-l', '--color-text', spec.colGroups[g].label, frame);
    gl.x = gridLeft + SET_PAD + gx; gl.y = headTop;
    for (c = 0; c < spec.colGroups[g].cols.length; c++) {
      var cl = await makeText(R, '--type-b3', '--color-text-muted', spec.colGroups[g].cols[c], frame);
      cl.x = gridLeft + SET_PAD + colX[g + ':' + c]; cl.y = headTop + gl.height + 8;
    }
  }
  var gridW = x;
  var gridTop = headTop + 64;

  // rows: a label band per group, then one row per item
  var rowY = {}, y = 0, dividers = [];
  for (g = 0; g < spec.rowGroups.length; g++) {
    if (g) { y += GROUP_GAP_Y; dividers.push(y - GROUP_GAP_Y / 2); }
    var band = await makeText(R, '--type-lbl-l', '--color-text', spec.rowGroups[g].label, frame);
    band.x = P; band.y = gridTop + SET_PAD + y;
    y += GROUP_BAND;
    for (var r = 0; r < spec.rowGroups[g].rows.length; r++) {
      rowY[g + ':' + r] = y;
      var rl = await makeText(R, '--type-b2', '--color-text-secondary', spec.rowGroups[g].rows[r], frame);
      rl.x = P; rl.y = gridTop + SET_PAD + y + (rowH - rl.height) / 2;
      y += rowH + (r < spec.rowGroups[g].rows.length - 1 ? ROW_GAP : 0);
    }
  }
  var gridH = y;

  // variants inside the set
  comps.forEach(function (comp, i) {
    var p = spec.place(variants[i]);
    comp.x = SET_PAD + colX[p.cg + ':' + p.c] + (spec.center ? (colW[p.cg + ':' + p.c] - comp.width) / 2 : 0);
    comp.y = SET_PAD + rowY[p.rg + ':' + p.r] + (rowH - comp.height) / 2;
  });
  set.x = gridLeft; set.y = gridTop;
  set.resizeWithoutConstraints(gridW + SET_PAD * 2, gridH + SET_PAD * 2);

  // on-media variants are white: draw a dark backdrop behind them, on the artboard (not in the component)
  if (spec.backdrop) comps.forEach(function (comp, i) {
    var css = spec.backdrop(variants[i]);
    if (!css) return;
    var bd = figma.createRectangle();
    frame.insertChild(Math.max(0, frame.children.indexOf(set)), bd);
    bd.name = 'Backdrop';
    var cw = spec.center ? colW[spec.place(variants[i]).cg + ':' + spec.place(variants[i]).c] : comp.width, ch = spec.center ? rowH : comp.height;
    bd.resize(cw + 12, ch + 12);   // the cell plus 6, so neighbours never touch (gaps are 16 and 24)
    bd.x = set.x + comp.x - (cw - comp.width) / 2 - 6; bd.y = set.y + comp.y - (ch - comp.height) / 2 - 6;
    bd.cornerRadius = 8;
    bd.fills = paintFor(R, css);
  });

  // hairline between row groups, across labels and grid
  var fullW = gridLeft + gridW + SET_PAD * 2 - P;
  dividers.forEach(function (dy) {
    var line = figma.createRectangle();
    frame.appendChild(line);
    line.name = 'Divider';
    line.resize(fullW, 1);
    line.x = P; line.y = gridTop + SET_PAD + dy;
    line.fills = paintFor(R, '--color-line');
  });

  var bottom = gridTop + gridH + SET_PAD * 2, right = gridLeft + gridW + SET_PAD * 2;
  if (spec.examples && spec.examples.length) {   // [{label, items:[{variant, props}]}], like the cases on the web doc
    var exTop = bottom + 56;
    var exHead = await makeText(R, '--type-lbl-l', '--color-text', 'examples', frame);
    exHead.x = P; exHead.y = exTop;
    var ex = gridLeft + SET_PAD;
    for (var ei = 0; ei < spec.examples.length; ei++) {
      var E = spec.examples[ei];
      var el = await makeText(R, '--type-b3', '--color-text-muted', E.label, frame);
      el.x = ex; el.y = exTop;
      var iy = exTop + el.height + 8, ew = el.width;
      for (var ii = 0; ii < E.items.length; ii++) {
        var main = set.children.find(function (c) { return c.name === E.items[ii].variant; });
        if (!main) continue;
        var inst = main.createInstance();
        frame.appendChild(inst);
        inst.name = spec.title;
        if (E.items[ii].props) { try { inst.setProperties(propsFor(inst, E.items[ii].props)); } catch (e) { /* keep defaults */ } }
        inst.x = ex; inst.y = iy;
        iy += inst.height + 16; ew = Math.max(ew, inst.width);
      }
      bottom = Math.max(bottom, iy - 16);
      ex += ew + 56;
    }
    right = Math.max(right, ex - 56);
  }
  frame.resizeWithoutConstraints(Math.max(right, below.x + below.width, desc.x + desc.width) + P, bottom + P);
  restackArtboards(page);
  return frame;
}

// An artboard that grew must not run into the one below: push later artboards down, keep a 160 gap.
function restackArtboards(page) {
  var GAP = 160;
  var frames = page.children.filter(function (n) { return n.type === 'FRAME'; })
    .sort(function (a, b) { return a.y - b.y; });
  for (var i = 1; i < frames.length; i++) {
    var f = frames[i];
    for (var j = 0; j < i; j++) {
      var o = frames[j];
      var sideBySide = f.x >= o.x + o.width || o.x >= f.x + f.width;
      if (!sideBySide && f.y < o.y + o.height + GAP) f.y = o.y + o.height + GAP;
    }
  }
}

function gridLayout(set, comps, colOf, rowOf, cellW, cellH) {
  var pad = 40, maxX = 0, maxY = 0;
  comps.forEach(function (c, i) {
    c.x = pad + colOf(i) * cellW;
    c.y = pad + rowOf(i) * cellH;
    maxX = Math.max(maxX, c.x + c.width);
    maxY = Math.max(maxY, c.y + c.height);
  });
  set.resizeWithoutConstraints(maxX + pad, maxY + pad);
}

/* ----- Naming: Figma = code -----
   Component  = the component name a developer writes (Button, IconButton, SlideConfirm, SwingLoader).
   Property   = the prop name (size, tone, appearance, state, label, iconStart ...).
   Value      = the CSS modifier without the prefix (size m -> .btn--m, tone danger -> .btn--danger).
   Old Title Case names from earlier builds are renamed in place (`legacy`), so instances stay linked. */

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/* ----- Button (components.css: .btn, appearance, tone, size, disabled, success, tertiary) ----- */

var BTN_TONES = {
  primary: { solid: ['--purple-500', '--purple-600', '--light-100'], soft: ['--purple-50', '--purple-100', '--purple-100', '--purple-600'],
    ghost: ['--purple-600', '--purple-50'], tertiary: ['--light-300', '--light-500', '--purple-500'] },
  neutral: { solid: ['--dark-500', '--dark-400', '--light-100'], soft: ['--light-300', '--light-500', '--light-500', '--dark-500'],
    ghost: ['--dark-500', '--light-300'], tertiary: ['--light-200', '--light-300', '--dark-300'] },
  danger: { solid: ['--red-700', '--red-press', '--light-100'], soft: ['--red-50', '--red-100', '--red-100', '--red-700'],
    ghost: ['--red-700', '--red-50'], tertiary: ['--light-300', '--light-500', '--red-500'] },   // tertiary = .btn--tertiary.btn--danger (QRIS: Cancel payment)
  // .btn--success: the success token (green-500), pressed green-600 (Ghais' rule 09 Nov)
  success: { solid: ['--color-success', '--green-600', '--light-100'] },
  // ADS Swing Pass (components.css .btn--glass on the pass band, .btn--pass gradient): solid only, sizes l and s
  glass: { solid: ['GRAD:--glass-fill', 'GRAD:--glass-fill', '--light-100', '--glass-line'], sizes: ['l', 's'] },
  pass: { solid: ['GRAD:--gradient-swing-pass', 'GRAD:--gradient-swing-pass', '--light-100'], sizes: ['l', 's'] },
  // .btn--tertiary.btn--muted (event details: fact sheet, maps, sponsor links)
  muted: { tertiary: ['--light-300', '--light-500', '--dark-300'], sizes: ['s'] },
  // .btn--glow (ADS 2.0 GlassButton 60:14959, Ghais 11 Nov): glass + a 1.5px glow ring that Figma Motion turns.
  // glow = white spot over the glass line, white label; glowPurple = purple sweep, no glass line, dark label (light backgrounds).
  // Only in size glow, and Button only (an icon-only glow button is not in the design).
  glow: { solid: ['GRAD:--glass-fill', 'GRAD:--glass-fill', '--light-100', '--glass-line'], sizes: ['glow'], glow: 'white', noIcon: true },
  glowPurple: { solid: ['GRAD:--glass-fill', 'GRAD:--glass-fill', '--dark-500'], sizes: ['glow'], glow: 'purple', noIcon: true }
};
// BTN_SIZE_ORDER = variant order in the set (the size dropdown) and the artboard columns. The default instance
// is the top-left variant on the artboard (xl), not the first key here.
// py = top/bottom padding from the spacing tokens (multiples of 4). The height hugs padding + label line height
// with h as min height (the web's height): xl 16 + 20 + 16 = 52 -> 56, s 8 + 14 + 8 = 30 -> 32. Ghais 13 Nov.
// h is also minWidth, the artboard labels and the hug check in buildVariant.
var BTN_SIZES = {
  l: { legacy: 'Large', h: 48, px: ['--space-24', 24], ghostPx: ['--space-12', 12], py: ['--space-12', 12], gap: ['--gap-related', 8], type: '--type-cta-l', icon: 20, cls: '' },
  m: { legacy: 'Medium', h: 40, px: ['--space-16', 16], ghostPx: ['--space-8', 8], py: ['--space-8', 8], gap: ['--gap-related', 8], type: '--type-cta-l', icon: 20, cls: 'btn--m' },
  s: { legacy: 'Small', h: 32, px: ['--space-12', 12], ghostPx: ['--space-8', 8], py: ['--space-8', 8], gap: ['--gap-tight', 4], type: '--type-cta-s', icon: 16, cls: 'btn--s' },
  xl: { legacy: 'Extra large', h: 56, px: ['--space-32', 32], ghostPx: ['--space-16', 16], py: ['--space-16', 16], gap: ['--gap-related', 8], type: '--type-cta-l', icon: 24, cls: 'btn--xl' },
  xs: { legacy: 'Extra small', h: 24, px: ['--space-8', 8], ghostPx: ['--space-8', 8], py: ['--space-4', 4], gap: ['--gap-tight', 4], type: '--type-cta-s', icon: 16, cls: 'btn--xs' },
  // .btn--glow: padding 12 16 from the spacing tokens, height hugs (12 + 20 + 12 = 44), radius 12, CTA M 14/20. Glow tones only.
  glow: { legacy: 'Glow', h: 44, px: ['--space-16', 16], ghostPx: ['--space-16', 16], py: ['--space-12', 12], gap: ['--space-8', 8], type: '--type-cta-m', icon: 16, cls: 'btn--glow',
    radius: ['--radius-12', 12], tones: ['glow', 'glowPurple'] }
};
var BTN_SIZE_ORDER = ['xl', 'l', 'm', 's', 'xs', 'glow'];
var BTN_APPEAR = ['solid', 'soft', 'ghost', 'tertiary'];
var BTN_STATES = ['default', 'pressed', 'disabled', 'loading'];
var ICON_BTN_STATES = ['default', 'pressed', 'disabled'];

function btnColors(tone, appear, state) {
  if (state === 'loading') state = 'default';   // DS: loading keeps the tone colour and the width
  var t = BTN_TONES[tone], bg, fg, ring = null, pressed = state === 'pressed';
  if (appear === 'solid') { bg = pressed ? t.solid[1] : t.solid[0]; fg = t.solid[2]; ring = t.solid[3] || null; }
  else if (appear === 'soft') { bg = pressed ? t.soft[1] : t.soft[0]; ring = t.soft[2]; fg = t.soft[3]; }
  else if (appear === 'ghost') { bg = pressed ? t.ghost[1] : null; fg = t.ghost[0]; }
  else { bg = pressed ? t.tertiary[1] : t.tertiary[0]; fg = t.tertiary[2]; }
  if (state === 'disabled') { bg = appear === 'ghost' ? null : '--light-300'; fg = '--dark-200'; ring = null; }
  if (typeof bg === 'string' && bg.indexOf('MIX:') === 0) {
    var p = bg.slice(4).split(',');
    bg = colorMix('in srgb, ' + p[0] + ' 84%, ' + p[1]);
  }
  return { bg: bg, fg: fg, ring: ring };
}

function buttonVariants(states, isIcon) {
  var out = [];
  wireKeys(BTN_TONES).forEach(function (tone) {
    if (isIcon && BTN_TONES[tone].noIcon) return;
    BTN_APPEAR.forEach(function (appear) {
      if (!BTN_TONES[tone][appear]) return;
      BTN_SIZE_ORDER.forEach(function (size) {   // xl > l > m > s > xs > glow: the size dropdown reads big to small
        if (BTN_TONES[tone].sizes && BTN_TONES[tone].sizes.indexOf(size) < 0) return;
        if (BTN_SIZES[size].tones && BTN_SIZES[size].tones.indexOf(tone) < 0) return;
        states.forEach(function (state) {
          out.push({ size: size, tone: tone, appear: appear, state: state,
            name: 'size=' + size + ', tone=' + tone + ', appearance=' + appear + ', state=' + state,
            legacy: 'Size=' + BTN_SIZES[size].legacy + ', Tone=' + cap(tone) + ', Appearance=' + cap(appear) + ', State=' + cap(state) });
        });
      });
    });
  });
  return out;
}

async function placeholderIcon(page) {
  var icon = page.findOne(function (n) { return n.type === 'COMPONENT' && n.name === 'Icon/Placeholder'; });
  if (icon) return icon;
  icon = figma.createComponent();
  page.appendChild(icon);
  icon.name = 'Icon/Placeholder';
  icon.resizeWithoutConstraints(24, 24);
  var dot = figma.createEllipse();
  icon.appendChild(dot);
  dot.name = 'Icon';
  dot.resize(16, 16); dot.x = 4; dot.y = 4;
  dot.constraints = { horizontal: 'SCALE', vertical: 'SCALE' };
  icon.x = -80;
  return icon;
}

async function iconOrPlaceholder(name, page, notes) {
  var ic = await findIcon(name);
  if (ic) return ic;
  var msg = LIB
    ? 'Icon not in the ' + LIB.file + ' library (' + name + '), so a grey placeholder is used. In the DS file import that icon, publish, run Export library keys, then build again.'
    : 'Some icons are not imported yet (' + name + '), so a placeholder is used. Import icons, then build again.';
  if (notes.indexOf(msg) < 0) notes.push(msg);
  return placeholderIcon(page);
}

// set.children -> matching variant specs, in the same order
function pairUp(set, variants, ok) {
  var comps = set.children.filter(function (c) { return ok(c); });
  return { comps: comps, vs: comps.map(function (c) { return variants.filter(function (v) { return v.name === c.name; })[0]; }) };
}

function recolorIcon(R, inst, colorCss) {
  var shape = inst.findOne(function (n) { return n.name === 'Icon'; });
  if (shape) shape.fills = paintFor(R, colorCss);
}

async function styledText(R, styleCss, colorCss, chars) {
  var t = figma.createText(), st = R.text[styleCss];
  if (st) { await figma.loadFontAsync(st.fontName); await t.setTextStyleIdAsync(st.id); }
  else { R.missing[styleCss] = 1; await figma.loadFontAsync(t.fontName); }
  t.characters = chars;
  t.fills = paintFor(R, colorCss);
  return t;
}

/* ----- SwingLoader (components.css .swing-loader): static mark, the web version animates ----- */
var SL_LINE = 'M136.3 363.7L363.8 136.2', SL_ARC = 'M143.34 211.18A113.5 113.5 0 1 1 286.95 357.32';
var SL_SIZES = [16, 24, 48, 96];

async function buildLoader(R, notes) {
  var page = await pageNamed('Loading');
  var variants = SL_SIZES.map(function (s) { return { size: s, name: 'size=' + s, legacy: 'Size=' + s }; });
  async function buildVariant(comp, v) {
    var s = v.size;
    comp.layoutMode = 'NONE';
    comp.resizeWithoutConstraints(s, s);
    comp.fills = [];
    comp.clipsContent = false;
    var stroke = ' stroke="#5C00E6" stroke-width="29" stroke-linecap="round"';
    var f = figma.createNodeFromSvg('<svg width="' + s + '" height="' + s + '" viewBox="112 112 276 276" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="' + SL_LINE + '"' + stroke + '/><path d="' + SL_ARC + '"' + stroke + '/></svg>');
    page.appendChild(f);
    f.children.slice().forEach(function (n, i) {
      comp.appendChild(n);
      n.name = i ? 'arc' : 'line';
      n.constraints = { horizontal: 'SCALE', vertical: 'SCALE' };
      n.fills = [];
      n.strokes = paintFor(R, '--color-primary');
    });
    f.remove();
  }
  function wire(set) {
    set.description = '<span class="swing_loader swing_loader_{size}">. Static mark: on the web the club line is drawn, the arc follows, then both lift off. ' +
      'The colour is the stroke: primary by default, light-100 on purple, dark or Swing Pass (.swing_loader_inverse).';
  }
  var set = await buildSet(page, 'SwingLoader', variants, buildVariant, wire, function () {}, R, 'Swing loader');
  var pv = pairUp(set, variants, function (c) { return /^size=\d+$/.test(c.name); });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'SwingLoader', legacyTitle: 'Swing loader',
    description: 'The Swing mark used for every wait. 24 inside buttons (16 in size s), 48 for in-page loading, 96 for full screens.',
    code: ['<span class="swing_loader swing_loader_24" role="status" aria-label="Loading">',
      'size 48 = default (no class) · 24 = .swing_loader_24 · 96 = .swing_loader_96 · 16 = inside .swing_btn_s'],
    colGroups: [{ label: 'size', cols: SL_SIZES.map(String) }],
    rowGroups: [{ label: 'color', rows: ['primary'] }],
    place: function (v) { return { cg: 0, c: SL_SIZES.indexOf(v.size), rg: 0, r: 0 }; }
  });
  var by = {};
  set.children.forEach(function (c) { by[c.name] = c; });
  return { set: set, count: variants.length, bySize: function (s) { return by['size=' + s]; } };
}

/* ----- Button + IconButton ----- */
/* The glow ring of Button size=glow (ADS 2.0 GlassButton 60:14959, as Ghais fixed it 11 Nov).
   "glow" = a frame exactly the button's size (taken after auto layout sized it; constraints set last, so
   every margin is 0) holding an alpha mask "ring" (1.5px inside stroke, radius 12) and "sheen" above it.
   white:  sheen = 320 square, angular gradient transparent > white spot > transparent.
   purple: sheen = 276 x 161, linear top to bottom, Purple 500 at 0% opacity from 25% to Purple 500.
   Figma Motion turns "sheen": rotation 0 at 0 ms to -360 at 2000 ms, ease in-out (0.5, 0, 0.5, 1), Loop.
   The plugin cannot write keyframes, so they are added in Motion after a build. */
function glowRing(R, comp, kind, radius) {
  var rc = radius ? radius[0] : '--radius-12', rv = radius ? radius[1] : 12;
  var w = comp.width, h = comp.height;
  var ring = figma.createFrame(); comp.appendChild(ring); ring.name = 'glow';
  ring.layoutPositioning = 'ABSOLUTE'; ring.resize(w, h); ring.x = 0; ring.y = 0;
  ring.fills = []; ring.clipsContent = true; bindRadius(R, ring, rc, rv);
  var mask = figma.createRectangle(); ring.appendChild(mask); mask.name = 'ring';
  mask.resize(w, h); mask.x = 0; mask.y = 0; bindRadius(R, mask, rc, rv);
  mask.fills = []; mask.strokes = [solid({ r: 1, g: 1, b: 1, a: 1 })]; mask.strokeWeight = 1.5; mask.strokeAlign = 'INSIDE';
  mask.isMask = true; try { mask.maskType = 'ALPHA'; } catch (e) { /* older API: alpha is the default */ }
  var sh = figma.createRectangle(); ring.appendChild(sh); sh.name = 'sheen';
  if (kind === 'purple') {
    var P = R.color['--purple-500'] || { r: 0x5C / 255, g: 0, b: 0xE6 / 255, a: 1 };
    sh.resize(276, 161); sh.x = (w - 276) / 2 + 2.5; sh.y = (h - 161) / 2 - 0.5;
    sh.fills = [{ type: 'GRADIENT_LINEAR', gradientTransform: [[0, 1, 0], [-1, 0, 1]],
      gradientStops: [{ position: 0.25, color: { r: P.r, g: P.g, b: P.b, a: 0 } }, { position: 1, color: { r: P.r, g: P.g, b: P.b, a: 1 } }] }];
  } else {
    var W = function (a) { return { r: 1, g: 1, b: 1, a: a }; };
    sh.resize(320, 320); sh.x = (w - 320) / 2; sh.y = (h - 320) / 2;
    sh.fills = [{ type: 'GRADIENT_ANGULAR', gradientTransform: [[1, 0, 0], [0, 1, 0]],
      gradientStops: [{ position: 0, color: W(0) }, { position: 0.55, color: W(0) }, { position: 0.8, color: W(1) }, { position: 0.86, color: W(0.9) }, { position: 1, color: W(0) }] }];
  }
  mask.constraints = { horizontal: 'STRETCH', vertical: 'STRETCH' };
  sh.constraints = { horizontal: 'CENTER', vertical: 'CENTER' };
  ring.constraints = { horizontal: 'STRETCH', vertical: 'STRETCH' };
  return ring;
}

async function buildButtonSet(R, notes, page, kind, icons, loader) {
  var isIcon = kind === 'icon', setName = isIcon ? 'IconButton' : 'Button';
  var states = isIcon ? ICON_BTN_STATES : BTN_STATES;
  var variants = buttonVariants(states, isIcon);
  var parts = {};

  async function buildVariant(comp, v) {
    var S = BTN_SIZES[v.size], col = btnColors(v.tone, v.appear, v.state);
    comp.layoutMode = 'HORIZONTAL';
    comp.primaryAxisAlignItems = 'CENTER';
    comp.counterAxisAlignItems = 'CENTER';
    comp.resize(isIcon ? S.h : Math.max(comp.width, S.h), S.h);
    comp.layoutSizingHorizontal = isIcon ? 'FIXED' : 'HUG';
    // Button hugs its height: top/bottom padding from the spacing tokens (S.py). IconButton stays a fixed square.
    // Set after resize(), which puts both sizing modes back to FIXED.
    var hugH = !isIcon && !!S.py;
    comp.layoutSizingVertical = hugH ? 'HUG' : 'FIXED';
    comp.minWidth = S.h;
    if (hugH) comp.minHeight = S.h; else comp.minHeight = null;   // hug, but never shorter than the web's height
    comp.paddingTop = 0; comp.paddingBottom = 0;
    if (hugH) { bindNumber(R, comp, 'paddingTop', S.py[0], S.py[1]); bindNumber(R, comp, 'paddingBottom', S.py[0], S.py[1]); }
    if (isIcon) { comp.paddingLeft = 0; comp.paddingRight = 0; comp.itemSpacing = 0; }   // .btn--icon: padding 0, width = height
    else {
      var px = v.appear === 'ghost' ? S.ghostPx : S.px;
      if (px[0]) { bindNumber(R, comp, 'paddingLeft', px[0], px[1]); bindNumber(R, comp, 'paddingRight', px[0], px[1]); }
      else { comp.paddingLeft = px[1]; comp.paddingRight = px[1]; }   // no DS step for this value
      bindNumber(R, comp, 'itemSpacing', S.gap[0], S.gap[1]);
    }
    bindRadius(R, comp, S.radius ? S.radius[0] : '--radius-8', S.radius ? S.radius[1] : 8);
    if (typeof col.bg === 'string' && col.bg.indexOf('GRAD:') === 0) await fillStyle(R, comp, col.bg.slice(5), '--purple-500');
    else comp.fills = paintFor(R, col.bg);
    comp.strokes = col.ring ? paintFor(R, col.ring) : [];
    comp.strokeWeight = 1;
    comp.strokeAlign = 'INSIDE';
    comp.clipsContent = false;

    function iconSlot(nm, main, show) {
      var inst = main.createInstance();
      inst.name = nm;
      inst.resize(S.icon, S.icon);
      recolorIcon(R, inst, col.fg);
      inst.visible = show;
      comp.appendChild(inst);
      return inst;
    }

    if (isIcon) { parts[comp.name] = { icon: iconSlot('icon', icons.share, true) }; return; }

    var p = { lead: iconSlot('iconStart', icons.lead, false) };
    if (v.state === 'loading') {
      var sl = loader.bySize(S.icon === 16 ? 16 : 24).createInstance();
      sl.name = 'loader';
      sl.findAll(function (n) { return n.name === 'line' || n.name === 'arc'; }).forEach(function (n) { n.strokes = paintFor(R, col.fg); });
      comp.appendChild(sl);
    }
    var label = await styledText(R, S.type, col.fg, 'Button');
    comp.appendChild(label);
    label.name = 'label';
    label.textAutoResize = 'WIDTH_AND_HEIGHT';
    p.label = label;
    p.trail = iconSlot('iconEnd', icons.trail, false);
    var gl = BTN_TONES[v.tone].glow;
    // Hug check: with the min height the button is S.h unless its content is taller. If the CTA type tokens or
    // padding grow past it, the button still hugs, but say so instead of silently drifting from the web.
    if (Math.round(comp.height) !== S.h)
      notes.push('Button ' + comp.name + ': hugs to ' + Math.round(comp.height) + 'px, taller than its min height ' + S.h + ' (padding ' + S.py[1] + ' top/bottom + the ' + S.type + ' line height).');
    if (gl && v.state !== 'disabled') p.glow = glowRing(R, comp, gl, S.radius);   // disabled: no light, like the web
    parts[comp.name] = p;
  }

  function wire(set) {
    if (isIcon) {
      var pIcon = ensureProp(set, 'icon', 'INSTANCE_SWAP', icons.share.id, 'Icon');
      wireKeys(parts).forEach(function (k) { parts[k].icon.componentPropertyReferences = { mainComponent: pIcon }; });
      set.description = '<button class="swing_btn swing_btn_icon swing_btn_{tone} swing_btn_{appearance} swing_btn_{size}" aria-label="…">. Square, icon 24 in xl, 20 in l/m, 16 in s/xs. aria-label is required.';
      return;
    }
    var pLabel = ensureProp(set, 'label', 'TEXT', 'Button', 'Label');
    var pShowLead = ensureProp(set, 'showIconStart', 'BOOLEAN', false, 'Show leading icon');
    var pLead = ensureProp(set, 'iconStart', 'INSTANCE_SWAP', icons.lead.id, 'Leading icon');
    var pShowTrail = ensureProp(set, 'showIconEnd', 'BOOLEAN', false, 'Show trailing icon');
    var pTrail = ensureProp(set, 'iconEnd', 'INSTANCE_SWAP', icons.trail.id, 'Trailing icon');
    wireKeys(parts).forEach(function (k) {
      var p = parts[k];
      p.label.componentPropertyReferences = { characters: pLabel };
      p.lead.componentPropertyReferences = { visible: pShowLead, mainComponent: pLead };
      p.trail.componentPropertyReferences = { visible: pShowTrail, mainComponent: pTrail };
    });
    set.description = '<button class="swing_btn swing_btn_{tone} swing_btn_{appearance} swing_btn_{size}">{label}</button>. ' +
      'state: pressed = :active / .is-pressed · disabled = disabled · loading = aria-busy="true" + .swing_loader_24 before the label. ' +
      'size xl 56 · l 48 · m 40 · s 32 · xs 24, height hugs with that as min height: padding top/bottom xl 16 · l 12 · m 8 · s 8 · xs 4 from the space tokens (s and xs get a 48 tap area in code). success is solid only, tertiary is primary/neutral only. Full width (.swing_btn_block): set the instance width to Fill. ' +
      'size glow (.swing_btn_glow, padding 12 16 from space-12 / space-16, height hugs to 44, radius 12, CTA M) has tones glow (white light on the glass line, white label) and glowPurple (.swing_btn_glow_purple: purple sweep, no glass line, Dark 500 label, for light backgrounds). ' +
      'Its "glow" layer is a 1.5px ring mask with "sheen" above it; animate "sheen" in Figma Motion: rotation 0 at 0 ms, -360 at 2000 ms, ease in-out, Loop. Disabled has no glow.';
  }

  var sizes = BTN_SIZE_ORDER, tones = Object.keys(BTN_TONES);
  var appearsOf = function (tone) { return BTN_APPEAR.filter(function (a) { return BTN_TONES[tone][a]; }); };
  var spec = {
    title: setName, legacyTitle: isIcon ? 'Icon button' : null,
    description: isIcon
      ? 'A button with only an icon, for actions like Share. Same tones and sizes as Button, square. Swap the icon from the instance panel.'
      : 'Change the label and turn the icon on at the start or end from the instance panel. Loading keeps the colour and width; write what is happening, like "Processing payment…". For a full-width button, set the instance width to Fill.',
    code: isIcon
      ? ['<button class="swing_btn swing_btn_icon swing_btn_soft swing_btn_m" aria-label="Share"><i class="swing_icon" …></i></button>',
        'Property values are the class names: tone primary = no class, neutral = .swing_btn_neutral · appearance solid = no class, soft = .swing_btn_soft · size xl = .swing_btn_xl, l = no class, m = .swing_btn_m, s = .swing_btn_s, xs = .swing_btn_xs']
      : ['<button class="swing_btn swing_btn_neutral swing_btn_soft swing_btn_m">Back</button>',
        'Property values are the class names: tone primary = no class, neutral = .swing_btn_neutral · appearance solid = no class, soft = .swing_btn_soft · size xl = .swing_btn_xl, l = no class, m = .swing_btn_m, s = .swing_btn_s, xs = .swing_btn_xs',
        'state pressed = :active / .is-pressed · disabled = disabled attribute · loading = aria-busy="true" with the loader before the label'],
    colGroups: sizes.map(function (s) { return { label: 'size ' + s + ' · ' + BTN_SIZES[s].h, cols: states }; }),
    rowGroups: tones.map(function (t) { return { label: t, rows: appearsOf(t) }; }),
    place: function (v) {
      return { cg: sizes.indexOf(v.size), c: states.indexOf(v.state), rg: tones.indexOf(v.tone), r: appearsOf(v.tone).indexOf(v.appear) };
    },
    // white-on-glass tones are invisible on the light artboard: a dark cell behind them (not in the component)
    backdrop: function (v) { return /^(glass|glow)$/.test(v.tone) ? '--dark-500' : null; }
  };

  var set = await buildSet(page, setName, variants, buildVariant, wire, function () {}, R, isIcon ? 'Icon button' : null);
  var pv = pairUp(set, variants, function (c) { return parts[c.name]; });
  await docArtboard(R, page, set, pv.comps, pv.vs, spec);
  return { set: set, count: variants.length };
}

/* ----- SlideConfirm (components.css .slide-confirm, needs slide-confirm.js) ----- */
var SC_W = 342, SC_H = 56, SC_PAD = 4, SC_THUMB = 48, SC_DRAG_P = 0.5;
var SC_TONES = {
  primary: { track: '--purple-50', ring: '--purple-100', label: '--purple-600', fill: '--purple-500', thumb: '--purple-500', thumbDrag: '--purple-600' },
  danger: { track: '--red-50', ring: '--red-100', label: '--red-700', fill: '--red-700', thumb: '--red-700', thumbDrag: '--red-press' }
};
var SC_STATES = ['default', 'dragging', 'loading', 'disabled'];

async function buildSlideConfirm(R, notes, page, icons, loader) {
  var variants = [];
  wireKeys(SC_TONES).forEach(function (tone) {
    SC_STATES.forEach(function (state) { variants.push({ tone: tone, state: state, name: 'tone=' + tone + ', state=' + state }); });
  });
  var parts = {};

  async function buildVariant(comp, v) {
    var T = SC_TONES[v.tone], dis = v.state === 'disabled', drag = v.state === 'dragging', busy = v.state === 'loading';
    var track = dis ? '--light-300' : T.track, ring = dis ? '--light-500' : T.ring, labelC = dis ? '--dark-200' : T.label;
    var thumbBg = dis ? '--light-500' : drag ? T.thumbDrag : T.thumb, fg = dis ? '--dark-200' : '--light-100';
    comp.layoutMode = 'NONE';
    comp.resizeWithoutConstraints(SC_W, SC_H);
    bindRadius(R, comp, '--radius-12', 12);
    comp.fills = paintFor(R, track);
    comp.strokes = paintFor(R, ring);
    comp.strokeWeight = 1;
    comp.strokeAlign = 'INSIDE';
    comp.clipsContent = true;

    var x = drag ? Math.round((SC_W - SC_THUMB - 2 * SC_PAD) * SC_DRAG_P) : 0;

    // ::before, the fill that follows the thumb (full width when loading)
    var fill = figma.createRectangle();
    comp.appendChild(fill);
    fill.name = 'fill';
    fill.resize(busy ? SC_W : x + SC_THUMB + 2 * SC_PAD, SC_H);
    fill.x = 0; fill.y = 0;
    bindRadius(R, fill, '--radius-12', 12);
    fill.fills = paintFor(R, T.fill);
    fill.visible = drag || busy;
    fill.constraints = { horizontal: busy ? 'STRETCH' : 'MIN', vertical: 'STRETCH' };

    var label = await styledText(R, '--type-cta-l', labelC, v.tone === 'danger' ? 'Slide to cancel booking' : 'Slide to confirm');
    comp.appendChild(label);
    label.name = 'label';
    label.textAutoResize = 'HEIGHT';
    label.textAlignHorizontal = 'CENTER';
    label.textTruncation = 'ENDING';
    label.resize(SC_W - SC_THUMB - 16 - 16, label.height);
    label.x = SC_THUMB + 16; label.y = Math.round((SC_H - label.height) / 2);
    label.constraints = { horizontal: 'STRETCH', vertical: 'CENTER' };
    label.opacity = drag ? Math.max(0, Math.round((1 - SC_DRAG_P * 1.6) * 100) / 100) : 1;   // CSS: opacity 1 - progress x 1.6
    label.visible = !busy;

    var thumb = figma.createFrame();
    comp.appendChild(thumb);
    thumb.name = 'thumb';
    thumb.layoutMode = 'HORIZONTAL';
    thumb.primaryAxisAlignItems = 'CENTER';
    thumb.counterAxisAlignItems = 'CENTER';
    thumb.resize(SC_THUMB, SC_THUMB);
    thumb.layoutSizingHorizontal = 'FIXED'; thumb.layoutSizingVertical = 'FIXED';
    thumb.x = SC_PAD + x; thumb.y = SC_PAD;
    bindRadius(R, thumb, '--radius-8', 8);
    thumb.fills = paintFor(R, thumbBg);
    thumb.constraints = { horizontal: 'MIN', vertical: 'CENTER' };
    thumb.visible = !busy;
    var ic = icons.slide.createInstance();
    thumb.appendChild(ic);
    ic.name = 'icon';
    ic.resize(24, 24);
    recolorIcon(R, ic, fg);

    // .slide-confirm__busy: loader + process label, white, centred
    var bz = figma.createFrame();
    comp.appendChild(bz);
    bz.name = 'busy';
    bz.layoutMode = 'HORIZONTAL';
    bz.primaryAxisAlignItems = 'CENTER';
    bz.counterAxisAlignItems = 'CENTER';
    bz.resize(SC_W, SC_H);
    bz.layoutSizingHorizontal = 'FIXED'; bz.layoutSizingVertical = 'FIXED';
    bindNumber(R, bz, 'itemSpacing', '--gap-related', 8);
    bz.fills = [];
    bz.x = 0; bz.y = 0;
    bz.constraints = { horizontal: 'STRETCH', vertical: 'STRETCH' };
    bz.visible = busy;
    var sl = loader.bySize(24).createInstance();
    bz.appendChild(sl);
    sl.name = 'loader';
    sl.findAll(function (n) { return n.name === 'line' || n.name === 'arc'; }).forEach(function (n) { n.strokes = paintFor(R, '--light-100'); });
    var bl = await styledText(R, '--type-cta-l', '--light-100', 'Processing…');
    bz.appendChild(bl);
    bl.name = 'busyLabel';
    bl.textAutoResize = 'WIDTH_AND_HEIGHT';

    parts[comp.name] = { label: label, busy: bl };
  }

  function wire(set) {
    var pLabel = ensureProp(set, 'label', 'TEXT', 'Slide to confirm');
    var pBusy = ensureProp(set, 'busyLabel', 'TEXT', 'Processing…');
    wireKeys(parts).forEach(function (k) {
      parts[k].label.componentPropertyReferences = { characters: pLabel };
      parts[k].busy.componentPropertyReferences = { characters: pBusy };
    });
    set.description = '<div class="swing_slide_confirm swing_slide_confirm_{tone}" data-busy-label="{busyLabel}"><span class="swing_slide_confirm__label">{label}</span><button class="swing_slide_confirm__thumb">…</button></div> + slide-confirm.js. ' +
      'state: dragging = .is-dragging (shown at 50%) · loading = .is-done + aria-busy="true" · disabled = aria-disabled="true". Width: set the instance to Fill.';
  }

  var tones = Object.keys(SC_TONES);
  var set = await buildSet(page, 'SlideConfirm', variants, buildVariant, wire, function () {}, R);
  var pv = pairUp(set, variants, function (c) { return parts[c.name]; });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'SlideConfirm',
    description: 'For one action that costs money or cannot be undone, like paying or cancelling a paid booking. Slide past 90% to confirm; a tap does nothing. Track 56, thumb 48, radius 12. Set the instance width to Fill.',
    code: ['<div class="swing_slide_confirm" data-busy-label="Processing payment…"> … </div> + <script src="/swing/ds/slide-confirm.js">',
      'tone primary = no class, danger = .swing_slide_confirm_danger · state dragging = .is-dragging · loading = .is-done + aria-busy="true" · disabled = aria-disabled="true"'],
    colGroups: [{ label: 'state', cols: SC_STATES }],
    rowGroups: [{ label: 'tone', rows: tones }],
    place: function (v) { return { cg: 0, c: SC_STATES.indexOf(v.state), rg: 0, r: tones.indexOf(v.tone) }; }
  });
  return { set: set, count: variants.length };
}

async function buildButton(R, notes) {
  await removeOrphans(buttonVariants(BTN_STATES), notes);
  var loader = await buildLoader(R, notes);
  var page = await pageNamed('Button');
  var icons = {
    lead: await iconOrPlaceholder('Icon/Line/chevron-left', page, notes),
    trail: await iconOrPlaceholder('Icon/Line/chevron-right', page, notes),
    share: await iconOrPlaceholder('Icon/Line/share', page, notes),
    slide: await iconOrPlaceholder('Icon/Line/right-lg', page, notes)
  };
  var a = await buildButtonSet(R, notes, page, 'label', icons, loader);
  var b = await buildButtonSet(R, notes, page, 'icon', icons, loader);
  var c = await buildSlideConfirm(R, notes, page, icons, loader);
  return { set: a.set, count: a.count + b.count + c.count + loader.count,
    label: 'Button ' + a.count + ', IconButton ' + b.count + ', SlideConfirm ' + c.count + ', SwingLoader ' + loader.count + ' variants' };
}

/* ----- shared: a hugging horizontal auto-layout box ----- */
function hugRow(R, comp, h, pxCss, pxVal, gapCss, gapVal, radiusCss, radiusVal) {
  comp.layoutMode = 'HORIZONTAL';
  comp.primaryAxisAlignItems = 'CENTER';
  comp.counterAxisAlignItems = 'CENTER';
  comp.resize(Math.max(comp.width, h), h);
  comp.layoutSizingHorizontal = 'HUG';
  comp.layoutSizingVertical = 'FIXED';
  comp.paddingTop = 0; comp.paddingBottom = 0;
  if (pxCss) { bindNumber(R, comp, 'paddingLeft', pxCss, pxVal); bindNumber(R, comp, 'paddingRight', pxCss, pxVal); }
  else { comp.paddingLeft = pxVal; comp.paddingRight = pxVal; }
  if (gapCss) bindNumber(R, comp, 'itemSpacing', gapCss, gapVal); else comp.itemSpacing = gapVal;
  if (radiusCss === '--radius-full') pillRadius(comp, h);
  else bindRadius(R, comp, radiusCss, radiusVal);
  comp.strokeWeight = 1;
  comp.strokeAlign = 'INSIDE';
  comp.clipsContent = false;
}

function ringOrNone(R, css) { return css ? paintFor(R, css) : []; }

// .has-indicator > .counter / .indicator { box-shadow: 0 0 0 2px var(--color-bg) }
function bgRing(R) {
  var base = R.color['--color-bg'] || { r: 1, g: 1, b: 1, a: 1 };
  var fx = { type: 'DROP_SHADOW', color: { r: base.r, g: base.g, b: base.b, a: 1 }, offset: { x: 0, y: 0 }, radius: 0, spread: 2,
    visible: true, blendMode: 'NORMAL', showShadowBehindNode: false };
  var v = R.v('--color-bg');
  try { if (v) fx = figma.variables.setBoundVariableForEffect(fx, 'color', v); } catch (e) { /* older API: plain colour */ }
  return [fx];
}

/* ----- Badge (components.css .badge) ----- */
var BADGE_TONES = {   // soft bg, soft ring, soft fg, solid bg, dot
  neutral: ['--light-300', '--light-500', '--dark-400', '--dark-500', '--dark-200'],
  primary: ['--purple-50', '--purple-100', '--purple-600', '--purple-500', '--purple-500'],
  success: ['--green-50', '--green-100', '--color-success', '--color-success', '--green-500'],
  warning: ['--orange-50', '--orange-100', '--orange-700', '--orange-700', '--orange-500'],
  danger: ['--red-50', '--red-100', '--red-700', '--red-700', '--red-500'],
  info: ['--blue-50', '--blue-100', '--blue-600', '--blue-600', '--blue-500'],
  teal: ['--teal-50', '--teal-100', '--teal-700', '--teal-700', '--teal-500'],
  pink: ['--pink-50', '--pink-100', '--pink-700', '--pink-600', '--pink-500']
};
var BADGE_APPEAR = ['soft', 'solid', 'dot'];
var BADGE_SIZES = { m: { h: 24, type: '--type-b2s' }, s: { h: 20, type: '--type-b3s' } };

async function buildBadge(R, notes, page, icons) {
  var variants = [], parts = {};
  wireKeys(BADGE_TONES).forEach(function (tone) {
    BADGE_APPEAR.forEach(function (appear) {
      wireKeys(BADGE_SIZES).forEach(function (size) {
        variants.push({ tone: tone, appear: appear, size: size, name: 'tone=' + tone + ', appearance=' + appear + ', size=' + size });
      });
    });
  });
  async function buildVariant(comp, v) {
    var T = BADGE_TONES[v.tone], S = BADGE_SIZES[v.size], dot = v.appear === 'dot', solidA = v.appear === 'solid';
    var bg = dot ? null : solidA ? T[3] : T[0], ring = v.appear === 'soft' ? T[1] : null;
    var fg = dot ? '--color-text-secondary' : solidA ? '--light-100' : T[2];
    hugRow(R, comp, S.h, dot ? null : '--space-8', dot ? 0 : 8, dot ? '--gap-related' : '--gap-tight', dot ? 8 : 4, '--radius-8', 8);
    comp.fills = paintFor(R, bg);
    comp.strokes = ringOrNone(R, ring);
    var d = figma.createEllipse();
    comp.appendChild(d);
    d.name = 'dot'; d.resize(8, 8);
    d.fills = paintFor(R, T[4]);
    d.visible = dot;
    var ic = icons.clock.createInstance();
    comp.appendChild(ic);
    ic.name = 'icon'; ic.resize(16, 16);
    recolorIcon(R, ic, fg);
    ic.visible = false;
    var label = await styledText(R, S.type, fg, 'Paid');
    comp.appendChild(label);
    label.name = 'label';
    label.textAutoResize = 'WIDTH_AND_HEIGHT';
    parts[comp.name] = { label: label, icon: ic };
  }
  function wire(set) {
    var pL = ensureProp(set, 'label', 'TEXT', 'Paid');
    var pS = ensureProp(set, 'showIcon', 'BOOLEAN', false);
    var pI = ensureProp(set, 'icon', 'INSTANCE_SWAP', icons.clock.id);
    wireKeys(parts).forEach(function (k) {
      parts[k].label.componentPropertyReferences = { characters: pL };
      parts[k].icon.componentPropertyReferences = { visible: pS, mainComponent: pI };
    });
    set.description = '<span class="swing_badge swing_badge_{tone} swing_badge_{appearance} swing_badge_{size}">{label}</span>. A status that needs attention; not tappable (that is Tag). ' +
      'tone neutral, appearance soft and size m are the default (no class). Icon: line 16 before the label, never an icon alone.';
  }
  var set = await buildSet(page, 'Badge', variants, buildVariant, wire, function () {}, R);
  var tones = Object.keys(BADGE_TONES), sizes = Object.keys(BADGE_SIZES);
  var pv = pairUp(set, variants, function (c) { return parts[c.name]; });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'Badge',
    description: 'A short status that needs attention, like Pending payment, Paid or Cancelled. Not tappable. Plain facts like "Host" or "Online booking" stay grey text, not a badge. Solid for the one that matters most, dot for dense lists.',
    code: ['<span class="swing_badge swing_badge_success">Paid</span>',
      'tone neutral = no class, others = .swing_badge_{tone} · appearance soft = no class, .swing_badge_solid, .swing_badge_dot · size m (24) = no class, s (20) = .swing_badge_s'],
    colGroups: sizes.map(function (s) { return { label: 'size ' + s + ' · ' + BADGE_SIZES[s].h, cols: BADGE_APPEAR }; }),
    rowGroups: [{ label: 'tone', rows: tones }],
    place: function (v) { return { cg: sizes.indexOf(v.size), c: BADGE_APPEAR.indexOf(v.appear), rg: 0, r: tones.indexOf(v.tone) }; }
  });
  return { set: set, count: variants.length };
}

/* ----- Counter + Indicator (components.css .counter, .indicator) ----- */
var COUNTER_TONES = { danger: ['--red-700', '--light-100'], primary: ['--purple-500', '--light-100'], neutral: ['--light-300', '--dark-400'] };

async function buildCounter(R, notes, page) {
  var variants = [], parts = {};
  wireKeys(COUNTER_TONES).forEach(function (tone) {
    [20, 16].forEach(function (s) {
      ['inline', 'corner'].forEach(function (pl) {
        variants.push({ tone: tone, size: s, placement: pl, name: 'tone=' + tone + ', size=' + s + ', placement=' + pl,
          legacy: pl === 'inline' ? 'tone=' + tone + ', size=' + s : null });
      });
    });
  });
  async function buildVariant(comp, v) {
    var T = COUNTER_TONES[v.tone];
    hugRow(R, comp, v.size, '--space-4', 4, null, 0, '--radius-full', 9999);
    comp.minWidth = v.size;
    comp.fills = paintFor(R, T[0]);
    comp.strokes = [];
    comp.effects = v.placement === 'corner' ? bgRing(R) : [];
    var t = await styledText(R, '--type-b3s', T[1], '3');
    comp.appendChild(t);
    t.name = 'count';
    t.textAutoResize = 'WIDTH_AND_HEIGHT';
    parts[comp.name] = t;
  }
  function wire(set) {
    var p = ensureProp(set, 'count', 'TEXT', '3');
    wireKeys(parts).forEach(function (k) { parts[k].componentPropertyReferences = { characters: p }; });
    set.description = '<span class="swing_counter swing_counter_{tone}">{count}</span>. Numbers only, "99+" past 99. tone danger = no class. size 16 is the counter inside a small tag (.swing_tag_s). ' +
      'placement corner = inside .has-indicator on an icon or avatar: 2px ring in the page colour (--color-bg), offset -4 top and right. inline = in a tag or a row, no ring.';
  }
  var set = await buildSet(page, 'Counter', variants, buildVariant, wire, function () {}, R);
  var tones = Object.keys(COUNTER_TONES), cols = ['20 · inline', '20 · corner', '16 · inline', '16 · corner'];
  var pv = pairUp(set, variants, function (c) { return parts[c.name]; });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'Counter',
    description: 'A count (3, 12, 99+). corner sits on the top-right of an icon or avatar with a 2px ring in the page colour, so it stays readable over the edge. inline sits in a tag or a list row, no ring.',
    code: ['<span class="has-indicator"><i class="swing_icon" …></i><span class="swing_counter">3</span></span>',
      'tone danger = no class · primary = .swing_counter_primary · neutral = .swing_counter_neutral · placement corner = inside .has-indicator, inline = on its own'],
    colGroups: [{ label: 'size · placement', cols: cols }],
    rowGroups: [{ label: 'tone', rows: tones }],
    place: function (v) { return { cg: 0, c: cols.indexOf(v.size + ' · ' + v.placement), rg: 0, r: tones.indexOf(v.tone) }; }
  });
  var by = {};
  set.children.forEach(function (c) { by[c.name] = c; });
  return { set: set, count: variants.length, get: function (tone, s) { return by['tone=' + tone + ', size=' + s + ', placement=inline']; } };
}

async function buildIndicator(R, notes, page) {
  var variants = [
    { placement: 'corner', name: 'placement=corner', legacy: 'type=dot' },
    { placement: 'inline', name: 'placement=inline' }
  ];
  async function buildVariant(comp, v) {
    comp.layoutMode = 'NONE';
    comp.resizeWithoutConstraints(8, 8);
    pillRadius(comp, 8);
    comp.fills = paintFor(R, '--red-500');
    comp.strokes = [];
    comp.effects = v.placement === 'corner' ? bgRing(R) : [];
  }
  function wire(set) {
    set.description = '<span class="swing_indicator"></span>. 8px red-500 dot for "something new" without a number; the DS has one colour only. ' +
      'placement corner = inside .has-indicator (top-right of an icon or avatar, 2px ring in --color-bg). inline = in a row, e.g. .swing_notif_row unread, no ring.';
  }
  var set = await buildSet(page, 'Indicator', variants, buildVariant, wire, function () {}, R);
  var pls = ['corner', 'inline'];
  var pv = pairUp(set, variants, function (c) { return /^placement=/.test(c.name); });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'Indicator',
    description: 'An 8px dot for "something new" when there is no number to show. One colour in the DS (red-500). corner goes on an icon or avatar with a 2px ring in the page colour; inline sits in a row, like an unread notification.',
    code: ['<span class="has-indicator"><img class="swing_avatar" …><span class="swing_indicator"></span></span>',
      'placement corner = inside .has-indicator · inline = on its own, e.g. inside .swing_notif_row'],
    colGroups: [{ label: 'placement', cols: pls }],
    rowGroups: [{ label: 'tone', rows: ['danger · red-500'] }],
    place: function (v) { return { cg: 0, c: pls.indexOf(v.placement), rg: 0, r: 0 }; }
  });
  return { set: set, count: variants.length };
}

async function buildBadgePage(R, notes) {
  var page = await pageNamed('Badge');
  var icons = { clock: await iconOrPlaceholder('Icon/Line/clock', page, notes) };
  var a = await buildBadge(R, notes, page, icons);
  var b = await buildCounter(R, notes, page);
  var c = await buildIndicator(R, notes, page);
  return { set: a.set, count: a.count + b.count + c.count, counter: b,
    label: 'Badge ' + a.count + ', Counter ' + b.count + ', Indicator ' + c.count + ' variants' };
}

/* ----- Tag (components.css .tag) ----- */
var TAG_TONES = {   // bg, ring, fg, bg-on, fg-on, press
  neutral: ['--light-100', '--light-500', '--dark-500', '--dark-500', '--light-100', '--light-300'],
  primary: ['--purple-50', '--purple-100', '--purple-600', '--purple-500', '--light-100', '--purple-100'],
  teal: ['--teal-50', '--teal-100', '--teal-700', '--teal-700', '--light-100', '--teal-100'],
  pink: ['--pink-50', '--pink-100', '--pink-700', '--pink-700', '--light-100', '--pink-100'],
  orange: ['--orange-50', '--orange-100', '--orange-700', '--orange-700', '--light-100', '--orange-100'],
  green: ['--green-50', '--green-100', '--green-700', '--green-700', '--light-100', '--green-100'],
  red: ['--red-50', '--red-100', '--red-700', '--red-700', '--light-100', '--red-100'],
  'on-media': ['--scrim-media-soft', '--light-100', '--light-100', '--light-100', '--dark-500', '--scrim-media'],
  ads: ['--light-100', '--dark-400', '--dark-400', '--dark-400', '--light-100', '--light-300']   // .tags--ads .tag (Swing Credits history)
};
var TAG_STATES = ['default', 'pressed', 'selected', 'disabled'];
var TAG_SIZES = { m: { h: 32, px: ['--space-12', 12], type: '--type-b2s', icon: 16, remove: 20, counter: 20 },
  s: { h: 24, px: ['--space-8', 8], type: '--type-b3s', icon: 12, remove: 16, counter: 16 },
  ads: { h: 28, px: ['--space-16', 16], type: '--type-b3s', icon: 16, remove: 20, counter: 16 } };
// tone ads exists only in size ads (.tags--ads sets both), and size ads only in tone ads
function tagPair(tone, size) { return (tone === 'ads') === (size === 'ads'); }

async function buildTag(R, notes, page, icons, counter) {
  var variants = [], parts = {};
  wireKeys(TAG_TONES).forEach(function (tone) {
    wireKeys(TAG_SIZES).forEach(function (size) {
      if (!tagPair(tone, size)) return;
      TAG_STATES.forEach(function (state) {
        variants.push({ tone: tone, size: size, state: state, name: 'tone=' + tone + ', size=' + size + ', state=' + state });
      });
    });
  });
  async function buildVariant(comp, v) {
    var T = TAG_TONES[v.tone], S = TAG_SIZES[v.size];
    var bg = T[0], ring = T[1], fg = T[2];
    if (v.state === 'pressed') bg = T[5];
    if (v.state === 'selected') { bg = T[3]; ring = T[3]; fg = T[4]; }
    if (v.state === 'disabled') { bg = '--light-200'; ring = '--light-300'; fg = '--dark-100'; }
    hugRow(R, comp, S.h, S.px[0], S.px[1], '--gap-tight', 4, '--radius-full', 9999);
    comp.fills = paintFor(R, bg);
    comp.strokes = paintFor(R, ring);
    function slot(nm, main, sz) {
      var i = main.createInstance();
      comp.appendChild(i);
      i.name = nm; i.resize(sz, sz);
      recolorIcon(R, i, fg);
      i.visible = false;
      return i;
    }
    var p = { lead: slot('iconStart', icons.golf, S.icon) };
    var label = await styledText(R, S.type, fg, 'Golf');
    comp.appendChild(label);
    label.name = 'label';
    label.textAutoResize = 'WIDTH_AND_HEIGHT';
    p.label = label;
    var cnt = counter.get('danger', S.counter).createInstance();
    comp.appendChild(cnt);
    cnt.name = 'counter';
    cnt.visible = false;
    try { cnt.isExposedInstance = true; } catch (e) { /* older API */ }
    p.counter = cnt;
    p.chevron = slot('chevron', icons.chevron, S.icon);
    // .tag__remove: the x sits in a 20 (16 in s) round box
    var rm = figma.createFrame();
    comp.appendChild(rm);
    rm.name = 'remove';
    rm.layoutMode = 'HORIZONTAL';
    rm.primaryAxisAlignItems = 'CENTER'; rm.counterAxisAlignItems = 'CENTER';
    rm.resize(S.remove, S.remove);
    rm.layoutSizingHorizontal = 'FIXED'; rm.layoutSizingVertical = 'FIXED';
    rm.fills = [];
    pillRadius(rm, S.remove);
    var x = icons.close.createInstance();
    rm.appendChild(x);
    x.name = 'icon'; x.resize(S.icon, S.icon);
    recolorIcon(R, x, fg);
    rm.visible = false;
    p.remove = rm;
    parts[comp.name] = p;
  }
  function wire(set) {
    var pL = ensureProp(set, 'label', 'TEXT', 'Golf');
    var pSI = ensureProp(set, 'showIconStart', 'BOOLEAN', false);
    var pI = ensureProp(set, 'iconStart', 'INSTANCE_SWAP', icons.golf.id);
    var pC = ensureProp(set, 'showCounter', 'BOOLEAN', false);
    var pCh = ensureProp(set, 'showChevron', 'BOOLEAN', false);
    var pR = ensureProp(set, 'showRemove', 'BOOLEAN', false);
    wireKeys(parts).forEach(function (k) {
      var p = parts[k];
      p.label.componentPropertyReferences = { characters: pL };
      p.lead.componentPropertyReferences = { visible: pSI, mainComponent: pI };
      p.counter.componentPropertyReferences = { visible: pC };
      p.chevron.componentPropertyReferences = { visible: pCh };
      p.remove.componentPropertyReferences = { visible: pR };
    });
    set.description = '<button class="swing_tag swing_tag_{tone} swing_tag_{size}" type="button" aria-pressed="false">{label}</button>. A tappable pill for filters and quick choices (a status only = Badge). ' +
      'state selected = aria-pressed="true" or .is-on · pressed = :active · disabled = disabled. showChevron = menu tag (aria-haspopup), showRemove = .swing_tag__remove (a picked value). ' +
      'One colour per tag group; neutral is the default for filters.';
  }
  var set = await buildSet(page, 'Tag', variants, buildVariant, wire, function () {}, R);
  var tones = Object.keys(TAG_TONES), sizes = Object.keys(TAG_SIZES);
  var pv = pairUp(set, variants, function (c) { return parts[c.name]; });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'Tag',
    description: 'A small tappable pill for filters, interests or quick choices. Selected turns solid; not selected has a thin ring. Use one colour per group: neutral for filters, primary for the main choice on a screen, the other colours only for categories that have their own colour. on-media is for tags on a photo.',
    code: ['<div class="swing_tags" role="group" aria-label="Sport"><button class="swing_tag" type="button" aria-pressed="true">Golf</button> … </div>',
      'tone neutral = no class, others = .swing_tag_{tone} (.swing_tag_on_media on photos) · size m (32) = no class, s (24) = .swing_tag_s · tone ads + size ads (28) = .swing_tags_ads on the group · state selected = aria-pressed="true" / .is-on, disabled = disabled'],
    colGroups: sizes.map(function (s) { return { label: 'size ' + s + ' · ' + TAG_SIZES[s].h, cols: TAG_STATES }; }),
    rowGroups: [{ label: 'tone', rows: tones }],
    place: function (v) { return { cg: sizes.indexOf(v.size), c: TAG_STATES.indexOf(v.state), rg: 0, r: tones.indexOf(v.tone) }; }
  });
  notes.push('Tag: in CSS the side padding shrinks by 4 when an icon, chevron or × is at that edge (:has). Figma auto layout cannot do that from a boolean, so tags with an icon are 4px wider per side than on the web.');
  return { set: set, count: variants.length };
}

async function buildTagPage(R, notes) {
  var page = await pageNamed('Tag');
  var counterPage = await pageNamed('Badge');
  var counter = await buildCounter(R, notes, counterPage);
  var icons = {
    golf: await iconOrPlaceholder('Icon/Line/golf', page, notes),
    chevron: await iconOrPlaceholder('Icon/Line/chevron-down', page, notes),
    close: await iconOrPlaceholder('Icon/Line/close-sm', page, notes)
  };
  var t = await buildTag(R, notes, page, icons, counter);
  return { set: t.set, count: t.count, label: 'Tag ' + t.count + ' variants (Counter refreshed on the Badge page)' };
}

/* ----- Checkbox / Radio / Switch (components.css .checkbox, .radio, .switch) -----
   Property names follow the code: checked = false / true / mixed (aria-checked), state = the CSS state.
   The ring is CSS box-shadow 0 0 0 2px inset = a 2px inside stroke. */
var CB_VARIANTS = [['false', 'default'], ['false', 'hover'], ['false', 'disabled'], ['false', 'invalid'],
  ['true', 'default'], ['true', 'pressed'], ['true', 'disabled'],
  ['mixed', 'default'], ['mixed', 'pressed'], ['mixed', 'disabled']];
var RD_VARIANTS = CB_VARIANTS.filter(function (v) { return v[0] !== 'mixed'; });
var CTRL_STATES = ['default', 'hover', 'pressed', 'disabled', 'invalid'];

function controlColors(checked, state) {
  var on = checked !== 'false';
  if (state === 'disabled') return on ? { bg: '--dark-100', ring: '--dark-100', mark: '--light-100' } : { bg: '--light-300', ring: '--light-500' };
  if (on) { var c = state === 'pressed' ? '--purple-600' : '--purple-500'; return { bg: c, ring: c, mark: '--light-100' }; }
  return { bg: '--light-100', ring: state === 'hover' ? '--purple-500' : state === 'invalid' ? '--red-500' : '--dark-200' };
}

async function buildControl(R, notes, page, kind, checkIcon) {
  var isCb = kind === 'checkbox', setName = isCb ? 'Checkbox' : 'Radio';
  var list = isCb ? CB_VARIANTS : RD_VARIANTS;
  var variants = list.map(function (v) { return { checked: v[0], state: v[1], name: 'checked=' + v[0] + ', state=' + v[1] }; });
  async function buildVariant(comp, v) {
    var col = controlColors(v.checked, v.state);
    comp.layoutMode = 'NONE';
    comp.resizeWithoutConstraints(24, 24);
    if (isCb) bindRadius(R, comp, '--radius-8', 8); else pillRadius(comp, 24);
    comp.fills = paintFor(R, col.bg);
    comp.strokes = paintFor(R, col.ring);
    comp.strokeWeight = 2;
    comp.strokeAlign = 'INSIDE';
    comp.clipsContent = false;
    if (v.checked === 'true' && isCb) {
      var ic = checkIcon.createInstance();
      comp.appendChild(ic);
      ic.name = 'mark'; ic.resize(16, 16); ic.x = 4; ic.y = 4;
      recolorIcon(R, ic, col.mark);
    } else if (v.checked === 'mixed') {
      var bar = figma.createRectangle();
      comp.appendChild(bar);
      bar.name = 'mark'; bar.resize(12, 2); bar.x = 6; bar.y = 11;
      bar.fills = paintFor(R, col.mark);
    } else if (v.checked === 'true') {
      var dot = figma.createEllipse();
      comp.appendChild(dot);
      dot.name = 'mark'; dot.resize(8, 8); dot.x = 8; dot.y = 8;
      dot.fills = paintFor(R, col.mark);
    }
  }
  function wire(set) {
    set.description = isCb
      ? '<input type="checkbox" class="swing_checkbox">. checked true = :checked · mixed = el.indeterminate = true · state hover = :hover · pressed = :active (also scales to .92 on the web) · disabled = disabled · invalid = aria-invalid="true". Box 24, radius 8, 2px ring, tick = icons/solid/checkmark 16.'
      : '<input type="radio" class="swing_radio" name="…">. checked true = :checked · state hover / pressed / disabled / invalid as Checkbox. Circle 24, 2px ring, white dot 8 when checked.';
  }
  var set = await buildSet(page, setName, variants, buildVariant, wire, function () {}, R);
  var rows = isCb ? ['false', 'true', 'mixed'] : ['false', 'true'];
  var pv = pairUp(set, variants, function (c) { return /^checked=/.test(c.name); });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: setName,
    description: isCb
      ? 'Pick any number of options. mixed is the parent of a group where only some children are ticked. Pair it with a label (row 44) unless the box alone is clear from context.'
      : 'Pick one option from a short list. Selected = Purple 500 fill with a white dot, matching a ticked checkbox.',
    code: isCb
      ? ['<label class="swing_check"><input type="checkbox" class="swing_checkbox"><span class="swing_check__text"><span class="swing_check__label">Caddie</span></span></label>',
        'checked true = :checked · mixed = indeterminate · state pressed = :active · disabled = disabled · invalid = aria-invalid="true"']
      : ['<label class="swing_check"><input type="radio" class="swing_radio" name="holes"><span class="swing_check__text"><span class="swing_check__label">18 holes</span></span></label>',
        'checked true = :checked · state pressed = :active · disabled = disabled · invalid = aria-invalid="true"'],
    colGroups: [{ label: 'state', cols: CTRL_STATES }],
    rowGroups: [{ label: 'checked', rows: rows }],
    place: function (v) { return { cg: 0, c: CTRL_STATES.indexOf(v.state), rg: 0, r: rows.indexOf(v.checked) }; }
  });
  return { set: set, count: variants.length };
}

var SW_STATES = ['default', 'pressed', 'disabled'];
async function buildSwitch(R, notes, page) {
  var variants = [];
  ['false', 'true'].forEach(function (c) { SW_STATES.forEach(function (s) { variants.push({ checked: c, state: s, name: 'checked=' + c + ', state=' + s }); }); });
  async function buildVariant(comp, v) {
    var on = v.checked === 'true', dis = v.state === 'disabled', pressed = v.state === 'pressed';
    comp.layoutMode = 'NONE';
    comp.resizeWithoutConstraints(40, 24);
    bindRadius(R, comp, '--radius-12', 12);
    comp.fills = paintFor(R, dis ? (on ? '--purple-100' : '--light-500') : (on ? '--purple-500' : '--dark-100'));
    comp.strokes = [];
    comp.clipsContent = false;
    var w = pressed ? 24 : 20;
    var thumb = figma.createRectangle();
    comp.appendChild(thumb);
    thumb.name = 'thumb';
    thumb.resize(w, 20);
    pillRadius(thumb, 20);
    thumb.x = on ? 40 - 2 - w : 2; thumb.y = 2;
    thumb.fills = paintFor(R, '--light-100');
    var el = R.effects['--elevation-1'];
    if (!dis && el) await thumb.setEffectStyleIdAsync(el.id);
    else thumb.effects = [];
  }
  function wire(set) {
    set.description = '<input type="checkbox" role="switch" class="swing_switch">. For an instant on/off (notifications), not for a choice that needs Save. ' +
      'checked true = :checked · pressed = :active (thumb stretches to 24) · disabled = disabled. Track 40×24, thumb 20 with Elevation/Scale/1.';
  }
  var set = await buildSet(page, 'Switch', variants, buildVariant, wire, function () {}, R);
  var rows = ['false', 'true'];
  var pv = pairUp(set, variants, function (c) { return /^checked=/.test(c.name); });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'Switch',
    description: 'An instant on/off, like notifications. The change happens right away; if it needs a Save button, use a Checkbox instead.',
    code: ['<input type="checkbox" role="switch" class="swing_switch" aria-label="Notifications">',
      'checked true = :checked · state pressed = :active · disabled = disabled'],
    colGroups: [{ label: 'state', cols: SW_STATES }],
    rowGroups: [{ label: 'checked', rows: rows }],
    place: function (v) { return { cg: 0, c: SW_STATES.indexOf(v.state), rg: 0, r: rows.indexOf(v.checked) }; }
  });
  return { set: set, count: variants.length };
}

async function buildCheckboxPage(R, notes) {
  var page = await pageNamed('Checkbox');
  var tick = (await findIcon('Icon/Solid/checkmark')) || (await iconOrPlaceholder('Icon/Line/checkmark', page, notes));
  var r = await buildControl(R, notes, page, 'checkbox', tick);
  return { set: r.set, count: r.count, label: 'Checkbox ' + r.count + ' variants' };
}
async function buildRadioPage(R, notes) {
  var page = await pageNamed('Radio');
  var r = await buildControl(R, notes, page, 'radio', null);
  return { set: r.set, count: r.count, label: 'Radio ' + r.count + ' variants' };
}
async function buildSwitchPage(R, notes) {
  var page = await pageNamed('Switch');
  var r = await buildSwitch(R, notes, page);
  return { set: r.set, count: r.count, label: 'Switch ' + r.count + ' variants' };
}

/* ----- Check (components.css .check, .check--card): a Checkbox or Radio with its label ----- */
var CHECK_W = 342;

async function controlSet(R, notes, kind) {
  var pg = await pageNamed(kind === 'checkbox' ? 'Checkbox' : 'Radio');
  var set = findLogical(pg, kind === 'checkbox' ? 'Checkbox' : 'Radio');
  if (set) return set;
  return (kind === 'checkbox' ? await buildCheckboxPage(R, notes) : await buildRadioPage(R, notes)).set;
}

async function buildCheck(R, notes, page) {
  var sets = { checkbox: await controlSet(R, notes, 'checkbox'), radio: await controlSet(R, notes, 'radio') };
  var variants = [], parts = {};
  ['checkbox', 'radio'].forEach(function (ctl) {
    ['row', 'card'].forEach(function (lay) {
      ['false', 'true'].forEach(function (c) {
        ['default', 'disabled'].forEach(function (s) {
          variants.push({ control: ctl, layout: lay, checked: c, state: s,
            name: 'control=' + ctl + ', layout=' + lay + ', checked=' + c + ', state=' + s });
        });
      });
    });
  });
  async function buildVariant(comp, v) {
    var card = v.layout === 'card', on = v.checked === 'true', dis = v.state === 'disabled';
    comp.layoutMode = 'HORIZONTAL';
    comp.counterAxisAlignItems = 'MIN';
    comp.primaryAxisAlignItems = 'MIN';
    comp.resize(CHECK_W, 44);
    comp.layoutSizingHorizontal = 'FIXED';
    comp.layoutSizingVertical = 'HUG';
    comp.minHeight = 44;                                     // --tap-min
    bindNumber(R, comp, 'itemSpacing', '--space-12', 12);
    var pad = card ? ['--space-16', 16] : ['--space-8', 8];
    bindNumber(R, comp, 'paddingTop', pad[0], pad[1]);
    bindNumber(R, comp, 'paddingBottom', pad[0], pad[1]);
    if (card) { bindNumber(R, comp, 'paddingLeft', '--space-16', 16); bindNumber(R, comp, 'paddingRight', '--space-16', 16); }
    else { comp.paddingLeft = 0; comp.paddingRight = 0; }
    if (card) {
      bindRadius(R, comp, '--radius-12', 12);
      comp.fills = paintFor(R, dis ? '--light-200' : on ? '--purple-50' : '--light-100');
      comp.strokes = paintFor(R, on && !dis ? '--purple-500' : '--light-500');
      comp.strokeWeight = 1; comp.strokeAlign = 'INSIDE';
    } else { comp.fills = []; comp.strokes = []; }

    var main = sets[v.control].findChild(function (c) { return c.name === 'checked=' + v.checked + ', state=' + v.state; });
    var ctl = main.createInstance();
    comp.appendChild(ctl);
    ctl.name = v.control;

    var col = figma.createFrame();
    comp.appendChild(col);
    col.name = 'text';
    col.layoutMode = 'VERTICAL';
    col.fills = [];
    col.itemSpacing = 0;
    col.paddingTop = 1;                                      // B1 line 22 centred on the 24 box (--check-line)
    col.layoutSizingHorizontal = 'FILL';
    col.layoutSizingVertical = 'HUG';
    var label = await styledText(R, '--type-b1', dis ? '--dark-100' : '--dark-500', v.control === 'checkbox' ? 'Caddie' : '18 holes');
    col.appendChild(label);
    label.name = 'label';
    label.textAutoResize = 'HEIGHT';
    label.layoutSizingHorizontal = 'FILL';
    var hint = await styledText(R, '--type-b2', dis ? '--dark-100' : '--dark-300', 'One caddie for your group');
    col.appendChild(hint);
    hint.name = 'hint';
    hint.textAutoResize = 'HEIGHT';
    hint.layoutSizingHorizontal = 'FILL';
    hint.visible = false;

    var metaBox = figma.createFrame();
    comp.appendChild(metaBox);
    metaBox.name = 'meta';
    metaBox.layoutMode = 'HORIZONTAL';
    metaBox.fills = [];
    metaBox.paddingTop = 2;                                  // B2S line 20 centred on 24
    metaBox.layoutSizingHorizontal = 'HUG';
    metaBox.layoutSizingVertical = 'HUG';
    var meta = await styledText(R, '--type-b2s', dis ? '--dark-100' : '--dark-500', 'Rp 150,000');
    metaBox.appendChild(meta);
    meta.name = 'metaText';
    meta.textAutoResize = 'WIDTH_AND_HEIGHT';
    metaBox.visible = false;
    parts[comp.name] = { label: label, hint: hint, metaBox: metaBox, meta: meta };
  }
  function wire(set) {
    var pL = ensureProp(set, 'label', 'TEXT', 'Caddie');
    var pSH = ensureProp(set, 'showHint', 'BOOLEAN', false);
    var pH = ensureProp(set, 'hint', 'TEXT', 'One caddie for your group');
    var pSM = ensureProp(set, 'showMeta', 'BOOLEAN', false);
    var pM = ensureProp(set, 'meta', 'TEXT', 'Rp 150,000');
    wireKeys(parts).forEach(function (k) {
      var p = parts[k];
      p.label.componentPropertyReferences = { characters: pL };
      p.hint.componentPropertyReferences = { visible: pSH, characters: pH };
      p.metaBox.componentPropertyReferences = { visible: pSM };
      p.meta.componentPropertyReferences = { characters: pM };
    });
    set.description = '<label class="swing_check [swing_check_card]"><input type="{control}" class="{control}"><span class="swing_check__text"><span class="swing_check__label">{label}</span><span class="swing_check__hint">{hint}</span></span><span class="swing_check__meta">{meta}</span></label>. ' +
      'layout card = .swing_check_card (selected: purple-50 + purple-500 ring). Row min 44, gap 12, label B1, hint B2 dark-300, meta B2 Semibold. Width 342: set the instance to Fill.';
  }
  var set = await buildSet(page, 'Check', variants, buildVariant, wire, function () {}, R);
  var ctls = ['checkbox', 'radio'], lays = ['row', 'card'];
  var pv = pairUp(set, variants, function (c) { return parts[c.name]; });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'Check',
    description: 'A Checkbox or Radio with its label, as one tappable row (44 tall). card makes it a selectable tile for bigger choices. Turn on hint for a second line and meta for a value on the right, like a price.',
    code: ['<label class="swing_check"><input type="checkbox" class="swing_checkbox"><span class="swing_check__text"><span class="swing_check__label">Caddie</span></span></label>',
      'layout row = .swing_check · card = .swing_check .swing_check_card · group = <fieldset class="swing_check_group"> + <legend class="swing_check_group__legend">'],
    colGroups: ctls.map(function (c) { return { label: c, cols: ['checked false', 'checked true'] }; }),
    rowGroups: lays.map(function (l) { return { label: l, rows: ['default', 'disabled'] }; }),
    place: function (v) { return { cg: ctls.indexOf(v.control), c: v.checked === 'true' ? 1 : 0, rg: lays.indexOf(v.layout), r: v.state === 'default' ? 0 : 1 }; }
  });
  return { set: set, count: variants.length };
}

async function buildCheckPage(R, notes) {
  var page = await pageNamed('Check');
  var r = await buildCheck(R, notes, page);
  return { set: r.set, count: r.count, label: 'Check ' + r.count + ' variants' };
}

/* ----- TextField (components.css .field, .field--phone, .field--search, textarea) -----
   type = which kind of field, state = the CSS state, filled = the input has a value (label floats up). */
var TF_TYPES = {
  text: { states: ['default', 'hover', 'focus', 'error', 'success', 'disabled', 'readonly', 'locked', 'lockedWarning'], label: 'Email', value: 'ghais@swing.id', ph: 'name@email.com',
    help: 'We send the receipt here', helpErr: 'Enter a valid email' },
  password: { states: ['default', 'focus', 'error', 'disabled'], label: 'Password', value: '••••••••••', ph: 'At least 8 characters',
    help: 'At least 8 characters', helpErr: 'Password is too short' },
  multiline: { states: ['default', 'focus', 'error', 'disabled'], label: 'Notes for the course', value: 'Bring my own caddie, prefer the back nine.', ph: 'Anything the club should know',
    help: 'Optional', helpErr: 'Keep it under 200 characters' },
  phone: { states: ['default', 'focus', 'error', 'disabled'], label: 'Phone number', value: '812 3456 7890', ph: '812 3456 7890',
    help: 'Tap the code to change country', helpErr: 'Enter a valid phone number' },
  search: { states: ['default', 'focus'], label: '', value: 'Suvarna', ph: 'Search courses or players', help: '', helpErr: '' }
};
var TF_TYPE_ORDER = ['text', 'password', 'multiline', 'phone', 'search'];
var TF_W = 342;

function tfColors(state) {
  var c = { bg: '--light-200', ring: '--light-500', ringW: 1, label: '--dark-300', text: '--dark-500', help: '--dark-300', icon: '--dark-300' };
  if (state === 'hover') c.ring = '--dark-100';
  if (state === 'focus') { c.bg = '--light-100'; c.ring = '--purple-500'; c.ringW = 2; c.label = '--purple-600'; }
  if (state === 'error') { c.bg = '--red-50'; c.ring = '--red-500'; c.label = '--red-500'; c.help = '--red-500'; }
  if (state === 'success') { c.ring = '--color-success'; c.label = '--color-success'; c.help = '--color-success'; }
  if (state === 'disabled') { c.bg = '--light-300'; c.ring = null; c.label = c.text = c.icon = c.help = '--dark-100'; }
  if (state === 'readonly') c.ring = null;
  // .field--locked (ADS, readonly): no ring, label and value dark-200, a text button (.field__btn) in the box
  if (state === 'locked' || state === 'lockedWarning') { c.ring = null; c.label = '--dark-200'; c.text = '--dark-200'; }
  return c;
}

function autoFrame(name, dir, parent) {
  var f = figma.createFrame();
  parent.appendChild(f);
  f.name = name;
  f.layoutMode = dir;
  f.fills = [];
  f.itemSpacing = 0;
  return f;
}

async function buildTextField(R, notes, page, icons) {
  var variants = [], parts = {};
  TF_TYPE_ORDER.forEach(function (t) {
    TF_TYPES[t].states.forEach(function (s) {
      ['false', 'true'].forEach(function (f) {
        variants.push({ type: t, state: s, filled: f, name: 'type=' + t + ', state=' + s + ', filled=' + f,
          legacy: t === 'text' ? 'state=' + s + ', filled=' + f : null });
      });
    });
  });

  async function buildVariant(comp, v) {
    var T = TF_TYPES[v.type], C = tfColors(v.state), filled = v.filled === 'true', focus = v.state === 'focus';
    var isSearch = v.type === 'search', isMulti = v.type === 'multiline', isPhone = v.type === 'phone', isPw = v.type === 'password';
    var floated = filled || focus || isPhone;
    var p = {};
    comp.layoutMode = 'VERTICAL';
    comp.resize(TF_W, 100);
    comp.layoutSizingHorizontal = 'FIXED';
    comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--space-8', 8);
    comp.fills = [];

    // .field__box
    var box = autoFrame('box', 'HORIZONTAL', comp);
    box.counterAxisAlignItems = isMulti ? 'MIN' : 'CENTER';
    box.resize(TF_W, isSearch ? 48 : isMulti ? 112 : 56);   // resize first: it sets both axes back to FIXED
    box.layoutSizingHorizontal = 'FILL';
    box.layoutSizingVertical = 'FIXED';
    bindNumber(R, box, 'paddingLeft', '--space-16', 16);
    bindNumber(R, box, 'paddingRight', '--space-16', 16);
    box.paddingTop = 0; box.paddingBottom = 0;
    bindNumber(R, box, 'itemSpacing', isPhone ? '--space-8' : '--space-12', isPhone ? 8 : 12);
    bindRadius(R, box, '--radius-12', 12);
    box.fills = paintFor(R, C.bg);
    box.strokes = C.ring ? paintFor(R, C.ring) : [];
    box.strokeWeight = C.ringW; box.strokeAlign = 'INSIDE';

    // lead icon: a prop on text/password/multiline/phone, always the search glass on search
    var lead = (isSearch ? icons.search : icons.lead).createInstance();
    box.appendChild(lead);
    lead.name = isSearch ? 'searchIcon' : 'leadIcon'; lead.resize(20, 20);
    recolorIcon(R, lead, C.icon);
    lead.visible = isSearch;
    if (!isSearch && !isMulti) p.lead = lead;
    if (isMulti) lead.remove();

    var caret = function () {
      var c = figma.createRectangle(); c.name = 'caret'; c.resize(1.5, 18); c.fills = paintFor(R, '--purple-500'); return c;
    };
    var valueText = async function (row) {
      if (filled) {
        var t = await styledText(R, '--type-b1', C.text, T.value);
        row.appendChild(t);
        t.name = 'value';
        if (isMulti) { t.textAutoResize = 'HEIGHT'; t.layoutSizingHorizontal = 'FILL'; } else t.textAutoResize = 'WIDTH_AND_HEIGHT';
        if (!isPw) p.value = t;
        if (focus) row.appendChild(caret());
      } else {
        if (focus) row.appendChild(caret());
        if (focus || isPhone || isSearch) {
          var ph = await styledText(R, '--type-b1', C.state === 'disabled' ? '--dark-100' : '--dark-200', T.ph);
          row.appendChild(ph);
          ph.name = 'placeholder';
          ph.textAutoResize = 'WIDTH_AND_HEIGHT';
          p.placeholder = ph;
        }
      }
    };

    var col = autoFrame('content', 'VERTICAL', box);
    col.primaryAxisAlignItems = isMulti ? 'MIN' : 'CENTER';
    col.layoutSizingHorizontal = 'FILL';
    col.layoutSizingVertical = 'FILL';
    if (isMulti) { bindNumber(R, col, 'paddingTop', '--space-8', 8); bindNumber(R, col, 'paddingBottom', '--space-12', 12); }

    if (isSearch) {
      var srow = autoFrame('valueRow', 'HORIZONTAL', col);
      srow.counterAxisAlignItems = 'CENTER'; srow.itemSpacing = 1;
      srow.layoutSizingHorizontal = 'FILL'; srow.layoutSizingVertical = 'HUG';
      await valueText(srow);
    } else {
      var label = await styledText(R, floated ? '--type-b2s' : (isMulti ? '--type-b1s' : '--type-b1s'), C.label, T.label);
      col.appendChild(label);
      label.name = 'label';
      label.textAutoResize = 'HEIGHT';
      label.layoutSizingHorizontal = 'FILL';
      label.textTruncation = 'ENDING';
      p.label = label;
      if (isMulti && !floated) {   // resting label sits where the first line will be
        col.paddingTop = 17;
      }
      if (floated) {
        var row = autoFrame('valueRow', 'HORIZONTAL', col);
        row.counterAxisAlignItems = 'CENTER'; row.itemSpacing = 1;
        row.layoutSizingHorizontal = 'FILL'; row.layoutSizingVertical = 'HUG';
        if (isPhone) {
          // .field__cc: flag + code + chevron, a 1px line after it, then the number
          row.itemSpacing = 8;
          var cc = autoFrame('countryCode', 'HORIZONTAL', row);
          cc.counterAxisAlignItems = 'CENTER';
          bindNumber(R, cc, 'itemSpacing', '--space-4', 4);
          cc.layoutSizingHorizontal = 'HUG'; cc.layoutSizingVertical = 'HUG';
          var flag = autoFrame('flag', 'VERTICAL', cc);   // Indonesia: red over white, drawn (no emoji)
          flag.resize(20, 14); flag.layoutSizingHorizontal = 'FIXED'; flag.layoutSizingVertical = 'FIXED';
          flag.cornerRadius = 2; flag.clipsContent = true;
          flag.strokes = paintFor(R, '--light-500'); flag.strokeWeight = 1; flag.strokeAlign = 'INSIDE';
          var red = figma.createRectangle(); flag.appendChild(red); red.name = 'red'; red.resize(20, 7); red.fills = [solid({ r: 0.808, g: 0.067, b: 0.149, a: 1 })];
          red.layoutSizingHorizontal = 'FILL';
          var white = figma.createRectangle(); flag.appendChild(white); white.name = 'white'; white.resize(20, 7); white.fills = [solid({ r: 1, g: 1, b: 1, a: 1 })];
          white.layoutSizingHorizontal = 'FILL';
          var code = await styledText(R, '--type-b1', C.text, '+62');
          cc.appendChild(code); code.name = 'code'; code.textAutoResize = 'WIDTH_AND_HEIGHT';
          p.code = code;
          var chev = icons.chevron.createInstance();
          cc.appendChild(chev); chev.name = 'chevron'; chev.resize(16, 16);
          recolorIcon(R, chev, C.text);
          var line = figma.createRectangle(); row.appendChild(line); line.name = 'divider'; line.resize(1, 20);
          line.fills = paintFor(R, '--light-500');
          var num = autoFrame('number', 'HORIZONTAL', row);
          num.counterAxisAlignItems = 'CENTER'; num.itemSpacing = 1;
          num.layoutSizingHorizontal = 'FILL'; num.layoutSizingVertical = 'HUG';
          await valueText(num);
        } else {
          await valueText(row);
          if (isMulti) row.counterAxisAlignItems = 'MIN';
        }
      }
    }

    // .field__btn (locked): B3 Semibold purple-500 (orange-500 = .field__btn--warning), optional 14 icon after the text, gap 4
    if (v.state === 'locked' || v.state === 'lockedWarning') {
      var fb = autoFrame('button', 'HORIZONTAL', box);
      fb.counterAxisAlignItems = 'CENTER'; fb.layoutSizingHorizontal = 'HUG'; fb.layoutSizingVertical = 'HUG';
      bindNumber(R, fb, 'itemSpacing', '--space-4', 4);
      var fbc = v.state === 'lockedWarning' ? '--orange-500' : '--purple-500';
      var fbt = await styledText(R, '--type-b3s', fbc, v.state === 'lockedWarning' ? 'Verify email' : 'Change');
      fb.appendChild(fbt); fbt.name = 'label'; fbt.textAutoResize = 'WIDTH_AND_HEIGHT';
      var fbi = icons.info.createInstance(); fb.appendChild(fbi); fbi.name = 'icon'; fbi.resize(14, 14);
      recolorIcon(R, fbi, fbc); fbi.visible = false;
      p.btn = fbt; p.btnIcon = fbi;
    }

    // trailing: password = show/hide (always there), others = optional clear
    if (isPw) {
      var rv = autoFrame('reveal', 'HORIZONTAL', box);
      rv.primaryAxisAlignItems = 'CENTER'; rv.counterAxisAlignItems = 'CENTER';
      rv.resize(40, 40); rv.layoutSizingHorizontal = 'FIXED'; rv.layoutSizingVertical = 'FIXED';
      bindRadius(R, rv, '--radius-8', 8);
      var eye = icons.eye.createInstance(); rv.appendChild(eye); eye.name = 'icon'; eye.resize(20, 20);
      recolorIcon(R, eye, C.icon);
    } else if (!isMulti) {
      var act = autoFrame('action', 'HORIZONTAL', box);
      act.primaryAxisAlignItems = 'CENTER'; act.counterAxisAlignItems = 'CENTER';
      act.resize(40, 40); act.layoutSizingHorizontal = 'FIXED'; act.layoutSizingVertical = 'FIXED';
      bindRadius(R, act, '--radius-8', 8);
      var ai = icons.action.createInstance(); act.appendChild(ai); ai.name = 'icon'; ai.resize(20, 20);
      recolorIcon(R, ai, C.icon);
      act.visible = false;
      p.act = act; p.actIcon = ai;
    }

    // .field__help (+ .field__count on multiline). Search has none.
    if (!isSearch) {
      var help = autoFrame('help', 'HORIZONTAL', comp);
      help.counterAxisAlignItems = 'MIN';
      help.layoutSizingHorizontal = 'FILL'; help.layoutSizingVertical = 'HUG';
      bindNumber(R, help, 'itemSpacing', '--space-4', 4);
      bindNumber(R, help, 'paddingLeft', '--space-4', 4);
      bindNumber(R, help, 'paddingRight', '--space-4', 4);
      var err = v.state === 'error', ok = v.state === 'success';
      var hiBox = autoFrame('helpIcon', 'VERTICAL', help);   // CSS: icon 16 centred on the 20px text line
      hiBox.primaryAxisAlignItems = 'CENTER'; hiBox.counterAxisAlignItems = 'CENTER';
      hiBox.resize(16, 20); hiBox.layoutSizingHorizontal = 'FIXED'; hiBox.layoutSizingVertical = 'FIXED';
      var hi = (err ? icons.error : ok ? icons.success : icons.info).createInstance();
      hiBox.appendChild(hi); hi.name = 'icon'; hi.resize(16, 16);
      recolorIcon(R, hi, C.help);
      if (isMulti && !err) hiBox.visible = false;   // "Optional" reads without an icon, like the web
      var ht = await styledText(R, '--type-b2', C.help, err ? T.helpErr : ok ? 'Looks good' : T.help);
      help.appendChild(ht); ht.name = 'helpText';
      ht.textAutoResize = 'HEIGHT'; ht.layoutSizingHorizontal = 'FILL';
      p.help = help; p.helpText = ht;
      if (isMulti) {
        var cnt = await styledText(R, '--type-b2', v.state === 'disabled' ? '--dark-100' : '--dark-200', filled ? T.value.length + ' / 200' : '0 / 200');
        help.appendChild(cnt); cnt.name = 'count'; cnt.textAutoResize = 'WIDTH_AND_HEIGHT';
        p.count = cnt;
      }
    }
    parts[comp.name] = p;
  }

  function wire(set) {
    var pL = ensureProp(set, 'label', 'TEXT', 'Email');
    var pV = ensureProp(set, 'value', 'TEXT', 'ghais@swing.id');
    var pP = ensureProp(set, 'placeholder', 'TEXT', 'name@email.com');
    var pSH = ensureProp(set, 'showHelp', 'BOOLEAN', true);
    var pH = ensureProp(set, 'helpText', 'TEXT', 'We send the receipt here');
    var pSL = ensureProp(set, 'showLeadIcon', 'BOOLEAN', false);
    var pLI = ensureProp(set, 'leadIcon', 'INSTANCE_SWAP', icons.lead.id);
    var pSA = ensureProp(set, 'showAction', 'BOOLEAN', false);
    var pAI = ensureProp(set, 'actionIcon', 'INSTANCE_SWAP', icons.action.id);
    var pC = ensureProp(set, 'count', 'TEXT', '0 / 200');
    var pCC = ensureProp(set, 'countryCode', 'TEXT', '+62');
    var pBL = ensureProp(set, 'buttonLabel', 'TEXT', 'Change');
    var pSBI = ensureProp(set, 'showButtonIcon', 'BOOLEAN', false);
    var pBI = ensureProp(set, 'buttonIcon', 'INSTANCE_SWAP', icons.info.id);
    wireKeys(parts).forEach(function (k) {
      var p = parts[k];
      if (p.label) p.label.componentPropertyReferences = { characters: pL };
      if (p.value) p.value.componentPropertyReferences = { characters: pV };
      if (p.placeholder) p.placeholder.componentPropertyReferences = { characters: pP };
      if (p.help) p.help.componentPropertyReferences = { visible: pSH };
      if (p.helpText) p.helpText.componentPropertyReferences = { characters: pH };
      if (p.lead) p.lead.componentPropertyReferences = { visible: pSL, mainComponent: pLI };
      if (p.act) p.act.componentPropertyReferences = { visible: pSA };
      if (p.actIcon) p.actIcon.componentPropertyReferences = { mainComponent: pAI };
      if (p.count) p.count.componentPropertyReferences = { characters: pC };
      if (p.code) p.code.componentPropertyReferences = { characters: pCC };
      if (p.btn) { p.btn.componentPropertyReferences = { characters: pBL }; p.btnIcon.componentPropertyReferences = { visible: pSBI, mainComponent: pBI }; }
    });
    set.description = '<div class="swing_field [swing_field_phone|swing_field_search] [is-error|is-success]"><div class="swing_field__box"><input class="swing_field__input" placeholder="{placeholder}"><label class="swing_field__label">{label}</label></div><p class="swing_field__help">{helpText}</p></div>. ' +
      'type password = <input type="password"> + show/hide .swing_field__action · multiline = <textarea class="swing_field__input"> (2× tall) + .swing_field__count · phone = .swing_field_phone with .swing_field__cc (+62, label always up) · search = .swing_field_search (48, glass icon, visible placeholder, no label). ' +
      'state focus = :focus-within · error = .is-error · success = .is-success · disabled / readonly = on the input · locked = .swing_field_locked (ADS: readonly, dark-200, .swing_field__btn "Change" in purple-500) · lockedWarning = .swing_field__btn_warning (orange-500, e.g. Verify email + icon 14). filled = has a value. Width 342: set the instance to Fill.';
  }

  var set = await buildSet(page, 'TextField', variants, buildVariant, wire, function () {}, R);
  var pv = pairUp(set, variants, function (c) { return parts[c.name]; });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'TextField',
    description: 'One component for every input. type picks the kind: text, password (show/hide), multiline (counter), phone (country code, label always up) and search (48, no label). The placeholder is only a hint while typing, never the label.',
    code: ['<div class="swing_field"><div class="swing_field__box"><input class="swing_field__input" id="email" type="email" placeholder="name@email.com"><label class="swing_field__label" for="email">Email</label></div><p class="swing_field__help">We send the receipt here</p></div>',
      'type password = type="password" · multiline = <textarea> · phone = .swing_field_phone · search = .swing_field_search · state error = .is-error · success = .is-success · focus = :focus-within'],
    colGroups: [{ label: 'filled', cols: ['false · empty', 'true · has value'] }],
    rowGroups: TF_TYPE_ORDER.map(function (t) { return { label: 'type ' + t, rows: TF_TYPES[t].states }; }),
    place: function (v) { return { cg: 0, c: v.filled === 'true' ? 1 : 0, rg: TF_TYPE_ORDER.indexOf(v.type), r: TF_TYPES[v.type].states.indexOf(v.state) }; }
  });
  notes.push('TextField: on the web the clear / show-password button pulls 8px into the right padding (margin-right -8). Figma auto layout has no negative margin, so with the button on the box is 8px roomier on the right. The flag on phone is drawn, not an emoji.');
  return { set: set, count: variants.length };
}

async function buildTextFieldPage(R, notes) {
  var page = await pageNamed('TextField');
  var solidOr = async function (n) { return (await findIcon('Icon/Solid/' + n)) || (await iconOrPlaceholder('Icon/Line/' + n, page, notes)); };
  var icons = {
    lead: await iconOrPlaceholder('Icon/Line/mail', page, notes),
    action: await iconOrPlaceholder('Icon/Line/close-circle', page, notes),
    info: await iconOrPlaceholder('Icon/Line/info', page, notes),
    error: await solidOr('warning-circle'),
    success: await solidOr('tick-circle'),
    search: await iconOrPlaceholder('Icon/Line/search', page, notes),
    eye: await iconOrPlaceholder('Icon/Line/eye', page, notes),
    chevron: await iconOrPlaceholder('Icon/Line/chevron-down', page, notes)
  };
  var r = await buildTextField(R, notes, page, icons);
  return { set: r.set, count: r.count, label: 'TextField ' + r.count + ' variants' };
}

/* ----- Select + Option (components.css .field--select, .option) ----- */
var SEL_STATES = ['default', 'open', 'error', 'disabled'];

async function buildSelect(R, notes, page, icons) {
  var variants = [], parts = {};
  SEL_STATES.forEach(function (s) { ['false', 'true'].forEach(function (f) { variants.push({ state: s, filled: f, name: 'state=' + s + ', filled=' + f }); }); });
  async function buildVariant(comp, v) {
    var C = tfColors(v.state === 'open' ? 'focus' : v.state), filled = v.filled === 'true', open = v.state === 'open';
    comp.layoutMode = 'VERTICAL';
    comp.resize(TF_W, 100);
    comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--space-8', 8);
    comp.fills = [];
    var box = autoFrame('box', 'HORIZONTAL', comp);
    box.counterAxisAlignItems = 'CENTER';
    box.resize(TF_W, 56); box.layoutSizingHorizontal = 'FILL'; box.layoutSizingVertical = 'FIXED';
    bindNumber(R, box, 'paddingLeft', '--space-16', 16);
    bindNumber(R, box, 'paddingRight', '--space-16', 16);
    bindNumber(R, box, 'itemSpacing', '--space-12', 12);
    bindRadius(R, box, '--radius-12', 12);
    box.fills = paintFor(R, C.bg);
    box.strokes = C.ring ? paintFor(R, C.ring) : [];
    box.strokeWeight = C.ringW; box.strokeAlign = 'INSIDE';
    var lead = icons.lead.createInstance();   // .field__lead, 20, dark-300
    box.appendChild(lead);
    lead.name = 'leadIcon'; lead.resize(20, 20);
    recolorIcon(R, lead, C.icon);
    lead.visible = false;
    var col = autoFrame('content', 'VERTICAL', box);
    col.primaryAxisAlignItems = 'CENTER';
    col.layoutSizingHorizontal = 'FILL'; col.layoutSizingVertical = 'FILL';
    var label = await styledText(R, filled ? '--type-b2s' : '--type-b1s', C.label, 'City');
    col.appendChild(label);
    label.name = 'label'; label.textAutoResize = 'HEIGHT'; label.layoutSizingHorizontal = 'FILL'; label.textTruncation = 'ENDING';
    var p = { label: label, lead: lead };
    if (filled) {
      var val = await styledText(R, '--type-b1', C.text, 'Jakarta');
      col.appendChild(val);
      val.name = 'value'; val.textAutoResize = 'HEIGHT'; val.layoutSizingHorizontal = 'FILL'; val.textTruncation = 'ENDING';
      p.value = val;
    }
    var chev = icons.chevron.createInstance();
    box.appendChild(chev);
    chev.name = 'chevron'; chev.resize(20, 20);
    recolorIcon(R, chev, C.icon);
    if (open) chev.rotation = 180;   // .field__trigger.is-open .field__chev { rotate(180deg) }
    var help = autoFrame('help', 'HORIZONTAL', comp);
    help.layoutSizingHorizontal = 'FILL'; help.layoutSizingVertical = 'HUG';
    bindNumber(R, help, 'itemSpacing', '--space-4', 4);
    bindNumber(R, help, 'paddingLeft', '--space-4', 4);
    bindNumber(R, help, 'paddingRight', '--space-4', 4);
    var hiBox = autoFrame('helpIcon', 'VERTICAL', help);
    hiBox.primaryAxisAlignItems = 'CENTER'; hiBox.counterAxisAlignItems = 'CENTER';
    hiBox.resize(16, 20); hiBox.layoutSizingHorizontal = 'FIXED'; hiBox.layoutSizingVertical = 'FIXED';
    var hi = (v.state === 'error' ? icons.error : icons.info).createInstance();
    hiBox.appendChild(hi); hi.name = 'icon'; hi.resize(16, 16);
    recolorIcon(R, hi, C.help);
    var ht = await styledText(R, '--type-b2', C.help, v.state === 'error' ? 'Choose a city' : 'We show courses near this city');
    help.appendChild(ht); ht.name = 'helpText'; ht.textAutoResize = 'HEIGHT'; ht.layoutSizingHorizontal = 'FILL';
    p.help = help; p.helpText = ht;
    parts[comp.name] = p;
  }
  function wire(set) {
    var pL = ensureProp(set, 'label', 'TEXT', 'City');
    var pV = ensureProp(set, 'value', 'TEXT', 'Jakarta');
    var pSH = ensureProp(set, 'showHelp', 'BOOLEAN', true);
    var pH = ensureProp(set, 'helpText', 'TEXT', 'We show courses near this city');
    var pSL = ensureProp(set, 'showLeadIcon', 'BOOLEAN', false);
    var pLI = ensureProp(set, 'leadIcon', 'INSTANCE_SWAP', icons.lead.id);
    wireKeys(parts).forEach(function (k) {
      var p = parts[k];
      p.label.componentPropertyReferences = { characters: pL };
      if (p.value) p.value.componentPropertyReferences = { characters: pV };
      p.help.componentPropertyReferences = { visible: pSH };
      p.helpText.componentPropertyReferences = { characters: pH };
      p.lead.componentPropertyReferences = { visible: pSL, mainComponent: pLI };
    });
    set.description = '<div class="swing_field field--select"><button class="swing_field__box swing_field__trigger" aria-haspopup="dialog"><span class="swing_field__value">{value}</span><span class="swing_field__label">{label}</span><i class="swing_icon swing_field__chev"></i></button></div>. ' +
      'Opens a bottom sheet of Option rows. showLeadIcon = .swing_field__lead (label moves right) · showHelp = .swing_field__help. state open = .is-open (chevron turns) · error = .swing_field.is-error · disabled = disabled. filled = a value is picked. Width 342: set the instance to Fill.';
  }
  var set = await buildSet(page, 'Select', variants, buildVariant, wire, function () {}, R);
  var pv = pairUp(set, variants, function (c) { return parts[c.name]; });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'Select',
    description: 'A field that opens a bottom sheet of options instead of a keyboard. Same box as TextField; the chevron turns while the sheet is open.',
    code: ['<div class="swing_field field--select"><button class="swing_field__box swing_field__trigger" type="button" aria-haspopup="dialog" data-sheet="city-sheet"><span class="swing_field__value"></span><span class="swing_field__label">City</span>…</button></div>',
      'state open = .swing_field__trigger.is-open · error = .swing_field.is-error · disabled = disabled · filled = .swing_field__value has text'],
    colGroups: [{ label: 'filled', cols: ['false · empty', 'true · picked'] }],
    rowGroups: [{ label: 'state', rows: SEL_STATES }],
    place: function (v) { return { cg: 0, c: v.filled === 'true' ? 1 : 0, rg: 0, r: SEL_STATES.indexOf(v.state) }; },
    examples: [
      { label: 'empty', items: [{ variant: 'state=default, filled=true', props: { label: 'Players', value: '1 player', showHelp: false } }] },
      { label: 'filled · lead icon', items: [{ variant: 'state=default, filled=true', props: { label: 'City', value: 'Jakarta', showLeadIcon: true, showHelp: true, helpText: 'We show courses near this city' } }] },
      { label: 'error · disabled', items: [
        { variant: 'state=error, filled=false', props: { label: 'Holes', showHelp: true, helpText: 'Choose 9 or 18 holes' } },
        { variant: 'state=disabled, filled=true', props: { label: 'Course', value: 'Handara Golf & Resort', showHelp: false } }] }
    ]
  });
  return { set: set, count: variants.length };
}

async function buildOption(R, notes, page, icons) {
  var variants = [], parts = {};
  ['false', 'true'].forEach(function (sel) { ['default', 'pressed'].forEach(function (s) { variants.push({ selected: sel, state: s, name: 'selected=' + sel + ', state=' + s }); }); });
  async function buildVariant(comp, v) {
    var on = v.selected === 'true', fg = on ? '--purple-600' : '--dark-500';
    comp.layoutMode = 'HORIZONTAL';
    comp.counterAxisAlignItems = 'CENTER';
    comp.resize(TF_W, 56);
    comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    comp.minHeight = 56;
    bindNumber(R, comp, 'itemSpacing', '--space-12', 12);
    bindNumber(R, comp, 'paddingTop', '--space-8', 8);
    bindNumber(R, comp, 'paddingBottom', '--space-8', 8);
    comp.paddingLeft = 0; comp.paddingRight = 0;
    comp.fills = v.state === 'pressed' ? paintFor(R, '--light-200') : [];
    comp.strokes = [];
    var lead = icons.lead.createInstance();
    comp.appendChild(lead);
    lead.name = 'leadIcon'; lead.resize(20, 20);
    recolorIcon(R, lead, '--dark-300');
    lead.visible = false;
    var col = autoFrame('text', 'VERTICAL', comp);
    col.layoutSizingHorizontal = 'FILL'; col.layoutSizingVertical = 'HUG';
    var label = await styledText(R, on ? '--type-b1s' : '--type-b1', fg, 'Jakarta');
    col.appendChild(label);
    label.name = 'label'; label.textAutoResize = 'HEIGHT'; label.layoutSizingHorizontal = 'FILL';
    var hint = await styledText(R, '--type-b2', '--dark-300', '24 courses');
    col.appendChild(hint);
    hint.name = 'hint'; hint.textAutoResize = 'HEIGHT'; hint.layoutSizingHorizontal = 'FILL';
    hint.visible = false;
    var ck = icons.check.createInstance();
    comp.appendChild(ck);
    ck.name = 'check'; ck.resize(20, 20);
    recolorIcon(R, ck, '--purple-600');
    ck.visible = on;
    // border-bottom 1px light-500: a hairline that can be switched off on the last option
    var line = figma.createRectangle();
    comp.appendChild(line);
    line.name = 'divider';
    line.layoutPositioning = 'ABSOLUTE';
    line.resize(TF_W, 1);
    line.x = 0; line.y = comp.height - 1;
    line.constraints = { horizontal: 'STRETCH', vertical: 'MAX' };
    line.fills = paintFor(R, '--light-500');
    parts[comp.name] = { label: label, hint: hint, lead: lead, line: line };
  }
  function wire(set) {
    var pL = ensureProp(set, 'label', 'TEXT', 'Jakarta');
    var pSH = ensureProp(set, 'showHint', 'BOOLEAN', false);
    var pH = ensureProp(set, 'hint', 'TEXT', '24 courses');
    var pSL = ensureProp(set, 'showLeadIcon', 'BOOLEAN', false);
    var pLI = ensureProp(set, 'leadIcon', 'INSTANCE_SWAP', icons.lead.id);
    var pD = ensureProp(set, 'showDivider', 'BOOLEAN', true);
    wireKeys(parts).forEach(function (k) {
      var p = parts[k];
      p.label.componentPropertyReferences = { characters: pL };
      p.hint.componentPropertyReferences = { visible: pSH, characters: pH };
      p.lead.componentPropertyReferences = { visible: pSL, mainComponent: pLI };
      p.line.componentPropertyReferences = { visible: pD };
    });
    set.description = '<button class="swing_option" role="option" aria-selected="{selected}"><span class="swing_option__text"><span class="swing_option__label">{label}</span><span class="swing_option__hint">{hint}</span></span></button> inside <div class="swing_options" role="listbox">. ' +
      'selected = purple-600 + B1 Semibold + check · pressed = :active (light-200). Min 56, 1px light-500 line under each; turn showDivider off on the last one.';
  }
  var set = await buildSet(page, 'Option', variants, buildVariant, wire, function () {}, R);
  var pv = pairUp(set, variants, function (c) { return parts[c.name]; });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'Option',
    description: 'One choice in the Select sheet. The picked one is purple with a check. Turn the divider off on the last row.',
    code: ['<div class="swing_options" role="listbox"><button class="swing_option" role="option" aria-selected="true"><span class="swing_option__text"><span class="swing_option__label">Jakarta</span></span></button></div>',
      'selected = aria-selected="true" · pressed = :active · leadIcon = .swing_option__lead · hint = .swing_option__hint'],
    colGroups: [{ label: 'state', cols: ['default', 'pressed'] }],
    rowGroups: [{ label: 'selected', rows: ['false', 'true'] }],
    place: function (v) { return { cg: 0, c: v.state === 'default' ? 0 : 1, rg: 0, r: v.selected === 'true' ? 1 : 0 }; }
  });
  return { set: set, count: variants.length };
}

async function buildSelectPage(R, notes) {
  var page = await pageNamed('Select');
  var solidOr = async function (n) { return (await findIcon('Icon/Solid/' + n)) || (await iconOrPlaceholder('Icon/Line/' + n, page, notes)); };
  var icons = {
    chevron: await iconOrPlaceholder('Icon/Line/chevron-down', page, notes),
    info: await iconOrPlaceholder('Icon/Line/info', page, notes),
    error: await solidOr('warning-circle'),
    check: await solidOr('checkmark'),
    lead: await iconOrPlaceholder('Icon/Line/gps', page, notes)
  };
  var a = await buildSelect(R, notes, page, icons);
  var b = await buildOption(R, notes, page, icons);
  return { set: a.set, count: a.count + b.count, label: 'Select ' + a.count + ', Option ' + b.count + ' variants' };
}

/* ----- MenuItem + Menu (components.css .menu, .menu__item) ----- */
var MI_TYPES = ['default', 'checked', 'danger'];

async function buildMenuItem(R, notes, page, icons) {
  var variants = [], parts = {};
  MI_TYPES.forEach(function (t) { ['default', 'pressed'].forEach(function (s) { variants.push({ type: t, state: s, name: 'type=' + t + ', state=' + s }); }); });
  async function buildVariant(comp, v) {
    var fg = v.type === 'checked' ? '--purple-600' : v.type === 'danger' ? '--red-700' : '--dark-500';
    var ico = v.type === 'danger' ? '--red-700' : v.type === 'checked' ? '--purple-600' : '--dark-300';
    comp.layoutMode = 'HORIZONTAL';
    comp.counterAxisAlignItems = 'CENTER';
    comp.resize(212, 44);
    comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'FIXED';
    bindNumber(R, comp, 'paddingLeft', '--space-12', 12);
    bindNumber(R, comp, 'paddingRight', '--space-12', 12);
    bindNumber(R, comp, 'itemSpacing', '--space-12', 12);
    bindRadius(R, comp, '--radius-8', 8);
    comp.fills = v.state === 'pressed' ? paintFor(R, '--light-300') : [];
    comp.strokes = [];
    var ic = icons.lead.createInstance();
    comp.appendChild(ic);
    ic.name = 'icon'; ic.resize(20, 20);
    recolorIcon(R, ic, ico);
    ic.visible = false;
    var label = await styledText(R, v.type === 'checked' ? '--type-b1s' : '--type-b1', fg, v.type === 'danger' ? 'Delete' : 'Newest first');
    comp.appendChild(label);
    label.name = 'label'; label.textAutoResize = 'WIDTH_AND_HEIGHT'; label.layoutGrow = 1;
    var ckBox = autoFrame('check', 'VERTICAL', comp);
    ckBox.primaryAxisAlignItems = 'CENTER'; ckBox.counterAxisAlignItems = 'CENTER';
    ckBox.resize(20, 20); ckBox.layoutSizingHorizontal = 'FIXED'; ckBox.layoutSizingVertical = 'FIXED';
    var ck = icons.check.createInstance();
    ckBox.appendChild(ck); ck.name = 'icon'; ck.resize(16, 16);
    recolorIcon(R, ck, '--purple-600');
    ckBox.visible = v.type === 'checked';
    parts[comp.name] = { label: label, ic: ic };
  }
  function wire(set) {
    var pL = ensureProp(set, 'label', 'TEXT', 'Newest first');
    var pS = ensureProp(set, 'showIcon', 'BOOLEAN', false);
    var pI = ensureProp(set, 'icon', 'INSTANCE_SWAP', icons.lead.id);
    wireKeys(parts).forEach(function (k) {
      parts[k].label.componentPropertyReferences = { characters: pL };
      parts[k].ic.componentPropertyReferences = { visible: pS, mainComponent: pI };
    });
    set.description = '<button class="swing_menu__item" role="menuitem">{label}</button>. type checked = role="menuitemradio" aria-checked="true" (purple-600, B1 Semibold, check) · danger = .swing_menu__item_danger (red-700) · pressed = :active / :hover (light-300). Min 44, radius 8, icon 20.';
  }
  var set = await buildSet(page, 'MenuItem', variants, buildVariant, wire, function () {}, R);
  var pv = pairUp(set, variants, function (c) { return parts[c.name]; });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'MenuItem',
    description: 'One action in a dropdown menu. checked marks the current choice (sort order); danger is for delete or cancel.',
    code: ['<button class="swing_menu__item" role="menuitem"><i class="swing_icon" …></i>Edit</button>',
      'type checked = aria-checked="true" · danger = .swing_menu__item_danger · state pressed = :active'],
    colGroups: [{ label: 'state', cols: ['default', 'pressed'] }],
    rowGroups: [{ label: 'type', rows: MI_TYPES }],
    place: function (v) { return { cg: 0, c: v.state === 'default' ? 0 : 1, rg: 0, r: MI_TYPES.indexOf(v.type) }; }
  });
  var by = {};
  set.children.forEach(function (c) { by[c.name] = c; });
  return { set: set, count: variants.length, get: function (t) { return by['type=' + t + ', state=default']; } };
}

async function buildMenu(R, notes, page, items) {
  var variants = [{ name: 'type=sort' }, { name: 'type=actions' }];
  async function buildVariant(comp, v) {
    comp.layoutMode = 'VERTICAL';
    comp.resize(220, 100);
    comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    comp.minWidth = 200; comp.maxWidth = 280;
    ['paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight'].forEach(function (f) { bindNumber(R, comp, f, '--space-4', 4); });
    comp.itemSpacing = 0;
    bindRadius(R, comp, '--radius-12', 12);
    comp.fills = paintFor(R, '--light-100');
    comp.strokes = paintFor(R, '--light-500'); comp.strokeWeight = 1; comp.strokeAlign = 'OUTSIDE';   // box-shadow 0 0 0 1px
    var el = R.effects['--elevation-2'];
    if (el) await comp.setEffectStyleIdAsync(el.id);
    var add = function (main, label) {
      var it = main.createInstance();
      comp.appendChild(it);
      it.layoutSizingHorizontal = 'FILL';
      try { it.setProperties(propKey(it, 'label', label)); } catch (e) { /* label stays default */ }
      return it;
    };
    if (v.name === 'type=sort') {
      var lab = await styledText(R, '--type-b3s', '--dark-200', 'Sort by');
      var labBox = autoFrame('label', 'HORIZONTAL', comp);
      labBox.layoutSizingHorizontal = 'FILL'; labBox.layoutSizingVertical = 'HUG';
      bindNumber(R, labBox, 'paddingLeft', '--space-12', 12); bindNumber(R, labBox, 'paddingRight', '--space-12', 12);
      bindNumber(R, labBox, 'paddingTop', '--space-8', 8); bindNumber(R, labBox, 'paddingBottom', '--space-4', 4);
      labBox.appendChild(lab); lab.name = 'text'; lab.textAutoResize = 'WIDTH_AND_HEIGHT';
      add(items.get('checked'), 'Newest first');
      add(items.get('default'), 'Nearest');
      add(items.get('default'), 'Price: low to high');
    } else {
      add(items.get('default'), 'Edit');
      add(items.get('default'), 'Share');
      var sepBox = autoFrame('separator', 'VERTICAL', comp);
      sepBox.layoutSizingHorizontal = 'FILL'; sepBox.layoutSizingVertical = 'HUG';
      bindNumber(R, sepBox, 'paddingTop', '--space-4', 4); bindNumber(R, sepBox, 'paddingBottom', '--space-4', 4);
      var sep = figma.createRectangle(); sepBox.appendChild(sep); sep.name = 'line'; sep.resize(212, 1);
      sep.layoutSizingHorizontal = 'FILL'; sep.fills = paintFor(R, '--light-500');
      add(items.get('danger'), 'Delete');
    }
  }
  function wire(set) {
    set.description = '<div class="swing_menu_wrap"><button aria-haspopup="menu">Sort</button><div class="swing_menu" role="menu">…swing_menu__item…</div></div>. Opens under its trigger (.swing_menu_end aligns right). ' +
      'Padding 4, radius 12, 1px light-500 ring, Elevation/Scale/2, width 200–280. Items are MenuItem instances: add, remove or reorder them in the instance.';
  }
  var set = await buildSet(page, 'Menu', variants, buildVariant, wire, function () {}, R);
  var pv = pairUp(set, variants, function (c) { return /^type=/.test(c.name); });
  pv.vs = pv.vs.map(function (v) { return { name: v.name, kind: v.name.split('=')[1] }; });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'Menu',
    description: 'A short list of actions that opens under its trigger: sort order, or the overflow menu. Built from MenuItem instances, so labels and items can change per screen.',
    code: ['<div class="swing_menu_wrap"><button class="swing_btn swing_btn_s swing_btn_soft" aria-haspopup="menu" aria-expanded="true">Sort</button><div class="swing_menu is-open" role="menu">…</div></div>',
      '.swing_menu_end aligns to the right edge of the trigger · .swing_menu__label = small heading · .swing_menu__sep = divider'],
    colGroups: [{ label: 'type', cols: ['sort', 'actions'] }],
    rowGroups: [{ label: 'example', rows: ['menu'] }],
    place: function (v) { return { cg: 0, c: v.kind === 'sort' ? 0 : 1, rg: 0, r: 0 }; }
  });
  return { set: set, count: variants.length };
}

// instance.setProperties needs the full key ("label#12:3")
function propsFor(inst, plain) {
  var o = {}, props = inst.componentProperties || {};
  for (var k in props) if (Object.prototype.hasOwnProperty.call(plain, k.split('#')[0])) o[k] = plain[k.split('#')[0]];
  return o;
}
function propKey(inst, name, value) {
  var o = {}, props = inst.componentProperties || {};
  for (var k in props) if (k.split('#')[0] === name) o[k] = value;
  return o;
}

async function buildMenuPage(R, notes) {
  var page = await pageNamed('Menu');
  var solidOr = async function (n) { return (await findIcon('Icon/Solid/' + n)) || (await iconOrPlaceholder('Icon/Line/' + n, page, notes)); };
  var icons = { lead: await iconOrPlaceholder('Icon/Line/pencil', page, notes), check: await solidOr('checkmark') };
  var a = await buildMenuItem(R, notes, page, icons);
  var b = await buildMenu(R, notes, page, a);
  return { set: a.set, count: a.count + b.count, label: 'MenuItem ' + a.count + ', Menu ' + b.count + ' variants' };
}

/* ----- ListItem + List (components.css .list, .list-item) ----- */
var LI_TRAIL = ['chevron', 'meta', 'dot', 'switch', 'none'];
var LI_W = 342;

// a bound 1px hairline pinned to the bottom of an auto-layout frame (CSS ::after / box-shadow line)
function bottomLine(R, parent, name, left, css) {
  var line = figma.createRectangle();
  parent.appendChild(line);
  line.name = name;
  line.layoutPositioning = 'ABSOLUTE';
  line.resize(Math.max(1, parent.width - left), 1);
  line.x = left; line.y = parent.height - 1;
  line.constraints = { horizontal: 'STRETCH', vertical: 'MAX' };
  line.fills = paintFor(R, css);
  return line;
}

async function switchSet(R, notes) {
  var pg = await pageNamed('Switch');
  var set = findLogical(pg, 'Switch');
  return set || (await buildSwitchPage(R, notes)).set;
}

async function buildListItem(R, notes, page, icons) {
  var sw = await switchSet(R, notes);
  var swOn = sw.children.find(function (c) { return /checked=true/.test(c.name) && /state=default/.test(c.name); }) || sw.children[0];
  var variants = [], parts = {};
  ['compact', 'standard'].forEach(function (sz) {
    LI_TRAIL.forEach(function (tr) {
      ['default', 'danger'].forEach(function (tn) {
        ['default', 'pressed'].forEach(function (st) {
          variants.push({ size: sz, trailing: tr, tone: tn, state: st, name: 'size=' + sz + ', trailing=' + tr + ', tone=' + tn + ', state=' + st });
        });
      });
    });
  });
  async function buildVariant(comp, v) {
    var danger = v.tone === 'danger', std = v.size === 'standard';
    comp.layoutMode = 'HORIZONTAL';
    comp.counterAxisAlignItems = 'CENTER';
    comp.resize(LI_W, std ? 76 : 56);
    comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    comp.minHeight = std ? 76 : 56;   // padding 16 + one line (24) / + body (20)
    bindNumber(R, comp, 'itemSpacing', '--space-12', 12);
    bindNumber(R, comp, 'paddingTop', '--space-16', 16);
    bindNumber(R, comp, 'paddingBottom', '--space-16', 16);
    comp.paddingLeft = 0; comp.paddingRight = 0;
    comp.fills = v.state === 'pressed' ? paintFor(R, '--light-200') : [];
    comp.strokes = [];
    var lead = icons.lead.createInstance();
    comp.appendChild(lead);
    lead.name = 'leadIcon'; lead.resize(24, 24);
    recolorIcon(R, lead, danger ? '--red-700' : '--dark-500');
    var col = autoFrame('text', 'VERTICAL', comp);
    col.layoutSizingHorizontal = 'FILL'; col.layoutSizingVertical = 'HUG';
    var title = await styledText(R, '--type-b1s', danger ? '--red-700' : '--dark-500', 'Account settings');
    col.appendChild(title);
    title.name = 'title'; title.textAutoResize = 'HEIGHT'; title.layoutSizingHorizontal = 'FILL'; title.textTruncation = 'ENDING';
    var p = { title: title, lead: lead };
    if (std) {
      var body = await styledText(R, '--type-b2', '--dark-300', 'Name, email and phone');
      col.appendChild(body);
      body.name = 'body'; body.textAutoResize = 'HEIGHT'; body.layoutSizingHorizontal = 'FILL';
      p.body = body;
    }
    if (v.trailing === 'meta' || v.trailing === 'chevron') {
      var meta = await styledText(R, '--type-b2', '--dark-300', 'English');
      comp.appendChild(meta);
      meta.name = 'meta'; meta.textAutoResize = 'WIDTH_AND_HEIGHT';
      meta.visible = v.trailing === 'meta';
      p.meta = meta;
    }
    if (v.trailing === 'chevron' || v.trailing === 'meta') {
      var chev = icons.chevron.createInstance();
      comp.appendChild(chev);
      chev.name = 'chevron'; chev.resize(20, 20);
      recolorIcon(R, chev, '--dark-200');
      chev.visible = v.trailing === 'chevron';
      if (v.trailing === 'meta') p.metaChev = chev;
    }
    if (v.trailing === 'dot') {
      var dot = figma.createEllipse();
      comp.appendChild(dot);
      dot.name = 'dot'; dot.resize(8, 8);
      dot.fills = paintFor(R, '--purple-500');
    }
    if (v.trailing === 'switch') {
      var s = swOn.createInstance();
      comp.appendChild(s);
      s.name = 'Switch';
    }
    p.line = bottomLine(R, comp, 'divider', 0, '--color-line');
    p.lineInset = bottomLine(R, comp, 'dividerInset', 36, '--color-line');   // .list--inset-icon: 24 + 12
    p.lineInset.visible = false;
    parts[comp.name] = p;
  }
  function wire(set) {
    var pT = ensureProp(set, 'title', 'TEXT', 'Account settings');
    var pB = ensureProp(set, 'body', 'TEXT', 'Name, email and phone');
    var pM = ensureProp(set, 'meta', 'TEXT', 'English');
    var pSM = ensureProp(set, 'showChevron', 'BOOLEAN', true);
    var pSL = ensureProp(set, 'showLeadIcon', 'BOOLEAN', true);
    var pLI = ensureProp(set, 'leadIcon', 'INSTANCE_SWAP', icons.lead.id);
    var pD = ensureProp(set, 'showDivider', 'BOOLEAN', true);
    var pDI = ensureProp(set, 'insetDivider', 'BOOLEAN', false);
    wireKeys(parts).forEach(function (k) {
      var p = parts[k];
      p.title.componentPropertyReferences = { characters: pT };
      if (p.body) p.body.componentPropertyReferences = { characters: pB };
      if (p.meta) p.meta.componentPropertyReferences = { characters: pM };
      if (p.metaChev) p.metaChev.componentPropertyReferences = { visible: pSM };
      p.lead.componentPropertyReferences = { visible: pSL, mainComponent: pLI };
      p.line.componentPropertyReferences = { visible: pD };
      p.lineInset.componentPropertyReferences = { visible: pDI };
    });
    set.description = '<a class="swing_list_item [swing_list_item_standard] [swing_list_item_danger]"><span class="swing_list_item__lead">…</span><span class="swing_list_item__text"><span class="swing_list_item__title">{title}</span><span class="swing_list_item__body">{body}</span></span>…trailing…</a> inside <div class="swing_list">. ' +
      'size compact = title only, padding 16, min 56 · standard = title + body, min 76. trailing chevron = .swing_list_item__chev · meta = .swing_list_item__meta (+ chevron, showChevron) · dot = .swing_list_item__dot · switch = .swing_switch · none. tone danger = .swing_list_item_danger. pressed = :active. ' +
      'Turn showDivider off on the last row (CSS hides it). insetDivider = .swing_list_inset_icon (line starts at the text). Width 342: set to Fill.';
  }
  var set = await buildSet(page, 'ListItem', variants, buildVariant, wire, function () {}, R);
  var pv = pairUp(set, variants, function (c) { return parts[c.name]; });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'ListItem',
    description: 'One row of a list: settings, a booking, a toggle. Compact is title only, standard adds a body line. The row is the tap target; the divider stops after the last row.',
    code: ['<div class="swing_list swing_list_inset_icon"><a class="swing_list_item" href="#"><span class="swing_list_item__lead"><i class="swing_icon" …></i></span><span class="swing_list_item__text"><span class="swing_list_item__title">Account settings</span></span><i class="swing_icon swing_list_item__chev" …></i></a></div>',
      'size standard = .swing_list_item_standard · tone danger = .swing_list_item_danger · trailing meta = .swing_list_item__meta · dot = .swing_list_item__dot · switch = .swing_switch'],
    colGroups: [{ label: 'tone default', cols: ['default', 'pressed'] }, { label: 'tone danger', cols: ['default', 'pressed'] }],
    rowGroups: [{ label: 'size compact', rows: LI_TRAIL }, { label: 'size standard', rows: LI_TRAIL }],
    place: function (v) { return { cg: v.tone === 'danger' ? 1 : 0, c: v.state === 'pressed' ? 1 : 0, rg: v.size === 'standard' ? 1 : 0, r: LI_TRAIL.indexOf(v.trailing) }; }
  });
  var by = {};
  set.children.forEach(function (c) { by[c.name] = c; });
  return { set: set, count: variants.length, get: function (sz, tr, tn) { return by['size=' + sz + ', trailing=' + tr + ', tone=' + (tn || 'default') + ', state=default']; } };
}

async function buildList(R, notes, page, items, icons) {
  var variants = [{ name: 'type=settings', kind: 'settings' }, { name: 'type=bookings', kind: 'bookings' }, { name: 'type=controls', kind: 'controls' }];
  async function head(comp, text) {
    var box = autoFrame('head', 'HORIZONTAL', comp);
    box.layoutSizingHorizontal = 'FILL'; box.layoutSizingVertical = 'HUG';
    bindNumber(R, box, 'paddingTop', '--space-16', 16);
    bindNumber(R, box, 'paddingBottom', '--space-4', 4);
    var t = await styledText(R, '--type-b2s', '--dark-300', text);
    box.appendChild(t); t.name = 'text'; t.textAutoResize = 'WIDTH_AND_HEIGHT';
  }
  function add(comp, main, props, swapIcon) {
    var it = main.createInstance();
    comp.appendChild(it);
    it.layoutSizingHorizontal = 'FILL';
    if (swapIcon) props.leadIcon = swapIcon.id;
    try { it.setProperties(propsFor(it, props)); } catch (e) { /* defaults stay */ }
    return it;
  }
  async function buildVariant(comp, v) {
    comp.layoutMode = 'VERTICAL';
    comp.resize(LI_W, 100);
    comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    comp.itemSpacing = 0;
    comp.fills = [];
    if (v.kind === 'settings') {
      await head(comp, 'Account');
      add(comp, items.get('compact', 'chevron'), { title: 'Profile', showDivider: false, insetDivider: true }, icons.user);
      add(comp, items.get('compact', 'meta'), { title: 'Language', meta: 'English', showDivider: false, insetDivider: true }, icons.lead);
      add(comp, items.get('compact', 'chevron'), { title: 'Golf preferences', showDivider: false, insetDivider: true }, icons.golf);
      add(comp, items.get('compact', 'none', 'danger'), { title: 'Log out', showDivider: false }, icons.logout);
    } else if (v.kind === 'bookings') {
      add(comp, items.get('standard', 'meta'), { title: 'Pondok Indah Golf Course', body: 'Sat, 14 Nov · 07:00 · 4 players', meta: 'Rp 1.2jt', showLeadIcon: false, showChevron: false });
      add(comp, items.get('standard', 'dot'), { title: 'Damai Indah Golf', body: 'Sun, 15 Nov · 06:30 · 2 players', showLeadIcon: false });
      add(comp, items.get('standard', 'chevron'), { title: 'Royale Jakarta Golf Club', body: 'Sat, 21 Nov · 08:00 · 3 players', showLeadIcon: false, showDivider: false });
    } else {
      await head(comp, 'Notifications');
      add(comp, items.get('standard', 'switch'), { title: 'Tee time reminders', body: 'A day and an hour before', showLeadIcon: false });
      add(comp, items.get('standard', 'switch'), { title: 'Game invites', body: 'When a player asks you to join', showLeadIcon: false, showDivider: false });
    }
  }
  function wire(set) {
    set.description = '<div class="swing_list [swing_list_inset_icon] [swing_list_flush]">…list-item…</div> with an optional <p class="swing_list__head">. Rows are ListItem instances: add, remove or reorder them, and turn showDivider off on the last one.';
  }
  var set = await buildSet(page, 'List', variants, buildVariant, wire, function () {}, R);
  var pv = pairUp(set, variants, function (c) { return /^type=/.test(c.name); });
  pv.vs = pv.vs.map(function (x) { return { name: x.name, kind: x.name.split('=')[1] }; });
  var KINDS = ['settings', 'bookings', 'controls'];
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'List',
    description: 'Ready lists built from ListItem instances: a settings group with icons (inset divider), bookings with a body line, and switches.',
    code: ['<p class="swing_list__head">Account</p><div class="swing_list swing_list_inset_icon">…</div>',
      '.swing_list_inset_icon / --inset-avatar = divider starts at the text · .swing_list_flush = no dividers (inside a card) · .swing_list_bleed = pressed row reaches the screen edge'],
    colGroups: [{ label: 'type', cols: KINDS }],
    rowGroups: [{ label: 'example', rows: ['list'] }],
    place: function (v) { return { cg: 0, c: KINDS.indexOf(v.kind), rg: 0, r: 0 }; }
  });
  return { set: set, count: variants.length };
}

async function buildListPage(R, notes) {
  var page = await pageNamed('List');
  var icons = {
    lead: await iconOrPlaceholder('Icon/Line/settings', page, notes),
    chevron: await iconOrPlaceholder('Icon/Line/chevron-right', page, notes),
    user: await iconOrPlaceholder('Icon/Line/user', page, notes),
    golf: await iconOrPlaceholder('Icon/Line/golf', page, notes),
    logout: await iconOrPlaceholder('Icon/Line/logout', page, notes)
  };
  var a = await buildListItem(R, notes, page, icons);
  var b = await buildList(R, notes, page, a, icons);
  notes.push('ListItem: on the web the chevron pulls 4px into the right edge (margin-right -4); Figma has no negative margin. Accordion rows (.swing_list_acc) are not a component yet.');
  return { set: a.set, count: a.count + b.count, label: 'ListItem ' + a.count + ', List ' + b.count + ' variants' };
}

/* ----- Tab + Tabs (components.css .tabs, .tab) ----- */
function lineBelow(R) {   // --line-sticky: 0 1px 0 var(--light-500)
  var c = R.color['--light-500'] || { r: 0.9, g: 0.9, b: 0.92, a: 1 };
  var fx = { type: 'DROP_SHADOW', color: { r: c.r, g: c.g, b: c.b, a: 1 }, offset: { x: 0, y: 1 }, radius: 0, spread: 0,
    visible: true, blendMode: 'NORMAL', showShadowBehindNode: false };
  var v = R.v('--light-500');
  try { if (v) fx = figma.variables.setBoundVariableForEffect(fx, 'color', v); } catch (e) { /* plain colour */ }
  return [fx];
}

async function buildTab(R, notes, page, icons) {
  var variants = [], parts = {};
  ['l', 's'].forEach(function (sz) { ['false', 'true'].forEach(function (sel) { variants.push({ size: sz, selected: sel, name: 'size=' + sz + ', selected=' + sel }); }); });
  async function buildVariant(comp, v) {
    var s = v.size === 's', on = v.selected === 'true', fg = on ? '--purple-600' : '--dark-300', px = s ? 8 : 12;
    comp.layoutMode = 'HORIZONTAL';
    comp.primaryAxisAlignItems = 'CENTER'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(100, 44);
    comp.layoutSizingHorizontal = 'HUG'; comp.layoutSizingVertical = 'FIXED';
    bindNumber(R, comp, 'paddingLeft', s ? '--space-8' : '--space-12', px);
    bindNumber(R, comp, 'paddingRight', s ? '--space-8' : '--space-12', px);
    bindNumber(R, comp, 'itemSpacing', s ? '--gap-tight' : '--gap-related', s ? 4 : 8);
    comp.fills = [];
    var ic = icons.icon.createInstance();
    comp.appendChild(ic);
    ic.name = 'icon'; ic.resize(s ? 16 : 20, s ? 16 : 20);
    recolorIcon(R, ic, fg);
    ic.visible = false;
    var t = await styledText(R, s ? '--type-b2s' : '--type-h6', fg, 'Reservations');
    comp.appendChild(t);
    t.name = 'label'; t.textAutoResize = 'WIDTH_AND_HEIGHT';
    var bar = figma.createRectangle();   // ::after, 2px, inset by the side padding
    comp.appendChild(bar);
    bar.name = 'indicator';
    bar.layoutPositioning = 'ABSOLUTE';
    bar.resize(Math.max(1, comp.width - px * 2), 2);
    bar.x = px; bar.y = comp.height - 2;
    bar.constraints = { horizontal: 'STRETCH', vertical: 'MAX' };
    bar.fills = paintFor(R, '--purple-500');
    pillRadius(bar, 2);
    bar.visible = on;
    parts[comp.name] = { label: t, icon: ic };
  }
  function wire(set) {
    var pL = ensureProp(set, 'label', 'TEXT', 'Reservations');
    var pS = ensureProp(set, 'showIcon', 'BOOLEAN', false);
    var pI = ensureProp(set, 'icon', 'INSTANCE_SWAP', icons.icon.id);
    wireKeys(parts).forEach(function (k) {
      parts[k].label.componentPropertyReferences = { characters: pL };
      parts[k].icon.componentPropertyReferences = { visible: pS, mainComponent: pI };
    });
    set.description = '<button class="swing_tab" role="tab" aria-selected="{selected}">{label}</button>. size l = H6, padding 12, icon 20 · s = .swing_tabs_s (B2 Semibold, padding 8, icon 16). Height 44 (tap-min). selected = purple-600 + 2px purple-500 bar.';
  }
  var set = await buildSet(page, 'Tab', variants, buildVariant, wire, function () {}, R);
  var pv = pairUp(set, variants, function (c) { return parts[c.name]; });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'Tab',
    description: 'One tab. The selected one is purple with a 2px bar under the label. Use the small size for second-level tabs inside a card or sheet.',
    code: ['<button class="swing_tab" role="tab" aria-selected="true">Reservations</button>', 'selected = aria-selected="true" · size s = inside .swing_tabs_s · showIcon = <i class="swing_icon"> before the label'],
    colGroups: [{ label: 'selected', cols: ['false', 'true'] }],
    rowGroups: [{ label: 'size', rows: ['l', 's'] }],
    place: function (v) { return { cg: 0, c: v.selected === 'true' ? 1 : 0, rg: 0, r: v.size === 's' ? 1 : 0 }; }
  });
  var by = {};
  set.children.forEach(function (c) { by[c.name] = c; });
  return { set: set, count: variants.length, get: function (sz, sel) { return by['size=' + sz + ', selected=' + sel]; } };
}

async function buildTabs(R, notes, page, tab) {
  var variants = [];
  ['flexible', 'fixed'].forEach(function (t) { ['l', 's'].forEach(function (sz) { variants.push({ type: t, size: sz, name: 'type=' + t + ', size=' + sz }); }); });
  async function buildVariant(comp, v) {
    var fixed = v.type === 'fixed', s = v.size === 's';
    comp.layoutMode = 'HORIZONTAL';
    comp.resize(390, 44);
    comp.layoutSizingHorizontal = fixed ? 'FIXED' : 'HUG'; comp.layoutSizingVertical = 'HUG';
    comp.itemSpacing = 0;
    bindNumber(R, comp, 'paddingLeft', s ? '--space-8' : '--space-12', s ? 8 : 12);
    bindNumber(R, comp, 'paddingRight', s ? '--space-8' : '--space-12', s ? 8 : 12);
    comp.fills = paintFor(R, '--color-bg');
    comp.effects = lineBelow(R);
    var labels = fixed ? ['Upcoming', 'Past', 'Cancelled'] : ['Reservations', 'Courses', 'Players', 'Events'];
    labels.forEach(function (l, i) {
      var it = tab.get(v.size, i === 0 ? 'true' : 'false').createInstance();
      comp.appendChild(it);
      if (fixed) it.layoutSizingHorizontal = 'FILL';   // .tabs--fixed .tab { flex: 1 1 0 }
      try { it.setProperties(propsFor(it, { label: l })); } catch (e) { /* default label */ }
    });
  }
  function wire(set) {
    set.description = '<div class="swing_tabs [swing_tabs_fixed] [swing_tabs_s]" role="tablist">…tab…</div>. Padding 12 (s: 8) so the first label lines up with the page edge, 1px light-500 line under (--line-sticky). ' +
      'type flexible = tabs hug their label and scroll sideways · fixed = equal widths, max 4, width 390 (set to Fill). Tabs are Tab instances: swap selected, edit labels, add or remove.';
  }
  var set = await buildSet(page, 'Tabs', variants, buildVariant, wire, function () {}, R);
  var pv = pairUp(set, variants, function (c) { return /^type=/.test(c.name); });
  pv.vs = pv.vs.map(function (x) { var m = /type=(\w+), size=(\w+)/.exec(x.name); return { name: x.name, type: m[1], size: m[2] }; });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'Tabs',
    description: 'A row of Tab instances with the base line under it. Flexible tabs hug their labels and scroll; fixed tabs split the width equally (max 4).',
    code: ['<div class="swing_tabs" role="tablist"><button class="swing_tab" role="tab" aria-selected="true">Reservations</button>…</div>',
      'type fixed = .swing_tabs_fixed · size s = .swing_tabs_s · .swing_tabs_flush = no side padding inside a padded container'],
    colGroups: [{ label: 'size', cols: ['l', 's'] }],
    rowGroups: [{ label: 'type', rows: ['flexible', 'fixed'] }],
    place: function (v) { return { cg: 0, c: v.size === 's' ? 1 : 0, rg: 0, r: v.type === 'fixed' ? 1 : 0 }; }
  });
  return { set: set, count: variants.length };
}

async function buildTabsPage(R, notes) {
  var page = await pageNamed('Tabs');
  var icons = { icon: await iconOrPlaceholder('Icon/Line/golf', page, notes) };
  var a = await buildTab(R, notes, page, icons);
  var b = await buildTabs(R, notes, page, a);
  return { set: a.set, count: a.count + b.count, label: 'Tab ' + a.count + ', Tabs ' + b.count + ' variants' };
}

/* ----- Divider (components.css .divider) ----- */
var DIV_TYPES = ['line', 'inset', 'insetAvatar', 'label', 'labelStart', 'band', 'vertical'];

async function buildDividerPage(R, notes) {
  var page = await pageNamed('Divider');
  var variants = DIV_TYPES.map(function (t) { return { type: t, name: 'type=' + t }; }), parts = {};
  function rule(parent, name, css, h) {
    var r = figma.createRectangle();
    parent.appendChild(r);
    r.name = name; r.resize(10, h || 1);
    r.fills = paintFor(R, css || '--color-line');
    return r;
  }
  async function buildVariant(comp, v) {
    comp.fills = [];
    if (v.type === 'vertical') {   // .divider--v: inline 1x16 between meta items
      comp.resize(1, 16);
      comp.fills = paintFor(R, '--color-line');
      return;
    }
    if (v.type === 'band') {       // 8px light-300 band, edge to edge (390)
      comp.resize(390, 8);
      comp.fills = paintFor(R, '--color-band');
      return;
    }
    comp.layoutMode = 'HORIZONTAL';
    comp.counterAxisAlignItems = 'CENTER';
    comp.resize(342, 1);
    comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    if (v.type === 'label' || v.type === 'labelStart') {
      bindNumber(R, comp, 'itemSpacing', '--space-16', 16);
      var a = rule(comp, 'line');
      if (v.type === 'label') a.layoutSizingHorizontal = 'FILL'; else a.resize(16, 1);
      var t = await styledText(R, '--type-b2s', '--dark-300', 'Monday, 03 January 2026');
      comp.appendChild(t);
      t.name = 'label'; t.textAutoResize = 'WIDTH_AND_HEIGHT';
      rule(comp, 'line').layoutSizingHorizontal = 'FILL';
      parts[comp.name] = { label: t };
      return;
    }
    var inset = v.type === 'inset' ? 32 : v.type === 'insetAvatar' ? 44 : 0;
    comp.paddingLeft = inset;
    if (v.type === 'inset') bindNumber(R, comp, 'paddingLeft', '--space-32', 32);   // insetAvatar is calc(32 + 12): no single token
    rule(comp, 'line').layoutSizingHorizontal = 'FILL';
  }
  function wire(set) {
    var pL = ensureProp(set, 'label', 'TEXT', 'Monday, 03 January 2026');
    wireKeys(parts).forEach(function (k) { parts[k].label.componentPropertyReferences = { characters: pL }; });
    set.description = '<hr class="swing_divider [swing_divider_inset|swing_divider_inset_avatar|swing_divider_band]"> · <div class="swing_divider swing_divider_label [swing_divider_label_start]" role="separator"><span>{label}</span></div> · <span class="swing_divider swing_divider_v"></span>. ' +
      'line = 1px --color-line · inset starts after a 20 icon + 12 gap (32) · insetAvatar after Avatar S + 12 (44) · band = 8px --color-band edge to edge · vertical = 1x16 between meta items. Space around it comes from the parent gap, never the divider.';
  }
  var set = await buildSet(page, 'Divider', variants, buildVariant, wire, function () {}, R);
  var pv = pairUp(set, variants, function (c) { return /^type=/.test(c.name); });
  pv.vs = pv.vs.map(function (x) { return { name: x.name, type: x.name.split('=')[1] }; });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'Divider',
    description: 'A 1px line between items, a dated separator for feeds and chat, an 8px band between big sections, or a short vertical line between meta items.',
    code: ['<hr class="swing_divider">', 'type inset = .swing_divider_inset · insetAvatar = .swing_divider_inset_avatar · label = .swing_divider_label · labelStart = .swing_divider_label_start · band = .swing_divider_band · vertical = .swing_divider_v'],
    colGroups: [{ label: 'example', cols: ['divider'] }],
    rowGroups: [{ label: 'type', rows: DIV_TYPES }],
    place: function (v) { return { cg: 0, c: 0, rg: 0, r: DIV_TYPES.indexOf(v.type) }; }
  });
  return { set: set, count: variants.length, label: 'Divider ' + variants.length + ' variants' };
}

/* ----- Avatar + AvatarGroup (components.css .avatar, .avatar-group) ----- */
var AV_SIZES = { xs: 16, s: 32, m: 48, l: 96 };
var AV_TYPES = ['initials', 'picture', 'guest'];

async function buildAvatar(R, notes, page, icons) {
  var variants = [], parts = {};
  wireKeys(AV_SIZES).forEach(function (sz) { AV_TYPES.forEach(function (t) { variants.push({ size: sz, type: t, name: 'size=' + sz + ', type=' + t }); }); });
  async function buildVariant(comp, v) {
    var d = AV_SIZES[v.size], pad = v.size === 'xs' ? 0 : 8;
    comp.layoutMode = 'HORIZONTAL';
    comp.primaryAxisAlignItems = 'CENTER'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(d, d);
    comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'FIXED';
    comp.paddingLeft = comp.paddingRight = comp.paddingTop = comp.paddingBottom = v.type === 'picture' ? 0 : pad;
    comp.clipsContent = true;
    pillRadius(comp, d);
    if (v.type === 'initials') {
      comp.fills = paintFor(R, '--dark-500');
      var t = await styledText(R, v.size === 'xs' ? '--type-lbl-s' : v.size === 'l' ? '--type-h2' : '--type-lbl-l', '--light-100', 'GH');
      comp.appendChild(t);
      t.name = 'initials'; t.textAutoResize = 'WIDTH_AND_HEIGHT';
      parts[comp.name] = { initials: t };
    } else if (v.type === 'guest') {
      comp.fills = paintFor(R, '--light-300');
      var g = icons.guest.createInstance();
      comp.appendChild(g);
      g.name = 'icon'; g.resize(d - pad * 2, d - pad * 2);
      recolorIcon(R, g, '--dark-100');
    } else {
      comp.fills = paintFor(R, '--dark-500');   // shows if the photo fails, like the initials under the <img>
      var ph = figma.createRectangle();
      comp.appendChild(ph);
      ph.name = 'photo (replace image fill)';
      ph.resize(d, d);
      ph.layoutSizingHorizontal = 'FILL'; ph.layoutSizingVertical = 'FILL';
      ph.fills = paintFor(R, '--purple-100');
    }
  }
  function wire(set) {
    var pI = ensureProp(set, 'initials', 'TEXT', 'GH');
    wireKeys(parts).forEach(function (k) { parts[k].initials.componentPropertyReferences = { characters: pI }; });
    set.description = '<span class="swing_avatar swing_avatar_{size} [swing_avatar_guest]">{initials}<img …></span>. size xs 16 (Label Small) · s 32 · m 48 (default, Label Large) · l 96 (H2). ' +
      'initials = dark-500 + white · picture = photo over the initials (replace the photo layer\'s image fill) · guest = light-300 + person icon dark-100. Always a circle.';
  }
  var set = await buildSet(page, 'Avatar', variants, buildVariant, wire, function () {}, R);
  var pv = pairUp(set, variants, function (c) { return /^size=/.test(c.name); });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'Avatar',
    description: 'A person: initials on dark, their photo, or the guest icon when there is neither. Four sizes; m is the default.',
    code: ['<span class="swing_avatar">GH</span> · <span class="swing_avatar swing_avatar_s">GH<img src="…" alt=""></span> · <span class="swing_avatar swing_avatar_guest"><svg …></svg></span>', 'size xs / s / m / l = .swing_avatar_xs / --s / --m / --l · type guest = .swing_avatar_guest'],
    colGroups: [{ label: 'type', cols: AV_TYPES }],
    rowGroups: [{ label: 'size', rows: Object.keys(AV_SIZES) }],
    place: function (v) { return { cg: 0, c: AV_TYPES.indexOf(v.type), rg: 0, r: Object.keys(AV_SIZES).indexOf(v.size) }; }
  });
  var by = {};
  set.children.forEach(function (c) { by[c.name] = c; });
  return { set: set, count: variants.length, get: function (sz, t) { return by['size=' + sz + ', type=' + t]; } };
}

async function buildAvatarGroup(R, notes, page, av) {
  var G = { xs: { av: 'xs', step: 4, gap: 4, ring: 1, type: '--type-b3s' }, s: { av: 's', step: 8, gap: 8, ring: 2, type: '--type-b2s' }, l: { av: 'm', step: 16, gap: 8, ring: 2, type: '--type-b1s' } };
  var variants = ['xs', 's', 'l'].map(function (sz) { return { size: sz, name: 'size=' + sz }; }), parts = {};
  var ring = bgRing(R)[0];
  async function buildVariant(comp, v) {
    var g = G[v.size];
    comp.layoutMode = 'HORIZONTAL';
    comp.counterAxisAlignItems = 'CENTER';
    comp.layoutSizingHorizontal = 'HUG'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', g.gap === 4 ? '--gap-tight' : '--gap-related', g.gap);
    comp.fills = [];
    var stack = autoFrame('stack', 'HORIZONTAL', comp);
    stack.layoutSizingHorizontal = 'HUG'; stack.layoutSizingVertical = 'HUG';
    stack.itemSpacing = -g.step;   // .avatar + .avatar { margin-left: -step }
    [['initials', 'GH'], ['picture'], ['initials', 'AR'], ['guest']].forEach(function (a) {
      var it = av.get(g.av, a[0]).createInstance();
      stack.appendChild(it);
      it.effects = [Object.assign({}, ring, { spread: g.ring })];   // 0 0 0 ring var(--color-bg)
      if (a[1]) { try { it.setProperties(propsFor(it, { initials: a[1] })); } catch (e) { /* default */ } }
    });
    var t = await styledText(R, g.type, '--color-text-secondary', '+8 joined');
    comp.appendChild(t);
    t.name = 'label'; t.textAutoResize = 'WIDTH_AND_HEIGHT';
    parts[comp.name] = { label: t };
  }
  function wire(set) {
    var pS = ensureProp(set, 'showLabel', 'BOOLEAN', true);
    var pL = ensureProp(set, 'label', 'TEXT', '+8 joined');
    wireKeys(parts).forEach(function (k) { parts[k].label.componentPropertyReferences = { visible: pS, characters: pL }; });
    set.description = '<div class="swing_avatar_group [swing_avatar_group_s|--xs]"><div class="swing_avatar_group__stack">…avatar…</div><span class="swing_avatar_group__label">{label}</span></div>. Up to 4 avatars, each with a ring in --color-bg. ' +
      'size l = Avatar m 48, overlap 16, B1 Semibold · s = Avatar s 32, overlap 8, B2 Semibold · xs = Avatar xs 16, overlap 4, ring 1, B3 Semibold. Hide or swap avatars in the stack.';
  }
  var set = await buildSet(page, 'AvatarGroup', variants, buildVariant, wire, function () {}, R);
  var pv = pairUp(set, variants, function (c) { return parts[c.name]; });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'AvatarGroup',
    description: 'Who is in a flight or a community: up to four overlapping avatars and a count.',
    code: ['<div class="swing_avatar_group"><div class="swing_avatar_group__stack"><span class="swing_avatar">GH</span>…</div><span class="swing_avatar_group__label">+8 joined</span></div>', 'size s = .swing_avatar_group_s · xs = .swing_avatar_group_xs'],
    colGroups: [{ label: 'example', cols: ['group'] }],
    rowGroups: [{ label: 'size', rows: ['l', 's', 'xs'] }],
    place: function (v) { return { cg: 0, c: 0, rg: 0, r: ['l', 's', 'xs'].indexOf(v.size) }; }
  });
  return { set: set, count: variants.length };
}

async function buildAvatarPage(R, notes) {
  var page = await pageNamed('Avatar');
  var guest = (await findIcon('Icon/Solid/user')) || (await iconOrPlaceholder('Icon/Line/user', page, notes));
  var a = await buildAvatar(R, notes, page, { guest: guest });
  var b = await buildAvatarGroup(R, notes, page, a);
  return { set: a.set, count: a.count + b.count, label: 'Avatar ' + a.count + ', AvatarGroup ' + b.count + ' variants' };
}

/* ----- Caption (components.css .caption) ----- */
var CAP_TONES = { neutral: ['--dark-300', 'info'], error: ['--red-500', 'warning-circle'], warning: ['--orange-700', 'warning-circle'], success: ['--color-success', 'tick-circle'] };

async function buildCaptionPage(R, notes) {
  var page = await pageNamed('Caption');
  var solidOr = async function (n) { return (await findIcon('Icon/Solid/' + n)) || (await iconOrPlaceholder('Icon/Line/' + n, page, notes)); };
  var icons = { neutral: await iconOrPlaceholder('Icon/Line/info', page, notes), error: await solidOr('warning-circle'),
    warning: await iconOrPlaceholder('Icon/Line/warning-circle', page, notes), success: await solidOr('tick-circle') };
  var variants = [], parts = {};
  wireKeys(CAP_TONES).forEach(function (t) { ['m', 's'].forEach(function (sz) { variants.push({ tone: t, size: sz, name: 'tone=' + t + ', size=' + sz }); }); });
  var TEXT = { neutral: 'Free cancellation until 24 hours before', error: 'Pick a payment method', warning: 'Only 2 slots left', success: 'Booking confirmed' };
  async function buildVariant(comp, v) {
    var fg = CAP_TONES[v.tone][0], s = v.size === 's';
    comp.layoutMode = 'HORIZONTAL';
    comp.counterAxisAlignItems = 'MIN';
    comp.layoutSizingHorizontal = 'HUG'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--gap-tight', 4);
    comp.fills = [];
    var box = autoFrame('icon', 'VERTICAL', comp);   // 16 glyph centred on the 20 line (s: 12 on 16)
    box.primaryAxisAlignItems = 'CENTER'; box.counterAxisAlignItems = 'CENTER';
    box.resize(s ? 12 : 16, s ? 16 : 20); box.layoutSizingHorizontal = 'FIXED'; box.layoutSizingVertical = 'FIXED';
    var ic = icons[v.tone].createInstance();
    box.appendChild(ic); ic.name = 'icon'; ic.resize(s ? 12 : 16, s ? 12 : 16);
    recolorIcon(R, ic, fg);
    var t = await styledText(R, s ? '--type-b3' : '--type-b2', fg, TEXT[v.tone]);
    comp.appendChild(t);
    t.name = 'text'; t.textAutoResize = 'WIDTH_AND_HEIGHT';
    parts[comp.name] = { text: t };
  }
  function wire(set) {
    var pT = ensureProp(set, 'text', 'TEXT', 'Free cancellation until 24 hours before');
    wireKeys(parts).forEach(function (k) { parts[k].text.componentPropertyReferences = { characters: pT }; });
    set.description = '<p class="swing_caption [swing_caption_error|--warning|--success] [swing_caption_s]"><i class="swing_icon" …></i>{text}</p>. One short line under a control or in a card; the icon keeps the meaning from being colour-only. ' +
      'neutral = dark-300 + line/info · error = red-500 + solid/warning-circle · warning = orange-700 + line/warning-circle · success = green-500 (--color-success) + solid/tick-circle. size m = B2 + icon 16 · s = B3 + icon 12. Link with aria-describedby.';
  }
  var set = await buildSet(page, 'Caption', variants, buildVariant, wire, function () {}, R);
  var pv = pairUp(set, variants, function (c) { return parts[c.name]; });
  var TONES = Object.keys(CAP_TONES);
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'Caption',
    description: 'A short status line with an icon: under a control, inside a card, next to a price. Inside a TextField the help line is the same thing.',
    code: ['<p class="swing_caption swing_caption_error" id="pay-err"><i class="swing_icon" style="--icon:url(…/solid/warning-circle.svg)"></i>Pick a payment method</p>', 'tone = .swing_caption_error / --warning / --success · size s = .swing_caption_s'],
    colGroups: [{ label: 'size', cols: ['m', 's'] }],
    rowGroups: [{ label: 'tone', rows: TONES }],
    place: function (v) { return { cg: 0, c: v.size === 's' ? 1 : 0, rg: 0, r: TONES.indexOf(v.tone) }; }
  });
  return { set: set, count: variants.length, label: 'Caption ' + variants.length + ' variants' };
}

/* ----- Pagination (components.css .dots, .dot, .dots-count, .segments, .seg) ----- */
// small sets with no text props: name every variant from its fields, pair by name
function simpleSet(variants) { return variants.map(function (v) { v.name = Object.keys(v).filter(function (k) { return k !== 'name'; }).map(function (k) { return k + '=' + v[k]; }).join(', '); return v; }); }
function byName(set) { var o = {}; set.children.forEach(function (c) { o[c.name] = c; }); return o; }

async function buildPaginationPage(R, notes) {
  var page = await pageNamed('Pagination');
  // Dot
  var dv = simpleSet([{ active: 'false', onMedia: 'false' }, { active: 'true', onMedia: 'false' }, { active: 'false', onMedia: 'true' }, { active: 'true', onMedia: 'true' }]);
  var dot = await buildSet(page, 'Dot', dv, async function (comp, v) {
    var on = v.active === 'true', m = v.onMedia === 'true', d = on ? 8 : 4;
    comp.resize(d, d);
    pillRadius(comp, d);
    comp.fills = paintFor(R, m ? '--light-100' : on ? '--purple-500' : '--dark-100');
    if (m && !on) comp.opacity = 0.48;
  }, function (set) { set.description = '<i class="swing_dot [is-active]"></i> inside .swing_dots. Off 4px dark-100 · active 8px purple-500 · onMedia (inside .swing_dots_on_media) = white, off dots at 48%. An indicator, never a tap target.'; }, function () {}, R);
  var pd = pairUp(dot, dv, function (c) { return /^active=/.test(c.name); });
  await docArtboard(R, page, dot, pd.comps, pd.vs, {
    title: 'Dot', description: 'One page dot. The active page is bigger and purple.',
    code: ['<i class="swing_dot is-active"></i>', 'active = .is-active · onMedia = inside .swing_dots_on_media'],
    colGroups: [{ label: 'active', cols: ['false', 'true'] }], rowGroups: [{ label: 'onMedia', rows: ['false', 'true'] }],
    place: function (v) { return { cg: 0, c: v.active === 'true' ? 1 : 0, rg: 0, r: v.onMedia === 'true' ? 1 : 0 }; },
    minCell: 80, minRow: 40, center: true,
    backdrop: function (v) { return v.onMedia === 'true' ? '--dark-500' : null; }
  });
  var D = byName(dot);
  // Dots
  var dsv = simpleSet([{ pages: '3', onMedia: 'false' }, { pages: '5', onMedia: 'false' }, { pages: '3', onMedia: 'true' }, { pages: '5', onMedia: 'true' }]);
  var dots = await buildSet(page, 'Dots', dsv, async function (comp, v) {
    comp.layoutMode = 'HORIZONTAL';
    comp.primaryAxisAlignItems = 'CENTER'; comp.counterAxisAlignItems = 'CENTER';
    comp.layoutSizingHorizontal = 'HUG'; comp.layoutSizingVertical = 'HUG';
    comp.minHeight = 8;
    bindNumber(R, comp, 'itemSpacing', '--gap-related', 8);
    comp.fills = [];
    for (var i = 0; i < +v.pages; i++) comp.appendChild(D['active=' + (i === 1) + ', onMedia=' + v.onMedia].createInstance());
  }, function (set) { set.description = '<div class="swing_dots [swing_dots_on_media]" role="img" aria-label="Page 2 of 5">…dot…</div>. Gap 8, centred. Swap which Dot is active in the instance. More than 9 pages: use DotsCount.'; }, function () {}, R);
  var pds = pairUp(dots, dsv, function (c) { return /^pages=/.test(c.name); });
  await docArtboard(R, page, dots, pds.comps, pds.vs, {
    title: 'Dots', description: 'Page dots for swipeable pages: onboarding, photo pagers. Over a photo use onMedia.',
    code: ['<div class="swing_dots" role="img" aria-label="Page 2 of 5"><i class="swing_dot"></i><i class="swing_dot is-active"></i>…</div>', 'onMedia = .swing_dots_on_media'],
    colGroups: [{ label: 'pages', cols: ['3', '5'] }], rowGroups: [{ label: 'onMedia', rows: ['false', 'true'] }],
    place: function (v) { return { cg: 0, c: v.pages === '5' ? 1 : 0, rg: 0, r: v.onMedia === 'true' ? 1 : 0 }; },
    minCell: 120, minRow: 40, center: true,
    backdrop: function (v) { return v.onMedia === 'true' ? '--dark-500' : null; }
  });
  // DotsCount
  var cv = [{ name: 'type=default' }], cParts = {};
  var cnt = await buildSet(page, 'DotsCount', cv, async function (comp) {
    comp.layoutMode = 'HORIZONTAL'; comp.layoutSizingHorizontal = 'HUG'; comp.layoutSizingVertical = 'HUG'; comp.fills = [];
    var t = await styledText(R, '--type-b3s', '--dark-300', '3 / 12');
    comp.appendChild(t); t.name = 'count'; t.textAutoResize = 'WIDTH_AND_HEIGHT';
    cParts[comp.name] = t;
  }, function (set) {
    var p = ensureProp(set, 'count', 'TEXT', '3 / 12');
    wireKeys(cParts).forEach(function (k) { cParts[k].componentPropertyReferences = { characters: p }; });
    set.description = '<div class="swing_dots_count">3 / 12</div>. B3 Semibold dark-300, tabular numbers. Use instead of dots past 9 pages.';
  }, function () {}, R);
  var pc = pairUp(cnt, cv, function (c) { return c.name === 'type=default'; });
  await docArtboard(R, page, cnt, pc.comps, pc.vs, {
    title: 'DotsCount', description: 'Page count for more than 9 pages.',
    code: ['<div class="swing_dots_count">3 / 12</div>', 'B3 Semibold, tabular numbers'],
    colGroups: [{ label: 'example', cols: ['count'] }], rowGroups: [{ label: 'type', rows: ['default'] }],
    place: function () { return { cg: 0, c: 0, rg: 0, r: 0 }; }
  });
  // Segment + Segments
  var SEG = ['todo', 'done', 'current'];
  var sv = [];
  SEG.forEach(function (s) { ['false', 'true'].forEach(function (m) { sv.push({ state: s, onMedia: m }); }); });
  simpleSet(sv);
  var seg = await buildSet(page, 'Segment', sv, async function (comp, v) {
    var m = v.onMedia === 'true', on = v.state !== 'todo';
    comp.resize(80, 4);
    pillRadius(comp, 4);
    if (on) comp.fills = paintFor(R, m ? '--light-100' : '--purple-500');
    else {
      var p = paintFor(R, m ? '--light-100' : '--light-500');
      if (m) p = p.map(function (x) { return Object.assign({}, x, { opacity: 0.4 }); });   // color-mix(light-100 40%, transparent)
      comp.fills = p;
    }
  }, function (set) { set.description = '<i class="swing_seg [is-done|is-current]"></i> inside .swing_segments. 4px pill. todo = light-500 · done / current = purple-500 (current fills over 5s in a story) · onMedia = white, todo at 40%. Set the instance to Fill.'; }, function () {}, R);
  var ps = pairUp(seg, sv, function (c) { return /^state=/.test(c.name); });
  await docArtboard(R, page, seg, ps.comps, ps.vs, {
    title: 'Segment', description: 'One step of a segmented progress bar.',
    code: ['<i class="swing_seg is-current"></i>', 'state done = .is-done · current = .is-current · onMedia = inside .swing_segments_on_media'],
    colGroups: [{ label: 'onMedia', cols: ['false', 'true'] }], rowGroups: [{ label: 'state', rows: SEG }],
    place: function (v) { return { cg: 0, c: v.onMedia === 'true' ? 1 : 0, rg: 0, r: SEG.indexOf(v.state) }; },
    minCell: 120, minRow: 32, center: true,
    backdrop: function (v) { return v.onMedia === 'true' ? '--dark-500' : null; }
  });
  var S = byName(seg);
  var ssv = simpleSet([{ onMedia: 'false' }, { onMedia: 'true' }]);
  var segs = await buildSet(page, 'Segments', ssv, async function (comp, v) {
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(342, 4); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--gap-tight', 4);
    comp.fills = [];
    ['done', 'current', 'todo', 'todo'].forEach(function (st) {
      var it = S['state=' + st + ', onMedia=' + v.onMedia].createInstance();
      comp.appendChild(it); it.layoutSizingHorizontal = 'FILL';
    });
  }, function (set) { set.description = '<div class="swing_segments [swing_segments_on_media]" role="progressbar" aria-valuemin="1" aria-valuemax="4" aria-valuenow="2">…seg…</div>. Equal segments, gap 4, width 342 (set to Fill). Add or remove Segment instances for more steps.'; }, function () {}, R);
  var pss = pairUp(segs, ssv, function (c) { return /^onMedia=/.test(c.name); });
  await docArtboard(R, page, segs, pss.comps, pss.vs, {
    title: 'Segments', description: 'Progress through steps or stories: done and current are filled, the rest wait.',
    code: ['<div class="swing_segments" role="progressbar" aria-valuemin="1" aria-valuemax="4" aria-valuenow="2"><i class="swing_seg is-done"></i><i class="swing_seg is-current"></i><i class="swing_seg"></i><i class="swing_seg"></i></div>', 'onMedia = .swing_segments_on_media'],
    colGroups: [{ label: 'example', cols: ['4 steps'] }], rowGroups: [{ label: 'onMedia', rows: ['false', 'true'] }],
    place: function (v) { return { cg: 0, c: 0, rg: 0, r: v.onMedia === 'true' ? 1 : 0 }; },
    backdrop: function (v) { return v.onMedia === 'true' ? '--dark-500' : null; }
  });
  var total = dv.length + dsv.length + 1 + sv.length + ssv.length;
  return { set: dot, count: total, label: 'Dot 4, Dots 4, DotsCount 1, Segment 6, Segments 2 variants' };
}

/* ----- Rating (components.css .stars, .star, .rating, .rate) ----- */
async function buildRatingPage(R, notes) {
  var page = await pageNamed('Rating');
  var starIcon = (await findIcon('Icon/Solid/stars')) || (await iconOrPlaceholder('Icon/Line/stars', page, notes));
  function starNode(parent, d, css) {
    var s = starIcon.createInstance();
    parent.appendChild(s); s.name = 'star'; s.resize(d, d);
    recolorIcon(R, s, css);
    return s;
  }
  // Star: one glyph, off / on / half
  var STATES = ['off', 'on', 'half'];
  var sv = [];
  STATES.forEach(function (st) { ['s', 'm'].forEach(function (sz) { sv.push({ state: st, size: sz }); }); });
  simpleSet(sv);
  var star = await buildSet(page, 'Star', sv, async function (comp, v) {
    var d = v.size === 'm' ? 24 : 16;
    comp.resize(d, d); comp.fills = [];
    starNode(comp, d, v.state === 'on' ? '--orange-500' : '--dark-100');
    if (v.state === 'half') {   // linear-gradient(90deg, on 50%, off 50%): an orange star clipped to the left half
      var half = figma.createFrame();
      comp.appendChild(half);
      half.name = 'half'; half.resize(d / 2, d); half.fills = []; half.clipsContent = true;
      starNode(half, d, '--orange-500');
    }
  }, function (set) { set.description = '<i class="swing_star [is-on|is-half]"></i> (mask: solid/stars). off = dark-100 · on = orange-500 · half = left half orange. size s = 16 · m = 24 (.swing_stars_m).'; }, function () {}, R);
  var pst = pairUp(star, sv, function (c) { return /^state=/.test(c.name); });
  await docArtboard(R, page, star, pst.comps, pst.vs, {
    title: 'Star', description: 'One star of a read-only score.',
    code: ['<i class="swing_star is-on"></i>', 'state on = .is-on · half = .is-half · size m = inside .swing_stars_m'],
    colGroups: [{ label: 'size', cols: ['s', 'm'] }], rowGroups: [{ label: 'state', rows: STATES }],
    place: function (v) { return { cg: 0, c: v.size === 'm' ? 1 : 0, rg: 0, r: STATES.indexOf(v.state) }; }
  });
  var ST = byName(star);
  // Stars: a score from 0 to 5 in halves
  var VALUES = ['0', '0.5', '1', '1.5', '2', '2.5', '3', '3.5', '4', '4.5', '5'];
  var stv = [];
  ['s', 'm'].forEach(function (sz) { VALUES.forEach(function (x) { stv.push({ size: sz, value: x }); }); });
  simpleSet(stv);
  var stars = await buildSet(page, 'Stars', stv, async function (comp, v) {
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER';
    comp.layoutSizingHorizontal = 'HUG'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', v.size === 'm' ? '--gap-related' : '--gap-tight', v.size === 'm' ? 8 : 4);
    comp.fills = [];
    var n = +v.value;
    for (var i = 1; i <= 5; i++) {
      var st = n >= i ? 'on' : n >= i - 0.5 ? 'half' : 'off';
      comp.appendChild(ST['state=' + st + ', size=' + v.size].createInstance());
    }
  }, function (set) { set.description = '<span class="swing_stars [swing_stars_m]" role="img" aria-label="Rated 4.5 out of 5">…5 star…</span>. Read-only. size s = 16, gap 4 · m = 24, gap 8. Always show the number next to it (Rating).'; }, function () {}, R);
  var psv = pairUp(stars, stv, function (c) { return /^size=/.test(c.name); });
  await docArtboard(R, page, stars, psv.comps, psv.vs, {
    title: 'Stars', description: 'A read-only score from 0 to 5 in half steps. Pair it with the number so the score is not colour-only.',
    code: ['<span class="swing_stars" role="img" aria-label="Rated 4.5 out of 5"><i class="swing_star is-on"></i>…<i class="swing_star is-half"></i></span>', 'size m = .swing_stars_m'],
    colGroups: [{ label: 'size', cols: ['s', 'm'] }], rowGroups: [{ label: 'value', rows: VALUES }],
    place: function (v) { return { cg: 0, c: v.size === 'm' ? 1 : 0, rg: 0, r: VALUES.indexOf(v.value) }; }
  });
  var SS = byName(stars);
  // Rating: stars + score + count
  var rv = [{ name: 'type=default' }], rParts = {};
  var rating = await buildSet(page, 'Rating', rv, async function (comp) {
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER';
    comp.layoutSizingHorizontal = 'HUG'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--gap-tight', 4);
    comp.fills = [];
    comp.appendChild(SS['size=s, value=4.5'].createInstance());
    var b = await styledText(R, '--type-b2s', '--dark-500', '4.5');
    comp.appendChild(b); b.name = 'score'; b.textAutoResize = 'WIDTH_AND_HEIGHT';
    var c = await styledText(R, '--type-b2', '--dark-300', '(128)');
    comp.appendChild(c); c.name = 'count'; c.textAutoResize = 'WIDTH_AND_HEIGHT';
    rParts[comp.name] = { score: b, count: c };
  }, function (set) {
    var pS = ensureProp(set, 'score', 'TEXT', '4.5'), pSC = ensureProp(set, 'showCount', 'BOOLEAN', true), pC = ensureProp(set, 'count', 'TEXT', '(128)');
    wireKeys(rParts).forEach(function (k) { rParts[k].score.componentPropertyReferences = { characters: pS }; rParts[k].count.componentPropertyReferences = { visible: pSC, characters: pC }; });
    set.description = '<span class="swing_rating"><span class="swing_stars">…</span><b>4.5</b> (128)</span>. Gap 4, B2 dark-300, the score in B2 Semibold dark-500, tabular numbers. Swap the Stars value to match the score.';
  }, function () {}, R);
  var pr = pairUp(rating, rv, function (c) { return c.name === 'type=default'; });
  await docArtboard(R, page, rating, pr.comps, pr.vs, {
    title: 'Rating', description: 'Stars with the score and the number of reviews, for course and coach cards.',
    code: ['<span class="swing_rating"><span class="swing_stars" role="img" aria-label="Rated 4.5 out of 5">…</span><b>4.5</b> (128)</span>', 'score = <b> · count = the text after it'],
    colGroups: [{ label: 'example', cols: ['rating'] }], rowGroups: [{ label: 'type', rows: ['default'] }],
    place: function () { return { cg: 0, c: 0, rg: 0, r: 0 }; }
  });
  // Rate: the input
  var RV = ['0', '1', '2', '3', '4', '5'];
  var rtv = [];
  ['l', 's'].forEach(function (sz) { ['default', 'disabled'].forEach(function (st) { RV.forEach(function (x) { rtv.push({ size: sz, state: st, value: x }); }); }); });
  simpleSet(rtv);
  var rate = await buildSet(page, 'Rate', rtv, async function (comp, v) {
    var l = v.size === 'l', off = v.state === 'disabled';
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER';
    comp.layoutSizingHorizontal = 'HUG'; comp.layoutSizingVertical = 'HUG';
    if (l) bindNumber(R, comp, 'itemSpacing', '--gap-related', 8); else comp.itemSpacing = 0;
    comp.fills = [];
    for (var i = 1; i <= 5; i++) {
      var tap = autoFrame('star' + i, 'HORIZONTAL', comp);   // .rate__star: 48 tap (s: 44), radius 12
      tap.primaryAxisAlignItems = 'CENTER'; tap.counterAxisAlignItems = 'CENTER';
      tap.resize(l ? 48 : 44, l ? 48 : 44); tap.layoutSizingHorizontal = 'FIXED'; tap.layoutSizingVertical = 'FIXED';
      bindRadius(R, tap, '--radius-12', 12);
      var on = i <= +v.value;
      starNode(tap, l ? 40 : 24, off ? (on ? '--dark-100' : '--light-500') : (on ? '--orange-500' : '--dark-100'));
    }
  }, function (set) { set.description = '<fieldset class="swing_rate [swing_rate_s]"><label class="swing_rate__star"><input type="radio" name="r" value="1" class="sr-only">…</label>×5</fieldset>. Native radios. size l = icon 40 in a 48 tap, gap 8 · s = icon 24 in a 44 tap, gap 0. value = stars up to the checked one are orange-500. disabled = dark-100 on / light-500 off.'; }, function () {}, R);
  var prt = pairUp(rate, rtv, function (c) { return /^size=/.test(c.name); });
  await docArtboard(R, page, rate, prt.comps, prt.vs, {
    title: 'Rate', description: 'Rating input: one tap sets the score. Big for a review screen, small inside a form.',
    code: ['<fieldset class="swing_rate"><legend class="sr-only">Rate the course</legend><label class="swing_rate__star"><input type="radio" name="r" value="1" class="sr-only"><span class="sr-only">1 star</span></label>…</fieldset>', 'size s = .swing_rate_s · disabled = <fieldset disabled>'],
    colGroups: [{ label: 'size l', cols: ['default', 'disabled'] }, { label: 'size s', cols: ['default', 'disabled'] }], rowGroups: [{ label: 'value', rows: RV }],
    place: function (v) { return { cg: v.size === 's' ? 1 : 0, c: v.state === 'disabled' ? 1 : 0, rg: 0, r: RV.indexOf(v.value) }; }
  });
  notes.push('Rate: the tap scales to 0.88 on the web; Figma shows the colour only.');
  return { set: star, count: sv.length + stv.length + 1 + rtv.length, label: 'Star 6, Stars 22, Rating 1, Rate 24 variants' };
}

/* ----- Stepper (components.css .stepper) ----- */
var STP_STATES = ['default', 'pressed', 'atMin', 'atMax', 'disabled'];

async function buildStepperPage(R, notes) {
  var page = await pageNamed('Stepper');
  var icons = { minus: await iconOrPlaceholder('Icon/Line/minus-lg', page, notes), plus: await iconOrPlaceholder('Icon/Line/add-lg', page, notes) };
  var variants = STP_STATES.map(function (s) { return { state: s, name: 'state=' + s }; }), parts = {};
  async function btn(comp, name, icon, off, press) {
    var b = autoFrame(name, 'HORIZONTAL', comp);
    b.primaryAxisAlignItems = 'CENTER'; b.counterAxisAlignItems = 'CENTER';
    b.resize(36, 36); b.layoutSizingHorizontal = 'FIXED'; b.layoutSizingVertical = 'FIXED';
    pillRadius(b, 36);
    b.fills = paintFor(R, off ? '--light-200' : press ? '--light-500' : '--light-300');
    var ic = icon.createInstance();
    b.appendChild(ic); ic.name = 'icon'; ic.resize(20, 20);
    recolorIcon(R, ic, off ? '--dark-100' : '--dark-500');
  }
  async function buildVariant(comp, v) {
    var s = v.state;
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER';
    comp.layoutSizingHorizontal = 'HUG'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--gap-tight', 4);
    comp.fills = [];
    await btn(comp, 'decrease', icons.minus, s === 'atMin' || s === 'disabled', false);
    var t = await styledText(R, '--type-b1s', s === 'disabled' ? '--dark-100' : '--dark-500', s === 'atMin' ? '1' : s === 'atMax' ? '4' : '2');
    var box = autoFrame('value', 'HORIZONTAL', comp);
    box.primaryAxisAlignItems = 'CENTER';
    box.layoutSizingHorizontal = 'HUG'; box.layoutSizingVertical = 'HUG';
    box.minWidth = 32;
    box.appendChild(t); t.name = 'text'; t.textAutoResize = 'WIDTH_AND_HEIGHT';
    await btn(comp, 'increase', icons.plus, s === 'atMax' || s === 'disabled', s === 'pressed');
    parts[comp.name] = { value: t };
  }
  function wire(set) {
    var p = ensureProp(set, 'value', 'TEXT', '2');
    wireKeys(parts).forEach(function (k) { parts[k].value.componentPropertyReferences = { characters: p }; });
    set.description = '<div class="swing_stepper" role="group" aria-label="Players" data-min="1" data-max="4"><button class="swing_stepper__btn" data-step="-1">…minus-lg…</button><output class="swing_stepper__value">{value}</output><button class="swing_stepper__btn" data-step="1">…add-lg…</button></div>. ' +
      'Buttons 36 circle light-300 (44 hit area), icon 20 · pressed = light-500 · atMin / atMax = that button disabled (light-200, dark-100) · disabled = .is-disabled. Value B1 Semibold, min width 32. Over ~10 use a TextField.';
  }
  var set = await buildSet(page, 'Stepper', variants, buildVariant, wire, function () {}, R);
  var pv = pairUp(set, variants, function (c) { return parts[c.name]; });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'Stepper', description: 'Small whole numbers: players in a flight, ball boxes, nights. The minus turns off at the minimum, the plus at the maximum.',
    code: ['<div class="swing_stepper" role="group" aria-label="Players" data-min="1" data-max="4"><button class="swing_stepper__btn" type="button" data-step="-1" aria-label="Remove a player">…</button><output class="swing_stepper__value" aria-live="polite">2</output>…</div>',
      'atMin / atMax = stepper.js disables that button · disabled = .swing_stepper.is-disabled · pressed = :active'],
    colGroups: [{ label: 'example', cols: ['stepper'] }], rowGroups: [{ label: 'state', rows: STP_STATES }],
    place: function (v) { return { cg: 0, c: 0, rg: 0, r: STP_STATES.indexOf(v.state) }; }
  });
  notes.push('Stepper: the pressed button scales to 0.92 on the web and the hit area is 44 around the 36 circle; Figma shows the 36 circle and the colour.');
  return { set: set, count: variants.length, label: 'Stepper ' + variants.length + ' variants' };
}

/* ----- PIN field (components.css .pin, .pin__cell) ----- */
var PIN_CELL_STATES = ['default', 'active', 'error', 'errorActive', 'disabled'];
var PIN_CONTENT = ['empty', 'digit', 'dot'];

async function buildPinPage(R, notes) {
  var page = await pageNamed('Pin');
  var solidOr = async function (n) { return (await findIcon('Icon/Solid/' + n)) || (await iconOrPlaceholder('Icon/Line/' + n, page, notes)); };
  var icons = { info: await iconOrPlaceholder('Icon/Line/info', page, notes), error: await solidOr('warning-circle') };
  // PinCell
  var cv = [], cParts = {};
  PIN_CELL_STATES.forEach(function (s) { PIN_CONTENT.forEach(function (c) { cv.push({ state: s, content: c }); }); });
  simpleSet(cv);
  var cell = await buildSet(page, 'PinCell', cv, async function (comp, v) {
    var C = tfColors(v.state === 'active' ? 'focus' : v.state === 'errorActive' ? 'error' : v.state);
    var ringW = v.state === 'active' || v.state === 'errorActive' ? 2 : 1;
    comp.layoutMode = 'HORIZONTAL';
    comp.primaryAxisAlignItems = 'CENTER'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(48, 56); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'FIXED';
    bindRadius(R, comp, '--radius-12', 12);
    comp.fills = paintFor(R, v.state === 'active' ? '--light-100' : C.bg);
    comp.strokes = C.ring ? paintFor(R, v.state === 'active' ? '--purple-500' : C.ring) : [];
    comp.strokeWeight = ringW; comp.strokeAlign = 'INSIDE';
    if (v.content === 'digit') {
      var t = await styledText(R, '--type-h4', C.text, '4');
      comp.appendChild(t); t.name = 'digit'; t.textAutoResize = 'WIDTH_AND_HEIGHT';
      cParts[comp.name] = t;
    } else if (v.content === 'dot') {   // .pin--mask .pin__cell.is-filled::before
      var d = figma.createEllipse();
      comp.appendChild(d); d.name = 'dot'; d.resize(12, 12);
      d.fills = paintFor(R, v.state === 'disabled' ? '--dark-100' : '--dark-500');
    } else if (v.state === 'active' || v.state === 'errorActive') {
      var caret = figma.createRectangle();
      comp.appendChild(caret); caret.name = 'caret'; caret.resize(1.5, 24);
      caret.fills = paintFor(R, v.state === 'active' ? '--purple-500' : '--red-500');
    }
  }, function (set) {
    var p = ensureProp(set, 'digit', 'TEXT', '4');
    wireKeys(cParts).forEach(function (k) { cParts[k].componentPropertyReferences = { characters: p }; });
    set.description = '<div class="swing_pin__cell [is-active] [is-filled]">{digit}</div>, drawn by pin.js. 48 x 56, radius 12, Text field colours: default light-200 + 1px light-500 · active light-100 + 2px purple-500 · error red-50 + red-500 (active 2px) · disabled light-300. Digit H4, mask dot 12.';
  }, function () {}, R);
  var pc = pairUp(cell, cv, function (c) { return /^state=/.test(c.name); });
  await docArtboard(R, page, cell, pc.comps, pc.vs, {
    title: 'PinCell', description: 'One digit box of a PIN or OTP field.',
    code: ['<div class="swing_pin__cell is-active"></div>', 'active = .is-active · filled = .is-filled · dot = inside .swing_pin_mask · error = .swing_pin.is-error'],
    colGroups: [{ label: 'content', cols: PIN_CONTENT }], rowGroups: [{ label: 'state', rows: PIN_CELL_STATES }],
    place: function (v) { return { cg: 0, c: PIN_CONTENT.indexOf(v.content), rg: 0, r: PIN_CELL_STATES.indexOf(v.state) }; }
  });
  var CELL = byName(cell);
  // Pin
  var PIN_STATES = ['default', 'typing', 'error', 'disabled'];
  var pv = [], parts = {};
  PIN_STATES.forEach(function (s) { ['false', 'true'].forEach(function (m) { pv.push({ state: s, mask: m }); }); });
  simpleSet(pv);
  var DIG = ['4', '8', '1', '5', '9', '2'];
  var pin = await buildSet(page, 'Pin', pv, async function (comp, v) {
    var s = v.state, mask = v.mask === 'true';
    comp.layoutMode = 'VERTICAL';
    comp.resize(342, 100); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--space-8', 8);
    comp.fills = [];
    var C = tfColors(s === 'typing' ? 'focus' : s);
    var label = await styledText(R, '--type-b2s', C.label, mask ? 'Payment PIN' : 'Verification code');
    comp.appendChild(label); label.name = 'label'; label.textAutoResize = 'WIDTH_AND_HEIGHT';
    var row = autoFrame('cells', 'HORIZONTAL', comp);
    row.layoutSizingHorizontal = 'FILL'; row.layoutSizingVertical = 'HUG';
    bindNumber(R, row, 'itemSpacing', '--gap-related', 8);
    for (var i = 0; i < 6; i++) {
      var st = s === 'disabled' ? 'disabled' : s === 'error' ? 'error' : (s === 'typing' && i === 3) ? 'active' : 'default';
      var filled = s === 'error' || (s === 'typing' && i < 3);
      var it = CELL['state=' + st + ', content=' + (filled ? (mask ? 'dot' : 'digit') : 'empty')].createInstance();
      row.appendChild(it);
      if (filled && !mask) { try { it.setProperties(propsFor(it, { digit: DIG[i] })); } catch (e) { /* default digit */ } }
    }
    var help = autoFrame('help', 'HORIZONTAL', comp);
    help.layoutSizingHorizontal = 'FILL'; help.layoutSizingVertical = 'HUG';
    bindNumber(R, help, 'itemSpacing', '--space-4', 4);
    bindNumber(R, help, 'paddingLeft', '--space-4', 4);
    var hb = autoFrame('helpIcon', 'VERTICAL', help);
    hb.primaryAxisAlignItems = 'CENTER'; hb.counterAxisAlignItems = 'CENTER';
    hb.resize(16, 20); hb.layoutSizingHorizontal = 'FIXED'; hb.layoutSizingVertical = 'FIXED';
    var hi = (s === 'error' ? icons.error : icons.info).createInstance();
    hb.appendChild(hi); hi.name = 'icon'; hi.resize(16, 16);
    recolorIcon(R, hi, C.help);
    var ht = await styledText(R, '--type-b2', C.help, s === 'error' ? 'Wrong code. Check the SMS and try again' : 'We sent a 6-digit code to +62 812 3456 7890');
    help.appendChild(ht); ht.name = 'helpText'; ht.textAutoResize = 'HEIGHT'; ht.layoutSizingHorizontal = 'FILL';
    var foot = autoFrame('foot', 'HORIZONTAL', comp);   // .pin__foot
    foot.layoutSizingHorizontal = 'FILL'; foot.layoutSizingVertical = 'HUG';
    bindNumber(R, foot, 'itemSpacing', '--gap-related', 8);
    var ft = await styledText(R, '--type-b2', s === 'disabled' ? '--dark-100' : '--dark-300', 'Resend code in 0:42');
    foot.appendChild(ft); ft.name = 'text'; ft.textAutoResize = 'WIDTH_AND_HEIGHT';
    foot.visible = !mask;
    parts[comp.name] = { label: label, help: help, helpText: ht, foot: foot, footText: ft };
  }, function (set) {
    var pL = ensureProp(set, 'label', 'TEXT', 'Verification code');
    var pSH = ensureProp(set, 'showHelp', 'BOOLEAN', true);
    var pH = ensureProp(set, 'helpText', 'TEXT', 'We sent a 6-digit code to +62 812 3456 7890');
    var pSF = ensureProp(set, 'showFoot', 'BOOLEAN', true);
    var pF = ensureProp(set, 'foot', 'TEXT', 'Resend code in 0:42');
    wireKeys(parts).forEach(function (k) {
      var p = parts[k];
      p.label.componentPropertyReferences = { characters: pL };
      p.help.componentPropertyReferences = { visible: pSH };
      p.helpText.componentPropertyReferences = { characters: pH };
      p.foot.componentPropertyReferences = { visible: pSF };
      p.footText.componentPropertyReferences = { characters: pF };
    });
    set.description = '<div class="swing_field swing_pin [swing_pin_mask] [is-error]"><label class="swing_pin__label">{label}</label><div class="swing_pin__box"><input class="swing_pin__input" inputmode="numeric" autocomplete="one-time-code" maxlength="6"><div class="swing_pin__cells"></div></div><p class="swing_field__help">{helpText}</p></div>. ' +
      'One real input under 6 PinCells (gap 8). typing = :focus-within, label purple-600, next cell active · error = .is-error · disabled = input disabled · mask = .swing_pin_mask (payment PIN, dots). foot = .swing_pin__foot (resend timer).';
  }, function () {}, R);
  var pp = pairUp(pin, pv, function (c) { return parts[c.name]; });
  await docArtboard(R, page, pin, pp.comps, pp.vs, {
    title: 'Pin', description: 'OTP or payment PIN: six cells over one real input, so SMS autofill and paste work. mask shows dots instead of digits.',
    code: ['<div class="swing_field swing_pin"><label class="swing_pin__label" for="otp">Verification code</label><div class="swing_pin__box"><input class="swing_pin__input" id="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6"><div class="swing_pin__cells" aria-hidden="true"></div></div><p class="swing_field__help" id="otp-help">…</p></div>',
      'mask = .swing_pin_mask · error = .swing_pin.is-error · typing = focused · disabled = <input disabled>'],
    colGroups: [{ label: 'mask', cols: ['false · OTP', 'true · payment PIN'] }], rowGroups: [{ label: 'state', rows: PIN_STATES }],
    place: function (v) { return { cg: 0, c: v.mask === 'true' ? 1 : 0, rg: 0, r: PIN_STATES.indexOf(v.state) }; }
  });
  return { set: cell, count: cv.length + pv.length, label: 'PinCell ' + cv.length + ', Pin ' + pv.length + ' variants' };
}

/* ----- Slider (components.css .slider) ----- */
var SL_STATES = ['default', 'pressed', 'disabled'];

async function buildSliderPage(R, notes) {
  var page = await pageNamed('Slider');
  var variants = [], parts = {};
  ['single', 'range'].forEach(function (t) { SL_STATES.forEach(function (s) { variants.push({ type: t, state: s }); }); });
  simpleSet(variants);
  var W = 342;
  function thumb(ctrl, at, press, off) {   // radial: 20 fill + 2px light-100 ring = 24
    var t = figma.createEllipse();
    ctrl.appendChild(t); t.name = 'thumb'; t.resize(24, 24);
    t.x = at * (W - 24); t.y = 10;   // centre runs from 12 to W-12, so the thumb never leaves the track
    t.fills = paintFor(R, off ? '--dark-100' : press ? '--purple-600' : '--purple-500');
    t.strokes = paintFor(R, '--light-100'); t.strokeWeight = 2; t.strokeAlign = 'INSIDE';
    t.constraints = { horizontal: 'SCALE', vertical: 'CENTER' };
    return t;
  }
  async function buildVariant(comp, v) {
    var range = v.type === 'range', off = v.state === 'disabled', press = v.state === 'pressed';
    var lo = range ? 0.1 : 0, hi = range ? 0.75 : (10 - 1) / 49;
    comp.layoutMode = 'VERTICAL';
    comp.resize(W, 100); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--gap-related', 8);
    comp.fills = [];
    comp.clipsContent = false;
    var head = autoFrame('head', 'HORIZONTAL', comp);
    head.primaryAxisAlignItems = 'SPACE_BETWEEN'; head.counterAxisAlignItems = 'BASELINE';
    head.layoutSizingHorizontal = 'FILL'; head.layoutSizingVertical = 'HUG';
    bindNumber(R, head, 'itemSpacing', '--gap-group', 16);
    var label = await styledText(R, '--type-b1s', off ? '--dark-100' : '--dark-500', range ? 'Price' : 'Distance');
    head.appendChild(label); label.name = 'label'; label.textAutoResize = 'WIDTH_AND_HEIGHT';
    var val = await styledText(R, '--type-b2s', off ? '--dark-100' : '--purple-600', range ? 'Rp 200rb – Rp 1,5jt' : '10 km');
    head.appendChild(val); val.name = 'value'; val.textAutoResize = 'WIDTH_AND_HEIGHT';
    var ctrl = figma.createFrame();   // .slider__control: 44 tall; the track lines up with the content edge
    comp.appendChild(ctrl);
    ctrl.name = 'control'; ctrl.resize(W, 44); ctrl.fills = []; ctrl.clipsContent = false;
    ctrl.layoutSizingHorizontal = 'FILL';
    var track = figma.createRectangle();
    ctrl.appendChild(track); track.name = 'track'; track.resize(W, 4); track.x = 0; track.y = 20;
    track.fills = paintFor(R, '--light-500'); pillRadius(track, 4);
    track.constraints = { horizontal: 'STRETCH', vertical: 'CENTER' };
    var fill = figma.createRectangle();
    var fx0 = range ? 12 + lo * (W - 24) : 0, fx1 = 12 + hi * (W - 24);
    ctrl.appendChild(fill); fill.name = 'fill'; fill.resize(Math.max(1, fx1 - fx0), 4); fill.x = fx0; fill.y = 20;
    fill.fills = paintFor(R, off ? '--dark-100' : '--purple-500'); pillRadius(fill, 4);
    fill.constraints = { horizontal: 'SCALE', vertical: 'CENTER' };
    if (range) thumb(ctrl, lo, false, off);
    var top = thumb(ctrl, hi, press, off);
    if (press) {   // .slider__bubble.is-on: 8 above the thumb, dark-400, elevation 2, 8px arrow
      var bub = autoFrame('bubble', 'HORIZONTAL', ctrl);
      bindNumber(R, bub, 'paddingLeft', '--space-8', 8); bindNumber(R, bub, 'paddingRight', '--space-8', 8);
      bindNumber(R, bub, 'paddingTop', '--space-4', 4); bindNumber(R, bub, 'paddingBottom', '--space-4', 4);
      bindRadius(R, bub, '--radius-8', 8);
      bub.fills = paintFor(R, '--dark-400');
      bub.layoutSizingHorizontal = 'HUG'; bub.layoutSizingVertical = 'HUG';
      var el = R.effects['--elevation-2'];
      if (el) await bub.setEffectStyleIdAsync(el.id);
      var bt = await styledText(R, '--type-b2s', '--light-100', range ? 'Rp 1,5jt' : '10 km');
      bub.appendChild(bt); bt.name = 'text'; bt.textAutoResize = 'WIDTH_AND_HEIGHT';
      bub.clipsContent = false;
      bub.x = top.x + 12 - bub.width / 2; bub.y = 10 - 8 - bub.height;
      pointerArrow(R, bub, 'down', '--dark-400');
      bub.constraints = { horizontal: 'SCALE', vertical: 'MIN' };
    }
    var scale = autoFrame('scale', 'HORIZONTAL', comp);
    scale.primaryAxisAlignItems = 'SPACE_BETWEEN';
    scale.layoutSizingHorizontal = 'FILL'; scale.layoutSizingVertical = 'HUG';
    bindNumber(R, scale, 'itemSpacing', '--gap-group', 16);
    var mn = await styledText(R, '--type-b2s', off ? '--dark-100' : '--dark-300', range ? 'Rp 0' : '1 km');
    scale.appendChild(mn); mn.name = 'min'; mn.textAutoResize = 'WIDTH_AND_HEIGHT';
    var mx = await styledText(R, '--type-b2s', off ? '--dark-100' : '--dark-300', range ? 'Rp 2jt' : '50 km');
    scale.appendChild(mx); mx.name = 'max'; mx.textAutoResize = 'WIDTH_AND_HEIGHT';
    parts[comp.name] = { label: label, value: val, scale: scale, min: mn, max: mx, head: head };
  }
  function wire(set) {
    var pL = ensureProp(set, 'label', 'TEXT', 'Distance');
    var pV = ensureProp(set, 'value', 'TEXT', '10 km');
    var pS = ensureProp(set, 'showScale', 'BOOLEAN', true);
    var pMn = ensureProp(set, 'min', 'TEXT', '1 km');
    var pMx = ensureProp(set, 'max', 'TEXT', '50 km');
    wireKeys(parts).forEach(function (k) {
      var p = parts[k];
      p.label.componentPropertyReferences = { characters: pL };
      p.value.componentPropertyReferences = { characters: pV };
      p.scale.componentPropertyReferences = { visible: pS };
      p.min.componentPropertyReferences = { characters: pMn };
      p.max.componentPropertyReferences = { characters: pMx };
    });
    set.description = '<div class="swing_slider [swing_slider_range]"><div class="swing_slider__head"><label class="swing_slider__label">{label}</label><output class="swing_slider__value">{value}</output></div><div class="swing_slider__control"><input type="range" class="swing_slider__input">…</div><div class="swing_slider__scale"><span>{min}</span><span>{max}</span></div></div>. ' +
      'Track 4px light-500, fill purple-500, thumb 24 (purple-500 + 2px light-100 ring, 44 hit area). pressed = purple-600 thumb + value bubble (dark-400, B2 Semibold, Elevation 2) · disabled = dark-100. Move the thumb and resize the fill to set the value. Width 342: set to Fill.';
  }
  var set = await buildSet(page, 'Slider', variants, buildVariant, wire, function () {}, R);
  var pv = pairUp(set, variants, function (c) { return parts[c.name]; });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'Slider', description: 'Pick a value or a range by dragging: distance, price, handicap. The value shows in the head, and in a bubble while dragging.',
    code: ['<div class="swing_slider" data-format="km"><div class="swing_slider__head"><label class="swing_slider__label" for="dist">Distance</label><output class="swing_slider__value"></output></div><div class="swing_slider__control"><input type="range" class="swing_slider__input" id="dist" min="1" max="50" value="10"></div><div class="swing_slider__scale"><span>1 km</span><span>50 km</span></div></div>',
      'type range = .swing_slider_range with two inputs · pressed = :active (slider.js shows .swing_slider__bubble) · disabled = <input disabled>'],
    colGroups: [{ label: 'type', cols: ['single', 'range'] }], rowGroups: [{ label: 'state', rows: SL_STATES }],
    place: function (v) { return { cg: 0, c: v.type === 'range' ? 1 : 0, rg: 0, r: SL_STATES.indexOf(v.state) }; }
  });
  notes.push('Slider: the thumb is 24 to the eye and 44 to the finger, and the web control bleeds 10px each side; in Figma the thumb sits on the content edge and the hit area is not drawn. Position the thumb and the fill by hand for other values.');
  return { set: set, count: variants.length, label: 'Slider ' + variants.length + ' variants' };
}

/* ----- pointer arrow: the CSS 8px rotated square, half outside the bubble = an 11.3 x 5.7 triangle ----- */
function pointerArrow(R, parent, dir, css) {
  var a = figma.createVector();
  parent.appendChild(a);
  a.name = 'arrow';
  var w = 11.31, h = 5.66;
  var d = { down: 'M 0 0 L ' + w + ' 0 L ' + (w / 2) + ' ' + h + ' Z', up: 'M 0 ' + h + ' L ' + w + ' ' + h + ' L ' + (w / 2) + ' 0 Z',
    right: 'M 0 0 L ' + h + ' ' + (w / 2) + ' L 0 ' + w + ' Z', left: 'M ' + h + ' 0 L 0 ' + (w / 2) + ' L ' + h + ' ' + w + ' Z' }[dir];
  a.vectorPaths = [{ windingRule: 'NONZERO', data: d }];
  a.fills = paintFor(R, css);
  if (parent.layoutMode && parent.layoutMode !== 'NONE') a.layoutPositioning = 'ABSOLUTE';
  var pw = parent.width, ph = parent.height, vw = dir === 'up' || dir === 'down' ? w : h, vh = dir === 'up' || dir === 'down' ? h : w;
  a.x = dir === 'left' ? -h : dir === 'right' ? pw : (pw - vw) / 2;
  a.y = dir === 'up' ? -h : dir === 'down' ? ph : (ph - vh) / 2;
  a.constraints = { horizontal: dir === 'left' ? 'MIN' : dir === 'right' ? 'MAX' : 'CENTER', vertical: dir === 'up' ? 'MIN' : dir === 'down' ? 'MAX' : 'CENTER' };
  return a;
}

/* ----- Toaster (components.css .toaster) ----- */
var TOAST_TONES = { neutral: ['--dark-300', 'info', 'line'], error: ['--red-500', 'warning-circle', 'solid'], warning: ['--orange-700', 'warning-circle', 'line'],
  success: ['--color-success', 'tick-circle', 'solid'], primary: ['--purple-500', 'info', 'line'] };

async function buildToasterPage(R, notes) {
  var page = await pageNamed('Toaster');
  var icon = async function (n, kind) { return kind === 'solid' ? ((await findIcon('Icon/Solid/' + n)) || (await iconOrPlaceholder('Icon/Line/' + n, page, notes))) : await iconOrPlaceholder('Icon/Line/' + n, page, notes); };
  var close = await iconOrPlaceholder('Icon/Line/close-sm', page, notes), chev = await iconOrPlaceholder('Icon/Line/chevron-right', page, notes);
  var TONES = Object.keys(TOAST_TONES), variants = TONES.map(function (t) { return { tone: t, name: 'tone=' + t }; }), parts = {}, firstIcon = null;
  var TEXT = { neutral: 'Link copied', error: 'Payment failed. Try another method', warning: 'Only 2 slots left for this tee time', success: 'Booking confirmed', primary: 'You earned 120 Swing credits' };
  async function buildVariant(comp, v) {
    var T = TOAST_TONES[v.tone];
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(342, 48); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    comp.minHeight = 48; comp.maxWidth = 480;
    bindNumber(R, comp, 'itemSpacing', '--space-12', 12);
    bindNumber(R, comp, 'paddingLeft', '--space-16', 16); bindNumber(R, comp, 'paddingRight', '--space-16', 16);
    bindNumber(R, comp, 'paddingTop', '--space-12', 12); bindNumber(R, comp, 'paddingBottom', '--space-12', 12);
    bindRadius(R, comp, '--radius-8', 8);
    comp.fills = paintFor(R, T[0]);
    var el = R.effects['--elevation-2'];
    if (el) await comp.setEffectStyleIdAsync(el.id);
    var main = await icon(T[1], T[2]);
    if (!firstIcon) firstIcon = main;
    var ic = main.createInstance();
    comp.appendChild(ic); ic.name = 'icon'; ic.resize(20, 20);
    recolorIcon(R, ic, '--light-100');
    var t = await styledText(R, '--type-b2s', '--light-100', TEXT[v.tone]);
    comp.appendChild(t); t.name = 'text'; t.textAutoResize = 'HEIGHT'; t.layoutSizingHorizontal = 'FILL';
    // .toaster__action: 32 tall with margin -8 on the web; here 24 so the toaster keeps its 48
    var act = autoFrame('action', 'HORIZONTAL', comp);
    act.counterAxisAlignItems = 'CENTER';
    act.resize(40, 24); act.layoutSizingHorizontal = 'HUG'; act.layoutSizingVertical = 'FIXED';
    bindNumber(R, act, 'itemSpacing', '--gap-tight', 4);
    bindNumber(R, act, 'paddingLeft', '--space-4', 4); bindNumber(R, act, 'paddingRight', '--space-4', 4);
    var at = await styledText(R, '--type-b2s', '--light-100', 'View');
    act.appendChild(at); at.name = 'label'; at.textAutoResize = 'WIDTH_AND_HEIGHT';
    try { at.textDecoration = 'UNDERLINE'; } catch (e) { /* older API */ }
    var ac = chev.createInstance(); act.appendChild(ac); ac.name = 'icon'; ac.resize(16, 16);
    recolorIcon(R, ac, '--light-100');
    act.visible = false;
    var cl = autoFrame('close', 'HORIZONTAL', comp);
    cl.primaryAxisAlignItems = 'CENTER'; cl.counterAxisAlignItems = 'CENTER';
    cl.resize(32, 24); cl.layoutSizingHorizontal = 'FIXED'; cl.layoutSizingVertical = 'FIXED';
    var ci = close.createInstance(); cl.appendChild(ci); ci.name = 'icon'; ci.resize(20, 20);
    recolorIcon(R, ci, '--light-100');
    cl.visible = false;
    parts[comp.name] = { icon: ic, text: t, act: act, actText: at, close: cl };
  }
  function wire(set) {
    var pT = ensureProp(set, 'text', 'TEXT', 'Booking confirmed');
    var pSI = ensureProp(set, 'showIcon', 'BOOLEAN', true);
    var pI = ensureProp(set, 'icon', 'INSTANCE_SWAP', firstIcon.id);
    var pSA = ensureProp(set, 'showAction', 'BOOLEAN', false);
    var pA = ensureProp(set, 'action', 'TEXT', 'View');
    var pSC = ensureProp(set, 'showClose', 'BOOLEAN', false);
    wireKeys(parts).forEach(function (k) {
      var p = parts[k];
      p.text.componentPropertyReferences = { characters: pT };
      p.icon.componentPropertyReferences = { visible: pSI };
      p.act.componentPropertyReferences = { visible: pSA };
      p.actText.componentPropertyReferences = { characters: pA };
      p.close.componentPropertyReferences = { visible: pSC };
    });
    set.description = '<div class="swing_toaster swing_toaster_{tone}" role="status"><i class="swing_icon swing_toaster__icon"></i><p class="swing_toaster__text">{text}</p><button class="swing_toaster__action">{action}<i class="swing_icon">chevron-right</i></button><button class="swing_toaster__close" aria-label="Dismiss">close-sm</button></div>. ' +
      'Solid fill, white B2 Semibold, icon 20, padding 12/16, gap 12, radius 8, Elevation 2, min 48. neutral dark-300 · error red-500 · warning orange-700 · success green-500 (--color-success) · primary purple-500. Floats 16 above the bottom bar, full width minus page-x (max 480).';
  }
  var set = await buildSet(page, 'Toaster', variants, buildVariant, wire, function () {}, R);
  var pv = pairUp(set, variants, function (c) { return parts[c.name]; });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'Toaster', description: 'Short feedback after an action. It floats above the bottom bar and goes away on its own; add an action or a close for the ones that matter.',
    code: ['<div class="swing_toaster swing_toaster_success" role="status"><i class="swing_icon swing_toaster__icon" …solid/tick-circle></i><p class="swing_toaster__text">Booking confirmed</p></div>', 'tone = .swing_toaster_error / --warning / --success / --primary · showAction = .swing_toaster__action · showClose = .swing_toaster__close'],
    colGroups: [{ label: 'example', cols: ['toaster'] }], rowGroups: [{ label: 'tone', rows: TONES }],
    place: function (v) { return { cg: 0, c: 0, rg: 0, r: TONES.indexOf(v.tone) }; },
    examples: [{ label: 'with action and close', items: [{ variant: 'tone=success', props: { showAction: true, showClose: true } }, { variant: 'tone=error', props: { showAction: true, action: 'Retry' } }] }]
  });
  notes.push('Toaster: the action and close are 32 tall with margin -8 on the web; Figma draws them 24 tall so the toaster stays 48. The close also pulls 8px into the right padding there.');
  return { set: set, count: variants.length, label: 'Toaster ' + variants.length + ' variants' };
}

/* ----- Tooltip + MapPin (components.css .tooltip, .map-pin) ----- */
var TT_PLACE = ['top', 'bottom', 'left', 'right'];

async function buildTooltipPage(R, notes) {
  var page = await pageNamed('Tooltip');
  var close = await iconOrPlaceholder('Icon/Line/close-sm', page, notes);
  var variants = [], parts = {};
  TT_PLACE.forEach(function (p) { ['false', 'true'].forEach(function (d) { variants.push({ placement: p, dismiss: d }); }); });
  simpleSet(variants);
  var ARROW = { top: 'down', bottom: 'up', left: 'right', right: 'left' };
  async function buildVariant(comp, v) {
    var dis = v.dismiss === 'true';
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(240, 40); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'paddingLeft', '--space-12', 12);
    bindNumber(R, comp, 'paddingRight', dis ? '--space-4' : '--space-12', dis ? 4 : 12);
    bindNumber(R, comp, 'paddingTop', '--space-8', 8); bindNumber(R, comp, 'paddingBottom', '--space-8', 8);
    bindNumber(R, comp, 'itemSpacing', '--gap-related', 8);
    bindRadius(R, comp, '--radius-8', 8);
    comp.fills = paintFor(R, '--dark-400');
    comp.clipsContent = false;
    var el = R.effects['--elevation-2'];
    if (el) await comp.setEffectStyleIdAsync(el.id);
    var t = await styledText(R, '--type-b2s', '--light-100', dis ? 'Tap a slot to see the price for your flight' : 'Covers payment processing and support.');
    comp.appendChild(t); t.name = 'text'; t.textAutoResize = 'HEIGHT'; t.layoutSizingHorizontal = 'FILL';
    if (dis) {
      var cl = autoFrame('close', 'HORIZONTAL', comp);
      cl.primaryAxisAlignItems = 'CENTER'; cl.counterAxisAlignItems = 'CENTER';
      cl.resize(32, 32); cl.layoutSizingHorizontal = 'FIXED'; cl.layoutSizingVertical = 'FIXED';
      var ci = close.createInstance(); cl.appendChild(ci); ci.name = 'icon'; ci.resize(20, 20);
      recolorIcon(R, ci, '--light-100');
    }
    pointerArrow(R, comp, ARROW[v.placement], '--dark-400');
    parts[comp.name] = { text: t };
  }
  function wire(set) {
    var pT = ensureProp(set, 'text', 'TEXT', 'Covers payment processing and support.');
    wireKeys(parts).forEach(function (k) { parts[k].text.componentPropertyReferences = { characters: pT }; });
    set.description = '<span class="swing_tip" data-placement="{placement}"><button class="swing_tip__btn" aria-describedby="t1">…info 16…</button><span class="swing_tooltip" id="t1" role="tooltip">{text}</span></span>. ' +
      'dark-400, white B2 Semibold, padding 8/12, radius 8, max 240, Elevation 2, 8 away from the trigger with an 8px pointer. dismiss = coach mark (.swing_tooltip_dismiss + .swing_tooltip__close 32, stays until closed). Opens on tap on phones.';
  }
  var set = await buildSet(page, 'Tooltip', variants, buildVariant, wire, function () {}, R);
  var pv = pairUp(set, variants, function (c) { return parts[c.name]; });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'Tooltip', description: 'A short explanation next to what it explains. placement is where the bubble sits; the pointer faces the trigger. dismiss is a coach mark that stays until closed.',
    code: ['<span class="swing_tip" data-placement="top"><button class="swing_tip__btn" type="button" aria-label="About the service fee" aria-describedby="t1">…</button><span class="swing_tooltip" id="t1" role="tooltip">Covers payment processing and support.</span></span>',
      'placement = data-placement · dismiss = .swing_tooltip_dismiss + .swing_tooltip__close · data-align="start|end" pins it to an edge'],
    colGroups: [{ label: 'dismiss', cols: ['false', 'true · coach mark'] }], rowGroups: [{ label: 'placement', rows: TT_PLACE }],
    place: function (v) { return { cg: 0, c: v.dismiss === 'true' ? 1 : 0, rg: 0, r: TT_PLACE.indexOf(v.placement) }; }
  });
  // MapPin
  var mv = simpleSet([{ selected: 'false' }, { selected: 'true' }]), mParts = {};
  var pin = await buildSet(page, 'MapPin', mv, async function (comp, v) {
    var on = v.selected === 'true';
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(80, 32); comp.layoutSizingHorizontal = 'HUG'; comp.layoutSizingVertical = 'FIXED';
    bindNumber(R, comp, 'paddingLeft', '--space-12', 12); bindNumber(R, comp, 'paddingRight', '--space-12', 12);
    bindRadius(R, comp, '--radius-8', 8);
    comp.fills = paintFor(R, on ? '--dark-400' : '--light-100');
    comp.clipsContent = false;
    var el = R.effects['--elevation-1'];
    if (el) await comp.setEffectStyleIdAsync(el.id);
    var t = await styledText(R, '--type-b2s', on ? '--light-100' : '--purple-600', 'Rp 850k');
    comp.appendChild(t); t.name = 'label'; t.textAutoResize = 'WIDTH_AND_HEIGHT';
    pointerArrow(R, comp, 'down', on ? '--dark-400' : '--light-100');
    mParts[comp.name] = t;
  }, function (set) {
    var p = ensureProp(set, 'label', 'TEXT', 'Rp 850k');
    wireKeys(mParts).forEach(function (k) { mParts[k].componentPropertyReferences = { characters: p }; });
    set.description = '<button class="swing_map_pin" aria-pressed="{selected}">{label}</button>. White label h32, padding 12, radius 8, purple-600 B2 Semibold, Elevation 1, 8px pointer. selected = dark-400 + white (scales to 1.08 on the web).';
  }, function () {}, R);
  var pm = pairUp(pin, mv, function (c) { return mParts[c.name]; });
  await docArtboard(R, page, pin, pm.comps, pm.vs, {
    title: 'MapPin', description: 'A price or name label over the map. The selected one turns dark.',
    code: ['<button class="swing_map_pin" type="button" aria-pressed="false">Rp 850k</button>', 'selected = aria-pressed="true"'],
    colGroups: [{ label: 'selected', cols: ['false', 'true'] }], rowGroups: [{ label: 'example', rows: ['pin'] }],
    place: function (v) { return { cg: 0, c: v.selected === 'true' ? 1 : 0, rg: 0, r: 0 }; },
    backdrop: function () { return '--light-300'; }
  });
  notes.push('Tooltip: the tip trigger button (info 16 in a 24 target) is part of the screen, not this component. MapPin: the selected pin scales to 1.08 on the web; Figma shows the colour only.');
  return { set: set, count: variants.length + mv.length, label: 'Tooltip ' + variants.length + ', MapPin ' + mv.length + ' variants' };
}

// find a built set on its page, or build that page first.
// UI components (screen-level parts) are always main components of THIS file, also in library mode:
// the UI file is the DS for them, and their atoms (Button, icons, tokens) come from the base library.
// They live on the page of the screen that introduced them (a later screen reuses them from there).
var UI_PARTS = { PhotoTile: 'Screen / Home', PassUpsell: 'Screen / Home', SectionHead: 'Screen / Home', ProductCard: 'Screen / Home',
  PromoBanner: 'Screen / Home', HelpCard: 'Screen / Home', LinkCard: 'Screen / Home', ProfileHead: 'Screen / Account', NotifRow: 'Screen / Updates',
  CreditCard: 'Screen / Swing Credits', AdsRow: 'Screen / Swing Credits', RewardCard: 'Screen / Swing Credits', AskBox: 'Screen / Swing Credits',
  MailFoot: 'Screen / Verify email',
  CodeCard: 'Screen / Refer & earn', StatPanel: 'Screen / Refer & earn', StepCard: 'Screen / Refer & earn', FaqItem: 'Screen / Refer & earn',
  CodeHero: 'Screen / IG story',
  KvRow: 'Screen / Swing Pass email',
  PassCard: 'Screen / Swing Pass', SaveCard: 'Screen / Swing Pass', PayMethod: 'Screen / Swing Pass', DealCard: 'Screen / Swing Pass', Perk: 'Screen / Swing Pass',
  EventsHead: 'Screen / Swing Pass events', EventCard: 'Screen / Swing Pass events', HostCta: 'Screen / Swing Pass events',
  PromoCard: 'Screen / Swing Pass event', CreditStrip: 'Screen / Swing Pass event', InfoTile: 'Screen / Swing Pass event', Venue: 'Screen / Swing Pass event', BrandCard: 'Screen / Swing Pass event',
  NoteBar: 'Screen / Join Swing Pass', MethodRow: 'Screen / Join Swing Pass', Plan: 'Screen / Join Swing Pass',
  ChoiceRow: 'Screen / Swing Pass cancel',
  BillRow: 'Screen / Swing Pass billing history',
  DateBtn: 'Screen / Golf course', SessionTab: 'Screen / Golf course', RateCard: 'Screen / Golf course', InclItem: 'Screen / Golf course', Amenity: 'Screen / Golf course', StatTile: 'Screen / Golf course',
  PayType: 'Screen / Booking', PlayerRow: 'Screen / Booking', MiniRow: 'Screen / Booking', PriceRow: 'Screen / Booking', PayBar: 'Screen / Booking',
  RefRow: 'Screen / Track' };
// Assets panel folders come from slash names: a UI component is "<screen>/<name>" (Home/ProductCard).
function uiSetName(name) { return UI_PARTS[name] ? UI_PARTS[name].replace(/^Screen \/ /, '') + '/' + name : name; }
function isUiSet(n, name) { return n.type === 'COMPONENT_SET' && (setTag(n).logical === name || n.name === swingBase(uiSetName(name)) || n.name === uiSetName(name) || n.name === name); }
async function setFrom(pageName, setName, buildPage, R, notes) {
  if (LIB && !UI_PARTS[setName]) return libSet(setName, pageName);
  pageName = UI_PARTS[setName] || pageName;
  var pg = await pageNamed(pageName);
  var alt = UI_PARTS[setName] ? uiSetName(setName) : null;
  var set = findLogical(pg, setName, alt);
  // a set built before the swing names (no tag): build its page once, which renames and splits it in place
  if (set && !set.__split && !setTag(set).logical) { await buildPage(R, notes); set = findLogical(pg, setName, alt) || set; }
  if (set) return set;
  await buildPage(R, notes);
  return findLogical(pg, setName, alt);
}
// setFrom, and the set must have this variant: a page built before the variant existed is rebuilt
// (in place, instances stay linked). In library mode a missing variant means "publish again".
async function setWith(pageName, setName, buildPage, R, notes, variant) {
  var has = function (s) { return s && s.children.some(function (c) { return c.name === variant; }); };
  var set = await setFrom(pageName, setName, buildPage, R, notes);
  if (!has(set) && (!LIB || UI_PARTS[setName])) { await buildPage(R, notes); set = await setFrom(pageName, setName, buildPage, R, notes); }   // UI components live in this file, so they can be rebuilt in library mode too
  if (!has(set)) throw new Error(setName + ' has no "' + variant + '" variant' + (LIB ? ' in the library yet. Build the ' + pageName + ' page in the DS file, publish, and export the keys again.' : '.'));
  return set;
}

/* ----- Step + Steps (components.css .steps, .step) ----- */
var STEP_STATES = ['todo', 'current', 'done'];

async function buildStepsPage(R, notes) {
  var page = await pageNamed('Steps');
  var check = (await findIcon('Icon/Solid/checkmark')) || (await iconOrPlaceholder('Icon/Line/checkmark', page, notes));
  var variants = [], parts = {};
  STEP_STATES.forEach(function (s) { ['false', 'true'].forEach(function (l) { variants.push({ state: s, last: l }); }); });
  simpleSet(variants);
  async function buildVariant(comp, v) {
    var C = { todo: ['--light-300', '--dark-300', '--light-500'], current: ['--purple-500', '--light-100', '--light-500'], done: ['--green-50', '--color-success', '--green-500'] }[v.state];
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'MIN';
    comp.resize(342, 60); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--space-12', 12);
    if (v.last === 'true') comp.paddingBottom = 0; else bindNumber(R, comp, 'paddingBottom', '--space-16', 16);
    comp.fills = [];
    var dot = autoFrame('marker', 'HORIZONTAL', comp);   // ::before: 32 circle with the number (done: a check)
    dot.primaryAxisAlignItems = 'CENTER'; dot.counterAxisAlignItems = 'CENTER';
    dot.resize(32, 32); dot.layoutSizingHorizontal = 'FIXED'; dot.layoutSizingVertical = 'FIXED';
    pillRadius(dot, 32);
    dot.fills = paintFor(R, C[0]);
    var p = {};
    if (v.state === 'done') {
      var ck = check.createInstance(); dot.appendChild(ck); ck.name = 'check'; ck.resize(16, 16);
      recolorIcon(R, ck, C[1]);
    } else {
      var n = await styledText(R, '--type-b2s', C[1], '01');
      dot.appendChild(n); n.name = 'number'; n.textAutoResize = 'WIDTH_AND_HEIGHT';
      p.number = n;
    }
    var col = autoFrame('text', 'VERTICAL', comp);
    col.layoutSizingHorizontal = 'FILL'; col.layoutSizingVertical = 'HUG';
    bindNumber(R, col, 'paddingTop', '--space-4', 4);
    var t = await styledText(R, '--type-b1s', v.state === 'current' ? '--purple-600' : '--dark-500', 'Choose a tee time');
    col.appendChild(t); t.name = 'title'; t.textAutoResize = 'HEIGHT'; t.layoutSizingHorizontal = 'FILL';
    var b = await styledText(R, '--type-b2', '--dark-300', 'Morning slots fill first on weekends');
    col.appendChild(b); b.name = 'body'; b.textAutoResize = 'HEIGHT'; b.layoutSizingHorizontal = 'FILL';
    var mb = autoFrame('meta', 'HORIZONTAL', comp);
    mb.layoutSizingHorizontal = 'HUG'; mb.layoutSizingVertical = 'HUG';
    bindNumber(R, mb, 'paddingTop', '--space-4', 4);
    var m = await styledText(R, '--type-b2', '--dark-300', '2 min');
    mb.appendChild(m); m.name = 'text'; m.textAutoResize = 'WIDTH_AND_HEIGHT';
    mb.visible = false;
    if (v.last !== 'true') {   // ::after: 2px line from 4 under the circle to 4 above the next step
      var line = figma.createRectangle();
      comp.appendChild(line);
      line.name = 'connector';
      line.layoutPositioning = 'ABSOLUTE';
      line.x = 15; line.y = 36; line.resize(2, Math.max(1, comp.height - 40));
      line.constraints = { horizontal: 'MIN', vertical: 'STRETCH' };
      line.fills = paintFor(R, C[2]);
    }
    p.title = t; p.body = b; p.meta = mb; p.metaText = m;
    parts[comp.name] = p;
  }
  function wire(set) {
    var pN = ensureProp(set, 'number', 'TEXT', '01');
    var pT = ensureProp(set, 'title', 'TEXT', 'Choose a tee time');
    var pSB = ensureProp(set, 'showBody', 'BOOLEAN', true);
    var pB = ensureProp(set, 'body', 'TEXT', 'Morning slots fill first on weekends');
    var pSM = ensureProp(set, 'showMeta', 'BOOLEAN', false);
    var pM = ensureProp(set, 'meta', 'TEXT', '2 min');
    wireKeys(parts).forEach(function (k) {
      var p = parts[k];
      if (p.number) p.number.componentPropertyReferences = { characters: pN };
      p.title.componentPropertyReferences = { characters: pT };
      p.body.componentPropertyReferences = { visible: pSB, characters: pB };
      p.meta.componentPropertyReferences = { visible: pSM };
      p.metaText.componentPropertyReferences = { characters: pM };
    });
    set.description = '<li class="swing_step [is-done|is-current]"><span class="swing_step__check"></span><span class="swing_step__text"><span class="swing_step__title">{title}</span><span class="swing_step__body">{body}</span></span><span class="swing_step__meta">{meta}</span></li> in <ol class="swing_steps">. ' +
      'Number (01, 02…) in a 32 circle, B2 Semibold, 2px connector to the next step. todo = light-300 / dark-300 · current = purple-500 / white, title purple-600 · done = green-50 + green-500 check, green-500 line. last = no line, no bottom padding.';
  }
  var set = await buildSet(page, 'Step', variants, buildVariant, wire, function () {}, R);
  var pv = pairUp(set, variants, function (c) { return parts[c.name]; });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'Step', description: 'One step of a process: done ones get a green check, the current one is purple, the rest wait in grey.',
    code: ['<li class="swing_step is-current"><span class="swing_step__text"><span class="swing_step__title">Choose a tee time</span><span class="swing_step__body">…</span></span></li>', 'state done = .is-done · current = .is-current · last = :last-child'],
    colGroups: [{ label: 'last', cols: ['false', 'true'] }], rowGroups: [{ label: 'state', rows: STEP_STATES }],
    place: function (v) { return { cg: 0, c: v.last === 'true' ? 1 : 0, rg: 0, r: STEP_STATES.indexOf(v.state) }; }
  });
  var S = byName(set);
  var sv = [{ name: 'type=default' }];
  var steps = await buildSet(page, 'Steps', sv, async function (comp) {
    comp.layoutMode = 'VERTICAL'; comp.resize(342, 100);
    comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    comp.itemSpacing = 0; comp.fills = [];
    [['done', 'false', '01', 'Pick a course', 'Pondok Indah Golf Course'], ['current', 'false', '02', 'Choose a tee time', 'Morning slots fill first on weekends'], ['todo', 'true', '03', 'Pay', 'Card, e-wallet or bank transfer']].forEach(function (s) {
      var it = S['state=' + s[0] + ', last=' + s[1]].createInstance();
      comp.appendChild(it); it.layoutSizingHorizontal = 'FILL';
      try { it.setProperties(propsFor(it, { number: s[2], title: s[3], body: s[4] })); } catch (e) { /* defaults */ }
    });
  }, function (s) { s.description = '<ol class="swing_steps">…step…</ol>. Step instances, the last one with last=true.'; }, function () {}, R);
  var ps = pairUp(steps, sv, function (c) { return c.name === 'type=default'; });
  await docArtboard(R, page, steps, ps.comps, ps.vs, {
    title: 'Steps', description: 'A booking or onboarding flow as a vertical list of steps.',
    code: ['<ol class="swing_steps"><li class="swing_step is-done">…</li><li class="swing_step is-current">…</li><li class="swing_step">…</li></ol>', 'Step instances; the number comes from a CSS counter'],
    colGroups: [{ label: 'example', cols: ['steps'] }], rowGroups: [{ label: 'type', rows: ['default'] }],
    place: function () { return { cg: 0, c: 0, rg: 0, r: 0 }; }
  });
  return { set: set, count: variants.length + 1, label: 'Step ' + variants.length + ', Steps 1 variants' };
}

/* ----- Review, Comment, ChatRow (components.css .review, .comment, .chat-row) ----- */
async function buildReviewPage(R, notes) {
  var page = await pageNamed('Review');
  var avatarSet = await setFrom('Avatar', 'Avatar', buildAvatarPage, R, notes);
  var AV = byName(avatarSet);
  var star = (await findIcon('Icon/Solid/stars')) || (await iconOrPlaceholder('Icon/Line/stars', page, notes));
  function divider(comp, left) { return bottomLine(R, comp, 'divider', left || 0, '--color-line'); }
  // Review
  var rv = simpleSet([{ open: 'false' }, { open: 'true' }]), rParts = {};
  var LONG = 'Greens were fast and true, the caddie knew every break. Back nine gets windy after ten, so book early. The clubhouse food was good too and the staff helped us with the rental set when one of the clubs was missing.';
  var review = await buildSet(page, 'Review', rv, async function (comp, v) {
    comp.layoutMode = 'VERTICAL'; comp.resize(342, 100);
    comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--space-8', 8);
    bindNumber(R, comp, 'paddingTop', '--space-16', 16); bindNumber(R, comp, 'paddingBottom', '--space-16', 16);
    comp.fills = [];
    var by = autoFrame('by', 'HORIZONTAL', comp);
    by.counterAxisAlignItems = 'CENTER'; by.layoutSizingHorizontal = 'FILL'; by.layoutSizingVertical = 'HUG';
    bindNumber(R, by, 'itemSpacing', '--space-8', 8);
    by.appendChild(AV['size=s, type=initials'].createInstance());
    var nm = await styledText(R, '--type-b2s', '--dark-500', 'Ghais Ramadhan');
    by.appendChild(nm); nm.name = 'name'; nm.textAutoResize = 'WIDTH_AND_HEIGHT';
    var dt = await styledText(R, '--type-b2', '--dark-300', '2 days ago');
    by.appendChild(dt); dt.name = 'date'; dt.textAutoResize = 'WIDTH_AND_HEIGHT';
    var st = autoFrame('stars', 'HORIZONTAL', comp);
    st.layoutSizingHorizontal = 'HUG'; st.layoutSizingVertical = 'HUG';
    bindNumber(R, st, 'itemSpacing', '--space-4', 4);
    for (var i = 0; i < 5; i++) { var s = star.createInstance(); st.appendChild(s); s.resize(16, 16); recolorIcon(R, s, i < 4 ? '--orange-500' : '--light-500'); }
    var tx = await styledText(R, '--type-b1', '--dark-500', LONG);
    comp.appendChild(tx); tx.name = 'text'; tx.textAutoResize = 'HEIGHT'; tx.layoutSizingHorizontal = 'FILL';
    if (v.open !== 'true') { try { tx.textTruncation = 'ENDING'; tx.maxLines = 3; } catch (e) { /* older API */ } }
    rParts[comp.name] = { name: nm, date: dt, text: tx, line: divider(comp) };
  }, function (set) {
    var pN = ensureProp(set, 'name', 'TEXT', 'Ghais Ramadhan'), pD = ensureProp(set, 'date', 'TEXT', '2 days ago'), pT = ensureProp(set, 'text', 'TEXT', LONG), pL = ensureProp(set, 'showDivider', 'BOOLEAN', true);
    wireKeys(rParts).forEach(function (k) { var p = rParts[k]; p.name.componentPropertyReferences = { characters: pN }; p.date.componentPropertyReferences = { characters: pD }; p.text.componentPropertyReferences = { characters: pT }; p.line.componentPropertyReferences = { visible: pL }; });
    set.description = '<article class="swing_review [is-open]"><div class="swing_review__by"><span class="swing_avatar swing_avatar_s">…</span><b>{name}</b>{date}</div><span class="swing_stars swing_stars_s">…</span><p class="swing_review__text">{text}</p></article>. Padding 16 0, gap 8, line under (off on the last). Text B1, clamped to 3 lines until open. Stars 16 orange-500, off light-500.';
  }, function () {}, R);
  var pr = pairUp(review, rv, function (c) { return rParts[c.name]; });
  await docArtboard(R, page, review, pr.comps, pr.vs, {
    title: 'Review', description: 'A course or coach review: who, when, the score, then the text clamped to three lines until opened.',
    code: ['<article class="swing_review"><div class="swing_review__by"><span class="swing_avatar swing_avatar_s">GR</span><b>Ghais Ramadhan</b> 2 days ago</div><span class="swing_stars swing_stars_s">…</span><p class="swing_review__text">…</p></article>', 'open = .is-open (no clamp) · showDivider off on the last one'],
    colGroups: [{ label: 'open', cols: ['false · 3 lines', 'true'] }], rowGroups: [{ label: 'example', rows: ['review'] }],
    place: function (v) { return { cg: 0, c: v.open === 'true' ? 1 : 0, rg: 0, r: 0 }; }
  });
  // Comment
  var cv = [{ name: 'type=default' }], cParts = {};
  var comment = await buildSet(page, 'Comment', cv, async function (comp) {
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'MIN';
    comp.resize(342, 80); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--space-12', 12);
    bindNumber(R, comp, 'paddingTop', '--space-16', 16); bindNumber(R, comp, 'paddingBottom', '--space-16', 16);
    comp.fills = [];
    comp.appendChild(AV['size=s, type=initials'].createInstance());
    var main = autoFrame('main', 'VERTICAL', comp);
    main.layoutSizingHorizontal = 'FILL'; main.layoutSizingVertical = 'HUG';
    bindNumber(R, main, 'itemSpacing', '--space-4', 4);
    var head = autoFrame('head', 'HORIZONTAL', main);
    head.counterAxisAlignItems = 'BASELINE'; head.layoutSizingHorizontal = 'FILL'; head.layoutSizingVertical = 'HUG';
    bindNumber(R, head, 'itemSpacing', '--space-8', 8);
    var nm = await styledText(R, '--type-b1s', '--dark-500', 'Ardi Pratama');
    head.appendChild(nm); nm.name = 'name'; nm.textAutoResize = 'WIDTH_AND_HEIGHT';
    var tm = await styledText(R, '--type-b3', '--dark-300', '1h');
    head.appendChild(tm); tm.name = 'time'; tm.textAutoResize = 'WIDTH_AND_HEIGHT';
    var tx = await styledText(R, '--type-b1', '--dark-500', 'Count me in for Saturday. I can bring one more player.');
    main.appendChild(tx); tx.name = 'text'; tx.textAutoResize = 'HEIGHT'; tx.layoutSizingHorizontal = 'FILL';
    var acts = autoFrame('actions', 'HORIZONTAL', main);
    acts.layoutSizingHorizontal = 'HUG'; acts.layoutSizingVertical = 'HUG';
    bindNumber(R, acts, 'itemSpacing', '--space-16', 16);
    for (var a of ['Reply', 'Like']) { var at = await styledText(R, '--type-b2s', '--dark-300', a); acts.appendChild(at); at.name = a.toLowerCase(); at.textAutoResize = 'WIDTH_AND_HEIGHT'; }
    cParts[comp.name] = { name: nm, time: tm, text: tx, acts: acts, line: divider(comp) };
  }, function (set) {
    var pN = ensureProp(set, 'name', 'TEXT', 'Ardi Pratama'), pTm = ensureProp(set, 'time', 'TEXT', '1h'), pT = ensureProp(set, 'text', 'TEXT', 'Count me in for Saturday. I can bring one more player.');
    var pA = ensureProp(set, 'showActions', 'BOOLEAN', true), pL = ensureProp(set, 'showDivider', 'BOOLEAN', true);
    wireKeys(cParts).forEach(function (k) { var p = cParts[k]; p.name.componentPropertyReferences = { characters: pN }; p.time.componentPropertyReferences = { characters: pTm }; p.text.componentPropertyReferences = { characters: pT }; p.acts.componentPropertyReferences = { visible: pA }; p.line.componentPropertyReferences = { visible: pL }; });
    set.description = '<div class="swing_comment"><span class="swing_avatar swing_avatar_s">…</span><div class="swing_comment__main"><div class="swing_comment__head"><span class="swing_comment__name">{name}</span><span class="swing_comment__time">{time}</span></div><p class="swing_comment__text">{text}</p><div class="swing_comment__acts">Reply · Like</div></div></div>. Padding 16 0, gap 12, line under.';
  }, function () {}, R);
  var pc = pairUp(comment, cv, function (c) { return c.name === 'type=default'; });
  await docArtboard(R, page, comment, pc.comps, pc.vs, {
    title: 'Comment', description: 'A comment in a community post or game thread.',
    code: ['<div class="swing_comment"><span class="swing_avatar swing_avatar_s">AP</span><div class="swing_comment__main"><div class="swing_comment__head"><span class="swing_comment__name">Ardi Pratama</span><span class="swing_comment__time">1h</span></div><p class="swing_comment__text">…</p><div class="swing_comment__acts">…</div></div></div>', 'showActions = .swing_comment__acts · showDivider off on the last one'],
    colGroups: [{ label: 'example', cols: ['comment'] }], rowGroups: [{ label: 'type', rows: ['default'] }],
    place: function () { return { cg: 0, c: 0, rg: 0, r: 0 }; }
  });
  // ChatRow
  var counterSet = await setFrom('Badge', 'Counter', buildBadgePage, R, notes);
  var counterMain = counterSet && counterSet.children.find(function (c) { return /tone=primary/.test(c.name) && /size=20/.test(c.name) && /placement=inline/.test(c.name); });
  var hv = simpleSet([{ unread: 'false' }, { unread: 'true' }]), hParts = {};
  var chat = await buildSet(page, 'ChatRow', hv, async function (comp, v) {
    var un = v.unread === 'true';
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(342, 80); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--space-12', 12);
    bindNumber(R, comp, 'paddingTop', '--space-16', 16); bindNumber(R, comp, 'paddingBottom', '--space-16', 16);
    comp.fills = [];
    comp.appendChild(AV['size=m, type=initials'].createInstance());
    var col = autoFrame('text', 'VERTICAL', comp);
    col.layoutSizingHorizontal = 'FILL'; col.layoutSizingVertical = 'HUG';
    var head = autoFrame('title', 'HORIZONTAL', col);
    head.counterAxisAlignItems = 'BASELINE'; head.layoutSizingHorizontal = 'FILL'; head.layoutSizingVertical = 'HUG';
    bindNumber(R, head, 'itemSpacing', '--space-8', 8);
    var nm = await styledText(R, '--type-b1s', '--dark-500', 'Sabtu pagi @ Pondok Indah');
    head.appendChild(nm); nm.name = 'name'; nm.textAutoResize = 'HEIGHT'; nm.layoutSizingHorizontal = 'FILL'; nm.textTruncation = 'ENDING'; nm.maxLines = 1;
    var tm = await styledText(R, un ? '--type-b3s' : '--type-b3', un ? '--purple-600' : '--dark-300', '09:41');
    head.appendChild(tm); tm.name = 'time'; tm.textAutoResize = 'WIDTH_AND_HEIGHT';
    var row = autoFrame('bodyRow', 'HORIZONTAL', col);
    row.counterAxisAlignItems = 'CENTER'; row.layoutSizingHorizontal = 'FILL'; row.layoutSizingVertical = 'HUG';
    bindNumber(R, row, 'itemSpacing', '--space-8', 8);
    var bd = await styledText(R, '--type-b2', un ? '--dark-500' : '--dark-300', 'Ardi: Count me in, I can bring one more player for the back nine.');
    row.appendChild(bd); bd.name = 'body'; bd.textAutoResize = 'HEIGHT'; bd.layoutSizingHorizontal = 'FILL';
    try { bd.textTruncation = 'ENDING'; bd.maxLines = 2; } catch (e) { /* older API */ }
    var side = null;
    if (un) {
      if (counterMain) { side = counterMain.createInstance(); row.appendChild(side); side.name = 'Counter'; }
      else {
        side = autoFrame('counter', 'HORIZONTAL', row); side.fills = paintFor(R, '--purple-500');
        var ct = await styledText(R, '--type-lbl-l', '--light-100', '2'); side.appendChild(ct);
      }
    }
    hParts[comp.name] = { name: nm, time: tm, body: bd, line: divider(comp, 60) };   // .list--inset-avatar-m: 48 + 12
  }, function (set) {
    var pN = ensureProp(set, 'name', 'TEXT', 'Sabtu pagi @ Pondok Indah'), pTm = ensureProp(set, 'time', 'TEXT', '09:41');
    var pB = ensureProp(set, 'body', 'TEXT', 'Ardi: Count me in, I can bring one more player for the back nine.'), pL = ensureProp(set, 'showDivider', 'BOOLEAN', true);
    wireKeys(hParts).forEach(function (k) { var p = hParts[k]; p.name.componentPropertyReferences = { characters: pN }; p.time.componentPropertyReferences = { characters: pTm }; p.body.componentPropertyReferences = { characters: pB }; p.line.componentPropertyReferences = { visible: pL }; });
    set.description = '<a class="swing_list_item swing_list_item_standard swing_chat_row [is-unread]"><span class="swing_list_item__lead"><span class="swing_avatar">…</span></span><span class="swing_list_item__text"><span class="swing_list_item__title"><span>{name}</span><span class="swing_chat_row__time">{time}</span></span><span class="swing_list_item__body">{body}</span></span><span class="swing_chat_row__side">…counter…</span></a> in .swing_list_inset_avatar_m. ' +
      'Avatar 48, name B1 Semibold (one line), time B3, body B2 clamped to 2 lines. unread = time purple-600 B3 Semibold, body dark-500, primary Counter.';
  }, function () {}, R);
  var ph = pairUp(chat, hv, function (c) { return hParts[c.name]; });
  await docArtboard(R, page, chat, ph.comps, ph.vs, {
    title: 'ChatRow', description: 'A conversation in the chat list. Unread ones show the time in purple and a count.',
    code: ['<div class="swing_list swing_list_inset_avatar_m"><a class="swing_list_item swing_list_item_standard swing_chat_row is-unread" href="#">…</a></div>', 'unread = .is-unread · the divider starts after the 48 avatar + 12'],
    colGroups: [{ label: 'unread', cols: ['false', 'true'] }], rowGroups: [{ label: 'example', rows: ['chat'] }],
    place: function (v) { return { cg: 0, c: v.unread === 'true' ? 1 : 0, rg: 0, r: 0 }; }
  });
  return { set: review, count: rv.length + 1 + hv.length, label: 'Review 2, Comment 1, ChatRow 2 variants' };
}

/* ----- BottomNavItem + BottomNav (components.css .bottom-nav) ----- */
var BN_VARIANTS = [{ type: 'tab', state: 'default' }, { type: 'tab', state: 'active' }, { type: 'tab', state: 'pressed' }, { type: 'action', state: 'default' }, { type: 'action', state: 'pressed' }];

async function buildBottomNavPage(R, notes) {
  var page = await pageNamed('BottomNav');
  var ic = async function (n) { return { line: await iconOrPlaceholder('Icon/Line/' + n, page, notes), solid: (await findIcon('Icon/Solid/' + n)) || (await iconOrPlaceholder('Icon/Line/' + n, page, notes)) }; };
  var home = await ic('home'), compass = await ic('compass'), chat = await ic('chat-circle'), user = await ic('user');
  var plus = await iconOrPlaceholder('Icon/Line/add-lg', page, notes);
  var counterSet = await setFrom('Badge', 'Counter', buildBadgePage, R, notes);
  var corner = counterSet && counterSet.children.find(function (c) { return /tone=danger/.test(c.name) && /size=16/.test(c.name) && /placement=corner/.test(c.name); });
  var variants = simpleSet(BN_VARIANTS.map(function (v) { return { type: v.type, state: v.state }; })), parts = {};
  async function buildVariant(comp, v) {
    var act = v.type === 'action', on = v.state === 'active', press = v.state === 'pressed';
    comp.layoutMode = 'VERTICAL';
    comp.primaryAxisAlignItems = 'CENTER'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(74, 52); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    comp.minHeight = 52;
    bindNumber(R, comp, 'itemSpacing', '--space-4', 4);
    bindNumber(R, comp, 'paddingTop', '--space-8', 8);
    bindNumber(R, comp, 'paddingLeft', '--space-4', 4); bindNumber(R, comp, 'paddingRight', '--space-4', 4);
    bindNumber(R, comp, 'paddingBottom', '--space-4', 4);
    bindRadius(R, comp, '--radius-8', 8);
    comp.fills = press && !act ? paintFor(R, '--light-300') : [];
    comp.clipsContent = false;
    var p = {};
    var box = autoFrame('icon', 'HORIZONTAL', comp);
    box.resize(24, 24); box.layoutSizingHorizontal = 'FIXED'; box.layoutSizingVertical = 'FIXED';
    box.clipsContent = false;
    if (act) {   // 48 purple circle, pulled up 24 (margin-top -24), 4px ring in the nav colour
      var c = figma.createFrame();
      box.appendChild(c);
      c.name = 'circle';
      c.layoutPositioning = 'ABSOLUTE';
      c.layoutMode = 'HORIZONTAL'; c.primaryAxisAlignItems = 'CENTER'; c.counterAxisAlignItems = 'CENTER';
      c.resize(48, 48); c.x = -12; c.y = -24;
      pillRadius(c, 48);
      c.fills = paintFor(R, press ? '--purple-600' : '--purple-500');
      var ring = bgRing(R)[0];
      c.effects = [Object.assign({}, ring, { spread: 4 })];
      var pi = plus.createInstance(); c.appendChild(pi); pi.name = 'icon'; pi.resize(24, 24);
      recolorIcon(R, pi, '--light-100');
      p.icon = pi;
    } else {
      var i = (on ? home.solid : home.line).createInstance();
      box.appendChild(i); i.name = on ? 'iconSolid' : 'iconLine'; i.resize(24, 24);
      recolorIcon(R, i, on ? '--purple-500' : '--dark-300');
      p.icon = i;
      if (corner) {
        var ct = corner.createInstance();
        box.appendChild(ct);
        ct.name = 'Counter';
        ct.layoutPositioning = 'ABSOLUTE';
        ct.x = 16; ct.y = -4;   // top -4, left 100% - 8
        ct.visible = false;
        p.counter = ct;
      }
    }
    var t = await styledText(R, '--type-b3s', act || on ? '--purple-600' : '--dark-300', act ? 'Post' : 'Home');
    comp.appendChild(t); t.name = 'label'; t.textAutoResize = 'WIDTH_AND_HEIGHT'; t.textTruncation = 'ENDING';
    p.label = t;
    parts[comp.name] = p;
  }
  function wire(set) {
    var pL = ensureProp(set, 'label', 'TEXT', 'Home');
    var pI = ensureProp(set, 'icon', 'INSTANCE_SWAP', home.line.id);
    var pC = ensureProp(set, 'showCounter', 'BOOLEAN', false);
    wireKeys(parts).forEach(function (k) {
      var p = parts[k];
      p.label.componentPropertyReferences = { characters: pL };
      if (!/type=action/.test(k)) p.icon.componentPropertyReferences = { mainComponent: pI };
      if (p.counter) p.counter.componentPropertyReferences = { visible: pC };
    });
    set.description = '<a class="swing_bottom_nav__item [is-active]" aria-current="page"><span class="swing_bottom_nav__icon"><i class="swing_icon swing_bottom_nav__line"></i><i class="swing_icon swing_bottom_nav__solid"></i></span><span class="swing_bottom_nav__label">{label}</span></a>. ' +
      'Min 52, padding 8/4/4, gap 4, icon 24, B3 Semibold dark-300. active = the SOLID icon in purple-500 + purple-600 label (swap icon to the solid one) · pressed = light-300 · action = 48 purple-500 circle pulled up 24, + icon, middle slot only. showCounter = .swing_counter on the icon.';
  }
  var set = await buildSet(page, 'BottomNavItem', variants, buildVariant, wire, function () {}, R);
  var pv = pairUp(set, variants, function (c) { return parts[c.name]; });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'BottomNavItem', description: 'One tab of the bottom navigation. Active uses the solid icon and a purple label, no extra indicator. The action is the purple Post button in the middle.',
    code: ['<a class="swing_bottom_nav__item is-active" href="/home" aria-current="page"><span class="swing_bottom_nav__icon">…line + solid…</span><span class="swing_bottom_nav__label">Home</span></a>', 'state active = .is-active / aria-current · type action = .swing_bottom_nav__item_action'],
    colGroups: [{ label: 'type', cols: ['tab', 'action'] }], rowGroups: [{ label: 'state', rows: ['default', 'active', 'pressed'] }],
    place: function (v) { return { cg: 0, c: v.type === 'action' ? 1 : 0, rg: 0, r: ['default', 'active', 'pressed'].indexOf(v.state) }; }
  });
  var B = byName(set);
  // Home V5 tabs (ref/home.html): Activity and Account icons are not in the DS icon set yet
  var actIc = await refIcon(R, 'albatross', 'ds/brand/albatross-icon.svg', 24, '--dark-300', notes, page);
  var accIc = await refIcon(R, 'nav-account', 'ref/img/nav-account.svg', 24, '--dark-300', notes, page);
  var nv = simpleSet([{ items: '5' }, { items: '4' }, { items: '3' }]);
  var nav = await buildSet(page, 'BottomNav', nv, async function (comp, v) {
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'MAX';
    comp.resize(390, 64); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    comp.itemSpacing = 0;
    bindNumber(R, comp, 'paddingTop', '--space-4', 4);
    bindNumber(R, comp, 'paddingLeft', '--space-8', 8); bindNumber(R, comp, 'paddingRight', '--space-8', 8);
    bindNumber(R, comp, 'paddingBottom', '--space-8', 8);
    comp.fills = paintFor(R, '--light-100');
    comp.clipsContent = false;
    var up = lineBelow(R)[0];
    comp.effects = [Object.assign({}, up, { offset: { x: 0, y: -1 } })];   // --line-sticky-up
    var tabs = v.items === '5'
      ? [['active', 'Home', home.solid], ['default', 'Explore', compass.line], ['action', 'Post'], ['default', 'Chats', chat.line], ['default', 'Account', user.line]]
      : v.items === '3' ? [['active', 'Home', home.solid], ['default', 'Activity', actIc], ['default', 'Account', accIc]]
      : [['active', 'Home', home.solid], ['default', 'Explore', compass.line], ['default', 'Chats', chat.line], ['default', 'Account', user.line]];
    tabs.forEach(function (t) {
      var it = B[t[0] === 'action' ? 'type=action, state=default' : 'type=tab, state=' + t[0]].createInstance();
      comp.appendChild(it); it.layoutSizingHorizontal = 'FILL';
      var props = { label: t[1] };
      if (t[2]) props.icon = t[2].id;
      try { it.setProperties(propsFor(it, props)); } catch (e) { /* defaults */ }
    });
  }, function (s) { s.description = '<nav class="swing_bottom_nav" aria-label="Main">…swing_bottom_nav__item…</nav>. 390 wide, light-100, 1px light-500 line on top (--line-sticky-up), padding 4/8/8 (bottom grows with the home indicator), 3–5 equal items. Swap the active tab and its solid icon per screen.'; }, function () {}, R);
  var pn = pairUp(nav, nv, function (c) { return /^items=/.test(c.name); });
  await docArtboard(R, page, nav, pn.comps, pn.vs, {
    title: 'BottomNav', description: 'The main navigation. Five items with the Post action in the middle, four tabs, or the three tabs of the Home V5 app (Home, Activity, Account).',
    code: ['<nav class="swing_bottom_nav" aria-label="Main"><a class="swing_bottom_nav__item is-active" aria-current="page">…</a>…</nav>', 'items 5 = with .swing_bottom_nav__item_action in the middle · items 3 = ref/home.html'],
    colGroups: [{ label: 'example', cols: ['nav'] }], rowGroups: [{ label: 'items', rows: ['5', '4', '3'] }],
    place: function (v) { return { cg: 0, c: 0, rg: 0, r: ['5', '4', '3'].indexOf(v.items) }; }
  });
  notes.push('BottomNav: the active icon pops in (scale .82 to 1) and the action circle scales to .96 on press on the web; Figma shows the end state.');
  return { set: set, count: variants.length + nv.length, label: 'BottomNavItem 5, BottomNav 3 variants' };
}

/* ----- Brand marks + AppBar (components.css .appbar) ----- */
var SWING_WORDMARK_SVG = "<svg width=\"82\" height=\"24\" viewBox=\"0 0 82 24\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"> <g id=\"Logo / Swing Logo\"> <g id=\"Union\"> <path d=\"M53.1625 3.67539C53.1625 3.9861 53.4203 4.23797 53.7384 4.23797H55.0846C55.4026 4.23797 55.6604 3.98609 55.6604 3.67539V2.56259C55.6604 2.25188 55.4026 2 55.0846 2H53.7384C53.4203 2 53.1625 2.25188 53.1625 2.56259V3.67539Z\" fill=\"#000\"/> <path d=\"M53.1625 16.2729C53.1625 16.5836 53.4203 16.8354 53.7384 16.8354H55.0846C55.4026 16.8354 55.6604 16.5836 55.6604 16.2729V6.46132C55.6604 6.15061 55.4026 5.89873 55.0846 5.89873H53.7384C53.4203 5.89873 53.1625 6.15061 53.1625 6.46132V16.2729Z\" fill=\"#000\"/> <path d=\"M31.4855 17.1392C30.1036 17.1392 28.9807 16.8354 28.117 16.2278C27.4042 15.7264 26.922 15.0572 26.6704 14.2202C26.5801 13.9198 26.8002 13.6268 27.1169 13.579L28.566 13.3603C28.8626 13.3155 29.1364 13.5062 29.2687 13.7694C29.4271 14.0844 29.6582 14.3469 29.9619 14.557C30.411 14.8675 30.9776 15.0228 31.6617 15.0228C32.2629 15.0228 32.7258 14.908 33.0506 14.6785C33.3822 14.4422 33.5481 14.1215 33.5481 13.7165C33.5481 13.4667 33.4859 13.2675 33.3615 13.119C33.2441 12.9637 32.9815 12.8152 32.5738 12.6734C32.1661 12.5316 31.5408 12.3527 30.6978 12.1367C29.7581 11.8937 29.0118 11.6338 28.459 11.357C27.9063 11.0734 27.5089 10.7392 27.2671 10.3544C27.0253 9.96962 26.9043 9.5038 26.9043 8.95696C26.9043 8.2751 27.0874 7.68101 27.4537 7.17468C27.8199 6.66835 28.3312 6.28017 28.9876 6.01013C29.6441 5.73333 30.418 5.59494 31.3093 5.59494C32.1799 5.59494 32.9504 5.72658 33.6206 5.98987C34.2978 6.25316 34.8437 6.62785 35.2583 7.11392C35.5566 7.46371 35.7726 7.8572 35.9064 8.29438C35.9953 8.58502 35.7828 8.86768 35.4772 8.92109L34.0698 9.16703C33.7462 9.22358 33.4518 8.99469 33.3012 8.70924C33.1899 8.49817 33.0303 8.31745 32.8226 8.16709C32.4563 7.89705 31.9657 7.74515 31.3508 7.71139C30.7634 7.67764 30.2901 7.7654 29.9308 7.97468C29.5715 8.17721 29.3919 8.46413 29.3919 8.83544C29.3919 9.04472 29.4644 9.22363 29.6095 9.37215C29.7546 9.52067 30.0448 9.6692 30.4801 9.81772C30.9224 9.96624 31.5788 10.1485 32.4494 10.3646C33.3408 10.5873 34.0525 10.8439 34.5846 11.1342C35.1235 11.4177 35.5105 11.7586 35.7454 12.157C35.9872 12.5553 36.1082 13.038 36.1082 13.6051C36.1082 14.7055 35.697 15.5696 34.8748 16.1975C34.0594 16.8253 32.9297 17.1392 31.4855 17.1392Z\" fill=\"#000\"/> <path d=\"M39.9545 16.8354C39.7012 16.8354 39.4777 16.6737 39.4038 16.437L36.3367 6.61166C36.2233 6.24826 36.5035 5.88176 36.8923 5.88498L38.1311 5.89523C38.3827 5.89732 38.6038 6.05876 38.677 6.29393L40.7408 12.9165L42.8335 6.29533C42.908 6.05955 43.1311 5.89873 43.3837 5.89873H44.6375C44.8903 5.89873 45.1136 6.0599 45.1879 6.29604L47.2706 12.9165L49.3433 6.29675C49.4173 6.06025 49.6408 5.89873 49.8939 5.89873H51.1359C51.5228 5.89873 51.7996 6.26417 51.6866 6.62572L48.6181 16.4373C48.5441 16.6738 48.3206 16.8354 48.0674 16.8354H46.9615C46.7129 16.8354 46.4925 16.6796 46.4146 16.449L44.0057 9.31139L41.6068 16.4484C41.5292 16.6793 41.3085 16.8354 41.0597 16.8354H39.9545Z\" fill=\"#000\"/> <path d=\"M66.2542 16.8354C65.9362 16.8354 65.6784 16.5836 65.6784 16.2729V11.5696C65.6784 11.2253 65.6542 10.8439 65.6058 10.4253C65.5574 10.0067 65.4434 9.60506 65.2638 9.22025C65.091 8.82869 64.8285 8.50802 64.4761 8.25823C64.1306 8.00844 63.6607 7.88354 63.0665 7.88354C62.7486 7.88354 62.4342 7.93418 62.1233 8.03544C61.8123 8.13671 61.529 8.31224 61.2734 8.56203C61.0246 8.80506 60.8242 9.14262 60.6722 9.57468C60.5202 10 60.4442 10.5468 60.4442 11.2152V16.2729C60.4442 16.5836 60.1864 16.8354 59.8684 16.8354H58.491C58.173 16.8354 57.9152 16.5836 57.9152 16.2729V6.46132C57.9152 6.15061 58.173 5.89873 58.491 5.89873H59.5678C59.8858 5.89873 60.1436 6.15061 60.1436 6.46132V7.11213C60.4293 6.78471 60.7644 6.50176 61.149 6.26329C61.8676 5.81097 62.7521 5.58481 63.8024 5.58481C64.6315 5.58481 65.3156 5.71983 65.8546 5.98987C66.3935 6.25992 66.8219 6.60422 67.1398 7.02278C67.4576 7.44135 67.6926 7.88692 67.8446 8.35949C67.9966 8.83207 68.0933 9.28101 68.1348 9.70633C68.1832 10.1249 68.2073 10.4658 68.2073 10.7291V16.2729C68.2073 16.5836 67.9495 16.8354 67.6315 16.8354H66.2542Z\" fill=\"#000\"/> <path d=\"M72.9953 21.7165C73.5688 21.9055 74.1665 22 74.7884 22C75.6314 22 76.3984 21.8886 77.0894 21.6658C77.7872 21.443 78.3711 21.1021 78.841 20.643C79.3108 20.1907 79.6287 19.6101 79.7945 18.9013C79.8498 18.6582 79.8878 18.4084 79.9085 18.1519C79.9362 17.9021 79.95 17.6388 79.95 17.362V6.46132C79.95 6.15061 79.6922 5.89873 79.3742 5.89873H78.3389C78.0209 5.89873 77.7631 6.15061 77.7631 6.46132V6.68593C77.6289 6.56759 77.4872 6.45709 77.3381 6.35443C76.6195 5.8481 75.7281 5.59494 74.664 5.59494C73.6068 5.59494 72.6878 5.8481 71.907 6.35443C71.1262 6.85401 70.5216 7.53924 70.0932 8.41013C69.6717 9.27426 69.461 10.2599 69.461 11.3671C69.461 12.4608 69.6717 13.443 70.0932 14.3139C70.5147 15.1848 71.1089 15.8734 71.8759 16.3797C72.6429 16.8861 73.5412 17.1392 74.5707 17.1392C75.6625 17.1392 76.578 16.8861 77.3174 16.3797C77.363 16.3485 77.4079 16.3166 77.4521 16.284V17.3215C77.4659 17.8413 77.3588 18.2734 77.1308 18.6177C76.9097 18.9688 76.5953 19.2321 76.1876 19.4076C75.78 19.5899 75.317 19.681 74.7988 19.681C74.3565 19.681 73.9385 19.5831 73.5446 19.3873C73.3219 19.2785 73.1277 19.135 72.9622 18.9568C72.7521 18.7306 72.4193 18.6146 72.1391 18.7502L70.8878 19.356C70.5914 19.4995 70.4766 19.8597 70.6767 20.1169C70.9032 20.4081 71.1647 20.6679 71.4614 20.8962C71.9174 21.254 72.4287 21.5274 72.9953 21.7165ZM77.7631 11.3671C77.7631 12.0759 77.6663 12.7004 77.4729 13.2405C77.2863 13.7806 76.9857 14.2025 76.5711 14.5063C76.1635 14.8034 75.6245 14.9519 74.9542 14.9519C74.3047 14.9519 73.7692 14.7932 73.3477 14.4759C72.9262 14.1586 72.6118 13.73 72.4045 13.1899C72.2042 12.643 72.104 12.0354 72.104 11.3671C72.104 10.7055 72.2076 10.1046 72.4149 9.56456C72.6222 9.01772 72.9435 8.58565 73.3788 8.26835C73.8141 7.9443 74.3669 7.78228 75.0372 7.78228C75.6729 7.78228 76.1911 7.93418 76.5919 8.23797C76.9926 8.53502 77.2863 8.95359 77.4729 9.49367C77.6663 10.027 77.7631 10.6515 77.7631 11.3671Z\" fill-rule=\"evenodd\" clip-rule=\"evenodd\" fill=\"#000\"/> </g> <path id=\"Union_2\" d=\"M22.2168 2.3251C22.4301 2.53332 22.55 2.8157 22.55 3.11013C22.55 3.40456 22.4301 3.68694 22.2168 3.89516L20.3077 5.75767C21.1969 6.84338 21.8471 8.10144 22.212 9.45333C22.6756 11.1705 22.6621 12.977 22.1729 14.6874C21.6838 16.3978 20.7367 17.9502 19.4289 19.1852C18.4022 20.1548 17.1823 20.9012 15.8498 21.3812C15.2438 21.5994 14.6076 21.2182 14.4543 20.606C14.3011 19.9937 14.6904 19.384 15.2885 19.1459C16.22 18.7751 17.0739 18.2329 17.802 17.5454C18.8113 16.5922 19.5422 15.3941 19.9197 14.0741C20.2972 12.7541 20.3076 11.3598 19.9499 10.0345C19.6906 9.07406 19.2448 8.17495 18.6402 7.38449L4.00677 21.661C3.90178 21.7671 3.77619 21.8517 3.63734 21.9099C3.49848 21.968 3.34913 21.9987 3.19801 22C3.0469 22.0012 2.89703 21.9731 2.75716 21.9173C2.61729 21.8615 2.49021 21.779 2.38335 21.6748C2.27649 21.5705 2.19198 21.4466 2.13475 21.3101C2.07753 21.1736 2.04873 21.0274 2.05004 20.88C2.05136 20.7326 2.08275 20.5868 2.1424 20.4514C2.20205 20.3159 2.28875 20.1934 2.39746 20.091L17.0309 5.81443C16.2134 5.21934 15.2827 4.78196 14.2887 4.53007C12.9291 4.18555 11.5 4.20044 10.1483 4.57319C8.79655 4.94595 7.57093 5.66313 6.59738 6.65104C5.89514 7.36364 5.34232 8.19855 4.9654 9.10862C4.72339 9.69294 4.09969 10.0748 3.47165 9.92736C2.84361 9.77991 2.45069 9.1605 2.67235 8.56855C3.15976 7.26692 3.92074 6.07424 4.91107 5.0693C6.17251 3.78927 7.76055 2.86001 9.51201 2.37702C11.2635 1.89404 13.1151 1.87475 14.8768 2.32114C16.2749 2.67544 17.5764 3.31294 18.6984 4.18761L20.6075 2.3251C20.8209 2.11694 21.1103 2 21.4121 2C21.7139 2 22.0033 2.11694 22.2168 2.3251Z\" fill=\"#000\"/> </g> </svg>";
var SWING_PASS_SVG = "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"> <g id=\"Logo / Swing Pass icon\"> <path id=\"Vector\" d=\"M2.00002 17.1119C2.00002 17.3474 2.09357 17.5733 2.2601 17.7399C2.42668 17.9064 2.65258 18 2.88812 18C3.12367 18 3.34957 17.9064 3.51615 17.7399L13.4755 7.78057L12.9152 10.3439L15.0008 12.9964L11.556 12.858L9.09477 16.5304C8.83855 16.9128 8.94077 17.4304 9.32309 17.6866C9.7054 17.9429 10.223 17.8406 10.4793 17.4583L12.4212 14.5608L16.5585 14.727C17.3401 14.7584 17.7994 13.8594 17.3159 13.2445L14.7113 9.93175L15.6587 5.59735L17.7288 3.52723C17.8137 3.44528 17.8813 3.34727 17.9279 3.23889C17.9745 3.13052 17.999 3.01395 18 2.89601C18.001 2.77806 17.9785 2.66109 17.9339 2.55192C17.8892 2.44275 17.8232 2.34357 17.7398 2.26017C17.6564 2.17677 17.5573 2.11081 17.4481 2.06614C17.3389 2.02148 17.222 1.999 17.104 2.00003C16.9861 2.00105 16.8695 2.02556 16.7611 2.07211C16.6527 2.11867 16.5547 2.18634 16.4728 2.27118L14.3937 4.3503L10.0729 5.28574L6.7659 2.67399C6.15203 2.18919 5.25205 2.64653 5.28176 3.42818L5.43903 7.56683L2.53975 9.5078C2.1573 9.76383 2.05482 10.2814 2.31085 10.6639C2.56689 11.0463 3.08448 11.1488 3.46692 10.8928L7.13985 8.43387L7.00897 4.98971L9.65704 7.08105L12.2172 6.52679L2.2601 16.4839C2.09357 16.6504 2.00002 16.8763 2.00002 17.1119Z\" fill=\"#000\"/> </g> </svg>";
var APPBAR_TYPES = ['standard', 'center', 'root', 'home', 'chat', 'search', 'homeSearch', 'ads', 'centerCountry', 'adsInverse', 'adsShare'];

async function buildAppBarPage(R, notes) {
  var page = await pageNamed('AppBar');
  // Brand: the wordmark and the Swing Pass mark as components, recoloured with tokens
  var brv = simpleSet([{ type: 'wordmark' }, { type: 'passMark' }]);
  var brand = await buildSet(page, 'Brand', brv, async function (comp, v) {
    var word = v.type === 'wordmark';
    var node = figma.createNodeFromSvg(word ? SWING_WORDMARK_SVG : SWING_PASS_SVG);
    comp.appendChild(node);
    node.name = 'art';
    comp.resize(word ? 82 : 16, word ? 24 : 16);
    node.resize(word ? 82 : 16, word ? 24 : 16);
    node.x = 0; node.y = 0;
    node.constraints = { horizontal: 'SCALE', vertical: 'SCALE' };
    comp.fills = [];
    node.findAll(function (n) { return n.type === 'VECTOR' || n.type === 'BOOLEAN_OPERATION'; }).forEach(function (n) { n.fills = paintFor(R, word ? '--purple-500' : '--light-100'); });
  }, function (s) { s.description = 'Swing brand marks from /swing/ds/brand: wordmark 82 x 24 in purple-500 (.swing_appbar__logo), Swing Pass mark 16 in light-100 (.swing_appbar__pass::before). Change the colour on the art layers if a screen needs it.'; }, function () {}, R);
  var pb = pairUp(brand, brv, function (c) { return /^type=/.test(c.name); });
  await docArtboard(R, page, brand, pb.comps, pb.vs, {
    title: 'Brand', description: 'The Swing wordmark and the Swing Pass mark, used in the home header.',
    code: ['<span class="swing_appbar__logo" role="img" aria-label="Swing"></span>', '.swing_appbar__pass::before = swing-pass.svg'],
    colGroups: [{ label: 'type', cols: ['wordmark', 'passMark'] }], rowGroups: [{ label: 'example', rows: ['mark'] }],
    place: function (v) { return { cg: 0, c: v.type === 'wordmark' ? 0 : 1, rg: 0, r: 0 }; },
    backdrop: function (v) { return v.type === 'passMark' ? '--dark-400' : null; }
  });
  var BR = byName(brand);
  var avatarSet = await setFrom('Avatar', 'Avatar', buildAvatarPage, R, notes);
  var AV = byName(avatarSet);
  var I = {};
  for (var n of ['chevron-left', 'share', 'search', 'more-h']) I[n] = await iconOrPlaceholder('Icon/Line/' + n, page, notes);
  I.bell = await iconOrPlaceholder('Icon/Line/notification-bell', page, notes);
  I.down = await iconOrPlaceholder('Icon/Line/chevron-down', page, notes);
  I.lead = await refIcon(R, 'home-lead', 'ref/img/home-lead.svg', 24, '--dark-500', notes, page);   // Home V5 menu icon
  // .appbar--ads (Swing Credits, Personal information): ADS back arrow 20 dark-300, a country button on the right
  I.adsBack = await refIcon(R, 'back-ads', 'ref/img/sc/back.svg?v=1', 20, '--dark-300', notes, page);
  I.adsBackW = await refIcon(R, 'back-ads-w', 'ref/img/sp/back-w.svg?v=1', 20, '--light-100', notes, page);   // .appbar--inverse
  I.adsShare = await refIcon(R, 'share-ads', 'ref/img/ev/share.svg?v=1', 20, '--dark-300', notes, page);   // .appbar--ads share
  I.flag = await refIcon(R, 'flag-id', 'ds/img/flag-id.svg', 16, null, notes, page);
  var abBtns = byName(await setWith('Button', 'Button', buildButton, R, notes, 'size=s, tone=glass, appearance=solid, state=default'));
  var abBtn = abBtns['size=s, tone=neutral, appearance=tertiary, state=default'], abGlass = abBtns['size=s, tone=glass, appearance=solid, state=default'];
  var variants = [], parts = {};
  APPBAR_TYPES.forEach(function (t) { ['false', 'true'].forEach(function (s) { variants.push({ type: t, scrolled: s }); }); });
  simpleSet(variants);
  function iconBtn(parent, icon, name, size, color) {   // .appbar__icon: 44, radius 8, icon 24 dark-500 (.appbar--ads: 20 dark-300)
    var b = autoFrame(name, 'HORIZONTAL', parent);
    b.primaryAxisAlignItems = 'CENTER'; b.counterAxisAlignItems = 'CENTER';
    b.resize(44, 44); b.layoutSizingHorizontal = 'FIXED'; b.layoutSizingVertical = 'FIXED';
    bindRadius(R, b, '--radius-8', 8);
    var i = icon.createInstance(); b.appendChild(i); i.name = 'icon'; i.resize(size || 24, size || 24);
    recolorIcon(R, i, color || '--dark-500');
    return b;
  }
  async function buildVariant(comp, v) {
    var t = v.type, inv = t === 'adsInverse', ash = t === 'adsShare', ads = t === 'ads' || inv || ash, cc = t === 'centerCountry', ctr = t === 'center' || ads || cc, back = t === 'standard' || t === 'center' || t === 'chat' || t === 'search' || ads || cc, hs = t === 'homeSearch';
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(390, hs ? 62 : 56); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    comp.minHeight = hs ? 62 : 56;   // .home-bar { min-height: 62px }
    bindNumber(R, comp, 'itemSpacing', '--gap-related', 8);
    if (back || hs) bindNumber(R, comp, 'paddingLeft', '--space-16', 16); else bindNumber(R, comp, 'paddingLeft', '--page-x', 24);
    if (t === 'search') bindNumber(R, comp, 'paddingRight', '--page-x', 24); else bindNumber(R, comp, 'paddingRight', '--space-16', 16);
    comp.fills = inv ? [] : paintFor(R, '--light-100');   // .appbar--inverse: transparent on the pass band
    comp.effects = v.scrolled === 'true' ? lineBelow(R) : [];
    var p = {};
    var left = comp;
    if (ctr) { left = autoFrame('start', 'HORIZONTAL', comp); left.layoutSizingHorizontal = 'FILL'; left.layoutSizingVertical = 'HUG'; }
    if (back) { if (ads) iconBtn(left, inv ? I.adsBackW : I.adsBack, 'back', 20, inv ? '--light-100' : '--dark-300'); else iconBtn(left, I['chevron-left'], 'back'); }
    if (t === 'standard' || t === 'root' || ctr) {
      var title = await styledText(R, t === 'root' ? '--type-h3' : '--type-h5', inv ? '--light-100' : '--dark-500', t === 'root' ? 'Activities' : ads ? 'Swing Credits' : 'Booking details');
      comp.appendChild(title); title.name = 'title';
      title.textAutoResize = ctr ? 'WIDTH_AND_HEIGHT' : 'HEIGHT';
      if (!ctr) { title.layoutSizingHorizontal = 'FILL'; title.textTruncation = 'ENDING'; title.maxLines = 1; }
      p.title = title;
    } else if (t === 'home') {
      var br = autoFrame('brand', 'HORIZONTAL', comp);
      br.counterAxisAlignItems = 'CENTER'; br.layoutSizingHorizontal = 'HUG'; br.layoutSizingVertical = 'HUG';
      bindNumber(R, br, 'itemSpacing', '--gap-related', 8);
      br.appendChild(BR['type=wordmark'].createInstance());
      var pass = autoFrame('pass', 'HORIZONTAL', br);   // .appbar__pass
      pass.counterAxisAlignItems = 'CENTER';
      pass.resize(60, 24); pass.layoutSizingHorizontal = 'HUG'; pass.layoutSizingVertical = 'FIXED';
      bindNumber(R, pass, 'paddingLeft', '--space-8', 8); bindNumber(R, pass, 'paddingRight', '--space-8', 8);
      bindNumber(R, pass, 'itemSpacing', '--gap-tight', 4);
      bindRadius(R, pass, '--radius-8', 8);
      pass.fills = paintFor(R, '--dark-400');
      pass.appendChild(BR['type=passMark'].createInstance());
      var pt = await styledText(R, '--type-b3s', '--light-100', 'PASS');
      pass.appendChild(pt); pt.name = 'text'; pt.textAutoResize = 'WIDTH_AND_HEIGHT';
      // resize() first: in Figma it sets both axes back to FIXED, so FILL must come after it
      var sp = autoFrame('spacer', 'HORIZONTAL', comp); sp.resize(10, 1); sp.layoutSizingHorizontal = 'FILL';
    } else if (t === 'chat') {
      var lead = autoFrame('lead', 'HORIZONTAL', comp);   // .appbar__lead
      lead.counterAxisAlignItems = 'CENTER'; lead.layoutSizingHorizontal = 'FILL'; lead.layoutSizingVertical = 'HUG';
      bindNumber(R, lead, 'itemSpacing', '--gap-related', 8);
      lead.appendChild(AV['size=s, type=initials'].createInstance());
      var tx = autoFrame('text', 'VERTICAL', lead);
      tx.layoutSizingHorizontal = 'FILL'; tx.layoutSizingVertical = 'HUG';
      var nm = await styledText(R, '--type-h6', '--dark-500', 'Sabtu pagi @ Pondok Indah');
      tx.appendChild(nm); nm.name = 'name'; nm.textAutoResize = 'HEIGHT'; nm.layoutSizingHorizontal = 'FILL'; nm.textTruncation = 'ENDING'; nm.maxLines = 1;
      var sb = await styledText(R, '--type-b3', '--dark-300', '4 players · 2 online');
      tx.appendChild(sb); sb.name = 'sub'; sb.textAutoResize = 'HEIGHT'; sb.layoutSizingHorizontal = 'FILL';
      p.title = nm; p.sub = sb;
    } else if (hs) {   // Home V5 (.appbar__bar.home-bar): menu, 36 grey search with a country chip, bell
      iconBtn(comp, I.lead, 'menu');
      var sbar = autoFrame('searchbar', 'HORIZONTAL', comp);
      sbar.counterAxisAlignItems = 'CENTER'; sbar.resize(200, 36); sbar.layoutSizingHorizontal = 'FILL'; sbar.layoutSizingVertical = 'FIXED';
      bindNumber(R, sbar, 'itemSpacing', '--space-8', 8);
      bindNumber(R, sbar, 'paddingLeft', '--space-12', 12); bindNumber(R, sbar, 'paddingRight', '--space-4', 4);   // 12 minus the chip's -8 margin
      bindRadius(R, sbar, '--radius-8', 8); sbar.fills = paintFor(R, '--light-300');
      var ssi = I.search.createInstance(); sbar.appendChild(ssi); ssi.name = 'icon'; ssi.resize(16, 16); recolorIcon(R, ssi, '--dark-300');
      var sph = await styledText(R, '--type-b2', '--dark-200', 'Search...');
      sbar.appendChild(sph); sph.name = 'placeholder'; sph.textAutoResize = 'HEIGHT'; sph.layoutSizingHorizontal = 'FILL'; sph.textTruncation = 'ENDING'; sph.maxLines = 1;
      var cc = autoFrame('country', 'HORIZONTAL', sbar);
      cc.counterAxisAlignItems = 'CENTER'; cc.resize(60, 28); cc.layoutSizingHorizontal = 'HUG'; cc.layoutSizingVertical = 'FIXED';
      bindNumber(R, cc, 'itemSpacing', '--space-4', 4); bindNumber(R, cc, 'paddingLeft', '--space-8', 8); bindNumber(R, cc, 'paddingRight', '--space-8', 8);
      bindRadius(R, cc, '--radius-8', 8); cc.fills = paintFor(R, '--light-200');
      await refArt(R, cc, 'ds/img/flag-id.svg', 16, 16, 'flag', notes);
      var ccode = await styledText(R, '--type-b2', '--dark-500', 'ID');
      cc.appendChild(ccode); ccode.name = 'code'; ccode.textAutoResize = 'WIDTH_AND_HEIGHT';
      var cdn = I.down.createInstance(); cc.appendChild(cdn); cdn.name = 'chevron'; cdn.resize(12, 12); recolorIcon(R, cdn, '--dark-500');
      p.ph = sph; p.code = ccode;
    } else {   // search: a 40 tall search field in the bar
      var f = autoFrame('search', 'HORIZONTAL', comp);
      f.counterAxisAlignItems = 'CENTER';
      f.resize(300, 40); f.layoutSizingHorizontal = 'FILL'; f.layoutSizingVertical = 'FIXED';
      bindNumber(R, f, 'paddingLeft', '--space-16', 16); bindNumber(R, f, 'paddingRight', '--space-16', 16);
      bindNumber(R, f, 'itemSpacing', '--space-12', 12);
      bindRadius(R, f, '--radius-12', 12);
      f.fills = paintFor(R, '--light-200');
      f.strokes = paintFor(R, '--light-500'); f.strokeWeight = 1; f.strokeAlign = 'INSIDE';
      var si = I.search.createInstance(); f.appendChild(si); si.name = 'icon'; si.resize(20, 20);
      recolorIcon(R, si, '--dark-300');
      var ph = await styledText(R, '--type-b1', '--dark-200', 'Search courses or players');
      f.appendChild(ph); ph.name = 'placeholder'; ph.textAutoResize = 'HEIGHT'; ph.layoutSizingHorizontal = 'FILL'; ph.textTruncation = 'ENDING'; ph.maxLines = 1;
      p.title = ph;
    }
    if (t !== 'search') {
      var acts = autoFrame('actions', 'HORIZONTAL', comp);
      acts.counterAxisAlignItems = 'CENTER';
      acts.layoutSizingHorizontal = ctr ? 'FILL' : 'HUG'; acts.layoutSizingVertical = 'HUG';
      if (ctr) acts.primaryAxisAlignItems = 'MAX';
      acts.itemSpacing = 0;
      if (ash) iconBtn(acts, I.adsShare, 'share', 20, '--dark-300');
      else if (ads || cc) {   // .appbar__actions > .btn.btn--s.btn--tertiary.btn--neutral with .flag + "ID"
        var cb = (inv ? abGlass : abBtn).createInstance(); acts.appendChild(cb); cb.name = 'country';
        try { cb.setProperties(propsFor(cb, { label: 'ID', showIconStart: true, iconStart: I.flag.id, showIconEnd: false })); } catch (e) { /* defaults */ }
      }
      else if (t === 'home' || hs) iconBtn(acts, I.bell, 'notifications');
      else if (t === 'root') iconBtn(acts, I.search, 'search');
      else if (t === 'chat') iconBtn(acts, I['more-h'], 'more');
      else iconBtn(acts, I.share, 'share');
      // center / ads: "actions" is the FILL column that balances the back column, so the title stays centred.
      // showActions hides what is inside it; hiding the column itself would push the title to the right.
      p.actions = ctr ? acts.children[0] : acts;
    }
    parts[comp.name] = p;
  }
  function wire(set) {
    var pT = ensureProp(set, 'title', 'TEXT', 'Booking details');
    var pA = ensureProp(set, 'showActions', 'BOOLEAN', true);
    var pPh = ensureProp(set, 'placeholder', 'TEXT', 'Search...'), pCo = ensureProp(set, 'country', 'TEXT', 'ID');
    wireKeys(parts).forEach(function (k) {
      var p = parts[k];
      if (p.title && !/type=(home|search)/.test(k)) p.title.componentPropertyReferences = { characters: pT };
      if (p.actions) p.actions.componentPropertyReferences = { visible: pA };
      if (p.ph) p.ph.componentPropertyReferences = { characters: pPh };
      if (p.code) p.code.componentPropertyReferences = { characters: pCo };
    });
    set.description = '<header class="swing_appbar [swing_appbar_center|swing_appbar_root] [is-scrolled]"><div class="swing_appbar__bar"><button class="swing_appbar__icon" aria-label="Back">chevron-left</button><h1 class="swing_appbar__title">{title}</h1><div class="swing_appbar__actions">…</div></div></header>. ' +
      'Bar 56, light-100, edge 16 to a 44 icon button (24 when the bar starts with text), gap 8, title H5 one line. center = title centred · adsShare = .swing_appbar_ads with a share icon (20, dark-300) instead of the country button · adsInverse = .swing_appbar_ads.appbar--inverse on the Swing Pass band: transparent, title and back light-100, country button in Button glass · centerCountry = .swing_appbar_center with the country button (Button s tertiary neutral, flag + ID) in the actions, DS back chevron · ads = .swing_appbar_center.appbar--ads: centred title, ADS back arrow 20 dark-300, country button (Button s tertiary neutral, flag + ID) · root = H3, no back · home = wordmark + PASS · chat = avatar + name H6 + sub B3 · search = 40 search field · homeSearch = Home V5 bar, 62 tall: menu, 36 light-300 search (placeholder B2 dark-200) with a light-200 country chip (flag 16, B2, chevron 12), bell. scrolled = 1px light-500 line (.is-scrolled). Put Tabs right under it for tabbed pages.';
  }
  var set = await buildSet(page, 'AppBar', variants, buildVariant, wire, function () {}, R);
  var pv = pairUp(set, variants, function (c) { return parts[c.name]; });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'AppBar', description: 'The page header. Back, a title and up to two actions; the line appears once the page scrolls.',
    code: ['<header class="swing_appbar"><div class="swing_appbar__bar"><button class="swing_appbar__icon" aria-label="Back">…</button><h1 class="swing_appbar__title">Booking details</h1><div class="swing_appbar__actions">…</div></div></header>',
      'type center = .swing_appbar_center · root = .swing_appbar_root · home = .swing_appbar__brand · chat = .swing_appbar__lead · search = .swing_field_search in the bar · homeSearch = .swing_appbar__bar.home-bar with .swing_searchbar + .swing_searchbar__country · scrolled = .is-scrolled'],
    colGroups: [{ label: 'scrolled', cols: ['false', 'true'] }], rowGroups: [{ label: 'type', rows: APPBAR_TYPES }],
    place: function (v) { return { cg: 0, c: v.scrolled === 'true' ? 1 : 0, rg: 0, r: APPBAR_TYPES.indexOf(v.type) }; }
  });
  return { set: set, count: brv.length + variants.length, label: 'Brand 2, AppBar ' + variants.length + ' variants' };
}

/* ----- Media (components.css .media) ----- */
var MEDIA_RATIO = { classic: [3, 2], wide: [16, 9], square: [1, 1], portrait: [4, 5] };

async function buildMediaSet(R, notes, page) {
  var img = (await findIcon('Icon/Solid/image')) || (await iconOrPlaceholder('Icon/Line/image', page, notes));
  var variants = [];
  wireKeys(MEDIA_RATIO).forEach(function (r) { ['light', 'dark'].forEach(function (t) { ['photo', 'empty'].forEach(function (c) { variants.push({ ratio: r, tone: t, content: c }); }); }); });
  simpleSet(variants);
  var set = await buildSet(page, 'Media', variants, async function (comp, v) {
    var q = MEDIA_RATIO[v.ratio], w = v.ratio === 'portrait' ? 200 : 342, h = Math.round(w * q[1] / q[0]);
    comp.layoutMode = 'HORIZONTAL'; comp.primaryAxisAlignItems = 'CENTER'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(w, h); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'FIXED';
    comp.clipsContent = true;
    bindRadius(R, comp, '--radius-12', 12);
    comp.fills = paintFor(R, v.tone === 'dark' ? '--dark-200' : '--light-300');
    if (v.content === 'empty') {
      var i = img.createInstance(); comp.appendChild(i); i.name = 'icon'; i.resize(40, 40);
      recolorIcon(R, i, v.tone === 'dark' ? '--dark-300' : '--dark-100');
    } else {
      var ph = figma.createRectangle(); comp.appendChild(ph);
      ph.name = 'photo (replace image fill)';
      ph.layoutPositioning = 'ABSOLUTE'; ph.resize(w, h); ph.x = 0; ph.y = 0;
      ph.constraints = { horizontal: 'STRETCH', vertical: 'STRETCH' };
      ph.fills = paintFor(R, '--purple-100');
    }
  }, function (s) { s.description = '<div class="swing_media [swing_media_wide|--square|--portrait] [swing_media_dark] [swing_media_empty]"><img …></div>. Radius 12 (0 inside a Card), light-300 behind the photo (dark: dark-200). ratio classic 3:2 (default) · wide 16:9 · square 1:1 · portrait 4:5. empty = placeholder with the image icon 40. Replace the photo layer\'s image fill; resize the instance keeping its ratio.'; }, function () {}, R);
  var pm = pairUp(set, variants, function (c) { return /^ratio=/.test(c.name); });
  var RAT = Object.keys(MEDIA_RATIO);
  await docArtboard(R, page, set, pm.comps, pm.vs, {
    title: 'Media', description: 'A photo cropped to a fixed ratio, or the placeholder while it loads or when there is none.',
    code: ['<div class="swing_media swing_media_wide"><img src="…" alt="…"></div> · <div class="swing_media swing_media_empty"></div>', 'ratio wide = .swing_media_wide · square = --square · portrait = --portrait · tone dark = .swing_media_dark'],
    colGroups: [{ label: 'tone light', cols: ['photo', 'empty'] }, { label: 'tone dark', cols: ['photo', 'empty'] }], rowGroups: [{ label: 'ratio', rows: RAT }],
    place: function (v) { return { cg: v.tone === 'dark' ? 1 : 0, c: v.content === 'empty' ? 1 : 0, rg: 0, r: RAT.indexOf(v.ratio) }; }
  });
  return { set: set, count: variants.length, M: byName(set) };
}

/* ----- Card + Stat (components.css .card, .stat) ----- */
function scrimPaint(R) {   // linear-gradient(180deg, scrim 0, soft 36%, transparent 60–66%, soft 84%, scrim 100%)
  var c = R.color['--dark-500'] || { r: 0.1, g: 0.1, b: 0.12 };
  var st = function (pos, a) { return { position: pos, color: { r: c.r, g: c.g, b: c.b, a: a } }; };
  return [{ type: 'GRADIENT_LINEAR', gradientTransform: [[0, 1, 0], [-1, 0, 1]],
    gradientStops: [st(0, 0.8), st(0.36, 0.48), st(0.6, 0), st(0.66, 0), st(0.84, 0.48), st(1, 0.8)] }];
}

async function buildCardPage(R, notes) {
  var page = await pageNamed('Card');
  var media = await buildMediaSet(R, notes, page);
  var star = (await findIcon('Icon/Solid/stars')) || (await iconOrPlaceholder('Icon/Line/stars', page, notes));
  var btnSet = await setFrom('Button', 'Button', buildButton, R, notes);
  var btn = btnSet && btnSet.children.find(function (c) { return c.name === 'size=m, tone=primary, appearance=solid, state=default'; });
  var badgeSet = await setFrom('Badge', 'Badge', buildBadgePage, R, notes);
  var badge = badgeSet && badgeSet.children.find(function (c) { return /tone=success/.test(c.name) && /appearance=soft/.test(c.name) && /size=s/.test(c.name); });
  var variants = [], parts = {};
  ['standard', 'overlay'].forEach(function (t) { ['default', 'pressed'].forEach(function (s) { variants.push({ type: t, state: s }); }); });
  simpleSet(variants);
  async function buildVariant(comp, v) {
    var ov = v.type === 'overlay', press = v.state === 'pressed';
    var title = ov ? '--light-100' : '--dark-500', text = ov ? '--light-400' : '--dark-300', meta = ov ? '--light-400' : '--dark-200';
    comp.layoutMode = 'VERTICAL';
    comp.resize(342, ov ? 428 : 300); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = ov ? 'FIXED' : 'HUG';
    if (ov) comp.primaryAxisAlignItems = 'SPACE_BETWEEN';
    comp.itemSpacing = 0;
    comp.clipsContent = true;
    bindRadius(R, comp, '--radius-16', 16);
    comp.fills = paintFor(R, ov ? '--dark-400' : press ? '--light-200' : '--light-100');
    comp.strokes = ov ? [] : paintFor(R, '--light-500'); comp.strokeWeight = 1; comp.strokeAlign = 'INSIDE';
    var p = {};
    var m = media.M['ratio=' + (ov ? 'portrait' : 'wide') + ', tone=light, content=photo'].createInstance();
    comp.appendChild(m); m.name = 'Media';
    if (ov) {   // the photo fills the card behind the text, with the scrim on top of it
      m.layoutPositioning = 'ABSOLUTE'; m.x = 0; m.y = 0; m.resize(342, 428);
      m.constraints = { horizontal: 'STRETCH', vertical: 'STRETCH' };
      var sc = figma.createRectangle(); comp.appendChild(sc); sc.name = 'scrim';
      sc.layoutPositioning = 'ABSOLUTE'; sc.x = 0; sc.y = 0; sc.resize(342, 428);
      sc.constraints = { horizontal: 'STRETCH', vertical: 'STRETCH' };
      sc.fills = scrimPaint(R);
    } else {
      m.layoutSizingHorizontal = 'FILL';
      pillRadius(m, 0);   // .card > .media { border-radius: 0 }
      p.media = m;
    }
    var body = autoFrame('body', 'VERTICAL', comp);
    body.layoutSizingHorizontal = 'FILL'; body.layoutSizingVertical = 'HUG';
    bindNumber(R, body, 'itemSpacing', '--space-12', 12);
    ['paddingLeft', 'paddingRight', 'paddingBottom'].forEach(function (f) { bindNumber(R, body, f, '--space-16', 16); });
    bindNumber(R, body, 'paddingTop', ov ? '--space-24' : '--space-16', ov ? 24 : 16);
    var head = autoFrame('head', 'VERTICAL', body);
    head.layoutSizingHorizontal = 'FILL'; head.layoutSizingVertical = 'HUG';
    bindNumber(R, head, 'itemSpacing', '--space-4', 4);
    var tt = await styledText(R, '--type-h5', title, 'Pondok Indah Golf Course');
    head.appendChild(tt); tt.name = 'title'; tt.textAutoResize = 'HEIGHT'; tt.layoutSizingHorizontal = 'FILL';
    var tx = await styledText(R, '--type-b1', text, 'South Jakarta · 18 holes · Par 72');
    head.appendChild(tx); tx.name = 'text'; tx.textAutoResize = 'HEIGHT'; tx.layoutSizingHorizontal = 'FILL';
    var mt = autoFrame('meta', 'HORIZONTAL', body);
    mt.counterAxisAlignItems = 'CENTER'; mt.layoutSizingHorizontal = 'FILL'; mt.layoutSizingVertical = 'HUG';
    mt.layoutWrap = 'WRAP';
    bindNumber(R, mt, 'itemSpacing', '--space-8', 8);
    if (badge) { var bi = badge.createInstance(); mt.appendChild(bi); try { bi.setProperties(propsFor(bi, { label: 'Open' })); } catch (e) { /* default */ } }
    var mtt = await styledText(R, '--type-b2', meta, 'Available today');
    mt.appendChild(mtt); mtt.name = 'text'; mtt.textAutoResize = 'WIDTH_AND_HEIGHT';
    var rt = autoFrame('rating', 'HORIZONTAL', body);
    rt.counterAxisAlignItems = 'CENTER'; rt.layoutSizingHorizontal = 'HUG'; rt.layoutSizingVertical = 'HUG';
    bindNumber(R, rt, 'itemSpacing', '--space-4', 4);
    var si = star.createInstance(); rt.appendChild(si); si.name = 'icon'; si.resize(16, 16);
    recolorIcon(R, si, ov ? '--orange-300' : '--orange-500');
    var sb = await styledText(R, '--type-b2s', title, '4.9');
    rt.appendChild(sb); sb.name = 'score'; sb.textAutoResize = 'WIDTH_AND_HEIGHT';
    var sr = await styledText(R, '--type-b2', meta, '(132 reviews)');
    rt.appendChild(sr); sr.name = 'reviews'; sr.textAutoResize = 'WIDTH_AND_HEIGHT';
    // footer: border-top light-500 inset by the card padding (overlay: no border)
    var foot = autoFrame('footer', 'VERTICAL', comp);
    foot.layoutSizingHorizontal = 'FILL'; foot.layoutSizingVertical = 'HUG';
    bindNumber(R, foot, 'paddingLeft', '--space-16', 16); bindNumber(R, foot, 'paddingRight', '--space-16', 16);
    var inner = autoFrame('row', 'HORIZONTAL', foot);
    inner.counterAxisAlignItems = 'CENTER'; inner.layoutSizingHorizontal = 'FILL'; inner.layoutSizingVertical = 'HUG';
    bindNumber(R, inner, 'itemSpacing', '--space-8', 8);
    bindNumber(R, inner, 'paddingTop', '--space-12', 12); bindNumber(R, inner, 'paddingBottom', '--space-16', 16);
    if (!ov) {
      inner.strokes = paintFor(R, '--light-500'); inner.strokeAlign = 'INSIDE';
      inner.strokeTopWeight = 1; inner.strokeBottomWeight = 0; inner.strokeLeftWeight = 0; inner.strokeRightWeight = 0;
    }
    if (btn) { var b = btn.createInstance(); inner.appendChild(b); b.layoutSizingHorizontal = 'FILL'; try { b.setProperties(propsFor(b, { label: 'Book a tee time' })); } catch (e) { /* default */ } }
    p.title = tt; p.text = tx; p.meta = mt; p.rating = rt; p.score = sb; p.reviews = sr; p.foot = foot;
    parts[comp.name] = p;
  }
  function wire(set) {
    var pM = ensureProp(set, 'showMedia', 'BOOLEAN', true);
    var pT = ensureProp(set, 'title', 'TEXT', 'Pondok Indah Golf Course');
    var pX = ensureProp(set, 'text', 'TEXT', 'South Jakarta · 18 holes · Par 72');
    var pSM = ensureProp(set, 'showMeta', 'BOOLEAN', true);
    var pSR = ensureProp(set, 'showRating', 'BOOLEAN', true);
    var pS = ensureProp(set, 'score', 'TEXT', '4.9');
    var pRv = ensureProp(set, 'reviews', 'TEXT', '(132 reviews)');
    var pF = ensureProp(set, 'showFooter', 'BOOLEAN', true);
    wireKeys(parts).forEach(function (k) {
      var p = parts[k];
      if (p.media) p.media.componentPropertyReferences = { visible: pM };
      p.title.componentPropertyReferences = { characters: pT };
      p.text.componentPropertyReferences = { characters: pX };
      p.meta.componentPropertyReferences = { visible: pSM };
      p.rating.componentPropertyReferences = { visible: pSR };
      p.score.componentPropertyReferences = { characters: pS };
      p.reviews.componentPropertyReferences = { characters: pRv };
      p.foot.componentPropertyReferences = { visible: pF };
    });
    set.description = '<article class="swing_card [swing_card_overlay] [swing_card_link]"><div class="swing_media swing_media_wide">…</div><div class="swing_card__body"><div class="swing_card__head"><h3 class="swing_card__title">{title}</h3><p class="swing_card__text">{text}</p></div><div class="swing_card__meta">…</div><span class="swing_card__rating">…</span></div><div class="swing_card__footer">…</div></article>. ' +
      'Flat: light-100 + 1px light-500 ring, radius 16, no shadow. Body padding 16, gap 12; title H5, text B1 dark-300, meta B2 dark-200, rating star 16 orange-500. Footer under a light-500 line inset 16. overlay = 4:5, photo behind with the media scrim, white text (padding 24/16/16). pressed = light-200 (a.card / .swing_card_link).';
  }
  var set = await buildSet(page, 'Card', variants, buildVariant, wire, function () {}, R);
  var pv = pairUp(set, variants, function (c) { return parts[c.name]; });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'Card', description: 'The flat content card: photo, title, a line of text, meta, rating and an optional footer action. overlay puts the text on the photo.',
    code: ['<article class="swing_card"><div class="swing_media swing_media_wide"><img …></div><div class="swing_card__body"><div class="swing_card__head"><h3 class="swing_card__title">…</h3><p class="swing_card__text">…</p></div></div><div class="swing_card__footer"><a class="swing_btn swing_btn_m">…</a></div></article>', 'type overlay = .swing_card_overlay · pressed = a.card:active · showMedia / showMeta / showRating / showFooter = leave that block out'],
    colGroups: [{ label: 'state', cols: ['default', 'pressed'] }], rowGroups: [{ label: 'type', rows: ['standard', 'overlay'] }],
    place: function (v) { return { cg: 0, c: v.state === 'pressed' ? 1 : 0, rg: 0, r: v.type === 'overlay' ? 1 : 0 }; }
  });
  // Stat
  var sv = simpleSet([{ tone: 'primary' }, { tone: 'neutral' }]), sParts = {};
  var stat = await buildSet(page, 'Stat', sv, async function (comp, v) {
    var n = v.tone === 'neutral';
    comp.layoutMode = 'VERTICAL'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(165, 70); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--space-4', 4);
    bindNumber(R, comp, 'paddingTop', '--space-12', 12); bindNumber(R, comp, 'paddingBottom', '--space-12', 12);
    bindNumber(R, comp, 'paddingLeft', '--space-8', 8); bindNumber(R, comp, 'paddingRight', '--space-8', 8);
    bindRadius(R, comp, '--radius-8', 8);
    comp.fills = paintFor(R, n ? '--light-200' : '--purple-50');
    comp.strokes = n ? paintFor(R, '--light-500') : []; comp.strokeWeight = 1; comp.strokeAlign = 'INSIDE';
    var l = await styledText(R, '--type-b2', n ? '--dark-300' : '--purple-600', 'HCP');
    comp.appendChild(l); l.name = 'label'; l.textAutoResize = 'WIDTH_AND_HEIGHT';
    var val = await styledText(R, '--type-h4', n ? '--dark-500' : '--purple-600', '12.4');
    comp.appendChild(val); val.name = 'value'; val.textAutoResize = 'WIDTH_AND_HEIGHT';
    sParts[comp.name] = { label: l, value: val };
  }, function (s) {
    var pL = ensureProp(s, 'label', 'TEXT', 'HCP'), pV = ensureProp(s, 'value', 'TEXT', '12.4');
    wireKeys(sParts).forEach(function (k) { sParts[k].label.componentPropertyReferences = { characters: pL }; sParts[k].value.componentPropertyReferences = { characters: pV }; });
    s.description = '<div class="swing_stat [swing_stat_neutral]"><span class="swing_stat__label">{label}</span><span class="swing_stat__value">{value}</span></div>. purple-50 + purple-600, label B2, value H4, padding 12/8, radius 8. neutral = light-200 + 1px light-500, dark-500 value. Put 2 in .swing_stat_grid or 1–4 in .swing_stat_row (gap 8), set to Fill.';
  }, function () {}, R);
  var ps = pairUp(stat, sv, function (c) { return sParts[c.name]; });
  await docArtboard(R, page, stat, ps.comps, ps.vs, {
    title: 'Stat', description: 'A number tile inside a card: handicap, gross, net. Neutral when purple would compete with the page.',
    code: ['<div class="swing_stat_grid"><div class="swing_stat"><span class="swing_stat__label">HCP</span><span class="swing_stat__value">12.4</span></div>…</div>', 'tone neutral = .swing_stat_neutral · .swing_stat_row = 1-4 equal tiles'],
    colGroups: [{ label: 'tone', cols: ['primary', 'neutral'] }], rowGroups: [{ label: 'example', rows: ['stat'] }],
    place: function (v) { return { cg: 0, c: v.tone === 'neutral' ? 1 : 0, rg: 0, r: 0 }; }
  });
  return { set: set, count: media.count + variants.length + sv.length, label: 'Media ' + media.count + ', Card ' + variants.length + ', Stat 2 variants' };
}

/* ----- ActionCard (components.css .action-card) ----- */
var AC_TONES = { purple: ['--purple-50', '--purple-100', '--purple-600'], pink: ['--pink-50', '--pink-100', '--pink-600'], green: ['--green-50', '--green-100', '--green-700'],
  teal: ['--teal-50', '--teal-100', '--teal-700'], blue: ['--blue-50', '--blue-100', '--blue-600'], orange: ['--orange-50', '--orange-100', '--orange-700'] };

async function buildActionCardPage(R, notes) {
  var page = await pageNamed('ActionCard');
  var icon = await iconOrPlaceholder('Icon/Line/golf', page, notes), chev = await iconOrPlaceholder('Icon/Line/chevron-right', page, notes);
  var TONES = Object.keys(AC_TONES), variants = [], parts = {};
  TONES.forEach(function (t) { ['tile', 'row'].forEach(function (l) { ['false', 'true'].forEach(function (s) { variants.push({ tone: t, layout: l, strong: s }); }); }); });
  simpleSet(variants);
  async function buildVariant(comp, v) {
    var T = AC_TONES[v.tone], row = v.layout === 'row', strong = v.strong === 'true';
    comp.layoutMode = row ? 'HORIZONTAL' : 'VERTICAL';
    comp.counterAxisAlignItems = row ? 'CENTER' : 'MIN';
    comp.resize(row ? 342 : 165, 120); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--space-12', 12);
    ['paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight'].forEach(function (f) { bindNumber(R, comp, f, '--space-16', 16); });
    bindRadius(R, comp, '--radius-12', 12);
    comp.fills = paintFor(R, strong ? T[1] : T[0]);
    comp.strokes = strong ? [] : paintFor(R, T[1]); comp.strokeWeight = 1; comp.strokeAlign = 'INSIDE';
    var box = autoFrame('icon', 'HORIZONTAL', comp);
    box.primaryAxisAlignItems = 'CENTER'; box.counterAxisAlignItems = 'CENTER';
    box.resize(40, 40); box.layoutSizingHorizontal = 'FIXED'; box.layoutSizingVertical = 'FIXED';
    bindRadius(R, box, '--radius-8', 8);
    box.fills = paintFor(R, '--light-100');
    var i = icon.createInstance(); box.appendChild(i); i.name = 'icon'; i.resize(24, 24);
    recolorIcon(R, i, T[2]);
    var tx = autoFrame('text', 'VERTICAL', comp);
    tx.layoutSizingHorizontal = 'FILL'; tx.layoutSizingVertical = 'HUG';
    var t = await styledText(R, '--type-s3s', T[2], 'Book a tee time');
    tx.appendChild(t); t.name = 'title'; t.textAutoResize = 'HEIGHT'; t.layoutSizingHorizontal = 'FILL';
    var d = await styledText(R, '--type-b2', '--dark-300', '120+ courses near you');
    tx.appendChild(d); d.name = 'desc'; d.textAutoResize = 'HEIGHT'; d.layoutSizingHorizontal = 'FILL';
    if (row) { var c = chev.createInstance(); comp.appendChild(c); c.name = 'chevron'; c.resize(20, 20); recolorIcon(R, c, T[2]); }
    parts[comp.name] = { icon: i, title: t, desc: d };
  }
  function wire(set) {
    var pI = ensureProp(set, 'icon', 'INSTANCE_SWAP', icon.id);
    var pT = ensureProp(set, 'title', 'TEXT', 'Book a tee time');
    var pSD = ensureProp(set, 'showDesc', 'BOOLEAN', true);
    var pD = ensureProp(set, 'desc', 'TEXT', '120+ courses near you');
    wireKeys(parts).forEach(function (k) {
      var p = parts[k];
      p.icon.componentPropertyReferences = { mainComponent: pI };
      p.title.componentPropertyReferences = { characters: pT };
      p.desc.componentPropertyReferences = { visible: pSD, characters: pD };
    });
    set.description = '<a class="swing_action_card [swing_action_card_{tone}] [swing_action_card_row] [swing_action_card_strong]"><span class="swing_action_card__icon"><i class="swing_icon"></i></span><span class="swing_action_card__text"><span class="swing_action_card__title">{title}</span><span class="swing_action_card__desc">{desc}</span></span></a>. ' +
      'Tint 50 + 1px tint-100 ring, radius 12, padding 16, gap 12. Icon 24 in a 40 white tile (radius 8), title S3 Semibold in the tone (600/700), desc B2 dark-300. strong = 100 tint, no ring · row = full width + chevron. Tile width 165 = half of 342 minus 12; set to Fill in a grid.';
  }
  var set = await buildSet(page, 'ActionCard', variants, buildVariant, wire, function () {}, R);
  var pv = pairUp(set, variants, function (c) { return parts[c.name]; });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'ActionCard', description: 'A shortcut tile on Home: icon, title and one line. Six tones; strong uses the 100 tint; row is full width with a chevron.',
    code: ['<a class="swing_action_card swing_action_card_green" href="#"><span class="swing_action_card__icon"><i class="swing_icon" …></i></span><span class="swing_action_card__text"><span class="swing_action_card__title">Book a tee time</span><span class="swing_action_card__desc">…</span></span></a>', 'tone = .swing_action_card_pink / --green / --teal / --blue / --orange · layout row = .swing_action_card_row · strong = .swing_action_card_strong'],
    colGroups: [{ label: 'layout tile', cols: ['default', 'strong'] }, { label: 'layout row', cols: ['default', 'strong'] }], rowGroups: [{ label: 'tone', rows: TONES }],
    place: function (v) { return { cg: v.layout === 'row' ? 1 : 0, c: v.strong === 'true' ? 1 : 0, rg: 0, r: TONES.indexOf(v.tone) }; }
  });
  notes.push('ActionCard: the web scales the card to .98 on press; Figma shows no pressed state.');
  return { set: set, count: variants.length, label: 'ActionCard ' + variants.length + ' variants' };
}

/* ----- CourseCard + CardRail + Carousel (components.css .course-card, .card-rail, .carousel) ----- */
function softScrim(R) { return paintFor(R, '--dark-500').map(function (p) { return Object.assign({}, p, { opacity: 0.48 }); }); }   // --scrim-media-soft

async function buildCourseCardPage(R, notes) {
  var page = await pageNamed('CourseCard');
  var mediaSet = await setFrom('Card', 'Media', buildCardPage, R, notes);
  var M = byName(mediaSet);
  var badgeSet = await setFrom('Badge', 'Badge', buildBadgePage, R, notes);
  var badge = badgeSet && badgeSet.children.find(function (c) { return /tone=neutral/.test(c.name) && /appearance=soft/.test(c.name) && /size=s/.test(c.name); });
  var solidOr = async function (n) { return (await findIcon('Icon/Solid/' + n)) || (await iconOrPlaceholder('Icon/Line/' + n, page, notes)); };
  var I = { save: await iconOrPlaceholder('Icon/Line/bookmark', page, notes), saved: await solidOr('bookmark'), star: await solidOr('stars'),
    tag: await solidOr('price-tag'), clock: await iconOrPlaceholder('Icon/Line/clock', page, notes) };
  var variants = simpleSet([{ saved: 'false', promo: 'false' }, { saved: 'true', promo: 'false' }, { saved: 'false', promo: 'true' }, { saved: 'true', promo: 'true' }]), parts = {};
  var W = 240;
  async function buildVariant(comp, v) {
    var saved = v.saved === 'true', promo = v.promo === 'true';
    comp.layoutMode = 'VERTICAL';
    comp.resize(W, 340); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--space-12', 12);
    comp.fills = [];
    var ph = autoFrame('photo', 'VERTICAL', comp);   // the media + what sits on it
    ph.layoutMode = 'NONE';
    ph.resize(W, W); ph.layoutSizingHorizontal = 'FILL';
    ph.clipsContent = false;
    var m = M['ratio=square, tone=light, content=photo'].createInstance();
    ph.appendChild(m); m.name = 'Media'; m.resize(W, W); m.x = 0; m.y = 0;
    m.constraints = { horizontal: 'STRETCH', vertical: 'STRETCH' };
    bindRadius(R, m, '--radius-16', 16);   // .course-card > .media { radius 16 }
    var tags = autoFrame('tags', 'HORIZONTAL', ph);
    tags.layoutWrap = 'WRAP';
    bindNumber(R, tags, 'itemSpacing', '--space-4', 4); bindNumber(R, tags, 'counterAxisSpacing', '--space-4', 4);
    tags.resize(W - 12 - 64, 20); tags.layoutSizingVertical = 'HUG';
    tags.x = 12; tags.y = 12;
    if (badge) ['18 holes', 'Night golf'].forEach(function (l) {   // .badge--on-media: light-100 + dark-500, no ring
      var b = badge.createInstance(); tags.appendChild(b);
      try { b.setProperties(propsFor(b, { label: l })); } catch (e) { /* default */ }
      b.fills = paintFor(R, '--light-100'); b.strokes = [];
      var t = b.findOne(function (n) { return n.type === 'TEXT'; }); if (t) t.fills = paintFor(R, '--dark-500');
    });
    var sv = autoFrame('save', 'HORIZONTAL', ph);
    sv.primaryAxisAlignItems = 'CENTER'; sv.counterAxisAlignItems = 'CENTER';
    sv.resize(40, 40); sv.x = W - 8 - 40; sv.y = 8;
    sv.constraints = { horizontal: 'MAX', vertical: 'MIN' };
    pillRadius(sv, 40);
    sv.fills = paintFor(R, '--light-100');
    var si = (saved ? I.saved : I.save).createInstance(); sv.appendChild(si); si.name = 'icon'; si.resize(20, 20);
    recolorIcon(R, si, saved ? '--purple-500' : '--dark-500');
    var body = autoFrame('body', 'VERTICAL', comp);
    body.layoutSizingHorizontal = 'FILL'; body.layoutSizingVertical = 'HUG';
    bindNumber(R, body, 'itemSpacing', '--space-4', 4);
    var row = autoFrame('row', 'HORIZONTAL', body);
    row.counterAxisAlignItems = 'BASELINE'; row.primaryAxisAlignItems = 'SPACE_BETWEEN';
    row.layoutSizingHorizontal = 'FILL'; row.layoutSizingVertical = 'HUG';
    bindNumber(R, row, 'itemSpacing', '--space-8', 8);
    var tt = await styledText(R, '--type-s2s', '--dark-500', 'Pondok Indah Golf Course');
    row.appendChild(tt); tt.name = 'title'; tt.textAutoResize = 'HEIGHT'; tt.layoutSizingHorizontal = 'FILL'; tt.textTruncation = 'ENDING'; tt.maxLines = 1;
    var rt = autoFrame('rating', 'HORIZONTAL', row);
    rt.counterAxisAlignItems = 'CENTER'; rt.layoutSizingHorizontal = 'HUG'; rt.layoutSizingVertical = 'HUG';
    bindNumber(R, rt, 'itemSpacing', '--space-4', 4);
    var st = I.star.createInstance(); rt.appendChild(st); st.name = 'icon'; st.resize(16, 16); recolorIcon(R, st, '--orange-500');
    var sc = await styledText(R, '--type-b2s', '--dark-500', '4.8');
    rt.appendChild(sc); sc.name = 'score'; sc.textAutoResize = 'WIDTH_AND_HEIGHT';
    var tx = await styledText(R, '--type-b2', '--dark-300', 'South Jakarta · 12 km');
    body.appendChild(tx); tx.name = 'text'; tx.textAutoResize = 'HEIGHT'; tx.layoutSizingHorizontal = 'FILL';
    var pr = autoFrame('price', 'HORIZONTAL', body);
    pr.counterAxisAlignItems = 'CENTER'; pr.layoutSizingHorizontal = 'HUG'; pr.layoutSizingVertical = 'HUG';
    bindNumber(R, pr, 'itemSpacing', '--space-4', 4);
    if (promo) { var ti = I.tag.createInstance(); pr.appendChild(ti); ti.name = 'icon'; ti.resize(16, 16); recolorIcon(R, ti, '--orange-700'); }
    var pt = await styledText(R, '--type-b2s', promo ? '--orange-700' : '--dark-500', promo ? 'From Rp 680k · 20% off' : 'From Rp 850k');
    pr.appendChild(pt); pt.name = 'text'; pt.textAutoResize = 'WIDTH_AND_HEIGHT';
    var mt = autoFrame('meta', 'HORIZONTAL', body);
    mt.counterAxisAlignItems = 'CENTER'; mt.layoutSizingHorizontal = 'HUG'; mt.layoutSizingVertical = 'HUG';
    bindNumber(R, mt, 'itemSpacing', '--space-4', 4); bindNumber(R, mt, 'paddingTop', '--space-4', 4);
    var ci = I.clock.createInstance(); mt.appendChild(ci); ci.name = 'icon'; ci.resize(16, 16); recolorIcon(R, ci, '--dark-200');
    var mtt = await styledText(R, '--type-b3s', '--dark-200', 'Next tee time 07:30');
    mt.appendChild(mtt); mtt.name = 'text'; mtt.textAutoResize = 'WIDTH_AND_HEIGHT';
    parts[comp.name] = { tags: tags, title: tt, score: sc, text: tx, price: pt, meta: mt, metaText: mtt };
  }
  function wire(set) {
    var pTg = ensureProp(set, 'showTags', 'BOOLEAN', true);
    var pT = ensureProp(set, 'title', 'TEXT', 'Pondok Indah Golf Course');
    var pS = ensureProp(set, 'score', 'TEXT', '4.8');
    var pX = ensureProp(set, 'text', 'TEXT', 'South Jakarta · 12 km');
    var pP = ensureProp(set, 'price', 'TEXT', 'From Rp 850k');
    var pSM = ensureProp(set, 'showMeta', 'BOOLEAN', true);
    var pM = ensureProp(set, 'meta', 'TEXT', 'Next tee time 07:30');
    wireKeys(parts).forEach(function (k) {
      var p = parts[k];
      p.tags.componentPropertyReferences = { visible: pTg };
      p.title.componentPropertyReferences = { characters: pT };
      p.score.componentPropertyReferences = { characters: pS };
      p.text.componentPropertyReferences = { characters: pX };
      if (!/promo=true/.test(k)) p.price.componentPropertyReferences = { characters: pP };
      p.meta.componentPropertyReferences = { visible: pSM };
      p.metaText.componentPropertyReferences = { characters: pM };
    });
    set.description = '<a class="swing_course_card"><div class="swing_media">…</div><div class="swing_course_card__tags"><span class="swing_badge swing_badge_on_media">…</span></div><button class="swing_course_card__save" aria-pressed="{saved}">bookmark</button><div class="swing_course_card__body"><div class="swing_course_card__row"><h3 class="swing_course_card__title">{title}</h3><span class="swing_course_card__rating">★ {score}</span></div><span class="swing_course_card__text">{text}</span><span class="swing_course_card__price [is-promo]">{price}</span><span class="swing_course_card__meta">…</span></div></a>. ' +
      'No surface: square photo radius 16, tags on it (white badges), save 40 white circle (saved = purple-500 solid bookmark). Title S2 Semibold one line, text B2 dark-300, price B2 Semibold (promo = orange-700 + price-tag), meta B3 Semibold dark-200. 240 wide in a CardRail.';
  }
  var set = await buildSet(page, 'CourseCard', variants, buildVariant, wire, function () {}, R);
  var pv = pairUp(set, variants, function (c) { return parts[c.name]; });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'CourseCard', description: 'A golf course in a list or a rail: photo with tags and a save button, then name, rating, place, price and the next tee time.',
    code: ['<a class="swing_course_card" href="#"><div class="swing_media"><img …></div><div class="swing_course_card__tags">…</div><button class="swing_course_card__save" aria-pressed="false">…</button><div class="swing_course_card__body">…</div></a>', 'saved = aria-pressed="true" · promo = .swing_course_card__price.is-promo'],
    colGroups: [{ label: 'saved', cols: ['false', 'true'] }], rowGroups: [{ label: 'promo', rows: ['false', 'true'] }],
    place: function (v) { return { cg: 0, c: v.saved === 'true' ? 1 : 0, rg: 0, r: v.promo === 'true' ? 1 : 0 }; }
  });
  var CC = byName(set);
  // CardRail
  var rv = [{ name: 'type=default' }];
  var rail = await buildSet(page, 'CardRail', rv, async function (comp) {
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'MIN';
    comp.resize(390, 340); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    comp.clipsContent = true;
    bindNumber(R, comp, 'itemSpacing', '--space-16', 16);
    bindNumber(R, comp, 'paddingLeft', '--page-x', 24); bindNumber(R, comp, 'paddingRight', '--page-x', 24);
    bindNumber(R, comp, 'paddingBottom', '--space-4', 4);
    comp.fills = [];
    [['false', 'false', 'Pondok Indah Golf Course'], ['true', 'true', 'Damai Indah Golf'], ['false', 'false', 'Royale Jakarta Golf Club']].forEach(function (c) {
      var it = CC['saved=' + c[0] + ', promo=' + c[1]].createInstance(); comp.appendChild(it);
      try { it.setProperties(propsFor(it, { title: c[2] })); } catch (e) { /* default */ }
    });
  }, function (s) { s.description = '<div class="swing_card_rail">…course-card…</div>. 240 items, gap 16, padding 0 24 4 (page-x), scrolls sideways and snaps per card, bleeds to the screen edge. 390 wide, clips.'; }, function () {}, R);
  var pr = pairUp(rail, rv, function (c) { return c.name === 'type=default'; });
  await docArtboard(R, page, rail, pr.comps, pr.vs, {
    title: 'CardRail', description: 'A horizontal rail of 240 cards that scrolls and snaps, edge to edge.',
    code: ['<div class="swing_card_rail"><a class="swing_course_card">…</a>…</div>', '--rail-item: 240px · gap 16 · scroll-padding = page-x'],
    colGroups: [{ label: 'example', cols: ['rail'] }], rowGroups: [{ label: 'type', rows: ['default'] }],
    place: function () { return { cg: 0, c: 0, rg: 0, r: 0 }; }
  });
  // Carousel
  var kv = [{ name: 'type=default' }], kParts = {};
  var car = await buildSet(page, 'Carousel', kv, async function (comp) {
    comp.resize(342, 228);
    comp.clipsContent = true;
    bindRadius(R, comp, '--radius-12', 12);
    comp.fills = paintFor(R, '--light-300');
    var m = M['ratio=classic, tone=light, content=photo'].createInstance();
    comp.appendChild(m); m.name = 'Media'; m.x = 0; m.y = 0; m.resize(342, 228);
    pillRadius(m, 0);   // .carousel__track > * { border-radius: 0 }
    m.constraints = { horizontal: 'STRETCH', vertical: 'STRETCH' };
    var dots = autoFrame('dots', 'HORIZONTAL', comp);
    dots.counterAxisAlignItems = 'CENTER';
    dots.layoutSizingHorizontal = 'HUG'; dots.layoutSizingVertical = 'HUG';
    bindNumber(R, dots, 'itemSpacing', '--space-4', 4);
    bindNumber(R, dots, 'paddingLeft', '--space-8', 8); bindNumber(R, dots, 'paddingRight', '--space-8', 8);
    bindNumber(R, dots, 'paddingTop', '--space-4', 4); bindNumber(R, dots, 'paddingBottom', '--space-4', 4);
    bindRadius(R, dots, '--radius-8', 8);
    dots.fills = softScrim(R);
    for (var i = 0; i < 5; i++) {   // 6px white at 48%, active scaled 1.34 (= 8) at 100%
      var d = figma.createEllipse(); dots.appendChild(d); d.name = 'dot';
      var on = i === 0; d.resize(on ? 8 : 6, on ? 8 : 6);
      d.fills = paintFor(R, '--light-100'); d.opacity = on ? 1 : 0.48;
    }
    dots.x = (342 - dots.width) / 2; dots.y = 228 - 12 - dots.height;
    dots.constraints = { horizontal: 'CENTER', vertical: 'MAX' };
    var cnt = autoFrame('count', 'HORIZONTAL', comp);
    cnt.counterAxisAlignItems = 'CENTER';
    cnt.resize(40, 20); cnt.layoutSizingHorizontal = 'HUG'; cnt.layoutSizingVertical = 'FIXED';
    bindNumber(R, cnt, 'paddingLeft', '--space-8', 8); bindNumber(R, cnt, 'paddingRight', '--space-8', 8);
    bindRadius(R, cnt, '--radius-8', 8);
    cnt.fills = softScrim(R);
    var ct = await styledText(R, '--type-b3s', '--light-100', '1 / 12');
    cnt.appendChild(ct); ct.name = 'text'; ct.textAutoResize = 'WIDTH_AND_HEIGHT';
    cnt.x = 342 - 12 - cnt.width; cnt.y = 12;
    cnt.constraints = { horizontal: 'MAX', vertical: 'MIN' };
    kParts[comp.name] = { dots: dots, count: cnt, countText: ct };
  }, function (s) {
    var pD = ensureProp(s, 'showDots', 'BOOLEAN', true), pC = ensureProp(s, 'showCount', 'BOOLEAN', true), pT = ensureProp(s, 'count', 'TEXT', '1 / 12');
    wireKeys(kParts).forEach(function (k) { var p = kParts[k]; p.dots.componentPropertyReferences = { visible: pD }; p.count.componentPropertyReferences = { visible: pC }; p.countText.componentPropertyReferences = { characters: pT }; });
    s.description = '<div class="swing_carousel"><div class="swing_carousel__track"><div class="swing_media">…</div>…</div></div>. Radius 12, swipes one photo at a time. carousel.js adds the dots chip (bottom 12, scrim-media-soft, 6px white dots at 48%, active 8 at 100%) and the "1 / 12" chip (top-right 12, h20, B3 Semibold white).';
  }, function () {}, R);
  var pk = pairUp(car, kv, function (c) { return c.name === 'type=default'; });
  await docArtboard(R, page, car, pk.comps, pk.vs, {
    title: 'Carousel', description: 'Swipeable photos with dots and a count, for course and event details.',
    code: ['<div class="swing_carousel"><div class="swing_carousel__track"><div class="swing_media"><img …></div>…</div></div>', 'carousel.js draws .swing_carousel__dots and .swing_carousel__count'],
    colGroups: [{ label: 'example', cols: ['carousel'] }], rowGroups: [{ label: 'type', rows: ['default'] }],
    place: function () { return { cg: 0, c: 0, rg: 0, r: 0 }; }
  });
  notes.push('CourseCard: the photo zooms to 1.02 on press on the web; Figma shows no pressed state. Tags are Badge instances recoloured to the on-media look (white, no ring), since Badge has no on-media tone.');
  return { set: set, count: variants.length + 2, label: 'CourseCard 4, CardRail 1, Carousel 1 variants' };
}

/* ----- Bottom sheet + Modal patterns (components.css .sheet, .sheet__*, .share-to) ----- */
async function buildSheetPage(R, notes) {
  var page = await pageNamed('Sheet');
  var solidOr = async function (n) { return (await findIcon('Icon/Solid/' + n)) || (await iconOrPlaceholder('Icon/Line/' + n, page, notes)); };
  var I = { close: await iconOrPlaceholder('Icon/Line/close-lg', page, notes), back: await iconOrPlaceholder('Icon/Line/chevron-left', page, notes),
    trash: await iconOrPlaceholder('Icon/Line/trash', page, notes), info: await iconOrPlaceholder('Icon/Line/info', page, notes),
    search: await iconOrPlaceholder('Icon/Line/search', page, notes), link: await iconOrPlaceholder('Icon/Line/link', page, notes),
    wa: await solidOr('br-whatsapp'), ig: await solidOr('br-instagram'), more: await iconOrPlaceholder('Icon/Line/more-h', page, notes) };
  function iconBtn(parent, icon, name) {   // .sheet__close / .sheet__icon: 44, radius 8, icon 24 dark-300
    var b = autoFrame(name, 'HORIZONTAL', parent);
    b.primaryAxisAlignItems = 'CENTER'; b.counterAxisAlignItems = 'CENTER';
    b.resize(44, 44); b.layoutSizingHorizontal = 'FIXED'; b.layoutSizingVertical = 'FIXED';
    bindRadius(R, b, '--radius-8', 8);
    var i = icon.createInstance(); b.appendChild(i); i.name = 'icon'; i.resize(24, 24);
    recolorIcon(R, i, '--dark-300');
    return b;
  }
  // SheetHead
  var hv = [], hParts = {};
  ['start', 'center'].forEach(function (a) { ['false', 'true'].forEach(function (l) { hv.push({ align: a, lined: l }); }); });
  simpleSet(hv);
  var head = await buildSet(page, 'SheetHead', hv, async function (comp, v) {
    var c = v.align === 'center';
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(390, 72); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    if (!c) comp.primaryAxisAlignItems = 'SPACE_BETWEEN';
    bindNumber(R, comp, 'itemSpacing', c ? '--gap-related' : '--gap-group', c ? 8 : 16);
    bindNumber(R, comp, 'paddingTop', '--space-12', 12); bindNumber(R, comp, 'paddingRight', '--space-16', 16);
    bindNumber(R, comp, 'paddingBottom', '--gap-group', 16);
    bindNumber(R, comp, 'paddingLeft', c ? '--space-16' : '--page-x', c ? 16 : 24);
    comp.fills = [];
    comp.effects = v.lined === 'true' ? lineBelow(R) : [];
    var p = {};
    if (c) { var st = autoFrame('start', 'HORIZONTAL', comp); st.layoutSizingHorizontal = 'FILL'; st.layoutSizingVertical = 'HUG'; p.back = iconBtn(st, I.back, 'back'); }
    var hd = autoFrame('heading', 'VERTICAL', comp);
    hd.layoutSizingHorizontal = c ? 'HUG' : 'FILL'; hd.layoutSizingVertical = 'HUG';
    if (c) hd.counterAxisAlignItems = 'CENTER';
    bindNumber(R, hd, 'itemSpacing', '--gap-tight', 4);
    var t = await styledText(R, '--type-h5', '--dark-500', 'Choose players');
    hd.appendChild(t); t.name = 'title'; t.textAutoResize = c ? 'WIDTH_AND_HEIGHT' : 'HEIGHT'; if (!c) t.layoutSizingHorizontal = 'FILL';
    if (c) t.textAlignHorizontal = 'CENTER';
    var d = await styledText(R, '--type-b2', '--dark-300', 'Up to 4 in one flight');
    hd.appendChild(d); d.name = 'desc'; d.textAutoResize = c ? 'WIDTH_AND_HEIGHT' : 'HEIGHT'; if (!c) d.layoutSizingHorizontal = 'FILL';
    d.visible = false;
    var end = comp;
    if (c) { end = autoFrame('end', 'HORIZONTAL', comp); end.layoutSizingHorizontal = 'FILL'; end.layoutSizingVertical = 'HUG'; end.primaryAxisAlignItems = 'MAX'; }
    var cl = iconBtn(end, I.close, 'close');
    p.title = t; p.desc = d; p.close = cl;
    hParts[comp.name] = p;
  }, function (set) {
    var pT = ensureProp(set, 'title', 'TEXT', 'Choose players'), pSD = ensureProp(set, 'showDesc', 'BOOLEAN', false), pD = ensureProp(set, 'desc', 'TEXT', 'Up to 4 in one flight');
    var pSC = ensureProp(set, 'showClose', 'BOOLEAN', true), pSB = ensureProp(set, 'showBack', 'BOOLEAN', true);
    wireKeys(hParts).forEach(function (k) { var p = hParts[k]; p.title.componentPropertyReferences = { characters: pT }; p.desc.componentPropertyReferences = { visible: pSD, characters: pD }; p.close.componentPropertyReferences = { visible: pSC }; if (p.back) p.back.componentPropertyReferences = { visible: pSB }; });
    set.description = '<header class="swing_sheet__head [swing_sheet__head_center]"><button class="swing_sheet__icon" aria-label="Back">…</button><div class="swing_sheet__heading"><h2 class="swing_sheet__title">{title}</h2><p class="swing_sheet__desc">{desc}</p></div><button class="swing_sheet__close" aria-label="Close">close-lg</button></header>. ' +
      'Padding 12 16 16 24 (center: 12 16 16 16), title H5, desc B2 dark-300, 44 icon buttons with 24 dark-300 icons. center = back · title · close with the title centred. lined = 1px light-500 line once the body scrolls (.is-scrolled / .swing_sheet_lined).';
  }, function () {}, R);
  var ph = pairUp(head, hv, function (c) { return hParts[c.name]; });
  await docArtboard(R, page, head, ph.comps, ph.vs, {
    title: 'SheetHead', description: 'The top of every sheet and modal: title (and a line of description), close, and a back button in the centred version.',
    code: ['<header class="swing_sheet__head"><div class="swing_sheet__heading"><h2 class="swing_sheet__title" id="t">Choose players</h2></div><button class="swing_sheet__close" aria-label="Close">…</button></header>', 'align center = .swing_sheet__head_center · lined = .is-scrolled / .swing_sheet_lined · showDesc = .swing_sheet__desc'],
    colGroups: [{ label: 'lined', cols: ['false', 'true'] }], rowGroups: [{ label: 'align', rows: ['start', 'center'] }],
    place: function (v) { return { cg: 0, c: v.lined === 'true' ? 1 : 0, rg: 0, r: v.align === 'center' ? 1 : 0 }; }
  });
  var H = byName(head);
  // ShareApp
  var av = [{ name: 'type=default' }], aParts = {};
  var app = await buildSet(page, 'ShareApp', av, async function (comp) {
    comp.layoutMode = 'VERTICAL'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(64, 80); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--gap-related', 8);
    bindNumber(R, comp, 'paddingTop', '--space-4', 4); bindNumber(R, comp, 'paddingBottom', '--space-4', 4);
    bindRadius(R, comp, '--radius-8', 8);
    comp.fills = [];
    var mk = autoFrame('mark', 'HORIZONTAL', comp);
    mk.primaryAxisAlignItems = 'CENTER'; mk.counterAxisAlignItems = 'CENTER';
    mk.resize(48, 48); mk.layoutSizingHorizontal = 'FIXED'; mk.layoutSizingVertical = 'FIXED';
    bindRadius(R, mk, '--radius-12', 12);
    mk.fills = paintFor(R, '--light-300');
    var i = I.link.createInstance(); mk.appendChild(i); i.name = 'icon'; i.resize(20, 20); recolorIcon(R, i, '--dark-500');
    var t = await styledText(R, '--type-b3s', '--dark-500', 'Copy link');
    comp.appendChild(t); t.name = 'label'; t.textAutoResize = 'HEIGHT'; t.layoutSizingHorizontal = 'FILL'; t.textAlignHorizontal = 'CENTER';
    aParts[comp.name] = { icon: i, label: t };
  }, function (set) {
    var pI = ensureProp(set, 'icon', 'INSTANCE_SWAP', I.link.id), pL = ensureProp(set, 'label', 'TEXT', 'Copy link');
    wireKeys(aParts).forEach(function (k) { aParts[k].icon.componentPropertyReferences = { mainComponent: pI }; aParts[k].label.componentPropertyReferences = { characters: pL }; });
    set.description = '<button class="swing_share_to__app"><span class="swing_share_to__mark"><i class="swing_icon"></i></span>{label}</button>. 64 wide, 48 light-300 tile (radius 12) with a 20 icon or a 40 app logo, label B3 Semibold. In .swing_share_to, gap 8, scrolls sideways.';
  }, function () {}, R);
  var pa = pairUp(app, av, function (c) { return aParts[c.name]; });
  await docArtboard(R, page, app, pa.comps, pa.vs, {
    title: 'ShareApp', description: 'One target in the share sheet.',
    code: ['<div class="swing_share_to"><button class="swing_share_to__app"><span class="swing_share_to__mark">…</span>Copy link</button>…</div>', 'icon swap for WhatsApp, Instagram, More'],
    colGroups: [{ label: 'example', cols: ['app'] }], rowGroups: [{ label: 'type', rows: ['default'] }],
    place: function () { return { cg: 0, c: 0, rg: 0, r: 0 }; }
  });
  var APP = byName(app)['type=default'];
  // pieces from other pages
  var btnSet = await setFrom('Button', 'Button', buildButton, R, notes), BTN = byName(btnSet);
  var optSet = await setFrom('Select', 'Option', buildSelectPage, R, notes), OPT = byName(optSet);
  var selSet = await setFrom('Select', 'Select', buildSelectPage, R, notes), SEL = byName(selSet);
  function button(parent, key, label) {
    var m = BTN[key]; if (!m) return null;
    var b = m.createInstance(); parent.appendChild(b); b.layoutSizingHorizontal = 'FILL';
    try { b.setProperties(propsFor(b, { label: label })); } catch (e) { /* default */ }
    return b;
  }
  function put(parent, main, props) { var it = main.createInstance(); parent.appendChild(it); it.layoutSizingHorizontal = 'FILL'; try { it.setProperties(propsFor(it, props)); } catch (e) { /* defaults */ } return it; }
  // Sheet
  var TYPES = ['options', 'form', 'dialog', 'share', 'empty'];
  var sv = simpleSet(TYPES.map(function (t) { return { type: t }; }));
  var sheet = await buildSet(page, 'Sheet', sv, async function (comp, v) {
    var t = v.type;
    comp.layoutMode = 'VERTICAL';
    comp.resize(390, 300); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    comp.itemSpacing = 0;
    comp.fills = paintFor(R, '--light-100');
    comp.clipsContent = true;
    ['topLeftRadius', 'topRightRadius'].forEach(function (f) { bindNumber(R, comp, f, '--radius-16', 16); });
    comp.bottomLeftRadius = comp.bottomRightRadius = 0;
    var el = R.effects['--elevation-3'];
    if (el) await comp.setEffectStyleIdAsync(el.id);
    var hw = autoFrame('handle', 'HORIZONTAL', comp);   // .sheet__handle: 32 x 4, 8 from the top
    hw.primaryAxisAlignItems = 'CENTER'; hw.layoutSizingHorizontal = 'FILL'; hw.layoutSizingVertical = 'HUG';
    bindNumber(R, hw, 'paddingTop', '--space-8', 8);
    var hb = figma.createRectangle(); hw.appendChild(hb); hb.name = 'bar'; hb.resize(32, 4); bindRadius(R, hb, '--radius-8', 8);
    hb.fills = paintFor(R, '--light-500');
    if (t !== 'dialog') {
      var hd = put(comp, H[t === 'form' ? 'align=center, lined=false' : 'align=start, lined=false'],
        { title: { options: 'Players', form: 'Book a tee time', share: 'Share', empty: 'Choose a course' }[t] });
      hd.name = 'SheetHead';
    }
    var body = autoFrame('body', 'VERTICAL', comp);
    body.layoutSizingHorizontal = 'FILL'; body.layoutSizingVertical = 'HUG';
    bindNumber(R, body, 'itemSpacing', '--gap-group', 16);
    bindNumber(R, body, 'paddingLeft', '--page-x', 24); bindNumber(R, body, 'paddingRight', '--page-x', 24);
    bindNumber(R, body, 'paddingTop', t === 'dialog' ? '--space-32' : '--space-8', t === 'dialog' ? 32 : 8);
    bindNumber(R, body, 'paddingBottom', t === 'dialog' ? '--space-8' : '--space-24', t === 'dialog' ? 8 : 24);
    if (t === 'options') {
      body.itemSpacing = 0;
      ['1 player', '2 players', '3 players', '4 players'].forEach(function (l, i) {
        put(body, OPT['selected=' + (i === 1) + ', state=default'], { label: l, showDivider: i < 3 });
      });
    } else if (t === 'form') {
      put(body, SEL['state=default, filled=true'], { label: 'Players', value: '4 players', showHelp: false });
      put(body, SEL['state=default, filled=true'], { label: 'Tee time', value: 'Sat, 14 Nov · 07:00', showHelp: false });
    } else if (t === 'dialog') {
      body.counterAxisAlignItems = 'CENTER';
      var art = autoFrame('art', 'HORIZONTAL', body);   // .sheet__art--danger
      art.primaryAxisAlignItems = 'CENTER'; art.counterAxisAlignItems = 'CENTER';
      art.resize(64, 64); art.layoutSizingHorizontal = 'FIXED'; art.layoutSizingVertical = 'FIXED';
      bindRadius(R, art, '--radius-16', 16);
      art.fills = paintFor(R, '--red-50');
      var ai = I.trash.createInstance(); art.appendChild(ai); ai.name = 'icon'; ai.resize(32, 32); recolorIcon(R, ai, '--red-700');
      var hg = autoFrame('heading', 'VERTICAL', body);
      hg.counterAxisAlignItems = 'CENTER'; hg.layoutSizingHorizontal = 'FILL'; hg.layoutSizingVertical = 'HUG';
      bindNumber(R, hg, 'itemSpacing', '--gap-related', 8);
      var dt = await styledText(R, '--type-h4', '--dark-500', 'Cancel this booking?');
      hg.appendChild(dt); dt.name = 'title'; dt.textAutoResize = 'HEIGHT'; dt.layoutSizingHorizontal = 'FILL'; dt.textAlignHorizontal = 'CENTER';
      var dd = await styledText(R, '--type-b1', '--dark-300', 'Your tee time on Sat, 14 Nov at 07:00 is released to other players.');
      hg.appendChild(dd); dd.name = 'desc'; dd.textAutoResize = 'HEIGHT'; dd.layoutSizingHorizontal = 'FILL'; dd.textAlignHorizontal = 'CENTER';
      var nt = autoFrame('note', 'HORIZONTAL', body);   // .sheet__note
      nt.counterAxisAlignItems = 'CENTER'; nt.layoutSizingHorizontal = 'HUG'; nt.layoutSizingVertical = 'HUG';
      bindNumber(R, nt, 'itemSpacing', '--gap-related', 8);
      bindNumber(R, nt, 'paddingTop', '--space-12', 12); bindNumber(R, nt, 'paddingBottom', '--space-12', 12);
      bindNumber(R, nt, 'paddingLeft', '--space-16', 16); bindNumber(R, nt, 'paddingRight', '--space-16', 16);
      bindRadius(R, nt, '--radius-8', 8);
      nt.fills = paintFor(R, '--purple-50');
      var ni = I.info.createInstance(); nt.appendChild(ni); ni.name = 'icon'; ni.resize(16, 16); recolorIcon(R, ni, '--purple-600');
      var ntt = await styledText(R, '--type-b2s', '--purple-600', 'Full refund until 24 hours before');
      nt.appendChild(ntt); ntt.name = 'text'; ntt.textAutoResize = 'WIDTH_AND_HEIGHT';
    } else if (t === 'share') {
      var row = autoFrame('share-to', 'HORIZONTAL', body);
      row.layoutSizingHorizontal = 'FILL'; row.layoutSizingVertical = 'HUG';
      bindNumber(R, row, 'itemSpacing', '--gap-related', 8);
      [[I.link, 'Copy link'], [I.wa, 'WhatsApp'], [I.ig, 'Instagram'], [I.more, 'More']].forEach(function (a) {
        var it = APP.createInstance(); row.appendChild(it);
        try { it.setProperties(propsFor(it, { icon: a[0].id, label: a[1] })); } catch (e) { /* default */ }
      });
    } else {   // .sheet__empty
      var em = autoFrame('empty', 'VERTICAL', body);
      em.counterAxisAlignItems = 'CENTER'; em.layoutSizingHorizontal = 'FILL'; em.layoutSizingVertical = 'HUG';
      bindNumber(R, em, 'itemSpacing', '--gap-group', 16);
      bindNumber(R, em, 'paddingTop', '--space-32', 32); bindNumber(R, em, 'paddingBottom', '--space-32', 32);
      bindNumber(R, em, 'paddingLeft', '--space-16', 16); bindNumber(R, em, 'paddingRight', '--space-16', 16);
      var ei = I.search.createInstance(); em.appendChild(ei); ei.name = 'icon'; ei.resize(32, 32); recolorIcon(R, ei, '--dark-200');
      var cp = autoFrame('copy', 'VERTICAL', em);
      cp.counterAxisAlignItems = 'CENTER'; cp.layoutSizingHorizontal = 'FILL'; cp.layoutSizingVertical = 'HUG';
      bindNumber(R, cp, 'itemSpacing', '--gap-tight', 4);
      var et = await styledText(R, '--type-h6', '--dark-500', 'No courses found');
      cp.appendChild(et); et.name = 'title'; et.textAutoResize = 'WIDTH_AND_HEIGHT';
      var ex = await styledText(R, '--type-b2', '--dark-300', 'Try another city or clear the filters.');
      cp.appendChild(ex); ex.name = 'text'; ex.textAutoResize = 'HEIGHT'; ex.resize(280, ex.height); ex.textAlignHorizontal = 'CENTER';
      var eb = button(em, 'size=m, tone=primary, appearance=soft, state=default', 'Clear filters');
      if (eb) eb.layoutSizingHorizontal = 'HUG';
    }
    if (t === 'form' || t === 'dialog') {   // .sheet__foot (--stack on the dialog), --bar-pad
      var ft = autoFrame('foot', 'VERTICAL', comp);
      ft.layoutSizingHorizontal = 'FILL'; ft.layoutSizingVertical = 'HUG';
      bindNumber(R, ft, 'itemSpacing', '--gap-related', 8);
      bindNumber(R, ft, 'paddingTop', '--space-16', 16); bindNumber(R, ft, 'paddingBottom', '--space-32', 32);
      bindNumber(R, ft, 'paddingLeft', '--page-x', 24); bindNumber(R, ft, 'paddingRight', '--page-x', 24);
      if (t === 'form') {
        var up = lineBelow(R)[0]; ft.effects = [Object.assign({}, up, { offset: { x: 0, y: -1 } })];
        var sum = autoFrame('sum', 'HORIZONTAL', ft);   // .sheet__sum
        sum.counterAxisAlignItems = 'CENTER'; sum.primaryAxisAlignItems = 'SPACE_BETWEEN';
        sum.layoutSizingHorizontal = 'FILL'; sum.layoutSizingVertical = 'HUG'; sum.minHeight = 32;
        bindNumber(R, sum, 'paddingBottom', '--space-8', 8);
        var sl = await styledText(R, '--type-b2s', '--dark-300', 'Total · 4 players');
        sum.appendChild(sl); sl.name = 'label'; sl.textAutoResize = 'WIDTH_AND_HEIGHT';
        var sto = await styledText(R, '--type-s2s', '--dark-500', 'Rp 3.400.000');
        sum.appendChild(sto); sto.name = 'total'; sto.textAutoResize = 'WIDTH_AND_HEIGHT';
        button(ft, 'size=l, tone=primary, appearance=solid, state=default', 'Pay now');
      } else {
        button(ft, 'size=l, tone=danger, appearance=solid, state=default', 'Cancel booking');
        button(ft, 'size=l, tone=neutral, appearance=ghost, state=default', 'Keep booking');
      }
    }
  }, function (set) {
    set.description = '<div class="swing_sheet_scrim"></div><section class="swing_sheet [swing_sheet_dialog]" role="dialog" aria-modal="true"><span class="swing_sheet__handle"></span><header class="swing_sheet__head">…</header><div class="swing_sheet__body">…</div><footer class="swing_sheet__foot">…</footer></section>. ' +
      '390 (max 480) wide, up to 88% tall, light-100, radius 16 16 0 0, Elevation 3, --scrim behind. Handle 32 x 4 light-500. Body padding 8 24 24, gap 16. Foot padding 16 24 32 with a line above (dialog: none). ' +
      'type = the ready patterns: options (Select sheet), form (centred head, summary + Pay), dialog (art 64, H4 title, B1 text, note, stacked buttons), share (.swing_share_to), empty (.swing_sheet__empty). Parts are instances: detach or swap per screen.';
  }, function () {}, R);
  var ps = pairUp(sheet, sv, function (c) { return /^type=/.test(c.name); });
  await docArtboard(R, page, sheet, ps.comps, ps.vs, {
    title: 'Sheet', description: 'Every modal is a bottom sheet. These are the ready patterns: a list of options, a short form with a summary, a dialog with one decision, share, and the empty state.',
    code: ['<section class="swing_sheet" role="dialog" aria-modal="true" aria-labelledby="t"><span class="swing_sheet__handle"></span><header class="swing_sheet__head">…</header><div class="swing_sheet__body">…</div><footer class="swing_sheet__foot"><button class="swing_btn swing_btn_block">…</button></footer></section>',
      'type dialog = .swing_sheet_dialog + .swing_sheet__art / .swing_sheet__note · form foot = .swing_sheet__sum · share = .swing_share_to · empty = .swing_sheet__empty'],
    colGroups: [{ label: 'type', cols: TYPES }], rowGroups: [{ label: 'example', rows: ['sheet'] }],
    place: function (v) { return { cg: 0, c: TYPES.indexOf(v.name.split('=')[1]), rg: 0, r: 0 }; },
    backdrop: function () { return '--light-300'; }
  });
  notes.push('Sheet: the scrim (--scrim) and the slide-up are screen-level; drop the Sheet over a frame with a 50% dark-500 rectangle behind it. The home-indicator safe area adds to the foot bottom padding on devices.');
  return { set: head, count: hv.length + 1 + sv.length, label: 'SheetHead 4, ShareApp 1, Sheet 5 variants' };
}

/* ----- Search (components.css .search) ----- */
async function buildSearchPage(R, notes) {
  var page = await pageNamed('Search');
  var I = { clock: await iconOrPlaceholder('Icon/Line/clock', page, notes), search: await iconOrPlaceholder('Icon/Line/search', page, notes) };
  var mediaSet = await setFrom('Card', 'Media', buildCardPage, R, notes), M = byName(mediaSet);
  var tfSet = await setFrom('TextField', 'TextField', buildTextFieldPage, R, notes), TF = byName(tfSet);
  var btnSet = await setFrom('Button', 'Button', buildButton, R, notes), BTN = byName(btnSet);
  // SearchRow
  var rv = [], rParts = {};
  ['icon', 'media'].forEach(function (l) { ['default', 'pressed'].forEach(function (s) { rv.push({ lead: l, state: s }); }); });
  simpleSet(rv);
  var row = await buildSet(page, 'SearchRow', rv, async function (comp, v) {
    var media = v.lead === 'media';
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(342, 48); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    comp.minHeight = 48;
    bindNumber(R, comp, 'itemSpacing', '--space-12', 12);
    bindNumber(R, comp, 'paddingTop', '--space-4', 4); bindNumber(R, comp, 'paddingBottom', '--space-4', 4);
    bindRadius(R, comp, '--radius-8', 8);
    comp.fills = v.state === 'pressed' ? paintFor(R, '--light-200') : [];
    var p = {};
    if (media) {
      var m = M['ratio=square, tone=light, content=photo'].createInstance(); comp.appendChild(m); m.name = 'Media'; m.resize(48, 48);
      bindRadius(R, m, '--radius-8', 8);
    } else {
      var i = I.clock.createInstance(); comp.appendChild(i); i.name = 'icon'; i.resize(20, 20); recolorIcon(R, i, '--dark-200');
      p.icon = i;
    }
    var tx = autoFrame('text', 'VERTICAL', comp);
    tx.layoutSizingHorizontal = 'FILL'; tx.layoutSizingVertical = 'HUG';
    var full = media ? 'Pondok Indah Golf Course' : 'pondok indah', hit = 'pondok';
    var t = await styledText(R, '--type-b1', '--dark-500', full);
    tx.appendChild(t); t.name = 'title'; t.textAutoResize = 'HEIGHT'; t.layoutSizingHorizontal = 'FILL'; t.textTruncation = 'ENDING'; t.maxLines = 1;
    try {   // <mark>: the matched part in B1 Semibold purple-600
      var at = full.toLowerCase().indexOf(hit);
      if (at >= 0) { t.setRangeFills(at, at + hit.length, paintFor(R, '--purple-600')); var bs = R.text['--type-b1s']; if (bs) await t.setRangeTextStyleIdAsync(at, at + hit.length, bs.id); }
    } catch (e) { /* range styling not available */ }
    var mt = await styledText(R, '--type-b2', '--dark-300', 'Golf course · South Jakarta');
    tx.appendChild(mt); mt.name = 'meta'; mt.textAutoResize = 'HEIGHT'; mt.layoutSizingHorizontal = 'FILL';
    mt.visible = media;
    p.title = t; p.meta = mt;
    rParts[comp.name] = p;
  }, function (set) {
    var pT = ensureProp(set, 'title', 'TEXT', 'pondok indah'), pSM = ensureProp(set, 'showMeta', 'BOOLEAN', false), pM = ensureProp(set, 'meta', 'TEXT', 'Golf course · South Jakarta');
    var pI = ensureProp(set, 'icon', 'INSTANCE_SWAP', I.clock.id);
    wireKeys(rParts).forEach(function (k) { var p = rParts[k]; p.title.componentPropertyReferences = { characters: pT }; p.meta.componentPropertyReferences = { visible: pSM, characters: pM }; if (p.icon) p.icon.componentPropertyReferences = { mainComponent: pI }; });
    set.description = '<a class="swing_search__row"><i class="swing_icon"></i>|<div class="swing_media"></div><span class="swing_search__text"><span class="swing_search__title">…<mark>{match}</mark>…</span><span class="swing_search__meta">{meta}</span></span></a>. Min 48, padding 4 0, gap 12, radius 8, B1 dark-500; the match is B1 Semibold purple-600 (re-apply after editing the title). icon 20 dark-200 · media 48 square radius 8. pressed = light-200.';
  }, function () {}, R);
  var pr = pairUp(row, rv, function (c) { return rParts[c.name]; });
  await docArtboard(R, page, row, pr.comps, pr.vs, {
    title: 'SearchRow', description: 'A suggestion or a result under the search bar. The part that matches what was typed is purple.',
    code: ['<a class="swing_search__row" href="#"><i class="swing_icon" …clock></i><span class="swing_search__text"><span class="swing_search__title"><mark>pondok</mark> indah</span></span></a>', 'lead media = .swing_media 48 · showMeta = .swing_search__meta · pressed = :active'],
    colGroups: [{ label: 'state', cols: ['default', 'pressed'] }], rowGroups: [{ label: 'lead', rows: ['icon', 'media'] }],
    place: function (v) { return { cg: 0, c: v.state === 'pressed' ? 1 : 0, rg: 0, r: v.lead === 'media' ? 1 : 0 }; }
  });
  var SR = byName(row);
  // SearchBar
  var bv = simpleSet([{ state: 'default' }, { state: 'active' }]);
  var bar = await buildSet(page, 'SearchBar', bv, async function (comp, v) {
    var on = v.state === 'active';
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(342, 48); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--space-8', 8);
    comp.fills = [];
    var f = TF['type=search, state=' + (on ? 'focus' : 'default') + ', filled=' + on].createInstance();
    comp.appendChild(f); f.layoutSizingHorizontal = 'FILL';
    if (on) {
      var b = BTN['size=m, tone=primary, appearance=ghost, state=default'];
      if (b) { var bi = b.createInstance(); comp.appendChild(bi); try { bi.setProperties(propsFor(bi, { label: 'Cancel' })); } catch (e) { /* default */ } }
    }
  }, function (s) { s.description = '<div class="swing_search [is-active]"><div class="swing_search__bar"><div class="swing_field swing_field_search">…</div><button class="swing_btn swing_btn_ghost swing_btn_m swing_search__cancel">Cancel</button></div>…</div>. Cancel shows while the bar is focused or has text (.is-active). The field is a TextField type=search instance.'; }, function () {}, R);
  var pb = pairUp(bar, bv, function (c) { return /^state=/.test(c.name); });
  await docArtboard(R, page, bar, pb.comps, pb.vs, {
    title: 'SearchBar', description: 'The search field, with Cancel while it is in use.',
    code: ['<div class="swing_search__bar"><div class="swing_field swing_field_search">…</div><button class="swing_btn swing_btn_ghost swing_btn_m swing_search__cancel">Cancel</button></div>', 'state active = .swing_search.is-active'],
    colGroups: [{ label: 'example', cols: ['bar'] }], rowGroups: [{ label: 'state', rows: ['default', 'active'] }],
    place: function (v) { return { cg: 0, c: 0, rg: 0, r: v.name === 'state=active' ? 1 : 0 }; }
  });
  // SearchPanel
  var nv = simpleSet([{ type: 'results' }, { type: 'empty' }]);
  var panel = await buildSet(page, 'SearchPanel', nv, async function (comp, v) {
    comp.layoutMode = 'VERTICAL';
    comp.resize(342, 200); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--space-16', 16); bindNumber(R, comp, 'paddingTop', '--space-16', 16);
    comp.fills = [];
    if (v.type === 'empty') {
      var em = autoFrame('empty', 'VERTICAL', comp);
      em.counterAxisAlignItems = 'CENTER'; em.layoutSizingHorizontal = 'FILL'; em.layoutSizingVertical = 'HUG';
      bindNumber(R, em, 'itemSpacing', '--space-4', 4);
      bindNumber(R, em, 'paddingTop', '--space-32', 32); bindNumber(R, em, 'paddingBottom', '--space-32', 32);
      bindNumber(R, em, 'paddingLeft', '--space-16', 16); bindNumber(R, em, 'paddingRight', '--space-16', 16);
      var a = await styledText(R, '--type-h6', '--dark-500', 'No results for “pondk”');
      em.appendChild(a); a.name = 'title'; a.textAutoResize = 'WIDTH_AND_HEIGHT';
      var b = await styledText(R, '--type-b2', '--dark-300', 'Check the spelling or try a city name.');
      em.appendChild(b); b.name = 'text'; b.textAutoResize = 'WIDTH_AND_HEIGHT';
      return;
    }
    async function group(title, action, rows) {
      var g = autoFrame('group', 'VERTICAL', comp);
      g.layoutSizingHorizontal = 'FILL'; g.layoutSizingVertical = 'HUG';
      var h = autoFrame('head', 'HORIZONTAL', g);
      h.counterAxisAlignItems = 'CENTER'; h.primaryAxisAlignItems = 'SPACE_BETWEEN';
      h.layoutSizingHorizontal = 'FILL'; h.layoutSizingVertical = 'HUG'; h.minHeight = 32;
      var ht = await styledText(R, '--type-b2s', '--dark-300', title); h.appendChild(ht); ht.name = 'title'; ht.textAutoResize = 'WIDTH_AND_HEIGHT';
      if (action) { var ha = await styledText(R, '--type-b2s', '--purple-600', action); h.appendChild(ha); ha.name = 'action'; ha.textAutoResize = 'WIDTH_AND_HEIGHT'; }
      rows.forEach(function (r) { var it = SR[r[0]].createInstance(); g.appendChild(it); it.layoutSizingHorizontal = 'FILL'; try { it.setProperties(propsFor(it, r[1])); } catch (e) { /* defaults */ } });
    }
    await group('Recent', 'Clear', [['lead=icon, state=default', { title: 'pondok indah' }], ['lead=icon, state=default', { title: 'night golf jakarta' }]]);
    await group('Courses', null, [['lead=media, state=default', { title: 'Pondok Indah Golf Course', showMeta: true }], ['lead=media, state=default', { title: 'Pondok Ranji Driving Range', showMeta: true, meta: 'Driving range · Tangerang Selatan' }]]);
  }, function (s) { s.description = '<div class="swing_search__panel"><div class="swing_search__group"><div class="swing_search__head">Recent <button>Clear</button></div>…swing_search__row…</div>…</div>. Padding-top 16, groups 16 apart, head min 32 B2 Semibold dark-300. empty = .swing_search__empty (H6 + B2, padding 32 16).'; }, function () {}, R);
  var pp = pairUp(panel, nv, function (c) { return /^type=/.test(c.name); });
  await docArtboard(R, page, panel, pp.comps, pp.vs, {
    title: 'SearchPanel', description: 'What shows under the bar: recent searches and grouped results, or the no-result state.',
    code: ['<div class="swing_search__panel"><div class="swing_search__group"><div class="swing_search__head">Recent</div><a class="swing_search__row">…</a></div></div>', 'type empty = .swing_search__empty'],
    colGroups: [{ label: 'type', cols: ['results', 'empty'] }], rowGroups: [{ label: 'example', rows: ['panel'] }],
    place: function (v) { return { cg: 0, c: v.name === 'type=empty' ? 1 : 0, rg: 0, r: 0 }; }
  });
  return { set: row, count: rv.length + 2 + 2, label: 'SearchRow 4, SearchBar 2, SearchPanel 2 variants' };
}

/* ----- Date picker (components.css .cal, .date-strip) ----- */
var CAL_STATES = ['default', 'today', 'selected', 'pressed', 'disabled'];

async function buildDatePickerPage(R, notes) {
  var page = await pageNamed('DatePicker');
  var prev = await iconOrPlaceholder('Icon/Line/chevron-left', page, notes), next = await iconOrPlaceholder('Icon/Line/chevron-right', page, notes);
  var dateIcon = await iconOrPlaceholder('Icon/Line/date', page, notes);
  // CalDay
  var dv = [], dParts = {};
  CAL_STATES.forEach(function (s) { ['false', 'true'].forEach(function (d) { dv.push({ state: s, dot: d }); }); });
  simpleSet(dv);
  var day = await buildSet(page, 'CalDay', dv, async function (comp, v) {
    var s = v.state, fg = s === 'selected' ? '--light-100' : s === 'today' ? '--purple-500' : s === 'disabled' ? '--dark-100' : '--dark-500';
    comp.layoutMode = 'HORIZONTAL'; comp.primaryAxisAlignItems = 'CENTER'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(44, 44); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'FIXED';
    bindRadius(R, comp, '--radius-12', 12);
    comp.fills = s === 'selected' ? paintFor(R, '--purple-500') : s === 'pressed' ? paintFor(R, '--light-300') : [];
    comp.strokes = s === 'today' ? paintFor(R, '--purple-500') : []; comp.strokeWeight = 1; comp.strokeAlign = 'INSIDE';
    var t = await styledText(R, s === 'today' || s === 'selected' ? '--type-b1s' : '--type-b1', fg, '14');
    comp.appendChild(t); t.name = 'day'; t.textAutoResize = 'WIDTH_AND_HEIGHT';
    if (v.dot === 'true') {   // .has-dot::after: 4px, bottom 4, currentColor at 60%
      var d = figma.createEllipse(); comp.appendChild(d); d.name = 'dot';
      d.layoutPositioning = 'ABSOLUTE'; d.resize(4, 4); d.x = 20; d.y = 36;
      d.fills = paintFor(R, fg); d.opacity = 0.6;
      d.constraints = { horizontal: 'CENTER', vertical: 'MAX' };
    }
    dParts[comp.name] = t;
  }, function (set) {
    var p = ensureProp(set, 'day', 'TEXT', '14');
    wireKeys(dParts).forEach(function (k) { dParts[k].componentPropertyReferences = { characters: p }; });
    set.description = '<button class="swing_cal__day [is-today] [has-dot]" aria-pressed="{selected}">{day}</button>. 44, radius 12, B1 dark-500. today = 1px purple-500 ring + purple-500 B1 Semibold · selected = purple-500 + white B1 Semibold · pressed = light-300 · disabled = dark-100 (past or full). dot = 4px at 60% (has tee times / events).';
  }, function () {}, R);
  var pd = pairUp(day, dv, function (c) { return dParts[c.name]; });
  await docArtboard(R, page, day, pd.comps, pd.vs, {
    title: 'CalDay', description: 'One day of the month grid.',
    code: ['<button class="swing_cal__day is-today has-dot" aria-pressed="false">9</button>', 'selected = aria-pressed="true" · disabled = disabled · dot = .has-dot'],
    colGroups: [{ label: 'dot', cols: ['false', 'true'] }], rowGroups: [{ label: 'state', rows: CAL_STATES }],
    place: function (v) { return { cg: 0, c: v.dot === 'true' ? 1 : 0, rg: 0, r: CAL_STATES.indexOf(v.state) }; }
  });
  var D = byName(day);
  // Calendar: November 2026 (1 Nov is a Sunday), Monday first; today 9, picked 14
  var cv = [{ name: 'type=default' }];
  var cal = await buildSet(page, 'Calendar', cv, async function (comp) {
    comp.layoutMode = 'VERTICAL';
    comp.resize(342, 400); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--space-8', 8);
    comp.fills = [];
    var nav = autoFrame('nav', 'HORIZONTAL', comp);
    nav.counterAxisAlignItems = 'CENTER'; nav.primaryAxisAlignItems = 'SPACE_BETWEEN';
    nav.layoutSizingHorizontal = 'FILL'; nav.layoutSizingVertical = 'HUG';
    var nb = function (icon, name) {
      var b = autoFrame(name, 'HORIZONTAL', nav); b.primaryAxisAlignItems = 'CENTER'; b.counterAxisAlignItems = 'CENTER';
      b.resize(44, 44); b.layoutSizingHorizontal = 'FIXED'; b.layoutSizingVertical = 'FIXED'; bindRadius(R, b, '--radius-8', 8);
      var i = icon.createInstance(); b.appendChild(i); i.name = 'icon'; i.resize(20, 20); recolorIcon(R, i, '--dark-500');
    };
    nb(prev, 'prev');
    var mo = await styledText(R, '--type-s2s', '--dark-500', 'November 2026');
    nav.appendChild(mo); mo.name = 'month'; mo.textAutoResize = 'WIDTH_AND_HEIGHT';
    nb(next, 'next');
    var grid = autoFrame('grid', 'VERTICAL', comp);
    grid.layoutSizingHorizontal = 'FILL'; grid.layoutSizingVertical = 'HUG';
    bindNumber(R, grid, 'itemSpacing', '--space-4', 4);
    var dow = autoFrame('dow', 'HORIZONTAL', grid);
    dow.layoutSizingHorizontal = 'FILL'; dow.layoutSizingVertical = 'HUG';
    for (var w of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
      var c = autoFrame('cell', 'HORIZONTAL', dow); c.primaryAxisAlignItems = 'CENTER'; c.counterAxisAlignItems = 'CENTER';
      c.resize(48, 32); c.layoutSizingHorizontal = 'FILL'; c.layoutSizingVertical = 'FIXED';
      var wt = await styledText(R, '--type-b3s', '--dark-200', w.toUpperCase()); c.appendChild(wt); wt.name = 'label'; wt.textAutoResize = 'WIDTH_AND_HEIGHT';
    }
    var n = -5;   // 6 blanks before Sunday 1
    for (var r = 0; r < 6 && n <= 30; r++) {
      var wk = autoFrame('week', 'HORIZONTAL', grid);
      wk.layoutSizingHorizontal = 'FILL'; wk.layoutSizingVertical = 'HUG';
      for (var k = 0; k < 7; k++, n++) {
        var cell = autoFrame('cell', 'HORIZONTAL', wk); cell.primaryAxisAlignItems = 'CENTER';
        cell.resize(48, 44); cell.layoutSizingHorizontal = 'FILL'; cell.layoutSizingVertical = 'HUG';
        if (n < 1 || n > 30) continue;
        var st = n < 9 ? 'disabled' : n === 9 ? 'today' : n === 14 ? 'selected' : 'default';
        var dot = n === 14 || n === 15 || n === 21 || n === 28;
        var it = D['state=' + st + ', dot=' + dot].createInstance(); cell.appendChild(it);
        try { it.setProperties(propsFor(it, { day: String(n) })); } catch (e) { /* default */ }
      }
    }
  }, function (s) { s.description = '<div class="swing_cal"><div class="swing_cal__nav"><button>‹</button><span class="swing_cal__month">November 2026</span><button>›</button></div><div class="swing_cal__grid">…swing_cal__dow × 7, swing_cal__day…</div></div>. Rendered by picker.js inside a Sheet. Month S2 Semibold, nav buttons 44 with 20 icons, weekday B3 Semibold dark-200 uppercase h32, 7 columns, rows 4 apart. Monday first.'; }, function () {}, R);
  var pc = pairUp(cal, cv, function (c) { return c.name === 'type=default'; });
  await docArtboard(R, page, cal, pc.comps, pc.vs, {
    title: 'Calendar', description: 'The month grid in the date sheet. Past days are off, today has a ring, the picked day is purple, dots mark days with tee times.',
    code: ['<div class="swing_cal">…</div> (picker.js)', 'opens from a Select with the date icon, inside a Sheet'],
    colGroups: [{ label: 'example', cols: ['November 2026'] }], rowGroups: [{ label: 'type', rows: ['default'] }],
    place: function () { return { cg: 0, c: 0, rg: 0, r: 0 }; }
  });
  // DateStripDay + DateStrip (2026-11-09: the Swing date band look, outlined 64 x 48)
  var sv = simpleSet([{ state: 'default' }, { state: 'selected' }, { state: 'disabled' }]), sParts = {};
  var sd = await buildSet(page, 'DateStripDay', sv, async function (comp, v) {
    var on = v.state === 'selected', off = v.state === 'disabled';
    comp.layoutMode = 'VERTICAL'; comp.primaryAxisAlignItems = 'CENTER'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(64, 48); comp.layoutSizingHorizontal = 'HUG'; comp.layoutSizingVertical = 'HUG';
    comp.minWidth = 64; comp.minHeight = 48;   // min-height 48; the optional meta line grows it to 60
    bindNumber(R, comp, 'paddingTop', '--space-4', 4); bindNumber(R, comp, 'paddingBottom', '--space-4', 4);
    bindNumber(R, comp, 'paddingLeft', '--space-12', 12); bindNumber(R, comp, 'paddingRight', '--space-12', 12);
    comp.itemSpacing = 0;
    bindRadius(R, comp, '--radius-8', 8);
    comp.fills = paintFor(R, on ? '--purple-50' : '--light-100');
    comp.strokes = paintFor(R, on ? '--purple-500' : off ? '--light-300' : '--light-400'); comp.strokeWeight = 1; comp.strokeAlign = 'INSIDE';
    comp.clipsContent = false;
    var a = await styledText(R, '--type-b3', off ? '--dark-100' : '--dark-300', 'SAT');
    comp.appendChild(a); a.name = 'dow'; a.textAutoResize = 'WIDTH_AND_HEIGHT';
    try { a.textCase = 'UPPER'; } catch (e) { /* older API */ }
    var b = await styledText(R, '--type-b2s', on ? '--purple-500' : off ? '--dark-100' : '--dark-500', '7 Nov');
    comp.appendChild(b); b.name = 'date'; b.textAutoResize = 'WIDTH_AND_HEIGHT';
    var mt = await styledText(R, '--type-b3', off ? '--dark-100' : '--dark-300', '6 games');   // .date-strip__meta
    comp.appendChild(mt); mt.name = 'meta'; mt.textAutoResize = 'WIDTH_AND_HEIGHT'; mt.visible = false;
    var dot = figma.createEllipse();   // .is-mine::after: 8px green-500, top 4 right 4
    comp.appendChild(dot); dot.name = 'mine';
    dot.layoutPositioning = 'ABSOLUTE'; dot.resize(8, 8);
    dot.x = comp.width - 12; dot.y = 4;
    dot.constraints = { horizontal: 'MAX', vertical: 'MIN' };
    dot.fills = paintFor(R, '--green-500');
    dot.visible = false;
    sParts[comp.name] = { dow: a, num: b, meta: mt, mine: dot };
  }, function (set) {
    var pA = ensureProp(set, 'dow', 'TEXT', 'SAT'), pB = ensureProp(set, 'date', 'TEXT', '7 Nov', 'num'), pM = ensureProp(set, 'mine', 'BOOLEAN', false);
    var pSM = ensureProp(set, 'showMeta', 'BOOLEAN', false), pMT = ensureProp(set, 'meta', 'TEXT', '6 games');
    wireKeys(sParts).forEach(function (k) { var p = sParts[k]; p.dow.componentPropertyReferences = { characters: pA }; p.num.componentPropertyReferences = { characters: pB }; p.mine.componentPropertyReferences = { visible: pM }; p.meta.componentPropertyReferences = { visible: pSM, characters: pMT }; });
    set.description = '<button class="swing_date_strip__day [is-mine]" aria-pressed="{selected}"><span class="swing_date_strip__dow">Sat</span><span class="swing_date_strip__num">7 Nov</span>[<span class="swing_date_strip__meta">6 games</span>]</button>. ' +
      'showMeta + meta = the optional line under the date (B3 dark-300, dark-100 when off), tile grows to 60; in a strip turn it on for every day so heights match. ' +
      'Min 64 x 48, padding 4/12, radius 8, light-100 + 1px light-400. Weekday B3 dark-300 uppercase over the date B2 Semibold dark-500. selected = purple-50 + 1px purple-500, date purple-500 · disabled = 1px light-300, all dark-100 (no rounds that day) · mine = 8px green-500 dot top-right (you are in a round).';
  }, function () {}, R);
  var ps = pairUp(sd, sv, function (c) { return sParts[c.name]; });
  await docArtboard(R, page, sd, ps.comps, ps.vs, {
    title: 'DateStripDay', description: 'One day in the date strip. Days with nothing on are off; the green dot marks a day you are playing.',
    code: ['<button class="swing_date_strip__day is-mine" aria-pressed="true"><span class="swing_date_strip__dow">Sat</span><span class="swing_date_strip__num">7 Nov</span></button>', 'selected = aria-pressed="true" · disabled = disabled · mine = .is-mine'],
    colGroups: [{ label: 'example', cols: ['day'] }], rowGroups: [{ label: 'state', rows: ['default', 'selected', 'disabled'] }],
    place: function (v) { return { cg: 0, c: 0, rg: 0, r: ['default', 'selected', 'disabled'].indexOf(v.name.split('=')[1]) }; },
    examples: [{ label: 'selected · mine', items: [{ variant: 'state=selected', props: { mine: true } }] },
      { label: 'with meta line', items: [{ variant: 'state=default', props: { showMeta: true, meta: '4 games' } }, { variant: 'state=selected', props: { showMeta: true, meta: '6 games', mine: true } }, { variant: 'state=disabled', props: { showMeta: true, meta: 'No games' } }] }]
  });
  var SD = byName(sd);
  var tv = [{ name: 'type=default' }, { name: 'type=meta' }];
  var strip = await buildSet(page, 'DateStrip', tv, async function (comp, v) {
    var withMeta = v.name === 'type=meta', H = withMeta ? 76 : 64;   // 8 + 60 + 8 with the meta line
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(390, H); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    comp.clipsContent = true;
    bindNumber(R, comp, 'itemSpacing', '--space-8', 8);
    bindNumber(R, comp, 'paddingTop', '--space-8', 8); bindNumber(R, comp, 'paddingBottom', '--space-8', 8);
    bindNumber(R, comp, 'paddingLeft', '--space-64', 64); bindNumber(R, comp, 'paddingRight', '--page-x', 24);
    comp.fills = paintFor(R, '--light-100');
    [['FRI', '6 Nov', 'disabled', false, 'No games'], ['SAT', '7 Nov', 'selected', true, '6 games'], ['SUN', '8 Nov', 'default', false, '4 games'], ['MON', '9 Nov', 'disabled', false, 'No games'], ['TUE', '10 Nov', 'disabled', false, 'No games'], ['WED', '11 Nov', 'default', false, '2 games']].forEach(function (d) {
      var it = SD['state=' + d[2]].createInstance(); comp.appendChild(it);
      var pr = { dow: d[0], date: d[1], mine: !!d[3] };
      if (withMeta) { pr.showMeta = true; pr.meta = d[4]; }
      try { it.setProperties(propsFor(it, pr)); } catch (e) { /* default */ }
    });
    // .date-strip__cal: the calendar stays on the left, days scroll under its 16px fade
    var cal = figma.createFrame(); comp.appendChild(cal); cal.name = 'cal';
    cal.layoutPositioning = 'ABSOLUTE';
    cal.resize(64, H); cal.x = 0; cal.y = 0;
    cal.constraints = { horizontal: 'MIN', vertical: 'STRETCH' };
    var bg = R.color['--light-100'] || { r: 1, g: 1, b: 1 };
    cal.fills = [{ type: 'GRADIENT_LINEAR', gradientTransform: [[1, 0, 0], [0, 1, 0]],
      gradientStops: [{ position: 0, color: { r: bg.r, g: bg.g, b: bg.b, a: 1 } }, { position: 0.75, color: { r: bg.r, g: bg.g, b: bg.b, a: 1 } }, { position: 1, color: { r: bg.r, g: bg.g, b: bg.b, a: 0 } }] }];
    var ic = dateIcon.createInstance(); cal.appendChild(ic); ic.name = 'icon'; ic.resize(24, 24);
    ic.x = 24; ic.y = (H - 24) / 2; ic.constraints = { horizontal: 'MIN', vertical: 'CENTER' };
    recolorIcon(R, ic, '--dark-400');
  }, function (s) { s.description = '<div class="swing_date_strip" data-days="14" data-cal>…swing_date_strip__day…</div> (picker.js renders the days; data-cal adds the calendar). light-100, padding 8 24, gap 8, scrolls sideways; type=meta = every day with its meta line (data-meta="6 games|No games|…"), 76 tall; the calendar icon (24, dark-400) stays on the left over a 16px fade. 390 wide, clips. Edit, add or remove DateStripDay instances; keep the cal layer last so it sits on top.'; }, function () {}, R);
  var pt = pairUp(strip, tv, function (c) { return /^type=/.test(c.name); });
  await docArtboard(R, page, strip, pt.comps, pt.vs, {
    title: 'DateStrip', description: 'The Swing date band: pick a day for rounds or tee times. Days without anything are off, the green dot is a day you play.',
    code: ['<div class="swing_date_strip" data-days="14" data-cal></div>', '<div class="swing_date_strip" data-days="14" data-cal data-meta="6 games|No games|4 games|…"></div>  (type=meta)', 'picker.js fires "pick" { value } · authored days (.swing_date_strip__day) are kept as they are'],
    colGroups: [{ label: 'example', cols: ['strip'] }], rowGroups: [{ label: 'type', rows: ['default', 'meta'] }],
    place: function (v) { return { cg: 0, c: 0, rg: 0, r: v.name === 'type=meta' ? 1 : 0 }; }
  });
  return { set: day, count: dv.length + 1 + sv.length + tv.length, label: 'CalDay 10, Calendar 1, DateStripDay 3, DateStrip 2 variants' };
}

/* ----- Time picker + Time wheel (components.css .slots, .slot, .time-wheel) ----- */
async function buildTimePickerPage(R, notes) {
  var page = await pageNamed('TimePicker');
  var sun = await iconOrPlaceholder('Icon/Line/sunrise', page, notes);
  var variants = [], parts = {};
  ['default', 'selected', 'disabled'].forEach(function (s) { ['false', 'true'].forEach(function (l) { variants.push({ state: s, low: l }); }); });
  simpleSet(variants);
  var slot = await buildSet(page, 'Slot', variants, async function (comp, v) {
    var on = v.state === 'selected', off = v.state === 'disabled', low = v.low === 'true';
    comp.layoutMode = 'VERTICAL'; comp.primaryAxisAlignItems = 'CENTER'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(108, 56); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    comp.minHeight = 56;
    bindNumber(R, comp, 'paddingTop', '--space-8', 8); bindNumber(R, comp, 'paddingBottom', '--space-8', 8);
    bindNumber(R, comp, 'paddingLeft', '--space-4', 4); bindNumber(R, comp, 'paddingRight', '--space-4', 4);
    bindRadius(R, comp, '--radius-12', 12);
    comp.fills = paintFor(R, on ? '--purple-500' : '--light-100');
    comp.strokes = paintFor(R, on ? '--purple-500' : '--light-500'); comp.strokeWeight = 1; comp.strokeAlign = 'INSIDE';
    var t = await styledText(R, '--type-s3s', on ? '--light-100' : '--dark-500', '07:30');
    comp.appendChild(t); t.name = 'time'; t.textAutoResize = 'WIDTH_AND_HEIGHT';
    if (off) { try { t.textDecoration = 'STRIKETHROUGH'; } catch (e) { /* older API */ } }
    var m = await styledText(R, '--type-b3', on ? '--purple-100' : low ? '--orange-700' : '--dark-300', off ? 'Full' : low ? '1 left' : '4 left');
    comp.appendChild(m); m.name = 'meta'; m.textAutoResize = 'WIDTH_AND_HEIGHT';
    parts[comp.name] = { time: t, meta: m };
  }, function (set) {
    var pT = ensureProp(set, 'time', 'TEXT', '07:30'), pSM = ensureProp(set, 'showMeta', 'BOOLEAN', true);
    wireKeys(parts).forEach(function (k) { parts[k].time.componentPropertyReferences = { characters: pT }; parts[k].meta.componentPropertyReferences = { visible: pSM }; });
    set.description = '<button class="swing_slot [is-low]" aria-pressed="{selected}"><span class="swing_slot__time">07:30</span><span class="swing_slot__meta">4 left</span></button>. Min 56, padding 8/4, radius 12, light-100 + 1px light-500, time S3 Semibold, meta B3 dark-300. low = orange-700 meta · selected = purple-500, white time, purple-100 meta · disabled = time struck through. Width 108 = 3 per row in 342 (min 88).';
  }, function () {}, R);
  var pv = pairUp(slot, variants, function (c) { return parts[c.name]; });
  await docArtboard(R, page, slot, pv.comps, pv.vs, {
    title: 'Slot', description: 'A tee time to pick. Few places left turns the count orange; full ones are struck through.',
    code: ['<button class="swing_slot" aria-pressed="false"><span class="swing_slot__time">07:30</span><span class="swing_slot__meta">4 left</span></button>', 'low = .is-low · selected = aria-pressed="true" · disabled = disabled'],
    colGroups: [{ label: 'low', cols: ['false', 'true'] }], rowGroups: [{ label: 'state', rows: ['default', 'selected', 'disabled'] }],
    place: function (v) { return { cg: 0, c: v.low === 'true' ? 1 : 0, rg: 0, r: ['default', 'selected', 'disabled'].indexOf(v.state) }; }
  });
  var S = byName(slot);
  // SlotsGroup
  var gv = [{ name: 'type=default' }];
  var grp = await buildSet(page, 'SlotsGroup', gv, async function (comp) {
    comp.layoutMode = 'VERTICAL';
    comp.resize(342, 160); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--space-8', 8);
    comp.fills = [];
    var h = autoFrame('head', 'HORIZONTAL', comp);
    h.counterAxisAlignItems = 'CENTER'; h.layoutSizingHorizontal = 'FILL'; h.layoutSizingVertical = 'HUG';
    bindNumber(R, h, 'itemSpacing', '--space-8', 8);
    var i = sun.createInstance(); h.appendChild(i); i.name = 'icon'; i.resize(16, 16); recolorIcon(R, i, '--dark-300');
    var ht = await styledText(R, '--type-b2s', '--dark-300', 'Morning'); h.appendChild(ht); ht.name = 'title'; ht.textAutoResize = 'WIDTH_AND_HEIGHT';
    var slots = [['06:30', 'default', 'false'], ['07:00', 'disabled', 'false'], ['07:30', 'selected', 'false'], ['08:00', 'default', 'true'], ['08:30', 'default', 'false'], ['09:00', 'default', 'false']];
    for (var r = 0; r < 2; r++) {
      var row = autoFrame('row', 'HORIZONTAL', comp);
      row.layoutSizingHorizontal = 'FILL'; row.layoutSizingVertical = 'HUG';
      bindNumber(R, row, 'itemSpacing', '--space-8', 8);
      slots.slice(r * 3, r * 3 + 3).forEach(function (s) {
        var it = S['state=' + s[1] + ', low=' + s[2]].createInstance(); row.appendChild(it); it.layoutSizingHorizontal = 'FILL';
        try { it.setProperties(propsFor(it, { time: s[0] })); } catch (e) { /* default */ }
      });
    }
  }, function (s) { s.description = '<div class="swing_slots_group"><div class="swing_slots_group__head"><i class="swing_icon"></i>Morning</div><div class="swing_slots">…slot…</div></div>. Head B2 Semibold dark-300 with a 16 icon, slots in a grid of min 88 (3 per row at 342), gap 8; groups 16 apart.'; }, function () {}, R);
  var pg = pairUp(grp, gv, function (c) { return c.name === 'type=default'; });
  await docArtboard(R, page, grp, pg.comps, pg.vs, {
    title: 'SlotsGroup', description: 'Tee times for one part of the day.',
    code: ['<div class="swing_slots_group"><div class="swing_slots_group__head">…Morning</div><div class="swing_slots"><button class="swing_slot">…</button>…</div></div>', 'grid-template-columns: repeat(auto-fill, minmax(88px, 1fr))'],
    colGroups: [{ label: 'example', cols: ['morning'] }], rowGroups: [{ label: 'type', rows: ['default'] }],
    place: function () { return { cg: 0, c: 0, rg: 0, r: 0 }; }
  });
  // TimeWheel
  var wv = [{ name: 'type=default' }];
  var wheel = await buildSet(page, 'TimeWheel', wv, async function (comp) {
    comp.resize(342, 220);
    comp.fills = [];
    var band = figma.createRectangle(); comp.appendChild(band); band.name = 'band';
    band.resize(342, 44); band.x = 0; band.y = 88;
    bindRadius(R, band, '--radius-12', 12);
    band.fills = paintFor(R, '--purple-50');
    band.strokes = paintFor(R, '--purple-100'); band.strokeWeight = 1; band.strokeAlign = 'INSIDE';
    band.constraints = { horizontal: 'STRETCH', vertical: 'CENTER' };
    var cols = autoFrame('columns', 'HORIZONTAL', comp);
    cols.counterAxisAlignItems = 'CENTER';
    cols.resize(342, 220); cols.x = 0; cols.y = 0;
    cols.constraints = { horizontal: 'STRETCH', vertical: 'STRETCH' };
    async function col(vals, on) {
      var c = autoFrame('column', 'VERTICAL', cols);
      c.layoutSizingHorizontal = 'FILL'; c.layoutSizingVertical = 'HUG';
      for (var i = 0; i < vals.length; i++) {
        var it = autoFrame('item', 'HORIZONTAL', c); it.primaryAxisAlignItems = 'CENTER'; it.counterAxisAlignItems = 'CENTER';
        it.resize(150, 44); it.layoutSizingHorizontal = 'FILL'; it.layoutSizingVertical = 'FIXED';
        it.opacity = i === 0 || i === 4 ? 0.33 : 1;   // the column mask fades the outer rows
        var t = await styledText(R, '--type-h4', i === on ? '--purple-600' : '--dark-200', vals[i]);
        it.appendChild(t); t.name = 'value'; t.textAutoResize = 'WIDTH_AND_HEIGHT';
      }
    }
    await col(['05', '06', '07', '08', '09'], 2);
    var sep = await styledText(R, '--type-h4', '--purple-600', ':');
    var sb = autoFrame('sep', 'HORIZONTAL', cols); bindNumber(R, sb, 'paddingLeft', '--space-8', 8); bindNumber(R, sb, 'paddingRight', '--space-8', 8);
    sb.appendChild(sep); sep.name = 'text'; sep.textAutoResize = 'WIDTH_AND_HEIGHT';
    await col(['20', '25', '30', '35', '40'], 2);
  }, function (s) { s.description = '<div class="swing_time_wheel" data-step="5"></div> (picker.js), 24h. Five 44 rows (220), the middle one in a purple-50 band with a 1px purple-100 ring; values H4 dark-200, the picked one purple-600, ":" purple-600. Outer rows fade out. In a Sheet with an Apply button.'; }, function () {}, R);
  var pw = pairUp(wheel, wv, function (c) { return c.name === 'type=default'; });
  await docArtboard(R, page, wheel, pw.comps, pw.vs, {
    title: 'TimeWheel', description: 'Pick an exact time in a sheet: hours and minutes in steps of 5, the value is the row in the purple band.',
    code: ['<div class="swing_time_wheel" data-step="5"></div>', 'picker.js renders .swing_tw_col / .swing_tw_item / .swing_tw_sep; .swing_tw_presets = quick chips'],
    colGroups: [{ label: 'example', cols: ['07:30'] }], rowGroups: [{ label: 'type', rows: ['default'] }],
    place: function () { return { cg: 0, c: 0, rg: 0, r: 0 }; }
  });
  notes.push('Slot: the tap scales to .97 on the web. TimeWheel: the web fades the columns with a gradient mask; Figma lowers the opacity of the outer rows instead.');
  return { set: slot, count: variants.length + 2, label: 'Slot 6, SlotsGroup 1, TimeWheel 1 variants' };
}

/* ----- SwingPass background (components.css .swing-pass) ----- */
async function buildSwingPassPage(R, notes) {
  var page = await pageNamed('SwingPass');
  var variants = simpleSet([{ shape: 'card' }, { shape: 'hero' }]);
  var set = await buildSet(page, 'SwingPass', variants, async function (comp, v) {
    var w = v.shape === 'hero' ? 390 : 342, h = v.shape === 'hero' ? 280 : 200;
    comp.resize(w, h);
    comp.clipsContent = true;
    comp.fills = paintFor(R, '--purple-500');
    function blob(name, css, op, bw, bh, x, y) {   // ::before / ::after: blurred circles (blur 48)
      var e = figma.createEllipse(); comp.appendChild(e); e.name = name;
      e.resize(bw, bh); e.x = x; e.y = y;
      e.fills = paintFor(R, css); e.opacity = op;
      e.effects = [{ type: 'LAYER_BLUR', radius: 48, visible: true }];
      e.constraints = { horizontal: 'SCALE', vertical: 'SCALE' };
    }
    blob('glow (::before)', '--purple-300', 0.8, w * 0.95, h * 1.3, -0.3 * w, h - (h * 1.3 - 0.7 * h));
    blob('deep (::after)', '--purple-700', 0.75, w * 0.8, h * 1.2, w - w * 0.8 + 0.35 * w, -0.65 * h);
  }, function (s) { s.description = '<div class="swing_pass [swing_pass_static]">…content…</div>. purple-500 base with two blurred blobs: purple-300 at 80% bottom-left, purple-700 at 75% top-right (blur 48). Text on it is light-100. On the web the blobs drift (14s); Figma shows the start frame. Put content on top of the instance; resize it to any size.'; }, function () {}, R);
  var pv = pairUp(set, variants, function (c) { return /^shape=/.test(c.name); });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'SwingPass', description: 'The Swing Pass surface: purple with a soft lavender glow and a deep purple corner. Use it behind Swing Pass cards and heroes, with white text.',
    code: ['<div class="swing_pass">…</div>', '.swing_pass_static = no motion · .is-paused = paused from JS'],
    colGroups: [{ label: 'shape', cols: ['card', 'hero'] }], rowGroups: [{ label: 'example', rows: ['surface'] }],
    place: function (v) { return { cg: 0, c: v.name === 'shape=hero' ? 1 : 0, rg: 0, r: 0 }; }
  });
  notes.push('SwingPass: the blobs drift on the web (14s loop); Figma shows the first frame.');
  return { set: set, count: variants.length, label: 'SwingPass 2 variants' };
}

/* ----- Accordion (components.css .list-acc) ----- */
async function buildAccordionPage(R, notes) {
  var page = await pageNamed('Accordion');
  var chev = await iconOrPlaceholder('Icon/Line/chevron-down', page, notes), lead = await iconOrPlaceholder('Icon/Line/golf', page, notes);
  var variants = [], parts = {};
  ['false', 'true'].forEach(function (o) { ['false', 'true'].forEach(function (l) { variants.push({ open: o, lead: l }); }); });
  simpleSet(variants);
  async function buildVariant(comp, v) {
    var open = v.open === 'true', hasLead = v.lead === 'true';
    comp.layoutMode = 'VERTICAL';
    comp.resize(342, 56); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    comp.itemSpacing = 0; comp.fills = [];
    var sm = autoFrame('summary', 'HORIZONTAL', comp);   // summary.list-item
    sm.counterAxisAlignItems = 'CENTER'; sm.layoutSizingHorizontal = 'FILL'; sm.layoutSizingVertical = 'HUG';
    sm.minHeight = 56;
    bindNumber(R, sm, 'itemSpacing', '--space-12', 12);
    bindNumber(R, sm, 'paddingTop', '--space-16', 16); bindNumber(R, sm, 'paddingBottom', '--space-16', 16);
    var p = {};
    if (hasLead) { var li = lead.createInstance(); sm.appendChild(li); li.name = 'leadIcon'; li.resize(24, 24); recolorIcon(R, li, '--dark-500'); p.lead = li; }
    var t = await styledText(R, '--type-b1s', '--dark-500', 'Can I bring a guest?');
    sm.appendChild(t); t.name = 'title'; t.textAutoResize = 'HEIGHT'; t.layoutSizingHorizontal = 'FILL';
    var c = chev.createInstance(); sm.appendChild(c); c.name = 'chevron'; c.resize(20, 20); recolorIcon(R, c, '--dark-200');
    if (open) c.rotation = 180;   // .list-acc[open] .list-item__chev { rotate(180deg) }
    if (open) {
      var pn = autoFrame('panel', 'VERTICAL', comp);   // .list-acc__panel
      pn.layoutSizingHorizontal = 'FILL'; pn.layoutSizingVertical = 'HUG';
      bindNumber(R, pn, 'paddingBottom', '--space-16', 16);
      pn.paddingLeft = hasLead ? 36 : 0;   // calc(24 + 12) with a lead
      var b = await styledText(R, '--type-b1', '--dark-300', 'Yes. Members can bring up to 3 guests per round. Guests pay the visitor green fee at the counter.');
      pn.appendChild(b); b.name = 'body'; b.textAutoResize = 'HEIGHT'; b.layoutSizingHorizontal = 'FILL';
      p.body = b;
      p.line = bottomLine(R, comp, 'divider', 0, '--color-line');   // the line moves under the panel
    } else {
      p.line = bottomLine(R, comp, 'divider', 0, '--color-line');
    }
    p.title = t;
    parts[comp.name] = p;
  }
  function wire(set) {
    var pT = ensureProp(set, 'title', 'TEXT', 'Can I bring a guest?');
    var pB = ensureProp(set, 'body', 'TEXT', 'Yes. Members can bring up to 3 guests per round. Guests pay the visitor green fee at the counter.');
    var pL = ensureProp(set, 'showDivider', 'BOOLEAN', true);
    var pI = ensureProp(set, 'leadIcon', 'INSTANCE_SWAP', lead.id);
    wireKeys(parts).forEach(function (k) {
      var p = parts[k];
      p.title.componentPropertyReferences = { characters: pT };
      if (p.body) p.body.componentPropertyReferences = { characters: pB };
      p.line.componentPropertyReferences = { visible: pL };
      if (p.lead) p.lead.componentPropertyReferences = { mainComponent: pI };
    });
    set.description = '<details class="swing_list_acc [open]"><summary class="swing_list_item">[<span class="swing_list_item__lead">…</span>]<span class="swing_list_item__text"><span class="swing_list_item__title">{title}</span></span><i class="swing_icon swing_list_item__chev" …chevron-down></i></summary><div class="swing_list_acc__panel">{body}</div></details> inside .swing_list. ' +
      'Summary = a ListItem row (padding 16, title B1 Semibold) with a 20 dark-200 chevron-down that turns when open. Panel B1 dark-300, padding 0 0 16, starts at the text (36 with a lead). The line sits under the summary when closed and under the panel when open; turn it off on the last one.';
  }
  var set = await buildSet(page, 'Accordion', variants, buildVariant, wire, function () {}, R);
  var pv = pairUp(set, variants, function (c) { return parts[c.name]; });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: 'Accordion', description: 'A list row that opens to show more: FAQs, course rules, package details. Native <details>, no JS needed.',
    code: ['<div class="swing_list"><details class="swing_list_acc"><summary class="swing_list_item">…<i class="swing_icon swing_list_item__chev" …chevron-down></i></summary><div class="swing_list_acc__panel">…</div></details></div>', 'open = [open] · lead = .swing_list_item__lead (panel starts at 36)'],
    colGroups: [{ label: 'open', cols: ['false', 'true'] }], rowGroups: [{ label: 'lead', rows: ['false', 'true'] }],
    place: function (v) { return { cg: 0, c: v.open === 'true' ? 1 : 0, rg: 0, r: v.lead === 'true' ? 1 : 0 }; }
  });
  return { set: set, count: variants.length, label: 'Accordion ' + variants.length + ' variants' };
}

/* ----- Foundations: Color + Typography (documentation pages, bound to the imported tokens) ----- */
function foundationFrame(R, page, title, hugWidth) {
  var f = page.findChild(function (n) { return n.type === 'FRAME' && n.name === title; });
  if (!f) { f = figma.createFrame(); page.appendChild(f); f.name = title; f.x = 0; f.y = 0; }
  f.children.slice().forEach(function (n) { n.remove(); });
  f.layoutMode = 'VERTICAL';
  f.resize(1228, 400); f.layoutSizingHorizontal = hugWidth ? 'HUG' : 'FIXED'; f.layoutSizingVertical = 'HUG';
  f.paddingTop = f.paddingBottom = f.paddingLeft = f.paddingRight = 64;
  f.itemSpacing = 48;
  f.fills = paintFor(R, '--color-bg-subtle');
  f.clipsContent = false;
  return f;
}
function hexOf(c) {
  if (!c) return '';
  var h = function (x) { var s = Math.round(x * 255).toString(16); return s.length < 2 ? '0' + s : s; };
  var out = '#' + (h(c.r) + h(c.g) + h(c.b)).toUpperCase();
  return c.a != null && c.a < 1 ? out + ' ' + Math.round(c.a * 100) + '%' : out;
}
async function docHead(R, f, title, desc) {
  var h = autoFrame('head', 'VERTICAL', f);
  h.layoutSizingHorizontal = 'FILL'; h.layoutSizingVertical = 'HUG'; h.itemSpacing = 8;
  var t = await makeText(R, '--type-h3', '--color-text', title, h); t.name = 'title';
  var d = await makeText(R, '--type-b2', '--color-text-secondary', desc, h); d.name = 'description';
  d.textAutoResize = 'HEIGHT'; d.resize(720, d.height);
}

async function buildColorPage(R, notes) {
  var page = await pageNamed('Color');
  // One row per ramp, never wrapped (Ghais 11 Nov: "jangan buat turun ke bawah, tapi manjang semua"):
  // the frame hugs the longest ramp (purple, 10 steps) instead of a fixed 1228.
  var f = foundationFrame(R, page, 'Color', true);
  await docHead(R, f, 'Color', 'Every colour token of the Swing DS, bound to its variable. Ramps first, then the semantic roles that point at them, then the gradients. Use the semantic ones in screens; the ramps are for building components.');
  // group the colour variables by their path (Color/Primary/Purple/500 -> Primary / Purple)
  var groups = {}, order = [];
  for (var css in R.vars) {
    var v = R.vars[css];
    if (v.resolvedType !== 'COLOR') continue;
    var parts = v.name.split('/'), key = parts.slice(1, -1).join(' / ') || 'Other';
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push({ css: css, v: v, step: parts[parts.length - 1] });
  }
  // Ramps dark to light (900 ... 50, press right after 700). Steps added later (400, 200) were
  // created last in the file, so the variable order put them at the end of the row.
  var rank = function (s) { return /^\d+$/.test(s) ? Number(s) : s === 'press' ? 699.5 : null; };
  order.forEach(function (k) {
    var gs = groups[k];
    if (gs.every(function (x) { return rank(x.step) != null; })) gs.sort(function (a, b) { return rank(b.step) - rank(a.step); });
  });
  var cols = await figma.variables.getLocalVariableCollectionsAsync(), defMode = {};
  cols.forEach(function (c) { defMode[c.id] = c.defaultModeId; });
  var done = 0, total = order.reduce(function (a, k) { return a + groups[k].length; }, 0);
  figma.ui.postMessage({ type: 'build-progress', set: 'Color', done: 0, total: total, phase: 'variants' });
  for (var gi = 0; gi < order.length; gi++) {
    var g = autoFrame(order[gi], 'VERTICAL', f);
    g.layoutSizingHorizontal = 'HUG'; g.layoutSizingVertical = 'HUG'; g.itemSpacing = 16;
    var gl = await makeText(R, '--type-lbl-l', '--color-text', order[gi].toUpperCase(), g); gl.name = 'label';
    var row = autoFrame('swatches', 'HORIZONTAL', g);
    row.layoutWrap = 'NO_WRAP'; row.itemSpacing = 16;
    row.layoutSizingHorizontal = 'HUG'; row.layoutSizingVertical = 'HUG';
    for (var si = 0; si < groups[order[gi]].length; si++) {
      var it = groups[order[gi]][si], c = R.color[it.css];
      var sw = autoFrame(it.step, 'VERTICAL', row);
      sw.resize(128, 120); sw.layoutSizingHorizontal = 'FIXED'; sw.layoutSizingVertical = 'HUG'; sw.itemSpacing = 4;
      var chip = figma.createRectangle(); sw.appendChild(chip); chip.name = 'swatch';
      chip.resize(128, 72); chip.cornerRadius = 12; chip.layoutSizingHorizontal = 'FILL';
      chip.fills = paintFor(R, it.css);
      var lum = c ? 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b : 0;
      if (lum > 0.9 || (c && c.a != null && c.a < 0.3)) { chip.strokes = paintFor(R, '--color-line'); chip.strokeWeight = 1; chip.strokeAlign = 'INSIDE'; }
      var nm = await makeText(R, '--type-b2s', '--color-text', it.step, sw); nm.name = 'name';
      sw.itemSpacing = 4; nm.textAutoResize = 'HEIGHT'; nm.layoutSizingHorizontal = 'FILL';
      var cv = await makeText(R, '--type-b3', '--color-text-muted', 'var(' + it.css + ')', sw); cv.name = 'css';
      cv.textAutoResize = 'HEIGHT'; cv.layoutSizingHorizontal = 'FILL';
      var val = it.v.valuesByMode[defMode[it.v.variableCollectionId]], line = hexOf(c);
      if (val && val.type === 'VARIABLE_ALIAS') {   // semantic: show what it points at
        var target = await figma.variables.getVariableByIdAsync(val.id);
        var tcss = target && (target.description || '').split('\n')[0];
        if (tcss) line = '→ ' + tcss.replace(/^--/, '') + ' · ' + line;
      }
      var hx = await makeText(R, '--type-b3', '--color-text-muted', line, sw); hx.name = 'value';
      hx.textAutoResize = 'HEIGHT'; hx.layoutSizingHorizontal = 'FILL';
      done++;
      if (done % 12 === 0) figma.ui.postMessage({ type: 'build-progress', set: 'Color', done: done, total: total, phase: 'variants' });
    }
  }
  // gradients = paint styles
  var ps = (await figma.getLocalPaintStylesAsync()).filter(function (s) { return /^--/.test(s.description || ''); });
  if (ps.length) {
    var gg = autoFrame('Gradients', 'VERTICAL', f);
    gg.layoutSizingHorizontal = 'FILL'; gg.layoutSizingVertical = 'HUG'; gg.itemSpacing = 16;
    await makeText(R, '--type-lbl-l', '--color-text', 'GRADIENTS (PAINT STYLES)', gg);
    var gr = autoFrame('swatches', 'HORIZONTAL', gg);
    gr.layoutWrap = 'WRAP'; gr.itemSpacing = 16; gr.counterAxisSpacing = 24;
    gr.layoutSizingHorizontal = 'FILL'; gr.layoutSizingVertical = 'HUG';
    for (var pi = 0; pi < ps.length; pi++) {
      var s = ps[pi], box = autoFrame(s.name, 'VERTICAL', gr);
      box.resize(264, 140); box.layoutSizingHorizontal = 'FIXED'; box.layoutSizingVertical = 'HUG'; box.itemSpacing = 4;
      var r = figma.createRectangle(); box.appendChild(r); r.name = 'swatch';
      r.resize(264, 96); r.cornerRadius = 12; r.layoutSizingHorizontal = 'FILL';
      await r.setFillStyleIdAsync(s.id);
      var n1 = await makeText(R, '--type-b2s', '--color-text', s.name.split('/').pop(), box); n1.textAutoResize = 'HEIGHT'; n1.layoutSizingHorizontal = 'FILL';
      var n2 = await makeText(R, '--type-b3', '--color-text-muted', 'var(' + s.description.split('\n')[0] + ')', box); n2.textAutoResize = 'HEIGHT'; n2.layoutSizingHorizontal = 'FILL';
    }
  }
  figma.ui.postMessage({ type: 'build-progress', set: 'Color', done: total, total: total, phase: 'artboard' });
  return { set: f, count: total, label: total + ' colours in ' + order.length + ' groups, ' + ps.length + ' gradients' };
}

async function buildTypographyPage(R, notes) {
  var page = await pageNamed('Typography');
  var f = foundationFrame(R, page, 'Typography');
  f.resize(1600, f.height);   // two specimen columns: mobile and desktop
  await docHead(R, f, 'Typography', 'Every text style of the Swing DS with its size, line height and tracking, on mobile and on desktop (1024 and up, .type-desktop / .type-responsive in code). Headings for titles, Subheading for card and section names, Body for copy, CTA on buttons, Label for small caps-like labels. CTA and Label are the same on both.');
  // Desktop styles (--type-desktop-*) sit beside their mobile style, not in a group of their own.
  var styles = Object.keys(R.text).filter(function (css) { return !/^--type-desktop-/.test(css); }).map(function (css) { return { css: css, s: R.text[css], d: R.text[css.replace(/^--type-/, '--type-desktop-')] || null }; });
  var groups = {}, order = [];
  styles.forEach(function (x) { var k = x.s.name.split('/')[0]; if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(x); });
  var total = styles.length, done = 0;
  figma.ui.postMessage({ type: 'build-progress', set: 'Typography', done: 0, total: total, phase: 'variants' });
  var SAMPLE = { Heading: 'Tee off at Pondok Indah', Subheading: 'Saturday morning flight', Body: 'Greens were fast and true, and the caddie knew every break on the back nine.', CTA: 'Book a tee time', Label: 'MEMBERS ONLY' };
  function spec(s) {
    var lh = s.lineHeight && s.lineHeight.unit === 'PIXELS' ? Math.round(s.lineHeight.value * 10) / 10 : s.lineHeight && s.lineHeight.unit === 'PERCENT' ? s.lineHeight.value + '%' : 'auto';
    var ls = s.letterSpacing ? (s.letterSpacing.unit === 'PERCENT' ? Math.round(s.letterSpacing.value * 100) / 100 + '%' : Math.round(s.letterSpacing.value * 100) / 100 + 'px') : '0';
    return s.fontName.family + ' ' + s.fontName.style + ' · ' + s.fontSize + ' / ' + lh + ' · tracking ' + ls + (s.paragraphSpacing ? ' · paragraph ' + s.paragraphSpacing : '');
  }
  for (var gi = 0; gi < order.length; gi++) {
    var g = autoFrame(order[gi], 'VERTICAL', f);
    g.layoutSizingHorizontal = 'FILL'; g.layoutSizingVertical = 'HUG'; g.itemSpacing = 0;
    var gh = autoFrame('label', 'HORIZONTAL', g);
    gh.layoutSizingHorizontal = 'FILL'; gh.layoutSizingVertical = 'HUG'; gh.itemSpacing = 40; gh.paddingBottom = 8;
    var gl = await makeText(R, '--type-lbl-l', '--color-text', order[gi].toUpperCase(), gh); gl.name = 'group';
    gl.textAutoResize = 'HEIGHT'; gl.resize(300, gl.height);
    var hm = await makeText(R, '--type-lbl-s', '--color-text-muted', 'MOBILE', gh); hm.name = 'mobile'; hm.textAutoResize = 'HEIGHT'; hm.layoutSizingHorizontal = 'FILL';
    var hd = await makeText(R, '--type-lbl-s', '--color-text-muted', 'DESKTOP · 1024+', gh); hd.name = 'desktop'; hd.textAutoResize = 'HEIGHT'; hd.layoutSizingHorizontal = 'FILL';
    for (var i = 0; i < groups[order[gi]].length; i++) {
      var x = groups[order[gi]][i];
      var row = autoFrame(x.s.name, 'HORIZONTAL', g);
      row.counterAxisAlignItems = 'CENTER'; row.layoutSizingHorizontal = 'FILL'; row.layoutSizingVertical = 'HUG';
      row.itemSpacing = 40; row.paddingTop = row.paddingBottom = 20;
      row.strokes = paintFor(R, '--color-line'); row.strokeAlign = 'INSIDE';
      row.strokeTopWeight = 0; row.strokeLeftWeight = 0; row.strokeRightWeight = 0; row.strokeBottomWeight = 1;
      var meta = autoFrame('meta', 'VERTICAL', row);
      meta.resize(300, 60); meta.layoutSizingHorizontal = 'FIXED'; meta.layoutSizingVertical = 'HUG'; meta.itemSpacing = 2;
      var a = await makeText(R, '--type-b2s', '--color-text', x.s.name, meta); a.name = 'name';
      var b = await makeText(R, '--type-b3', '--color-text-muted', 'var(' + x.css + ')', meta); b.name = 'css';
      var c = await makeText(R, '--type-b3', '--color-text-muted', spec(x.s), meta); c.name = 'spec';
      var txt = SAMPLE[order[gi]] || 'Tee off at Pondok Indah';
      var sample = await makeText(R, x.css, '--color-text', txt, row);
      sample.name = 'mobile'; sample.textAutoResize = 'HEIGHT'; sample.layoutSizingHorizontal = 'FILL';
      var dcol = autoFrame('desktop', 'VERTICAL', row);
      dcol.layoutSizingHorizontal = 'FILL'; dcol.layoutSizingVertical = 'HUG'; dcol.itemSpacing = 4;
      if (x.d) {
        var ds = await makeText(R, x.css.replace(/^--type-/, "--type-desktop-"), '--color-text', txt, dcol);
        ds.name = 'sample'; ds.textAutoResize = 'HEIGHT'; ds.layoutSizingHorizontal = 'FILL';
        var dm = await makeText(R, '--type-b3', '--color-text-muted', x.d.name + ' · ' + x.d.fontSize + ' / ' + (x.d.lineHeight && x.d.lineHeight.unit === 'PIXELS' ? Math.round(x.d.lineHeight.value) : 'auto'), dcol);
        dm.name = 'spec';
      } else {
        var same = await makeText(R, '--type-b3', '--color-text-muted', 'Same as mobile', dcol); same.name = 'same';
      }
      done++;
      if (done % 6 === 0) figma.ui.postMessage({ type: 'build-progress', set: 'Typography', done: done, total: total, phase: 'variants' });
    }
  }
  figma.ui.postMessage({ type: 'build-progress', set: 'Typography', done: total, total: total, phase: 'artboard' });
  var nd = styles.filter(function (x) { return x.d; }).length;
  return { set: f, count: total, label: total + ' text styles in ' + order.length + ' groups, ' + nd + ' with a desktop size' };
}

/* ================= Screens: ref UI pages rebuilt from the DS components =================
   One Figma page per ref screen (stat.chara.id/swing/ref/<screen>.html). Left: the screen
   frame, 390 wide, auto layout, made only of component instances. Right: "Components on
   this screen", every part it uses. Parts that are not a DS page yet are built here as
   component sets; DS parts are shown as instances of their own page. Photos and art are
   loaded from the ref site (manifest allows stat.chara.id); grey boxes if that fails. */
var REF_URL = 'https://stat.chara.id/swing/';
var REF_CACHE = {};
function refMiss(notes, path) {   // one note for all files that did not load, not one per file
  var pre = 'Screens: could not load ', i = notes.findIndex(function (n) { return n.indexOf(pre) === 0; });
  var files = i >= 0 ? notes[i].slice(pre.length).split(' from stat.chara.id')[0].split(', ') : [];
  if (files.indexOf(path) < 0) files.push(path);
  var m = pre + files.join(', ') + ' from stat.chara.id, so grey boxes are used there. Check the connection and build again.';
  if (i >= 0) notes[i] = m; else notes.push(m);
}
async function refFetchSvg(path) {
  if (REF_CACHE['svg:' + path] !== undefined) return REF_CACHE['svg:' + path];
  var t = null;
  // fp=1: a URL Cloudflare has not cached yet, so it carries the CORS header added on 10 Nov (ref/img/.htaccess)
  try { var r = await fetch(REF_URL + path + (path.indexOf('?') < 0 ? '?' : '&') + 'fp=1'); if (r.ok) t = await r.text(); } catch (e) { t = null; }
  REF_CACHE['svg:' + path] = t;
  return t;
}
async function refPhoto(R, node, path, notes) {   // image fill (cover), grey if it can't load
  var k = 'img:' + path;
  if (REF_CACHE[k] === undefined) {
    try { var im = await figma.createImageAsync(REF_URL + path); REF_CACHE[k] = im.hash; } catch (e) { REF_CACHE[k] = null; }
  }
  if (REF_CACHE[k]) node.fills = [{ type: 'IMAGE', imageHash: REF_CACHE[k], scaleMode: 'FILL' }];
  else { node.fills = paintFor(R, '--light-300'); refMiss(notes, path); }
}
// An SVG from the ref site as plain vectors (logos, art). Give w, h or both; a missing side keeps the ratio.
async function refArt(R, parent, path, w, h, name, notes) {
  var svg = await refFetchSvg(path), n = null;
  if (svg) { try { n = figma.createNodeFromSvg(svg); } catch (e) { n = null; } }
  if (!n) { n = figma.createRectangle(); n.resize(w || h || 16, h || w || 16); n.fills = paintFor(R, '--light-300'); refMiss(notes, path); }
  parent.appendChild(n);
  n.name = name;
  var s = w ? w / n.width : h / n.height;
  if (n.type !== 'RECTANGLE' && Math.abs(s - 1) > 0.001) n.rescale(s);
  if (w && h && (Math.abs(n.width - w) > 0.5 || Math.abs(n.height - h) > 0.5)) n.resize(w, h);
  return n;
}
function refTint(R, node, css) {   // recolour every shape of an SVG (fills and strokes) to one token
  if (!css) return;
  node.findAll(function (n) { return n.type !== 'FRAME' && n.type !== 'GROUP' && 'fills' in n; }).forEach(function (n) {
    if (n.fills && n.fills.length) n.fills = paintFor(R, css);
    if (n.strokes && n.strokes.length) n.strokes = paintFor(R, css);
  });
}
// Icons the ref screens use that the DS icon set does not have yet: components in a "Ref" section
// of the Icons page, so they publish with the library like every other icon.
async function refIcon(R, name, path, size, css, notes, page) {
  var full = 'Icon/Ref/' + name;
  if (LIB) {   // the base library has the ref icons its own parts use; screen art it lacks is made here, on this file's Icons page
    var lc = await findIcon(full);
    if (lc) return lc;
  }
  var ip = await pageNamed('Icons');
  var c = ip.findOne(function (n) { return n.type === 'COMPONENT' && n.name === full; });
  if (!c) {   // the first Home build (10 Nov) put them on the screen page: move, so instances stay linked
    var sp = figma.root.children.filter(function (p) { return p.name === 'Screen / Home'; })[0];
    if (sp) { await sp.loadAsync(); c = sp.findOne(function (n) { return n.type === 'COMPONENT' && n.name === full; }); }
  }
  if (!c) { c = figma.createComponent(); c.name = full; }
  var sec = await iconSection(ip, 'Ref', R);
  if (c.parent !== sec) {
    sec.appendChild(c);
    var k = sec.children.length - 1;
    c.x = 40 + (k % ICON_COLS) * ICON_CELL; c.y = 40 + Math.floor(k / ICON_COLS) * ICON_CELL;
    sec.resizeWithoutConstraints(80 + ICON_COLS * ICON_CELL - 24, 80 + Math.ceil((k + 1) / ICON_COLS) * ICON_CELL - 24);
  }
  c.children.slice().forEach(function (x) { x.remove(); });
  c.resizeWithoutConstraints(size, size);
  c.fills = [];
  var svg = await refFetchSvg(path), node = null;
  if (svg) { try { node = figma.createNodeFromSvg(svg); } catch (e) { node = null; } }
  if (!node) { node = figma.createEllipse(); node.resize(size - 8, size - 8); node.fills = paintFor(R, '--light-500'); refMiss(notes, path); }
  c.appendChild(node);
  node.name = 'art';
  if (node.type === 'FRAME') { node.fills = []; node.rescale(size / Math.max(node.width, node.height)); }
  node.x = (size - node.width) / 2; node.y = (size - node.height) / 2;
  node.constraints = { horizontal: 'SCALE', vertical: 'SCALE' };
  refTint(R, node, css);
  c.description = 'From ' + REF_URL + path + '. Not in the DS icon set yet.';
  return c;
}
async function paintStyleFor(R, css) {
  if (!R.pstyles) {
    R.pstyles = {};
    var byName = {};
    (await figma.getLocalPaintStylesAsync()).forEach(function (s) { var k = (s.description || '').split('\n')[0]; if (/^--/.test(k)) R.pstyles[k] = s; byName[s.name] = s; });
    R.pstylesByName = byName;
  }
  // a style named the way this plugin names it counts even without the CSS name in its description
  var named = R.pstylesByName && R.pstylesByName[paintName(css)];
  if (named && PAINT_NAMES[css]) return named;   // the file's own agreed style wins over an older one this plugin made
  return R.pstyles[css] || named || null;
}
async function fillStyle(R, node, css, fallbackCss) {   // gradients live as paint styles
  var st = await paintStyleFor(R, css);
  if (st) await node.setFillStyleIdAsync(st.id);
  else { R.missing[css] = 1; node.fills = paintFor(R, fallbackCss); }
}
async function effectStyle(R, node, css) {
  var st = R.effects[css];
  if (st) await node.setEffectStyleIdAsync(st.id); else R.missing[css] = 1;
}
function padX(R, f) { bindNumber(R, f, 'paddingLeft', '--page-x', 24); bindNumber(R, f, 'paddingRight', '--page-x', 24); }
function fillHug(f) { f.layoutSizingHorizontal = 'FILL'; f.layoutSizingVertical = 'HUG'; }
function hugHug(f) { f.layoutSizingHorizontal = 'HUG'; f.layoutSizingVertical = 'HUG'; }
function setText(inst, plain) {
  try { inst.setProperties(propsFor(inst, plain)); } catch (e) { /* keep defaults */ }
  // a swapped icon comes in with its own colour (dark): give it the button's label colour again (Ghais 11 Nov: dark chevron on Join)
  if (plain && (plain.iconStart || plain.iconEnd)) tintSwappedIcons(inst);
}
function tintSwappedIcons(inst) {
  // Found by structure, not by layer name: a swapped nested instance can come back under the icon's own name.
  // The colour is copied as a plain colour: a fill that carries the label's variable binding can be refused.
  var label = inst.findOne && inst.findOne(function (n) { return n.type === 'TEXT' && n.name === 'label'; });
  var lf = label && label.fills, p0 = lf && lf !== figma.mixed && lf.length ? lf[0] : null;
  if (!p0 || p0.type !== 'SOLID') return;
  var paint = { type: 'SOLID', color: { r: p0.color.r, g: p0.color.g, b: p0.color.b }, opacity: p0.opacity == null ? 1 : p0.opacity };
  (inst.findAll ? inst.findAll(function (n) { return n.type === 'INSTANCE'; }) : []).forEach(function (ic) {
    var shape = ic.findOne(function (n) { return n.name === 'Icon'; });
    if (shape) { try { shape.fills = [paint]; } catch (e) { /* keep */ } }
  });
}

/* ----- DS parts from Home V5 (components.css: .photo-tile, .pass-upsell, .section-head, .product-card,
   .promo-banner, .help-card, .link-card). Each is its own DS page, like Button, so every screen
   (and the library) uses the same component. ----- */
async function partKit(R, page, notes) {
  var btnSet = await setFrom('Button', 'Button', buildButton, R, notes);
  var tert = byName(btnSet)['size=s, tone=primary, appearance=tertiary, state=default'];
  var K = { I: { chev: await iconOrPlaceholder('Icon/Line/chevron-right', page, notes), info: await iconOrPlaceholder('Icon/Line/info', page, notes) } };
  K.txt = async function (parent, style, color, chars, name, mode) {
    var t = await styledText(R, style, color, chars); parent.appendChild(t); t.name = name;
    if (mode === 'fill') { t.textAutoResize = 'HEIGHT'; t.layoutSizingHorizontal = 'FILL'; } else t.textAutoResize = 'WIDTH_AND_HEIGHT';
    return t;
  };
  K.chip = function (parent, name, bg) {   // .product-chip (Regular): h16, padding 0 6, radius 8
    var c = autoFrame(name, 'HORIZONTAL', parent);
    c.counterAxisAlignItems = 'CENTER'; c.resize(60, 16); c.layoutSizingHorizontal = 'HUG'; c.layoutSizingVertical = 'FIXED';
    bindNumber(R, c, 'itemSpacing', '--space-4', 4); c.paddingLeft = 6; c.paddingRight = 6;
    bindRadius(R, c, '--radius-8', 8); c.fills = paintFor(R, bg);
    return c;
  };
  K.tertiary = function (parent, label) {   // .btn.btn--s.btn--tertiary + chevron-right
    var b = tert.createInstance(); parent.appendChild(b);
    setText(b, { label: label, showIconEnd: true, iconEnd: K.I.chev.id });
    return b;
  };
  return K;
}
// One-variant UI component, on the page of its screen (UI_PARTS) where the screen's component list
// shows it. A set an earlier build put on its own page ("PhotoTile", 10 Nov) is moved here first, keeping
// its id so placed instances stay linked; that page is removed once it holds no components.
async function buildPartPage(R, notes, name, build, wire, doc) {
  var page = await pageNamed(UI_PARTS[name] || name);
  if (!page.findOne(function (n) { return isUiSet(n, name); })) {
    var op = figma.root.children.filter(function (p) { return p.name === name && p !== page; })[0];
    if (op) {
      await op.loadAsync();
      var old = op.findOne(function (n) { return isUiSet(n, name); });
      if (old) { page.appendChild(old); old.layoutMode = 'NONE'; }
      if (!op.findOne(function (n) { return n.type === 'COMPONENT' || n.type === 'COMPONENT_SET'; }) && figma.currentPage !== op) {
        try { op.remove(); notes.push(name + ': moved from its own page to ' + page.name + ' (that page was empty, so it was removed).'); } catch (e) { /* keep the page */ }
      }
    }
  }
  var K = await partKit(R, page, notes);
  var V1 = (doc && doc.variants) || [{ name: 'type=default' }];   // a UI component with variants passes its own (name = 'key=value')
  var set = await buildSet(page, uiSetName(name), V1, function (comp, v) { return build(comp, K, page, v); }, wire, function () {}, R, UI_PARTS[name] ? name : undefined);
  if (UI_PARTS[name]) { if (!set.description) set.description = doc.description; return { set: set, count: 1, label: name + ' on ' + page.name }; }   // the screen's list is its artboard
  var pv = pairUp(set, V1, function (c) { return V1.some(function (v) { return v.name === c.name; }); });
  await docArtboard(R, page, set, pv.comps, pv.vs, {
    title: name, description: doc.description, code: doc.code,
    colGroups: [{ label: doc.colLabel || 'example', cols: doc.variants ? V1.map(function (v) { return v.name.split('=')[1]; }) : [doc.col || 'default'] }],
    rowGroups: [{ label: 'type', rows: ['default'] }],
    backdrop: doc.backdrop,   // a white part (glass) gets a dark cell behind it on the artboard
    place: function (v) { return { cg: 0, c: Math.max(0, V1.indexOf(v)), rg: 0, r: 0 }; }
  });
  return { set: set, count: V1.length, label: name + ' ' + V1.length + (V1.length === 1 ? ' variant' : ' variants') };
}

async function buildPhotoTilePage(R, notes) {
  var pt = {};
  return buildPartPage(R, notes, 'PhotoTile', async function (comp, K) {
    comp.layoutMode = 'VERTICAL'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(76, 120); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--space-4', 4); comp.fills = [];
    var ph = figma.createRectangle(); comp.appendChild(ph); ph.name = 'photo'; ph.resize(76, 100); ph.layoutSizingHorizontal = 'FILL';
    bindRadius(R, ph, '--radius-8', 8);
    await refPhoto(R, ph, 'ref/img/tile-teetime.jpg?v=2', notes);
    var l = await K.txt(comp, '--type-b3s', '--dark-500', 'Tee time', 'label', 'fill'); l.textAlignHorizontal = 'CENTER';
    pt[comp.name] = l;
  }, function (s) {
    var pL = ensureProp(s, 'label', 'TEXT', 'Tee time');
    wireKeys(pt).forEach(function (k) { pt[k].componentPropertyReferences = { characters: pL }; });
    s.description = '<a class="swing_photo_tile"><img …><span>{label}</span></a> in .swing_photo_tiles (4 columns, gap 12). Photo ratio 72.75 / 96, radius 8; label B3 Semibold centred. Change the photo by replacing the image fill on "photo".';
  }, { description: 'A photo shortcut with a label. Four of them in a row are the Home booking entries.',
    code: ['<nav class="swing_photo_tiles"><a class="swing_photo_tile" href="#"><img src="…" alt=""><span>Tee time</span></a>…</nav>', '.swing_photo_tiles = 4 columns, gap 12'] });
}

async function buildPassUpsellPage(R, notes) {
  var pu = {};
  return buildPartPage(R, notes, 'PassUpsell', async function (comp, K) {
    comp.layoutMode = 'VERTICAL'; comp.resize(342, 200); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    comp.clipsContent = true; bindRadius(R, comp, '--radius-16', 16); comp.fills = paintFor(R, '--light-100');
    await effectStyle(R, comp, '--elevation-brand-s');
    var top = autoFrame('top', 'VERTICAL', comp); fillHug(top);
    bindNumber(R, top, 'itemSpacing', '--space-32', 32);
    ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'].forEach(function (f) { bindNumber(R, top, f, '--space-24', 24); });
    await fillStyle(R, top, '--gradient-swing-pass', '--purple-500');
    var copy = autoFrame('copy', 'VERTICAL', top); fillHug(copy); bindNumber(R, copy, 'itemSpacing', '--space-8', 8);
    await refArt(R, copy, 'ref/img/h5/pass-logo-w.svg?v=1', 0, 24, 'Swing Pass logo', notes);
    var cp = await K.txt(copy, '--type-b2s', '--light-100', 'Get access to exclusive promotions and free of processing fees from only Rp. 300k / month', 'copy', 'fill');
    var g = autoFrame('btn-glass', 'HORIZONTAL', top);
    g.counterAxisAlignItems = 'CENTER'; hugHug(g);
    bindNumber(R, g, 'itemSpacing', '--space-4', 4);
    bindNumber(R, g, 'paddingLeft', '--space-12', 12); bindNumber(R, g, 'paddingRight', '--space-12', 12);
    bindNumber(R, g, 'paddingTop', '--space-8', 8); bindNumber(R, g, 'paddingBottom', '--space-8', 8);
    bindRadius(R, g, '--radius-8', 8);
    await fillStyle(R, g, '--glass-fill', null);
    g.strokes = paintFor(R, '--glass-line'); g.strokeWeight = 1;
    var gl = await K.txt(g, '--type-cta-s', '--light-100', 'Join Swing Pass', 'label');
    await refArt(R, g, 'ref/img/h5/btn-icon-w.svg?v=1', 14, 14, 'icon', notes);
    var row = autoFrame('credits', 'HORIZONTAL', comp); fillHug(row);
    row.counterAxisAlignItems = 'CENTER'; row.primaryAxisAlignItems = 'SPACE_BETWEEN';
    ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'].forEach(function (f) { bindNumber(R, row, f, '--space-16', 16); });
    await refArt(R, row, 'ref/img/h5/credits-logo.svg?v=1', 0, 16, 'Swing Credits logo', notes);
    var val = autoFrame('value', 'HORIZONTAL', row); val.counterAxisAlignItems = 'CENTER'; hugHug(val); bindNumber(R, val, 'itemSpacing', '--space-4', 4);
    var vt = await K.txt(val, '--type-b3s', '--dark-500', '0 credits', 'text');
    await refArt(R, val, 'ref/img/h5/chev-16.svg?v=1', 16, 16, 'chevron', notes);
    pu[comp.name] = { copy: cp, cta: gl, value: vt };
  }, function (s) {
    var pC = ensureProp(s, 'copy', 'TEXT', 'Get access to exclusive promotions and free of processing fees from only Rp. 300k / month');
    var pA = ensureProp(s, 'cta', 'TEXT', 'Join Swing Pass'), pV = ensureProp(s, 'credits', 'TEXT', '0 credits');
    wireKeys(pu).forEach(function (k) { var p = pu[k]; p.copy.componentPropertyReferences = { characters: pC }; p.cta.componentPropertyReferences = { characters: pA }; p.value.componentPropertyReferences = { characters: pV }; });
    s.description = '<div class="swing_pass_upsell"><div class="swing_pass_upsell__top"><div class="swing_pass_upsell__copy">logo + <p>{copy}</p></div><a class="swing_glass_btn">{cta}</a></div><a class="swing_pass_upsell__row">Swing Credits logo · {credits} ›</a></div>. ' +
      'Radius 16, light-100, elevation-brand-s. Top: gradient-swing-pass, padding 24, gap 32, copy B2 Semibold white. Glass button: glass-fill + 1px glass-line, radius 8, CTA S white. Credits row padding 16, value B3 Semibold.';
  }, { description: 'The Swing Pass upsell on Home, with the member’s Swing Credits underneath.',
    code: ['<div class="swing_pass_upsell"><div class="swing_pass_upsell__top">…<a class="swing_glass_btn">Join Swing Pass</a></div><a class="swing_pass_upsell__row">…</a></div>', '.swing_glass_btn = glass-fill + glass-line'] });
}

async function buildSectionHeadPage(R, notes) {
  var sh = {};
  return buildPartPage(R, notes, 'SectionHead', async function (comp, K) {
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'MAX'; comp.primaryAxisAlignItems = 'SPACE_BETWEEN';
    comp.resize(342, 60); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--space-16', 16); comp.fills = [];
    var t = await K.txt(comp, '--type-h5', '--dark-500', 'Explore golf\ncourses near you', 'title', 'fill');
    K.tertiary(comp, 'See all');
    sh[comp.name] = t;
  }, function (s) {
    var pT = ensureProp(s, 'title', 'TEXT', 'Explore golf\ncourses near you');
    wireKeys(sh).forEach(function (k) { sh[k].componentPropertyReferences = { characters: pT }; });
    s.description = '<div class="swing_section_head"><h2 class="swing_promo_banner__title">{title}</h2><a class="swing_btn swing_btn_s swing_btn_tertiary">See all ›</a></div>. Title H5 dark-500, Button S tertiary on the right, bottom aligned, gap 16.';
  }, { description: 'A section title with a See all button, above a rail.',
    code: ['<div class="swing_section_head"><h2 class="swing_promo_banner__title">Explore golf<br>courses near you</h2><a class="swing_btn swing_btn_s swing_btn_tertiary" href="#">See all …</a></div>'] });
}

async function buildProductCardPage(R, notes) {
  var pc = {};
  // size=regular = .product-card--regular (Home rails, 242); size=l = + .product-card--l (Tee time list, full width): bigger type, chips 20, gaps 16 / 8
  var V = [{ size: 'regular', name: 'size=regular', legacy: 'type=default' }, { size: 'l', name: 'size=l' }];
  return buildPartPage(R, notes, 'ProductCard', async function (comp, K, pg, v) {
    var L = v && v.size === 'l', W = L ? 342 : 242, ic = L ? 12 : 10, chipType = L ? '--type-b3s' : '--type-b4s';
    function chip(parent, name, bg) { var c = K.chip(parent, name, bg); if (L) { c.resize(60, 20); c.layoutSizingHorizontal = 'HUG'; c.layoutSizingVertical = 'FIXED'; bindNumber(R, c, 'paddingLeft', '--space-8', 8); bindNumber(R, c, 'paddingRight', '--space-8', 8); bindRadius(R, c, '--radius-16', 16); } return c; }
    comp.layoutMode = 'VERTICAL'; comp.resize(W, 300); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', L ? '--space-16' : '--space-8', L ? 16 : 8); comp.fills = [];
    var media = autoFrame('media', 'VERTICAL', comp); fillHug(media); media.clipsContent = true; bindRadius(R, media, '--radius-16', 16);
    var ph = figma.createRectangle(); media.appendChild(ph); ph.name = 'photo'; ph.resize(W, 160); ph.layoutSizingHorizontal = 'FILL';
    await refPhoto(R, ph, 'ref/img/h5/gc-1.jpg?v=1', notes);
    var chips = autoFrame('chips', 'VERTICAL', media); hugHug(chips); if (L) bindNumber(R, chips, 'itemSpacing', '--space-4', 4); else chips.itemSpacing = 2;   // ADS: chips 2 apart (l: 4)
    chips.layoutPositioning = 'ABSOLUTE'; chips.x = 8; chips.y = 8;
    var c1 = chip(chips, 'promo', '--green-50'); await refArt(R, c1, 'ref/img/h5/tag-promo.svg?v=1', ic, ic, 'icon', notes);
    var c1t = await K.txt(c1, chipType, '--green-500', '10% Off + 1 other promo', 'text');
    var c2 = chip(chips, 'cashback', '--light-300'); await refArt(R, c2, 'ref/img/h5/credits-10.svg?v=1', ic, ic, 'icon', notes);
    var c2t = await K.txt(c2, chipType, '--dark-300', 'Up to 2% cashback', 'text');
    var up = autoFrame('upsell', 'HORIZONTAL', media); fillHug(up); up.counterAxisAlignItems = 'CENTER';
    bindNumber(R, up, 'itemSpacing', L ? '--space-8' : '--space-4', L ? 8 : 4);
    bindNumber(R, up, 'paddingLeft', '--space-16', 16); bindNumber(R, up, 'paddingRight', '--space-16', 16);
    bindNumber(R, up, 'paddingTop', '--space-8', 8); bindNumber(R, up, 'paddingBottom', '--space-8', 8);
    await fillStyle(R, up, '--gradient-swing-pass', '--purple-500');
    await refArt(R, up, 'ref/img/h5/pass-10.svg?v=1', ic, ic, 'pass', notes);
    var upt = await K.txt(up, chipType, '--light-100', 'Save up to 50% with Swing Pass', 'text', 'fill');
    await refArt(R, up, 'ref/img/h5/chev-w-10.svg?v=1', ic, ic, 'chevron', notes);
    var body = autoFrame('body', 'VERTICAL', comp); fillHug(body); bindNumber(R, body, 'itemSpacing', L ? '--space-8' : '--space-4', L ? 8 : 4);
    var tt = await K.txt(body, L ? '--type-h5' : '--type-h6', '--dark-500', 'Suvarna Jakarta Golf Club', 'title', 'fill'); if (!L) { tt.textTruncation = 'ENDING'; tt.maxLines = 1; }
    var price = autoFrame('price', 'VERTICAL', body); fillHug(price); if (L) price.itemSpacing = 2;
    var from = autoFrame('from', 'HORIZONTAL', price); hugHug(from); from.itemSpacing = 3;   // one space
    await K.txt(from, L ? '--type-b3s' : '--type-b4s', '--dark-200', 'Starting from', 'label');
    var was = await K.txt(from, L ? '--type-b3s' : '--type-b4s', '--dark-200', 'Rp. 1,580,000', 'was'); was.textDecoration = 'STRIKETHROUGH';
    var best = autoFrame('best', 'HORIZONTAL', price); hugHug(best); best.counterAxisAlignItems = 'CENTER'; bindNumber(R, best, 'itemSpacing', '--space-8', 8);
    var bt = await K.txt(best, L ? '--type-b1s' : '--type-b2s', '--green-500', 'Rp. 1,422,000 / pax', 'text');
    var sv = chip(best, 'save', '--green-500'); bindNumber(R, sv, 'paddingLeft', '--space-8', 8); bindNumber(R, sv, 'paddingRight', '--space-8', 8); pillRadius(sv, L ? 20 : 16);
    await refArt(R, sv, 'ref/img/h5/tag-save.svg?v=1', ic, ic, 'icon', notes);
    var svt = await K.txt(sv, chipType, '--light-100', 'Save 10%', 'text');
    var loc = autoFrame('loc', 'HORIZONTAL', body); hugHug(loc); loc.counterAxisAlignItems = 'CENTER';
    bindNumber(R, loc, 'itemSpacing', '--space-4', 4); if (!L) bindNumber(R, loc, 'paddingTop', '--space-4', 4);
    await refArt(R, loc, 'ref/img/h5/gps-10.svg?v=1', ic, ic, 'icon', notes);
    var lt = await K.txt(loc, L ? '--type-b3s' : '--type-b4s', '--dark-300', 'Jakarta Timur, Indonesia · 54km away', 'text');
    pc[comp.name] = { promo: c1t, cash: c2t, up: up, upt: upt, title: tt, was: was, best: bt, save: svt, loc: lt };
  }, function (s) {
    var P = { title: ensureProp(s, 'title', 'TEXT', 'Suvarna Jakarta Golf Club'), was: ensureProp(s, 'was', 'TEXT', 'Rp. 1,580,000'),
      best: ensureProp(s, 'price', 'TEXT', 'Rp. 1,422,000 / pax'), save: ensureProp(s, 'save', 'TEXT', 'Save 10%'),
      loc: ensureProp(s, 'location', 'TEXT', 'Jakarta Timur, Indonesia · 54km away'), promo: ensureProp(s, 'promo', 'TEXT', '10% Off + 1 other promo'),
      cash: ensureProp(s, 'cashback', 'TEXT', 'Up to 2% cashback'), upt: ensureProp(s, 'upsell', 'TEXT', 'Save up to 50% with Swing Pass'),
      showUp: ensureProp(s, 'showUpsell', 'BOOLEAN', true) };
    wireKeys(pc).forEach(function (k) {
      var p = pc[k];
      ['title', 'was', 'best', 'save', 'loc', 'promo', 'cash', 'upt'].forEach(function (f) { p[f].componentPropertyReferences = { characters: P[f] }; });
      p.up.componentPropertyReferences = { visible: P.showUp };
    });
    s.description = '<a class="swing_product_card swing_product_card_regular"><span class="swing_product_card__media">photo 160 · chips · upsell strip</span><span class="swing_product_card__body">title · from <s>was</s> · best + save chip · location</span></a>. ' +
      '242 wide in .swing_product_rail (gap 12, bleeds to the screen edge). Media radius 16; chips top-left 8, 2 apart (promo green-50/green-500, cashback light-300/dark-300); upsell gradient-swing-pass, B4 Semibold white. Title H6 one line, from B4s dark-200 struck, best B2s green-500 + pill save chip green-500, location B4s dark-300.';
  }, { variants: V,  description: 'A golf course or driving range for a Regular user: photo with promo chips and the Swing Pass strip, then name, price and distance.',
    code: ['<a class="swing_product_card swing_product_card_regular" href="#"><span class="swing_product_card__media">…</span><span class="swing_product_card__body">…</span></a>', 'in .swing_product_rail · 242 wide'] });
}

async function buildPromoBannerPage(R, notes) {
  var pb = {};
  return buildPartPage(R, notes, 'PromoBanner', async function (comp, K) {
    comp.layoutMode = 'VERTICAL'; comp.resize(342, 340); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--space-16', 16); comp.fills = [];
    var t = await K.txt(comp, '--type-h5', '--dark-500', 'Get 100,000 Swing Credits when you refer a friend to join Swing!', 'title', 'fill');
    var art = autoFrame('art', 'HORIZONTAL', comp); art.layoutMode = 'NONE'; art.resize(342, 228); art.layoutSizingHorizontal = 'FILL';
    art.clipsContent = true; bindRadius(R, art, '--radius-16', 16);
    var a = await refArt(R, art, 'ref/img/referral-illo.svg?v=2', 342, 0, 'illustration', notes);
    a.x = 0; a.y = (228 - a.height) / 2; a.constraints = { horizontal: 'STRETCH', vertical: 'CENTER' };
    var foot = autoFrame('foot', 'HORIZONTAL', comp); fillHug(foot);
    foot.counterAxisAlignItems = 'CENTER'; foot.primaryAxisAlignItems = 'SPACE_BETWEEN'; bindNumber(R, foot, 'itemSpacing', '--space-8', 8);
    var st = autoFrame('stat', 'HORIZONTAL', foot); hugHug(st); st.counterAxisAlignItems = 'CENTER'; bindNumber(R, st, 'itemSpacing', '--space-8', 8);
    await refArt(R, st, 'ds/brand/swing-credits-icon.svg', 20, 20, 'icon', notes);
    var tx = autoFrame('text', 'VERTICAL', st); hugHug(tx);
    var lb = await K.txt(tx, '--type-b3s', '--dark-500', 'No referrals yet', 'label');
    var sb = await K.txt(tx, '--type-b4s', '--dark-200', '0 Swing Credits earned', 'sub');
    K.tertiary(foot, 'Refer a friend');
    pb[comp.name] = { t: t, lb: lb, sb: sb };
  }, function (s) {
    var pT = ensureProp(s, 'title', 'TEXT', 'Get 100,000 Swing Credits when you refer a friend to join Swing!');
    var pL = ensureProp(s, 'label', 'TEXT', 'No referrals yet'), pS = ensureProp(s, 'sub', 'TEXT', '0 Swing Credits earned');
    wireKeys(pb).forEach(function (k) { var p = pb[k]; p.t.componentPropertyReferences = { characters: pT }; p.lb.componentPropertyReferences = { characters: pL }; p.sb.componentPropertyReferences = { characters: pS }; });
    s.description = '<section class="swing_promo_banner"><h2 class="swing_promo_banner__title">{title}</h2><img class="swing_promo_banner__art"><div class="swing_promo_banner__foot"><div class="swing_promo_banner__stat">icon · {label} / {sub}</div><a class="swing_btn swing_btn_s swing_btn_tertiary">…</a></div></section>. Gap 16, title H5, art 3:2 radius 16, label B3s dark-500, sub B4s dark-200.';
  }, { description: 'The referral banner on Home and Account: title, illustration, what the member earned and an action.',
    code: ['<section class="swing_promo_banner"><h2 class="swing_promo_banner__title">…</h2><img class="swing_promo_banner__art" src="…" alt=""><div class="swing_promo_banner__foot">…</div></section>'] });
}

async function buildHelpCardPage(R, notes) {
  var hc = {};
  return buildPartPage(R, notes, 'HelpCard', async function (comp, K) {
    comp.resize(342, 218); comp.clipsContent = true; bindRadius(R, comp, '--radius-16', 16);
    await fillStyle(R, comp, '--gradient-help-card', '--purple-50');
    var a = await refArt(R, comp, 'ref/img/h5/cc-art.svg?v=1', 311, 216, 'art', notes); a.x = 188; a.y = 16;
    var col = autoFrame('content', 'VERTICAL', comp); hugHug(col); col.x = 0; col.y = 0;
    ['paddingLeft', 'paddingRight', 'paddingTop'].forEach(function (f) { bindNumber(R, col, f, '--space-16', 16); });
    bindNumber(R, col, 'itemSpacing', '--space-16', 16);
    var t = await K.txt(col, '--type-h6', '--dark-500', 'Need help with anything else?\nConnect with our call center', 'title');
    var list = autoFrame('list', 'VERTICAL', col); hugHug(list); bindNumber(R, list, 'itemSpacing', '--space-4', 4);
    for (var it of ['Book manually', 'Organize an event', 'Partnerships & collaborations', 'Other special requests']) {
      var li = autoFrame('item', 'HORIZONTAL', list); hugHug(li); li.counterAxisAlignItems = 'CENTER'; bindNumber(R, li, 'itemSpacing', '--space-8', 8);
      await refArt(R, li, 'ref/img/h5/cc-dot.svg?v=1', 12, 12, 'dot', notes);
      await K.txt(li, '--type-b3', '--dark-500', it, 'text');
    }
    var b = K.tertiary(comp, 'Go to call center'); b.x = 16; b.y = 218 - 16 - b.height;
    b.constraints = { horizontal: 'MIN', vertical: 'MAX' };
    hc[comp.name] = { t: t };
  }, function (s) {
    var pT = ensureProp(s, 'title', 'TEXT', 'Need help with anything else?\nConnect with our call center');
    wireKeys(hc).forEach(function (k) { hc[k].t.componentPropertyReferences = { characters: pT }; });
    s.description = '<section class="swing_help_card"><img class="swing_help_card__art"><h2 class="swing_help_card__title">{title}</h2><ul class="swing_help_card__list">…</ul><a class="swing_btn swing_btn_s swing_btn_tertiary">…</a></section>. 218 tall, radius 16, gradient-help-card, agent art at 188/16 (311 x 216, cropped), title H6, list B3 with 12 dots, button bottom-left 16.';
  }, { description: 'The call center card: what support can help with, and a button to reach it.',
    code: ['<section class="swing_help_card"><img class="swing_help_card__art" src="…" alt=""><h2 class="swing_help_card__title">…</h2><ul class="swing_help_card__list">…</ul><a class="swing_btn swing_btn_s swing_btn_tertiary">…</a></section>'] });
}

async function buildFeaturedPromoPage(R, notes) {
  // components.css .featured-promo (Figma Swing Web App 6131:52581, Ghais 11 Nov)
  var fp = {}, btnSet = await setFrom('Button', 'Button', buildButton, R, notes);
  var solidS = byName(btnSet)['size=s, tone=primary, appearance=solid, state=default'];
  var tick = null;
  // the first build (11 Nov) had one variant "type=default": rename it so placed instances stay linked
  var oldPage = figma.root.children.filter(function (p) { return p.name === 'FeaturedPromo'; })[0];
  if (oldPage) {
    await oldPage.loadAsync();
    var oldSet = oldPage.findOne(function (n) { return isUiSet(n, 'FeaturedPromo'); });
    var oldV = oldSet && oldSet.children.filter(function (c) { return c.name === 'type=default'; })[0];
    if (oldV && !oldSet.children.some(function (c) { return c.name === 'state=default'; })) oldV.name = 'state=default';
  }
  return buildPartPage(R, notes, 'FeaturedPromo', async function (comp, K, page, v) {
    var claimed = v && v.name === 'state=claimed';
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(343, 80); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    comp.itemSpacing = 0; comp.clipsContent = true;
    bindRadius(R, comp, '--radius-12', 12);
    comp.fills = paintFor(R, '--light-100');
    comp.strokes = paintFor(R, '--purple-500'); comp.strokeWeight = 1; comp.strokeAlign = 'INSIDE';
    var strip = autoFrame('pass strip', 'HORIZONTAL', comp); strip.counterAxisAlignItems = 'CENTER';
    strip.layoutSizingHorizontal = 'HUG'; strip.layoutAlign = 'STRETCH';
    bindNumber(R, strip, 'paddingLeft', '--space-8', 8); bindNumber(R, strip, 'paddingRight', '--space-8', 8);
    await fillStyle(R, strip, '--gradient-swing-pass', '--purple-500');
    await refArt(R, strip, 'ref/img/fp/pass-mark-w.svg?v=1', 20, 20, 'pass mark', notes);
    var body = autoFrame('body', 'HORIZONTAL', comp); fillHug(body); body.counterAxisAlignItems = 'MAX';
    ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'].forEach(function (f) { bindNumber(R, body, f, '--space-16', 16); });
    bindNumber(R, body, 'itemSpacing', '--space-16', 16);
    var tx = autoFrame('text', 'VERTICAL', body); fillHug(tx); bindNumber(R, tx, 'itemSpacing', '--space-4', 4);
    var t = await K.txt(tx, '--type-b2s', '--dark-500', 'Rp 999,000 · Sun & PH PM Deal at Suvarna Jakarta Golf Club', 'title', 'fill');
    try { t.textTruncation = 'ENDING'; t.maxLines = 2; } catch (e) { /* older API */ }
    var g = await K.txt(tx, '--type-b3s', '--purple-500', 'Swing Pass Exclusive', 'tag');
    var st = null;
    if (claimed) {   // .featured-promo__status: Button S size, Light 300, CTA S Dark 300, green tick 16
      if (!tick) tick = (await findIcon('Icon/Solid/tick-circle')) || (await iconOrPlaceholder('Icon/Line/tick-circle', page, notes));
      var sf = autoFrame('status', 'HORIZONTAL', body); sf.counterAxisAlignItems = 'CENTER';
      sf.resize(80, 32); sf.layoutSizingHorizontal = 'HUG'; sf.layoutSizingVertical = 'FIXED';
      bindNumber(R, sf, 'paddingLeft', '--space-12', 12); bindNumber(R, sf, 'paddingRight', '--space-12', 12);
      bindNumber(R, sf, 'itemSpacing', '--space-4', 4); bindRadius(R, sf, '--radius-8', 8);
      sf.fills = paintFor(R, '--light-300');
      var ic = tick.createInstance(); sf.appendChild(ic); ic.name = 'tick'; ic.resize(16, 16); recolorIcon(R, ic, '--green-500');
      st = await K.txt(sf, '--type-cta-s', '--dark-300', 'Active', 'status');
    } else {
      var b = solidS.createInstance(); body.appendChild(b); b.name = 'button';
      setText(b, { label: 'Join', showIconEnd: true, iconEnd: K.I.chev.id });
      // white chevron, bound to the token (setText's copy is unbound)
      b.findAll(function (n) { return n.type === 'INSTANCE' && !!n.findOne(function (k) { return k.name === 'Icon'; }); }).forEach(function (ic) { recolorIcon(R, ic, '--light-100'); });
    }
    fp[comp.name] = { t: t, g: g, st: st };
  }, function (s) {
    var pT = ensureProp(s, 'title', 'TEXT', 'Rp 999,000 · Sun & PH PM Deal at Suvarna Jakarta Golf Club');
    var pG = ensureProp(s, 'tag', 'TEXT', 'Swing Pass Exclusive');
    var pS = ensureProp(s, 'status', 'TEXT', 'Active');
    wireKeys(fp).forEach(function (k) {
      fp[k].t.componentPropertyReferences = { characters: pT }; fp[k].g.componentPropertyReferences = { characters: pG };
      if (fp[k].st) fp[k].st.componentPropertyReferences = { characters: pS };
    });
    s.description = '<a class="swing_featured_promo"><span class="swing_featured_promo__mark"></span><span class="swing_featured_promo__body"><span class="swing_featured_promo__text"><span class="swing_featured_promo__title">{title}</span><span class="swing_featured_promo__tag">{tag}</span></span><span class="swing_btn swing_btn_s">Join + chevron-right</span></span></a>. ' +
      'Purple 500 line 1, radius 12; strip padding 0 8 on gradient-swing-pass with the white pass mark 20; body padding 16, gap 16, button on the bottom line; title B2 Semibold 2 lines, tag B3 Semibold Purple 500. ' +
      'state=claimed: <span class="swing_featured_promo__status">{status}</span> in the button\'s place, 32 tall, padding 0 12, gap 4, radius 8, Light 300, CTA S Dark 300, green tick 16.';
  }, { variants: [{ name: 'state=default' }, { name: 'state=claimed' }], colLabel: 'state',
    description: 'One deal that only Swing Pass members get. The whole card is the link; the Join button inside only marks it. Source: Figma Swing Web App 6131:52581.',
    code: ['<a class="swing_featured_promo" href="…"><span class="swing_featured_promo__mark" aria-hidden="true"></span><span class="swing_featured_promo__body"><span class="swing_featured_promo__text"><span class="swing_featured_promo__title">…</span><span class="swing_featured_promo__tag">Swing Pass Exclusive</span></span><span class="swing_btn swing_btn_s">Join<i class="swing_icon">…chevron-right…</i></span></span></a>', 'state=claimed: <span class="swing_featured_promo__status">Active</span> instead of the button'] });
}

async function buildCashbackTablePage(R, notes) {
  // components.css .cashback-table (Figma Swing Web App 271:7933 "Cashback details", Ghais 11 Nov)
  var ct = {}, W = 343;
  var ROWS = [['Mon - Fri', '05:00 - 12:00', '10%', '50%'], ['Mon - Fri', '12:00 - 20:00', '8%', '40%'], ['Sat - Sun', '05:00 - 20:00', '8%', '40%']];
  function lineUnder(f, on) {   // border-bottom 1px light-500
    f.strokes = paintFor(R, '--light-500'); f.strokeAlign = 'INSIDE';
    f.strokeTopWeight = 0; f.strokeLeftWeight = 0; f.strokeRightWeight = 0; f.strokeBottomWeight = on ? 1 : 0;
  }
  // every column is exactly a third: FILL let Figma give a header cell a different width than the cells under it (Ghais 11 Nov)
  function cell(parent, name, dir) {
    var c = autoFrame(name, dir || 'VERTICAL', parent); c.resize(W / 3, 40); c.layoutSizingHorizontal = 'FIXED'; c.layoutSizingVertical = 'FILL';
    return c;
  }
  return buildPartPage(R, notes, 'CashbackTable', async function (comp, K, page, v) {
    var here = v && v.name === 'current=pass' ? 2 : 1;
    comp.layoutMode = 'VERTICAL'; comp.resize(W, 300); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    comp.itemSpacing = 0; comp.fills = paintFor(R, '--light-100');
    // "You are here" over the current plan
    var hr = autoFrame('here', 'HORIZONTAL', comp); fillHug(hr); hr.counterAxisAlignItems = 'MAX';
    var hereText = null;
    for (var i = 0; i < 3; i++) {
      var slot = autoFrame('slot ' + (i + 1), 'VERTICAL', hr); slot.resize(W / 3, 1); slot.layoutSizingHorizontal = 'FIXED'; slot.layoutSizingVertical = 'HUG';
      if (i !== here) continue;
      var tab = autoFrame('you are here', 'VERTICAL', slot); fillHug(tab); tab.counterAxisAlignItems = 'CENTER';
      bindNumber(R, tab, 'paddingTop', '--space-8', 8); bindNumber(R, tab, 'paddingBottom', '--space-8', 8);
      bindNumber(R, tab, 'paddingLeft', '--space-12', 12); bindNumber(R, tab, 'paddingRight', '--space-12', 12);
      bindNumber(R, tab, 'topLeftRadius', '--radius-8', 8); bindNumber(R, tab, 'topRightRadius', '--radius-8', 8);
      tab.fills = paintFor(R, '--green-500');
      hereText = await K.txt(tab, '--type-b2s', '--light-100', 'You are here', 'label', 'fill'); hereText.textAlignHorizontal = 'CENTER';
    }
    // the table: header + rows, with the Swing Pass outline on top
    var tb = autoFrame('table', 'VERTICAL', comp); fillHug(tb); tb.itemSpacing = 0;
    var head = autoFrame('plans', 'HORIZONTAL', tb); fillHug(head);
    cell(head, 'corner');
    var plans = [['Regular Swing players', '--light-200', 'ref/img/cbt/albatross-mark.svg?v=1'], ['Swing Pass members', '--purple-50', 'ref/img/cbt/pass-mark.svg?v=1']];
    for (var p = 0; p < 2; p++) {
      var pc = cell(head, p ? 'swing pass' : 'regular'); pc.counterAxisAlignItems = 'CENTER'; pc.primaryAxisAlignItems = 'CENTER';
      bindNumber(R, pc, 'paddingTop', '--space-16', 16); bindNumber(R, pc, 'paddingBottom', '--space-16', 16);
      bindNumber(R, pc, 'paddingLeft', '--space-12', 12); bindNumber(R, pc, 'paddingRight', '--space-12', 12);
      bindNumber(R, pc, 'itemSpacing', '--space-8', 8);
      pc.fills = paintFor(R, plans[p][1]); lineUnder(pc, true);
      if (p) bindNumber(R, pc, 'topRightRadius', '--radius-16', 16);
      var mk = await refArt(R, pc, plans[p][2], 32, 32, 'mark', notes);
      if (p) { for (var vec of mk.findAll ? mk.findAll(function (n) { return n.type === 'VECTOR'; }) : []) await fillStyle(R, vec, '--gradient-swing-pass', '--purple-500'); }
      else refTint(R, mk, '--dark-300');
      var pl = await K.txt(pc, '--type-b2s', '--dark-500', plans[p][0], 'label', 'fill'); pl.textAlignHorizontal = 'CENTER';
    }
    for (var r = 0; r < ROWS.length; r++) {
      var last = r === ROWS.length - 1, row = autoFrame('row ' + (r + 1), 'HORIZONTAL', tb); fillHug(row);
      var lc = cell(row, 'slot'); lc.primaryAxisAlignItems = 'CENTER'; lineUnder(lc, true);
      bindNumber(R, lc, 'paddingTop', '--space-16', 16); bindNumber(R, lc, 'paddingBottom', '--space-16', 16);
      bindNumber(R, lc, 'paddingLeft', '--space-16', 16); bindNumber(R, lc, 'paddingRight', '--space-8', 8);
      bindNumber(R, lc, 'itemSpacing', '--space-4', 4);
      await K.txt(lc, '--type-b1s', '--dark-500', ROWS[r][0], 'day', 'fill');
      await K.txt(lc, '--type-b2', '--dark-300', ROWS[r][1], 'time', 'fill');
      for (var q = 0; q < 2; q++) {
        var vc = cell(row, q ? 'swing pass' : 'regular'); vc.counterAxisAlignItems = 'CENTER'; vc.primaryAxisAlignItems = 'CENTER';
        bindNumber(R, vc, 'paddingTop', '--space-16', 16); bindNumber(R, vc, 'paddingBottom', '--space-16', 16);
        bindNumber(R, vc, 'paddingLeft', '--space-12', 12); bindNumber(R, vc, 'paddingRight', '--space-12', 12);
        vc.fills = paintFor(R, q ? '--purple-50' : '--light-200'); lineUnder(vc, !(q && last));
        if (q && last) bindNumber(R, vc, 'bottomRightRadius', '--radius-16', 16);
        var val = await K.txt(vc, '--type-h5', q ? '--dark-500' : '--dark-300', ROWS[r][q ? 3 : 2], 'value', 'fill'); val.textAlignHorizontal = 'CENTER';
        var un = await K.txt(vc, '--type-b2', '--dark-300', 'cashback', 'unit', 'fill'); un.textAlignHorizontal = 'CENTER';
      }
    }
    var ol = figma.createRectangle(); tb.appendChild(ol); ol.name = 'swing pass outline';
    ol.layoutPositioning = 'ABSOLUTE'; ol.resize(W / 3, tb.height); ol.x = W - W / 3; ol.y = 0;
    ol.constraints = { horizontal: 'MAX', vertical: 'STRETCH' };
    ol.fills = []; ol.strokes = paintFor(R, '--purple-500'); ol.strokeWeight = 2; ol.strokeAlign = 'INSIDE';
    bindNumber(R, ol, 'topRightRadius', '--radius-16', 16); bindNumber(R, ol, 'bottomRightRadius', '--radius-16', 16);
    ct[comp.name] = { here: hereText };
  }, function (s) {
    var pH = ensureProp(s, 'here', 'TEXT', 'You are here');
    wireKeys(ct).forEach(function (k) { if (ct[k].here) ct[k].here.componentPropertyReferences = { characters: pH }; });
    s.description = '<table class="swing_cashback_table">: "You are here" tab (Green 500, radius 8 top, B2 Semibold white, padding 8 12) over the current plan; ' +
      'plan headers mark 32 + B2 Semibold, padding 16 12, gap 8 (Regular Light 200, Swing Pass Purple 50 radius 16 top right); ' +
      'rows: slot B1 Semibold + B2 Dark 300, padding 16 8 16 16; values H5 + "cashback" B2, padding 16 12; Light 500 line under every row; ' +
      '2px Purple 500 outline round the Swing Pass column, radius 16 on the right. current=regular / current=pass moves the tab. Three equal columns, 343 wide here.';
  }, { variants: [{ name: 'current=regular' }, { name: 'current=pass' }], colLabel: 'current',
    description: 'Cashback a regular player and a Swing Pass member get, per time slot. Source: Figma Swing Web App 271:7933.',
    code: ['<table class="swing_cashback_table"><thead><tr class="swing_cashback_table__here"><td></td><td><span class="swing_cashback_table__you">You are here</span></td><td></td></tr><tr><td></td><th class="swing_cashback_table__plan">…Regular Swing players</th><th class="swing_cashback_table__plan swing_cashback_table__pass">…Swing Pass members</th></tr></thead><tbody><tr><th scope="row">…day + time…</th><td>…10% cashback…</td><td class="swing_cashback_table__pass">…50% cashback…</td></tr></tbody></table>'] });
}

async function buildLinkCardPage(R, notes) {
  var lc = {}, info = null;
  return buildPartPage(R, notes, 'LinkCard', async function (comp, K) {
    info = K.I.info;
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(242, 72); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--space-12', 12);
    bindNumber(R, comp, 'paddingLeft', '--space-16', 16); bindNumber(R, comp, 'paddingRight', '--space-16', 16);
    bindNumber(R, comp, 'paddingTop', '--space-12', 12); bindNumber(R, comp, 'paddingBottom', '--space-12', 12);
    bindRadius(R, comp, '--radius-16', 16); comp.fills = paintFor(R, '--light-200');
    var ic = info.createInstance(); comp.appendChild(ic); ic.name = 'icon'; ic.resize(24, 24); recolorIcon(R, ic, '--dark-500');
    var tx = autoFrame('text', 'VERTICAL', comp); fillHug(tx);
    var t = await K.txt(tx, '--type-b2s', '--dark-500', 'What’s new', 'title', 'fill');
    var b = await K.txt(tx, '--type-b3', '--dark-300', 'See what we’ve included on version 5.0', 'body', 'fill');
    var ch = K.I.chev.createInstance(); comp.appendChild(ch); ch.name = 'chevron'; ch.resize(24, 24); recolorIcon(R, ch, '--dark-500');
    lc[comp.name] = { ic: ic, t: t, b: b };
  }, function (s) {
    var pT = ensureProp(s, 'title', 'TEXT', 'What’s new'), pB = ensureProp(s, 'body', 'TEXT', 'See what we’ve included on version 5.0');
    var pI = ensureProp(s, 'icon', 'INSTANCE_SWAP', info.id);
    wireKeys(lc).forEach(function (k) { var p = lc[k]; p.t.componentPropertyReferences = { characters: pT }; p.b.componentPropertyReferences = { characters: pB }; p.ic.componentPropertyReferences = { mainComponent: pI }; });
    s.description = '<a class="swing_link_card"><i class="swing_icon swing_link_card__icon"></i><span class="swing_link_card__text"><span class="swing_link_card__title">{title}</span><span class="swing_link_card__body">{body}</span></span><i class="swing_icon swing_link_card__chev"></i></a>. 242 wide in a .swing_link_rail column (gap 8, columns 12 apart). Padding 12 16, radius 16, light-200, icon 24, title B2 Semibold, body B3 dark-300.';
  }, { description: 'A link with an icon, title and one line of help. Two columns of three scroll sideways at the bottom of Home.',
    code: ['<section class="swing_link_rail"><div class="swing_link_rail__col"><a class="swing_link_card" href="#">…</a>…</div>…</section>'] });
}

/* ----- Screen: Home (ref/home.html) — only instances of DS parts, plus the screen's own photos and art ----- */
// The right-hand list every screen gets: one row per part, top to bottom. A UI component sits in its row
// as the main component itself; base DS parts are instances. fill(row) adds the rows, row(title, meta, nodes).
async function screenList(R, page, scr, screenName, fill) {
  var list = page.findChild(function (n) { return n.type === 'FRAME' && n.name === 'Components on this screen'; });
  if (!list) { list = figma.createFrame(); page.appendChild(list); list.name = 'Components on this screen'; }
  list.findAll(function (n) { return n.type === 'COMPONENT_SET' || (n.type === 'COMPONENT' && !(n.parent && n.parent.type === 'COMPONENT_SET')); }).forEach(function (n) { page.appendChild(n); });   // never delete a component with the rows; a variant stays in its set
  list.children.slice().forEach(function (c) { c.remove(); });
  list.layoutMode = 'VERTICAL'; hugHug(list); list.x = scr.x + 390 + 160; list.y = scr.y;
  ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'].forEach(function (f) { bindNumber(R, list, f, '--space-40', 40); });
  bindNumber(R, list, 'itemSpacing', '--space-48', 48);
  list.fills = paintFor(R, '--color-bg-subtle');
  var hd = autoFrame('header', 'VERTICAL', list); hugHug(hd); bindNumber(R, hd, 'itemSpacing', '--space-8', 8);
  var h1 = await styledText(R, '--type-h3', '--color-text', 'Components on this screen'); hd.appendChild(h1); h1.name = 'title'; h1.textAutoResize = 'WIDTH_AND_HEIGHT';
  var hdd = await styledText(R, '--type-b2', '--color-text-secondary', 'Top to bottom, in the order they appear on ' + screenName + '. UI components are the main components themselves, kept in this list; ' + (LIB ? 'Button, AppBar, BottomNav, list items, dots and icons are instances from the ' + LIB.file + ' library' : 'Button, AppBar, BottomNav, list items, dots and icons are instances of their DS pages') + '. A change to either updates this screen. Photos and art are the screen’s own.');
  hd.appendChild(hdd); hdd.name = 'description'; hdd.textAutoResize = 'HEIGHT'; hdd.resize(560, hdd.height);
  async function row(title, meta, nodes) {
    var r = autoFrame(title + ' · row', 'VERTICAL', list); hugHug(r); bindNumber(R, r, 'itemSpacing', '--space-12', 12);
    var h = autoFrame(title + ' · label', 'VERTICAL', r); hugHug(h); h.itemSpacing = 2;
    var a = await styledText(R, '--type-h5', '--color-text', title); h.appendChild(a); a.name = 'name'; a.textAutoResize = 'WIDTH_AND_HEIGHT';
    var m = await styledText(R, '--type-b2', '--color-text-secondary', meta); h.appendChild(m); m.name = 'meta'; m.textAutoResize = 'HEIGHT'; m.resize(560, m.height);
    if (nodes.length === 1) { r.appendChild(nodes[0]); return; }   // one component or instance: straight in the row, no wrapper
    var g = autoFrame(title + ' · examples', 'HORIZONTAL', r); hugHug(g); g.counterAxisAlignItems = 'CENTER'; bindNumber(R, g, 'itemSpacing', '--space-24', 24);
    nodes.forEach(function (n) { g.appendChild(n); });
  }
  await fill(row);
  await nameInstances([scr, list]);
  return list;
}
// Instances take their main component's variant name ("type=default", "items=3"), which nobody can search
// for. Name each one after its component (ProductCard, BottomNav), with the variant when it says something.
// dynamic-page documentAccess: instance.mainComponent is not readable, getMainComponentAsync() is.
async function nameInstances(roots) {
  for (var ri = 0; ri < roots.length; ri++) {
    var root = roots[ri];
    var all = root.findAll(function (n) { return n.type === 'INSTANCE'; });
    for (var i = 0; i < all.length; i++) {
      var n = all[i], nested = false;
      for (var p = n.parent; p && p !== root; p = p.parent) if (p.type === 'INSTANCE') { nested = true; break; }   // inside another instance: leave it
      if (nested) continue;
      var mc = await n.getMainComponentAsync(); if (!mc) continue;
      if (n.name !== mc.name && !/^[\w-]+=/.test(n.name)) continue;   // a name someone chose (avatar, edit) stays
      var setName = mc.parent && mc.parent.type === 'COMPONENT_SET' ? mc.parent.name : mc.name;
      var variant = mc.parent && mc.parent.type === 'COMPONENT_SET' && mc.name !== 'type=default' ? mc.name : '';
      // a split set already says its kind (swing_btn_primary): leave tone=primary out of the layer name
      if (variant) variant = variant.split(', ').filter(function (kv) {
        var p = kv.split('=');
        return !(SPLIT_PROPS.indexOf(p[0]) >= 0 && new RegExp('_' + snakeName(p[1]) + '$').test(setName));
      }).join(', ');
      n.name = setName.split('/').pop() + (variant ? ' · ' + variant : '');
    }
  }
}
async function buildHomeScreen(R, notes) {
  var page = await pageNamed('Screen / Home');
  var get = function (pg, name, fn) { return setFrom(pg, name, fn, R, notes); };
  var appBar = await setWith('AppBar', 'AppBar', buildAppBarPage, R, notes, 'type=homeSearch, scrolled=false');
  var navSet = await setWith('BottomNav', 'BottomNav', buildBottomNavPage, R, notes, 'items=3');
  var dotSet = await get('Pagination', 'Dot', buildPaginationPage);
  var btnSet = await get('Button', 'Button', buildButton);
  var P = { tile: await get('PhotoTile', 'PhotoTile', buildPhotoTilePage), pass: await get('PassUpsell', 'PassUpsell', buildPassUpsellPage),
    head: await get('SectionHead', 'SectionHead', buildSectionHeadPage), card: await get('ProductCard', 'ProductCard', buildProductCardPage),
    promo: await get('PromoBanner', 'PromoBanner', buildPromoBannerPage), help: await get('HelpCard', 'HelpCard', buildHelpCardPage),
    link: await get('LinkCard', 'LinkCard', buildLinkCardPage) };
  var DOT = byName(dotSet);
  var LI = {};
  for (var ln of ['info', 'partnership', 'chat-circle', 'stars', 'customer-service']) LI[ln] = await iconOrPlaceholder('Icon/Line/' + ln, page, notes);
  LI.instagram = await refIcon(R, 'instagram', 'ds/logos/social/instagram.svg', 24, '--dark-500', notes, page);
  // the first Home build kept its parts on this page; they moved to their DS pages, HomeBar became AppBar homeSearch
  page.findAll(function (n) { return n.type === 'COMPONENT_SET' && n.name === 'HomeBar'; }).forEach(function (n) { n.remove(); });
  var src = function (pg) { return UI_PARTS[pg] ? 'UI component · main component, here' : LIB ? 'Library · ' + LIB.file + ' · ' + pg : 'DS · ' + pg + ' page'; };

  /* ---------- the screen ---------- */
  var old = page.findChild(function (n) { return n.type === 'FRAME' && n.name === 'Home'; });
  var keepX = old ? old.x : 0, keepY = old ? old.y : 0;
  if (old) old.remove();
  var scr = figma.createFrame(); page.appendChild(scr);
  scr.name = 'Home'; scr.x = keepX; scr.y = keepY;
  scr.layoutMode = 'VERTICAL'; scr.resize(390, 844); scr.layoutSizingHorizontal = 'FIXED'; scr.layoutSizingVertical = 'HUG';
  scr.itemSpacing = 0; scr.clipsContent = true; scr.fills = paintFor(R, '--light-100');
  function put(parent, set) { var m = set.children.filter(function (c) { return c.name === 'size=regular'; })[0] || set.children[0]; var i = m.createInstance(); parent.appendChild(i); return i; }
  var bar = byName(appBar)['type=homeSearch, scrolled=false'].createInstance(); scr.appendChild(bar); bar.layoutSizingHorizontal = 'FILL';
  var main = autoFrame('page', 'VERTICAL', scr); fillHug(main);
  bindNumber(R, main, 'itemSpacing', '--gap-section', 32); bindNumber(R, main, 'paddingTop', '--space-16', 16);
  function section(name, pad) { var s = autoFrame(name, 'VERTICAL', main); fillHug(s); bindNumber(R, s, 'itemSpacing', '--gap-group', 16); if (pad) padX(R, s); return s; }
  function rail(parent, name) {   // .product-rail / .link-rail: page-x padding, bleeds and clips at the screen edge
    var r = autoFrame(name, 'HORIZONTAL', parent); fillHug(r); padX(R, r);
    bindNumber(R, r, 'itemSpacing', '--space-12', 12); r.clipsContent = true;
    return r;
  }
  async function txt(parent, style, color, chars, name) {
    var t = await styledText(R, style, color, chars); parent.appendChild(t); t.name = name; t.textAutoResize = 'HEIGHT'; t.layoutSizingHorizontal = 'FILL'; return t;
  }
  // 1. hero, greeting, tiles, Swing Pass
  var s1 = section('book', true);
  var heroG = autoFrame('hero', 'VERTICAL', s1); fillHug(heroG); heroG.counterAxisAlignItems = 'CENTER'; bindNumber(R, heroG, 'itemSpacing', '--gap-group', 16);
  var hero = figma.createRectangle(); heroG.appendChild(hero); hero.name = 'home-hero'; hero.resize(342, 160); hero.layoutSizingHorizontal = 'FILL';
  bindRadius(R, hero, '--radius-16', 16); await refPhoto(R, hero, 'ref/img/home-hero.jpg?v=2', notes);
  var dots = autoFrame('dots', 'HORIZONTAL', heroG); hugHug(dots); dots.counterAxisAlignItems = 'CENTER'; bindNumber(R, dots, 'itemSpacing', '--gap-related', 8);
  for (var di = 0; di < 9; di++) dots.appendChild(DOT['active=' + (di === 0) + ', onMedia=false'].createInstance());
  await txt(s1, '--type-h3', '--dark-500', 'How would you like to\nswing today, Alvin?', 'greeting');
  var tiles = autoFrame('photo-tiles', 'HORIZONTAL', s1); fillHug(tiles); bindNumber(R, tiles, 'itemSpacing', '--space-12', 12);
  for (var tl of [['Tee time', 'tile-teetime'], ['Driving range', 'tile-range'], ['Events', 'tile-events'], ['Marketplace', 'tile-market']]) {
    var tI = put(tiles, P.tile); tI.layoutSizingHorizontal = 'FILL'; setText(tI, { label: tl[0] });
    var tp = tI.findOne(function (n) { return n.name === 'photo'; }); if (tp) await refPhoto(R, tp, 'ref/img/' + tl[1] + '.jpg?v=2', notes);
  }
  put(s1, P.pass).layoutSizingHorizontal = 'FILL';
  // 2 + 3. product rails
  async function productSection(name, title, cards) {
    var s = section(name, false);
    var head = autoFrame('head', 'VERTICAL', s); fillHug(head); padX(R, head);
    var hI = put(head, P.head); hI.layoutSizingHorizontal = 'FILL'; setText(hI, { title: title });
    var r = rail(s, 'product-rail');
    for (var c of cards) {
      var pI = put(r, P.card); setText(pI, { title: c[1], was: c[2], price: c[3] });
      var pp = pI.findOne(function (n) { return n.name === 'photo'; }); if (pp) await refPhoto(R, pp, 'ref/img/h5/' + c[0] + '.jpg?v=1', notes);
    }
  }
  await productSection('golf', 'Explore golf\ncourses near you', [['gc-1', 'Suvarna Jakarta Golf Club', 'Rp. 1,580,000', 'Rp. 1,422,000 / pax'], ['gc-2', 'Gading Raya Golf Club', 'Rp. 850,000', 'Rp. 765,000 / pax'], ['gc-3', 'Imperial Klub Golf', 'Rp. 988,000', 'Rp. 889,200 / pax']]);
  await productSection('range', 'Explore driving\nranges near you', [['dr-1', 'Albatross Driving Range', 'Rp. 125,000', 'Rp. 112,500 / 100 balls'], ['dr-2', 'Imperial Klub Golf', 'Rp. 175,000', 'Rp. 157,500 / 100 balls'], ['dr-3', 'Topgolf Jakarta', 'Rp. 200,000', 'Rp. 180,000 / 60 mins']]);
  // 4. referral, 5. call center
  put(section('referral', true), P.promo).layoutSizingHorizontal = 'FILL';
  put(section('help', true), P.help);
  // 6. link rail: two columns of three
  var r6 = rail(section('links', false), 'link-rail');
  var LINKS = [[['info', 'What’s new', 'See what we’ve included on version 5.0'], ['instagram', 'Follow us on Instagram', 'Follow to stay updated on promotions and news'], ['partnership', 'Request a golf venue', 'Suggest more places to be added on Swing']],
    [['chat-circle', 'Give us feedback', 'Tell us how we can improve your experience on Swing'], ['stars', 'Leave a rating', 'We’d like to know your honest opinion of us'], ['customer-service', 'Contact Swing support', 'We’re here for you if you need any help']]];
  LINKS.forEach(function (col) {
    var c = autoFrame('col', 'VERTICAL', r6); c.resize(242, 100); c.layoutSizingHorizontal = 'FIXED'; c.layoutSizingVertical = 'HUG'; bindNumber(R, c, 'itemSpacing', '--space-8', 8);
    col.forEach(function (l) { var li = put(c, P.link); li.layoutSizingHorizontal = 'FILL'; setText(li, { title: l[1], body: l[2], icon: LI[l[0]].id }); });
  });
  // 7. footer art, flush on the bottom nav
  await refArt(R, main, 'ref/img/h5/foot-art.svg?v=1', 390, 260, 'home-foot-art', notes);
  var nav = byName(navSet)['items=3'].createInstance(); scr.appendChild(nav); nav.layoutSizingHorizontal = 'FILL';

  /* ---------- Components on this screen ---------- */
  var one = function (set, v) { return (v ? byName(set)[v] : set.children[0]).createInstance(); };
  var asMain = function (set) { return set; };   // a UI component sits in its row as the main component itself
  var list = await screenList(R, page, scr, 'Home', async function (row) {
    await row('AppBar', src('AppBar') + ' · type=homeSearch: menu, search with the country chip, updates bell', [one(appBar, 'type=homeSearch, scrolled=false')]);
    await row('Dot', src('Pagination') + ' · 9 dots under the hero, the first one active', [one(dotSet, 'active=true, onMedia=false'), one(dotSet, 'active=false, onMedia=false')]);
    await row('PhotoTile', src('PhotoTile') + ' · used 4× · Tee time, Driving range, Events, Marketplace', [asMain(P.tile)]);
    await row('PassUpsell', src('PassUpsell') + ' · Swing Pass upsell with the Swing Credits row', [asMain(P.pass)]);
    await row('SectionHead', src('SectionHead') + ' · used 2× · title + See all above each rail', [asMain(P.head)]);
    await row('ProductCard', src('ProductCard') + ' · used 6× · golf courses and driving ranges (Regular user)', [asMain(P.card)]);
    await row('PromoBanner', src('PromoBanner') + ' · referral banner', [asMain(P.promo)]);
    await row('HelpCard', src('HelpCard') + ' · call center card', [asMain(P.help)]);
    await row('LinkCard', src('LinkCard') + ' · used 6× · two columns of three in the link rail', [asMain(P.link)]);
    await row('Button', src('Button') + ' · size=s, tone=primary, appearance=tertiary + chevron-right, inside SectionHead, PromoBanner and HelpCard', [one(btnSet, 'size=s, tone=primary, appearance=tertiary, state=default')]);
    await row('BottomNav', src('BottomNav') + ' · items=3: Home (active), Activity, Account', [one(navSet, 'items=3')]);
  });
  notes.push('Home: built from stat.chara.id/swing/ref/home.html' + (LIB ? ' with the ' + LIB.file + ' library' : '') + '. Differences from the web: rails are clipped at the screen edge instead of scrolling; "Starting from" and the struck price are two text layers; the country chip sits 4 from the search edge (CSS pulls it with a -8 margin).');
  return { set: scr, count: 9, label: 'screen from 9 DS parts' };
}

// Where a part in a screen's list comes from: this page, another screen's page, the library or a DS page.
function partSrc(pg, screenPage) {
  if (UI_PARTS[pg]) return UI_PARTS[pg] === screenPage ? 'UI component · main component, here' : 'UI component · main component on ' + UI_PARTS[pg];
  return LIB ? 'Library · ' + LIB.file + ' · ' + pg : 'DS · ' + pg + ' page';
}

/* ----- ProfileHead (components.css .profile-head, ADS Account): 80 banner photo, Avatar L overlapping
   the bottom edge by 48, edit icon button on the avatar's corner ----- */
async function buildProfileHeadPage(R, notes) {
  var avSet = await setFrom('Avatar', 'Avatar', buildAvatarPage, R, notes);
  var ibSet = await setFrom('Button', 'IconButton', buildButton, R, notes);
  var page = await pageNamed(UI_PARTS.ProfileHead);
  var pencil = await iconOrPlaceholder('Icon/Line/pencil', page, notes);
  return buildPartPage(R, notes, 'ProfileHead', async function (comp) {
    // The avatar and the edit button hang 48 below the 80 banner. Figma clips what leaves a frame (the set,
    // a list row), so the component is 128 high and holds the overhang; the banner is its top 80.
    comp.layoutMode = 'NONE'; comp.resizeWithoutConstraints(390, 128); comp.clipsContent = false;
    comp.fills = [];
    var ban = figma.createRectangle(); comp.appendChild(ban); ban.name = 'banner'; ban.resize(390, 80); ban.x = 0; ban.y = 0;
    ban.constraints = { horizontal: 'STRETCH', vertical: 'MIN' };
    await refPhoto(R, ban, 'ref/img/account-banner.jpg?v=2', notes);
    if ((ban.fills || []).some(function (f) { return f.type === 'IMAGE'; })) ban.fills = paintFor(R, '--purple-100').concat(ban.fills);   // purple-100 under the photo, as on the web
    // .profile-head__avatar: left page-x, bottom -48 -> top 80 + 48 - 96 = 32
    var av = byName(avSet)['size=l, type=initials'].createInstance(); comp.appendChild(av); av.name = 'avatar'; av.x = 24; av.y = 32;
    setText(av, { initials: 'AL' });
    // .profile-head__edit: left page-x + 96 - 32, bottom -48 -> x 88, top 80 + 48 - 32 = 96
    var ed = byName(ibSet)['size=s, tone=neutral, appearance=tertiary, state=default'].createInstance(); comp.appendChild(ed); ed.name = 'edit'; ed.x = 88; ed.y = 96;
    setText(ed, { icon: pencil.id });
  }, function (s) {
    s.description = '<div class="swing_profile_head"><img class="swing_profile_head__banner"><span class="swing_avatar swing_avatar_l swing_profile_head__avatar">AL</span><button class="swing_btn swing_btn_s swing_btn_icon swing_btn_tertiary swing_btn_neutral swing_profile_head__edit">pencil</button></div>. Banner 80 high (purple-100 under the photo); the avatar and the edit button hang 48 below it. The component is 128 high so that overhang is inside it (Figma clips outside a frame): content under it starts 16 down, which is the 64 of .page--profile on the web. Change the photo on "banner", the initials on "avatar".';
  }, { description: 'The Account header: banner photo, Avatar L and the edit button.' });
}

/* ----- Screen: Account (stat.chara.id/swing/ref/account.html) ----- */
var ACCOUNT_GROUPS = [
  ['Account', [['credit-card', 'Saved credit cards'], ['notification-bell', 'Notifications settings'], ['ticket', 'My promo codes'], ['invoice-paper', 'My receipts']]],
  ['Support', [['chat-circle', 'Give us feedback'], ['customer-service', 'Contact Swing support'], ['delete-profile', 'Delete my account']]],
  ['Legal', [['file-tick', 'Terms & conditions'], ['lock-circle', 'Privacy policy']]]
];
async function buildAccountScreen(R, notes) {
  var PG = 'Screen / Account';
  var page = await pageNamed(PG);
  var get = function (pg, name, fn) { return setFrom(pg, name, fn, R, notes); };
  var navSet = await setWith('BottomNav', 'BottomNav', buildBottomNavPage, R, notes, 'items=3');
  var navItems = await get('BottomNav', 'BottomNavItem', buildBottomNavPage);
  var btnSet = await get('Button', 'Button', buildButton);
  var liSet = await get('List', 'ListItem', buildListPage);
  var P = { head: await get('ProfileHead', 'ProfileHead', buildProfileHeadPage), promo: await get('PromoBanner', 'PromoBanner', buildPromoBannerPage) };
  var I = {};
  var icons = ['chevron-right', 'logout-bracket'];
  ACCOUNT_GROUPS.forEach(function (g) { g[1].forEach(function (r) { icons.push(r[0]); }); });
  for (var ic of icons) I[ic] = await iconOrPlaceholder('Icon/Line/' + ic, page, notes);
  var LI = byName(liSet), chevRow = LI['size=compact, trailing=chevron, tone=default, state=default'], plainRow = LI['size=compact, trailing=none, tone=default, state=default'];
  var ghost = byName(btnSet)['size=s, tone=primary, appearance=ghost, state=default'];

  /* ---------- the screen ---------- */
  var old = page.findChild(function (n) { return n.type === 'FRAME' && n.name === 'Account'; });
  var keepX = old ? old.x : 0, keepY = old ? old.y : 0;
  if (old) old.remove();
  var scr = figma.createFrame(); page.appendChild(scr);
  scr.name = 'Account'; scr.x = keepX; scr.y = keepY;
  scr.layoutMode = 'VERTICAL'; scr.resize(390, 844); scr.layoutSizingHorizontal = 'FIXED'; scr.layoutSizingVertical = 'HUG';
  scr.itemSpacing = 0; scr.clipsContent = true; scr.fills = paintFor(R, '--light-100');
  async function txt(parent, style, color, chars, name) {
    var t = await styledText(R, style, color, chars); parent.appendChild(t); t.name = name; t.textAutoResize = 'HEIGHT'; t.layoutSizingHorizontal = 'FILL'; return t;
  }
  // .sections: white blocks 4 apart on light-200
  var main = autoFrame('sections', 'VERTICAL', scr); fillHug(main);
  bindNumber(R, main, 'itemSpacing', '--space-4', 4); bindNumber(R, main, 'paddingBottom', '--space-4', 4);
  main.fills = paintFor(R, '--light-200');
  // 1. profile: head, name + handle + ghost button, referral banner
  var s1 = autoFrame('profile', 'VERTICAL', main); fillHug(s1); s1.itemSpacing = 0; s1.fills = paintFor(R, '--light-100');
  var hd = P.head.children[0].createInstance(); s1.appendChild(hd); hd.layoutSizingHorizontal = 'FILL';
  var p1 = autoFrame('page', 'VERTICAL', s1); fillHug(p1); padX(R, p1);
  bindNumber(R, p1, 'paddingTop', '--space-16', 16);   // .page--profile 64 on the web, minus the 48 overhang the 128 head now holds bindNumber(R, p1, 'paddingBottom', '--space-32', 32); bindNumber(R, p1, 'itemSpacing', '--gap-section', 32);
  var st = autoFrame('stack', 'VERTICAL', p1); fillHug(st); bindNumber(R, st, 'itemSpacing', '--gap-group', 16);
  var nm = autoFrame('name', 'VERTICAL', st); fillHug(nm); nm.itemSpacing = 0;
  await txt(nm, '--type-h3', '--color-text', 'Alvin Lianto', 'name');
  await txt(nm, '--type-b2s', '--dark-300', '@alvin_lianto', 'handle');
  var gb = ghost.createInstance(); st.appendChild(gb);
  setText(gb, { label: 'Edit my personal information', showIconEnd: true, iconEnd: I['chevron-right'].id });
  var pr = P.promo.children[0].createInstance(); p1.appendChild(pr); pr.layoutSizingHorizontal = 'FILL';
  // 2-4. Account, Support, Legal: section title + list with lead icons and chevrons
  for (var g of ACCOUNT_GROUPS) {
    var sec = autoFrame(g[0].toLowerCase(), 'VERTICAL', main); fillHug(sec); padX(R, sec); sec.fills = paintFor(R, '--light-100');
    bindNumber(R, sec, 'paddingTop', '--space-32', 32); bindNumber(R, sec, 'paddingBottom', '--space-32', 32); bindNumber(R, sec, 'itemSpacing', '--gap-group', 16);
    await txt(sec, '--type-h5', '--dark-300', g[0], 'section-title');
    var lst = autoFrame('list', 'VERTICAL', sec); fillHug(lst); lst.itemSpacing = 0;
    g[1].forEach(function (r, i) {
      var li = chevRow.createInstance(); lst.appendChild(li); li.layoutSizingHorizontal = 'FILL';
      setText(li, { title: r[1], showLeadIcon: true, leadIcon: I[r[0]].id, insetDivider: true, showDivider: i < g[1].length - 1 });
    });
  }
  // 5. tail on the grey: Log out + version
  var tail = autoFrame('tail', 'VERTICAL', main); fillHug(tail); padX(R, tail); tail.fills = [];
  bindNumber(R, tail, 'paddingTop', '--space-16', 16); bindNumber(R, tail, 'paddingBottom', '--space-32', 32); bindNumber(R, tail, 'itemSpacing', '--gap-group', 16);
  var lo = plainRow.createInstance(); tail.appendChild(lo); lo.layoutSizingHorizontal = 'FILL';
  setText(lo, { title: 'Log out', showLeadIcon: true, leadIcon: I['logout-bracket'].id, showDivider: false });
  await txt(tail, '--type-b3s', '--dark-200', 'VERSION 1.0.0 (202898)', 'meta-note');
  // bottom nav, Account active
  var nav = byName(navSet)['items=3'].createInstance(); scr.appendChild(nav); nav.layoutSizingHorizontal = 'FILL';
  var NI = byName(navItems), tabs = [];
  var navInsts = nav.findAll(function (n) { return n.type === 'INSTANCE'; });
  for (var ti = 0; ti < navInsts.length; ti++) { var tm = await navInsts[ti].getMainComponentAsync(); if (tm && inPart(tm, navItems)) tabs.push(navInsts[ti]); }
  if (tabs.length === 3) { tabs[0].swapComponent(NI['type=tab, state=default']); tabs[2].swapComponent(NI['type=tab, state=active']); }

  /* ---------- Components on this screen ---------- */
  var one = function (main, props) { var i = main.createInstance(); if (props) setText(i, props); return i; };
  await screenList(R, page, scr, 'Account', async function (row) {
    await row('ProfileHead', partSrc('ProfileHead', PG) + ' · banner photo, Avatar L (initials), edit button with pencil', [P.head]);
    await row('Button', partSrc('Button', PG) + ' · size=s, tone=primary, appearance=ghost + chevron-right: Edit my personal information', [one(ghost, { label: 'Edit my personal information', showIconEnd: true, iconEnd: I['chevron-right'].id })]);
    await row('PromoBanner', partSrc('PromoBanner', PG) + ' · referral banner, the same one as Home', [one(P.promo.children[0])]);
    await row('ListItem', partSrc('List', PG) + ' · size=compact: trailing=chevron with a lead icon (Account, Support, Legal), trailing=none for Log out; inset divider, none on the last row',
      [one(chevRow, { title: 'Saved credit cards', showLeadIcon: true, leadIcon: I['credit-card'].id, insetDivider: true }), one(plainRow, { title: 'Log out', showLeadIcon: true, leadIcon: I['logout-bracket'].id, showDivider: false })]);
    await row('BottomNav', partSrc('BottomNav', PG) + ' · items=3 with Account active (the tab variants swapped on this instance)', [one(byName(navSet)['items=3'])]);
  });
  notes.push('Account: built from stat.chara.id/swing/ref/account.html. Differences from the web: the ghost button sits on the column edge (the web pulls it 12 left with a negative margin, auto layout has none). The "Verify your email" note is the separate Account - email not verified state, not on this screen.');
  return { set: scr, count: 5, label: 'screen from 5 parts' };
}

/* ----- NotifRow (components.css .notif-row, ADS Updates): Avatar S on top, date (Label S) + title (B2s),
   unread indicator; 24 above and below, light-500 line under every row ----- */
async function buildNotifRowPage(R, notes) {
  var avSet = await setFrom('Avatar', 'Avatar', buildAvatarPage, R, notes);
  var inSet = await setFrom('Badge', 'Indicator', buildBadgePage, R, notes);
  var nr = {};
  return buildPartPage(R, notes, 'NotifRow', async function (comp, K) {
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'MIN';
    comp.resize(342, 80); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--space-12', 12);
    bindNumber(R, comp, 'paddingTop', '--space-24', 24); bindNumber(R, comp, 'paddingBottom', '--space-24', 24);
    comp.fills = [];
    comp.strokes = paintFor(R, '--light-500'); comp.strokeAlign = 'INSIDE';
    comp.strokeTopWeight = 0; comp.strokeRightWeight = 0; comp.strokeLeftWeight = 0; comp.strokeBottomWeight = 1;
    var av = byName(avSet)['size=s, type=initials'].createInstance(); comp.appendChild(av); av.name = 'avatar';   // .avatar: align-self flex-start
    setText(av, { initials: 'TS' });
    var tx = autoFrame('text', 'VERTICAL', comp); tx.layoutSizingHorizontal = 'FILL'; tx.layoutSizingVertical = 'HUG'; tx.itemSpacing = 0;
    var d = await K.txt(tx, '--type-lbl-s', '--dark-200', '21/11', 'date', 'fill');
    var t = await K.txt(tx, '--type-b2s', '--dark-500', 'Tio Saputra has made his first booking! Check your Swing Credits reward here.', 'title', 'fill');
    // the indicator is centred on the row while the avatar sits on top: a full-height slot centres it
    var slot = autoFrame('unread', 'VERTICAL', comp); slot.primaryAxisAlignItems = 'CENTER'; slot.counterAxisAlignItems = 'CENTER';
    slot.layoutSizingHorizontal = 'HUG'; slot.layoutSizingVertical = 'FILL'; slot.fills = [];
    var ind = byName(inSet)['placement=inline'].createInstance(); slot.appendChild(ind); ind.name = 'indicator';
    nr[comp.name] = { d: d, t: t, slot: slot };
  }, function (s) {
    var pD = ensureProp(s, 'date', 'TEXT', '21/11'), pT = ensureProp(s, 'title', 'TEXT', 'Tio Saputra has made his first booking! Check your Swing Credits reward here.');
    var pU = ensureProp(s, 'unread', 'BOOLEAN', true);
    wireKeys(nr).forEach(function (k) { nr[k].d.componentPropertyReferences = { characters: pD }; nr[k].t.componentPropertyReferences = { characters: pT }; nr[k].slot.componentPropertyReferences = { visible: pU }; });
    s.description = '<li><a class="swing_notif_row [is-unread]"><span class="swing_avatar swing_avatar_s">TS</span><span class="swing_notif_row__text"><span class="swing_notif_row__date">21/11</span><span class="swing_notif_row__title">…</span></span><span class="swing_indicator"></span></a></li> in .swing_notif_list (white, padding 16 page-x). unread = .is-unread (shows the indicator). Every row has the light-500 line under it.';
  }, { description: 'One notification: avatar, date, title and the unread dot.' });
}

/* ----- Screen: Updates (stat.chara.id/swing/ref/updates.html) ----- */
async function buildUpdatesScreen(R, notes) {
  var PG = 'Screen / Updates';
  var page = await pageNamed(PG);
  var get = function (pg, name, fn) { return setFrom(pg, name, fn, R, notes); };
  var appBar = await setWith('AppBar', 'AppBar', buildAppBarPage, R, notes, 'type=center, scrolled=false');
  var tagSet = await get('Tag', 'Tag', buildTagPage);
  var P = { row: await get('NotifRow', 'NotifRow', buildNotifRowPage) };
  var solid = async function (n) { return (await findIcon('Icon/Solid/' + n)) || iconOrPlaceholder('Icon/Line/' + n, page, notes); };
  var TAGS = [['notification-bell', 'Notifications', '99+', true], ['price-tag-rotate-right', 'Promotions', '32', false], ['announcer', 'Announcements', '01', false]];
  var TI = {};
  for (var tg of TAGS) TI[tg[0]] = await solid(tg[0]);
  var TB = byName(tagSet);

  /* ---------- the screen: .screen min-height 100dvh, main (.band) grows to the bottom ---------- */
  var old = page.findChild(function (n) { return n.type === 'FRAME' && n.name === 'Updates'; });
  var keepX = old ? old.x : 0, keepY = old ? old.y : 0;
  if (old) old.remove();
  var scr = figma.createFrame(); page.appendChild(scr);
  scr.name = 'Updates'; scr.x = keepX; scr.y = keepY;
  scr.layoutMode = 'VERTICAL'; scr.resize(390, 844); scr.layoutSizingHorizontal = 'FIXED'; scr.layoutSizingVertical = 'FIXED';
  scr.itemSpacing = 0; scr.clipsContent = true; scr.fills = paintFor(R, '--light-100');
  // header: .appbar--center .appbar--root = centred title in H3, back and more
  var bar = byName(appBar)['type=center, scrolled=false'].createInstance(); scr.appendChild(bar); bar.layoutSizingHorizontal = 'FILL';
  setText(bar, { title: 'Updates', showActions: true });
  var bt = bar.findOne(function (n) { return n.type === 'TEXT' && n.name === 'title'; }), h3 = R.text['--type-h3'];
  if (bt && h3) { await figma.loadFontAsync(h3.fontName); await bt.setTextStyleIdAsync(h3.id); }
  // .appbar__sub--flush: the type filter, 0 top, page-x sides, 16 bottom; tags scroll and clip at the edge
  var sub = autoFrame('appbar-sub', 'VERTICAL', scr); fillHug(sub); padX(R, sub);
  bindNumber(R, sub, 'paddingBottom', '--space-16', 16); sub.fills = paintFor(R, '--light-100');
  var tags = autoFrame('tags', 'HORIZONTAL', sub); fillHug(tags); bindNumber(R, tags, 'itemSpacing', '--gap-related', 8); tags.clipsContent = true;
  for (var tg2 of TAGS) {
    var ti = TB['tone=neutral, size=m, state=' + (tg2[3] ? 'selected' : 'default')].createInstance(); tags.appendChild(ti);
    setText(ti, { label: tg2[1], showIconStart: true, iconStart: TI[tg2[0]].id, showCounter: true });
    var cn = ti.findOne(function (n) { return n.type === 'INSTANCE' && n.name === 'counter'; }); if (cn) setText(cn, { count: tg2[2] });
  }
  // .band: grey 4 above and below the white list, grows to the bottom of the screen
  var band = autoFrame('band', 'VERTICAL', scr); band.layoutSizingHorizontal = 'FILL'; band.layoutSizingVertical = 'FILL';
  bindNumber(R, band, 'paddingTop', '--space-4', 4); bindNumber(R, band, 'paddingBottom', '--space-4', 4); band.fills = paintFor(R, '--light-200');
  var nl = autoFrame('notif-list', 'VERTICAL', band); fillHug(nl); padX(R, nl); nl.itemSpacing = 0;
  bindNumber(R, nl, 'paddingTop', '--space-16', 16); bindNumber(R, nl, 'paddingBottom', '--space-16', 16); nl.fills = paintFor(R, '--light-100');
  var ROWS = [['21/11', 'Tio Saputra has made his first booking! Check your Swing Credits reward here.'], ['21/11', 'Tio Saputra has joined Swing using your referral code! Remind him to make the first booking.']];
  ROWS.forEach(function (r) { var ri = P.row.children[0].createInstance(); nl.appendChild(ri); ri.layoutSizingHorizontal = 'FILL'; setText(ri, { date: r[0], title: r[1], unread: true }); });

  /* ---------- Components on this screen ---------- */
  var one = function (main, props) { var i = main.createInstance(); if (props) setText(i, props); return i; };
  await screenList(R, page, scr, 'Updates', async function (row) {
    var ab = one(byName(appBar)['type=center, scrolled=false'], { title: 'Updates', showActions: true });
    var abt = ab.findOne(function (n) { return n.type === 'TEXT' && n.name === 'title'; }); if (abt && h3) await abt.setTextStyleIdAsync(h3.id);
    await row('AppBar', partSrc('AppBar', PG) + ' · type=center with the title set to H3 on this instance (.swing_appbar_center .swing_appbar_root), back + more', [ab]);
    await row('Tag', partSrc('Tag', PG) + ' · tone=neutral, size=m, solid icon + counter; Notifications selected', [one(TB['tone=neutral, size=m, state=selected'], { label: 'Notifications', showIconStart: true, iconStart: TI['notification-bell'].id, showCounter: true }), one(TB['tone=neutral, size=m, state=default'], { label: 'Promotions', showIconStart: true, iconStart: TI['price-tag-rotate-right'].id, showCounter: true })]);
    await row('NotifRow', partSrc('NotifRow', PG) + ' · Avatar S, date, title, unread dot; used 2×', [P.row]);
  });
  notes.push('Updates: built from stat.chara.id/swing/ref/updates.html. The AppBar has no centred-H3 variant (.swing_appbar_center .swing_appbar_root), so the title text style is set to H3 on the instance; the tag row is clipped at the edge instead of scrolling.');
  return { set: scr, count: 3, label: 'screen from 3 parts' };
}

/* ----- Swing Credits UI components (components.css .credit-head/.credit-card, .ads-row, .reward-card, .ask-box) ----- */
var SC_PAGE = 'Screen / Swing Credits';
async function scIcon(R, name, notes, page) { return refIcon(R, 'sc-' + name, 'ref/img/sc/' + name + '.svg?v=1', 14, null, notes, page); }
async function buildCreditCardPage(R, notes) {
  var bt = byName(await setFrom('Button', 'Button', buildButton, R, notes))['size=s, tone=primary, appearance=solid, state=default'];
  var page = await pageNamed(SC_PAGE);
  var redeem = await scIcon(R, 'redeem', notes, page);
  var cc = {};
  return buildPartPage(R, notes, 'CreditCard', async function (comp, K) {
    // .credit-head 108 (banner art) with .credit-card on it at top 32, page-x sides. Figma clips what leaves a
    // frame, so the component is as tall as head + the card's overhang; the screen pulls the body up by that much.
    comp.layoutMode = 'NONE'; comp.resizeWithoutConstraints(390, 200); comp.clipsContent = false; comp.fills = [];
    var ban = figma.createRectangle(); comp.appendChild(ban); ban.name = 'banner'; ban.resize(390, 108); ban.x = 0; ban.y = 0;
    ban.constraints = { horizontal: 'STRETCH', vertical: 'MIN' };
    await refPhoto(R, ban, 'ref/img/sc/banner.jpg?v=1', notes);
    var card = autoFrame('card', 'VERTICAL', comp); card.x = 24; card.y = 32;
    card.resize(342, 150); card.layoutSizingHorizontal = 'FIXED'; card.layoutSizingVertical = 'HUG';
    card.constraints = { horizontal: 'STRETCH', vertical: 'MIN' };
    ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'].forEach(function (f) { bindNumber(R, card, f, '--space-16', 16); });
    bindNumber(R, card, 'itemSpacing', '--space-16', 16); bindRadius(R, card, '--radius-16', 16);
    card.fills = paintFor(R, '--light-100'); card.strokes = paintFor(R, '--light-500'); card.strokeWeight = 1; card.strokeAlign = 'INSIDE';
    if (R.effects['--elevation-2']) { try { await card.setEffectStyleIdAsync(R.effects['--elevation-2'].id); } catch (e) { /* plain */ } } else R.missing['--elevation-2'] = 1;
    var tx = autoFrame('text', 'VERTICAL', card); tx.layoutSizingHorizontal = 'FILL'; tx.layoutSizingVertical = 'HUG'; bindNumber(R, tx, 'itemSpacing', '--space-4', 4);
    await refArt(R, tx, 'ref/img/sc/logo.svg?v=1', 97, 16, 'logo', notes);
    var val = await K.txt(tx, '--type-h2', '--dark-500', '1,000,000', 'value');
    var ex = autoFrame('expiry', 'HORIZONTAL', tx); hugHug(ex); ex.counterAxisAlignItems = 'CENTER'; bindNumber(R, ex, 'itemSpacing', '--space-4', 4);
    await refArt(R, ex, 'ref/img/sc/time-sand.svg?v=1', 10, 10, 'icon', notes);
    var et = await K.txt(ex, '--type-b4', '--dark-300', '1,000,000 credits will expire on 31 Dec 2024', 'text');
    var b = bt.createInstance(); card.appendChild(b); b.name = 'redeem'; b.layoutSizingHorizontal = 'FILL';   // .btn--block
    setText(b, { label: 'Redeem Swing Credits', showIconStart: true, iconStart: redeem.id, showIconEnd: false });
    comp.resizeWithoutConstraints(390, Math.max(108, Math.round(card.y + card.height)));
    cc[comp.name] = { val: val, et: et };
  }, function (s) {
    var pV = ensureProp(s, 'credits', 'TEXT', '1,000,000'), pE = ensureProp(s, 'expiry', 'TEXT', '1,000,000 credits will expire on 31 Dec 2024');
    wireKeys(cc).forEach(function (k) { cc[k].val.componentPropertyReferences = { characters: pV }; cc[k].et.componentPropertyReferences = { characters: pE }; });
    s.description = '<div class="swing_credit_head" style="--art:url(banner)"><div class="swing_credit_card">logo, .swing_credit_card__value (H2), .swing_credit_card__expiry (B4 + time-sand 10), .swing_btn.btn--s.btn--block Redeem</div></div>. Head 108; the card sits 32 down with page-x sides, white, light-500 line, radius 16, Elevation 2. The component holds the card\'s overhang below the head; on the web .swing_credit_body clears it with 92 top padding.';
  }, { description: 'Swing Credits balance on its banner, with the redeem button.' });
}
async function buildAdsRowPage(R, notes) {
  var swSet = await setFrom('Switch', 'Switch', buildSwitchPage, R, notes);
  var page = await pageNamed(SC_PAGE);
  // history rows (.ads-row as a link): a swappable 22 icon, then .ads-row__end = amount + word + chevron 16
  var hIcon = await refIcon(R, 'sc-h-code', 'ref/img/sc/h-code.svg?v=1', 22, null, notes, page);
  var ar = {};
  var AR_V = [{ end: 'switch', name: 'end=switch', legacy: 'type=default' }, { end: 'plus', name: 'end=plus' }, { end: 'minus', name: 'end=minus' }];
  return buildPartPage(R, notes, 'AdsRow', async function (comp, K, pg, v) {
    var sw0 = !v || v.end === 'switch';
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(342, 48); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG'; comp.minHeight = 48;
    bindNumber(R, comp, 'itemSpacing', '--ads-gap-14', 14); comp.fills = [];
    comp.strokes = paintFor(R, '--light-500'); comp.strokeAlign = 'INSIDE';
    comp.strokeTopWeight = 0; comp.strokeRightWeight = 0; comp.strokeLeftWeight = 0; comp.strokeBottomWeight = 1;
    var ic = null;
    if (sw0) await refArt(R, comp, 'ref/img/sc/credits-22.svg?v=1', 22, 22, 'icon', notes);
    else { ic = hIcon.createInstance(); comp.appendChild(ic); ic.name = 'icon'; ic.resize(22, 22); }
    var tx = autoFrame('text', 'VERTICAL', comp); tx.layoutSizingHorizontal = 'FILL'; tx.layoutSizingVertical = 'HUG'; tx.itemSpacing = 2;
    bindNumber(R, tx, 'paddingTop', '--space-12', 12); bindNumber(R, tx, 'paddingBottom', '--space-12', 12);
    var t = await K.txt(tx, '--type-b2s', '--dark-500', sw0 ? 'Always use Swing Credits' : 'Redeemed by Swing Credits Code', 'title', 'fill');
    var bd = await K.txt(tx, '--type-b3', '--dark-300', sw0 ? 'Credits will always be used during payments' : '01:04 PM', 'body', 'fill');
    var p = { t: t, bd: bd, ic: ic };
    if (sw0) {
      var sw = byName(swSet)['checked=true, state=default'].createInstance(); comp.appendChild(sw); sw.name = 'switch';
    } else {   // .ads-row__end: gap 4, B3 dark-300; .ads-row__amount B3 Semibold green-500 (plus) / red-500 (minus)
      var end = autoFrame('end', 'HORIZONTAL', comp); end.counterAxisAlignItems = 'CENTER'; end.layoutSizingHorizontal = 'HUG'; end.layoutSizingVertical = 'HUG';
      bindNumber(R, end, 'itemSpacing', '--space-4', 4);
      p.amt = await K.txt(end, '--type-b3s', v.end === 'plus' ? '--green-500' : '--red-500', v.end === 'plus' ? '+ 5,000' : '- 5,000', 'amount');
      p.word = await K.txt(end, '--type-b3', '--dark-300', v.end === 'plus' ? 'redeemed' : 'expired', 'word');
      await refArt(R, end, 'ref/img/sc/chev-16.svg?v=1', 16, 16, 'chevron', notes);
    }
    ar[comp.name] = p;
  }, function (s) {
    var pT = ensureProp(s, 'title', 'TEXT', 'Always use Swing Credits'), pB = ensureProp(s, 'body', 'TEXT', 'Credits will always be used during payments');
    var pA = ensureProp(s, 'amount', 'TEXT', '+ 5,000'), pW = ensureProp(s, 'word', 'TEXT', 'earned'), pI = ensureProp(s, 'icon', 'INSTANCE_SWAP', hIcon.id);
    wireKeys(ar).forEach(function (k) {
      var p = ar[k];
      p.t.componentPropertyReferences = { characters: pT }; p.bd.componentPropertyReferences = { characters: pB };
      if (p.amt) { p.amt.componentPropertyReferences = { characters: pA }; p.word.componentPropertyReferences = { characters: pW }; }
      if (p.ic) p.ic.componentPropertyReferences = { mainComponent: pI };
    });
    s.description = '<label class="swing_ads_row"><img 22><span class="swing_ads_row__text"><span class="swing_ads_row__title">…</span><span class="swing_ads_row__body">…</span></span><input class="swing_switch swing_switch_s"></label> in .swing_ads_list. Min 48, gap 14, text 12 top and bottom, light-500 line under it (the bottom stroke); the last row in a list has none, so set that instance\'s bottom stroke to 0. The DS Switch has one size (40 x 24); .swing_switch_s is 32 x 18. ' +
      'end=plus / end=minus = the history row (<a class="swing_ads_row">…<span class="swing_ads_row__end"><span><span class="swing_ads_row__amount swing_ads_row__amount_plus|minus">+ 5,000</span> earned</span><img chev-16></span>): swappable icon (Icon/Ref/sc-h-*), amount B3 Semibold green-500 / red-500, word B3 dark-300, chevron 16. The web puts a space between amount and word; here it is a 4 gap.';
  }, { description: 'An ADS row: icon, title, body, and a switch (settings) or an amount + chevron (history).', variants: AR_V });
}
async function buildRewardCardPage(R, notes) {
  var rc = {};
  return buildPartPage(R, notes, 'RewardCard', async function (comp, K) {
    comp.layoutMode = 'VERTICAL'; comp.resize(163, 220); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--space-8', 8); comp.fills = [];
    var im = figma.createRectangle(); comp.appendChild(im); im.name = 'photo'; im.resize(163, 156); im.layoutSizingHorizontal = 'FILL';
    bindRadius(R, im, '--radius-8', 8); im.strokes = paintFor(R, '--light-500'); im.strokeWeight = 1; im.strokeAlign = 'INSIDE';
    await refPhoto(R, im, 'ref/img/sc/card-1.jpg?v=1', notes);
    var tx = autoFrame('text', 'VERTICAL', comp); tx.layoutSizingHorizontal = 'FILL'; tx.layoutSizingVertical = 'HUG'; tx.itemSpacing = 2;
    var t = await K.txt(tx, '--type-b3s', '--dark-500', 'Honma TR20V Irons', 'title', 'fill');
    var sh = await K.txt(tx, '--type-b4', '--dark-300', 'Juragan Golf', 'shop', 'fill');
    var pr = autoFrame('price', 'HORIZONTAL', comp); hugHug(pr); pr.counterAxisAlignItems = 'CENTER'; bindNumber(R, pr, 'itemSpacing', '--space-4', 4);
    await refArt(R, pr, 'ref/img/sc/credits.svg?v=1', 10, 10, 'icon', notes);
    var p = await K.txt(pr, '--type-b4s', '--dark-300', '650,000 Swing Credits', 'text');
    rc[comp.name] = { t: t, sh: sh, p: p };
  }, function (s) {
    var pT = ensureProp(s, 'title', 'TEXT', 'Honma TR20V Irons'), pS = ensureProp(s, 'shop', 'TEXT', 'Juragan Golf'), pP = ensureProp(s, 'price', 'TEXT', '650,000 Swing Credits');
    wireKeys(rc).forEach(function (k) { rc[k].t.componentPropertyReferences = { characters: pT }; rc[k].sh.componentPropertyReferences = { characters: pS }; rc[k].p.componentPropertyReferences = { characters: pP }; });
    s.description = '<a class="swing_reward_card"><img class="swing_reward_card__img"><span class="swing_reward_card__text"><span class="swing_reward_card__title">…</span><span class="swing_reward_card__shop">…</span></span><span class="swing_reward_card__price"><img 10>…</span></a> in .swing_reward_grid (2 columns, gap 16). Photo 156 high, light-500 line, radius 8. Change the photo on "photo".';
  }, { description: 'A reward you can redeem with Swing Credits.' });
}
async function buildAskBoxPage(R, notes) {
  var bt = byName(await setFrom('Button', 'Button', buildButton, R, notes))['size=s, tone=primary, appearance=solid, state=default'];
  var ab = {};
  return buildPartPage(R, notes, 'AskBox', async function (comp, K) {
    comp.layoutMode = 'VERTICAL'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(342, 200); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'].forEach(function (f) { bindNumber(R, comp, f, '--space-24', 24); });
    bindNumber(R, comp, 'itemSpacing', '--space-16', 16); bindRadius(R, comp, '--radius-16', 16); comp.fills = paintFor(R, '--light-300');
    await refArt(R, comp, 'ref/img/sc/gift.svg?v=1', 48, 48, 'icon', notes);
    var w = autoFrame('text-wrap', 'VERTICAL', comp); w.layoutSizingHorizontal = 'FILL'; w.layoutSizingVertical = 'HUG';
    bindNumber(R, w, 'paddingLeft', '--space-24', 24); bindNumber(R, w, 'paddingRight', '--space-24', 24);   // .ask-box__text padding 0 24
    var t = await K.txt(w, '--type-h6', '--dark-200', 'Can’t find the rewards you’re looking for? Simply tell us, and we’ll try to add it into our rewards list.', 'text', 'fill');
    t.textAlignHorizontal = 'CENTER';
    var b = bt.createInstance(); comp.appendChild(b); b.name = 'request';
    setText(b, { label: 'Request reward', showIconStart: false, showIconEnd: false });
    ab[comp.name] = t;
  }, function (s) {
    var pT = ensureProp(s, 'text', 'TEXT', 'Can’t find the rewards you’re looking for? Simply tell us, and we’ll try to add it into our rewards list.');
    wireKeys(ab).forEach(function (k) { ab[k].componentPropertyReferences = { characters: pT }; });
    s.description = '<div class="swing_ask_box"><img 48><p class="swing_ask_box__text">…</p><a class="swing_btn swing_btn_s">Request reward</a></div>. light-300, radius 16, padding 24, gap 16, centred; text H6 dark-200 with 24 side padding.';
  }, { description: 'Ask for a reward that is not in the list.' });
}

/* ----- Screen: Swing Credits (stat.chara.id/swing/ref/swing-credits.html) ----- */
async function buildSwingCreditsScreen(R, notes) {
  var PG = SC_PAGE;
  var page = await pageNamed(PG);
  var get = function (pg, name, fn) { return setFrom(pg, name, fn, R, notes); };
  var appBar = await setWith('AppBar', 'AppBar', buildAppBarPage, R, notes, 'type=ads, scrolled=false');
  var BT = byName(await get('Button', 'Button', buildButton));
  var P = { card: await get('CreditCard', 'CreditCard', buildCreditCardPage), row: await get('AdsRow', 'AdsRow', buildAdsRowPage),
    reward: await get('RewardCard', 'RewardCard', buildRewardCardPage), ask: await get('AskBox', 'AskBox', buildAskBoxPage) };
  var IC = { chev: await scIcon(R, 'chev-purple', notes, page), learn: await scIcon(R, 'learn', notes, page), history: await scIcon(R, 'history', notes, page) };

  var old = page.findChild(function (n) { return n.type === 'FRAME' && n.name === 'Swing Credits'; });
  var keepX = old ? old.x : 0, keepY = old ? old.y : 0;
  if (old) old.remove();
  var scr = figma.createFrame(); page.appendChild(scr);
  scr.name = 'Swing Credits'; scr.x = keepX; scr.y = keepY;
  scr.layoutMode = 'VERTICAL'; scr.resize(390, 844); scr.layoutSizingHorizontal = 'FIXED'; scr.layoutSizingVertical = 'HUG'; scr.minHeight = 844;
  scr.itemSpacing = 0; scr.clipsContent = true; scr.fills = paintFor(R, '--light-200');   // .screen--grey
  var bar = byName(appBar)['type=ads, scrolled=false'].createInstance(); scr.appendChild(bar); bar.layoutSizingHorizontal = 'FILL';
  setText(bar, { title: 'Swing Credits', showActions: true });
  async function txt(parent, style, color, chars, name) {
    var t = await styledText(R, style, color, chars); parent.appendChild(t); t.name = name; t.textAutoResize = 'HEIGHT'; t.layoutSizingHorizontal = 'FILL'; return t;
  }
  // .sections.sections--flush: white blocks 4 apart, nothing above the first
  var main = autoFrame('sections', 'VERTICAL', scr); fillHug(main);
  bindNumber(R, main, 'itemSpacing', '--space-4', 4); bindNumber(R, main, 'paddingBottom', '--space-4', 4); main.fills = paintFor(R, '--light-200');
  // 1. balance card, the setting row, cashback + learn/history buttons
  var s1 = autoFrame('credits', 'VERTICAL', main); fillHug(s1); s1.itemSpacing = 0; s1.fills = paintFor(R, '--light-100');
  s1.itemReverseZIndex = true;   // the card's Elevation 2 falls on credit-body: keep the card on top (first item drawn last)
  var hd = P.card.children[0].createInstance(); s1.appendChild(hd); hd.layoutSizingHorizontal = 'FILL';
  var body = autoFrame('credit-body', 'VERTICAL', s1); fillHug(body); padX(R, body);
  // .credit-body padding-top 92 from the head's bottom (108); the component already holds the card's overhang
  body.paddingTop = Math.max(0, 108 + 92 - Math.round(hd.height));
  bindNumber(R, body, 'paddingBottom', '--space-32', 32); bindNumber(R, body, 'itemSpacing', '--space-16', 16); body.fills = [];   // white comes from .credits; a fill here would paint over the card's shadow
  var al = autoFrame('ads-list', 'VERTICAL', body); fillHug(al); al.itemSpacing = 0;
  var ar = byName(P.row)['end=switch'].createInstance(); al.appendChild(ar); ar.layoutSizingHorizontal = 'FILL';
  ar.strokeBottomWeight = 0;   // .ads-list > .ads-row:last-child { border-bottom: 0 }
  var stk = autoFrame('stack', 'VERTICAL', body); fillHug(stk); bindNumber(R, stk, 'itemSpacing', '--gap-related', 8);
  var cb = BT['size=s, tone=primary, appearance=tertiary, state=default'].createInstance(); stk.appendChild(cb); cb.layoutSizingHorizontal = 'FILL';
  setText(cb, { label: 'See all cashbacks', showIconStart: false, showIconEnd: true, iconEnd: IC.chev.id });
  var br = autoFrame('btn-row', 'HORIZONTAL', stk); fillHug(br); bindNumber(R, br, 'itemSpacing', '--space-8', 8);
  [['Learn more', IC.learn], ['See history', IC.history]].forEach(function (x) {
    var b = BT['size=s, tone=neutral, appearance=tertiary, state=default'].createInstance(); br.appendChild(b); b.layoutSizingHorizontal = 'FILL';
    setText(b, { label: x[0], showIconStart: true, iconStart: x[1].id, showIconEnd: false });
  });
  // 2. rewards: title, 2-column grid of 10, ask box
  var s2 = autoFrame('rewards', 'VERTICAL', main); fillHug(s2); padX(R, s2); s2.fills = paintFor(R, '--light-100');
  bindNumber(R, s2, 'paddingTop', '--space-32', 32); bindNumber(R, s2, 'paddingBottom', '--space-32', 32); bindNumber(R, s2, 'itemSpacing', '--space-16', 16);
  await txt(s2, '--type-h5', '--dark-300', 'Redeem your Swing Credits', 'section-title');
  var grid = autoFrame('reward-grid', 'VERTICAL', s2); fillHug(grid); bindNumber(R, grid, 'itemSpacing', '--space-16', 16);
  var REW = [['card-1', 'Honma TR20V Irons', 'Juragan Golf', '650,000 Swing Credits'], ['card-2', 'Ping G425 Max Driver Loft 9 Alta J CB Flex S + HC', 'Golfellas', '940,000 Swing Credits']];
  for (var gr = 0; gr < 5; gr++) {
    var rw = autoFrame('row', 'HORIZONTAL', grid); fillHug(rw); bindNumber(R, rw, 'itemSpacing', '--space-16', 16);
    for (var x of REW) {
      var ri = P.reward.children[0].createInstance(); rw.appendChild(ri); ri.layoutSizingHorizontal = 'FILL';
      setText(ri, { title: x[1], shop: x[2], price: x[3] });
      var rp = ri.findOne(function (n) { return n.name === 'photo'; }); if (rp) await refPhoto(R, rp, 'ref/img/sc/' + x[0] + '.jpg?v=1', notes);
    }
  }
  var ak = P.ask.children[0].createInstance(); s2.appendChild(ak); ak.layoutSizingHorizontal = 'FILL';

  var one = function (main, props) { var i = main.createInstance(); if (props) setText(i, props); return i; };
  await screenList(R, page, scr, 'Swing Credits', async function (row) {
    await row('AppBar', partSrc('AppBar', PG) + ' · type=ads: ADS back arrow, centred title, country button (flag + ID)', [one(byName(appBar)['type=ads, scrolled=false'], { title: 'Swing Credits', showActions: true })]);
    await row('CreditCard', partSrc('CreditCard', PG) + ' · banner, balance, expiry, Redeem button (Button s block)', [P.card]);
    await row('AdsRow', partSrc('AdsRow', PG) + ' · icon 22, title, body, Switch; the last row has no line', [P.row]);
    await row('Button', partSrc('Button', PG) + ' · size=s tertiary: primary block + chevron (See all cashbacks), neutral + icon (Learn more, See history)',
      [one(BT['size=s, tone=primary, appearance=tertiary, state=default'], { label: 'See all cashbacks', showIconEnd: true, iconEnd: IC.chev.id }), one(BT['size=s, tone=neutral, appearance=tertiary, state=default'], { label: 'Learn more', showIconStart: true, iconStart: IC.learn.id })]);
    await row('RewardCard', partSrc('RewardCard', PG) + ' · used 10× in 2 columns', [P.reward]);
    await row('AskBox', partSrc('AskBox', PG) + ' · request a reward', [P.ask]);
  });
  notes.push('Swing Credits: built from stat.chara.id/swing/ref/swing-credits.html. Differences from the web: the DS Switch has one size (40 x 24), the web row uses .swing_switch_s (32 x 18); the reward grid is rows of two instead of a CSS grid.');
  return { set: scr, count: 6, label: 'screen from 6 parts' };
}

/* ----- Swing Credits history (ref/swing-credits-history.html): AppBar ads, ADS tag filter, date groups of AdsRow end=plus/minus ----- */
var SCH_GROUPS = [
  ['Thu, 15 Sep 2025', [['h-code', 'Redeemed by Swing Credits Code', '01:04 PM', 1, 'redeemed'], ['h-expired', 'Expired', '11:59 PM', -1, 'expired'], ['h-revoked', 'Revoked by Swing', '11:59 PM', -1, 'revoked']]],
  ['Sat, 09 Dec 2023', [['h-issued', 'Issued by Swing', '01:04 PM', 1, 'earned'], ['h-redeemed', 'Redeemed', 'Honma TR20V Irons • 01:04 PM', -1, 'used']]],
  ['Sat, 09 Dec 2023', [['h-teetime', 'Tee time booking', '#749RG • 01:04 PM', 1, 'earned'], ['h-range', 'Driving range booking', '#749RG • 01:04 PM', 1, 'earned'],
    ['h-range', 'Driving range booking', '#749RG • 01:04 PM', -1, 'used'], ['h-teetime', 'Tee time booking', '#749RG • 01:04 PM', 1, 'earned'],
    ['h-teetime', 'Tee time booking', '#749RG • 01:04 PM', -1, 'used'], ['h-virtual', 'Virtual golf booking', '#749RG • 01:04 PM', 1, 'earned'],
    ['h-virtual', 'Virtual golf booking', '#749RG • 01:04 PM', -1, 'used'], ['h-event', 'Event registration', '#749RG • 01:04 PM', 1, 'earned'],
    ['h-event', 'Event registration', '#749RG • 01:04 PM', -1, 'used']]]
];
async function buildCreditsHistoryScreen(R, notes) {
  var PG = 'Screen / Swing Credits history';
  var page = await pageNamed(PG);
  var appBar = await setWith('AppBar', 'AppBar', buildAppBarPage, R, notes, 'type=ads, scrolled=false');
  var TB = byName(await setWith('Tag', 'Tag', buildTagPage, R, notes, 'tone=ads, size=ads, state=selected'));
  var RB = byName(await setWith('AdsRow', 'AdsRow', buildAdsRowPage, R, notes, 'end=minus'));
  var HI = {};
  for (var g of SCH_GROUPS) for (var r of g[1]) if (!HI[r[0]]) HI[r[0]] = await refIcon(R, 'sc-' + r[0], 'ref/img/sc/' + r[0] + '.svg?v=1', 22, null, notes, page);

  var old = page.findChild(function (n) { return n.type === 'FRAME' && n.name === 'Swing Credits history'; });
  var keepX = old ? old.x : 0, keepY = old ? old.y : 0;
  if (old) old.remove();
  var scr = figma.createFrame(); page.appendChild(scr);
  scr.name = 'Swing Credits history'; scr.x = keepX; scr.y = keepY;
  scr.layoutMode = 'VERTICAL'; scr.resize(390, 844); scr.layoutSizingHorizontal = 'FIXED'; scr.layoutSizingVertical = 'HUG'; scr.minHeight = 844;
  scr.itemSpacing = 0; scr.clipsContent = true; scr.fills = paintFor(R, '--light-200');   // .screen--grey
  var bar = byName(appBar)['type=ads, scrolled=false'].createInstance(); scr.appendChild(bar); bar.layoutSizingHorizontal = 'FILL';
  setText(bar, { title: 'Swing Credits history', showActions: false });   // empty .appbar__actions
  // .appbar__sub: 8 top, page-x sides, 16 bottom, light-100; .tags--ads gap 4
  var sub = autoFrame('appbar-sub', 'VERTICAL', scr); fillHug(sub); padX(R, sub);
  bindNumber(R, sub, 'paddingTop', '--space-8', 8); bindNumber(R, sub, 'paddingBottom', '--space-16', 16); sub.fills = paintFor(R, '--light-100');
  var tags = autoFrame('tags', 'HORIZONTAL', sub); fillHug(tags); bindNumber(R, tags, 'itemSpacing', '--space-4', 4);
  [['All', true], ['Credits earned', false], ['Credits used', false]].forEach(function (x) {
    var ti = TB['tone=ads, size=ads, state=' + (x[1] ? 'selected' : 'default')].createInstance(); tags.appendChild(ti); setText(ti, { label: x[0] });
  });
  // .sections.sections--top: grey, 4 top and bottom; .page: white, 32 top (.sections > .page), page-x sides, 32 bottom
  var main = autoFrame('sections', 'VERTICAL', scr); fillHug(main);
  bindNumber(R, main, 'paddingTop', '--space-4', 4); bindNumber(R, main, 'paddingBottom', '--space-4', 4); main.fills = paintFor(R, '--light-200');
  var pgf = autoFrame('page', 'VERTICAL', main); fillHug(pgf); padX(R, pgf); pgf.fills = paintFor(R, '--light-100');
  bindNumber(R, pgf, 'paddingTop', '--space-32', 32); bindNumber(R, pgf, 'paddingBottom', '--space-32', 32);
  bindNumber(R, pgf, 'itemSpacing', '--space-16', 16);   // what the web renders: .sections > .page (gap 16) outranks .page--groups (gap 32)
  for (var gi = 0; gi < SCH_GROUPS.length; gi++) {
    var G = SCH_GROUPS[gi];
    var grp = autoFrame('ads-group', 'VERTICAL', pgf); fillHug(grp); bindNumber(R, grp, 'itemSpacing', '--space-8', 8);
    var dt = await styledText(R, '--type-b3s', '--dark-300', G[0]); grp.appendChild(dt); dt.name = 'date'; dt.textAutoResize = 'HEIGHT'; dt.layoutSizingHorizontal = 'FILL';
    var list = autoFrame('ads-list', 'VERTICAL', grp); fillHug(list); list.itemSpacing = 0;
    G[1].forEach(function (x, i) {
      var ri = RB[x[3] > 0 ? 'end=plus' : 'end=minus'].createInstance(); list.appendChild(ri); ri.layoutSizingHorizontal = 'FILL';
      setText(ri, { title: x[1], body: x[2], amount: (x[3] > 0 ? '+ ' : '- ') + '5,000', word: x[4], icon: HI[x[0]].id });
      if (i === G[1].length - 1) ri.strokeBottomWeight = 0;   // .ads-list > .ads-row:last-child { border-bottom: 0 }
    });
  }

  var one = function (main0, props) { var i = main0.createInstance(); if (props) setText(i, props); return i; };
  await screenList(R, page, scr, 'Swing Credits history', async function (row) {
    await row('AppBar', partSrc('AppBar', PG) + ' · type=ads, no actions', [one(byName(appBar)['type=ads, scrolled=false'], { title: 'Swing Credits history', showActions: false })]);
    await row('Tag', partSrc('Tag', PG) + ' · tone=ads, size=ads (28): All selected', [one(TB['tone=ads, size=ads, state=selected'], { label: 'All' }), one(TB['tone=ads, size=ads, state=default'], { label: 'Credits earned' })]);
    await row('AdsRow', partSrc('AdsRow', PG) + ' · end=plus / end=minus, icon swapped per row; the last row in a group has no line', [one(RB['end=plus']), one(RB['end=minus'])]);
  });
  notes.push('Swing Credits history: built from stat.chara.id/swing/ref/swing-credits-history.html. Date groups are 16 apart, which is what the web renders (.sections > .swing_page outranks .page--groups, whose 32 never applies); the filter tags are static, so the list shows All.');
  return { set: scr, count: 3, label: 'screen from 3 parts' };
}

/* ----- Personal information (ref/personal-info.html): AppBar ads, two white sections of fields, sticky Save bar ----- */
async function buildPersonalInfoScreen(R, notes) {
  var PG = 'Screen / Personal information';
  var page = await pageNamed(PG);
  var appBar = await setWith('AppBar', 'AppBar', buildAppBarPage, R, notes, 'type=ads, scrolled=false');
  var TF = byName(await setWith('TextField', 'TextField', buildTextFieldPage, R, notes, 'type=text, state=lockedWarning, filled=true'));
  var SL = byName(await setFrom('Select', 'Select', buildSelectPage, R, notes));
  var CP = byName(await setFrom('Caption', 'Caption', buildCaptionPage, R, notes));
  var BT = byName(await setFrom('Button', 'Button', buildButton, R, notes));
  var verify = await refIcon(R, 'em-verify-14', 'ref/img/em/verify-14.svg?v=1', 14, null, notes, page);
  var V = { text: 'type=text, state=default, filled=true', locked: 'type=text, state=locked, filled=true', warn: 'type=text, state=lockedWarning, filled=true',
    select: 'state=default, filled=true', cap: 'tone=warning, size=s', btn: 'size=l, tone=primary, appearance=solid, state=default' };

  var old = page.findChild(function (n) { return n.type === 'FRAME' && n.name === 'Personal information'; });
  var keepX = old ? old.x : 0, keepY = old ? old.y : 0;
  if (old) old.remove();
  var scr = figma.createFrame(); page.appendChild(scr);
  scr.name = 'Personal information'; scr.x = keepX; scr.y = keepY;
  scr.layoutMode = 'VERTICAL'; scr.resize(390, 844); scr.layoutSizingHorizontal = 'FIXED'; scr.layoutSizingVertical = 'HUG'; scr.minHeight = 844;
  scr.itemSpacing = 0; scr.clipsContent = true; scr.fills = paintFor(R, '--light-200');   // .screen--grey
  var bar = byName(appBar)['type=ads, scrolled=false'].createInstance(); scr.appendChild(bar); bar.layoutSizingHorizontal = 'FILL';
  setText(bar, { title: 'Personal information', showActions: false });
  // .sections.sections--top: grey, 4 top/bottom/between; each .page white, 32 top (.sections > .page), page-x sides, 32 bottom, gap 16
  var main = autoFrame('sections', 'VERTICAL', scr); fillHug(main);
  bindNumber(R, main, 'paddingTop', '--space-4', 4); bindNumber(R, main, 'paddingBottom', '--space-4', 4); bindNumber(R, main, 'itemSpacing', '--space-4', 4);
  main.fills = paintFor(R, '--light-200');
  function section(name) {
    var s = autoFrame(name, 'VERTICAL', main); fillHug(s); padX(R, s); s.fills = paintFor(R, '--light-100');
    bindNumber(R, s, 'paddingTop', '--space-32', 32); bindNumber(R, s, 'paddingBottom', '--space-32', 32); bindNumber(R, s, 'itemSpacing', '--space-16', 16);
    return s;
  }
  async function title(parent, t) {   // .section-title.section-title--muted: H5 dark-300
    var x = await styledText(R, '--type-h5', '--dark-300', t); parent.appendChild(x); x.name = 'section-title'; x.textAutoResize = 'HEIGHT'; x.layoutSizingHorizontal = 'FILL'; return x;
  }
  function field(parent, key, props, name) {
    var i = (key === 'select' ? SL : TF)[V[key]].createInstance(); parent.appendChild(i); i.layoutSizingHorizontal = 'FILL';
    setText(i, Object.assign({ showHelp: false }, props)); i.name = name; return i;
  }
  var s1 = section('personal');
  await title(s1, 'Personal information');
  var fr = autoFrame('field-row', 'HORIZONTAL', s1); fillHug(fr); bindNumber(R, fr, 'itemSpacing', '--space-8', 8);   // .field-row: 2 columns, gap 8
  field(fr, 'text', { label: 'First name', value: 'Alvin' }, 'First name');
  field(fr, 'text', { label: 'Last name', value: 'Lianto' }, 'Last name');
  field(s1, 'select', { label: 'Birthday', value: '01/01/2000' }, 'Birthday');
  field(s1, 'select', { label: 'Nationality', value: 'Indonesia' }, 'Nationality');
  field(s1, 'select', { label: 'Gender', value: 'Male' }, 'Gender');
  field(s1, 'locked', { label: 'Username', value: 'alvinlianto', buttonLabel: 'Change' }, 'Username');
  var s2 = section('contact');
  await title(s2, 'Contact information');
  field(s2, 'locked', { label: 'Phone number', value: '+6282164771117', buttonLabel: 'Change' }, 'Phone number');
  var mf = autoFrame('email', 'VERTICAL', s2); fillHug(mf); bindNumber(R, mf, 'itemSpacing', '--space-8', 8);   // .field: box, then the caption 8 below
  field(mf, 'warn', { label: 'Email', value: 'alvin.lianto5109@gmail.com', buttonLabel: 'Verify email', showButtonIcon: true, buttonIcon: verify.id }, 'Email');
  var cap = CP[V.cap].createInstance(); mf.appendChild(cap); cap.layoutSizingHorizontal = 'FILL';
  setText(cap, { text: 'Verify your email to be able to receive notifications, updates, and promotions.' });
  // .bottom-bar: white, 16 / page-x / 32, 1px light-500 line above (--line-sticky-up), block Button
  var bb = autoFrame('bottom-bar', 'VERTICAL', scr); fillHug(bb); padX(R, bb);
  bindNumber(R, bb, 'paddingTop', '--space-16', 16); bindNumber(R, bb, 'paddingBottom', '--space-32', 32); bindNumber(R, bb, 'itemSpacing', '--gap-related', 8);
  bb.fills = paintFor(R, '--light-100');
  var up = lineBelow(R)[0]; if (up) bb.effects = [Object.assign({}, up, { offset: { x: 0, y: -1 } })];
  var sv = BT[V.btn].createInstance(); bb.appendChild(sv); sv.layoutSizingHorizontal = 'FILL'; setText(sv, { label: 'Save changes', showIconStart: false, showIconEnd: false });

  var one = function (m, props) { var i = m.createInstance(); if (props) setText(i, props); return i; };
  await screenList(R, page, scr, 'Personal information', async function (row) {
    await row('AppBar', partSrc('AppBar', PG) + ' · type=ads, no actions', [one(byName(appBar)['type=ads, scrolled=false'], { title: 'Personal information', showActions: false })]);
    await row('TextField', partSrc('TextField', PG) + ' · type=text filled; state=locked with Change, state=lockedWarning with Verify email + icon', [one(TF[V.locked], { label: 'Username', value: 'alvinlianto', showHelp: false }), one(TF[V.warn], { label: 'Email', value: 'alvin.lianto5109@gmail.com', buttonLabel: 'Verify email', showButtonIcon: true, buttonIcon: verify.id, showHelp: false })]);
    await row('Select', partSrc('Select', PG) + ' · filled: Birthday, Nationality, Gender', [one(SL[V.select], { label: 'Nationality', value: 'Indonesia', showHelp: false })]);
    await row('Caption', partSrc('Caption', PG) + ' · tone=warning, size=s under Email', [one(CP[V.cap], { text: 'Verify your email to be able to receive notifications, updates, and promotions.' })]);
    await row('Button', partSrc('Button', PG) + ' · size=l primary solid, block, in the bottom bar', [one(BT[V.btn], { label: 'Save changes' })]);
  });
  notes.push('Personal information: built from stat.chara.id/swing/ref/personal-info.html. Not drawn: the success toast and the Email verification sheet (states, not the resting screen). The Caption uses the DS warning icon; the web uses img/em/warning-o.svg.');
  return { set: scr, count: 5, label: 'screen from 5 parts' };
}

/* ----- Email templates (components.css .mail): MailFoot UI component + the Verify email mail ----- */
async function buildMailFootPage(R, notes) {
  var mf = {};
  var MF_V = [{ stores: 'false', name: 'stores=false' }, { stores: 'true', name: 'stores=true' }];
  return buildPartPage(R, notes, 'MailFoot', async function (comp, K, pg, v) {
    // .mail__foot: column, centred, gap 16, padding 16; .mail__brand: albatross 24, site B3 Semibold, copyright B4, dark-200, gap 4
    comp.layoutMode = 'VERTICAL'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(357, 100); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].forEach(function (f) { bindNumber(R, comp, f, '--space-16', 16); });
    bindNumber(R, comp, 'itemSpacing', '--space-16', 16); comp.fills = [];
    var br = autoFrame('brand', 'VERTICAL', comp); br.counterAxisAlignItems = 'CENTER'; br.layoutSizingHorizontal = 'FILL'; br.layoutSizingVertical = 'HUG';
    bindNumber(R, br, 'itemSpacing', '--space-4', 4);
    await refArt(R, br, 'ref/img/sp/albatross.svg?v=1', 24, 24, 'mark', notes);
    var site = await K.txt(br, '--type-b3s', '--dark-200', 'www.getswing.app', 'site'); site.textAlignHorizontal = 'CENTER';
    var cp = await K.txt(br, '--type-b4', '--dark-200', 'Copyright © 2026 PT. Silverwing Wisteria Indosport', 'copyright', 'fill'); cp.textAlignHorizontal = 'CENTER';
    if (v && v.stores === 'true') {   // .mail__stores: gap 8, badges 24 tall
      var st = autoFrame('stores', 'HORIZONTAL', comp); st.layoutSizingHorizontal = 'HUG'; st.layoutSizingVertical = 'HUG'; bindNumber(R, st, 'itemSpacing', '--space-8', 8);
      await refArt(R, st, 'ref/img/sp/badge-appstore.svg?v=1', 72, 24, 'app-store', notes);
      await refArt(R, st, 'ref/img/sp/badge-gplay.svg?v=1', 81, 24, 'google-play', notes);
    }
    mf[comp.name] = cp;
  }, function (s) {
    var pC = ensureProp(s, 'copyright', 'TEXT', 'Copyright © 2026 PT. Silverwing Wisteria Indosport');
    wireKeys(mf).forEach(function (k) { mf[k].componentPropertyReferences = { characters: pC }; });
    s.description = '<footer class="swing_mail__foot"><div class="swing_mail__brand"><img albatross 24><span class="swing_mail__site">www.getswing.app</span><span class="swing_mail__copy">…</span></div>[<div class="swing_mail__stores">App Store 72 + Google Play 81</div>]</footer>. Centred, padding 16, gap 16; brand gap 4, site B3 Semibold, copyright B4, both dark-200. stores=true adds the store badges (Swing Pass emails).';
  }, { description: 'Email footer: Swing mark, site, copyright, and optionally the store badges.', variants: MF_V });
}

async function buildVerifyEmailScreen(R, notes) {
  var PG = 'Screen / Verify email';
  var page = await pageNamed(PG);
  var MF = byName(await setWith('MailFoot', 'MailFoot', buildMailFootPage, R, notes, 'stores=true'));
  var old = page.findChild(function (n) { return n.type === 'FRAME' && n.name === 'Verify email'; });
  var keepX = old ? old.x : 0, keepY = old ? old.y : 0;
  if (old) old.remove();
  // .mail: 357 wide (max-width), light-200, column centred, gap 16, 16 top and bottom. An email, so no phone frame or 844 height.
  var scr = figma.createFrame(); page.appendChild(scr);
  scr.name = 'Verify email'; scr.x = keepX; scr.y = keepY;
  scr.layoutMode = 'VERTICAL'; scr.counterAxisAlignItems = 'CENTER';
  scr.resize(357, 400); scr.layoutSizingHorizontal = 'FIXED'; scr.layoutSizingVertical = 'HUG';
  bindNumber(R, scr, 'paddingTop', '--space-16', 16); bindNumber(R, scr, 'paddingBottom', '--space-16', 16); bindNumber(R, scr, 'itemSpacing', '--space-16', 16);
  scr.fills = paintFor(R, '--light-200');
  await refArt(R, scr, 'ref/img/sp/swing-logo.svg?v=1', 80, 24, 'logo', notes);   // .mail__logo 80 x 24
  var card = autoFrame('card', 'VERTICAL', scr); fillHug(card);
  // .mail__body.mail__body--s: white, 32 / 16, gap 32, radius 4 on the top corners only
  var body = autoFrame('body', 'VERTICAL', card); fillHug(body); body.fills = paintFor(R, '--light-100');
  bindNumber(R, body, 'paddingTop', '--space-32', 32); bindNumber(R, body, 'paddingBottom', '--space-32', 32);
  bindNumber(R, body, 'paddingLeft', '--space-16', 16); bindNumber(R, body, 'paddingRight', '--space-16', 16);
  bindNumber(R, body, 'itemSpacing', '--space-32', 32);
  ['topLeftRadius', 'topRightRadius'].forEach(function (f) { bindNumber(R, body, f, '--ads-radius-4', 4); });
  async function txt(parent, style, color, chars, name) {
    var t = await styledText(R, style, color, chars); parent.appendChild(t); t.name = name; t.textAutoResize = 'HEIGHT'; t.layoutSizingHorizontal = 'FILL'; return t;
  }
  await txt(body, '--type-h3', '--dark-500', 'Verify your email', 'heading');
  var grp = autoFrame('group', 'VERTICAL', body); fillHug(grp); bindNumber(R, grp, 'itemSpacing', '--space-16', 16);
  await txt(grp, '--type-b2', '--dark-500', 'Hi <First Name>,', 'text');
  await txt(grp, '--type-b2', '--dark-500', 'Please insert the code below into the Swing app to verify your email address.', 'text');
  await txt(grp, '--type-h4', '--purple-500', '123 456', 'code');
  var ft = MF['stores=false'].createInstance(); scr.appendChild(ft); ft.layoutSizingHorizontal = 'FILL';
  setText(ft, { copyright: 'Copyright © 2026 PT. Silverwing Wisteria Indosport' });

  await screenList(R, page, scr, 'Verify email', async function (row) {
    await row('MailFoot', partSrc('MailFoot', PG) + ' · stores=false here; stores=true adds the store badges (Swing Pass emails)', [MF['stores=false'].createInstance(), MF['stores=true'].createInstance()]);
  });
  notes.push('Verify email: built from stat.chara.id/swing/ref/verify-email.html. It is an email, so the frame is the 357 mail column, not a 390 phone screen. Logo, heading, text and code are plain layers: only this email uses them.');
  return { set: scr, count: 1, label: 'email from 1 part' };
}

/* ----- Refer & earn (ref/refer-earn.html): CodeCard, StatPanel, StepCard, FaqItem UI components ----- */
var RE_PAGE = 'Screen / Refer & earn';
var RE_STEPS = [
  ['1. Invite & download', 'Share your referral code or link to your friends and family for them to download later.', 'line:share-bracket'],
  ['2. Create an account', 'They create an account using your referral code and get 100,000 in Swing Credits as a reward.', 'line:user-circle'],
  ['3. First booking', 'They make the first booking at any location and have it confirmed on the Swing app.', 'brand:albatross-icon'],
  ['4. Claim reward', 'You will then get 100,000 in Swing Credits as a reward for referring your friend on Swing.', 'brand:swing-credits-icon']
];
var RE_FAQ = [
  ['What are my rewards and how do I use them?', 'For each player who created an account using your referral code and then make the first booking, you will then get 100,000 Swing Credits.\n\nYou can only get the driving range promo codes once the new player made the first driving range booking and tee time promo codes once the new player made the first tee time booking - This means, they are separated.\n\nYou can use them on any driving ranges and golf courses available on Swing.'],
  ['What does the number on \u201cyou\u2019ve earned\u201d mean?', 'It is the total Swing Credits you have received from referrals so far.'],
  ['Can I my old referral code be used?', 'Yes. Your code stays the same, so friends can keep using it.'],
  ['Can I still track the players who used my referral code in the past?', 'Yes. Everyone who signed up with your code shows up in Track my referral.'],
  ['I did everything for the referral, but didn\u2019t get the rewards, what should I do?', 'Check that your friend\u2019s first booking shows as finished. If it does and you still have no credits, contact us.']
];
async function brandIcon(R, name, size, notes, page) { return refIcon(R, 'brand-' + name, 'ds/brand/' + name + '.svg', size, null, notes, page); }

async function buildCodeCardPage(R, notes) {
  var BT = byName(await setFrom('Button', 'Button', buildButton, R, notes));
  var page = await pageNamed(RE_PAGE);
  var sc = await brandIcon(R, 'swing-credits-icon', 32, notes, page);
  var IC = { copy: await iconOrPlaceholder('Icon/Line/copy', page, notes), share: await iconOrPlaceholder('Icon/Line/share', page, notes) };
  var cc = {};
  return buildPartPage(R, notes, 'CodeCard', async function (comp, K) {
    // .code-card: clip, light-500 line, radius 16, purple-50, Elevation brand; white top 16 (label B2s dark-300, amount H2 + 32 credits mark), band 12/16 (code H4 purple-500, Copy + Share btn--s)
    comp.layoutMode = 'VERTICAL'; comp.resize(342, 160); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    comp.itemSpacing = 0; comp.clipsContent = true; bindRadius(R, comp, '--radius-16', 16);
    comp.fills = paintFor(R, '--purple-50'); comp.strokes = paintFor(R, '--light-500'); comp.strokeWeight = 1; comp.strokeAlign = 'INSIDE';
    await effectStyle(R, comp, '--elevation-brand');
    var top = autoFrame('top', 'VERTICAL', comp); fillHug(top); top.fills = paintFor(R, '--light-100');
    ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].forEach(function (f) { bindNumber(R, top, f, '--space-16', 16); });
    bindNumber(R, top, 'itemSpacing', '--space-4', 4);
    var lb = await K.txt(top, '--type-b2s', '--dark-300', 'From referrals, you\u2019ve earned', 'label', 'fill');
    var am = autoFrame('amount', 'HORIZONTAL', top); hugHug(am); am.counterAxisAlignItems = 'CENTER'; bindNumber(R, am, 'itemSpacing', '--space-4', 4);
    var mk = sc.createInstance(); am.appendChild(mk); mk.name = 'credits'; mk.resize(32, 32);
    var av = await K.txt(am, '--type-h2', '--dark-500', '1,450,000', 'value');
    var band = autoFrame('band', 'HORIZONTAL', comp); fillHug(band); band.counterAxisAlignItems = 'CENTER';
    bindNumber(R, band, 'paddingTop', '--space-12', 12); bindNumber(R, band, 'paddingBottom', '--space-12', 12);
    bindNumber(R, band, 'paddingLeft', '--space-16', 16); bindNumber(R, band, 'paddingRight', '--space-16', 16); bindNumber(R, band, 'itemSpacing', '--space-12', 12);
    var code = await K.txt(band, '--type-h4', '--purple-500', 'ALVLIA123', 'code', 'fill');
    var acts = autoFrame('actions', 'HORIZONTAL', band); hugHug(acts); bindNumber(R, acts, 'itemSpacing', '--space-4', 4);
    [['Copy', IC.copy], ['Share', IC.share]].forEach(function (x) {
      var b = BT['size=s, tone=primary, appearance=solid, state=default'].createInstance(); acts.appendChild(b); b.name = x[0].toLowerCase();
      setText(b, { label: x[0], showIconStart: true, iconStart: x[1].id, showIconEnd: false });
    });
    cc[comp.name] = { lb: lb, av: av, code: code };
  }, function (s) {
    var pL = ensureProp(s, 'label', 'TEXT', 'From referrals, you\u2019ve earned'), pA = ensureProp(s, 'amount', 'TEXT', '1,450,000'), pC = ensureProp(s, 'code', 'TEXT', 'ALVLIA123');
    wireKeys(cc).forEach(function (k) { cc[k].lb.componentPropertyReferences = { characters: pL }; cc[k].av.componentPropertyReferences = { characters: pA }; cc[k].code.componentPropertyReferences = { characters: pC }; });
    s.description = '<section class="swing_code_card"><div class="swing_code_card__top"><p class="swing_code_card__label">…</p><p class="swing_code_card__amount"><img swing-credits 32>{amount}</p></div><div class="swing_code_card__band"><p class="swing_code_card__code">{code}</p><div class="swing_code_card__actions">swing_btn_s Copy, swing_btn_s Share</div></div></section>. Radius 16, light-500 line, purple-50 band, Elevation brand.';
  }, { description: 'Referral rewards and code, with Copy and Share.' });
}

async function buildStatPanelPage(R, notes) {
  var sp = {};
  var V = [{ zero: 'false', name: 'zero=false' }, { zero: 'true', name: 'zero=true' }];
  return buildPartPage(R, notes, 'StatPanel', async function (comp, K, pg, v) {
    // .stat-panel: light-200, radius 16, 12/16, gap 12; two items (value H2 purple-500, dark-100 when .is-zero; label B2s dark-500, gap 4, centred) and a 1px light-500 divider
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(342, 80); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'paddingTop', '--space-12', 12); bindNumber(R, comp, 'paddingBottom', '--space-12', 12);
    bindNumber(R, comp, 'paddingLeft', '--space-16', 16); bindNumber(R, comp, 'paddingRight', '--space-16', 16);
    bindNumber(R, comp, 'itemSpacing', '--space-12', 12); bindRadius(R, comp, '--radius-16', 16); comp.fills = paintFor(R, '--light-200');
    var p = [];
    for (var i = 0; i < 2; i++) {
      if (i) { var d = figma.createRectangle(); comp.appendChild(d); d.name = 'divider'; d.resize(1, 40); d.fills = paintFor(R, '--light-500'); d.layoutSizingVertical = 'FILL'; }
      var it = autoFrame('item', 'VERTICAL', comp); it.layoutSizingHorizontal = 'FILL'; it.layoutSizingVertical = 'HUG'; it.counterAxisAlignItems = 'CENTER';
      bindNumber(R, it, 'itemSpacing', '--space-4', 4);
      var val = await K.txt(it, '--type-h2', v.zero === 'true' ? '--dark-100' : '--purple-500', v.zero === 'true' ? '0' : '3', 'value', 'fill'); val.textAlignHorizontal = 'CENTER';
      var lab = await K.txt(it, '--type-b2s', '--dark-500', i ? 'Made first booking' : 'Joined Swing', 'label', 'fill'); lab.textAlignHorizontal = 'CENTER';
      p.push([val, lab]);
    }
    sp[comp.name] = p;
  }, function (s) {
    var P = [[ensureProp(s, 'value1', 'TEXT', '0'), ensureProp(s, 'label1', 'TEXT', 'Joined Swing')], [ensureProp(s, 'value2', 'TEXT', '0'), ensureProp(s, 'label2', 'TEXT', 'Made first booking')]];
    wireKeys(sp).forEach(function (k) { sp[k].forEach(function (x, i) { x[0].componentPropertyReferences = { characters: P[i][0] }; x[1].componentPropertyReferences = { characters: P[i][1] }; }); });
    s.description = '<div class="swing_stat_panel"><div class="swing_stat_panel__item"><span class="swing_stat_panel__value [is-zero]">0</span><span class="swing_stat_panel__label">…</span></div><span class="swing_stat_panel__divider"></span>…</div>. light-200, radius 16, 12/16, gap 12. zero=true = .is-zero (value dark-100); otherwise purple-500.';
  }, { description: 'Two numbers side by side with a divider.', variants: V });
}

async function buildStepCardPage(R, notes) {
  var page = await pageNamed(RE_PAGE);
  var art = [], ico = [];
  for (var i = 0; i < 4; i++) {
    var src = RE_STEPS[i][2].split(':');
    ico.push(src[0] === 'line' ? await iconOrPlaceholder('Icon/Line/' + src[1], page, notes) : await brandIcon(R, src[1], 32, notes, page));
  }
  var sc = {};
  var V = [1, 2, 3, 4].map(function (n) { return { step: String(n), name: 'step=' + n }; });
  return buildPartPage(R, notes, 'StepCard', async function (comp, K, pg, v) {
    // .step-card: 168 wide, gap 16; art 64 tall, radius 16, light-200 + step-art-N cover, icon 32 purple-500 centred; title H6, body B3 dark-300, gap 4
    var n = Number(v.step) - 1;
    comp.layoutMode = 'VERTICAL'; comp.resize(168, 160); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--space-16', 16); comp.fills = [];
    var a = autoFrame('art', 'HORIZONTAL', comp); a.primaryAxisAlignItems = 'CENTER'; a.counterAxisAlignItems = 'CENTER';
    a.resize(168, 64); a.layoutSizingHorizontal = 'FILL'; a.layoutSizingVertical = 'FIXED';
    bindRadius(R, a, '--radius-16', 16); a.clipsContent = true; a.fills = paintFor(R, '--light-200');
    var bg = await refArt(R, a, 'ref/img/step-art-' + (n + 1) + '.svg?v=2', 168, 64, 'pattern', notes);
    bg.layoutPositioning = 'ABSOLUTE'; bg.x = 0; bg.y = 0;
    var ic = ico[n].createInstance(); a.appendChild(ic); ic.name = 'icon'; ic.resize(32, 32);
    if (/^line:/.test(RE_STEPS[n][2])) recolorIcon(R, ic, '--purple-500');
    var tx = autoFrame('text', 'VERTICAL', comp); fillHug(tx); bindNumber(R, tx, 'itemSpacing', '--space-4', 4);
    var t = await K.txt(tx, '--type-h6', '--dark-500', RE_STEPS[n][0], 'title', 'fill');
    var b = await K.txt(tx, '--type-b3', '--dark-300', RE_STEPS[n][1], 'body', 'fill');
    sc[comp.name] = { t: t, b: b };
  }, function (s) {
    var pT = ensureProp(s, 'title', 'TEXT', RE_STEPS[0][0]), pB = ensureProp(s, 'body', 'TEXT', RE_STEPS[0][1]);
    wireKeys(sc).forEach(function (k) { sc[k].t.componentPropertyReferences = { characters: pT }; sc[k].b.componentPropertyReferences = { characters: pB }; });
    s.description = '<li class="swing_step_card"><span class="swing_step_card__art" style="--step-art:url(step-art-N.svg)"><i class="swing_icon">…</i></span><span class="swing_step_card__text"><span class="swing_step_card__title">…</span><span class="swing_step_card__body">…</span></span></li> in .swing_step_rail (gap 32, a 2px light-500 line through the art middle). step = which art and icon; title and body are props (the default text is step 1, so set them per instance).';
  }, { description: 'A how-it-works step: art tile with icon, title, body.', variants: V });
}

async function buildFaqItemPage(R, notes) {
  var page = await pageNamed(RE_PAGE);
  var chev = await iconOrPlaceholder('Icon/Line/chevron-down', page, notes);
  var chevAds = await refIcon(R, 'sp-chev-down', 'ref/img/sp/chev-down.svg?v=1', 16, '--dark-200', notes, page);   // .faq--ads
  var fq = {};
  var V = [{ open: 'true', ads: 'false', name: 'open=true, ads=false', legacy: 'open=true' }, { open: 'false', ads: 'false', name: 'open=false, ads=false', legacy: 'open=false' },
    { open: 'true', ads: 'true', name: 'open=true, ads=true' }, { open: 'false', ads: 'true', name: 'open=false, ads=true' }];
  return buildPartPage(R, notes, 'FaqItem', async function (comp, K, pg, v) {
    // .faq__item: light-500 line under it; .faq__q 16 / 0, gap 12, B2s dark-500, chevron 16; open: q purple-500, 0 bottom, chevron turned; .faq__a B3 dark-300, 0 28 16 0
    var open = v.open === 'true';
    comp.layoutMode = 'VERTICAL'; comp.resize(294, 60); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG'; comp.itemSpacing = 0;
    comp.fills = []; comp.strokes = paintFor(R, '--light-500'); comp.strokeAlign = 'INSIDE';
    comp.strokeTopWeight = 0; comp.strokeRightWeight = 0; comp.strokeLeftWeight = 0; comp.strokeBottomWeight = 1;
    var q = autoFrame('question', 'HORIZONTAL', comp); fillHug(q); q.counterAxisAlignItems = 'CENTER';
    bindNumber(R, q, 'paddingTop', '--space-16', 16); if (open) q.paddingBottom = 0; else bindNumber(R, q, 'paddingBottom', '--space-16', 16);
    bindNumber(R, q, 'itemSpacing', '--space-12', 12);
    var qt = await K.txt(q, '--type-b2s', open ? '--purple-500' : '--dark-500', RE_FAQ[0][0], 'text', 'fill');
    var ads = v.ads === 'true';
    var ci = (ads ? chevAds : chev).createInstance(); q.appendChild(ci); ci.name = 'chevron'; ci.resize(16, 16); if (!ads) recolorIcon(R, ci, '--dark-500');
    if (open) ci.rotation = 180;
    var p = { q: qt };
    if (open) {
      var aw = autoFrame('answer', 'VERTICAL', comp); fillHug(aw);
      aw.paddingTop = 0; aw.paddingRight = 28; bindNumber(R, aw, 'paddingBottom', '--space-16', 16);   // .faq__a: 0 28 16 0, right under the open question
      p.a = await K.txt(aw, '--type-b3', '--dark-300', RE_FAQ[0][1], 'text', 'fill');
    }
    fq[comp.name] = p;
  }, function (s) {
    var pQ = ensureProp(s, 'question', 'TEXT', RE_FAQ[0][0]), pA = ensureProp(s, 'answer', 'TEXT', RE_FAQ[0][1]);
    wireKeys(fq).forEach(function (k) { fq[k].q.componentPropertyReferences = { characters: pQ }; if (fq[k].a) fq[k].a.componentPropertyReferences = { characters: pA }; });
    s.description = '<details class="swing_faq__item" [open]><summary class="swing_faq__q"><span>{question}</span><i chevron-down 16></i></summary><p class="swing_faq__a">{answer}</p></details> in .swing_faq (white, light-500 line, radius 16, 0 / 24). Line under each item; set the last instance\'s bottom stroke to 0. open=true: question purple-500, chevron turned, answer shown (right padding 28 = 16 + 12). ads=true = .swing_faq_ads (Swing Pass): the ADS chevron in dark-200.';
  }, { description: 'A FAQ question that opens to its answer.', variants: V });
}

async function buildReferEarnScreen(R, notes) {
  var PG = RE_PAGE;
  var page = await pageNamed(PG);
  var appBar = await setWith('AppBar', 'AppBar', buildAppBarPage, R, notes, 'type=centerCountry, scrolled=false');
  var BT = byName(await setFrom('Button', 'Button', buildButton, R, notes));
  var CP = byName(await setFrom('Caption', 'Caption', buildCaptionPage, R, notes));
  var DV = byName(await setFrom('Divider', 'Divider', buildDividerPage, R, notes));
  var P = { code: await setFrom('CodeCard', 'CodeCard', buildCodeCardPage, R, notes), stat: byName(await setWith('StatPanel', 'StatPanel', buildStatPanelPage, R, notes, 'zero=true')),
    step: byName(await setWith('StepCard', 'StepCard', buildStepCardPage, R, notes, 'step=4')), faq: byName(await setWith('FaqItem', 'FaqItem', buildFaqItemPage, R, notes, 'open=true, ads=true')) };
  var chevR = await iconOrPlaceholder('Icon/Line/chevron-right', page, notes);

  var old = page.findChild(function (n) { return n.type === 'FRAME' && n.name === 'Refer & earn'; });
  var keepX = old ? old.x : 0, keepY = old ? old.y : 0;
  if (old) old.remove();
  var scr = figma.createFrame(); page.appendChild(scr);
  scr.name = 'Refer & earn'; scr.x = keepX; scr.y = keepY;
  scr.layoutMode = 'VERTICAL'; scr.resize(390, 844); scr.layoutSizingHorizontal = 'FIXED'; scr.layoutSizingVertical = 'HUG'; scr.minHeight = 844;
  scr.itemSpacing = 0; scr.clipsContent = true; scr.fills = paintFor(R, '--light-100');
  var bar = byName(appBar)['type=centerCountry, scrolled=false'].createInstance(); scr.appendChild(bar); bar.layoutSizingHorizontal = 'FILL';
  setText(bar, { title: 'Refer & earn', showActions: true });
  // main: hero art full width (375 x 250 scaled to 390), then .page--lift: its first child rides 48 up onto the art (negative gap)
  var main = autoFrame('main', 'VERTICAL', scr); fillHug(main); main.itemSpacing = -48;
  await refArt(R, main, 'ref/img/referral-illo.svg?v=2', 390, 260, 'hero-illo', notes);
  var pg = autoFrame('page', 'VERTICAL', main); fillHug(pg); padX(R, pg);
  pg.paddingTop = 0; bindNumber(R, pg, 'paddingBottom', '--space-32', 32); bindNumber(R, pg, 'itemSpacing', '--gap-section', 32);
  var cc = P.code.children[0].createInstance(); pg.appendChild(cc); cc.layoutSizingHorizontal = 'FILL';
  async function txt(parent, style, color, chars, name) {
    var t = await styledText(R, style, color, chars); parent.appendChild(t); t.name = name; t.textAutoResize = 'HEIGHT'; t.layoutSizingHorizontal = 'FILL'; return t;
  }
  function stack(name) { var s = autoFrame(name, 'VERTICAL', pg); fillHug(s); bindNumber(R, s, 'itemSpacing', '--gap-group', 16); return s; }
  function divider() { var d = DV['type=line'].createInstance(); pg.appendChild(d); d.layoutSizingHorizontal = 'FILL'; return d; }
  // 1. Referral tracker
  var s1 = stack('tracker');
  await txt(s1, '--type-h5', '--dark-300', 'Referral tracker', 'section-title');
  var rel = autoFrame('stats', 'VERTICAL', s1); fillHug(rel); rel.counterAxisAlignItems = 'CENTER'; bindNumber(R, rel, 'itemSpacing', '--gap-related', 8);
  var st = P.stat['zero=true'].createInstance(); rel.appendChild(st); st.layoutSizingHorizontal = 'FILL';
  setText(st, { value1: '0', label1: 'Joined Swing', value2: '0', label2: 'Made first booking' });
  var cap = CP['tone=neutral, size=s'].createInstance(); rel.appendChild(cap);   // .center-self
  setText(cap, { text: 'First booking counts only after status is finished.' });
  var tr = BT['size=s, tone=primary, appearance=tertiary, state=default'].createInstance(); s1.appendChild(tr); tr.layoutSizingHorizontal = 'FILL';
  setText(tr, { label: 'Track my referrals', showIconStart: false, showIconEnd: true, iconEnd: chevR.id });
  await txt(s1, '--type-b2', '--dark-500', 'See how many of your friends have joined Swing and made first booking using your referral code. You can even remind them!', 'b2');
  divider();
  // 2. How it works: a rail of 4 step cards 32 apart, a 2px line through the art middle, clipped at the screen edge
  var s2 = stack('how-it-works');
  await txt(s2, '--type-h5', '--dark-300', 'How our referral works', 'section-title');
  var rail = autoFrame('step-rail', 'HORIZONTAL', s2); fillHug(rail); rail.clipsContent = false; bindNumber(R, rail, 'itemSpacing', '--space-32', 32);
  var line = figma.createRectangle(); rail.appendChild(line); line.name = 'line'; line.layoutPositioning = 'ABSOLUTE';
  line.resize(4 * 168 + 3 * 32, 2); line.x = 0; line.y = 31; line.fills = paintFor(R, '--light-500');
  RE_STEPS.forEach(function (x, i) { var c = P.step['step=' + (i + 1)].createInstance(); rail.appendChild(c); setText(c, { title: x[0], body: x[1] }); });
  divider();
  // 3. FAQ: .faq white box, light-500 line, radius 16, 0 / 24; first item open
  var s3 = stack('faqs');
  await txt(s3, '--type-h5', '--dark-300', 'FAQs about referral', 'section-title');
  var fq = autoFrame('faq', 'VERTICAL', s3); fillHug(fq); bindNumber(R, fq, 'paddingLeft', '--space-24', 24); bindNumber(R, fq, 'paddingRight', '--space-24', 24);
  bindRadius(R, fq, '--radius-16', 16); fq.fills = paintFor(R, '--light-100'); fq.strokes = paintFor(R, '--light-500'); fq.strokeWeight = 1; fq.strokeAlign = 'INSIDE';
  RE_FAQ.forEach(function (x, i) {
    var it = P.faq[i ? 'open=false, ads=false' : 'open=true, ads=false'].createInstance(); fq.appendChild(it); it.layoutSizingHorizontal = 'FILL';
    setText(it, { question: x[0], answer: x[1] });
    if (i === RE_FAQ.length - 1) it.strokeBottomWeight = 0;   // .faq__item:last-child
  });
  // .bottom-bar: note B3s dark-300 + block Button l
  var bb = autoFrame('bottom-bar', 'VERTICAL', scr); fillHug(bb); padX(R, bb);
  bindNumber(R, bb, 'paddingTop', '--space-16', 16); bindNumber(R, bb, 'paddingBottom', '--space-32', 32); bindNumber(R, bb, 'itemSpacing', '--gap-related', 8);
  bb.fills = paintFor(R, '--light-100');
  var up = lineBelow(R)[0]; if (up) bb.effects = [Object.assign({}, up, { offset: { x: 0, y: -1 } })];
  await txt(bb, '--type-b3s', '--dark-300', 'See how many of your friends have download and booked using your referral code. You can even remind them!', 'note');
  var tb = BT['size=l, tone=primary, appearance=solid, state=default'].createInstance(); bb.appendChild(tb); tb.layoutSizingHorizontal = 'FILL';
  setText(tb, { label: 'Track my referral', showIconStart: false, showIconEnd: false });

  var one = function (m, props) { var i = m.createInstance(); if (props) setText(i, props); return i; };
  await screenList(R, page, scr, 'Refer & earn', async function (row) {
    await row('AppBar', partSrc('AppBar', PG) + ' · type=centerCountry: DS back, centred title, country button', [one(byName(appBar)['type=centerCountry, scrolled=false'], { title: 'Refer & earn', showActions: true })]);
    await row('CodeCard', partSrc('CodeCard', PG) + ' · rewards + referral code, Copy and Share (Button s)', [P.code]);
    await row('StatPanel', partSrc('StatPanel', PG) + ' · zero=true here (values dark-100)', [one(P.stat['zero=true']), one(P.stat['zero=false'])]);
    await row('Caption', partSrc('Caption', PG) + ' · tone=neutral, size=s, centred', [one(CP['tone=neutral, size=s'], { text: 'First booking counts only after status is finished.' })]);
    await row('StepCard', partSrc('StepCard', PG) + ' · step=1..4 in a rail, 32 apart', [one(P.step['step=1']), one(P.step['step=4'], { title: RE_STEPS[3][0], body: RE_STEPS[3][1] })]);
    await row('FaqItem', partSrc('FaqItem', PG) + ' · open=true first; the last has no line', [one(P.faq['open=true, ads=false']), one(P.faq['open=false, ads=false'])]);
    await row('Divider', partSrc('Divider', PG) + ' · type=line between sections', [one(DV['type=line'])]);
    await row('Button', partSrc('Button', PG) + ' · s tertiary block + chevron (Track my referrals), l solid in the bottom bar', [one(BT['size=s, tone=primary, appearance=tertiary, state=default'], { label: 'Track my referrals', showIconEnd: true, iconEnd: chevR.id }), one(BT['size=l, tone=primary, appearance=solid, state=default'], { label: 'Track my referral' })]);
  });
  notes.push('Refer & earn: built from stat.chara.id/swing/ref/refer-earn.html. The code card rides 48 up onto the hero art with a negative gap (the web uses margin-top -48); the step rail is clipped at the screen edge instead of scrolling; FAQ items 2 to 5 are closed, as on the web.');
  return { set: scr, count: 8, label: 'screen from 8 parts' };
}

/* ----- IG story (ref/ig-story.html) and the Swing Pass welcome email (ref/swingpass-email.html) ----- */
async function buildCodeHeroPage(R, notes) {
  var ch = {};
  return buildPartPage(R, notes, 'CodeHero', async function (comp, K) {
    // .code-hero: column centred, gap 4, padding 24, radius 16, light-100, Elevation brand; label B2s dark-300, code H1 purple-500
    comp.layoutMode = 'VERTICAL'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(342, 100); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].forEach(function (f) { bindNumber(R, comp, f, '--space-24', 24); });
    bindNumber(R, comp, 'itemSpacing', '--space-4', 4); bindRadius(R, comp, '--radius-16', 16); comp.fills = paintFor(R, '--light-100');
    await effectStyle(R, comp, '--elevation-brand');
    var l = await K.txt(comp, '--type-b2s', '--dark-300', 'Alvin\u2019s referral code', 'label', 'fill'); l.textAlignHorizontal = 'CENTER';
    var c = await K.txt(comp, '--type-h1', '--purple-500', 'ALVLIA123', 'code', 'fill'); c.textAlignHorizontal = 'CENTER';
    ch[comp.name] = { l: l, c: c };
  }, function (s) {
    var pL = ensureProp(s, 'label', 'TEXT', 'Alvin\u2019s referral code'), pC = ensureProp(s, 'code', 'TEXT', 'ALVLIA123');
    wireKeys(ch).forEach(function (k) { ch[k].l.componentPropertyReferences = { characters: pL }; ch[k].c.componentPropertyReferences = { characters: pC }; });
    s.description = '<section class="swing_code_hero"><p class="swing_code_hero__label">…</p><p class="swing_code_hero__code">…</p></section>. Centred, padding 24, gap 4, radius 16, white, Elevation brand; label B2 Semibold dark-300, code H1 purple-500.';
  }, { description: 'A big referral code card for the shared story.' });
}

async function buildKvRowPage(R, notes) {
  var kv = {};
  var V = [{ pay: 'false', name: 'pay=false' }, { pay: 'true', name: 'pay=true' }];
  return buildPartPage(R, notes, 'KvRow', async function (comp, K, pg, v) {
    // .kv: space-between, centred, gap 16; dt B3 Semibold dark-300, dd B3 dark-300 right; .kv__pay: 14 logo (radius 4) + text, gap 8
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER'; comp.primaryAxisAlignItems = 'SPACE_BETWEEN';
    comp.resize(310, 20); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--space-16', 16); comp.fills = [];
    var k = await K.txt(comp, '--type-b3s', '--dark-300', 'Join date', 'key');
    var p = { k: k };
    if (v.pay === 'true') {
      var dd = autoFrame('value', 'HORIZONTAL', comp); hugHug(dd); dd.counterAxisAlignItems = 'CENTER'; bindNumber(R, dd, 'itemSpacing', '--space-8', 8);
      var lg = figma.createRectangle(); dd.appendChild(lg); lg.name = 'logo'; lg.resize(14, 14); bindRadius(R, lg, '--ads-radius-4', 4);
      await refPhoto(R, lg, 'ref/img/sp/ovo.png?v=1', notes);
      p.v = await K.txt(dd, '--type-b3', '--dark-300', 'OVO', 'text');
    } else {
      p.v = await K.txt(comp, '--type-b3', '--dark-300', '01 Jan 2025', 'value'); p.v.textAlignHorizontal = 'RIGHT';
    }
    kv[comp.name] = p;
  }, function (s) {
    var pK = ensureProp(s, 'key', 'TEXT', 'Join date'), pV = ensureProp(s, 'value', 'TEXT', '01 Jan 2025');
    wireKeys(kv).forEach(function (n) { kv[n].k.componentPropertyReferences = { characters: pK }; kv[n].v.componentPropertyReferences = { characters: pV }; });
    s.description = '<div class="swing_kv"><dt>{key}</dt><dd [class="swing_kv__pay"]>{value}</dd></div> in .swing_kv_list (column, gap 8). Space-between, gap 16; key B3 Semibold dark-300, value B3 dark-300 right-aligned. pay=true = .swing_kv__pay: a 14 payment logo (radius 4, replace the image fill) before the value.';
  }, { description: 'A label and value on one line; pay=true adds a payment logo.', variants: V });
}

async function buildIgStoryScreen(R, notes) {
  var PG = 'Screen / IG story';
  var page = await pageNamed(PG);
  var BT = byName(await setFrom('Button', 'Button', buildButton, R, notes));
  var CH = await setFrom('CodeHero', 'CodeHero', buildCodeHeroPage, R, notes);
  var old = page.findChild(function (n) { return n.type === 'FRAME' && n.name === 'IG story'; });
  var keepX = old ? old.x : 0, keepY = old ? old.y : 0;
  if (old) old.remove();
  var scr = figma.createFrame(); page.appendChild(scr);
  scr.name = 'IG story'; scr.x = keepX; scr.y = keepY;
  scr.layoutMode = 'VERTICAL'; scr.resize(390, 844); scr.layoutSizingHorizontal = 'FIXED'; scr.layoutSizingVertical = 'FIXED';
  scr.itemSpacing = 0; scr.clipsContent = true; scr.fills = paintFor(R, '--light-100');
  // main grows so the bottom bar sits at the bottom (.screen min-height 100dvh); hero art, then .page--lift (first child 48 up)
  var main = autoFrame('main', 'VERTICAL', scr); main.layoutSizingHorizontal = 'FILL'; main.layoutSizingVertical = 'FILL'; main.itemSpacing = -48;
  await refArt(R, main, 'ref/img/referral-illo.svg?v=2', 390, 260, 'hero-illo', notes);
  var pg = autoFrame('page', 'VERTICAL', main); fillHug(pg); padX(R, pg);
  pg.paddingTop = 0; bindNumber(R, pg, 'paddingBottom', '--space-32', 32); bindNumber(R, pg, 'itemSpacing', '--gap-section', 32);
  var hero = CH.children[0].createInstance(); pg.appendChild(hero); hero.layoutSizingHorizontal = 'FILL';
  var PT = 'Earn 100,000 Swing Credits together when you join Swing using Alvin\u2019s code and you make the first booking.', EM = 'Earn 100,000 Swing Credits together';
  var pt = await styledText(R, '--type-h5', '--dark-500', PT); pg.appendChild(pt); pt.name = 'promo-text';
  pt.textAutoResize = 'HEIGHT'; pt.layoutSizingHorizontal = 'FILL'; pt.textAlignHorizontal = 'CENTER';
  pt.setRangeFills(0, EM.length, paintFor(R, '--purple-500'));   // .promo-text em
  var bb = autoFrame('bottom-bar', 'VERTICAL', scr); fillHug(bb); padX(R, bb);
  bindNumber(R, bb, 'paddingTop', '--space-16', 16); bindNumber(R, bb, 'paddingBottom', '--space-32', 32); bindNumber(R, bb, 'itemSpacing', '--gap-related', 8);
  bb.fills = paintFor(R, '--light-100');
  var up = lineBelow(R)[0]; if (up) bb.effects = [Object.assign({}, up, { offset: { x: 0, y: -1 } })];
  var jb = BT['size=l, tone=primary, appearance=solid, state=default'].createInstance(); bb.appendChild(jb); jb.layoutSizingHorizontal = 'FILL';
  setText(jb, { label: 'Join Swing with Alvin\u2019s code', showIconStart: false, showIconEnd: false });
  await screenList(R, page, scr, 'IG story', async function (row) {
    await row('CodeHero', partSrc('CodeHero', PG) + ' · the referral code', [CH]);
    await row('Button', partSrc('Button', PG) + ' · size=l primary solid, block, in the bottom bar', [BT['size=l, tone=primary, appearance=solid, state=default'].createInstance()]);
  });
  notes.push('IG story: built from stat.chara.id/swing/ref/ig-story.html. No app bar, as on the web; the code card rides 48 up onto the art with a negative gap.');
  return { set: scr, count: 2, label: 'screen from 2 parts' };
}

async function buildSwingPassEmailScreen(R, notes) {
  var PG = 'Screen / Swing Pass email';
  var page = await pageNamed(PG);
  var BT = byName(await setFrom('Button', 'Button', buildButton, R, notes));
  var DV = byName(await setFrom('Divider', 'Divider', buildDividerPage, R, notes));
  var MF = byName(await setWith('MailFoot', 'MailFoot', buildMailFootPage, R, notes, 'stores=true'));
  var KV = byName(await setWith('KvRow', 'KvRow', buildKvRowPage, R, notes, 'pay=true'));
  var old = page.findChild(function (n) { return n.type === 'FRAME' && n.name === 'Swing Pass email'; });
  var keepX = old ? old.x : 0, keepY = old ? old.y : 0;
  if (old) old.remove();
  var scr = figma.createFrame(); page.appendChild(scr);
  scr.name = 'Swing Pass email'; scr.x = keepX; scr.y = keepY;
  scr.layoutMode = 'VERTICAL'; scr.counterAxisAlignItems = 'CENTER';
  scr.resize(357, 400); scr.layoutSizingHorizontal = 'FIXED'; scr.layoutSizingVertical = 'HUG';
  bindNumber(R, scr, 'paddingTop', '--space-16', 16); bindNumber(R, scr, 'paddingBottom', '--space-16', 16); bindNumber(R, scr, 'itemSpacing', '--space-16', 16);
  scr.fills = paintFor(R, '--light-200');
  await refArt(R, scr, 'ref/img/sp/swing-logo.svg?v=1', 80, 24, 'logo', notes);
  var card = autoFrame('card', 'VERTICAL', scr); fillHug(card);
  // .mail__banner: clip, 32 / 24, gradient-swing-pass; the pass mark (173) sits at top -19, left 208; title H4 white
  var ban = autoFrame('banner', 'VERTICAL', card); fillHug(ban); ban.clipsContent = true;
  bindNumber(R, ban, 'paddingTop', '--space-32', 32); bindNumber(R, ban, 'paddingBottom', '--space-32', 32);
  bindNumber(R, ban, 'paddingLeft', '--space-24', 24); bindNumber(R, ban, 'paddingRight', '--space-24', 24);
  await fillStyle(R, ban, '--gradient-swing-pass', '--purple-500');
  var mk = await refArt(R, ban, 'ref/img/sp/pass-icon-mail.svg?v=1', 173, 173, 'mark', notes);
  mk.layoutPositioning = 'ABSOLUTE'; mk.x = 208; mk.y = -19;
  async function txt(parent, style, color, chars, name) {
    var t = await styledText(R, style, color, chars); parent.appendChild(t); t.name = name; t.textAutoResize = 'HEIGHT'; t.layoutSizingHorizontal = 'FILL'; return t;
  }
  await txt(ban, '--type-h4', '--light-100', 'Tee-off with your new\nSwing Pass membership!', 'title');
  // .mail__body: white, 32 / 24, gap 32, radius 4 on top
  var body = autoFrame('body', 'VERTICAL', card); fillHug(body); body.fills = paintFor(R, '--light-100');
  bindNumber(R, body, 'paddingTop', '--space-32', 32); bindNumber(R, body, 'paddingBottom', '--space-32', 32);
  bindNumber(R, body, 'paddingLeft', '--space-24', 24); bindNumber(R, body, 'paddingRight', '--space-24', 24); bindNumber(R, body, 'itemSpacing', '--space-32', 32);
  ['topLeftRadius', 'topRightRadius'].forEach(function (f) { bindNumber(R, body, f, '--ads-radius-4', 4); });
  function group(name) { var g = autoFrame(name, 'VERTICAL', body); fillHug(g); bindNumber(R, g, 'itemSpacing', '--space-16', 16); return g; }
  var g1 = group('intro');
  await txt(g1, '--type-h6', '--dark-500', 'Hi <First Name>', 'hi');
  await txt(g1, '--type-b2', '--dark-500', 'We are truly excited to have you join Swing Pass and enjoy exclusive rates and free of processing fee, here, there, and everywhere on Swing!', 'text');
  await txt(g1, '--type-b2', '--dark-500', 'Your plan renews every 12 months. It will renew on 01 Jan 2025 at Rp. 2,500,000. Cancel anytime.', 'text');
  // .mail__box: column, gap 16, 32 / 16, light-500 line, radius 4; two .kv-list (gap 8) split by a divider
  var box = autoFrame('box', 'VERTICAL', body); fillHug(box);
  bindNumber(R, box, 'paddingTop', '--space-32', 32); bindNumber(R, box, 'paddingBottom', '--space-32', 32);
  bindNumber(R, box, 'paddingLeft', '--space-16', 16); bindNumber(R, box, 'paddingRight', '--space-16', 16); bindNumber(R, box, 'itemSpacing', '--space-16', 16);
  bindRadius(R, box, '--ads-radius-4', 4); box.strokes = paintFor(R, '--light-500'); box.strokeWeight = 1; box.strokeAlign = 'INSIDE';
  function kvList(rows) {
    var l = autoFrame('kv-list', 'VERTICAL', box); fillHug(l); bindNumber(R, l, 'itemSpacing', '--space-8', 8);
    rows.forEach(function (r) { var i = KV[r[2] ? 'pay=true' : 'pay=false'].createInstance(); l.appendChild(i); i.layoutSizingHorizontal = 'FILL'; setText(i, { key: r[0], value: r[1] }); });
  }
  kvList([['Join date', '01 Jan 2025'], ['Membership ID', '9834G-91H5R']]);
  var d1 = DV['type=line'].createInstance(); box.appendChild(d1); d1.layoutSizingHorizontal = 'FILL';
  kvList([['Billing amount', 'Rp. 2,500,000 / 12 months'], ['Billing method', 'OVO', true]]);
  var g2 = group('benefits');
  await txt(g2, '--type-b2', '--dark-500', 'Discover all your benefits and any other Swing Pass details on the app.', 'text');
  var sb = BT['size=l, tone=primary, appearance=solid, state=default'].createInstance(); g2.appendChild(sb); sb.layoutSizingHorizontal = 'FILL';
  setText(sb, { label: 'See benefits', showIconStart: false, showIconEnd: false });
  var d2 = DV['type=line'].createInstance(); body.appendChild(d2); d2.layoutSizingHorizontal = 'FILL';
  var g3 = group('support');
  var SUP = 'Please do contact our support team if you have any questions about Swing Pass or your plan. You can do so by clicking here.';
  var st = await txt(g3, '--type-b2', '--dark-500', SUP, 'text');
  var at = SUP.lastIndexOf('here');   // .mail__text a: B2 Semibold purple-500
  st.setRangeFills(at, at + 4, paintFor(R, '--purple-500'));
  var b2s = R.text['--type-b2s']; if (b2s) { await figma.loadFontAsync(b2s.fontName); await st.setRangeTextStyleIdAsync(at, at + 4, b2s.id); }
  await txt(g3, '--type-b2', '--dark-500', 'Thank you,\nSwing Team', 'text');
  var ft = MF['stores=true'].createInstance(); scr.appendChild(ft); ft.layoutSizingHorizontal = 'FILL';
  setText(ft, { copyright: 'Copyright \u00a9 2022 PT. Rajawali Lestari Inovasi' });
  await screenList(R, page, scr, 'Swing Pass email', async function (row) {
    await row('KvRow', partSrc('KvRow', PG) + ' · Join date, Membership ID, Billing amount; pay=true for Billing method (OVO logo)', [KV['pay=false'].createInstance(), KV['pay=true'].createInstance()]);
    await row('Divider', partSrc('Divider', PG) + ' · type=line', [DV['type=line'].createInstance()]);
    await row('Button', partSrc('Button', PG) + ' · size=l primary solid, block', [BT['size=l, tone=primary, appearance=solid, state=default'].createInstance()]);
    await row('MailFoot', partSrc('MailFoot', PG) + ' · stores=true', [MF['stores=true'].createInstance()]);
  });
  notes.push('Swing Pass email: built from stat.chara.id/swing/ref/swingpass-email.html. An email: the frame is the 357 mail column. Banner, body text and the box are plain layers; KvRow is the shared UI component.');
  return { set: scr, count: 4, label: 'email from 4 parts' };
}

/* ----- Swing Pass (ref/swingpass-page.html, shared by the member page): PassCard, SaveCard, PayMethod, DealCard, Perk ----- */
var SP_PAGE = 'Screen / Swing Pass';
async function spArt(R, name, size, notes, page, css) { return refIcon(R, 'sp-' + name, 'ref/img/sp/' + name + '.svg?v=1', size, css || null, notes, page); }

async function buildPassCardPage(R, notes) {
  var pc = {};
  var V = [{ enlarge: 'true', name: 'enlarge=true' }, { enlarge: 'false', name: 'enlarge=false' }];
  return buildPartPage(R, notes, 'PassCard', async function (comp, K, pg, v) {
    // .pass-card: 208 tall, 24 padding (.pass-card--enlarge: 38 bottom for the floating button), radius 8, glass fill, inner 1px glass line,
    // Elevation pass card, clipped; the 360 pass mark at top -76, left 48; top row: wordmark 126 x 24 + BETA badge; who: photo 48 + name H5 + meta B4s
    comp.layoutMode = 'VERTICAL'; comp.primaryAxisAlignItems = 'SPACE_BETWEEN';
    comp.resize(342, 208); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'FIXED';
    ['paddingTop', 'paddingRight', 'paddingLeft'].forEach(function (f) { bindNumber(R, comp, f, '--space-24', 24); });
    if (v.enlarge === 'true') comp.paddingBottom = 38; else bindNumber(R, comp, 'paddingBottom', '--space-24', 24);
    bindRadius(R, comp, '--radius-8', 8); comp.clipsContent = true;
    await fillStyle(R, comp, '--glass-fill', null);
    comp.strokes = paintFor(R, '--glass-line'); comp.strokeWeight = 1; comp.strokeAlign = 'INSIDE';
    await effectStyle(R, comp, '--elevation-pass-card');
    var mk = await refArt(R, comp, 'ref/img/sp/pass-icon.svg?v=1', 360, 360, 'mark', notes);
    mk.layoutPositioning = 'ABSOLUTE'; mk.x = 48; mk.y = -76;
    var top = autoFrame('top', 'HORIZONTAL', comp); fillHug(top); top.counterAxisAlignItems = 'CENTER'; top.primaryAxisAlignItems = 'SPACE_BETWEEN';
    await refArt(R, top, 'ref/img/sp/pass-wordmark.svg?v=1', 126, 24, 'logo', notes);
    var bd = autoFrame('badge', 'HORIZONTAL', top); hugHug(bd);
    bindNumber(R, bd, 'paddingTop', '--space-4', 4); bindNumber(R, bd, 'paddingBottom', '--space-4', 4); bindNumber(R, bd, 'paddingLeft', '--space-8', 8); bindNumber(R, bd, 'paddingRight', '--space-8', 8);
    bindRadius(R, bd, '--radius-full', 9999); bd.fills = paintFor(R, '--dark-400'); bd.strokes = paintFor(R, '--light-100'); bd.strokeWeight = 1; bd.strokeAlign = 'INSIDE';
    var bt = await K.txt(bd, '--type-lbl-s', '--light-100', 'BETA', 'text');
    var who = autoFrame('who', 'HORIZONTAL', comp); fillHug(who); who.counterAxisAlignItems = 'CENTER'; bindNumber(R, who, 'itemSpacing', '--space-16', 16);
    var ph = figma.createRectangle(); who.appendChild(ph); ph.name = 'photo'; ph.resize(48, 48); bindRadius(R, ph, '--radius-8', 8);
    await refPhoto(R, ph, 'ref/img/sp/avatar-rn.jpg?v=1', notes); await effectStyle(R, ph, '--elevation-avatar-l');
    var tx = autoFrame('text', 'VERTICAL', who); tx.layoutSizingHorizontal = 'FILL'; tx.layoutSizingVertical = 'HUG'; bindNumber(R, tx, 'itemSpacing', '--space-4', 4);
    var nm = await K.txt(tx, '--type-h5', '--light-100', 'Ronaldo Nazario', 'name', 'fill');
    var mt = await K.txt(tx, '--type-b4s', '--light-100', 'N235G-4GG34 \u2022 Active until 31 Dec 2025', 'meta', 'fill');
    pc[comp.name] = { bt: bt, nm: nm, mt: mt };
  }, function (s) {
    var pB = ensureProp(s, 'badge', 'TEXT', 'BETA'), pN = ensureProp(s, 'name', 'TEXT', 'Ronaldo Nazario'), pM = ensureProp(s, 'meta', 'TEXT', 'N235G-4GG34 \u2022 Active until 31 Dec 2025');
    wireKeys(pc).forEach(function (k) { pc[k].bt.componentPropertyReferences = { characters: pB }; pc[k].nm.componentPropertyReferences = { characters: pN }; pc[k].mt.componentPropertyReferences = { characters: pM }; });
    s.description = '<div class="swing_pass_card [swing_pass_card_enlarge]">mark, .swing_pass_card__top (wordmark + .swing_pass_card__badge), .swing_pass_card__who (photo 48 + name H5 + meta B4s)</div>. 208 tall, padding 24, radius 8, glass fill + 1px glass line, Elevation pass card, white text; sits on the Swing Pass band. enlarge=true leaves 38 at the bottom for the floating "Enlarge card" button. The web blurs what is behind it (backdrop-filter 100); Figma has no backdrop blur on a fill, so the glass is the gradient only.';
  }, { description: 'The Swing Pass membership card, on the purple band.', variants: V });
}

async function buildSaveCardPage(R, notes) {
  var page = await pageNamed(SP_PAGE);
  var chev = await spArt(R, 'chev-14', 14, notes, page), arrow = await spArt(R, 'arrow-16', 16, notes, page);
  var cg = await spArt(R, 'credits-grey', 16, notes, page), cc = await spArt(R, 'credits', 16, notes, page);
  var sv = {};
  var V = [{ type: 'total', name: 'type=total' }, { type: 'compare', name: 'type=compare' }];
  return buildPartPage(R, notes, 'SaveCard', async function (comp, K, pg, v) {
    // .save-card: clip, light-500 line, radius 16, white, Elevation card s. total: 16/24, label B2s dark-300 + value H2; compare: 16, gap 8,
    // credit columns (amount H6 + 16 mark, label B4; the "on" one dark-500 and B4s) with a 16 arrow; .save-card__link: 16/24, line above, B3s dark-300 + chevron 14
    comp.layoutMode = 'VERTICAL'; comp.resize(342, 140); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG'; comp.itemSpacing = 0;
    comp.clipsContent = true; bindRadius(R, comp, '--radius-16', 16); comp.fills = paintFor(R, '--light-100');
    comp.strokes = paintFor(R, '--light-500'); comp.strokeWeight = 1; comp.strokeAlign = 'INSIDE';
    await effectStyle(R, comp, '--elevation-card-s');
    var p = {};
    if (v.type === 'total') {
      var top = autoFrame('top', 'VERTICAL', comp); fillHug(top); bindNumber(R, top, 'itemSpacing', '--space-4', 4);
      bindNumber(R, top, 'paddingTop', '--space-16', 16); bindNumber(R, top, 'paddingBottom', '--space-16', 16); bindNumber(R, top, 'paddingLeft', '--space-24', 24); bindNumber(R, top, 'paddingRight', '--space-24', 24);
      p.lb = await K.txt(top, '--type-b2s', '--dark-300', 'Since 01 Jan 2025, you\u2019ve saved', 'label', 'fill');
      p.val = await K.txt(top, '--type-h2', '--dark-500', 'Rp. 50,000,000', 'value', 'fill');
    } else {
      var cmp = autoFrame('compare', 'HORIZONTAL', comp); fillHug(cmp); cmp.counterAxisAlignItems = 'CENTER'; bindNumber(R, cmp, 'itemSpacing', '--space-8', 8);
      ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].forEach(function (f) { bindNumber(R, cmp, f, '--space-16', 16); });
      async function col(on, amt, lab) {
        var c = autoFrame(on ? 'with' : 'without', 'VERTICAL', cmp); c.layoutSizingHorizontal = 'FILL'; c.layoutSizingVertical = 'HUG'; c.counterAxisAlignItems = 'CENTER'; c.itemSpacing = 2;
        var a = autoFrame('amount', 'HORIZONTAL', c); hugHug(a); a.counterAxisAlignItems = 'CENTER'; bindNumber(R, a, 'itemSpacing', '--space-4', 4);
        var m = (on ? cc : cg).createInstance(); a.appendChild(m); m.name = 'credits'; m.resize(16, 16);
        var at = await K.txt(a, '--type-h6', on ? '--dark-500' : '--dark-300', amt, 'value');
        var lt = await K.txt(c, on ? '--type-b4s' : '--type-b4', on ? '--dark-500' : '--dark-300', lab, 'label', 'fill'); lt.textAlignHorizontal = 'CENTER';
        return [at, lt];
      }
      p.off = await col(false, '5,000,000', 'Without Swing Pass');
      var ar = arrow.createInstance(); cmp.appendChild(ar); ar.name = 'arrow'; ar.resize(16, 16);
      p.on = await col(true, '10,000,000', 'With Swing Pass');
    }
    var ln = autoFrame('link', 'HORIZONTAL', comp); fillHug(ln); ln.counterAxisAlignItems = 'CENTER'; bindNumber(R, ln, 'itemSpacing', '--space-16', 16);
    bindNumber(R, ln, 'paddingTop', '--space-16', 16); bindNumber(R, ln, 'paddingBottom', '--space-16', 16); bindNumber(R, ln, 'paddingLeft', '--space-24', 24); bindNumber(R, ln, 'paddingRight', '--space-24', 24);
    ln.strokes = paintFor(R, '--light-500'); ln.strokeAlign = 'INSIDE'; ln.strokeTopWeight = 1; ln.strokeRightWeight = 0; ln.strokeBottomWeight = 0; ln.strokeLeftWeight = 0;
    p.link = await K.txt(ln, '--type-b3s', '--dark-300', v.type === 'total' ? 'See how you\u2019ve saved this much' : 'See how you\u2019ve earned 5,000,000 more with Swing Pass since 01 Jan 2025.', 'text', 'fill');
    var ci = chev.createInstance(); ln.appendChild(ci); ci.name = 'chevron'; ci.resize(14, 14);
    sv[comp.name] = p;
  }, function (s) {
    var pL = ensureProp(s, 'label', 'TEXT', 'Since 01 Jan 2025, you\u2019ve saved'), pV = ensureProp(s, 'value', 'TEXT', 'Rp. 50,000,000'), pK = ensureProp(s, 'link', 'TEXT', 'See how you\u2019ve saved this much');
    var pO = ensureProp(s, 'without', 'TEXT', '5,000,000'), pW = ensureProp(s, 'with', 'TEXT', '10,000,000');
    wireKeys(sv).forEach(function (k) {
      var p = sv[k]; p.link.componentPropertyReferences = { characters: pK };
      if (p.lb) { p.lb.componentPropertyReferences = { characters: pL }; p.val.componentPropertyReferences = { characters: pV }; }
      if (p.off) { p.off[0].componentPropertyReferences = { characters: pO }; p.on[0].componentPropertyReferences = { characters: pW }; }
    });
    s.description = '<div class="swing_save_card">.swing_save_card__top (label B2s + value H2) or .swing_save_card__compare (.swing_credit_col ×2 + arrow 16), then .swing_save_card__link</div>. Clip, light-500 line, radius 16, white, Elevation card s. type=total = how much was saved; type=compare = credits without vs with Swing Pass (the second column is .swing_credit_col_on, dark-500).';
  }, { description: 'Swing Pass savings: a total, or credits without vs with the pass.', variants: V });
}

async function buildPayMethodPage(R, notes) {
  var BT = byName(await setFrom('Button', 'Button', buildButton, R, notes));
  var pm = {};
  var icon = await refLogo(R, 'price-tag', 'ref/img/sp/price-tag.svg?v=1', 22, 22, notes, await pageNamed(SPJ_PAGE));
  // type=billing: wallet logo + amount + renewal line + Manage (Swing Pass page); type=action: a 22 icon + one name + a button (Join: promo code, billing method)
  var V = [{ type: 'billing', name: 'type=billing', legacy: 'type=default' }, { type: 'action', name: 'type=action' }];
  return buildPartPage(R, notes, 'PayMethod', async function (comp, K, pg, v) {
    var act = v && v.type === 'action';
    // .pay-method.pay-method--l: light-200, radius 16, 12/16, gap 14; logo 22; name B2s dark-500 + sub B3 dark-300 (gap 2); Button s tertiary
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(342, 64); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'paddingTop', '--space-12', 12); bindNumber(R, comp, 'paddingBottom', '--space-12', 12); bindNumber(R, comp, 'paddingLeft', '--space-16', 16); bindNumber(R, comp, 'paddingRight', '--space-16', 16);
    bindNumber(R, comp, 'itemSpacing', '--ads-gap-14', 14); bindRadius(R, comp, '--radius-16', 16); comp.fills = paintFor(R, '--light-200');
    var lg;
    if (act) { lg = icon.createInstance(); comp.appendChild(lg); lg.name = 'icon'; }
    else { lg = figma.createRectangle(); comp.appendChild(lg); lg.name = 'logo'; lg.resize(22, 22); await refPhoto(R, lg, 'ref/img/sp/ovo.png?v=1', notes); }
    var tx = autoFrame('text', 'VERTICAL', comp); tx.layoutSizingHorizontal = 'FILL'; tx.layoutSizingVertical = 'HUG'; tx.itemSpacing = 2;
    var nm = await K.txt(tx, '--type-b2s', '--dark-500', act ? 'Swing Pass promo code' : 'Rp. 2,500,000 / 12 months', 'name', 'fill');
    var sb = act ? null : await K.txt(tx, '--type-b3', '--dark-300', 'Renews on 01 Jan 2026', 'sub', 'fill');
    var b = BT['size=s, tone=primary, appearance=tertiary, state=default'].createInstance(); comp.appendChild(b); b.name = 'action';
    setText(b, { label: act ? 'Add' : 'Manage', showIconStart: false, showIconEnd: false });
    pm[comp.name] = { nm: nm, sb: sb, b: b, ic: act ? lg : null };
  }, function (s) {
    var pN = ensureProp(s, 'name', 'TEXT', 'Rp. 2,500,000 / 12 months'), pS = ensureProp(s, 'sub', 'TEXT', 'Renews on 01 Jan 2026'), pA = ensureProp(s, 'showAction', 'BOOLEAN', true);
    var pI = ensureProp(s, 'icon', 'INSTANCE_SWAP', icon.id);
    wireKeys(pm).forEach(function (k) { var x = pm[k]; x.nm.componentPropertyReferences = { characters: pN }; if (x.sb) x.sb.componentPropertyReferences = { characters: pS }; x.b.componentPropertyReferences = { visible: pA }; if (x.ic) x.ic.componentPropertyReferences = { mainComponent: pI }; });
    s.description = '<div class="swing_pay_method swing_pay_method_l"><img 22><span class="swing_pay_method__text"><span class="swing_pay_method__name">…</span><span class="swing_pay_method__sub">…</span></span><button class="swing_btn swing_btn_s swing_btn_tertiary">Manage</button></div>. light-200, radius 16, 12/16, gap 14. Replace the image fill on "logo" for another wallet; the button label is on the Button instance.';
  }, { variants: V,  description: 'The billing method row with its renewal line and a Manage button.' });
}

async function buildDealCardPage(R, notes) {
  var page = await pageNamed(SP_PAGE);
  var IC = { range: await spArt(R, 'golf-stick', 10, notes, page), teetime: await spArt(R, 'golf', 10, notes, page) };
  var dc = {};
  var V = [{ kind: 'range', name: 'kind=range' }, { kind: 'teetime', name: 'kind=teetime' }];
  return buildPartPage(R, notes, 'DealCard', async function (comp, K, pg, v) {
    // .deal-card: 160 x 240, padding 16, radius 16, clip, photo cover + deal scrim; tag (4/8, radius full, dark-400, Elevation tag l, B4s, icon 10) on top;
    // title H6 (2 lines, 36) + meta B4s at the bottom; text light-100
    comp.layoutMode = 'VERTICAL'; comp.primaryAxisAlignItems = 'SPACE_BETWEEN';
    comp.resize(160, 240); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'FIXED';
    ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].forEach(function (f) { bindNumber(R, comp, f, '--space-16', 16); });
    bindRadius(R, comp, '--radius-16', 16); comp.clipsContent = true; comp.fills = paintFor(R, '--purple-500');
    var ph = figma.createRectangle(); comp.appendChild(ph); ph.name = 'photo'; ph.layoutPositioning = 'ABSOLUTE'; ph.resize(160, 240); ph.x = 0; ph.y = 0;
    ph.constraints = { horizontal: 'STRETCH', vertical: 'STRETCH' };
    await refPhoto(R, ph, 'ref/img/sp/deal-' + (v.kind === 'range' ? 1 : 2) + '.jpg?v=1', notes);
    var sc = figma.createRectangle(); comp.appendChild(sc); sc.name = 'scrim'; sc.layoutPositioning = 'ABSOLUTE'; sc.resize(160, 240); sc.x = 0; sc.y = 0;
    sc.constraints = { horizontal: 'STRETCH', vertical: 'STRETCH' };
    await fillStyle(R, sc, '--deal-scrim', null);
    var tg = autoFrame('tag', 'HORIZONTAL', comp); hugHug(tg); tg.counterAxisAlignItems = 'CENTER'; bindNumber(R, tg, 'itemSpacing', '--space-4', 4);
    bindNumber(R, tg, 'paddingTop', '--space-4', 4); bindNumber(R, tg, 'paddingBottom', '--space-4', 4); bindNumber(R, tg, 'paddingLeft', '--space-8', 8); bindNumber(R, tg, 'paddingRight', '--space-8', 8);
    bindRadius(R, tg, '--radius-full', 9999); tg.fills = paintFor(R, '--dark-400'); await effectStyle(R, tg, '--elevation-tag-l');
    var ti = IC[v.kind].createInstance(); tg.appendChild(ti); ti.name = 'icon'; ti.resize(10, 10);
    var tt = await K.txt(tg, '--type-b4s', '--light-100', v.kind === 'range' ? 'Driving range' : 'Tee time', 'label');
    var tx = autoFrame('text', 'VERTICAL', comp); fillHug(tx); bindNumber(R, tx, 'itemSpacing', '--space-4', 4);
    var t = await K.txt(tx, '--type-h6', '--light-100', v.kind === 'range' ? 'Power Golf Swing Zone 50% Off' : 'Suvarna Jakarta Golf Club 50% Off', 'title', 'fill');
    t.textAutoResize = 'NONE'; t.resize(128, 36); t.layoutSizingHorizontal = 'FILL'; t.textTruncation = 'ENDING'; t.maxLines = 2;
    var mt = await K.txt(tx, '--type-b4s', '--light-100', 'Mon - Sun. 08:00 - 23:00.', 'meta', 'fill');
    dc[comp.name] = { tt: tt, t: t, mt: mt };
  }, function (s) {
    var pT = ensureProp(s, 'title', 'TEXT', 'Power Golf Swing Zone 50% Off'), pM = ensureProp(s, 'meta', 'TEXT', 'Mon - Sun. 08:00 - 23:00.');
    wireKeys(dc).forEach(function (k) { dc[k].t.componentPropertyReferences = { characters: pT }; dc[k].mt.componentPropertyReferences = { characters: pM }; });
    s.description = '<a class="swing_deal_card"><img class="swing_deal_card__img"><span class="swing_deal_card__tag"><img 10>{kind}</span><span class="swing_deal_card__text"><span class="swing_deal_card__title">…</span><span class="swing_deal_card__meta">…</span></span></a> in .swing_deal_rail (gap 8, centred first card). 160 x 240, padding 16, radius 16, photo + deal scrim, white text. kind = the tag (Driving range / Tee time). Replace the image fill on "photo" per deal.';
  }, { description: 'A Swing Pass deal: photo, kind tag, title and hours.', variants: V });
}

var SP_PERKS = ['b-discount', 'b-mail', 'b-add', 'b-credits'];
async function buildPerkPage(R, notes) {
  var page = await pageNamed(SP_PAGE);
  var ics = []; for (var n of SP_PERKS) ics.push(await spArt(R, n, 24, notes, page));
  var pk = {};
  return buildPartPage(R, notes, 'Perk', async function (comp, K) {
    // .perk: centred, gap 16; icon tile 40, radius 8, purple-50 with the 24 perk art; title B2s dark-500, desc B3 dark-300, gap 4
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(294, 48); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--space-16', 16); comp.fills = [];
    var tile = autoFrame('icon', 'HORIZONTAL', comp); tile.primaryAxisAlignItems = 'CENTER'; tile.counterAxisAlignItems = 'CENTER';
    tile.resize(40, 40); tile.layoutSizingHorizontal = 'FIXED'; tile.layoutSizingVertical = 'FIXED'; bindRadius(R, tile, '--radius-8', 8); tile.fills = paintFor(R, '--purple-50');
    var ic = ics[0].createInstance(); tile.appendChild(ic); ic.name = 'art'; ic.resize(24, 24);
    var tx = autoFrame('text', 'VERTICAL', comp); tx.layoutSizingHorizontal = 'FILL'; tx.layoutSizingVertical = 'HUG'; bindNumber(R, tx, 'itemSpacing', '--space-4', 4);
    var t = await K.txt(tx, '--type-b2s', '--dark-500', '0% processing fee', 'title', 'fill');
    var d = await K.txt(tx, '--type-b3', '--dark-300', 'If you\u2019re Swing Pass member, you won\u2019t be charged with any processing fees.', 'desc', 'fill');
    pk[comp.name] = { ic: ic, t: t, d: d };
  }, function (s) {
    var pI = ensureProp(s, 'icon', 'INSTANCE_SWAP', ics[0].id), pT = ensureProp(s, 'title', 'TEXT', '0% processing fee'), pD = ensureProp(s, 'desc', 'TEXT', 'If you\u2019re Swing Pass member, you won\u2019t be charged with any processing fees.');
    wireKeys(pk).forEach(function (k) { pk[k].ic.componentPropertyReferences = { mainComponent: pI }; pk[k].t.componentPropertyReferences = { characters: pT }; pk[k].d.componentPropertyReferences = { characters: pD }; });
    s.description = '<div class="swing_perk"><span class="swing_perk__icon"><i style="--perk:url(b-*.svg)"></i></span><span class="swing_perk__text"><span class="swing_perk__title">…</span><span class="swing_perk__desc">…</span></span></div> in .swing_perk_list (white, line, radius 16, padding 24, gap 24, dividers between). The web paints the perk art with the Swing Pass gradient through a mask; here the art keeps its own colours (Icon/Ref/sp-b-*), swap it with the icon property.';
  }, { description: 'A Swing Pass benefit: icon tile, title, description.' });
}

var SP_DEALS = [['range', 'Power Golf Swing Zone 50% Off'], ['teetime', 'Suvarna Jakarta Golf Club 50% Off'], ['range', 'Sedayu Indo Golf  Swing Zone 50% Off'], ['teetime', 'Gading Raya Golf Club 30% Off'],
  ['teetime', 'Imperial Klub Golf Club 30% Off'], ['range', 'Club de Arjuna 50% Off'], ['teetime', 'Modern Golf & Country Club 50% Off'], ['range', 'Albatross QCorner 50% Off'], ['range', 'Topgolf Jakarta 50% Off']];
var SP_PERK_TEXT = [['b-discount', '0% processing fee', 'If you\u2019re Swing Pass member, you won\u2019t be charged with any processing fees.'],
  ['b-mail', 'Invite access', 'Get the chance to be invited to private events only for Swing Pass members.'],
  ['b-add', 'And more benefits in the future', 'We\u2019ll add more benefits exclusive only to Swing Pass members in the future.'],
  ['b-credits', 'Earn more Swing Credits', 'Swing Pass member earns up to 10% more credits than regular users.']];
var SP_LOREM = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.';

// Shared by Swing Pass and Swing Pass member: band (AppBar adsInverse, pass card + Enlarge, total SaveCard), then the white sections.
async function spBuild(R, notes, opt) {
  var PG = opt.page, page = await pageNamed(PG);
  var appBar = byName(await setWith('AppBar', 'AppBar', buildAppBarPage, R, notes, 'type=adsInverse, scrolled=false'));
  var BT = byName(await setWith('Button', 'Button', buildButton, R, notes, 'size=s, tone=pass, appearance=solid, state=default'));
  var DV = byName(await setFrom('Divider', 'Divider', buildDividerPage, R, notes));
  var DOT = byName(await setFrom('Pagination', 'Dot', buildPaginationPage, R, notes));
  var P = { card: byName(await setWith('PassCard', 'PassCard', buildPassCardPage, R, notes, 'enlarge=true')), save: byName(await setWith('SaveCard', 'SaveCard', buildSaveCardPage, R, notes, 'type=compare')),
    pay: await setWith('PayMethod', 'PayMethod', buildPayMethodPage, R, notes, 'type=billing'), deal: byName(await setWith('DealCard', 'DealCard', buildDealCardPage, R, notes, 'kind=teetime')),
    perk: await setFrom('Perk', 'Perk', buildPerkPage, R, notes), faq: byName(await setWith('FaqItem', 'FaqItem', buildFaqItemPage, R, notes, 'open=true, ads=true')) };
  var pkIcons = {}; for (var n of SP_PERKS) pkIcons[n] = await spArt(R, n, 24, notes, page);
  var chevW = await spArt(R, 'chev-w-14', 14, notes, page);
  var old = page.findChild(function (n) { return n.type === 'FRAME' && n.name === opt.frame; });
  var keepX = old ? old.x : 0, keepY = old ? old.y : 0;
  if (old) old.remove();
  var scr = figma.createFrame(); page.appendChild(scr);
  scr.name = opt.frame; scr.x = keepX; scr.y = keepY;
  scr.layoutMode = 'VERTICAL'; scr.resize(390, 844); scr.layoutSizingHorizontal = 'FIXED'; scr.layoutSizingVertical = 'HUG'; scr.minHeight = 844;
  scr.clipsContent = true; scr.fills = paintFor(R, '--light-200');
  // the total SaveCard hangs 66 below the band (margin-bottom -66) and the band stays on top: negative gap, first item drawn last
  scr.itemSpacing = -66; scr.itemReverseZIndex = true;
  var band = autoFrame('pass-band', 'VERTICAL', scr); fillHug(band); band.clipsContent = false;
  await fillStyle(R, band, '--gradient-swing-pass', '--purple-500');
  var bar = appBar['type=adsInverse, scrolled=false'].createInstance(); band.appendChild(bar); bar.layoutSizingHorizontal = 'FILL';
  setText(bar, { title: 'Swing Pass', showActions: true });
  var body = autoFrame('pass-band-body', 'VERTICAL', band); fillHug(body); padX(R, body); bindNumber(R, body, 'paddingTop', '--space-32', 32); bindNumber(R, body, 'itemSpacing', '--space-32', 32);
  var wrap = autoFrame('pass-card-wrap', 'VERTICAL', body); fillHug(wrap); wrap.clipsContent = false;
  var pc = P.card['enlarge=true'].createInstance(); wrap.appendChild(pc); pc.layoutSizingHorizontal = 'FILL';
  if (opt.card) setText(pc, opt.card);
  var en = BT['size=s, tone=glass, appearance=solid, state=default'].createInstance(); wrap.appendChild(en); en.name = 'Enlarge card';
  setText(en, { label: 'Enlarge card', showIconStart: false, showIconEnd: false });
  en.layoutPositioning = 'ABSOLUTE'; en.x = Math.round((342 - en.width) / 2); en.y = 208 + 8 - en.height;   // .pass-card__enlarge: bottom -8, centred
  var tot = P.save['type=total'].createInstance(); body.appendChild(tot); tot.layoutSizingHorizontal = 'FILL';
  var main = autoFrame('sections', 'VERTICAL', scr); fillHug(main); bindNumber(R, main, 'itemSpacing', '--space-4', 4); bindNumber(R, main, 'paddingBottom', '--space-4', 4);
  main.fills = paintFor(R, '--light-200');
  function section(name, top) {
    var s = autoFrame(name, 'VERTICAL', main); fillHug(s); padX(R, s); s.fills = paintFor(R, '--light-100');
    if (top === 32) bindNumber(R, s, 'paddingTop', '--space-32', 32); else s.paddingTop = top;
    bindNumber(R, s, 'paddingBottom', '--space-32', 32); bindNumber(R, s, 'itemSpacing', '--space-16', 16); return s;
  }
  async function title(parent, t, center) {   // .section-title--dark (H5 dark-500), --center
    var x = await styledText(R, '--type-h5', '--dark-500', t); parent.appendChild(x); x.name = 'section-title'; x.textAutoResize = 'HEIGHT'; x.layoutSizingHorizontal = 'FILL';
    if (center) x.textAlignHorizontal = 'CENTER'; return x;
  }
  // .page--after-band: 80 top (64 + 16) to clear the hanging card
  var s1 = section('after-band', 80);
  var cm = P.save['type=compare'].createInstance(); s1.appendChild(cm); cm.layoutSizingHorizontal = 'FILL';
  var pm = byName(P.pay)['type=billing'].createInstance(); s1.appendChild(pm); pm.layoutSizingHorizontal = 'FILL';
  if (opt.pay) setText(pm, opt.pay);
  if (opt.afterPay) await opt.afterPay(s1);
  // deals: the rail runs edge to edge with the first card centred (padding 50% - 80 + page-x = 115), dots, a centred pass button
  var s2 = section('deals', 32); s2.paddingLeft = 0; s2.paddingRight = 0; s2.counterAxisAlignItems = 'CENTER';
  var tw = autoFrame('title', 'VERTICAL', s2); fillHug(tw); padX(R, tw);
  await title(tw, 'Exclusive discounts only for\nSwing Pass members', true);
  var rail = autoFrame('deal-rail', 'HORIZONTAL', s2); fillHug(rail); rail.paddingLeft = 115; bindNumber(R, rail, 'itemSpacing', '--space-8', 8); rail.clipsContent = true;
  SP_DEALS.forEach(function (d, i) {
    var c = P.deal['kind=' + d[0]].createInstance(); rail.appendChild(c); setText(c, { title: d[1], meta: 'Mon - Sun. 08:00 - 23:00.' });
  });
  var dots = autoFrame('dots', 'HORIZONTAL', s2); hugHug(dots); bindNumber(R, dots, 'itemSpacing', '--gap-tight', 4);
  for (var di = 0; di < SP_DEALS.length; di++) { var dt = DOT['active=' + (di ? 'false' : 'true') + ', onMedia=false'].createInstance(); dots.appendChild(dt); }
  var sa = BT['size=s, tone=pass, appearance=solid, state=default'].createInstance(); s2.appendChild(sa);
  setText(sa, { label: 'See all exclusive discounts', showIconStart: false, showIconEnd: true, iconEnd: chevW.id });
  // perks: two lists
  async function perkList(parent, rows, btn) {
    var l = autoFrame('perk-list', 'VERTICAL', parent); fillHug(l); bindNumber(R, l, 'itemSpacing', '--space-24', 24);
    ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].forEach(function (f) { bindNumber(R, l, f, '--space-24', 24); });
    bindRadius(R, l, '--radius-16', 16); l.fills = paintFor(R, '--light-100'); l.strokes = paintFor(R, '--light-500'); l.strokeWeight = 1; l.strokeAlign = 'INSIDE';
    rows.forEach(function (r, i) {
      if (i) { var d = DV['type=line'].createInstance(); l.appendChild(d); d.layoutSizingHorizontal = 'FILL'; }
      var host = l;
      if (btn && i === rows.length - 1) { host = autoFrame('last', 'VERTICAL', l); fillHug(host); bindNumber(R, host, 'itemSpacing', '--space-16', 16); }   // .perk-list > .btn: 16 under the last perk
      var pk = P.perk.children[0].createInstance(); host.appendChild(pk); pk.layoutSizingHorizontal = 'FILL';
      setText(pk, { icon: pkIcons[r[0]].id, title: r[1], desc: r[2] });
      if (btn && i === rows.length - 1) {
        var b = BT['size=s, tone=pass, appearance=solid, state=default'].createInstance(); host.appendChild(b); b.layoutSizingHorizontal = 'FILL';
        setText(b, { label: btn, showIconStart: false, showIconEnd: true, iconEnd: chevW.id });
      }
    });
  }
  var s3 = section('perks', 32);
  await title(s3, 'With more perks and benefits to enjoy for members!');
  await perkList(s3, SP_PERK_TEXT, 'See all cashbacks');
  var s4 = section('perks-2', 32);
  await title(s4, 'With more perks and benefits to enjoy for members!');
  await perkList(s4, [SP_PERK_TEXT[0], SP_PERK_TEXT[1], ['b-add', 'And more benefits in the future', 'If you\u2019re Swing Pass member, earn 5% credits from transactions instead of the usual 1%.']]);
  var s5 = section('faqs', 32);
  await title(s5, 'FAQs about Swing Pass');
  var fq = autoFrame('faq', 'VERTICAL', s5); fillHug(fq); bindNumber(R, fq, 'paddingLeft', '--space-24', 24); bindNumber(R, fq, 'paddingRight', '--space-24', 24);
  bindRadius(R, fq, '--radius-16', 16); fq.fills = paintFor(R, '--light-100'); fq.strokes = paintFor(R, '--light-500'); fq.strokeWeight = 1; fq.strokeAlign = 'INSIDE';
  for (var qi = 0; qi < 5; qi++) {
    var it = P.faq[qi ? 'open=false, ads=true' : 'open=true, ads=true'].createInstance(); fq.appendChild(it); it.layoutSizingHorizontal = 'FILL';
    setText(it, { question: 'Question ' + (qi + 1), answer: SP_LOREM }); if (qi === 4) it.strokeBottomWeight = 0;
  }
  var HL = 'Have any other questions? Contact us here.';
  var hl = await styledText(R, '--type-b2', '--dark-300', HL); s5.appendChild(hl); hl.name = 'help-line'; hl.textAutoResize = 'HEIGHT'; hl.layoutSizingHorizontal = 'FILL';
  var ha = HL.indexOf('Contact us here'); hl.setRangeFills(ha, ha + 15, paintFor(R, '--purple-500'));
  var b2s = R.text['--type-b2s']; if (b2s) { await figma.loadFontAsync(b2s.fontName); await hl.setRangeTextStyleIdAsync(ha, ha + 15, b2s.id); }
  if (opt.extra) await opt.extra({ main: main, section: section, title: title, BT: BT, DV: DV });

  var one = function (m, props) { var i = m.createInstance(); if (props) setText(i, props); return i; };
  await screenList(R, page, scr, opt.frame, async function (row) {
    await row('AppBar', partSrc('AppBar', PG) + ' · type=adsInverse: transparent on the band, white title and back, glass country button', [one(appBar['type=adsInverse, scrolled=false'], { title: 'Swing Pass', showActions: true })]);
    await row('PassCard', partSrc('PassCard', PG) + ' · enlarge=true with the floating glass "Enlarge card" Button', [one(P.card['enlarge=true'])]);
    await row('SaveCard', partSrc('SaveCard', PG) + ' · type=total on the band, type=compare below it', [one(P.save['type=total']), one(P.save['type=compare'])]);
    await row('PayMethod', partSrc('PayMethod', PG) + ' · type=billing: amount, renewal, Manage', [byName(P.pay)['type=billing'].createInstance()]);
    await row('DealCard', partSrc('DealCard', PG) + ' · kind=range / kind=teetime, 9 in the rail', [one(P.deal['kind=range']), one(P.deal['kind=teetime'])]);
    await row('Dot', partSrc('Pagination', PG) + ' · 9 dots, the first active', [one(DOT['active=true, onMedia=false']), one(DOT['active=false, onMedia=false'])]);
    await row('Perk', partSrc('Perk', PG) + ' · icon swapped per perk', [P.perk]);
    await row('FaqItem', partSrc('FaqItem', PG) + ' · ads=true (ADS chevron dark-200), the first open', [one(P.faq['open=true, ads=true']), one(P.faq['open=false, ads=true'])]);
    await row('Divider', partSrc('Divider', PG) + ' · type=line between perks', [one(DV['type=line'])]);
    await row('Button', partSrc('Button', PG) + ' · tone=pass s (gradient) with the white chevron; tone=glass s on the band', [one(BT['size=s, tone=pass, appearance=solid, state=default'], { label: 'See all cashbacks', showIconEnd: true, iconEnd: chevW.id }), one(BT['size=s, tone=glass, appearance=solid, state=default'], { label: 'Enlarge card' })]);
    if (opt.rows) await opt.rows(row, one);
  });
  notes.push(opt.frame + ': built from stat.chara.id/swing/ref/' + opt.src + '. Differences: glass has no backdrop blur in Figma; the Enlarge button is glass without the float shadow; inactive dots use the DS dot (the web greys them to dark-500 at 40%); the deal rail is clipped instead of scrolling; the Manage sheet is a state, not drawn.');
  return { scr: scr, page: page };
}
async function buildSwingPassPageScreen(R, notes) {
  var r = await spBuild(R, notes, { page: SP_PAGE, frame: 'Swing Pass', src: 'swingpass-page.html' });
  return { set: r.scr, count: 10, label: 'screen from 10 parts' };
}
// Swing Pass member (cancelled, still active): same page, "Ends on" in the billing row and a note box under it
async function buildSwingPassMemberScreen(R, notes) {
  var page = await pageNamed('Screen / Swing Pass member');
  var info = await spArt(R, 'info-24', 24, notes, page);
  var r = await spBuild(R, notes, { page: 'Screen / Swing Pass member', frame: 'Swing Pass member', src: 'swingpass-member.html',
    pay: { name: 'Rp. 2,500,000 / 12 months', sub: 'Ends on 31 Dec 2025' },
    afterPay: async function (s1) {
      // .note-box: centred, gap 16, padding 16, dark-200 line, radius 16, light-200; B3 dark-500 with the date in B3 Semibold; info 24
      var nb = autoFrame('note-box', 'HORIZONTAL', s1); fillHug(nb); nb.counterAxisAlignItems = 'CENTER'; bindNumber(R, nb, 'itemSpacing', '--space-16', 16);
      ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].forEach(function (f) { bindNumber(R, nb, f, '--space-16', 16); });
      bindRadius(R, nb, '--radius-16', 16); nb.fills = paintFor(R, '--light-200'); nb.strokes = paintFor(R, '--dark-200'); nb.strokeWeight = 1; nb.strokeAlign = 'INSIDE';
      var ic = info.createInstance(); nb.appendChild(ic); ic.name = 'icon'; ic.resize(24, 24);
      var NT = 'You can still use Swing Pass until 31 Dec 2025 and it won\u2019t be auto renewed.', D = '31 Dec 2025';
      var t = await styledText(R, '--type-b3', '--dark-500', NT); nb.appendChild(t); t.name = 'text'; t.textAutoResize = 'HEIGHT'; t.layoutSizingHorizontal = 'FILL';
      var b3s = R.text['--type-b3s'], at = NT.indexOf(D);
      if (b3s) { await figma.loadFontAsync(b3s.fontName); await t.setRangeTextStyleIdAsync(at, at + D.length, b3s.id); }
    } });
  return { set: r.scr, count: 10, label: 'screen from 10 parts' };
}

/* ----- Swing Pass events + Tee time (ref/swingpass-events.html, ref/teetime.html): EventsHead, EventCard, HostCta ----- */
var EV_PAGE = 'Screen / Swing Pass events';
async function evArt(R, name, size, notes, page, css) { return refIcon(R, 'ev-' + name, 'ref/img/ev/' + name + '.svg?v=1', size, css || null, notes, page); }

async function buildEventsHeadPage(R, notes) {
  var page = await pageNamed(EV_PAGE);
  var I = { back: await evArt(R, 'back', 20, notes, page, '--dark-300'), search: await evArt(R, 'search', 16, notes, page, '--dark-300'), chev: await evArt(R, 'chev-down-12', 12, notes, page) };
  var eh = {};
  var V = [{ tee: 'false', name: 'tee=false' }, { tee: 'true', name: 'tee=true' }];
  return buildPartPage(R, notes, 'EventsHead', async function (comp, K, pg, v) {
    // .events-head: 276, purple-100; art from 62 (tee: 26) to the bottom, full width; bar 6 / 14, gap 16: round back button 36 (white, back 20 dark-300) + title H4;
    // .searchbar.searchbar--ads pinned 24 from the sides, 2 below the bottom, Elevation card s
    var tee = v.tee === 'true', top = tee ? 26 : 62;
    comp.layoutMode = 'NONE'; comp.resizeWithoutConstraints(390, 278); comp.clipsContent = false; comp.fills = [];
    var bg = figma.createRectangle(); comp.appendChild(bg); bg.name = 'background'; bg.resize(390, 276); bg.x = 0; bg.y = 0; bg.fills = paintFor(R, '--purple-100');
    bg.constraints = { horizontal: 'STRETCH', vertical: 'MIN' };
    var art = await refArt(R, comp, 'ref/img/' + (tee ? 'tt' : 'ev') + '/head-art.svg?v=1', 390, 276 - top, 'art', notes);
    art.x = 0; art.y = top; art.constraints = { horizontal: 'STRETCH', vertical: 'MIN' };
    var bar = autoFrame('bar', 'HORIZONTAL', comp); bar.x = 0; bar.y = 0; bar.counterAxisAlignItems = 'MIN';
    bar.resize(390, 48); bar.layoutSizingHorizontal = 'FIXED'; bar.layoutSizingVertical = 'HUG';
    bar.paddingTop = 6; bar.paddingBottom = 6; bindNumber(R, bar, 'paddingLeft', '--ads-gap-14', 14); bindNumber(R, bar, 'paddingRight', '--ads-gap-14', 14); bindNumber(R, bar, 'itemSpacing', '--space-16', 16);
    var rb = autoFrame('back', 'HORIZONTAL', bar); rb.primaryAxisAlignItems = 'CENTER'; rb.counterAxisAlignItems = 'CENTER';
    rb.resize(36, 36); rb.layoutSizingHorizontal = 'FIXED'; rb.layoutSizingVertical = 'FIXED'; bindRadius(R, rb, '--radius-full', 9999); rb.fills = paintFor(R, '--light-100');
    var bi = I.back.createInstance(); rb.appendChild(bi); bi.name = 'icon'; bi.resize(20, 20);
    var t = await K.txt(bar, '--type-h4', '--dark-500', tee ? 'Book & explore\ntee time' : 'Register events\n& tournaments', 'title', 'fill');
    var sb = autoFrame('searchbar', 'HORIZONTAL', comp); sb.counterAxisAlignItems = 'CENTER';
    sb.resize(342, 36); sb.layoutSizingHorizontal = 'FIXED'; sb.layoutSizingVertical = 'FIXED'; sb.x = 24; sb.y = 276 - 36 + 2;
    sb.constraints = { horizontal: 'STRETCH', vertical: 'MAX' };
    bindNumber(R, sb, 'paddingTop', '--space-8', 8); bindNumber(R, sb, 'paddingBottom', '--space-8', 8); bindNumber(R, sb, 'paddingLeft', '--ads-gap-14', 14); bindNumber(R, sb, 'paddingRight', '--space-4', 4);
    bindNumber(R, sb, 'itemSpacing', '--space-8', 8); bindRadius(R, sb, '--radius-8', 8); sb.fills = paintFor(R, '--light-300'); await effectStyle(R, sb, '--elevation-card-s');
    var si = I.search.createInstance(); sb.appendChild(si); si.name = 'icon'; si.resize(16, 16);
    var ph = await K.txt(sb, '--type-b2', '--dark-200', tee ? 'Search golf courses...' : 'Search events...', 'placeholder', 'fill');
    var cc = autoFrame('country', 'HORIZONTAL', sb); hugHug(cc); cc.counterAxisAlignItems = 'CENTER'; bindNumber(R, cc, 'itemSpacing', '--space-8', 8);
    bindNumber(R, cc, 'paddingTop', '--space-4', 4); bindNumber(R, cc, 'paddingBottom', '--space-4', 4); bindNumber(R, cc, 'paddingLeft', '--space-8', 8); bindNumber(R, cc, 'paddingRight', '--space-8', 8);
    bindRadius(R, cc, '--ads-radius-4', 4); cc.fills = paintFor(R, '--light-200');
    await refArt(R, cc, 'ref/img/ev/flag-id.svg?v=1', 16, 16, 'flag', notes);
    var cs = autoFrame('code', 'HORIZONTAL', cc); hugHug(cs); cs.counterAxisAlignItems = 'CENTER'; bindNumber(R, cs, 'itemSpacing', '--space-4', 4);
    await K.txt(cs, '--type-b2', '--dark-500', 'ID', 'text');
    var ch = I.chev.createInstance(); cs.appendChild(ch); ch.name = 'chevron'; ch.resize(12, 12);
    eh[comp.name] = { t: t, ph: ph };
  }, function (s) {
    var pT = ensureProp(s, 'title', 'TEXT', 'Register events\n& tournaments'), pP = ensureProp(s, 'placeholder', 'TEXT', 'Search events...');
    wireKeys(eh).forEach(function (k) { eh[k].t.componentPropertyReferences = { characters: pT }; eh[k].ph.componentPropertyReferences = { characters: pP }; });
    s.description = '<header class="swing_events_head [swing_events_head_tee]"><div class="swing_events_head__art"></div><div class="swing_events_head__bar"><a class="swing_round_btn">back</a><h1 class="swing_events_head__title">…</h1></div><label class="swing_searchbar swing_searchbar_ads">…country…</label></header>. 276 tall, purple-100; the search bar hangs 2 below the bottom (the component is 278). tee=true = the tee time art, 26 from the top (events: 62).';
  }, { description: 'The ADS listing header: art, round back button, big title, search with country.', variants: V });
}

async function buildEventCardPage(R, notes) {
  var page = await pageNamed(EV_PAGE);
  var I = { credits: await evArt(R, 'credits-12', 12, notes, page), pass: await evArt(R, 'pass-12', 12, notes, page), chevW: await evArt(R, 'chev-w-12', 12, notes, page), gps: await evArt(R, 'gps-12', 12, notes, page) };
  var ec = {};
  var V = [{ pass: 'true', name: 'pass=true' }, { pass: 'false', name: 'pass=false' }];
  return buildPartPage(R, notes, 'EventCard', async function (comp, K, pg, v) {
    // .event-card: column, gap 16; media clip radius 16: photo 312 (padding 8, cash chip on top) + optional .pass-strip (8/16, gap 8, gradient, B3s white, icons 12);
    // body gap 8: title H5, price (from B3s + amount B1s, dark-300, gap 2), .meta-line (gps 12 + place · date, B3s dark-300, gap 4)
    comp.layoutMode = 'VERTICAL'; comp.resize(342, 420); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--space-16', 16); comp.fills = [];
    var md = autoFrame('media', 'VERTICAL', comp); fillHug(md); md.clipsContent = true; bindRadius(R, md, '--radius-16', 16);
    var ph = autoFrame('photo', 'HORIZONTAL', md); ph.counterAxisAlignItems = 'MIN'; ph.resize(342, 312); ph.layoutSizingHorizontal = 'FILL'; ph.layoutSizingVertical = 'FIXED';
    ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].forEach(function (f) { bindNumber(R, ph, f, '--space-8', 8); });
    var im = figma.createRectangle(); ph.appendChild(im); im.name = 'image'; im.layoutPositioning = 'ABSOLUTE'; im.resize(342, 312); im.x = 0; im.y = 0;
    im.constraints = { horizontal: 'STRETCH', vertical: 'STRETCH' }; await refPhoto(R, im, 'ref/img/ev/event-' + (v.pass === 'true' ? 1 : 2) + '.jpg?v=1', notes);
    var ch = autoFrame('cash-chip', 'HORIZONTAL', ph); hugHug(ch); ch.counterAxisAlignItems = 'CENTER'; bindNumber(R, ch, 'itemSpacing', '--space-4', 4);
    ch.paddingTop = 2; ch.paddingBottom = 2; bindNumber(R, ch, 'paddingLeft', '--space-8', 8); bindNumber(R, ch, 'paddingRight', '--space-8', 8);
    bindRadius(R, ch, '--radius-16', 16); ch.fills = paintFor(R, '--light-300');
    var ci = I.credits.createInstance(); ch.appendChild(ci); ci.name = 'icon'; ci.resize(12, 12);
    var ct = await K.txt(ch, '--type-b3s', '--dark-300', 'Up to 2% cashback', 'text');
    var p = { ct: ct };
    if (v.pass === 'true') {
      var ps = autoFrame('pass-strip', 'HORIZONTAL', md); fillHug(ps); ps.counterAxisAlignItems = 'CENTER'; bindNumber(R, ps, 'itemSpacing', '--space-8', 8);
      bindNumber(R, ps, 'paddingTop', '--space-8', 8); bindNumber(R, ps, 'paddingBottom', '--space-8', 8); bindNumber(R, ps, 'paddingLeft', '--space-16', 16); bindNumber(R, ps, 'paddingRight', '--space-16', 16);
      await fillStyle(R, ps, '--gradient-swing-pass', '--purple-500');
      var a = I.pass.createInstance(); ps.appendChild(a); a.name = 'icon'; a.resize(12, 12);
      p.ps = await K.txt(ps, '--type-b3s', '--light-100', 'This event is Swing Pass exclusive', 'text', 'fill');
      var b = I.chevW.createInstance(); ps.appendChild(b); b.name = 'chevron'; b.resize(12, 12);
    }
    var bd = autoFrame('body', 'VERTICAL', comp); fillHug(bd); bindNumber(R, bd, 'itemSpacing', '--space-8', 8);
    p.t = await K.txt(bd, '--type-h5', '--dark-500', 'INDONESIA DEVELOPMENT OPEN - SERIES 2', 'title', 'fill');
    var pr = autoFrame('price', 'VERTICAL', bd); fillHug(pr); pr.itemSpacing = 2;
    p.from = await K.txt(pr, '--type-b3s', '--dark-300', 'Starting from', 'from', 'fill');
    p.amt = await K.txt(pr, '--type-b1s', '--dark-300', 'Rp. 850,000 / pax', 'amount', 'fill');
    var ml = autoFrame('meta-line', 'HORIZONTAL', bd); fillHug(ml); ml.counterAxisAlignItems = 'CENTER'; bindNumber(R, ml, 'itemSpacing', '--space-4', 4);
    var g = I.gps.createInstance(); ml.appendChild(g); g.name = 'icon'; g.resize(12, 12);
    p.place = await K.txt(ml, '--type-b3s', '--dark-300', 'Jababeka Golf & Country Club', 'place');
    p.date = await K.txt(ml, '--type-b3s', '--dark-300', '\u2022  Monday, 18 May 2026', 'date');
    ec[comp.name] = p;
  }, function (s) {
    var P = { t: ensureProp(s, 'title', 'TEXT', 'INDONESIA DEVELOPMENT OPEN - SERIES 2'), amt: ensureProp(s, 'amount', 'TEXT', 'Rp. 850,000 / pax'), place: ensureProp(s, 'place', 'TEXT', 'Jababeka Golf & Country Club'),
      date: ensureProp(s, 'date', 'TEXT', '\u2022  Monday, 18 May 2026'), ct: ensureProp(s, 'cashback', 'TEXT', 'Up to 2% cashback') };
    wireKeys(ec).forEach(function (k) { wireKeys(P).forEach(function (f) { if (ec[k][f]) ec[k][f].componentPropertyReferences = { characters: P[f] }; }); });
    s.description = '<a class="swing_event_card"><span class="swing_event_card__media"><span class="swing_event_card__photo"><img><span class="swing_cash_chip">…</span></span>[<span class="swing_pass_strip">…</span>]</span><span class="swing_event_card__body">title H5, price, .swing_meta_line</span></a> in .swing_event_list (gap 32). pass=true adds the Swing Pass strip under the photo. Replace the image fill on "image" per event. The date keeps the web\'s "•" separator in its text.';
  }, { description: 'An event or tournament in the list: photo with cashback, optional Swing Pass strip, title, price, place and date.', variants: V });
}

async function buildHostCtaPage(R, notes) {
  var BT = byName(await setFrom('Button', 'Button', buildButton, R, notes));
  var hc = {};
  var V = [{ inset: 'false', name: 'inset=false' }, { inset: 'true', name: 'inset=true' }];
  return buildPartPage(R, notes, 'HostCta', async function (comp, K, pg, v) {
    // .host-cta: column centred, gap 16, 0 / page-x (inset: 0 / 48 on the full width = 0 / 24 inside the gutter), title H5 centred, Button s tertiary
    comp.layoutMode = 'VERTICAL'; comp.counterAxisAlignItems = 'CENTER'; comp.resize(342, 100); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--space-16', 16); comp.fills = [];
    if (v.inset === 'true') { bindNumber(R, comp, 'paddingLeft', '--page-x', 24); bindNumber(R, comp, 'paddingRight', '--page-x', 24); }
    var t = await K.txt(comp, '--type-h5', '--dark-500', 'Planning to host a tournament really soon? Connect with us and let Swing help you!', 'title', 'fill'); t.textAlignHorizontal = 'CENTER';
    var b = BT['size=s, tone=primary, appearance=tertiary, state=default'].createInstance(); comp.appendChild(b); b.name = 'action';
    setText(b, { label: 'Host your tournament', showIconStart: false, showIconEnd: false });
    hc[comp.name] = t;
  }, function (s) {
    var pT = ensureProp(s, 'title', 'TEXT', 'Planning to host a tournament really soon? Connect with us and let Swing help you!');
    wireKeys(hc).forEach(function (k) { hc[k].componentPropertyReferences = { characters: pT }; });
    s.description = '<div class="swing_host_cta [swing_host_cta_inset]"><h2 class="swing_host_cta__title">…</h2><a class="swing_btn swing_btn_s swing_btn_tertiary">…</a></div> at the end of a listing. Centred, gap 16, title H5. inset=true pads 24 more on each side (tee time). Set the button label on the Button instance.';
  }, { description: 'A centred ask at the end of a listing, with a tertiary button.', variants: V });
}

// events body: 50 top, page-x sides, gap 32, clipped; background art 667 tall at the bottom; a 555 tail under the last block
async function evBuild(R, notes, opt) {
  var page = await pageNamed(opt.page);
  var EH = byName(await setWith('EventsHead', 'EventsHead', buildEventsHeadPage, R, notes, 'tee=true'));
  var HC = byName(await setWith('HostCta', 'HostCta', buildHostCtaPage, R, notes, 'inset=true'));
  var old = page.findChild(function (n) { return n.type === 'FRAME' && n.name === opt.frame; });
  var keepX = old ? old.x : 0, keepY = old ? old.y : 0;
  if (old) old.remove();
  var scr = figma.createFrame(); page.appendChild(scr);
  scr.name = opt.frame; scr.x = keepX; scr.y = keepY;
  scr.layoutMode = 'VERTICAL'; scr.resize(390, 844); scr.layoutSizingHorizontal = 'FIXED'; scr.layoutSizingVertical = 'HUG'; scr.minHeight = 844;
  scr.itemSpacing = -2; scr.itemReverseZIndex = true; scr.clipsContent = true; scr.fills = paintFor(R, '--light-100');   // the search bar hangs 2 over the body
  var hd = EH['tee=' + opt.tee].createInstance(); scr.appendChild(hd); hd.layoutSizingHorizontal = 'FILL';
  setText(hd, { title: opt.title, placeholder: opt.placeholder });
  var body = autoFrame('events-body', 'VERTICAL', scr); fillHug(body); padX(R, body); body.paddingTop = 50 + 2; body.clipsContent = true;
  bindNumber(R, body, 'itemSpacing', '--space-32', 32);
  var art = await refArt(R, body, opt.art, 390, 667, 'art', notes); art.layoutPositioning = 'ABSOLUTE'; art.x = 0; art.constraints = { horizontal: 'STRETCH', vertical: 'MAX' };
  var list = autoFrame('event-list', 'VERTICAL', body); fillHug(list); bindNumber(R, list, 'itemSpacing', '--space-32', 32);
  await opt.cards(list);
  var hc = HC['inset=' + opt.inset].createInstance(); body.appendChild(hc); hc.layoutSizingHorizontal = 'FILL';
  setText(hc, { title: opt.cta[0] });
  var hb = hc.findOne(function (n) { return n.type === 'INSTANCE' && n.name === 'action'; }); if (hb) setText(hb, { label: opt.cta[1] });
  var tail = autoFrame('tail', 'VERTICAL', body); tail.resize(342, 555); tail.layoutSizingHorizontal = 'FILL'; tail.layoutSizingVertical = 'FIXED';
  return { scr: scr, page: page, body: body, art: art, EH: EH, HC: HC };
}
function evPlaceArt(r) { r.art.y = Math.max(0, r.body.height - 667); }   // .events-art: bottom 0

async function buildSwingPassEventsScreen(R, notes) {
  var PG = EV_PAGE;
  var EC = byName(await setWith('EventCard', 'EventCard', buildEventCardPage, R, notes, 'pass=false'));
  var r = await evBuild(R, notes, { page: PG, frame: 'Swing Pass events', tee: 'false', inset: 'false', title: 'Register events\n& tournaments', placeholder: 'Search events...', art: 'ref/img/ev/trophy-art.svg?v=1',
    cta: ['Planning to host a tournament really soon? Connect with us and let Swing help you!', 'Host your tournament'],
    cards: async function (list) {
      [['true', 'INDONESIA DEVELOPMENT OPEN - SERIES 2', 'Jababeka Golf & Country Club', '\u2022  Monday, 18 May 2026'], ['false', 'All In Golf Game', 'Gading Raya, Imperial, Suvarna', '\u2022  Monday, 15 June 2026']].forEach(function (e) {
        var c = EC['pass=' + e[0]].createInstance(); list.appendChild(c); c.layoutSizingHorizontal = 'FILL';
        setText(c, { title: e[1], place: e[2], date: e[3], amount: 'Rp. 850,000 / pax', cashback: 'Up to 2% cashback' });
      });
    } });
  evPlaceArt(r);
  var one = function (m, props) { var i = m.createInstance(); if (props) setText(i, props); return i; };
  await screenList(R, r.page, r.scr, 'Swing Pass events', async function (row) {
    await row('EventsHead', partSrc('EventsHead', PG) + ' · tee=false: events art, round back, title, search + country', [one(r.EH['tee=false'])]);
    await row('EventCard', partSrc('EventCard', PG) + ' · pass=true (Swing Pass strip) and pass=false', [one(EC['pass=true']), one(EC['pass=false'])]);
    await row('HostCta', partSrc('HostCta', PG) + ' · inset=false', [one(r.HC['inset=false'])]);
  });
  notes.push('Swing Pass events: built from stat.chara.id/swing/ref/swingpass-events.html. The search field shows its hint text only; the trophy art sits behind the list from the bottom, as on the web.');
  return { set: r.scr, count: 3, label: 'screen from 3 parts' };
}
async function buildTeeTimeScreen(R, notes) {
  var PG = 'Screen / Tee time';
  var PC = byName(await setWith('ProductCard', 'ProductCard', buildProductCardPage, R, notes, 'size=l'));
  var GC = [['gc-1', 'Suvarna Jakarta Golf Club', 'Rp. 1,580,000', 'Rp. 1,422,000 / pax'], ['gc-2', 'Gading Raya Golf Club', 'Rp. 850,000', 'Rp. 765,000 / pax'], ['gc-3', 'Imperial Klub Golf', 'Rp. 988,000', 'Rp. 889,200 / pax']];
  var r = await evBuild(R, notes, { page: PG, frame: 'Tee time', tee: 'true', inset: 'true', title: 'Book & explore\ntee time', placeholder: 'Search golf courses...', art: 'ref/img/tt/bg-art.svg?v=1',
    cta: ['Can\u2019t find the place you\u2019re looking for? Tell us, and we\u2019ll try to add it to Swing!', 'Request a location'],
    cards: async function (list) {
      for (var g of GC) {
        var c = PC['size=l'].createInstance(); list.appendChild(c); c.layoutSizingHorizontal = 'FILL';
        setText(c, { title: g[1], was: g[2], price: g[3], save: 'Save 10%', location: 'Jakarta Timur, Indonesia \u00b7 54km away', showUpsell: true });
        var ph = c.findOne(function (n) { return n.name === 'photo'; }); if (ph) await refPhoto(R, ph, 'ref/img/h5/' + g[0] + '.jpg?v=1', notes);
      }
    } });
  evPlaceArt(r);
  var one = function (m, props) { var i = m.createInstance(); if (props) setText(i, props); return i; };
  await screenList(R, r.page, r.scr, 'Tee time', async function (row) {
    await row('EventsHead', partSrc('EventsHead', PG) + ' · tee=true: tee time art (26 down), title, search + country', [one(r.EH['tee=true'])]);
    await row('ProductCard', partSrc('ProductCard', PG) + ' · size=l (.swing_product_card_l), full width, 3 courses', [one(PC['size=l'])]);
    await row('HostCta', partSrc('HostCta', PG) + ' · inset=true (Request a location)', [one(r.HC['inset=true'])]);
  });
  notes.push('Tee time: built from stat.chara.id/swing/ref/teetime.html, on the same layout as Swing Pass events. The course photos are set per card on the instance.');
  return { set: r.scr, count: 3, label: 'screen from 3 parts' };
}

/* ----- Swing Pass event (ref/swingpass-event.html): PromoCard, CreditStrip, InfoTile, Venue, BrandCard (golf course details reuses them) ----- */
var EVD_PAGE = 'Screen / Swing Pass event';
async function buildPromoCardPage(R, notes) {
  var page = await pageNamed(EVD_PAGE);
  var tag = await evArt(R, 'tag-green-16', 16, notes, page);
  var pr = {};
  var V = [{ pass: 'false', name: 'pass=false' }, { pass: 'true', name: 'pass=true' }];
  return buildPartPage(R, notes, 'PromoCard', async function (comp, K, pg, v) {
    // .promo-card: clip, green-100 line (pass: purple-500), radius 8; tag 8 on green-50 (pass: gradient, white icon); body 12, min 54, gap 2: title B3s dark-500, sub B4 dark-300 (pass: B4s purple-500)
    var ps = v.pass === 'true';
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'MIN'; comp.resize(342, 54); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    comp.clipsContent = true; bindRadius(R, comp, '--radius-8', 8); comp.fills = []; comp.strokes = paintFor(R, ps ? '--purple-500' : '--green-100'); comp.strokeWeight = 1; comp.strokeAlign = 'INSIDE';
    var tg = autoFrame('tag', 'HORIZONTAL', comp); tg.counterAxisAlignItems = 'CENTER'; tg.layoutSizingHorizontal = 'HUG'; tg.layoutSizingVertical = 'FILL';
    ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].forEach(function (f) { bindNumber(R, tg, f, '--space-8', 8); });
    if (ps) await fillStyle(R, tg, '--gradient-swing-pass', '--purple-500'); else tg.fills = paintFor(R, '--green-50');
    var ti = tag.createInstance(); tg.appendChild(ti); ti.name = 'icon'; ti.resize(16, 16); if (ps) recolorIcon(R, ti, '--light-100');
    var bd = autoFrame('body', 'VERTICAL', comp); bd.primaryAxisAlignItems = 'CENTER'; bd.layoutSizingHorizontal = 'FILL'; bd.layoutSizingVertical = 'HUG'; bd.minHeight = 54; bd.itemSpacing = 2;
    ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].forEach(function (f) { bindNumber(R, bd, f, '--space-12', 12); });
    bd.fills = paintFor(R, '--light-100');
    var t = await K.txt(bd, '--type-b3s', '--dark-500', 'Rp. 50,000 off for INDO Series 2', 'title', 'fill');
    var sb = await K.txt(bd, ps ? '--type-b4s' : '--type-b4', ps ? '--purple-500' : '--dark-300', 'Expiry date: 31 Mar 2023', 'sub', 'fill');
    pr[comp.name] = { t: t, sb: sb };
  }, function (s) {
    var pT = ensureProp(s, 'title', 'TEXT', 'Rp. 50,000 off for INDO Series 2'), pS = ensureProp(s, 'sub', 'TEXT', 'Expiry date: 31 Mar 2023');
    wireKeys(pr).forEach(function (k) { pr[k].t.componentPropertyReferences = { characters: pT }; pr[k].sb.componentPropertyReferences = { characters: pS }; });
    s.description = '<div class="swing_promo_card [swing_promo_card_pass]"><span class="swing_promo_card__tag"><img 16></span><span class="swing_promo_card__body"><span class="swing_promo_card__title">…</span><span class="swing_promo_card__sub">…</span></span></div>. Radius 8, green-100 line, green-50 tag. pass=true = .swing_promo_card_pass (Swing Pass exclusive): purple-500 line, gradient tag, sub in B4s purple-500.';
  }, { description: 'A promo with its tag and expiry; pass=true for Swing Pass exclusive.', variants: V });
}

async function buildCreditStripPage(R, notes) {
  var page = await pageNamed(EVD_PAGE);
  var I = { c: await evArt(R, 'credits-16', 16, notes, page), ch: await evArt(R, 'chev-p-16', 16, notes, page) };
  var cs = {};
  return buildPartPage(R, notes, 'CreditStrip', async function (comp, K) {
    // .credit-strip: 8, gap 8, radius 8, purple-50, B3s purple-500, icons 16
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER'; comp.resize(342, 32); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].forEach(function (f) { bindNumber(R, comp, f, '--space-8', 8); });
    bindNumber(R, comp, 'itemSpacing', '--space-8', 8); bindRadius(R, comp, '--radius-8', 8); comp.fills = paintFor(R, '--purple-50');
    var a = I.c.createInstance(); comp.appendChild(a); a.name = 'icon'; a.resize(16, 16);
    var t = await K.txt(comp, '--type-b3s', '--purple-500', 'Earn up to 5% cashback on Swing Credits!', 'text', 'fill');
    var b = I.ch.createInstance(); comp.appendChild(b); b.name = 'chevron'; b.resize(16, 16);
    cs[comp.name] = t;
  }, function (s) {
    var pT = ensureProp(s, 'text', 'TEXT', 'Earn up to 5% cashback on Swing Credits!');
    wireKeys(cs).forEach(function (k) { cs[k].componentPropertyReferences = { characters: pT }; });
    s.description = '<a class="swing_credit_strip"><img credits 16><span>…</span><img chevron 16></a>. Padding 8, gap 8, radius 8, purple-50, B3 Semibold purple-500.';
  }, { description: 'A Swing Credits cashback line that links on.' });
}

var EVD_TILES = [['i-gps', 'Venue', 'Jababeka Golf & Country Club'], ['i-date', 'Date', 'Monday, 18 May 2026'], ['i-clock', 'Starting time', 'Semi shotgun 12:30 PM'], ['i-sand', 'Deadline', 'Latest by 13 May 2026, 06:00 PM'], ['i-tag', 'Registration fee', 'Starting from Rp. 850,000 / pax']];
async function buildInfoTilePage(R, notes) {
  var page = await pageNamed(EVD_PAGE);
  var ic = await evArt(R, 'i-gps', 22, notes, page);
  var it = {};
  return buildPartPage(R, notes, 'InfoTile', async function (comp, K) {
    // .info-tile: centred, gap 14, 12/16, radius 16, light-200; icon 22; label B3 dark-300, value B3s dark-500, gap 2
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER'; comp.resize(165, 64); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'paddingTop', '--space-12', 12); bindNumber(R, comp, 'paddingBottom', '--space-12', 12); bindNumber(R, comp, 'paddingLeft', '--space-16', 16); bindNumber(R, comp, 'paddingRight', '--space-16', 16);
    bindNumber(R, comp, 'itemSpacing', '--ads-gap-14', 14); bindRadius(R, comp, '--radius-16', 16); comp.fills = paintFor(R, '--light-200');
    var i = ic.createInstance(); comp.appendChild(i); i.name = 'icon'; i.resize(22, 22);
    var tx = autoFrame('text', 'VERTICAL', comp); tx.layoutSizingHorizontal = 'FILL'; tx.layoutSizingVertical = 'HUG'; tx.itemSpacing = 2;
    var l = await K.txt(tx, '--type-b3', '--dark-300', 'Venue', 'label', 'fill'), val = await K.txt(tx, '--type-b3s', '--dark-500', 'Jababeka Golf & Country Club', 'value', 'fill');
    it[comp.name] = { i: i, l: l, v: val };
  }, function (s) {
    var pI = ensureProp(s, 'icon', 'INSTANCE_SWAP', ic.id), pL = ensureProp(s, 'label', 'TEXT', 'Venue'), pV = ensureProp(s, 'value', 'TEXT', 'Jababeka Golf & Country Club');
    wireKeys(it).forEach(function (k) { it[k].i.componentPropertyReferences = { mainComponent: pI }; it[k].l.componentPropertyReferences = { characters: pL }; it[k].v.componentPropertyReferences = { characters: pV }; });
    s.description = '<div class="swing_info_tile [swing_info_tile_wide]"><img 22><span class="swing_info_tile__text"><span class="swing_info_tile__label">…</span><span class="swing_info_tile__value">…</span></span></div> in .swing_info_tiles (2 columns, gap 8 / 12). light-200, radius 16, 12/16, gap 14. --wide spans both columns: set the instance to Fill in a full-width row. Swap the icon with the icon property.';
  }, { description: 'A label and value with an icon, in a 2-column grid.' });
}

async function buildVenuePage(R, notes) {
  var page = await pageNamed(EVD_PAGE);
  var I = { gps: await evArt(R, 'gps-p-12', 12, notes, page), pin: await evArt(R, 'gps-w-16', 16, notes, page) };
  var vn = {};
  // size=m = .venue (event details: name + address + distance, map 94); size=s = .venue--s (golf course: address + distance, 72 map with a line, radius 16)
  var V = [{ size: 'm', name: 'size=m', legacy: 'type=default' }, { size: 's', name: 'size=s' }];
  return buildPartPage(R, notes, 'Venue', async function (comp, K, pg, v) {
    var sm = v && v.size === 's', M = sm ? 72 : 94;
    // .venue: top-aligned, gap 16; text gap 8: name B2s dark-500 (one line) + address B3s dark-300 (3 lines, 48), .meta-line--primary (gps 12 + distance, purple-500);
    // map 94, radius 8, clip, with the pin (4 on purple-500 20% around a purple-500 8 circle, icon 16) in the middle
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'MIN'; comp.resize(342, M); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--space-16', 16); comp.fills = [];
    var tx = autoFrame('text', 'VERTICAL', comp); tx.layoutSizingHorizontal = 'FILL'; bindNumber(R, tx, 'itemSpacing', '--space-8', 8);
    if (sm) { tx.resize(254, 72); tx.layoutSizingHorizontal = 'FILL'; tx.layoutSizingVertical = 'FIXED'; tx.primaryAxisAlignItems = 'SPACE_BETWEEN'; } else tx.layoutSizingVertical = 'HUG';
    var id = sm ? tx : autoFrame('id', 'VERTICAL', tx); if (!sm) { fillHug(id); id.itemSpacing = 2; }
    var nm = sm ? null : await K.txt(id, '--type-b2s', '--dark-500', 'Rainbow Hills Golf', 'name', 'fill'); if (nm) { nm.textTruncation = 'ENDING'; nm.maxLines = 1; }
    var ad = await K.txt(id, '--type-b3s', '--dark-300', 'Lengkong Kulon, Pagedangan, Tangerang Regency, DKI Jakarta 15339', 'address', 'fill');
    ad.textAutoResize = 'NONE'; ad.resize(232, 48); ad.layoutSizingHorizontal = 'FILL'; ad.textTruncation = 'ENDING'; ad.maxLines = 3;
    var ml = autoFrame('meta-line', 'HORIZONTAL', tx); hugHug(ml); ml.counterAxisAlignItems = 'CENTER'; bindNumber(R, ml, 'itemSpacing', '--space-4', 4);
    var g = I.gps.createInstance(); ml.appendChild(g); g.name = 'icon'; g.resize(12, 12);
    var ds = await K.txt(ml, '--type-b3s', '--purple-500', '2km from your location', 'text');
    var mp = autoFrame('map', 'HORIZONTAL', comp); mp.primaryAxisAlignItems = 'CENTER'; mp.counterAxisAlignItems = 'CENTER';
    mp.resize(M, M); mp.layoutSizingHorizontal = 'FIXED'; mp.layoutSizingVertical = 'FIXED'; mp.clipsContent = true; bindRadius(R, mp, sm ? '--radius-16' : '--radius-8', sm ? 16 : 8);
    if (sm) { mp.strokes = paintFor(R, '--light-500'); mp.strokeWeight = 1; mp.strokeAlign = 'INSIDE'; }
    var im = figma.createRectangle(); mp.appendChild(im); im.name = 'image'; im.layoutPositioning = 'ABSOLUTE'; im.resize(M, M); im.x = 0; im.y = 0;
    im.constraints = { horizontal: 'STRETCH', vertical: 'STRETCH' }; await refPhoto(R, im, 'ref/img/ev/map.jpg?v=1', notes);
    var ring = autoFrame('pin', 'HORIZONTAL', mp); hugHug(ring); ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].forEach(function (f) { bindNumber(R, ring, f, '--space-4', 4); });
    bindRadius(R, ring, '--radius-full', 9999); ring.fills = paintFor(R, colorMix('in srgb, --purple-500 20%, transparent'));
    var dot = autoFrame('dot', 'HORIZONTAL', ring); hugHug(dot); ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].forEach(function (f) { bindNumber(R, dot, f, '--space-8', 8); });
    bindRadius(R, dot, '--radius-full', 9999); dot.fills = paintFor(R, '--purple-500');
    var pi = I.pin.createInstance(); dot.appendChild(pi); pi.name = 'icon'; pi.resize(16, 16);
    vn[comp.name] = { nm: nm, ad: ad, ds: ds };
  }, function (s) {
    var pN = ensureProp(s, 'name', 'TEXT', 'Rainbow Hills Golf'), pA = ensureProp(s, 'address', 'TEXT', 'Lengkong Kulon, Pagedangan, Tangerang Regency, DKI Jakarta 15339'), pD = ensureProp(s, 'distance', 'TEXT', '2km from your location');
    wireKeys(vn).forEach(function (k) { if (vn[k].nm) vn[k].nm.componentPropertyReferences = { characters: pN }; vn[k].ad.componentPropertyReferences = { characters: pA }; vn[k].ds.componentPropertyReferences = { characters: pD }; });
    s.description = '<div class="swing_venue"><div class="swing_venue__text">.swing_venue__id (name B2s, address B3s, 3 lines), .swing_meta_line_primary</div><div class="swing_venue__map"><img><span class="swing_venue__pin">…</span></div></div>. Gap 16; map 94, radius 8, purple pin in the middle. Replace the image fill on "image" with the place\'s map.';
  }, { variants: V,  description: 'A place: name, address, distance and a small map with a pin.' });
}

async function buildBrandCardPage(R, notes) {
  var page = await pageNamed(EVD_PAGE);
  var chev = await evArt(R, 'chev-12', 12, notes, page);
  var bc = {};
  var V = [{ wide: 'false', name: 'wide=false' }, { wide: 'true', name: 'wide=true' }];
  return buildPartPage(R, notes, 'BrandCard', async function (comp, K, pg, v) {
    // .brand-card: column centred, gap 8, padding 16, radius 16, light-200; logo 48 (wide: 90 x 48), radius 8; name B3s dark-500 (one line) + chevron 12, gap 4
    var w = v.wide === 'true';
    comp.layoutMode = 'VERTICAL'; comp.counterAxisAlignItems = 'CENTER'; comp.resize(165, 100); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].forEach(function (f) { bindNumber(R, comp, f, '--space-16', 16); });
    bindNumber(R, comp, 'itemSpacing', '--space-8', 8); bindRadius(R, comp, '--radius-16', 16); comp.fills = paintFor(R, '--light-200');
    var lg = figma.createRectangle(); comp.appendChild(lg); lg.name = 'logo'; lg.resize(w ? 90 : 48, 48); bindRadius(R, lg, '--radius-8', 8);
    await refPhoto(R, lg, 'ref/img/ev/brand-' + (w ? 2 : 0) + '.png?v=1', notes);
    var nm = autoFrame('name', 'HORIZONTAL', comp); nm.counterAxisAlignItems = 'CENTER'; nm.layoutSizingHorizontal = 'HUG'; nm.layoutSizingVertical = 'HUG'; nm.maxWidth = 133; bindNumber(R, nm, 'itemSpacing', '--space-4', 4);
    var t = await K.txt(nm, '--type-b3s', '--dark-500', w ? 'Swing App' : 'VIVO', 'text'); t.textTruncation = 'ENDING'; t.maxLines = 1;
    var c = chev.createInstance(); nm.appendChild(c); c.name = 'chevron'; c.resize(12, 12);
    bc[comp.name] = t;
  }, function (s) {
    var pN = ensureProp(s, 'name', 'TEXT', 'VIVO');
    wireKeys(bc).forEach(function (k) { bc[k].componentPropertyReferences = { characters: pN }; });
    s.description = '<a class="swing_brand_card"><img [class="swing_brand_card__wide"]><span class="swing_brand_card__name"><span>…</span><img chevron 12></span></a> in .swing_brand_grid (2 columns, gap 8 / 12). light-200, radius 16, padding 16, gap 8. wide=true = a 90 x 48 logo. Replace the image fill on "logo" per sponsor.';
  }, { description: 'A sponsor tile: logo and name.', variants: V });
}

var EVD_BRANDS = [['VIVO', 0], ['Juragan Golf', 1], ['Swing App', 2], ['Danpac', 3], ['DiDO', 4], ['Kaltenberg', 5], ['Vinker', 6], ['SvinGolf', 7], ['YOU\u2022C1000', 8], ['XOOU Vape', 9], ['Power Golf Driving Range', 10], ['Crystalin', 11], ['Leonian', 12], ['Modern Golf & Country C...', 13], ['Klub Golf Bogor Raya', 14]];
var EVD_WIDE = { 2: 1, 3: 1, 4: 1, 7: 1, 8: 1, 9: 1, 11: 1 };
var EVD_TEXT = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.';
var EVD_ORG = 'The Indonesia Development Open (INDO) is a structured golf competition platform designed to support the growth and progression of golfers across Indonesia. The Tournament provides competitive opportunities for professional, amateur, and junior players, creating a clear pathway for athletes to develop their skills and advance to higher levels of competition.\n\nINDO aims to bridge the gap between grassroots participation and elite performance by offering professionally managed Tournaments aligned with international competition standards.';

async function buildSwingPassEventScreen(R, notes) {
  var PG = EVD_PAGE, page = await pageNamed(PG);
  var appBar = byName(await setWith('AppBar', 'AppBar', buildAppBarPage, R, notes, 'type=adsShare, scrolled=false'));
  var BT = byName(await setWith('Button', 'Button', buildButton, R, notes, 'size=s, tone=muted, appearance=tertiary, state=default'));
  var DV = byName(await setFrom('Divider', 'Divider', buildDividerPage, R, notes));
  var P = { promo: byName(await setWith('PromoCard', 'PromoCard', buildPromoCardPage, R, notes, 'pass=true')), credit: await setFrom('CreditStrip', 'CreditStrip', buildCreditStripPage, R, notes),
    tile: await setFrom('InfoTile', 'InfoTile', buildInfoTilePage, R, notes), venue: await setWith('Venue', 'Venue', buildVenuePage, R, notes, 'size=s'),
    brand: byName(await setWith('BrandCard', 'BrandCard', buildBrandCardPage, R, notes, 'wide=true')) };
  var I = { pass: await evArt(R, 'pass-16', 16, notes, page), close: await evArt(R, 'close-w-14', 14, notes, page), gpsD: await evArt(R, 'gps-d-12', 12, notes, page),
    ext: await evArt(R, 'ext-14', 14, notes, page, '--dark-300'), map: await evArt(R, 'map-14', 14, notes, page, '--dark-300'), arrow: await evArt(R, 'arrow-w', 20, notes, page, '--light-100') };
  var TI = {}; for (var x of EVD_TILES) TI[x[0]] = await evArt(R, x[0], 22, notes, page);
  var old = page.findChild(function (n) { return n.type === 'FRAME' && n.name === 'Swing Pass event'; });
  var keepX = old ? old.x : 0, keepY = old ? old.y : 0;
  if (old) old.remove();
  var scr = figma.createFrame(); page.appendChild(scr);
  scr.name = 'Swing Pass event'; scr.x = keepX; scr.y = keepY;
  scr.layoutMode = 'VERTICAL'; scr.resize(390, 844); scr.layoutSizingHorizontal = 'FIXED'; scr.layoutSizingVertical = 'HUG'; scr.minHeight = 844;
  scr.itemSpacing = 0; scr.clipsContent = true; scr.fills = paintFor(R, '--light-200');   // .screen--grey
  var bar = appBar['type=adsShare, scrolled=false'].createInstance(); scr.appendChild(bar); bar.layoutSizingHorizontal = 'FILL';
  setText(bar, { title: 'Event details', showActions: true });
  async function txt(parent, style, color, chars, name) {
    var t = await styledText(R, style, color, chars); parent.appendChild(t); t.name = name; t.textAutoResize = 'HEIGHT'; t.layoutSizingHorizontal = 'FILL'; return t;
  }
  // main: hero 376 (photo + pass toast 32 from the bottom), the sheet rides 16 over it (negative gap)
  var main = autoFrame('main', 'VERTICAL', scr); fillHug(main); main.itemSpacing = -16;
  var hero = autoFrame('event-hero', 'VERTICAL', main); hero.resize(390, 376); hero.layoutSizingHorizontal = 'FILL'; hero.layoutSizingVertical = 'FIXED';
  hero.primaryAxisAlignItems = 'MAX'; padX(R, hero); bindNumber(R, hero, 'paddingBottom', '--space-32', 32);
  var hi = figma.createRectangle(); hero.appendChild(hi); hi.name = 'photo'; hi.layoutPositioning = 'ABSOLUTE'; hi.resize(390, 376); hi.x = 0; hi.y = 0;
  hi.constraints = { horizontal: 'STRETCH', vertical: 'STRETCH' }; await refPhoto(R, hi, 'ref/img/ev/event-1.jpg?v=1', notes);
  var toast = autoFrame('pass-toast', 'HORIZONTAL', hero); fillHug(toast); toast.counterAxisAlignItems = 'CENTER'; bindNumber(R, toast, 'itemSpacing', '--space-8', 8);
  bindNumber(R, toast, 'paddingTop', '--space-12', 12); bindNumber(R, toast, 'paddingBottom', '--space-12', 12); bindNumber(R, toast, 'paddingLeft', '--space-16', 16); bindNumber(R, toast, 'paddingRight', '--space-16', 16);
  bindRadius(R, toast, '--radius-12', 12); await fillStyle(R, toast, '--gradient-swing-pass', '--purple-500'); await effectStyle(R, toast, '--elevation-tag-l');
  var tp = I.pass.createInstance(); toast.appendChild(tp); tp.name = 'icon'; tp.resize(16, 16);
  await txt(toast, '--type-b3s', '--light-100', 'This event is Swing Pass exclusive', 'text');
  var tc = I.close.createInstance(); toast.appendChild(tc); tc.name = 'close'; tc.resize(14, 14);
  // .event-sheet: 32 / page-x, gap 32, radius 16 on top, white, Elevation 3
  var sh = autoFrame('event-sheet', 'VERTICAL', main); fillHug(sh); padX(R, sh); bindNumber(R, sh, 'paddingTop', '--space-32', 32); bindNumber(R, sh, 'paddingBottom', '--space-32', 32);
  bindNumber(R, sh, 'itemSpacing', '--space-32', 32); ['topLeftRadius', 'topRightRadius'].forEach(function (f) { bindNumber(R, sh, f, '--radius-16', 16); });
  sh.fills = paintFor(R, '--light-100'); await effectStyle(R, sh, '--elevation-3');
  var hd = autoFrame('head', 'VERTICAL', sh); fillHug(hd); hd.counterAxisAlignItems = 'CENTER'; bindNumber(R, hd, 'itemSpacing', '--space-8', 8);
  var ht = await txt(hd, '--type-h3', '--dark-500', 'INDONESIA DEVELOPMENT OPEN - SERIES 2', 'title'); ht.textAlignHorizontal = 'CENTER';
  var ml = autoFrame('meta-line', 'HORIZONTAL', hd); hugHug(ml); ml.counterAxisAlignItems = 'CENTER'; bindNumber(R, ml, 'itemSpacing', '--space-4', 4);
  await refArt(R, ml, 'ref/img/ev/flag-id.svg?v=1', 12, 12, 'flag', notes);
  var m1 = await styledText(R, '--type-b3s', '--dark-300', 'Cawang, Indonesia  \u2022'); ml.appendChild(m1); m1.name = 'place'; m1.textAutoResize = 'WIDTH_AND_HEIGHT';
  var g2 = I.gpsD.createInstance(); ml.appendChild(g2); g2.name = 'icon'; g2.resize(12, 12);
  var m2 = await styledText(R, '--type-b3s', '--dark-300', '54 km away'); ml.appendChild(m2); m2.name = 'distance'; m2.textAutoResize = 'WIDTH_AND_HEIGHT';
  var rel = autoFrame('promos', 'VERTICAL', sh); fillHug(rel); bindNumber(R, rel, 'itemSpacing', '--gap-related', 8);
  var pc = P.promo['pass=false'].createInstance(); rel.appendChild(pc); pc.layoutSizingHorizontal = 'FILL';
  var cs = P.credit.children[0].createInstance(); rel.appendChild(cs); cs.layoutSizingHorizontal = 'FILL';
  // .info-tiles: 2 columns, gap 8 / 12; the last (--wide) spans both
  var tiles = autoFrame('info-tiles', 'VERTICAL', sh); fillHug(tiles); bindNumber(R, tiles, 'itemSpacing', '--space-8', 8);
  for (var ri = 0; ri < 3; ri++) {
    var row = autoFrame('row', 'HORIZONTAL', tiles); fillHug(row); bindNumber(R, row, 'itemSpacing', '--space-12', 12);
    EVD_TILES.slice(ri * 2, ri * 2 + 2).forEach(function (x) { var t = P.tile.children[0].createInstance(); row.appendChild(t); t.layoutSizingHorizontal = 'FILL'; setText(t, { icon: TI[x[0]].id, label: x[1], value: x[2] }); });
  }
  function block(name) { var b = autoFrame(name, 'VERTICAL', sh); fillHug(b); bindNumber(R, b, 'itemSpacing', '--space-16', 16); return b; }
  function divider() { var d = DV['type=line'].createInstance(); sh.appendChild(d); d.layoutSizingHorizontal = 'FILL'; }
  function muted(parent, label, icon, block) {
    var b = BT['size=s, tone=muted, appearance=tertiary, state=default'].createInstance(); parent.appendChild(b); if (block) b.layoutSizingHorizontal = 'FILL';
    setText(b, { label: label, showIconStart: false, showIconEnd: true, iconEnd: icon.id }); return b;
  }
  var b1 = block('information');
  await txt(b1, '--type-h5', '--dark-300', 'Event information & rundown', 'section-title');
  await txt(b1, '--type-b3', '--dark-500', EVD_TEXT, 'event-text');
  divider();
  var b2 = block('organizer');
  var ban = figma.createRectangle(); b2.appendChild(ban); ban.name = 'event-banner'; ban.resize(342, Math.round(342 * 480 / 981)); ban.layoutSizingHorizontal = 'FILL'; ban.cornerRadius = 24;
  await refPhoto(R, ban, 'ref/img/ev/organizer.jpg?v=1', notes);
  await txt(b2, '--type-h5', '--dark-300', 'Event organized by Indonesian Development Open', 'section-title');
  await txt(b2, '--type-b3', '--dark-500', EVD_ORG, 'event-text');
  var br = autoFrame('btn-row', 'HORIZONTAL', b2); hugHug(br); bindNumber(R, br, 'itemSpacing', '--space-8', 8);
  muted(br, 'SEE FACT SHEET', I.ext); muted(br, 'Follow Instagram', I.ext);
  divider();
  var b3 = block('venue');
  await txt(b3, '--type-h5', '--dark-300', 'Event venue', 'section-title');
  var vn = byName(P.venue)['size=m'].createInstance(); b3.appendChild(vn); vn.layoutSizingHorizontal = 'FILL';
  muted(b3, 'View on Google Maps', I.map, true);
  divider();
  var b4 = block('sponsors');
  await txt(b4, '--type-h5', '--dark-300', 'Supported & sponsored by', 'section-title');
  var grid = autoFrame('brand-grid', 'VERTICAL', b4); fillHug(grid); bindNumber(R, grid, 'itemSpacing', '--space-8', 8);
  for (var bi = 0; bi < EVD_BRANDS.length; bi += 2) {
    var gr = autoFrame('row', 'HORIZONTAL', grid); fillHug(gr); bindNumber(R, gr, 'itemSpacing', '--space-12', 12);
    for (var bj = bi; bj < Math.min(bi + 2, EVD_BRANDS.length); bj++) {
      var b = EVD_BRANDS[bj], bc = P.brand['wide=' + (EVD_WIDE[b[1]] ? 'true' : 'false')].createInstance(); gr.appendChild(bc); bc.layoutSizingHorizontal = 'FILL';
      setText(bc, { name: b[0] }); var lg = bc.findOne(function (n) { return n.name === 'logo'; }); if (lg) await refPhoto(R, lg, 'ref/img/ev/brand-' + b[1] + '.png?v=1', notes);
    }
    if (bj - bi === 1) { var sp = autoFrame('empty', 'VERTICAL', gr); sp.layoutSizingHorizontal = 'FILL'; sp.layoutSizingVertical = 'HUG'; }   // odd count: keep the grid column
  }
  muted(b4, 'Become a sponsor', I.ext, true);
  // .bottom-bar: Join Swing Pass (Button l, tone pass) with the white arrow
  var bb = autoFrame('bottom-bar', 'VERTICAL', scr); fillHug(bb); padX(R, bb);
  bindNumber(R, bb, 'paddingTop', '--space-16', 16); bindNumber(R, bb, 'paddingBottom', '--space-32', 32); bb.fills = paintFor(R, '--light-100');
  var up = lineBelow(R)[0]; if (up) bb.effects = [Object.assign({}, up, { offset: { x: 0, y: -1 } })];
  var jb = BT['size=l, tone=pass, appearance=solid, state=default'].createInstance(); bb.appendChild(jb); jb.layoutSizingHorizontal = 'FILL';
  setText(jb, { label: 'Join Swing Pass', showIconStart: false, showIconEnd: true, iconEnd: I.arrow.id });

  var one = function (m, props) { var i = m.createInstance(); if (props) setText(i, props); return i; };
  await screenList(R, page, scr, 'Swing Pass event', async function (row) {
    await row('AppBar', partSrc('AppBar', PG) + ' · type=adsShare: ADS back, centred title, share', [one(appBar['type=adsShare, scrolled=false'], { title: 'Event details', showActions: true })]);
    await row('PromoCard', partSrc('PromoCard', PG) + ' · pass=false here; pass=true for Swing Pass exclusive', [one(P.promo['pass=false']), one(P.promo['pass=true'])]);
    await row('CreditStrip', partSrc('CreditStrip', PG) + ' · cashback line', [P.credit]);
    await row('InfoTile', partSrc('InfoTile', PG) + ' · 5 tiles in 2 columns, the last full width', [P.tile]);
    await row('Venue', partSrc('Venue', PG) + ' · size=m: name, address, distance, map', [byName(P.venue)['size=m'].createInstance()]);
    await row('BrandCard', partSrc('BrandCard', PG) + ' · wide=false / wide=true logos, 15 sponsors', [one(P.brand['wide=false']), one(P.brand['wide=true'])]);
    await row('Divider', partSrc('Divider', PG) + ' · type=line between blocks', [one(DV['type=line'])]);
    await row('Button', partSrc('Button', PG) + ' · tone=muted s tertiary with icons; tone=pass l in the bottom bar', [one(BT['size=s, tone=muted, appearance=tertiary, state=default'], { label: 'SEE FACT SHEET', showIconEnd: true, iconEnd: I.ext.id }), one(BT['size=l, tone=pass, appearance=solid, state=default'], { label: 'Join Swing Pass', showIconEnd: true, iconEnd: I.arrow.id })]);
  });
  notes.push('Swing Pass event: built from stat.chara.id/swing/ref/swingpass-event.html. The sheet rides 16 over the photo with a negative gap; grids are rows of two (no CSS grid in Figma); the organiser banner keeps its 24 radius (ADS, not a token).');
  return { set: scr, count: 8, label: 'screen from 8 parts' };
}

/* ----- Join Swing Pass, billing method, one time payment (ref/swingpass-join, -billing, -onetime): NoteBar, MethodRow, Plan ----- */
var SPJ_PAGE = 'Screen / Join Swing Pass';
// A ref logo or art as a component (any w x h; SVG drawn, PNG/JPG as an image fill), so a row can swap it
async function refLogo(R, name, path, w, h, notes, page) {
  var full = 'Logo/Ref/' + name;
  var c = page.findOne(function (n) { return n.type === 'COMPONENT' && n.name === full; });
  if (!c) { c = figma.createComponent(); page.appendChild(c); c.name = full; c.x = -400; c.y = 0; }
  c.children.slice().forEach(function (x) { x.remove(); });
  c.resizeWithoutConstraints(w, h); c.fills = []; c.clipsContent = true;
  if (/\.svg/.test(path)) {
    var n = await refArt(R, c, path, null, h, 'art', notes);
    if (n.width > w) n.rescale(w / n.width);
    n.x = 0; n.y = Math.round((h - n.height) / 2);   // object-position: left centre
  } else { var r = figma.createRectangle(); c.appendChild(r); r.name = 'art'; r.resize(w, h); await refPhoto(R, r, path, notes); }
  c.description = 'From ' + REF_URL + path + '.';
  return c;
}

async function buildNoteBarPage(R, notes) {
  var page = await pageNamed(SPJ_PAGE);
  var info = await spArt(R, 'info-w', 16, notes, page);
  var nb = {};
  var V = [{ tone: 'dark', name: 'tone=dark' }, { tone: 'primary', name: 'tone=primary' }, { tone: 'warning', name: 'tone=warning' }];
  return buildPartPage(R, notes, 'NoteBar', async function (comp, K, pg, v) {
    // .note-bar (ADS inline toaster): 8, gap 8, radius 8, dark-200 (primary: purple-500, warning: orange-700), B3s white + info 16
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER'; comp.resize(342, 36); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].forEach(function (f) { bindNumber(R, comp, f, '--space-8', 8); });
    bindNumber(R, comp, 'itemSpacing', '--space-8', 8); bindRadius(R, comp, '--radius-8', 8);
    comp.fills = paintFor(R, v.tone === 'primary' ? '--purple-500' : v.tone === 'warning' ? '--orange-700' : '--dark-200');
    var i = info.createInstance(); comp.appendChild(i); i.name = 'icon'; i.resize(16, 16);
    nb[comp.name] = await K.txt(comp, '--type-b3s', '--light-100', 'You will be auto renewed with recurring billing methods.', 'text', 'fill');
  }, function (s) {
    var pT = ensureProp(s, 'text', 'TEXT', 'You will be auto renewed with recurring billing methods.');
    wireKeys(nb).forEach(function (k) { nb[k].componentPropertyReferences = { characters: pT }; });
    s.description = '<p class="swing_note_bar [swing_note_bar_primary|--warning]"><i class="swing_icon">info</i>…</p>. ADS inline toaster: padding 8, gap 8, radius 8, dark-200 (primary purple-500, warning orange-700), B3 Semibold white.';
  }, { description: 'A short dark note on the grey band.', variants: V });
}

async function buildMethodRowPage(R, notes) {
  var BT = byName(await setFrom('Button', 'Button', buildButton, R, notes));
  var page = await pageNamed(SPJ_PAGE);
  var logo = await refLogo(R, 'mastercard', 'ref/img/sp/mastercard.svg?v=1', 22, 22, notes, page);
  var wide = await refLogo(R, 'bca', 'ref/img/pay/bca.svg?v=1', 40, 22, notes, page);
  var chev = await spArt(R, 'chev-right', 16, notes, page);
  var mr = {};
  var V = []; ['square', 'wide'].forEach(function (l) { ['none', 'button', 'chevron'].forEach(function (e) { V.push({ logo: l, end: e, name: 'logo=' + l + ', end=' + e }); }); });
  return buildPartPage(R, notes, 'MethodRow', async function (comp, K, pg, v) {
    // .method-row: centred, gap 14, min 48 (56 with a button), light-500 line under it; logo 22 (wide: 40 x 22); name B2s dark-500; end = Button s tertiary or chevron 16
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER'; comp.resize(342, 48); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    comp.minHeight = v.end === 'button' ? 56 : 48; bindNumber(R, comp, 'itemSpacing', '--ads-gap-14', 14); comp.fills = [];
    comp.strokes = paintFor(R, '--light-500'); comp.strokeAlign = 'INSIDE'; comp.strokeTopWeight = 0; comp.strokeRightWeight = 0; comp.strokeLeftWeight = 0; comp.strokeBottomWeight = 1;
    var lg = (v.logo === 'wide' ? wide : logo).createInstance(); comp.appendChild(lg); lg.name = 'logo';
    var nm = await K.txt(comp, '--type-b2s', '--dark-500', v.logo === 'wide' ? 'BCA virtual account' : 'Mastercard 1234', 'name', 'fill');
    var p = { lg: lg, nm: nm };
    if (v.end === 'button') { var b = BT['size=s, tone=primary, appearance=tertiary, state=default'].createInstance(); comp.appendChild(b); b.name = 'action'; setText(b, { label: 'Connect', showIconStart: false, showIconEnd: false }); }
    if (v.end === 'chevron') { var c = chev.createInstance(); comp.appendChild(c); c.name = 'chevron'; c.resize(16, 16); }
    mr[comp.name] = p;
  }, function (s) {
    var pL = ensureProp(s, 'logoImage', 'INSTANCE_SWAP', logo.id), pN = ensureProp(s, 'name', 'TEXT', 'Mastercard 1234');
    wireKeys(mr).forEach(function (k) { mr[k].lg.componentPropertyReferences = { mainComponent: pL }; mr[k].nm.componentPropertyReferences = { characters: pN }; });
    s.description = '<a class="swing_method_row"><img 22 | class="swing_method_row__logo" 40 x 22><span class="swing_method_row__name">…</span>[button | chevron]</a> in .swing_method_list. Gap 14, min 48 (56 with a button), light-500 line under it (set the last instance\'s bottom stroke to 0 where the web has no line). Swap the logo with the logoImage property (Logo/Ref/*); a DS line icon also fits the 22 slot.';
  }, { description: 'A payment method row: logo, name, and a button or chevron.', variants: V });
}

async function buildPlanPage(R, notes) {
  var page = await pageNamed(SPJ_PAGE);
  var on = await refLogo(R, 'radio-on', 'ref/img/tq/radio-on.svg?v=1', 20, 20, notes, page);
  var pl = {};
  var V = []; ['popular', 'was', 'plain'].forEach(function (k) { ['true', 'false'].forEach(function (sel) { V.push({ kind: k, selected: sel, name: 'kind=' + k + ', selected=' + sel }); }); });
  return buildPartPage(R, notes, 'Plan', async function (comp, K, pg, v) {
    // .plan: clip, light-500 line, radius 8, white (selected: purple-500 line, purple-50); .plan__flag (popular) 8/16 purple-500, Label S white uppercase;
    // body 8/16, gap 16: name B2s + prices (B3s: was dark-200 struck, now orange-500; "~ " in B3), radio 20 in a 48 tap
    var sel = v.selected === 'true';
    comp.layoutMode = 'VERTICAL'; comp.resize(342, 64); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG'; comp.itemSpacing = 0;
    comp.clipsContent = true; bindRadius(R, comp, '--radius-8', 8); comp.fills = paintFor(R, sel ? '--purple-50' : '--light-100');
    comp.strokes = paintFor(R, sel ? '--purple-500' : '--light-500'); comp.strokeWeight = 1; comp.strokeAlign = 'INSIDE';
    var p = {};
    if (v.kind === 'popular') {
      var fl = autoFrame('flag', 'HORIZONTAL', comp); fillHug(fl); fl.fills = paintFor(R, '--purple-500');
      bindNumber(R, fl, 'paddingTop', '--space-8', 8); bindNumber(R, fl, 'paddingBottom', '--space-8', 8); bindNumber(R, fl, 'paddingLeft', '--space-16', 16); bindNumber(R, fl, 'paddingRight', '--space-16', 16);
      p.flag = await K.txt(fl, '--type-lbl-s', '--light-100', 'MOST POPULAR!', 'text', 'fill');
    }
    var bd = autoFrame('body', 'HORIZONTAL', comp); fillHug(bd); bd.counterAxisAlignItems = 'CENTER'; bindNumber(R, bd, 'itemSpacing', '--space-16', 16);
    bindNumber(R, bd, 'paddingTop', '--space-8', 8); bindNumber(R, bd, 'paddingBottom', '--space-8', 8); bindNumber(R, bd, 'paddingLeft', '--space-16', 16); bindNumber(R, bd, 'paddingRight', '--space-16', 16);
    var tx = autoFrame('text', 'VERTICAL', bd); tx.layoutSizingHorizontal = 'FILL'; tx.layoutSizingVertical = 'HUG'; bindNumber(R, tx, 'itemSpacing', '--space-4', 4);
    p.name = await K.txt(tx, '--type-b2s', '--dark-500', v.kind === 'plain' ? '3 months' : v.kind === 'was' ? '6 months' : '12 months', 'name', 'fill');
    var pr = autoFrame('prices', 'HORIZONTAL', tx); hugHug(pr); bindNumber(R, pr, 'itemSpacing', '--space-8', 8);
    async function price(name, text, color, strike) {
      var t = await styledText(R, '--type-b3s', color, '~ ' + text); pr.appendChild(t); t.name = name; t.textAutoResize = 'WIDTH_AND_HEIGHT';
      var b3 = R.text['--type-b3']; if (b3) { await figma.loadFontAsync(b3.fontName); await t.setRangeTextStyleIdAsync(0, 2, b3.id); }   // .plan__approx
      if (strike) t.setRangeTextDecoration(2, t.characters.length, 'STRIKETHROUGH');
      return t;
    }
    if (v.kind !== 'plain') p.was = await price('was', v.kind === 'was' ? 'Rp. 1,500,000' : 'Rp. 3,000,000', '--dark-200', true);
    p.now = await price('now', v.kind === 'plain' ? 'Rp. 750,000' : v.kind === 'was' ? 'Rp. 1,400,000' : 'Rp. 2,500,000', v.kind === 'plain' ? '--dark-300' : '--orange-500', false);
    var rb = autoFrame('radio', 'HORIZONTAL', bd); rb.primaryAxisAlignItems = 'CENTER'; rb.counterAxisAlignItems = 'CENTER';
    rb.resize(48, 48); rb.layoutSizingHorizontal = 'FIXED'; rb.layoutSizingVertical = 'FIXED';
    if (sel) { var ri = on.createInstance(); rb.appendChild(ri); ri.name = 'dot'; }
    else { var c = figma.createEllipse(); rb.appendChild(c); c.name = 'dot'; c.resize(20, 20); c.fills = paintFor(R, '--light-100'); c.strokes = paintFor(R, '--dark-100'); c.strokeWeight = 1; c.strokeAlign = 'INSIDE'; }
    pl[comp.name] = p;
  }, function (s) {
    var P = { name: ensureProp(s, 'name', 'TEXT', '12 months'), was: ensureProp(s, 'was', 'TEXT', '~ Rp. 3,000,000'), now: ensureProp(s, 'now', 'TEXT', '~ Rp. 2,500,000'), flag: ensureProp(s, 'flag', 'TEXT', 'MOST POPULAR!') };
    wireKeys(pl).forEach(function (k) { wireKeys(P).forEach(function (f) { if (pl[k][f]) pl[k][f].componentPropertyReferences = { characters: P[f] }; }); });
    s.description = '<label class="swing_plan">[<span class="swing_plan__flag">Most popular!</span>]<span class="swing_plan__body"><span class="swing_plan__text">name + .swing_plan__prices (was + now)</span><input class="swing_choice__radio" type="radio"></span></label> in .swing_plan_list (gap 8). kind: popular = flag + struck price + now, was = struck + now, plain = one price (dark-300). selected = the checked plan (purple-500 line, purple-50). Price texts keep the "~ " prefix; a text override keeps its first two characters in B3 only if you keep them.';
  }, { description: 'A billing plan to pick, with its price.', variants: V });
}

function spjScreen(page, name, R) {
  var old = page.findChild(function (n) { return n.type === 'FRAME' && n.name === name; });
  var keepX = old ? old.x : 0, keepY = old ? old.y : 0;
  if (old) old.remove();
  var scr = figma.createFrame(); page.appendChild(scr);
  scr.name = name; scr.x = keepX; scr.y = keepY;
  scr.layoutMode = 'VERTICAL'; scr.resize(390, 844); scr.layoutSizingHorizontal = 'FIXED'; scr.layoutSizingVertical = 'HUG'; scr.minHeight = 844;
  scr.itemSpacing = 0; scr.clipsContent = true; scr.fills = paintFor(R, '--light-100');
  return scr;
}
// .sections: grey, gap 4, 4 at the bottom; .page white 32 / page-x / 32, gap 16; .page--tail.page--band transparent, 16 / 16, gap 16
function spjSections(R, scr) {
  var main = autoFrame('sections', 'VERTICAL', scr); main.layoutSizingHorizontal = 'FILL'; main.layoutSizingVertical = 'FILL';
  bindNumber(R, main, 'itemSpacing', '--space-4', 4); bindNumber(R, main, 'paddingBottom', '--space-4', 4); main.fills = paintFor(R, '--light-200');
  return {
    main: main,
    band: function (name) { var b = autoFrame(name, 'VERTICAL', main); fillHug(b); padX(R, b); bindNumber(R, b, 'paddingTop', '--space-16', 16); bindNumber(R, b, 'paddingBottom', '--space-16', 16); bindNumber(R, b, 'itemSpacing', '--space-16', 16); return b; },
    page: async function (name, title) {
      var p = autoFrame(name, 'VERTICAL', main); fillHug(p); padX(R, p); p.fills = paintFor(R, '--light-100');
      bindNumber(R, p, 'paddingTop', '--space-32', 32); bindNumber(R, p, 'paddingBottom', '--space-32', 32); bindNumber(R, p, 'itemSpacing', '--space-16', 16);
      if (title) { var t = await styledText(R, '--type-h5', '--dark-300', title); p.appendChild(t); t.name = 'section-title'; t.textAutoResize = 'HEIGHT'; t.layoutSizingHorizontal = 'FILL'; }
      return p;
    }
  };
}

async function buildSwingPassJoinScreen(R, notes) {
  var PG = SPJ_PAGE, page = await pageNamed(PG);
  var appBar = byName(await setWith('AppBar', 'AppBar', buildAppBarPage, R, notes, 'type=ads, scrolled=false'));
  var BT = byName(await setFrom('Button', 'Button', buildButton, R, notes));
  var SC = byName(await setFrom('Button', 'SlideConfirm', buildButton, R, notes));
  var CB = byName(await setFrom('Checkbox', 'Checkbox', buildCheckboxPage, R, notes));
  var NB = byName(await setWith('NoteBar', 'NoteBar', buildNoteBarPage, R, notes, 'tone=warning'));
  var PL = byName(await setWith('Plan', 'Plan', buildPlanPage, R, notes, 'kind=plain, selected=false'));
  var PM = byName(await setWith('PayMethod', 'PayMethod', buildPayMethodPage, R, notes, 'type=action'));
  var I = { arrow: await spArt(R, 'arrow-right-lg', 12, notes, page, '--purple-500'), infoD: await spArt(R, 'info-d', 16, notes, page), tag: await refLogo(R, 'price-tag', 'ref/img/sp/price-tag.svg?v=1', 22, 22, notes, page),
    reload: await refLogo(R, 'reload-left', 'ref/img/sp/reload-left.svg?v=1', 22, 22, notes, page) };
  var scr = spjScreen(page, 'Join Swing Pass', R);
  var bar = appBar['type=ads, scrolled=false'].createInstance(); scr.appendChild(bar); bar.layoutSizingHorizontal = 'FILL'; setText(bar, { title: 'Join Swing Pass', showActions: false });
  var S = spjSections(R, scr);
  // 1. region note: light-300, radius 8; route 8 (your country -> Swing Pass country, B4s, flags 16, arrow 12 purple-500), then a note bar
  var b1 = S.band('region');
  var rn = autoFrame('region-note', 'VERTICAL', b1); fillHug(rn); bindRadius(R, rn, '--radius-8', 8); rn.fills = paintFor(R, '--light-300');
  var rt = autoFrame('route', 'HORIZONTAL', rn); fillHug(rt); rt.counterAxisAlignItems = 'CENTER'; bindNumber(R, rt, 'itemSpacing', '--space-8', 8);
  ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].forEach(function (f) { bindNumber(R, rt, f, '--space-8', 8); });
  async function place(flag, text) {
    var pl = autoFrame('place', 'HORIZONTAL', rt); pl.layoutSizingHorizontal = 'FILL'; pl.layoutSizingVertical = 'HUG'; pl.primaryAxisAlignItems = 'CENTER'; pl.counterAxisAlignItems = 'CENTER';
    bindNumber(R, pl, 'itemSpacing', '--space-4', 4); await refArt(R, pl, flag, 16, 16, 'flag', notes);
    var t = await styledText(R, '--type-b4s', '--dark-500', text); pl.appendChild(t); t.name = 'text'; t.textAutoResize = 'WIDTH_AND_HEIGHT';
  }
  await place('ds/img/flag-id.svg', 'Indonesia (your location)');
  var ar = I.arrow.createInstance(); rt.appendChild(ar); ar.name = 'arrow'; ar.resize(12, 12);
  await place('ref/img/sp/flag-my.svg?v=1', 'Malaysia (Swing Pass)');
  var nb = NB['tone=dark'].createInstance(); rn.appendChild(nb); nb.layoutSizingHorizontal = 'FILL';
  setText(nb, { text: 'You are joining Swing Pass in another country. Prices shown are converted to your local currency based on today\'s conversion rate.' });
  // 2. plans
  var p2 = await S.page('plans', 'Select billing plan');
  var pls = autoFrame('plan-list', 'VERTICAL', p2); fillHug(pls); bindNumber(R, pls, 'itemSpacing', '--space-8', 8);
  [['popular', 'true', '12 months'], ['was', 'false', '6 months'], ['plain', 'false', '3 months']].forEach(function (x) {
    var i = PL['kind=' + x[0] + ', selected=' + x[1]].createInstance(); pls.appendChild(i); i.layoutSizingHorizontal = 'FILL';
  });
  // 3. billing method
  var p3 = await S.page('billing', 'Select billing method');
  var pml = autoFrame('pay-method-list', 'VERTICAL', p3); fillHug(pml); bindNumber(R, pml, 'itemSpacing', '--space-4', 4);
  [[I.tag, 'Swing Pass promo code', 'Add'], [I.reload, 'Select billing method', 'Select']].forEach(function (x) {
    var i = PM['type=action'].createInstance(); pml.appendChild(i); i.layoutSizingHorizontal = 'FILL'; setText(i, { icon: x[0].id, name: x[1] });
    var b = i.findOne(function (n) { return n.type === 'INSTANCE' && n.name === 'action'; }); if (b) setText(b, { label: x[2] });
  });
  // 4. agree: Checkbox + B3s text with the terms link in purple-500
  var b4 = S.band('agree');
  var ag = autoFrame('agree', 'HORIZONTAL', b4); fillHug(ag); ag.counterAxisAlignItems = 'CENTER'; bindNumber(R, ag, 'itemSpacing', '--space-8', 8);
  var cb = CB['checked=true, state=default'].createInstance(); ag.appendChild(cb); cb.name = 'checkbox';
  var AG = 'I have read and agreed to Swing Pass\u2019s terms & conditions.', LK = 'Swing Pass\u2019s terms & conditions';
  var at = await styledText(R, '--type-b3s', '--dark-500', AG); ag.appendChild(at); at.name = 'text'; at.textAutoResize = 'HEIGHT'; at.layoutSizingHorizontal = 'FILL';
  var li = AG.indexOf(LK); at.setRangeFills(li, li + LK.length, paintFor(R, '--purple-500'));
  // bottom bar (spaced: gap 16): total (H6 + info 16, term B3s dark-300) and the slide to confirm
  var bb = autoFrame('bottom-bar', 'VERTICAL', scr); fillHug(bb); padX(R, bb);
  bindNumber(R, bb, 'paddingTop', '--space-16', 16); bindNumber(R, bb, 'paddingBottom', '--space-32', 32); bindNumber(R, bb, 'itemSpacing', '--space-16', 16);
  bb.fills = paintFor(R, '--light-100'); var up = lineBelow(R)[0]; if (up) bb.effects = [Object.assign({}, up, { offset: { x: 0, y: -1 } })];
  var tot = autoFrame('plan-total', 'HORIZONTAL', bb); fillHug(tot); tot.counterAxisAlignItems = 'MAX'; tot.primaryAxisAlignItems = 'SPACE_BETWEEN'; bindNumber(R, tot, 'itemSpacing', '--space-8', 8);
  var tp = autoFrame('price', 'HORIZONTAL', tot); hugHug(tp); tp.counterAxisAlignItems = 'CENTER'; bindNumber(R, tp, 'itemSpacing', '--space-4', 4);
  var t1 = await styledText(R, '--type-h6', '--dark-500', '\u2248 Rp. 2,500,000'); tp.appendChild(t1); t1.name = 'total'; t1.textAutoResize = 'WIDTH_AND_HEIGHT';
  var ii = I.infoD.createInstance(); tp.appendChild(ii); ii.name = 'info'; ii.resize(16, 16);
  var t2 = await styledText(R, '--type-b3s', '--dark-300', 'for 12 months'); tot.appendChild(t2); t2.name = 'term'; t2.textAutoResize = 'WIDTH_AND_HEIGHT';
  var sc = SC['tone=primary, state=default'].createInstance(); bb.appendChild(sc); sc.layoutSizingHorizontal = 'FILL';

  var one = function (m, props) { var i = m.createInstance(); if (props) setText(i, props); return i; };
  await screenList(R, page, scr, 'Join Swing Pass', async function (row) {
    await row('AppBar', partSrc('AppBar', PG) + ' · type=ads, no actions', [one(appBar['type=ads, scrolled=false'], { title: 'Join Swing Pass', showActions: false })]);
    await row('NoteBar', partSrc('NoteBar', PG) + ' · tone=dark / primary / warning', [one(NB['tone=dark']), one(NB['tone=primary'])]);
    await row('Plan', partSrc('Plan', PG) + ' · kind=popular selected, was, plain', [one(PL['kind=popular, selected=true']), one(PL['kind=plain, selected=false'])]);
    await row('PayMethod', partSrc('PayMethod', PG) + ' · type=action: icon, name, button (Add / Select)', [one(PM['type=action'])]);
    await row('Checkbox', partSrc('Checkbox', PG) + ' · checked, in the agree row', [one(CB['checked=true, state=default'])]);
    await row('SlideConfirm', partSrc('Button', PG) + ' · tone=primary in the bottom bar', [one(SC['tone=primary, state=default'])]);
  });
  notes.push('Join Swing Pass: built from stat.chara.id/swing/ref/swingpass-join.html. Differences: the web uses the ADS Checkbox S (20, radius 4) and Slide confirm M (48, light-300 track); the DS has one size of each, so the DS ones are used. The price info sheet is a state, not drawn.');
  return { set: scr, count: 6, label: 'screen from 6 parts' };
}

async function buildSwingPassBillingScreen(R, notes) {
  var PG = 'Screen / Swing Pass billing', page = await pageNamed(PG);
  var appBar = byName(await setWith('AppBar', 'AppBar', buildAppBarPage, R, notes, 'type=ads, scrolled=false'));
  var BT = byName(await setFrom('Button', 'Button', buildButton, R, notes));
  var NB = byName(await setWith('NoteBar', 'NoteBar', buildNoteBarPage, R, notes, 'tone=warning'));
  var MR = byName(await setWith('MethodRow', 'MethodRow', buildMethodRowPage, R, notes, 'logo=wide, end=chevron'));
  var spPage = await pageNamed(SPJ_PAGE);
  var L = { mc: await refLogo(R, 'mastercard', 'ref/img/sp/mastercard.svg?v=1', 22, 22, notes, spPage), ovo: await refLogo(R, 'ovo', 'ref/img/sp/ovo.png?v=1', 22, 22, notes, spPage),
    wallet: await iconOrPlaceholder('Icon/Line/wallet', page, notes), plus: await spArt(R, 'plus-14', 14, notes, page, '--light-100') };
  var scr = spjScreen(page, 'Swing Pass billing', R);
  var bar = appBar['type=ads, scrolled=false'].createInstance(); scr.appendChild(bar); bar.layoutSizingHorizontal = 'FILL'; setText(bar, { title: 'Select billing method', showActions: false });
  var S = spjSections(R, scr);
  var b1 = S.band('note'); var nb = NB['tone=dark'].createInstance(); b1.appendChild(nb); nb.layoutSizingHorizontal = 'FILL'; setText(nb, { text: 'You will be auto renewed with recurring billing methods.' });
  function list(parent, rows) {
    var l = autoFrame('method-list', 'VERTICAL', parent); fillHug(l); l.itemSpacing = 0;
    rows.forEach(function (r) { var i = MR['logo=square, end=' + r[2]].createInstance(); l.appendChild(i); i.layoutSizingHorizontal = 'FILL'; setText(i, { logoImage: r[0].id, name: r[1] });
      if (r[0] === L.wallet) { var lg = i.findOne(function (n) { return n.name === 'logo'; }); if (lg) { try { lg.resize(22, 22); } catch (e) { /* keep */ } recolorIcon(R, lg, '--dark-500'); } } });
    return l;
  }
  var p1 = await S.page('cards', 'Credit cards');
  list(p1, [[L.mc, 'Mastercard 1234', 'none']]);
  var ad = BT['size=s, tone=primary, appearance=solid, state=default'].createInstance(); p1.appendChild(ad); ad.layoutSizingHorizontal = 'FILL';
  setText(ad, { label: 'Add credit card', showIconStart: true, iconStart: L.plus.id, showIconEnd: false });
  var p2 = await S.page('wallets', 'Recurring e-wallets');
  list(p2, [[L.ovo, 'OVO wallet', 'button'], [L.wallet, 'GoPay wallet', 'button'], [L.wallet, 'ShopeePay wallet', 'button']]);
  var one = function (m, props) { var i = m.createInstance(); if (props) setText(i, props); return i; };
  await screenList(R, page, scr, 'Swing Pass billing', async function (row) {
    await row('AppBar', partSrc('AppBar', PG) + ' · type=ads, no actions', [one(appBar['type=ads, scrolled=false'], { title: 'Select billing method', showActions: false })]);
    await row('NoteBar', partSrc('NoteBar', PG) + ' · tone=dark', [one(NB['tone=dark'])]);
    await row('MethodRow', partSrc('MethodRow', PG) + ' · logo=square: end=none (card), end=button (Connect)', [one(MR['logo=square, end=none']), one(MR['logo=square, end=button'])]);
    await row('Button', partSrc('Button', PG) + ' · size=s primary solid, block, plus 14', [one(BT['size=s, tone=primary, appearance=solid, state=default'], { label: 'Add credit card', showIconStart: true, iconStart: L.plus.id })]);
  });
  notes.push('Swing Pass billing: built from stat.chara.id/swing/ref/swingpass-billing.html. GoPay and ShopeePay use the DS wallet icon, as on the web (their logos are not in the ref yet).');
  return { set: scr, count: 4, label: 'screen from 4 parts' };
}

var SPO_PAY = [['dana', 'svg', 'DANA'], ['linkaja', 'svg', 'LinkAja!']];
var SPO_VA = [['bca', 'svg', 'BCA virtual account'], ['mandiri', 'svg', 'Mandiri virtual account'], ['bni', 'svg', 'BNI virtual account'], ['bri', 'svg', 'BRI virtual account'], ['permata', 'svg', 'Permata virtual account'],
  ['cimb', 'svg', 'CIMB virtual account'], ['sampoerna', 'png', 'Sahabat Sampoerna virtual account'], ['bsi', 'svg', 'BSI virtual account'], ['bjb', 'svg', 'BJB virtual account']];
async function buildSwingPassOnetimeScreen(R, notes) {
  var PG = 'Screen / Swing Pass one time', page = await pageNamed(PG);
  var appBar = byName(await setWith('AppBar', 'AppBar', buildAppBarPage, R, notes, 'type=ads, scrolled=false'));
  var NB = byName(await setWith('NoteBar', 'NoteBar', buildNoteBarPage, R, notes, 'tone=warning'));
  var MR = byName(await setWith('MethodRow', 'MethodRow', buildMethodRowPage, R, notes, 'logo=wide, end=chevron'));
  var spPage = await pageNamed(SPJ_PAGE);
  var qr = await refLogo(R, 'qr-code', 'ref/img/sp/qr-code.svg?v=1', 22, 22, notes, spPage);
  var LG = {}; for (var x of SPO_PAY.concat(SPO_VA)) LG[x[0]] = await refLogo(R, x[0], 'ref/img/pay/' + x[0] + '.' + x[1] + '?v=1', 40, 22, notes, spPage);
  var scr = spjScreen(page, 'Swing Pass one time', R);
  var bar = appBar['type=ads, scrolled=false'].createInstance(); scr.appendChild(bar); bar.layoutSizingHorizontal = 'FILL'; setText(bar, { title: 'Select billing method', showActions: false });
  var S = spjSections(R, scr);
  var b1 = S.band('note'); var nb = NB['tone=dark'].createInstance(); b1.appendChild(nb); nb.layoutSizingHorizontal = 'FILL';
  setText(nb, { text: 'You will not be auto renewed with one time payments and you\u2019ll have to pay again later.' });
  function list(parent, rows, logo) {
    var l = autoFrame('method-list', 'VERTICAL', parent); fillHug(l); l.itemSpacing = 0;
    rows.forEach(function (r) { var i = MR['logo=' + logo + ', end=none'].createInstance(); l.appendChild(i); i.layoutSizingHorizontal = 'FILL'; setText(i, { logoImage: (r[3] || LG[r[0]]).id, name: r[2] }); });
  }
  list(await S.page('qris', 'QRIS'), [['qr', '', 'QRIS', qr]], 'square');
  list(await S.page('ewallets', 'E-wallets'), SPO_PAY, 'wide');
  list(await S.page('va', 'Virtual accounts'), SPO_VA, 'wide');
  var one = function (m, props) { var i = m.createInstance(); if (props) setText(i, props); return i; };
  await screenList(R, page, scr, 'Swing Pass one time', async function (row) {
    await row('AppBar', partSrc('AppBar', PG) + ' · type=ads, no actions', [one(appBar['type=ads, scrolled=false'], { title: 'Select billing method', showActions: false })]);
    await row('NoteBar', partSrc('NoteBar', PG) + ' · tone=dark', [one(NB['tone=dark'])]);
    await row('MethodRow', partSrc('MethodRow', PG) + ' · logo=square (QRIS) and logo=wide (40 x 22 bank and wallet logos), end=none', [one(MR['logo=square, end=none']), one(MR['logo=wide, end=none'])]);
  });
  notes.push('Swing Pass one time: built from stat.chara.id/swing/ref/swingpass-onetime.html. The bank and wallet logos are Logo/Ref/* components on Screen / Join Swing Pass; swap them with the logoImage property.');
  return { set: scr, count: 3, label: 'screen from 3 parts' };
}

/* ----- QRIS payment and the waiting-for-verification state (ref/swingpass-qris.html, ref/swingpass-waiting.html) ----- */
async function buildSwingPassQrisScreen(R, notes) {
  var PG = 'Screen / Swing Pass QRIS', page = await pageNamed(PG);
  var appBar = byName(await setWith('AppBar', 'AppBar', buildAppBarPage, R, notes, 'type=ads, scrolled=false'));
  var BT = byName(await setWith('Button', 'Button', buildButton, R, notes, 'size=s, tone=danger, appearance=tertiary, state=default'));
  var DV = byName(await setFrom('Divider', 'Divider', buildDividerPage, R, notes));
  var NB = byName(await setWith('NoteBar', 'NoteBar', buildNoteBarPage, R, notes, 'tone=warning'));
  var dl = await spArt(R, 'download-w', 20, notes, page, '--light-100');
  var scr = spjScreen(page, 'Swing Pass QRIS', R);
  var bar = appBar['type=ads, scrolled=false'].createInstance(); scr.appendChild(bar); bar.layoutSizingHorizontal = 'FILL'; setText(bar, { title: 'QRIS', showActions: false });
  var S = spjSections(R, scr);
  var b1 = S.band('note'); var nb = NB['tone=primary'].createInstance(); b1.appendChild(nb); nb.layoutSizingHorizontal = 'FILL';
  setText(nb, { text: 'Your Swing Pass will be processed once payment has been verified. Make payment within 09:59.' });
  var p1 = await S.page('qris', 'QRIS');
  var d = DV['type=line'].createInstance(); p1.appendChild(d); d.layoutSizingHorizontal = 'FILL';
  var grp = autoFrame('payment', 'VERTICAL', p1); fillHug(grp); grp.itemSpacing = 0;
  function line(f) { f.strokes = paintFor(R, '--light-500'); f.strokeAlign = 'INSIDE'; f.strokeTopWeight = 0; f.strokeRightWeight = 0; f.strokeLeftWeight = 0; f.strokeBottomWeight = 1; }
  // .info-row: min 64, centred column, gap 2, line under it: label B2s dark-500, value B3 dark-300
  var ir = autoFrame('info-row', 'VERTICAL', grp); fillHug(ir); ir.primaryAxisAlignItems = 'CENTER'; ir.minHeight = 64; ir.itemSpacing = 2; line(ir);
  var l1 = await styledText(R, '--type-b2s', '--dark-500', 'Total amount'); ir.appendChild(l1); l1.name = 'label'; l1.textAutoResize = 'HEIGHT'; l1.layoutSizingHorizontal = 'FILL';
  var l2 = await styledText(R, '--type-b3', '--dark-300', 'Rp. 2,300,000'); ir.appendChild(l2); l2.name = 'value'; l2.textAutoResize = 'HEIGHT'; l2.layoutSizingHorizontal = 'FILL';
  // .qr-block 12 / 0 with a line; .qr-box: centred, gap 16, 16 / 24, radius 16, light-200; QR 192; Button l block with the download icon
  var qb = autoFrame('qr-block', 'VERTICAL', grp); fillHug(qb); bindNumber(R, qb, 'paddingTop', '--space-12', 12); bindNumber(R, qb, 'paddingBottom', '--space-12', 12); line(qb);
  var bx = autoFrame('qr-box', 'VERTICAL', qb); fillHug(bx); bx.counterAxisAlignItems = 'CENTER'; bindNumber(R, bx, 'itemSpacing', '--space-16', 16);
  bindNumber(R, bx, 'paddingTop', '--space-16', 16); bindNumber(R, bx, 'paddingBottom', '--space-16', 16); bindNumber(R, bx, 'paddingLeft', '--space-24', 24); bindNumber(R, bx, 'paddingRight', '--space-24', 24);
  bindRadius(R, bx, '--radius-16', 16); bx.fills = paintFor(R, '--light-200');
  var qr = figma.createRectangle(); bx.appendChild(qr); qr.name = 'qr'; qr.resize(192, 192); await refPhoto(R, qr, 'ref/img/sp/qris.png?v=1', notes);
  var sv = BT['size=l, tone=primary, appearance=solid, state=default'].createInstance(); bx.appendChild(sv); sv.layoutSizingHorizontal = 'FILL';
  setText(sv, { label: 'Save QR code image', showIconStart: true, iconStart: dl.id, showIconEnd: false });
  var br = autoFrame('btn-row', 'HORIZONTAL', p1); fillHug(br); bindNumber(R, br, 'itemSpacing', '--space-4', 4);
  [['danger', 'Cancel payment'], ['muted', 'Refresh status']].forEach(function (x) {
    var b = BT['size=s, tone=' + x[0] + ', appearance=tertiary, state=default'].createInstance(); br.appendChild(b); b.layoutSizingHorizontal = 'FILL'; setText(b, { label: x[1], showIconStart: false, showIconEnd: false });
  });
  var one = function (m, props) { var i = m.createInstance(); if (props) setText(i, props); return i; };
  await screenList(R, page, scr, 'Swing Pass QRIS', async function (row) {
    await row('AppBar', partSrc('AppBar', PG) + ' · type=ads, no actions', [one(appBar['type=ads, scrolled=false'], { title: 'QRIS', showActions: false })]);
    await row('NoteBar', partSrc('NoteBar', PG) + ' · tone=primary with the payment timer', [one(NB['tone=primary'])]);
    await row('Divider', partSrc('Divider', PG) + ' · type=line', [one(DV['type=line'])]);
    await row('Button', partSrc('Button', PG) + ' · l solid block (download icon); s tertiary danger and muted side by side', [one(BT['size=s, tone=danger, appearance=tertiary, state=default'], { label: 'Cancel payment' }), one(BT['size=s, tone=muted, appearance=tertiary, state=default'], { label: 'Refresh status' })]);
  });
  notes.push('Swing Pass QRIS: built from stat.chara.id/swing/ref/swingpass-qris.html. The timer is the static 09:59; the info row and QR box are plain layers (only this screen has them).');
  return { set: scr, count: 4, label: 'screen from 4 parts' };
}

async function buildSwingPassWaitingScreen(R, notes) {
  var PG = 'Screen / Swing Pass waiting', page = await pageNamed(PG);
  var appBar = byName(await setWith('AppBar', 'AppBar', buildAppBarPage, R, notes, 'type=adsInverse, scrolled=false'));
  var BT = byName(await setWith('Button', 'Button', buildButton, R, notes, 'size=s, tone=glass, appearance=solid, state=default'));
  var SPS = await setFrom('SwingPass', 'SwingPass', buildSwingPassPage, R, notes);
  var PC = byName(await setWith('PassCard', 'PassCard', buildPassCardPage, R, notes, 'enlarge=false'));
  var old = page.findChild(function (n) { return n.type === 'FRAME' && n.name === 'Swing Pass waiting'; });
  var keepX = old ? old.x : 0, keepY = old ? old.y : 0;
  if (old) old.remove();
  var scr = figma.createFrame(); page.appendChild(scr);
  scr.name = 'Swing Pass waiting'; scr.x = keepX; scr.y = keepY;
  scr.layoutMode = 'VERTICAL'; scr.resize(390, 844); scr.layoutSizingHorizontal = 'FIXED'; scr.layoutSizingVertical = 'FIXED'; scr.itemSpacing = 0; scr.clipsContent = true; scr.fills = [];
  // .screen.swing-pass.swing-pass--static: the DS Swing Pass surface behind everything
  var bg = SPS.children[0].createInstance(); scr.appendChild(bg); bg.name = 'SwingPass'; bg.layoutPositioning = 'ABSOLUTE'; bg.x = 0; bg.y = 0; bg.resize(390, 844);
  bg.constraints = { horizontal: 'STRETCH', vertical: 'STRETCH' };
  var bar = appBar['type=adsInverse, scrolled=false'].createInstance(); scr.appendChild(bar); bar.layoutSizingHorizontal = 'FILL'; setText(bar, { title: 'Swing Pass', showActions: true });
  // .pass-state: content at the bottom, gap 96, 24 / page-x / 123
  var st = autoFrame('pass-state', 'VERTICAL', scr); st.layoutSizingHorizontal = 'FILL'; st.layoutSizingVertical = 'FILL'; st.primaryAxisAlignItems = 'MAX';
  padX(R, st); bindNumber(R, st, 'paddingTop', '--space-24', 24); st.paddingBottom = 96 + 24 + 3; bindNumber(R, st, 'itemSpacing', '--space-96', 96);
  var g = autoFrame('group', 'VERTICAL', st); fillHug(g); bindNumber(R, g, 'itemSpacing', '--space-32', 32);
  var pc = PC['enlarge=false'].createInstance(); g.appendChild(pc); pc.layoutSizingHorizontal = 'FILL';
  setText(pc, { name: 'Ronaldo Nazario', meta: 'N235G-4GG34 \u2022 Waiting for verification', badge: 'BETA' });
  var msg = autoFrame('pass-msg', 'VERTICAL', g); fillHug(msg); bindNumber(R, msg, 'itemSpacing', '--space-8', 8);
  async function txt(style, chars, name) { var t = await styledText(R, style, '--light-100', chars); msg.appendChild(t); t.name = name; t.textAutoResize = 'HEIGHT'; t.layoutSizingHorizontal = 'FILL'; t.textAlignHorizontal = 'CENTER'; return t; }
  await txt('--type-h3', 'Verification submitted!', 'title');
  await txt('--type-b2s', 'Your Swing Pass membership will be verified within 24 hours. You\u2019ll be notified once it\u2019s approved.', 'text');
  var ac = autoFrame('actions', 'VERTICAL', st); fillHug(ac); ac.counterAxisAlignItems = 'CENTER'; bindNumber(R, ac, 'itemSpacing', '--space-16', 16);
  var ok1 = BT['size=s, tone=glass, appearance=solid, state=default'].createInstance(); ac.appendChild(ok1); setText(ok1, { label: 'Ok, got it!', showIconStart: false, showIconEnd: false });
  // .btn--text.btn--inverse: a text-only button in white (CTA S); the DS has no text appearance, so it is a text layer here
  var tb = await styledText(R, '--type-cta-s', '--light-100', 'Contact Swing Suppport'); ac.appendChild(tb); tb.name = 'text-button'; tb.textAutoResize = 'WIDTH_AND_HEIGHT';
  var one = function (m, props) { var i = m.createInstance(); if (props) setText(i, props); return i; };
  await screenList(R, page, scr, 'Swing Pass waiting', async function (row) {
    await row('SwingPass', partSrc('SwingPass', PG) + ' · the full-screen surface (static)', [SPS.children[0].createInstance()]);
    await row('AppBar', partSrc('AppBar', PG) + ' · type=adsInverse', [one(appBar['type=adsInverse, scrolled=false'], { title: 'Swing Pass', showActions: true })]);
    await row('PassCard', partSrc('PassCard', PG) + ' · enlarge=false, waiting for verification', [one(PC['enlarge=false'])]);
    await row('Button', partSrc('Button', PG) + ' · tone=glass s', [one(BT['size=s, tone=glass, appearance=solid, state=default'], { label: 'Ok, got it!' })]);
  });
  notes.push('Swing Pass waiting: built from stat.chara.id/swing/ref/swingpass-waiting.html. "Contact Swing Suppport" is .swing_btn_text.btn--inverse; the DS Button has no text-only appearance, so it is a white CTA S text layer (the web typo "Suppport" is kept).');
  return { set: scr, count: 4, label: 'screen from 4 parts' };
}

/* ----- Swing Pass success (ref/swingpass-success.html, -success-onetime.html): gradient hero, kv summary, promo line, bottom bar ----- */
async function spSuccess(R, notes, opt) {
  var PG = opt.page, page = await pageNamed(PG);
  var BT = byName(await setFrom('Button', 'Button', buildButton, R, notes));
  var DV = byName(await setFrom('Divider', 'Divider', buildDividerPage, R, notes));
  var KV = byName(await setWith('KvRow', 'KvRow', buildKvRowPage, R, notes, 'pay=true'));
  var I = { tick: await spArt(R, 'tick-circle', 128, notes, page), tag: await spArt(R, 'tag-green', 16, notes, page), warn: await spArt(R, 'warning-o', 16, notes, page), arrow: await evArt(R, 'arrow-w', 20, notes, page, '--light-100') };
  var scr = spjScreen(page, opt.frame, R); scr.fills = paintFor(R, '--light-200');   // .screen--grey
  var main = autoFrame('main', 'VERTICAL', scr); main.layoutSizingHorizontal = 'FILL'; main.layoutSizingVertical = 'FILL';
  // .success-hero: centred, gap 16, 32 / page-x / 32, gradient, white; tick 128; title H3, sub S3s, gap 8
  var hero = autoFrame('success-hero', 'VERTICAL', main); fillHug(hero); hero.counterAxisAlignItems = 'CENTER'; padX(R, hero);
  bindNumber(R, hero, 'paddingTop', '--space-32', 32); bindNumber(R, hero, 'paddingBottom', '--space-32', 32); bindNumber(R, hero, 'itemSpacing', '--space-16', 16);
  await fillStyle(R, hero, '--gradient-swing-pass', '--purple-500');
  var tk = I.tick.createInstance(); hero.appendChild(tk); tk.name = 'art'; tk.resize(128, 128);
  var tx = autoFrame('text', 'VERTICAL', hero); fillHug(tx); bindNumber(R, tx, 'itemSpacing', '--space-8', 8);
  async function htxt(style, chars, name) { var t = await styledText(R, style, '--light-100', chars); tx.appendChild(t); t.name = name; t.textAutoResize = 'HEIGHT'; t.layoutSizingHorizontal = 'FILL'; t.textAlignHorizontal = 'CENTER'; }
  await htxt('--type-h3', 'Membership acquired!', 'title'); await htxt('--type-s3s', 'Welcome to Swing Pass', 'sub');
  // .page.page--white: 32 / page-x / 32, gap 16
  var pg = autoFrame('page', 'VERTICAL', main); fillHug(pg); padX(R, pg); pg.fills = paintFor(R, '--light-100');
  bindNumber(R, pg, 'paddingTop', '--space-32', 32); bindNumber(R, pg, 'paddingBottom', '--space-32', 32); bindNumber(R, pg, 'itemSpacing', '--space-16', 16);
  function kvList(rows) {
    var l = autoFrame('kv-list', 'VERTICAL', pg); fillHug(l); bindNumber(R, l, 'itemSpacing', '--space-8', 8);
    rows.forEach(function (r) { var i = KV[r[2] ? 'pay=true' : 'pay=false'].createInstance(); l.appendChild(i); i.layoutSizingHorizontal = 'FILL'; setText(i, { key: r[0], value: r[1] }); });
  }
  function divider() { var d = DV['type=line'].createInstance(); pg.appendChild(d); d.layoutSizingHorizontal = 'FILL'; }
  kvList([['Player name', 'Alvin Lianto'], ['Join date', '01 Jan 2025'], opt.renew, ['Membership ID', '9834G-91H5R']]); divider();
  kvList([['Billing amount', 'Rp. 2,500,000 / 12 months'], ['Billing method', 'OVO', true]]); divider();
  // .promo-line: gap 48; code B3s green-500 + tag 16 (gap 4); note B3 dark-300, right-aligned
  var pl = autoFrame('promo-line', 'HORIZONTAL', pg); fillHug(pl); pl.counterAxisAlignItems = 'CENTER'; bindNumber(R, pl, 'itemSpacing', '--space-48', 48);
  var cd = autoFrame('code', 'HORIZONTAL', pl); hugHug(cd); cd.counterAxisAlignItems = 'CENTER'; bindNumber(R, cd, 'itemSpacing', '--space-4', 4);
  var tg = I.tag.createInstance(); cd.appendChild(tg); tg.name = 'icon'; tg.resize(16, 16);
  var ct = await styledText(R, '--type-b3s', '--green-500', 'SWINGPASS50'); cd.appendChild(ct); ct.name = 'text'; ct.textAutoResize = 'WIDTH_AND_HEIGHT';
  var nt = await styledText(R, '--type-b3', '--dark-300', 'Rp. 2,300,000 for the first 12 months, then back to normal rate subsequently'); pl.appendChild(nt); nt.name = 'note';
  nt.textAutoResize = 'HEIGHT'; nt.layoutSizingHorizontal = 'FILL'; nt.textAlignHorizontal = 'RIGHT';
  var bb = autoFrame('bottom-bar', 'VERTICAL', scr); fillHug(bb); padX(R, bb);
  bindNumber(R, bb, 'paddingTop', '--space-16', 16); bindNumber(R, bb, 'paddingBottom', '--space-32', 32); bindNumber(R, bb, 'itemSpacing', opt.spaced ? '--space-16' : '--gap-related', opt.spaced ? 16 : 8);
  bb.fills = paintFor(R, '--light-100'); var up = lineBelow(R)[0]; if (up) bb.effects = [Object.assign({}, up, { offset: { x: 0, y: -1 } })];
  await opt.bar(bb, BT, I);
  var one = function (m, props) { var i = m.createInstance(); if (props) setText(i, props); return i; };
  await screenList(R, page, scr, opt.frame, async function (row) {
    await row('KvRow', partSrc('KvRow', PG) + ' · 4 + 2 rows, the billing method with the OVO logo', [one(KV['pay=false']), one(KV['pay=true'])]);
    await row('Divider', partSrc('Divider', PG) + ' · type=line', [one(DV['type=line'])]);
    await row('Button', partSrc('Button', PG) + ' · ' + opt.btnNote, opt.btnRow(one, BT, I));
  });
  notes.push(opt.frame + ': built from stat.chara.id/swing/ref/' + opt.src + '. The gradient hero, the promo line' + (opt.spaced ? ' and the orange B3s caption' : '') + ' are plain layers (no DS part for them).');
  return scr;
}
async function buildSwingPassSuccessScreen(R, notes) {
  var scr = await spSuccess(R, notes, { page: 'Screen / Swing Pass success', frame: 'Swing Pass success', src: 'swingpass-success.html', renew: ['Renews on', '01 Jan 2026'], spaced: true,
    btnNote: 'l solid block with the white arrow',
    bar: async function (bb, BT, I) {
      // .caption.caption--b3s.caption--orange: gap 8, B3s orange-500, warning 16
      var cp = autoFrame('caption', 'HORIZONTAL', bb); fillHug(cp); cp.counterAxisAlignItems = 'MIN'; bindNumber(R, cp, 'itemSpacing', '--space-8', 8);
      var w = I.warn.createInstance(); cp.appendChild(w); w.name = 'icon'; w.resize(16, 16);
      var t = await styledText(R, '--type-b3s', '--orange-500', 'Please complete the verification process to be able to activate your Swing Pass and enjoy its benefits'); cp.appendChild(t); t.name = 'text'; t.textAutoResize = 'HEIGHT'; t.layoutSizingHorizontal = 'FILL';
      var b = BT['size=l, tone=primary, appearance=solid, state=default'].createInstance(); bb.appendChild(b); b.layoutSizingHorizontal = 'FILL';
      setText(b, { label: 'Continue to verification', showIconStart: false, showIconEnd: true, iconEnd: I.arrow.id });
    },
    btnRow: function (one, BT, I) { return [one(BT['size=l, tone=primary, appearance=solid, state=default'], { label: 'Continue to verification', showIconEnd: true, iconEnd: I.arrow.id })]; } });
  return { set: scr, count: 3, label: 'screen from 3 parts' };
}
async function buildSwingPassSuccessOnetimeScreen(R, notes) {
  var scr = await spSuccess(R, notes, { page: 'Screen / Swing Pass success one time', frame: 'Swing Pass success one time', src: 'swingpass-success-onetime.html', renew: ['Ends on', '31 Dec 2025'], spaced: false,
    btnNote: 'l solid Finish and l tertiary See my Swing Pass, both block',
    bar: async function (bb, BT) {
      [['solid', 'Finish'], ['tertiary', 'See my Swing Pass']].forEach(function (x) {
        var b = BT['size=l, tone=primary, appearance=' + x[0] + ', state=default'].createInstance(); bb.appendChild(b); b.layoutSizingHorizontal = 'FILL'; setText(b, { label: x[1], showIconStart: false, showIconEnd: false });
      });
    },
    btnRow: function (one, BT) { return [one(BT['size=l, tone=primary, appearance=solid, state=default'], { label: 'Finish' }), one(BT['size=l, tone=primary, appearance=tertiary, state=default'], { label: 'See my Swing Pass' })]; } });
  return { set: scr, count: 3, label: 'screen from 3 parts' };
}

/* ----- Cancel Swing Pass and billing history (ref/swingpass-cancel.html, -history.html): ChoiceRow, BillRow ----- */
async function adsRadio(R, parent, sel, notes) {   // .choice__radio: 20, dark-100 ring on white; checked = the ADS radio art; in a 44 tap
  var rb = autoFrame('radio', 'HORIZONTAL', parent); rb.primaryAxisAlignItems = 'CENTER'; rb.counterAxisAlignItems = 'CENTER';
  rb.resize(44, 44); rb.layoutSizingHorizontal = 'FIXED'; rb.layoutSizingVertical = 'FIXED';
  if (sel) { var on = await refLogo(R, 'radio-on', 'ref/img/tq/radio-on.svg?v=1', 20, 20, notes, await pageNamed(SPJ_PAGE)); var ri = on.createInstance(); rb.appendChild(ri); ri.name = 'dot'; }
  else { var c = figma.createEllipse(); rb.appendChild(c); c.name = 'dot'; c.resize(20, 20); c.fills = paintFor(R, '--light-100'); c.strokes = paintFor(R, '--dark-100'); c.strokeWeight = 1; c.strokeAlign = 'INSIDE'; }
  return rb;
}
async function buildChoiceRowPage(R, notes) {
  var cr = {};
  var V = [{ selected: 'false', name: 'selected=false' }, { selected: 'true', name: 'selected=true' }];
  return buildPartPage(R, notes, 'ChoiceRow', async function (comp, K, pg, v) {
    // .choice: centred, gap 8, min 48, light-500 line under it; label B2s dark-500; radio 20 with 12 around it
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER'; comp.resize(342, 48); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG'; comp.minHeight = 48;
    bindNumber(R, comp, 'itemSpacing', '--space-8', 8); comp.fills = [];
    comp.strokes = paintFor(R, '--light-500'); comp.strokeAlign = 'INSIDE'; comp.strokeTopWeight = 0; comp.strokeRightWeight = 0; comp.strokeLeftWeight = 0; comp.strokeBottomWeight = 1;
    cr[comp.name] = await K.txt(comp, '--type-b2s', '--dark-500', 'The plan is too expensive', 'label', 'fill');
    await adsRadio(R, comp, v.selected === 'true', notes);
  }, function (s) {
    var pL = ensureProp(s, 'label', 'TEXT', 'The plan is too expensive');
    wireKeys(cr).forEach(function (k) { cr[k].componentPropertyReferences = { characters: pL }; });
    s.description = '<label class="swing_choice"><span class="swing_choice__label">…</span><input class="swing_choice__radio" type="radio"></label> in .swing_choice_list. Gap 8, min 48, light-500 line under it; label B2 Semibold. selected = the checked radio (ADS radio art).';
  }, { description: 'One answer to pick, with a radio on the right.', variants: V });
}

async function buildBillRowPage(R, notes) {
  var BD = byName(await setFrom('Badge', 'Badge', buildBadgePage, R, notes));
  var page = await pageNamed('Screen / Swing Pass billing history');
  var chev = await spArt(R, 'chev-down', 16, notes, page, '--dark-200');
  var br = {};
  var ST = { scheduled: ['primary', 'Scheduled'], paid: ['success', 'Paid'], failed: ['danger', 'Failed'] };
  var V = Object.keys(ST).map(function (k) { return { status: k, name: 'status=' + k }; });
  return buildPartPage(R, notes, 'BillRow', async function (comp, K, pg, v) {
    // .bill-row: centred, gap 16, min 64, 12 / 0, line under it; title B2s, meta B3 dark-300 with a 14 wallet logo (radius 4), gap 4;
    // end: amount B2s + Badge s, right-aligned, gap 4; chevron 16 dark-200 turned to point right
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER'; comp.resize(342, 64); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG'; comp.minHeight = 64;
    bindNumber(R, comp, 'paddingTop', '--space-12', 12); bindNumber(R, comp, 'paddingBottom', '--space-12', 12); bindNumber(R, comp, 'itemSpacing', '--space-16', 16); comp.fills = [];
    comp.strokes = paintFor(R, '--light-500'); comp.strokeAlign = 'INSIDE'; comp.strokeTopWeight = 0; comp.strokeRightWeight = 0; comp.strokeLeftWeight = 0; comp.strokeBottomWeight = 1;
    var tx = autoFrame('text', 'VERTICAL', comp); tx.layoutSizingHorizontal = 'FILL'; tx.layoutSizingVertical = 'HUG'; bindNumber(R, tx, 'itemSpacing', '--gap-tight', 4);
    var t = await K.txt(tx, '--type-b2s', '--dark-500', 'Swing Pass \u00b7 12 months', 'title', 'fill');
    var mt = autoFrame('meta', 'HORIZONTAL', tx); hugHug(mt); mt.counterAxisAlignItems = 'CENTER'; bindNumber(R, mt, 'itemSpacing', '--space-4', 4);
    var m1 = await K.txt(mt, '--type-b3', '--dark-300', '01 Jan 2026 \u00b7 Auto renewal \u00b7', 'text');
    var lg = figma.createRectangle(); mt.appendChild(lg); lg.name = 'logo'; lg.resize(14, 14); bindRadius(R, lg, '--ads-radius-4', 4); await refPhoto(R, lg, 'ref/img/sp/ovo.png?v=1', notes);
    var m2 = await K.txt(mt, '--type-b3', '--dark-300', 'OVO', 'wallet');
    var end = autoFrame('end', 'VERTICAL', comp); hugHug(end); end.counterAxisAlignItems = 'MAX'; bindNumber(R, end, 'itemSpacing', '--gap-tight', 4);
    var am = await K.txt(end, '--type-b2s', '--dark-500', 'Rp. 2,500,000', 'amount');
    var b = BD['tone=' + ST[v.status][0] + ', appearance=soft, size=s'].createInstance(); end.appendChild(b); b.name = 'badge'; setText(b, { label: ST[v.status][1] });
    var c = chev.createInstance(); comp.appendChild(c); c.name = 'chevron'; c.resize(16, 16); c.rotation = 90;   // chev-down turned -90deg in CSS = pointing right
    br[comp.name] = { t: t, m1: m1, m2: m2, am: am };
  }, function (s) {
    var P = { t: ensureProp(s, 'title', 'TEXT', 'Swing Pass \u00b7 12 months'), m1: ensureProp(s, 'meta', 'TEXT', '01 Jan 2026 \u00b7 Auto renewal \u00b7'), m2: ensureProp(s, 'wallet', 'TEXT', 'OVO'), am: ensureProp(s, 'amount', 'TEXT', 'Rp. 2,500,000') };
    wireKeys(br).forEach(function (k) { wireKeys(P).forEach(function (f) { br[k][f].componentPropertyReferences = { characters: P[f] }; }); });
    s.description = '<a class="swing_bill_row"><span class="swing_bill_row__text">title + .swing_bill_row__meta (… · logo 14 + wallet)</span><span class="swing_bill_row__end">amount + .swing_badge.badge--s</span><i chevron></i></a> in .swing_bill_list (the last row has no line: set its bottom stroke to 0). status = the Badge: scheduled primary, paid success, failed danger.';
  }, { description: 'A Swing Pass charge: plan, date and wallet, amount and status.', variants: V });
}

var SPC_REASONS = ['I don\u2019t find much value in the benefits', 'The plan is too expensive', 'Im struggling to use up all of the exclusive rates and benefits in the plan', 'I didn\u2019t know it auto-renews',
  'I don\u2019t see myself using Swing that often', 'I\u2019m using another plan or membership on a different provider', 'There aren\u2019t any perks available available for the services I use', 'Other reasons'];
async function buildSwingPassCancelScreen(R, notes) {
  var PG = 'Screen / Swing Pass cancel', page = await pageNamed(PG);
  var appBar = byName(await setWith('AppBar', 'AppBar', buildAppBarPage, R, notes, 'type=ads, scrolled=false'));
  var BT = byName(await setFrom('Button', 'Button', buildButton, R, notes));
  var DV = byName(await setFrom('Divider', 'Divider', buildDividerPage, R, notes));
  var KV = byName(await setWith('KvRow', 'KvRow', buildKvRowPage, R, notes, 'pay=true'));
  var CR = byName(await setWith('ChoiceRow', 'ChoiceRow', buildChoiceRowPage, R, notes, 'selected=true'));
  var arrow = await evArt(R, 'arrow-w', 20, notes, page, '--light-100');
  var scr = spjScreen(page, 'Swing Pass cancel', R);
  var bar = appBar['type=ads, scrolled=false'].createInstance(); scr.appendChild(bar); bar.layoutSizingHorizontal = 'FILL'; setText(bar, { title: 'Cancel Swing Pass', showActions: false });
  var S = spjSections(R, scr); bindNumber(R, S.main, 'paddingTop', '--space-4', 4);   // .sections--top
  var p1 = await S.page('membership', 'Swing Pass membership');
  var t1 = p1.children[0]; t1.fills = paintFor(R, '--dark-500');   // .section-title--dark
  var d = DV['type=line'].createInstance(); p1.appendChild(d); d.layoutSizingHorizontal = 'FILL';
  var kl = autoFrame('kv-list', 'VERTICAL', p1); fillHug(kl); bindNumber(R, kl, 'itemSpacing', '--space-8', 8);
  [['Player name', 'Alvin Lianto'], ['Cancel date', '01 Feb 2024'], ['Ends on', '31 Dec 2024'], ['Membership ID', '9834G-91H5R']].forEach(function (r) { var i = KV['pay=false'].createInstance(); kl.appendChild(i); i.layoutSizingHorizontal = 'FILL'; setText(i, { key: r[0], value: r[1] }); });
  var p2 = await S.page('reason');
  var hd = autoFrame('head', 'VERTICAL', p2); fillHug(hd); bindNumber(R, hd, 'itemSpacing', '--gap-tight', 4);
  var h1 = await styledText(R, '--type-h5', '--dark-300', 'Cancellation reason'); hd.appendChild(h1); h1.name = 'section-title'; h1.textAutoResize = 'HEIGHT'; h1.layoutSizingHorizontal = 'FILL';
  var h2 = await styledText(R, '--type-b3', '--dark-300', 'Before you go, please share with us why you\u2019re cancelling to help us improve Swing Pass.'); hd.appendChild(h2); h2.name = 'section-sub'; h2.textAutoResize = 'HEIGHT'; h2.layoutSizingHorizontal = 'FILL';
  var cl = autoFrame('choice-list', 'VERTICAL', p2); fillHug(cl); cl.itemSpacing = 0;
  SPC_REASONS.forEach(function (r) { var i = CR['selected=false'].createInstance(); cl.appendChild(i); i.layoutSizingHorizontal = 'FILL'; setText(i, { label: r }); });
  var bb = autoFrame('bottom-bar', 'VERTICAL', scr); fillHug(bb); padX(R, bb); bindNumber(R, bb, 'paddingTop', '--space-16', 16); bindNumber(R, bb, 'paddingBottom', '--space-32', 32);
  bb.fills = paintFor(R, '--light-100'); var up = lineBelow(R)[0]; if (up) bb.effects = [Object.assign({}, up, { offset: { x: 0, y: -1 } })];
  var cb = BT['size=l, tone=primary, appearance=solid, state=disabled'].createInstance(); bb.appendChild(cb); cb.layoutSizingHorizontal = 'FILL';
  setText(cb, { label: 'Cancel membership', showIconStart: false, showIconEnd: true, iconEnd: arrow.id });
  var one = function (m, props) { var i = m.createInstance(); if (props) setText(i, props); return i; };
  await screenList(R, page, scr, 'Swing Pass cancel', async function (row) {
    await row('AppBar', partSrc('AppBar', PG) + ' · type=ads, no actions', [one(appBar['type=ads, scrolled=false'], { title: 'Cancel Swing Pass', showActions: false })]);
    await row('KvRow', partSrc('KvRow', PG) + ' · 4 rows', [one(KV['pay=false'])]);
    await row('ChoiceRow', partSrc('ChoiceRow', PG) + ' · 8 reasons, none picked yet', [one(CR['selected=false']), one(CR['selected=true'])]);
    await row('Divider', partSrc('Divider', PG) + ' · type=line', [one(DV['type=line'])]);
    await row('Button', partSrc('Button', PG) + ' · l solid disabled until a reason is picked', [one(BT['size=l, tone=primary, appearance=solid, state=disabled'], { label: 'Cancel membership', showIconEnd: true, iconEnd: arrow.id })]);
  });
  notes.push('Swing Pass cancel: built from stat.chara.id/swing/ref/swingpass-cancel.html. The disabled button is the DS disabled (light-300, dark-200); the web\'s ADS .swing_btn_off_ads is dark-100 with white text. The confirm sheet is a state, not drawn.');
  return { set: scr, count: 5, label: 'screen from 5 parts' };
}

async function buildSwingPassHistoryScreen(R, notes) {
  var PG = 'Screen / Swing Pass billing history', page = await pageNamed(PG);
  var appBar = byName(await setWith('AppBar', 'AppBar', buildAppBarPage, R, notes, 'type=ads, scrolled=false'));
  var PM = byName(await setWith('PayMethod', 'PayMethod', buildPayMethodPage, R, notes, 'type=action'));
  var BR = byName(await setWith('BillRow', 'BillRow', buildBillRowPage, R, notes, 'status=failed'));
  var scr = spjScreen(page, 'Swing Pass billing history', R);
  var bar = appBar['type=ads, scrolled=false'].createInstance(); scr.appendChild(bar); bar.layoutSizingHorizontal = 'FILL'; setText(bar, { title: 'Billing history', showActions: false });
  var S = spjSections(R, scr); bindNumber(R, S.main, 'paddingTop', '--space-4', 4);
  var p1 = await S.page('current', 'Current plan');
  var pm = PM['type=billing'].createInstance(); p1.appendChild(pm); pm.layoutSizingHorizontal = 'FILL';
  var pb = pm.findOne(function (n) { return n.type === 'INSTANCE' && n.name === 'action'; }); if (pb) setText(pb, { label: 'Change' });
  function bills(parent, rows) {
    var l = autoFrame('bill-list', 'VERTICAL', parent); fillHug(l); l.itemSpacing = 0;
    rows.forEach(function (r, i) { var b = BR['status=' + r[0]].createInstance(); l.appendChild(b); b.layoutSizingHorizontal = 'FILL'; setText(b, { meta: r[1], amount: r[2] }); if (i === rows.length - 1) b.strokeBottomWeight = 0; });
  }
  bills(await S.page('upcoming', 'Upcoming'), [['scheduled', '01 Jan 2026 \u00b7 Auto renewal \u00b7', 'Rp. 2,500,000']]);
  var p3 = await S.page('year', '2025');
  bills(p3, [['paid', '01 Jan 2025 \u00b7 SWINGPASS50 \u00b7', 'Rp. 2,300,000'], ['failed', '01 Jan 2025 \u00b7', 'Rp. 2,300,000']]);
  var HL = 'Questions about a charge? Contact us here.';
  var hl = await styledText(R, '--type-b2', '--dark-300', HL); p3.appendChild(hl); hl.name = 'help-line'; hl.textAutoResize = 'HEIGHT'; hl.layoutSizingHorizontal = 'FILL';
  var ha = HL.indexOf('Contact us here'); hl.setRangeFills(ha, ha + 15, paintFor(R, '--purple-500'));
  var b2s = R.text['--type-b2s']; if (b2s) { await figma.loadFontAsync(b2s.fontName); await hl.setRangeTextStyleIdAsync(ha, ha + 15, b2s.id); }
  var one = function (m, props) { var i = m.createInstance(); if (props) setText(i, props); return i; };
  await screenList(R, page, scr, 'Swing Pass billing history', async function (row) {
    await row('AppBar', partSrc('AppBar', PG) + ' · type=ads, no actions', [one(appBar['type=ads, scrolled=false'], { title: 'Billing history', showActions: false })]);
    await row('PayMethod', partSrc('PayMethod', PG) + ' · type=billing with Change', [one(PM['type=billing'])]);
    await row('BillRow', partSrc('BillRow', PG) + ' · status=scheduled / paid / failed', [one(BR['status=scheduled']), one(BR['status=paid']), one(BR['status=failed'])]);
  });
  notes.push('Swing Pass billing history: built from stat.chara.id/swing/ref/swingpass-history.html.');
  return { set: scr, count: 3, label: 'screen from 3 parts' };
}

/* ----- Golf course details (ref/golf-course.html): DateBtn, SessionTab, RateCard, InclItem, Amenity, StatTile ----- */
var GC_PAGE = 'Screen / Golf course';
async function gcArt(R, name, size, notes, css) { return refIcon(R, 'gcd-' + name, 'ref/img/gcd/' + name + '.svg?v=1', size, css || null, notes, await pageNamed(GC_PAGE)); }
function gcTile(R, comp, w, py, px, radius, bg) {
  comp.resize(w, 40); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
  bindNumber(R, comp, 'paddingTop', '--space-' + py, py); bindNumber(R, comp, 'paddingBottom', '--space-' + py, py);
  bindNumber(R, comp, 'paddingLeft', '--space-' + px, px); bindNumber(R, comp, 'paddingRight', '--space-' + px, px);
  bindRadius(R, comp, '--radius-' + radius, radius); comp.fills = paintFor(R, bg);
}
async function buildDateBtnPage(R, notes) {
  var db = {};
  var V = [{ selected: 'true', name: 'selected=true' }, { selected: 'false', name: 'selected=false' }];
  return buildPartPage(R, notes, 'DateBtn', async function (comp, K, pg, v) {
    // .date-btn: 56 x 36, 4 / 12, 1px line (transparent), radius 8; day B4 dark-300 over date B3s dark-500; selected: purple-500 line, purple-50, date purple-500
    var sel = v.selected === 'true';
    comp.layoutMode = 'VERTICAL'; comp.primaryAxisAlignItems = 'CENTER'; comp.counterAxisAlignItems = 'CENTER';
    comp.resize(56, 36); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'FIXED';
    bindNumber(R, comp, 'paddingTop', '--space-4', 4); bindNumber(R, comp, 'paddingBottom', '--space-4', 4); bindNumber(R, comp, 'paddingLeft', '--space-12', 12); bindNumber(R, comp, 'paddingRight', '--space-12', 12);
    bindRadius(R, comp, '--radius-8', 8); comp.fills = sel ? paintFor(R, '--purple-50') : [];
    comp.strokes = sel ? paintFor(R, '--purple-500') : []; comp.strokeWeight = 1; comp.strokeAlign = 'INSIDE';
    var d = await K.txt(comp, '--type-b4', '--dark-300', 'FRI', 'day'), t = await K.txt(comp, '--type-b3s', sel ? '--purple-500' : '--dark-500', '16 Sep', 'date');
    db[comp.name] = { d: d, t: t };
  }, function (s) {
    var pD = ensureProp(s, 'day', 'TEXT', 'FRI'), pT = ensureProp(s, 'date', 'TEXT', '16 Sep');
    wireKeys(db).forEach(function (k) { db[k].d.componentPropertyReferences = { characters: pD }; db[k].t.componentPropertyReferences = { characters: pT }; });
    s.description = '<button class="swing_date_btn" aria-pressed><small>FRI</small>16 Sep</button> in .swing_date_band__days (gap 4). 56 x 36, radius 8. selected = aria-pressed="true": purple-500 line, purple-50, date purple-500.';
  }, { description: 'A day to pick in the date strip.', variants: V });
}
async function buildSessionTabPage(R, notes) {
  var I = { day: await gcArt(R, 'tab-container', 14, notes), night: await gcArt(R, 'tab-container-2', 14, notes) };
  var st = {};
  var V = [{ selected: 'true', name: 'selected=true' }, { selected: 'false', name: 'selected=false' }];
  return buildPartPage(R, notes, 'SessionTab', async function (comp, K, pg, v) {
    // .session-tab: 8 / 16, gap 8, radius 16 on top, B3s dark-300, icon 14; selected: white, purple-500, Elevation card s
    var sel = v.selected === 'true';
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER'; comp.resize(120, 36); comp.layoutSizingHorizontal = 'HUG'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'paddingTop', '--space-8', 8); bindNumber(R, comp, 'paddingBottom', '--space-8', 8); bindNumber(R, comp, 'paddingLeft', '--space-16', 16); bindNumber(R, comp, 'paddingRight', '--space-16', 16);
    bindNumber(R, comp, 'itemSpacing', '--space-8', 8); ['topLeftRadius', 'topRightRadius'].forEach(function (f) { bindNumber(R, comp, f, '--radius-16', 16); });
    comp.fills = sel ? paintFor(R, '--light-100') : []; if (sel) await effectStyle(R, comp, '--elevation-card-s');
    var i = (sel ? I.day : I.night).createInstance(); comp.appendChild(i); i.name = 'icon'; i.resize(14, 14);
    st[comp.name] = { i: i, t: await K.txt(comp, '--type-b3s', sel ? '--purple-500' : '--dark-300', sel ? 'Day session' : 'Night session', 'label') };
  }, function (s) {
    var pI = ensureProp(s, 'icon', 'INSTANCE_SWAP', I.day.id), pL = ensureProp(s, 'label', 'TEXT', 'Day session');
    wireKeys(st).forEach(function (k) { st[k].i.componentPropertyReferences = { mainComponent: pI }; st[k].t.componentPropertyReferences = { characters: pL }; });
    s.description = '<button class="swing_session_tab" role="tab" aria-selected>icon 14 + label</button> in .swing_session_tabs at the bottom of the date band. Radius 16 on top; selected = white, purple-500, Elevation card s.';
  }, { description: 'A day / night session tab on the date band.', variants: V });
}
async function buildRateCardPage(R, notes) {
  var rc = {};
  return buildPartPage(R, notes, 'RateCard', async function (comp, K) {
    // .rate-card: column centred, gap 4, 12 / 16, light-500 line, radius 16, white; time B2s dark-500; was B4s dark-200 struck; best B3s green-500 + chip (2 / 4, radius full, green-500, B4s white)
    comp.layoutMode = 'VERTICAL'; comp.counterAxisAlignItems = 'CENTER'; comp.resize(165, 70); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'paddingTop', '--space-12', 12); bindNumber(R, comp, 'paddingBottom', '--space-12', 12); bindNumber(R, comp, 'paddingLeft', '--space-16', 16); bindNumber(R, comp, 'paddingRight', '--space-16', 16);
    bindNumber(R, comp, 'itemSpacing', '--space-4', 4); bindRadius(R, comp, '--radius-16', 16); comp.fills = paintFor(R, '--light-100');
    comp.strokes = paintFor(R, '--light-500'); comp.strokeWeight = 1; comp.strokeAlign = 'INSIDE';
    var t = await K.txt(comp, '--type-b2s', '--dark-500', '05:30 - 06:00', 'time', 'fill');
    var pr = autoFrame('price', 'VERTICAL', comp); fillHug(pr);
    var w = await K.txt(pr, '--type-b4s', '--dark-200', 'Rp. 1,580,000', 'was', 'fill'); w.textDecoration = 'STRIKETHROUGH';
    var be = autoFrame('best', 'HORIZONTAL', pr); hugHug(be); be.counterAxisAlignItems = 'CENTER'; bindNumber(R, be, 'itemSpacing', '--space-4', 4);
    var b = await K.txt(be, '--type-b3s', '--green-500', 'Rp. 1,422,000 / pax', 'text');
    var ch = autoFrame('chip', 'HORIZONTAL', be); hugHug(ch); ch.paddingTop = 2; ch.paddingBottom = 2; bindNumber(R, ch, 'paddingLeft', '--space-4', 4); bindNumber(R, ch, 'paddingRight', '--space-4', 4);
    bindRadius(R, ch, '--radius-full', 9999); ch.fills = paintFor(R, '--green-500');
    var c = await K.txt(ch, '--type-b4s', '--light-100', '-10%', 'text');
    rc[comp.name] = { t: t, w: w, b: b, c: c };
  }, function (s) {
    var P = { t: ensureProp(s, 'time', 'TEXT', '05:30 - 06:00'), w: ensureProp(s, 'was', 'TEXT', 'Rp. 1,580,000'), b: ensureProp(s, 'price', 'TEXT', 'Rp. 1,422,000 / pax'), c: ensureProp(s, 'discount', 'TEXT', '-10%') };
    wireKeys(rc).forEach(function (k) { wireKeys(P).forEach(function (f) { rc[k][f].componentPropertyReferences = { characters: P[f] }; }); });
    s.description = '<a class="swing_rate_card">.swing_rate_card__time + .swing_rate_card__price (struck was, best + .swing_rate_chip)</a> in .swing_rate_grid (2 columns, gap 8 / 12). White, light-500 line, radius 16.';
  }, { description: 'A tee time slot with its price and discount.' });
}
async function buildInclItemPage(R, notes) {
  var ic = await gcArt(R, 'icon-label', 12, notes), tick = await gcArt(R, 'interface-so-tick-circle', 12, notes);
  var it = {};
  return buildPartPage(R, notes, 'InclItem', async function (comp, K) {
    // .incl: space-between, 8 / 12, radius 8, light-200, B3s dark-300; icon 12 + label (gap 8), tick 12
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER'; comp.primaryAxisAlignItems = 'SPACE_BETWEEN'; gcTile(R, comp, 169, 8, 12, 8, '--light-200');
    var l = autoFrame('label', 'HORIZONTAL', comp); hugHug(l); l.counterAxisAlignItems = 'CENTER'; bindNumber(R, l, 'itemSpacing', '--space-8', 8);
    var i = ic.createInstance(); l.appendChild(i); i.name = 'icon'; i.resize(12, 12);
    var t = await K.txt(l, '--type-b3s', '--dark-300', 'Green fee', 'text');
    var k = tick.createInstance(); comp.appendChild(k); k.name = 'included'; k.resize(12, 12);
    it[comp.name] = { i: i, t: t };
  }, function (s) {
    var pI = ensureProp(s, 'icon', 'INSTANCE_SWAP', ic.id), pT = ensureProp(s, 'label', 'TEXT', 'Green fee');
    wireKeys(it).forEach(function (k) { it[k].i.componentPropertyReferences = { mainComponent: pI }; it[k].t.componentPropertyReferences = { characters: pT }; });
    s.description = '<span class="swing_incl"><span><img 12>label</span><img tick 12></span> in .swing_incl_grid (2 columns, gap 4). light-200, radius 8, 8 / 12.';
  }, { description: 'Something the price includes, with a tick.' });
}
async function buildAmenityPage(R, notes) {
  var ic = await gcArt(R, 'icon-label-5', 22, notes);
  var am = {};
  return buildPartPage(R, notes, 'Amenity', async function (comp, K) {
    // .amenity: 220 wide, centred, gap 14, 12 / 16, radius 8, light-200; icon 22; B2s dark-500
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER'; gcTile(R, comp, 220, 12, 16, 8, '--light-200'); bindNumber(R, comp, 'itemSpacing', '--ads-gap-14', 14);
    var i = ic.createInstance(); comp.appendChild(i); i.name = 'icon'; i.resize(22, 22);
    am[comp.name] = { i: i, t: await K.txt(comp, '--type-b2s', '--dark-500', 'Club valet', 'label', 'fill') };
  }, function (s) {
    var pI = ensureProp(s, 'icon', 'INSTANCE_SWAP', ic.id), pT = ensureProp(s, 'label', 'TEXT', 'Club valet');
    wireKeys(am).forEach(function (k) { am[k].i.componentPropertyReferences = { mainComponent: pI }; am[k].t.componentPropertyReferences = { characters: pT }; });
    s.description = '<span class="swing_amenity"><img 22>label</span> in .swing_amenity_rail (4 rows, 220 columns, gap 8 / 12, scrolls sideways). light-200, radius 8, 12 / 16, gap 14.';
  }, { description: 'A course amenity with its icon.' });
}
async function buildStatTilePage(R, notes) {
  var sv = {};
  return buildPartPage(R, notes, 'StatTile', async function (comp, K) {
    // .stat-tile: column, gap 2, 12 / 16, radius 8, light-200; label B3 dark-300, value B3s dark-500
    comp.layoutMode = 'VERTICAL'; gcTile(R, comp, 165, 12, 16, 8, '--light-200'); comp.itemSpacing = 2;
    sv[comp.name] = { l: await K.txt(comp, '--type-b3', '--dark-300', 'Holes', 'label', 'fill'), v: await K.txt(comp, '--type-b3s', '--dark-500', '18 holes', 'value', 'fill') };
  }, function (s) {
    var pL = ensureProp(s, 'label', 'TEXT', 'Holes'), pV = ensureProp(s, 'value', 'TEXT', '18 holes');
    wireKeys(sv).forEach(function (k) { sv[k].l.componentPropertyReferences = { characters: pL }; sv[k].v.componentPropertyReferences = { characters: pV }; });
    s.description = '<span class="swing_stat_tile">label<b>value</b></span> in .swing_stat_tiles (2 columns, gap 8 / 12). light-200, radius 8.';
  }, { description: 'A course fact: label and value.' });
}

var GC_DAYS = [['FRI', '16 Sep'], ['SAT', '17 Sep'], ['SUN', '18 Sep'], ['MON', '19 Sep'], ['TUE', '20 Sep'], ['WED', '21 Sep'], ['THU', '22 Sep'], ['FRI', '23 Sep'], ['SAT', '24 Sep'], ['SUN', '25 Sep'], ['MON', '26 Sep'], ['TUE', '27 Sep'], ['WED', '28 Sep'], ['THU', '29 Sep'], ['FRI', '30 Sep'], ['MON', '01 Oct'], ['TUE', '02 Oct']];
var GC_RATES = [['05:30 - 06:00', 'Rp. 1,580,000', 'Rp. 1,422,000 / pax'], ['06:00- 06:30', 'Rp. 1,580,000', 'Rp. 1,422,000 / pax'], ['06:30 - 07:00', 'Rp. 1,580,000', 'Rp. 1,422,000 / pax'], ['07:00 - 07:30', 'Rp. 1,580,000', 'Rp. 1,422,000 / pax'],
  ['07:30 - 08:00', 'Rp. 1,620,000', 'Rp. 1,458,000 / pax'], ['11:00 - 11:30', 'Rp. 1,620,000', 'Rp. 1,458,000 / pax'], ['11:30 - 12:00', 'Rp. 1,650,000', 'Rp. 1,485,000 / pax'], ['12:00 - 12:30', 'Rp. 1,650,000', 'Rp. 1,485,000 / pax']];
var GC_INCL = [['icon-label', 'Green fee'], ['icon-label-2', 'Cart'], ['icon-label-3', 'Caddy'], ['icon-label-4', 'Insurance']];
var GC_AMEN = ['Club valet', 'Shoe rental', 'Pro shop', 'Spa & massage', 'Caddy & golf carts', 'Locker room', 'Restaurant & dining', 'Health club', 'Club rental', 'Golf lessons & coaching', 'Night golf', 'Accommodation'];
var GC_STATS = [['Holes', '18 holes'], ['Par', '72'], ['Length', '6983m'], ['Established year', '1974'], ['Course type', 'Mountainside'], ['Grass type', 'Bent Grass'], ['Designer', 'Peter Thomson']];
var GC_MORE = 'Modern Golf & Country Club is an 18 Holes International Standard Golf Course. The course was designed by five times British Open Champion, Peter Thomson. Every hole is designed with great detail so that each hole has a unique character. Lakes, long fairways, and bunkers are designed along the way to the green to challenge and add excitement to the course.\n\nModern Golf & Country Club offers its members and guests complete sports facilities.';

async function buildGolfCourseScreen(R, notes) {
  var PG = GC_PAGE, page = await pageNamed(PG);
  var appBar = byName(await setWith('AppBar', 'AppBar', buildAppBarPage, R, notes, 'type=adsShare, scrolled=false'));
  var BT = byName(await setWith('Button', 'Button', buildButton, R, notes, 'size=s, tone=muted, appearance=tertiary, state=default'));
  var DV = byName(await setFrom('Divider', 'Divider', buildDividerPage, R, notes));
  var P = { promo: byName(await setWith('PromoCard', 'PromoCard', buildPromoCardPage, R, notes, 'pass=true')), credit: await setFrom('CreditStrip', 'CreditStrip', buildCreditStripPage, R, notes),
    venue: byName(await setWith('Venue', 'Venue', buildVenuePage, R, notes, 'size=s')), date: byName(await setWith('DateBtn', 'DateBtn', buildDateBtnPage, R, notes, 'selected=false')),
    tab: byName(await setWith('SessionTab', 'SessionTab', buildSessionTabPage, R, notes, 'selected=false')), rate: await setFrom('RateCard', 'RateCard', buildRateCardPage, R, notes),
    incl: await setFrom('InclItem', 'InclItem', buildInclItemPage, R, notes), amen: await setFrom('Amenity', 'Amenity', buildAmenityPage, R, notes), stat: await setFrom('StatTile', 'StatTile', buildStatTilePage, R, notes) };
  var I = { flag: await gcArt(R, 'emoji-flag-of-indonesia', 12, notes), gps: await gcArt(R, 'interface-so-gps', 12, notes), seeAll: await gcArt(R, 'icon', 14, notes),
    cal: await gcArt(R, 'interface-so-date', 24, notes), info: await gcArt(R, 'icon-2', 14, notes), map: await gcArt(R, 'icon-3', 14, notes, '--dark-300'),
    note: await gcArt(R, 'ecommerce-so-price-tag-rotat', 16, notes), day: await gcArt(R, 'tab-container', 14, notes), night: await gcArt(R, 'tab-container-2', 14, notes) };
  var INC = {}; for (var x of GC_INCL) INC[x[0]] = await gcArt(R, x[0], 12, notes);
  var AM = []; for (var ai = 0; ai < GC_AMEN.length; ai++) AM.push(await gcArt(R, 'icon-label-' + (ai + 5), 22, notes));
  var old = page.findChild(function (n) { return n.type === 'FRAME' && n.name === 'Golf course'; });
  var keepX = old ? old.x : 0, keepY = old ? old.y : 0;
  if (old) old.remove();
  var scr = figma.createFrame(); page.appendChild(scr);
  scr.name = 'Golf course'; scr.x = keepX; scr.y = keepY;
  scr.layoutMode = 'VERTICAL'; scr.resize(390, 844); scr.layoutSizingHorizontal = 'FIXED'; scr.layoutSizingVertical = 'HUG'; scr.minHeight = 844;
  scr.itemSpacing = 0; scr.clipsContent = true; scr.fills = paintFor(R, '--light-200');
  var bar = appBar['type=adsShare, scrolled=false'].createInstance(); scr.appendChild(bar); bar.layoutSizingHorizontal = 'FILL'; setText(bar, { title: 'Golf course details', showActions: true });
  async function txt(parent, style, color, chars, name) { var t = await styledText(R, style, color, chars); parent.appendChild(t); t.name = name; t.textAutoResize = 'HEIGHT'; t.layoutSizingHorizontal = 'FILL'; return t; }
  // hero 240, the r24 sheet rides 24 over it
  var main = autoFrame('main', 'VERTICAL', scr); fillHug(main); main.itemSpacing = -24;
  var hero = figma.createRectangle(); main.appendChild(hero); hero.name = 'event-hero'; hero.resize(390, 240); hero.layoutSizingHorizontal = 'FILL'; await refPhoto(R, hero, 'ref/img/gcd/hero.jpg?v=1', notes);
  // the sheet has no side padding of its own: blocks pad themselves so the date band and the amenity rail can run edge to edge
  var sh = autoFrame('event-sheet', 'VERTICAL', main); fillHug(sh); bindNumber(R, sh, 'paddingTop', '--space-32', 32); bindNumber(R, sh, 'paddingBottom', '--space-32', 32);
  bindNumber(R, sh, 'itemSpacing', '--space-32', 32); ['topLeftRadius', 'topRightRadius'].forEach(function (f) { sh[f] = 24; });
  sh.fills = paintFor(R, '--light-100'); await effectStyle(R, sh, '--elevation-3');
  function blk(name, gap) { var b = autoFrame(name, 'VERTICAL', sh); fillHug(b); padX(R, b); if (gap) bindNumber(R, b, 'itemSpacing', gap[0], gap[1]); return b; }
  function divider() { var w = blk('divider'); var d = DV['type=line'].createInstance(); w.appendChild(d); d.layoutSizingHorizontal = 'FILL'; }
  function grid(parent, items, make, gapX) {
    var g = autoFrame('grid', 'VERTICAL', parent); fillHug(g); bindNumber(R, g, 'itemSpacing', gapX ? '--space-8' : '--space-4', gapX ? 8 : 4);
    for (var i = 0; i < items.length; i += 2) {
      var r = autoFrame('row', 'HORIZONTAL', g); fillHug(r); bindNumber(R, r, 'itemSpacing', gapX ? '--space-12' : '--space-4', gapX ? 12 : 4);
      items.slice(i, i + 2).forEach(function (it) { var c = make(it); r.appendChild(c); c.layoutSizingHorizontal = 'FILL'; });
      if (items.length - i === 1) { var e = autoFrame('empty', 'VERTICAL', r); e.layoutSizingHorizontal = 'FILL'; e.layoutSizingVertical = 'HUG'; }
    }
    return g;
  }
  // head
  var hd = blk('head', ['--space-8', 8]); hd.counterAxisAlignItems = 'CENTER';
  (await txt(hd, '--type-h3', '--dark-500', 'Suvarna Jakarta Golf Club', 'title')).textAlignHorizontal = 'CENTER';
  var ml = autoFrame('meta-line', 'HORIZONTAL', hd); hugHug(ml); ml.counterAxisAlignItems = 'CENTER'; bindNumber(R, ml, 'itemSpacing', '--space-4', 4);
  var fi = I.flag.createInstance(); ml.appendChild(fi); fi.resize(12, 12);
  var m1 = await styledText(R, '--type-b3s', '--dark-300', 'Jakarta Timur, Indonesia  \u2022'); ml.appendChild(m1); m1.textAutoResize = 'WIDTH_AND_HEIGHT';
  var gi = I.gps.createInstance(); ml.appendChild(gi); gi.resize(12, 12);
  var m2 = await styledText(R, '--type-b3s', '--dark-300', '54 km away'); ml.appendChild(m2); m2.textAutoResize = 'WIDTH_AND_HEIGHT';
  // promos: promo card + See all (16, radius 8, light-300, CTA S purple-500), credit strip
  var pr = blk('promos', ['--gap-related', 8]);
  var row = autoFrame('promo-row', 'HORIZONTAL', pr); fillHug(row); row.counterAxisAlignItems = 'MIN'; bindNumber(R, row, 'itemSpacing', '--space-8', 8);
  var pc = P.promo['pass=false'].createInstance(); row.appendChild(pc); pc.layoutSizingHorizontal = 'FILL'; pc.layoutSizingVertical = 'FILL';
  setText(pc, { title: 'Suvarna 10% Off (Weekday)', sub: 'Expiry date: 31 Mar 2023' });
  var sa = autoFrame('see-all', 'HORIZONTAL', row); sa.counterAxisAlignItems = 'CENTER'; sa.layoutSizingHorizontal = 'HUG'; sa.layoutSizingVertical = 'FILL'; bindNumber(R, sa, 'itemSpacing', '--space-4', 4);
  ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].forEach(function (f) { bindNumber(R, sa, f, '--space-16', 16); });
  bindRadius(R, sa, '--radius-8', 8); sa.fills = paintFor(R, '--light-300');
  var st = await styledText(R, '--type-cta-s', '--purple-500', 'See all'); sa.appendChild(st); st.textAutoResize = 'WIDTH_AND_HEIGHT';
  var si = I.seeAll.createInstance(); sa.appendChild(si); si.resize(14, 14);
  var cs = P.credit.children[0].createInstance(); pr.appendChild(cs); cs.layoutSizingHorizontal = 'FILL';
  // .date-band: full width, light-200, 16 / page-x / 0, items to the right, gap 16; calendar mask on the left; 17 days (clipped); session tabs
  var band = autoFrame('date-band', 'VERTICAL', sh); fillHug(band); padX(R, band); bindNumber(R, band, 'paddingTop', '--space-16', 16); band.counterAxisAlignItems = 'MAX';
  bindNumber(R, band, 'itemSpacing', '--space-16', 16); band.fills = paintFor(R, '--light-200'); band.clipsContent = true;
  var days = autoFrame('days', 'HORIZONTAL', band); days.resize(302, 36); days.layoutSizingHorizontal = 'FIXED'; days.layoutSizingVertical = 'HUG'; days.clipsContent = true; bindNumber(R, days, 'itemSpacing', '--space-4', 4);
  GC_DAYS.forEach(function (d, i) { var b = P.date['selected=' + (i ? 'false' : 'true')].createInstance(); days.appendChild(b); setText(b, { day: d[0], date: d[1] }); });
  var tabs = autoFrame('session-tabs', 'HORIZONTAL', band); fillHug(tabs);
  [['true', 'Day session', I.day], ['false', 'Night session', I.night]].forEach(function (x) { var t = P.tab['selected=' + x[0]].createInstance(); tabs.appendChild(t); setText(t, { label: x[1], icon: x[2].id }); });
  var cal = autoFrame('calendar', 'HORIZONTAL', band); cal.layoutPositioning = 'ABSOLUTE'; cal.x = 0; cal.y = 16; cal.resize(88, 36); cal.paddingLeft = 24; cal.counterAxisAlignItems = 'CENTER';
  cal.fills = [{ type: 'GRADIENT_LINEAR', gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: [{ position: 0, color: Object.assign({}, (paintFor(R, '--light-200')[0] || {}).color || { r: 0.97, g: 0.97, b: 0.98 }, { a: 1 }) }, { position: 64 / 88, color: Object.assign({}, (paintFor(R, '--light-200')[0] || {}).color || { r: 0.97, g: 0.97, b: 0.98 }, { a: 1 }) }, { position: 1, color: { r: 0.97, g: 0.97, b: 0.98, a: 0 } }] }];
  var ci = I.cal.createInstance(); cal.appendChild(ci); ci.resize(24, 24);
  // tee times
  var tt = blk('tee-times', ['--gap-related', 8]);
  var tr = autoFrame('title-row', 'HORIZONTAL', tt); fillHug(tr); tr.counterAxisAlignItems = 'CENTER'; bindNumber(R, tr, 'itemSpacing', '--space-8', 8);
  var trt = await styledText(R, '--type-h5', '--dark-500', 'Select preferred tee time'); tr.appendChild(trt); trt.name = 'section-title'; trt.textAutoResize = 'WIDTH_AND_HEIGHT';
  var tri = I.info.createInstance(); tr.appendChild(tri); tri.resize(14, 14);
  grid(tt, GC_RATES, function (r) { var c = P.rate.children[0].createInstance(); setText(c, { time: r[0], was: r[1], price: r[2], discount: '-10%' }); return c; }, true).name = 'rate-grid';
  var ib = autoFrame('incl-block', 'VERTICAL', tt); fillHug(ib); bindNumber(R, ib, 'itemSpacing', '--space-8', 8);
  await txt(ib, '--type-b2s', '--dark-500', 'Prices shown include:', 'title');
  grid(ib, GC_INCL, function (x) { var c = P.incl.children[0].createInstance(); setText(c, { icon: INC[x[0]].id, label: x[1] }); return c; }, false).name = 'incl-grid';
  divider();
  // amenities: 4 rows of 220 columns, gap 8 / 12, from the page edge, clipped at the screen edge
  var am = autoFrame('amenities', 'VERTICAL', sh); fillHug(am); bindNumber(R, am, 'itemSpacing', '--gap-related', 8);
  var amt = autoFrame('title', 'VERTICAL', am); fillHug(amt); padX(R, amt); await txt(amt, '--type-h5', '--dark-500', 'Amenities', 'section-title');
  var rail = autoFrame('amenity-rail', 'HORIZONTAL', am); fillHug(rail); padX(R, rail); rail.clipsContent = true; bindNumber(R, rail, 'itemSpacing', '--space-12', 12);
  for (var c0 = 0; c0 < GC_AMEN.length; c0 += 4) {
    var colf = autoFrame('column', 'VERTICAL', rail); hugHug(colf); bindNumber(R, colf, 'itemSpacing', '--space-8', 8);
    for (var a = c0; a < Math.min(c0 + 4, GC_AMEN.length); a++) { var ac = P.amen.children[0].createInstance(); colf.appendChild(ac); setText(ac, { icon: AM[a].id, label: GC_AMEN[a] }); }
  }
  divider();
  var lc = blk('location', ['--gap-related', 8]);
  await txt(lc, '--type-h5', '--dark-500', 'Location', 'section-title');
  var vn = P.venue['size=s'].createInstance(); lc.appendChild(vn); vn.layoutSizingHorizontal = 'FILL';
  var mb = BT['size=s, tone=muted, appearance=tertiary, state=default'].createInstance(); lc.appendChild(mb); mb.layoutSizingHorizontal = 'FILL';
  setText(mb, { label: 'View on Google Maps', showIconStart: false, showIconEnd: true, iconEnd: I.map.id });
  divider();
  var mi = blk('more', ['--gap-related', 8]);
  await txt(mi, '--type-h5', '--dark-500', 'More information', 'section-title');
  // .more-text: 64 tall, clipped, B3 dark-500; "... Show more" pinned bottom right on a white fade
  var mt = autoFrame('more-text', 'VERTICAL', mi); mt.resize(342, 64); mt.layoutSizingHorizontal = 'FILL'; mt.layoutSizingVertical = 'FIXED'; mt.clipsContent = true;
  await txt(mt, '--type-b3', '--dark-500', GC_MORE, 'text');
  var more = autoFrame('show-more', 'HORIZONTAL', mt); hugHug(more); more.layoutPositioning = 'ABSOLUTE'; more.paddingLeft = 8; more.fills = paintFor(R, '--light-100');
  var mtx = await styledText(R, '--type-b3s', '--purple-500', '... Show more'); more.appendChild(mtx); mtx.textAutoResize = 'WIDTH_AND_HEIGHT';
  more.x = 342 - more.width; more.y = 64 - more.height; more.constraints = { horizontal: 'MAX', vertical: 'MAX' };
  grid(mi, GC_STATS, function (x) { var c = P.stat.children[0].createInstance(); setText(c, { label: x[0], value: x[1] }); return c; }, true).name = 'stat-tiles';
  divider();
  var cp = blk('cross-promo', ['--space-16', 16]); cp.counterAxisAlignItems = 'MIN';
  var ci2 = figma.createRectangle(); cp.appendChild(ci2); ci2.name = 'photo'; ci2.resize(342, 160); ci2.layoutSizingHorizontal = 'FILL'; bindRadius(R, ci2, '--radius-16', 16); await refPhoto(R, ci2, 'ref/img/gcd/dr.jpg?v=1', notes);
  await txt(cp, '--type-h6', '--dark-500', 'Suvarna Jakarta Golf Club also has a driving range for you to book if you\u2019re interested', 'text');
  var cb = BT['size=s, tone=primary, appearance=tertiary, state=default'].createInstance(); cp.appendChild(cb);
  setText(cb, { label: 'Check out driving range', showIconStart: false, showIconEnd: true, iconEnd: I.seeAll.id });
  // bottom bar: Book tee time (disabled until a slot is picked)
  var bb = autoFrame('bottom-bar', 'VERTICAL', scr); fillHug(bb); padX(R, bb); bindNumber(R, bb, 'paddingTop', '--space-16', 16); bindNumber(R, bb, 'paddingBottom', '--space-32', 32);
  bb.fills = paintFor(R, '--light-100'); var up = lineBelow(R)[0]; if (up) bb.effects = [Object.assign({}, up, { offset: { x: 0, y: -1 } })];
  var bk = BT['size=l, tone=primary, appearance=solid, state=disabled'].createInstance(); bb.appendChild(bk); bk.layoutSizingHorizontal = 'FILL'; setText(bk, { label: 'Book tee time', showIconStart: false, showIconEnd: false });
  // .float-note: centred, 112 above the viewport bottom; 8 / 12, radius 8, green-50, Elevation 3, B3s + 16 tag
  var fn = autoFrame('float-note', 'HORIZONTAL', scr); hugHug(fn); fn.layoutPositioning = 'ABSOLUTE'; fn.counterAxisAlignItems = 'CENTER'; bindNumber(R, fn, 'itemSpacing', '--space-8', 8);
  bindNumber(R, fn, 'paddingTop', '--space-8', 8); bindNumber(R, fn, 'paddingBottom', '--space-8', 8); bindNumber(R, fn, 'paddingLeft', '--space-12', 12); bindNumber(R, fn, 'paddingRight', '--space-12', 12);
  bindRadius(R, fn, '--radius-8', 8); fn.fills = paintFor(R, '--green-50'); await effectStyle(R, fn, '--elevation-3');
  var fni = I.note.createInstance(); fn.appendChild(fni); fni.resize(16, 16);
  var fnt = await styledText(R, '--type-b3s', '--dark-500', 'Prices shown already includes the best promo!'); fn.appendChild(fnt); fnt.textAutoResize = 'WIDTH_AND_HEIGHT';
  fn.x = Math.round((390 - fn.width) / 2); fn.y = Math.round(scr.height - 112 - fn.height); fn.constraints = { horizontal: 'CENTER', vertical: 'MAX' };

  var one = function (m, props) { var i = m.createInstance(); if (props) setText(i, props); return i; };
  await screenList(R, page, scr, 'Golf course', async function (row) {
    await row('AppBar', partSrc('AppBar', PG) + ' · type=adsShare', [one(appBar['type=adsShare, scrolled=false'], { title: 'Golf course details', showActions: true })]);
    await row('PromoCard', partSrc('PromoCard', PG) + ' · pass=false, next to See all', [one(P.promo['pass=false'])]);
    await row('CreditStrip', partSrc('CreditStrip', PG), [P.credit.children[0].createInstance()]);
    await row('DateBtn', partSrc('DateBtn', PG) + ' · 17 days, the first selected', [one(P.date['selected=true']), one(P.date['selected=false'])]);
    await row('SessionTab', partSrc('SessionTab', PG) + ' · Day selected, Night', [one(P.tab['selected=true']), one(P.tab['selected=false'])]);
    await row('RateCard', partSrc('RateCard', PG) + ' · 8 slots in 2 columns', [P.rate]);
    await row('InclItem', partSrc('InclItem', PG) + ' · 4 included items', [P.incl]);
    await row('Amenity', partSrc('Amenity', PG) + ' · 12 in columns of 4', [P.amen]);
    await row('Venue', partSrc('Venue', PG) + ' · size=s', [one(P.venue['size=s'])]);
    await row('StatTile', partSrc('StatTile', PG) + ' · 7 course facts', [P.stat]);
    await row('Divider', partSrc('Divider', PG) + ' · type=line', [one(DV['type=line'])]);
    await row('Button', partSrc('Button', PG) + ' · muted s (maps), tertiary s (driving range), l disabled (Book tee time)', [one(BT['size=s, tone=muted, appearance=tertiary, state=default'], { label: 'View on Google Maps', showIconEnd: true, iconEnd: I.map.id }), one(BT['size=l, tone=primary, appearance=solid, state=disabled'], { label: 'Book tee time' })]);
  });
  notes.push('Golf course: built from stat.chara.id/swing/ref/golf-course.html. The sheet rides 24 over the photo; the date strip and the amenity rail are clipped instead of scrolling; the floating promo note is pinned 112 above the frame bottom; grids are rows of two.');
  return { set: scr, count: 12, label: 'screen from 12 parts' };
}

/* ----- Booking confirmation (ref/booking.html): PayType, PlayerRow, MiniRow, PriceRow, PayBar (booking details and tournament confirm reuse them) ----- */
var BK_PAGE = 'Screen / Booking';
async function tcArt(R, name, size, notes, css) { return refIcon(R, 'tc-' + name, 'ref/img/tc/' + name + '.svg?v=1', size, css || null, notes, await pageNamed(BK_PAGE)); }
async function buildPayTypePage(R, notes) {
  var page = await pageNamed(BK_PAGE);
  var ic = await iconOrPlaceholder('Icon/Line/groups-2', page, notes);
  var pt = {};
  var V = [{ selected: 'true', name: 'selected=true' }, { selected: 'false', name: 'selected=false' }];
  return buildPartPage(R, notes, 'PayType', async function (comp, K, pg, v) {
    // .pay-type__opt: centred, gap 12, 12 / 16, radius 16, light-200, B3s dark-300, icon 20; selected: purple-100 line, purple-50, purple-500, Elevation brand
    var sel = v.selected === 'true';
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER'; comp.resize(167, 60); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'paddingTop', '--space-12', 12); bindNumber(R, comp, 'paddingBottom', '--space-12', 12); bindNumber(R, comp, 'paddingLeft', '--space-16', 16); bindNumber(R, comp, 'paddingRight', '--space-16', 16);
    bindNumber(R, comp, 'itemSpacing', '--space-12', 12); bindRadius(R, comp, '--radius-16', 16); comp.fills = paintFor(R, sel ? '--purple-50' : '--light-200');
    comp.strokes = sel ? paintFor(R, '--purple-100') : []; comp.strokeWeight = 1; comp.strokeAlign = 'INSIDE'; if (sel) await effectStyle(R, comp, '--elevation-brand');
    var i = ic.createInstance(); comp.appendChild(i); i.name = 'icon'; i.resize(20, 20); recolorIcon(R, i, sel ? '--purple-500' : '--dark-300');
    pt[comp.name] = { i: i, t: await K.txt(comp, '--type-b3s', sel ? '--purple-500' : '--dark-300', sel ? 'Host pays for everyone' : 'Players pay for themselves', 'label', 'fill') };
  }, function (s) {
    var pI = ensureProp(s, 'icon', 'INSTANCE_SWAP', ic.id), pL = ensureProp(s, 'label', 'TEXT', 'Host pays for everyone');
    wireKeys(pt).forEach(function (k) { pt[k].i.componentPropertyReferences = { mainComponent: pI }; pt[k].t.componentPropertyReferences = { characters: pL }; });
    s.description = '<button class="swing_pay_type__opt" role="radio" aria-checked>icon 20 + label</button> in .swing_pay_type (2 columns, gap 8). selected = aria-checked="true": purple-100 line, purple-50, purple-500, Elevation brand.';
  }, { description: 'Who pays: one of two options.', variants: V });
}
async function buildPlayerRowPage(R, notes) {
  var AV = byName(await setFrom('Avatar', 'Avatar', buildAvatarPage, R, notes));
  var I = { chev: await tcArt(R, 'chev-down-12', 12, notes, '--dark-300'), add: await tcArt(R, 'add', 14, notes, '--purple-500') };
  var pr = {};
  var V = [{ kind: 'host', name: 'kind=host' }, { kind: 'player', name: 'kind=player' }, { kind: 'empty', name: 'kind=empty' }, { kind: 'own', name: 'kind=own' }];
  return buildPartPage(R, notes, 'PlayerRow', async function (comp, K, pg, v) {
    // .player-row: centred, gap 16; Avatar S; name H6 dark-500 (+ sub B3s dark-300 for a regular player); price B3s dark-300 + chevron 12 (turned when open).
    // empty: guest avatar, "Empty slot" dark-100, then "Add a player" (text button, purple-500, add 14) or "Pays for their own" (B3s dark-200)
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER'; comp.resize(308, 40); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--space-16', 16); comp.fills = [];
    var host = v.kind === 'host', pl = v.kind === 'player';
    var av = AV[host || pl ? 'size=s, type=initials' : 'size=s, type=guest'].createInstance(); comp.appendChild(av); av.name = 'avatar';
    var tx = autoFrame('text', 'VERTICAL', comp); tx.layoutSizingHorizontal = 'FILL'; tx.layoutSizingVertical = 'HUG';
    var p = { nm: await K.txt(tx, '--type-h6', host || pl ? '--dark-500' : '--dark-100', host ? 'Alvin Lianto (Host)' : pl ? 'Budi Santoso' : 'Empty slot', 'name', 'fill') };
    if (pl) p.sub = await K.txt(tx, '--type-b3s', '--green-700', 'Paid by host', 'sub', 'fill');   // .player-row__sub--paid
    else if (host) {
      p.sub = await K.txt(tx, '--type-b3s', '--dark-300', 'Regular Swing player', 'sub', 'fill');
      var pc = autoFrame('price', 'HORIZONTAL', comp); hugHug(pc); pc.counterAxisAlignItems = 'CENTER'; bindNumber(R, pc, 'itemSpacing', '--space-4', 4);
      p.pr = await K.txt(pc, '--type-b3s', '--dark-300', 'Rp. 1,222,000', 'text');
      var ch = I.chev.createInstance(); pc.appendChild(ch); ch.name = 'chevron'; ch.resize(12, 12); ch.rotation = 180;   // aria-expanded: scaleY(-1)
    } else if (v.kind === 'empty') {
      var ab = autoFrame('add', 'HORIZONTAL', comp); hugHug(ab); ab.counterAxisAlignItems = 'CENTER'; bindNumber(R, ab, 'itemSpacing', '--space-4', 4);   // .btn--s.btn--text
      var ai = I.add.createInstance(); ab.appendChild(ai); ai.name = 'icon'; ai.resize(14, 14);
      p.ad = await K.txt(ab, '--type-cta-s', '--purple-500', 'Add a player', 'label');
    } else p.ad = await K.txt(comp, '--type-b3s', '--dark-200', 'Pays for their own', 'own');
    pr[comp.name] = p;
  }, function (s) {
    var P = { nm: ensureProp(s, 'name', 'TEXT', 'Alvin Lianto (Host)'), sub: ensureProp(s, 'sub', 'TEXT', 'Regular Swing player'), pr: ensureProp(s, 'price', 'TEXT', 'Rp. 1,222,000'), ad: ensureProp(s, 'action', 'TEXT', 'Add a player') };
    wireKeys(pr).forEach(function (k) { wireKeys(P).forEach(function (f) { if (pr[k][f]) pr[k][f].componentPropertyReferences = { characters: P[f] }; }); });
    s.description = '<div class="swing_player_row">avatar + .swing_player_row__text (name H6, sub B3s) + .swing_player_row__price (B3s + chevron)</div> in .swing_player_list (white, line, radius 16; items 16 padding, line between). kind=host = the booker; player = a joined player (sub in green-700, .swing_player_row__sub_paid; set the avatar initials on the nested Avatar); empty = an open slot with "Add a player" (.swing_btn_text); own = an open slot when players pay for themselves. A Swing Pass member\'s sub is gradient text on the web; set the sub colour on the instance.';
  }, { description: 'A player slot in the booking.', variants: V });
}
async function buildMiniRowPage(R, notes) {
  var SW = byName(await setFrom('Switch', 'Switch', buildSwitchPage, R, notes));
  var I = { promo: await tcArt(R, 'promo', 16, notes, '--green-500'), chev: await tcArt(R, 'chev-right', 16, notes, '--dark-200'), sc: await brandIcon(R, 'swing-credits-icon', 16, notes, await pageNamed(BK_PAGE)),
    err: await tcArt(R, 'user-info', 16, notes, '--red-500') };
  var mr = {};
  var V = [{ kind: 'promo', name: 'kind=promo' }, { kind: 'credits', name: 'kind=credits' }, { kind: 'error', name: 'kind=error' }];
  return buildPartPage(R, notes, 'MiniRow', async function (comp, K, pg, v) {
    // .mini-row: centred, gap 12, 12, radius 8, light-200; icon 16; title B3s dark-300 (one line), sub B4 dark-300 (promo: B4s green-500); promo = chevron 16 dark-200, credits = Switch
    var pro = v.kind === 'promo', err = v.kind === 'error';
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER'; comp.resize(260, 48); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].forEach(function (f) { bindNumber(R, comp, f, '--space-12', 12); });
    bindNumber(R, comp, 'itemSpacing', '--space-12', 12); bindRadius(R, comp, '--radius-8', 8); comp.fills = paintFor(R, '--light-200');
    var i = (err ? I.err : pro ? I.promo : I.sc).createInstance(); comp.appendChild(i); i.name = 'icon'; i.resize(16, 16);
    var tx = autoFrame('text', 'VERTICAL', comp); tx.layoutSizingHorizontal = 'FILL'; tx.layoutSizingVertical = 'HUG';
    var t = await K.txt(tx, '--type-b3s', err ? '--red-500' : '--dark-300', err ? 'Fill in player details' : pro ? 'Suvarna 10% Off (Weekday)' : 'Use 200,000 Swing Credits', 'title', 'fill'); t.textTruncation = 'ENDING'; t.maxLines = 1;
    var sb = err ? null : await K.txt(tx, pro ? '--type-b4s' : '--type-b4', pro ? '--green-500' : '--dark-300', pro ? 'The best promo auto applied!' : 'Out of 1,000,000', 'sub', 'fill');
    if (pro || err) { var c = I.chev.createInstance(); comp.appendChild(c); c.name = 'chevron'; c.resize(16, 16); }
    else { var sw = SW['checked=true, state=default'].createInstance(); comp.appendChild(sw); sw.name = 'switch'; }
    mr[comp.name] = { t: t, sb: sb, i: i };
  }, function (s) {
    var pT = ensureProp(s, 'title', 'TEXT', 'Suvarna 10% Off (Weekday)'), pS = ensureProp(s, 'sub', 'TEXT', 'The best promo auto applied!'), pI = ensureProp(s, 'icon', 'INSTANCE_SWAP', I.promo.id);
    wireKeys(mr).forEach(function (k) { mr[k].t.componentPropertyReferences = { characters: pT }; if (mr[k].sb) mr[k].sb.componentPropertyReferences = { characters: pS }; mr[k].i.componentPropertyReferences = { mainComponent: pI }; });
    s.description = '<a class="swing_mini_row">icon 16 + title / sub + chevron</a> or <label class="swing_mini_row">credits + switch</label> in a player breakdown. light-200, radius 8, padding 12, gap 12. The DS Switch has one size (40 x 24); the web uses .swing_switch_s.';
  }, { description: 'A small promo or Swing Credits row under a player.', variants: V });
}
async function buildPriceRowPage(R, notes) {
  var info = await tcArt(R, 'so-info', 12, notes, '--dark-300');
  var pw = {};
  var V = [{ kind: 'normal', name: 'kind=normal' }, { kind: 'total', name: 'kind=total' }, { kind: 'info', name: 'kind=info' }, { kind: 'sub', name: 'kind=sub' }];
  return buildPartPage(R, notes, 'PriceRow', async function (comp, K, pg, v) {
    // .price-row: space-between, top-aligned, gap 16; label B3s dark-300 (info: inline + 12 icon, gap 4); value B3 dark-300 right (total: B3s)
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'MIN'; comp.primaryAxisAlignItems = 'SPACE_BETWEEN'; comp.resize(342, 20); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--space-16', 16); comp.fills = [];
    var lab = comp;
    if (v.kind === 'info') { lab = autoFrame('label', 'HORIZONTAL', comp); hugHug(lab); lab.counterAxisAlignItems = 'CENTER'; bindNumber(R, lab, 'itemSpacing', '--space-4', 4); }
    if (v.kind === 'sub') { lab = autoFrame('label', 'VERTICAL', comp); lab.layoutSizingHorizontal = 'FILL'; lab.layoutSizingVertical = 'HUG'; bindNumber(R, lab, 'itemSpacing', '--space-4', 4); }
    var l = await K.txt(lab, '--type-b3s', '--dark-300', v.kind === 'total' ? 'Total payment' : v.kind === 'info' ? 'Processing fee' : 'Alvin Lianto (Host)', v.kind === 'info' || v.kind === 'sub' ? 'text' : 'label');
    var sb = null; if (v.kind === 'sub') { var sw = autoFrame('sub', 'VERTICAL', lab); fillHug(sw); bindNumber(R, sw, 'paddingLeft', '--space-16', 16); sb = await K.txt(sw, '--type-b3', '--dark-300', 'Single Package', 'text', 'fill'); }   // .price-row__sub: 16 in, B3
    if (v.kind === 'info') { var i = info.createInstance(); lab.appendChild(i); i.name = 'icon'; i.resize(12, 12); }
    var val = await K.txt(comp, v.kind === 'total' ? '--type-b3s' : '--type-b3', '--dark-300', v.kind === 'total' ? 'Rp. 4,069,000' : v.kind === 'info' ? 'Rp. 3,000' : 'Rp. 1,222,000', 'value'); val.textAlignHorizontal = 'RIGHT';
    pw[comp.name] = { l: l, v: val, sb: sb };
  }, function (s) {
    var pL = ensureProp(s, 'label', 'TEXT', 'Alvin Lianto (Host)'), pV = ensureProp(s, 'value', 'TEXT', 'Rp. 1,222,000'), pS = ensureProp(s, 'sub', 'TEXT', 'Single Package');
    wireKeys(pw).forEach(function (k) { pw[k].l.componentPropertyReferences = { characters: pL }; pw[k].v.componentPropertyReferences = { characters: pV }; if (pw[k].sb) pw[k].sb.componentPropertyReferences = { characters: pS }; });
    s.description = '<div class="swing_price_row [swing_price_row_total]"><span class="swing_price_row__label [--inline]">…</span><span class="swing_price_row__value">…</span></div> in .swing_price_rows (gap 8). kind=total = .swing_price_row_total (value B3s); info = an inline 12 info icon after the label. A struck published rate: set the value text to strikethrough on the instance.';
  }, { description: 'A label and amount in the price breakdown.', variants: V });
}
async function buildPayBarPage(R, notes) {
  var BT = byName(await setFrom('Button', 'Button', buildButton, R, notes));
  var I = { chev: await tcArt(R, 'pay-chev', 12, notes, '--green-500'), arrow: await tcArt(R, 'pay-arrow', 20, notes, '--light-100'), sc: await brandIcon(R, 'swing-credits-icon', 16, notes, await pageNamed(BK_PAGE)) };
  var pb = {};
  return buildPartPage(R, notes, 'PayBar', async function (comp, K) {
    // .pay-bar: centred, gap 16; total right-aligned (amount H4 dark-500, earn B2s green-500 with the credits mark 16 + chevron 12, gap 4), then the pay Button (l) with an arrow
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER'; comp.resize(342, 48); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'itemSpacing', '--space-16', 16); comp.fills = [];
    var tot = autoFrame('total', 'VERTICAL', comp); tot.layoutSizingHorizontal = 'FILL'; tot.layoutSizingVertical = 'HUG'; tot.counterAxisAlignItems = 'MAX'; bindNumber(R, tot, 'itemSpacing', '--space-4', 4);
    var am = await K.txt(tot, '--type-h4', '--dark-500', 'Rp. 4,069,000', 'amount');
    var ea = autoFrame('earn', 'HORIZONTAL', tot); hugHug(ea); ea.counterAxisAlignItems = 'CENTER'; bindNumber(R, ea, 'itemSpacing', '--space-4', 4);
    var m = I.sc.createInstance(); ea.appendChild(m); m.name = 'credits'; m.resize(16, 16);
    var et = await K.txt(ea, '--type-b2s', '--green-500', '+81,320 for all', 'text');
    var c = I.chev.createInstance(); ea.appendChild(c); c.name = 'chevron'; c.resize(12, 12);
    var b = BT['size=l, tone=primary, appearance=solid, state=default'].createInstance(); comp.appendChild(b); b.name = 'pay';
    setText(b, { label: 'Pay for all', showIconStart: false, showIconEnd: true, iconEnd: I.arrow.id });
    pb[comp.name] = { am: am, et: et };
  }, function (s) {
    var pA = ensureProp(s, 'amount', 'TEXT', 'Rp. 4,069,000'), pE = ensureProp(s, 'earn', 'TEXT', '+81,320 for all');
    wireKeys(pb).forEach(function (k) { pb[k].am.componentPropertyReferences = { characters: pA }; pb[k].et.componentPropertyReferences = { characters: pE }; });
    s.description = '<div class="swing_pay_bar"><div class="swing_pay_bar__total"><span class="swing_pay_bar__amount">…</span><button class="swing_pay_bar__earn">credits + …</button></div><a class="swing_btn">Pay … →</a></div> in the bottom bar. Gap 16; the total sits right-aligned next to the Button l (set its label on the instance).';
  }, { description: 'The total, the credits you earn, and the pay button.' });
}

async function buildBookingScreen(R, notes) {
  var PG = BK_PAGE, page = await pageNamed(PG);
  var appBar = byName(await setWith('AppBar', 'AppBar', buildAppBarPage, R, notes, 'type=ads, scrolled=false'));
  var BT = byName(await setFrom('Button', 'Button', buildButton, R, notes));
  var DV = byName(await setFrom('Divider', 'Divider', buildDividerPage, R, notes));
  var CP = byName(await setFrom('Caption', 'Caption', buildCaptionPage, R, notes));
  var STP = byName(await setFrom('Stepper', 'Stepper', buildStepperPage, R, notes));
  var KV = byName(await setWith('KvRow', 'KvRow', buildKvRowPage, R, notes, 'pay=true'));
  var PM = byName(await setWith('PayMethod', 'PayMethod', buildPayMethodPage, R, notes, 'type=action'));
  var P = { type: byName(await setWith('PayType', 'PayType', buildPayTypePage, R, notes, 'selected=false')), player: byName(await setWith('PlayerRow', 'PlayerRow', buildPlayerRowPage, R, notes, 'kind=own')),
    mini: byName(await setWith('MiniRow', 'MiniRow', buildMiniRowPage, R, notes, 'kind=credits')), price: byName(await setWith('PriceRow', 'PriceRow', buildPriceRowPage, R, notes, 'kind=info')),
    bar: await setFrom('PayBar', 'PayBar', buildPayBarPage, R, notes) };
  var I = { g: await iconOrPlaceholder('Icon/Line/groups-2', page, notes), ref: await iconOrPlaceholder('Icon/Line/referral', page, notes), more: await tcArt(R, 'show-more', 14, notes, '--purple-500'),
    chevW: await spArt(R, 'chev-w-14', 14, notes, page), ovo: await refLogo(R, 'ovo', 'ref/img/sp/ovo.png?v=1', 22, 22, notes, await pageNamed(SPJ_PAGE)) };
  var scr = spjScreen(page, 'Booking', R);
  var bar = appBar['type=ads, scrolled=false'].createInstance(); scr.appendChild(bar); bar.layoutSizingHorizontal = 'FILL'; setText(bar, { title: 'Booking confirmation', showActions: false });
  var S = spjSections(R, scr); bindNumber(R, S.main, 'paddingTop', '--space-4', 4);
  async function txt(parent, style, color, chars, name) { var t = await styledText(R, style, color, chars); parent.appendChild(t); t.name = name; t.textAutoResize = 'HEIGHT'; t.layoutSizingHorizontal = 'FILL'; return t; }
  function divider(p) { var d = DV['type=line'].createInstance(); p.appendChild(d); d.layoutSizingHorizontal = 'FILL'; }
  function price(parent, kind, label, value, struck) {
    var r = P.price['kind=' + kind].createInstance(); parent.appendChild(r); r.layoutSizingHorizontal = 'FILL'; setText(r, { label: label, value: value });
    if (struck) { var vt = r.findOne(function (n) { return n.type === 'TEXT' && n.name === 'value'; }); if (vt) vt.textDecoration = 'STRIKETHROUGH'; }
    return r;
  }
  // 1. course + when
  var p1 = await S.page('summary');
  await txt(p1, '--type-h5', '--dark-500', 'Suvarna Jakarta Golf Club', 'title'); divider(p1);
  var kl = autoFrame('kv-list', 'VERTICAL', p1); fillHug(kl); bindNumber(R, kl, 'itemSpacing', '--space-8', 8);
  [['Date', '16 September 2025'], ['Session', 'Day session'], ['Preferred time', '05:30 - 06:00']].forEach(function (r) { var i = KV['pay=false'].createInstance(); kl.appendChild(i); i.layoutSizingHorizontal = 'FILL'; setText(i, { key: r[0], value: r[1] }); });
  // 2. who pays + players
  var p2 = await S.page('players', 'Who pays and how many pax?');
  var tr = autoFrame('pay-type', 'HORIZONTAL', p2); fillHug(tr); bindNumber(R, tr, 'itemSpacing', '--space-8', 8);
  [['false', 'Players pay for themselves', I.g], ['true', 'Host pays for everyone', I.ref]].forEach(function (x) { var o = P.type['selected=' + x[0]].createInstance(); tr.appendChild(o); o.layoutSizingHorizontal = 'FILL'; setText(o, { label: x[1], icon: x[2].id }); });
  // .pax-row: centred, gap 8, 12 / 16, radius 16, light-200; label B2s + hint B3s (Min in orange-700); DS Stepper
  var px = autoFrame('pax-row', 'HORIZONTAL', p2); fillHug(px); px.counterAxisAlignItems = 'CENTER'; bindNumber(R, px, 'itemSpacing', '--space-8', 8);
  bindNumber(R, px, 'paddingTop', '--space-12', 12); bindNumber(R, px, 'paddingBottom', '--space-12', 12); bindNumber(R, px, 'paddingLeft', '--space-16', 16); bindNumber(R, px, 'paddingRight', '--space-16', 16);
  bindRadius(R, px, '--radius-16', 16); px.fills = paintFor(R, '--light-200');
  var pxt = autoFrame('text', 'VERTICAL', px); pxt.layoutSizingHorizontal = 'FILL'; pxt.layoutSizingVertical = 'HUG';
  await txt(pxt, '--type-b2s', '--dark-500', 'Number of players', 'label');
  var hint = await txt(pxt, '--type-b3s', '--dark-300', 'Min 3 pax. Max 4 pax.', 'hint'); hint.setRangeFills(0, 10, paintFor(R, '--orange-700'));
  var stp = STP['state=default'].createInstance(); px.appendChild(stp); setText(stp, { value: '3' });
  // .player-list: white, line, radius 16; items 16, gap 8, line between; the host is open with its breakdown (48 in, gap 4)
  var pl = autoFrame('player-list', 'VERTICAL', p2); fillHug(pl); pl.clipsContent = true; bindRadius(R, pl, '--radius-16', 16);
  pl.fills = paintFor(R, '--light-100'); pl.strokes = paintFor(R, '--light-500'); pl.strokeWeight = 1; pl.strokeAlign = 'INSIDE';
  function item(i) {
    var it = autoFrame('player', 'VERTICAL', pl); fillHug(it); ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].forEach(function (f) { bindNumber(R, it, f, '--space-16', 16); });
    bindNumber(R, it, 'itemSpacing', '--space-8', 8);
    if (i) { it.strokes = paintFor(R, '--light-500'); it.strokeAlign = 'INSIDE'; it.strokeTopWeight = 1; it.strokeRightWeight = 0; it.strokeBottomWeight = 0; it.strokeLeftWeight = 0; }
    return it;
  }
  var h = item(0); var hr = P.player['kind=host'].createInstance(); h.appendChild(hr); hr.layoutSizingHorizontal = 'FILL';
  setText(hr, { name: 'Alvin Lianto (Host)', sub: 'Regular Swing player', price: 'Rp. 1,222,000' });
  var bd = autoFrame('breakdown', 'VERTICAL', h); fillHug(bd); bindNumber(R, bd, 'paddingLeft', '--space-48', 48); bindNumber(R, bd, 'itemSpacing', '--space-4', 4);
  var prs = autoFrame('price-rows', 'VERTICAL', bd); fillHug(prs); bindNumber(R, prs, 'itemSpacing', '--space-8', 8);
  price(prs, 'normal', 'Published rate', 'Rp. 1,580,000', true); price(prs, 'normal', 'Suvarna 10% Off (Weekday)', '- Rp. 158,000'); price(prs, 'normal', 'Swing Credits used', '- 200,000');
  var m1 = P.mini['kind=promo'].createInstance(); bd.appendChild(m1); m1.layoutSizingHorizontal = 'FILL';
  var m2 = P.mini['kind=credits'].createInstance(); bd.appendChild(m2); m2.layoutSizingHorizontal = 'FILL';
  // .pass-strip.pass-strip--card: radius 8, gradient, B3s white + chevron 14
  var ps = autoFrame('pass-strip', 'HORIZONTAL', bd); fillHug(ps); ps.counterAxisAlignItems = 'CENTER'; bindNumber(R, ps, 'itemSpacing', '--space-8', 8);
  bindNumber(R, ps, 'paddingTop', '--space-8', 8); bindNumber(R, ps, 'paddingBottom', '--space-8', 8); bindNumber(R, ps, 'paddingLeft', '--space-16', 16); bindNumber(R, ps, 'paddingRight', '--space-16', 16);
  bindRadius(R, ps, '--radius-8', 8); await fillStyle(R, ps, '--gradient-swing-pass', '--purple-500');
  await txt(ps, '--type-b3s', '--light-100', 'Save up to 50% on your slot with Swing Pass', 'text');
  var pci = I.chevW.createInstance(); ps.appendChild(pci); pci.resize(14, 14);
  for (var e = 1; e < 3; e++) { var ei = item(e); var er = P.player['kind=empty'].createInstance(); ei.appendChild(er); er.layoutSizingHorizontal = 'FILL'; }
  // .inputbar: 36, 0 / 12, radius 8, light-300, B2 hint dark-200
  var ib = autoFrame('inputbar', 'HORIZONTAL', p2); ib.counterAxisAlignItems = 'CENTER'; ib.resize(342, 36); ib.layoutSizingHorizontal = 'FILL'; ib.layoutSizingVertical = 'FIXED';
  bindNumber(R, ib, 'paddingLeft', '--space-12', 12); bindNumber(R, ib, 'paddingRight', '--space-12', 12); bindRadius(R, ib, '--radius-8', 8); ib.fills = paintFor(R, '--light-300');
  await txt(ib, '--type-b2', '--dark-200', 'Add notes to Suvarna Jakarta Golf Club...', 'hint');
  // 3. terms: 3-line clamp, divider, Show more (text button), caption
  var p3 = await S.page('terms', 'Terms & conditions');
  var cl = await txt(p3, '--type-b3', '--dark-500', 'Please arrive at the clubhouse at least 30 minutes before your tee time to check in. Tee times can be rescheduled up to 24 hours before play, subject to availability. Cancellations made less than 24 hours before the tee time are not refundable. Proper golf attire is required on the course: collared shirt, golf trousers or shorts, and soft-spike golf shoes. Rain checks are issued at the discretion of the golf course when play is stopped because of weather. The golf course may reassign your tee time by up to 30 minutes for tournament or maintenance needs.', 'clamp-text');
  cl.textTruncation = 'ENDING'; cl.maxLines = 3;
  divider(p3);
  var sm = autoFrame('show-more', 'HORIZONTAL', p3); hugHug(sm); sm.counterAxisAlignItems = 'CENTER'; bindNumber(R, sm, 'itemSpacing', '--space-4', 4);
  var smt = await styledText(R, '--type-cta-s', '--purple-500', 'Show more'); sm.appendChild(smt); smt.textAutoResize = 'WIDTH_AND_HEIGHT';
  var smi = I.more.createInstance(); sm.appendChild(smi); smi.resize(14, 14);
  var cap = CP['tone=neutral, size=s'].createInstance(); p3.appendChild(cap); cap.layoutSizingHorizontal = 'FILL';
  setText(cap, { text: 'By tapping the \u201cPay for all\u201d button, you are agreeing to the terms & conditions of the golf course.' });
  // 4. price details
  var p4 = await S.page('price', 'Price details');
  var pr4 = autoFrame('price-rows', 'VERTICAL', p4); fillHug(pr4); bindNumber(R, pr4, 'itemSpacing', '--space-8', 8);
  price(pr4, 'normal', 'Alvin Lianto (Host)', 'Rp. 1,222,000'); price(pr4, 'normal', 'Player 2', 'Rp. 1,422,000'); price(pr4, 'normal', 'Player 3', 'Rp. 1,422,000'); price(pr4, 'info', 'Processing fee', 'Rp. 3,000');
  divider(p4); price(p4, 'total', 'Total payment', 'Rp. 4,069,000');
  var pm = PM['type=action'].createInstance(); p4.appendChild(pm); pm.layoutSizingHorizontal = 'FILL'; setText(pm, { icon: I.ovo.id, name: 'OVO' });
  var pmb = pm.findOne(function (n) { return n.type === 'INSTANCE' && n.name === 'action'; }); if (pmb) setText(pmb, { label: 'Change' });
  // bottom bar: PayBar
  var bb = autoFrame('bottom-bar', 'VERTICAL', scr); fillHug(bb); padX(R, bb); bindNumber(R, bb, 'paddingTop', '--space-16', 16); bindNumber(R, bb, 'paddingBottom', '--space-32', 32);
  bb.fills = paintFor(R, '--light-100'); var up = lineBelow(R)[0]; if (up) bb.effects = [Object.assign({}, up, { offset: { x: 0, y: -1 } })];
  var pyb = P.bar.children[0].createInstance(); bb.appendChild(pyb); pyb.layoutSizingHorizontal = 'FILL'; setText(pyb, { amount: 'Rp. 4,069,000', earn: '+81,320 for all' });

  var one = function (m, props) { var i = m.createInstance(); if (props) setText(i, props); return i; };
  await screenList(R, page, scr, 'Booking', async function (row) {
    await row('AppBar', partSrc('AppBar', PG) + ' · type=ads, no actions', [one(appBar['type=ads, scrolled=false'], { title: 'Booking confirmation', showActions: false })]);
    await row('KvRow', partSrc('KvRow', PG) + ' · date, session, time', [one(KV['pay=false'])]);
    await row('PayType', partSrc('PayType', PG) + ' · Host pays selected', [one(P.type['selected=true']), one(P.type['selected=false'])]);
    await row('Stepper', partSrc('Stepper', PG) + ' · number of players', [one(STP['state=default'])]);
    await row('PlayerRow', partSrc('PlayerRow', PG) + ' · kind=host (open), empty, own', [one(P.player['kind=host']), one(P.player['kind=empty']), one(P.player['kind=own'])]);
    await row('MiniRow', partSrc('MiniRow', PG) + ' · kind=promo, kind=credits (Switch)', [one(P.mini['kind=promo']), one(P.mini['kind=credits'])]);
    await row('PriceRow', partSrc('PriceRow', PG) + ' · kind=normal / info / total', [one(P.price['kind=normal']), one(P.price['kind=info']), one(P.price['kind=total'])]);
    await row('PayMethod', partSrc('PayMethod', PG) + ' · type=action with the OVO logo and Change', [one(PM['type=action'], { icon: I.ovo.id, name: 'OVO' })]);
    await row('Caption', partSrc('Caption', PG) + ' · tone=neutral, size=s', [one(CP['tone=neutral, size=s'])]);
    await row('Divider', partSrc('Divider', PG) + ' · type=line', [one(DV['type=line'])]);
    await row('PayBar', partSrc('PayBar', PG) + ' · total, credits earned, Pay for all', [P.bar.children[0].createInstance()]);
  });
  notes.push('Booking: built from stat.chara.id/swing/ref/booking.html in its default state (host pays, 3 players, credits on, host breakdown open). "Add a player" and "Show more" are .swing_btn_text (no DS text button), drawn as CTA S text; the pay-type icons use the DS groups-2 and referral icons (the web loads them from /swing/a/, which has no CORS for the plugin); PayMethod here has gap 14 (the web .swing_pay_method without --l has 12).');
  return { set: scr, count: 11, label: 'screen from 11 parts' };
}

/* ----- Tee time details (ref/booking-details.html, default = confirmed, regular player) ----- */
async function buildBookingDetailsScreen(R, notes) {
  var PG = 'Screen / Booking details', page = await pageNamed(PG);
  var appBar = byName(await setWith('AppBar', 'AppBar', buildAppBarPage, R, notes, 'type=adsShare, scrolled=false'));
  var DV = byName(await setFrom('Divider', 'Divider', buildDividerPage, R, notes));
  var CP = byName(await setFrom('Caption', 'Caption', buildCaptionPage, R, notes));
  var BD = byName(await setFrom('Badge', 'Badge', buildBadgePage, R, notes));
  var KV = byName(await setWith('KvRow', 'KvRow', buildKvRowPage, R, notes, 'pay=true'));
  var P = { player: byName(await setWith('PlayerRow', 'PlayerRow', buildPlayerRowPage, R, notes, 'kind=player')), mini: byName(await setWith('MiniRow', 'MiniRow', buildMiniRowPage, R, notes, 'kind=credits')),
    price: byName(await setWith('PriceRow', 'PriceRow', buildPriceRowPage, R, notes, 'kind=info')) };
  var I = { more: await iconOrPlaceholder('Icon/Line/more-h', page, notes), tick: await spArt(R, 'tick-circle', 16, notes, page), chevR: await tcArt(R, 'chev-right', 14, notes, '--purple-500'),
    showMore: await tcArt(R, 'show-more', 14, notes, '--purple-500'), chevW: await spArt(R, 'chev-w-14', 14, notes, page) };
  var scr = spjScreen(page, 'Booking details', R);
  var bar = appBar['type=adsShare, scrolled=false'].createInstance(); scr.appendChild(bar); bar.layoutSizingHorizontal = 'FILL'; setText(bar, { title: 'Tee time details', showActions: true });
  var bi = bar.findOne(function (n) { return n.type === 'INSTANCE' && n.name === 'icon' && n.parent && n.parent.name === 'share'; });   // "Booking options": three dots
  if (bi) { try { bi.swapComponent(I.more); recolorIcon(R, bi, '--dark-300'); } catch (e) { /* keep share */ } }
  var S = spjSections(R, scr); bindNumber(R, S.main, 'paddingTop', '--space-4', 4);
  async function txt(parent, style, color, chars, name) { var t = await styledText(R, style, color, chars); parent.appendChild(t); t.name = name; t.textAutoResize = 'HEIGHT'; t.layoutSizingHorizontal = 'FILL'; return t; }
  function divider(p) { var d = DV['type=line'].createInstance(); p.appendChild(d); d.layoutSizingHorizontal = 'FILL'; }
  async function textBtn(parent, label, icon) {   // .btn--s.btn--text: CTA S purple-500 + 14 icon, no padding
    var b = autoFrame('text-button', 'HORIZONTAL', parent); hugHug(b); b.counterAxisAlignItems = 'CENTER'; bindNumber(R, b, 'itemSpacing', '--space-4', 4);
    var t = await styledText(R, '--type-cta-s', '--purple-500', label); b.appendChild(t); t.textAutoResize = 'WIDTH_AND_HEIGHT';
    var i = icon.createInstance(); b.appendChild(i); i.resize(14, 14); return b;
  }
  // 1. head: course (H5), booking number + View golf course, Confirmed badge; divider; kv
  var p1 = await S.page('summary');
  var hd = autoFrame('booking-head', 'HORIZONTAL', p1); fillHug(hd); hd.counterAxisAlignItems = 'MIN'; bindNumber(R, hd, 'itemSpacing', '--space-16', 16);
  var ht = autoFrame('text', 'VERTICAL', hd); ht.layoutSizingHorizontal = 'FILL'; ht.layoutSizingVertical = 'HUG'; bindNumber(R, ht, 'itemSpacing', '--space-4', 4);
  await txt(ht, '--type-h5', '--dark-500', 'Suvarna Jakarta Golf Club', 'title');
  var sub = autoFrame('sub', 'HORIZONTAL', ht); hugHug(sub); sub.counterAxisAlignItems = 'CENTER'; bindNumber(R, sub, 'itemSpacing', '--space-8', 8);
  var st = await styledText(R, '--type-b3', '--dark-300', 'Booking #SW-240915-0381'); sub.appendChild(st); st.textAutoResize = 'WIDTH_AND_HEIGHT';
  await textBtn(sub, 'View golf course', I.chevR);
  var bg = BD['tone=success, appearance=soft, size=s'].createInstance(); hd.appendChild(bg); setText(bg, { label: 'Confirmed' });
  divider(p1);
  var kl = autoFrame('kv-list', 'VERTICAL', p1); fillHug(kl); bindNumber(R, kl, 'itemSpacing', '--space-8', 8);
  [['Date', '16 September 2025'], ['Session', 'Day session'], ['Preferred time', '05:30 - 06:00'], ['Number of players', '3 players']].forEach(function (r) { var i = KV['pay=false'].createInstance(); kl.appendChild(i); i.layoutSizingHorizontal = 'FILL'; setText(i, { key: r[0], value: r[1] }); });
  // 2. players: title + solid 3/3 confirmed badge; list (host open with the paid row, then two paid players); notes (read only) + caption
  var p2 = await S.page('players');
  var sh = autoFrame('section-head', 'HORIZONTAL', p2); fillHug(sh); sh.counterAxisAlignItems = 'CENTER'; bindNumber(R, sh, 'itemSpacing', '--space-8', 8);
  var sht = await styledText(R, '--type-h5', '--dark-300', 'Players'); sh.appendChild(sht); sht.name = 'section-title'; sht.textAutoResize = 'WIDTH_AND_HEIGHT';
  var sb = BD['tone=success, appearance=solid, size=s'].createInstance(); sh.appendChild(sb); setText(sb, { label: '3/3 confirmed' });
  var pl = autoFrame('player-list', 'VERTICAL', p2); fillHug(pl); pl.clipsContent = true; bindRadius(R, pl, '--radius-16', 16);
  pl.fills = paintFor(R, '--light-100'); pl.strokes = paintFor(R, '--light-500'); pl.strokeWeight = 1; pl.strokeAlign = 'INSIDE';
  function item(i) {
    var it = autoFrame('player', 'VERTICAL', pl); fillHug(it); ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].forEach(function (f) { bindNumber(R, it, f, '--space-16', 16); });
    bindNumber(R, it, 'itemSpacing', '--space-8', 8);
    if (i) { it.strokes = paintFor(R, '--light-500'); it.strokeAlign = 'INSIDE'; it.strokeTopWeight = 1; it.strokeRightWeight = 0; it.strokeBottomWeight = 0; it.strokeLeftWeight = 0; }
    return it;
  }
  var h = item(0); var hr = P.player['kind=host'].createInstance(); h.appendChild(hr); hr.layoutSizingHorizontal = 'FILL';
  setText(hr, { name: 'Alvin Lianto (Host)', sub: 'Regular Swing player', price: 'Rp. 4,069,000' });
  var hb = autoFrame('breakdown', 'VERTICAL', h); fillHug(hb); bindNumber(R, hb, 'paddingLeft', '--space-48', 48); bindNumber(R, hb, 'itemSpacing', '--space-4', 4);
  var mr = P.mini['kind=promo'].createInstance(); hb.appendChild(mr); mr.layoutSizingHorizontal = 'FILL';
  setText(mr, { icon: I.tick.id, title: 'Paid on 15 Sep 09:12 PM', sub: 'Suvarna 10% Off (Weekday) applied' });
  [['Budi Santoso', 'BS'], ['Rina Wijaya', 'RW']].forEach(function (x, i) {
    var it = item(i + 1); var r = P.player['kind=player'].createInstance(); it.appendChild(r); r.layoutSizingHorizontal = 'FILL'; setText(r, { name: x[0], sub: 'Paid by host' });
    var av = r.findOne(function (n) { return n.type === 'INSTANCE' && n.name === 'avatar'; }); if (av) setText(av, { initials: x[1] });
  });
  var ib = autoFrame('inputbar', 'HORIZONTAL', p2); ib.counterAxisAlignItems = 'CENTER'; ib.resize(342, 36); ib.layoutSizingHorizontal = 'FILL'; ib.layoutSizingVertical = 'FIXED';
  bindNumber(R, ib, 'paddingLeft', '--space-12', 12); bindNumber(R, ib, 'paddingRight', '--space-12', 12); bindRadius(R, ib, '--radius-8', 8); ib.fills = paintFor(R, '--light-300');
  await txt(ib, '--type-b2', '--dark-200', 'Add notes to Suvarna Jakarta Golf Club...', 'hint');
  var cap = CP['tone=neutral, size=s'].createInstance(); p2.appendChild(cap); cap.layoutSizingHorizontal = 'FILL'; setText(cap, { text: 'Tee time is confirmed, so notes can no longer be edited.' });
  // 3. credits earned + pass strip
  var p3 = await S.page('credits', 'Swing Credits earned');
  var pr = autoFrame('price-rows', 'VERTICAL', p3); fillHug(pr); bindNumber(R, pr, 'itemSpacing', '--space-8', 8);
  var row = P.price['kind=normal'].createInstance(); pr.appendChild(row); row.layoutSizingHorizontal = 'FILL'; setText(row, { label: '2% cashback of Rp. 4,066,000', value: '+81,320' });
  var ps = autoFrame('pass-strip', 'HORIZONTAL', p3); fillHug(ps); ps.counterAxisAlignItems = 'CENTER'; bindNumber(R, ps, 'itemSpacing', '--space-8', 8);
  bindNumber(R, ps, 'paddingTop', '--space-8', 8); bindNumber(R, ps, 'paddingBottom', '--space-8', 8); bindNumber(R, ps, 'paddingLeft', '--space-16', 16); bindNumber(R, ps, 'paddingRight', '--space-16', 16);
  bindRadius(R, ps, '--radius-8', 8); await fillStyle(R, ps, '--gradient-swing-pass', '--purple-500');
  await txt(ps, '--type-b3s', '--light-100', 'Swing Pass members earn up to 5% cashback and save up to 50%', 'text');
  var pci = I.chevW.createInstance(); ps.appendChild(pci); pci.resize(14, 14);
  // 4. terms
  var p4 = await S.page('terms', 'Terms & conditions');
  var cl = await txt(p4, '--type-b3', '--dark-500', 'Please arrive at the clubhouse at least 30 minutes before your tee time to check in. Tee times can be rescheduled up to 24 hours before play, subject to availability. Cancellations made less than 24 hours before the tee time are not refundable. Proper golf attire is required on the course: collared shirt, golf trousers or shorts, and soft-spike golf shoes.', 'clamp-text');
  cl.textTruncation = 'ENDING'; cl.maxLines = 3;
  divider(p4); await textBtn(p4, 'Show more', I.showMore);

  var one = function (m, props) { var i = m.createInstance(); if (props) setText(i, props); return i; };
  await screenList(R, page, scr, 'Booking details', async function (row) {
    await row('AppBar', partSrc('AppBar', PG) + ' · type=adsShare with the icon swapped to more-h (booking options)', [one(appBar['type=adsShare, scrolled=false'], { title: 'Tee time details', showActions: true })]);
    await row('Badge', partSrc('Badge', PG) + ' · success soft s (Confirmed), success solid s (3/3 confirmed)', [one(BD['tone=success, appearance=soft, size=s'], { label: 'Confirmed' }), one(BD['tone=success, appearance=solid, size=s'], { label: '3/3 confirmed' })]);
    await row('KvRow', partSrc('KvRow', PG) + ' · 4 rows', [one(KV['pay=false'])]);
    await row('PlayerRow', partSrc('PlayerRow', PG) + ' · kind=host (open) and kind=player (paid by host)', [one(P.player['kind=host']), one(P.player['kind=player'])]);
    await row('MiniRow', partSrc('MiniRow', PG) + ' · kind=promo with the tick icon (paid)', [one(P.mini['kind=promo'], { icon: I.tick.id, title: 'Paid on 15 Sep 09:12 PM', sub: 'Suvarna 10% Off (Weekday) applied' })]);
    await row('PriceRow', partSrc('PriceRow', PG) + ' · cashback earned', [one(P.price['kind=normal'])]);
    await row('Caption', partSrc('Caption', PG) + ' · tone=neutral, size=s', [one(CP['tone=neutral, size=s'])]);
    await row('Divider', partSrc('Divider', PG) + ' · type=line', [one(DV['type=line'])]);
  });
  notes.push('Booking details: built from stat.chara.id/swing/ref/booking-details.html in its default (confirmed) state. The web renders the page with JS; the "Waiting players" state (?state=waiting) and the Swing Pass view (?pass=1) are not drawn. Text buttons (.swing_btn_text) are CTA S text; the options icon is the DS more-h (the web loads it from /swing/a/, no CORS).');
  return { set: scr, count: 8, label: 'screen from 8 parts' };
}

/* ----- Track my referral (ref/track.html): RefRow ----- */
async function buildRefRowPage(R, notes) {
  var AV = byName(await setFrom('Avatar', 'Avatar', buildAvatarPage, R, notes));
  var BT = byName(await setFrom('Button', 'Button', buildButton, R, notes));
  var page = await pageNamed('Screen / Track');
  var sc = await brandIcon(R, 'swing-credits-icon', 16, notes, page);
  var tick = (await findIcon('Icon/Solid/tick-circle')) || (await iconOrPlaceholder('Icon/Line/tick-circle', page, notes));
  var rr = {};
  var V = [{ booked: 'false', name: 'booked=false' }, { booked: 'true', name: 'booked=true' }];
  return buildPartPage(R, notes, 'RefRow', async function (comp, K, pg, v) {
    // .ref-row: centred, gap 12, 12 / 16, radius 16, light-200; Avatar S; name B2s dark-500, body B3 dark-300; end: Send reminder (Button s tertiary) or reward (credits 16 + B3s purple-500) + tick 16 green-500
    comp.layoutMode = 'HORIZONTAL'; comp.counterAxisAlignItems = 'CENTER'; comp.resize(342, 60); comp.layoutSizingHorizontal = 'FIXED'; comp.layoutSizingVertical = 'HUG';
    bindNumber(R, comp, 'paddingTop', '--space-12', 12); bindNumber(R, comp, 'paddingBottom', '--space-12', 12); bindNumber(R, comp, 'paddingLeft', '--space-16', 16); bindNumber(R, comp, 'paddingRight', '--space-16', 16);
    bindNumber(R, comp, 'itemSpacing', '--space-12', 12); bindRadius(R, comp, '--radius-16', 16); comp.fills = paintFor(R, '--light-200');
    var av = AV['size=s, type=initials'].createInstance(); comp.appendChild(av); av.name = 'avatar';
    var tx = autoFrame('text', 'VERTICAL', comp); tx.layoutSizingHorizontal = 'FILL'; tx.layoutSizingVertical = 'HUG';
    var p = { nm: await K.txt(tx, '--type-b2s', '--dark-500', 'Tio Saputra', 'name', 'fill'), bd: await K.txt(tx, '--type-b3', '--dark-300', 'Joined on 15 May 2026', 'body', 'fill') };
    var end = autoFrame('end', 'HORIZONTAL', comp); hugHug(end); end.counterAxisAlignItems = 'CENTER'; bindNumber(R, end, 'itemSpacing', '--space-8', 8);
    if (v.booked === 'true') {
      var rw = autoFrame('reward', 'HORIZONTAL', end); hugHug(rw); rw.counterAxisAlignItems = 'CENTER'; bindNumber(R, rw, 'itemSpacing', '--space-4', 4);
      var m = sc.createInstance(); rw.appendChild(m); m.name = 'credits'; m.resize(16, 16);
      p.rw = await K.txt(rw, '--type-b3s', '--purple-500', '100,000', 'text');
      var t = tick.createInstance(); end.appendChild(t); t.name = 'done'; t.resize(16, 16); recolorIcon(R, t, '--green-500');
    } else { var b = BT['size=s, tone=primary, appearance=tertiary, state=default'].createInstance(); end.appendChild(b); b.name = 'remind'; setText(b, { label: 'Send reminder', showIconStart: false, showIconEnd: false }); }
    rr[comp.name] = p;
  }, function (s) {
    var P = { nm: ensureProp(s, 'name', 'TEXT', 'Tio Saputra'), bd: ensureProp(s, 'body', 'TEXT', 'Joined on 15 May 2026'), rw: ensureProp(s, 'reward', 'TEXT', '100,000') };
    wireKeys(rr).forEach(function (k) { wireKeys(P).forEach(function (f) { if (rr[k][f]) rr[k][f].componentPropertyReferences = { characters: P[f] }; }); });
    s.description = '<li class="swing_ref_row">avatar + .swing_ref_row__text (name, joined) + .swing_ref_row__end</li> in .swing_ref_list (gap 8). light-200, radius 16, 12 / 16, gap 12. booked=false: Send reminder; booked=true: the reward and a green tick. Set the initials on the nested Avatar.';
  }, { description: 'A referred friend and their status.', variants: V });
}

async function buildTrackScreen(R, notes) {
  var PG = 'Screen / Track', page = await pageNamed(PG);
  var appBar = byName(await setWith('AppBar', 'AppBar', buildAppBarPage, R, notes, 'type=centerCountry, scrolled=false'));
  var CP = byName(await setFrom('Caption', 'Caption', buildCaptionPage, R, notes));
  var SP = byName(await setWith('StatPanel', 'StatPanel', buildStatPanelPage, R, notes, 'zero=false'));
  var RR = byName(await setWith('RefRow', 'RefRow', buildRefRowPage, R, notes, 'booked=true'));
  var search = await iconOrPlaceholder('Icon/Line/search', page, notes);
  var scr = spjScreen(page, 'Track', R);
  var bar = appBar['type=centerCountry, scrolled=false'].createInstance(); scr.appendChild(bar); bar.layoutSizingHorizontal = 'FILL'; setText(bar, { title: 'Track my referral', showActions: true });
  // .appbar__sub 8 / page-x / 16 with the DS .searchbar (36, 0 / 12, radius 8, light-300, search 16 dark-300, B2 hint dark-200)
  var sub = autoFrame('appbar-sub', 'VERTICAL', scr); fillHug(sub); padX(R, sub); bindNumber(R, sub, 'paddingTop', '--space-8', 8); bindNumber(R, sub, 'paddingBottom', '--space-16', 16); sub.fills = paintFor(R, '--light-100');
  var sb = autoFrame('searchbar', 'HORIZONTAL', sub); sb.counterAxisAlignItems = 'CENTER'; sb.resize(342, 36); sb.layoutSizingHorizontal = 'FILL'; sb.layoutSizingVertical = 'FIXED';
  bindNumber(R, sb, 'paddingLeft', '--space-12', 12); bindNumber(R, sb, 'paddingRight', '--space-12', 12); bindNumber(R, sb, 'itemSpacing', '--space-8', 8); bindRadius(R, sb, '--radius-8', 8); sb.fills = paintFor(R, '--light-300');
  var si = search.createInstance(); sb.appendChild(si); si.name = 'icon'; si.resize(16, 16); recolorIcon(R, si, '--dark-300');
  var ph = await styledText(R, '--type-b2', '--dark-200', 'Search your friend\u2019s name here'); sb.appendChild(ph); ph.name = 'hint'; ph.textAutoResize = 'HEIGHT'; ph.layoutSizingHorizontal = 'FILL';
  // .page: 16 / page-x / 32, gap 32
  var pg = autoFrame('page', 'VERTICAL', scr); fillHug(pg); padX(R, pg); bindNumber(R, pg, 'paddingTop', '--space-16', 16); bindNumber(R, pg, 'paddingBottom', '--space-32', 32); bindNumber(R, pg, 'itemSpacing', '--gap-section', 32);
  var st = autoFrame('stats', 'VERTICAL', pg); fillHug(st); st.counterAxisAlignItems = 'CENTER'; bindNumber(R, st, 'itemSpacing', '--gap-related', 8);
  var sp = SP['zero=false'].createInstance(); st.appendChild(sp); sp.layoutSizingHorizontal = 'FILL'; setText(sp, { value1: '3', label1: 'Joined Swing', value2: '1', label2: 'Made first booking' });
  var cap = CP['tone=neutral, size=s'].createInstance(); st.appendChild(cap); setText(cap, { text: 'First booking counts only after status is finished.' });
  var list = autoFrame('ref-list', 'VERTICAL', pg); fillHug(list); bindNumber(R, list, 'itemSpacing', '--space-8', 8);
  [['Tio Saputra', 'TS', '15 May 2026', false], ['Amirul Hadi Wibowo', 'AW', '13 May 2026', false], ['Richard Liking', 'RL', '1 May 2026', true]].forEach(function (f) {
    var r = RR['booked=' + f[3]].createInstance(); list.appendChild(r); r.layoutSizingHorizontal = 'FILL'; setText(r, { name: f[0], body: 'Joined on ' + f[2], reward: '100,000' });
    var av = r.findOne(function (n) { return n.type === 'INSTANCE' && n.name === 'avatar'; }); if (av) setText(av, { initials: f[1] });
  });
  var one = function (m, props) { var i = m.createInstance(); if (props) setText(i, props); return i; };
  await screenList(R, page, scr, 'Track', async function (row) {
    await row('AppBar', partSrc('AppBar', PG) + ' · type=centerCountry', [one(appBar['type=centerCountry, scrolled=false'], { title: 'Track my referral', showActions: true })]);
    await row('StatPanel', partSrc('StatPanel', PG) + ' · zero=false: 3 joined, 1 booked', [one(SP['zero=false'])]);
    await row('Caption', partSrc('Caption', PG) + ' · tone=neutral, size=s', [one(CP['tone=neutral, size=s'])]);
    await row('RefRow', partSrc('RefRow', PG) + ' · booked=false (Send reminder), booked=true (reward)', [one(RR['booked=false']), one(RR['booked=true'])]);
  });
  notes.push('Track: built from stat.chara.id/swing/ref/track.html with its sample friends; the search field shows its hint text only and the no-match state is not drawn.');
  return { set: scr, count: 4, label: 'screen from 4 parts' };
}

/* ----- Tournament questions (ref/tournament-questions.html): player switch, questions with ChoiceRow lists ----- */
var TQ_OPTS = { gender: ['Male', 'Female'], experience: ['Never played golf before', 'Just a beginner and still learning', 'Quite confident at my swing', 'I am a professional golf player'],
  category: ['Pro men', 'Pro women', 'Intermediate men', 'Intermediate men', 'Amateur men', 'Amateur women'], shirt: ['Small (S)', 'Medium (M)', 'Large (L)'],
  score: ['Under 90', '90 - 95', '95 - 100', '100 above'], source: ['Instagram', 'TikTok', 'Friends & families', 'Other'] };
async function buildTournamentQuestionsScreen(R, notes) {
  var PG = 'Screen / Tournament questions', page = await pageNamed(PG);
  var AV = byName(await setFrom('Avatar', 'Avatar', buildAvatarPage, R, notes));
  var BT = byName(await setWith('Button', 'Button', buildButton, R, notes, 'size=s, tone=danger, appearance=tertiary, state=default'));
  var CR = byName(await setWith('ChoiceRow', 'ChoiceRow', buildChoiceRowPage, R, notes, 'selected=true'));
  async function tq(n, size, css) { return refIcon(R, 'tq-' + n, 'ref/img/tq/' + n + '.svg?v=1', size, css || null, notes, page); }
  var I = { prev: await tq('prev', 20, '--dark-100'), next: await tq('next', 20, '--dark-100'), reload: await tq('reload', 14, '--dark-300'), remove: await tq('remove', 14, '--red-500'),
    download: await tq('download', 14, '--purple-500'), upload: await tq('upload', 14, '--light-100'), chev: await tq('chev-down', 20, '--purple-500'), warn: await tq('warning', 16) };
  var scr = spjScreen(page, 'Tournament questions', R);
  var S = spjSections(R, scr); bindNumber(R, S.main, 'paddingTop', '--space-4', 4);
  async function txt(parent, style, color, chars, name) { var t = await styledText(R, style, color, chars); parent.appendChild(t); t.name = name; t.textAutoResize = 'HEIGHT'; t.layoutSizingHorizontal = 'FILL'; return t; }
  async function q(p, text, l) {   // .q-title: H6 dark-300 (--l: H5) + required star red-500
    var t = await txt(p, l ? '--type-h5' : '--type-h6', '--dark-300', text + ' *', 'q-title'); t.setRangeFills(t.characters.length - 1, t.characters.length, paintFor(R, '--red-500')); return t;
  }
  function choices(p, key) {
    var l = autoFrame('choice-list', 'VERTICAL', p); fillHug(l); l.itemSpacing = 0;
    TQ_OPTS[key].forEach(function (o) { var c = CR['selected=false'].createInstance(); l.appendChild(c); c.layoutSizingHorizontal = 'FILL'; setText(c, { label: o }); });
  }
  function btn(parent, tone, appear, label, icon, block) {
    var b = BT['size=s, tone=' + tone + ', appearance=' + appear + ', state=default'].createInstance(); parent.appendChild(b); if (block) b.layoutSizingHorizontal = 'FILL';
    setText(b, { label: label, showIconStart: !!icon, iconStart: icon ? icon.id : undefined, showIconEnd: false }); return b;
  }
  // 1. player switch: 16 / 0, radius 8, light-300; 48 nav buttons (disabled, dark-100); who: Avatar S, name H6, sub B3 (pulled 8 up = 0 gap)
  var p1 = await S.page('player');
  var sw = autoFrame('player-switch', 'HORIZONTAL', p1); fillHug(sw); sw.counterAxisAlignItems = 'CENTER'; bindNumber(R, sw, 'itemSpacing', '--space-8', 8);
  bindNumber(R, sw, 'paddingTop', '--space-16', 16); bindNumber(R, sw, 'paddingBottom', '--space-16', 16); bindRadius(R, sw, '--radius-8', 8); sw.fills = paintFor(R, '--light-300');
  function nav(name, icon) { var n = autoFrame(name, 'HORIZONTAL', sw); n.primaryAxisAlignItems = 'CENTER'; n.counterAxisAlignItems = 'CENTER'; n.resize(48, 48); n.layoutSizingHorizontal = 'FIXED'; n.layoutSizingVertical = 'FIXED'; var i = icon.createInstance(); n.appendChild(i); i.resize(20, 20); }
  nav('prev', I.prev);
  var who = autoFrame('who', 'VERTICAL', sw); who.layoutSizingHorizontal = 'FILL'; who.layoutSizingVertical = 'HUG'; who.counterAxisAlignItems = 'CENTER'; bindNumber(R, who, 'itemSpacing', '--space-8', 8);
  var av = AV['size=s, type=initials'].createInstance(); who.appendChild(av); setText(av, { initials: 'AL' });
  var tw = autoFrame('text', 'VERTICAL', who); fillHug(tw); tw.counterAxisAlignItems = 'CENTER';
  (await txt(tw, '--type-h6', '--dark-500', 'Alvin Lianto (You)', 'name')).textAlignHorizontal = 'CENTER';
  (await txt(tw, '--type-b3', '--dark-300', 'Swing account', 'sub')).textAlignHorizontal = 'CENTER';
  nav('next', I.next);
  var br = autoFrame('btn-row', 'HORIZONTAL', p1); fillHug(br); bindNumber(R, br, 'itemSpacing', '--space-8', 8);
  btn(br, 'muted', 'tertiary', 'Change player', I.reload, true); btn(br, 'danger', 'tertiary', 'Remove player', I.remove, true);
  // 2. scoring template: download (s tertiary block), upload card (24 / 48, line, radius 16, file art 48, Button s with upload)
  var p2 = await S.page('template');
  await q(p2, 'Download, fill, and reupload the scoring template to identify your HCP & player category');
  btn(p2, 'primary', 'tertiary', 'Download template', I.download, true);
  var uc = autoFrame('upload-card', 'VERTICAL', p2); fillHug(uc); uc.counterAxisAlignItems = 'CENTER'; bindNumber(R, uc, 'itemSpacing', '--space-16', 16);
  bindNumber(R, uc, 'paddingTop', '--space-24', 24); bindNumber(R, uc, 'paddingBottom', '--space-24', 24); bindNumber(R, uc, 'paddingLeft', '--space-48', 48); bindNumber(R, uc, 'paddingRight', '--space-48', 48);
  bindRadius(R, uc, '--radius-16', 16); uc.strokes = paintFor(R, '--light-500'); uc.strokeWeight = 1; uc.strokeAlign = 'INSIDE';
  await refArt(R, uc, 'ref/img/tq/file-ui.svg?v=1', 48, 48, 'art', notes);
  btn(uc, 'primary', 'solid', 'Upload file here', I.upload, false);
  var p3 = await S.page('gender'); await q(p3, 'What is your gender?'); choices(p3, 'gender');
  // birthday: .inputbar--l.inputbar--select: 48, 0 / 12, radius 8, light-300, B2 purple-500 + chevron 20
  var p4 = await S.page('birthday'); await q(p4, 'When is your birthday?');
  var sel = autoFrame('inputbar', 'HORIZONTAL', p4); sel.counterAxisAlignItems = 'CENTER'; sel.primaryAxisAlignItems = 'SPACE_BETWEEN'; sel.resize(342, 48); sel.layoutSizingHorizontal = 'FILL'; sel.layoutSizingVertical = 'FIXED';
  bindNumber(R, sel, 'paddingLeft', '--space-12', 12); bindNumber(R, sel, 'paddingRight', '--space-12', 12); bindRadius(R, sel, '--radius-8', 8); sel.fills = paintFor(R, '--light-300');
  var st = await styledText(R, '--type-b2', '--purple-500', 'Select birth date'); sel.appendChild(st); st.textAutoResize = 'WIDTH_AND_HEIGHT';
  var ci = I.chev.createInstance(); sel.appendChild(ci); ci.resize(20, 20);
  var p5 = await S.page('experience'); await q(p5, 'How experienced are you in golf?'); choices(p5, 'experience');
  var p6 = await S.page('category'); await q(p6, 'What is your category?'); choices(p6, 'category');
  // shirt: orange B3s caption, two size images (radius 8), choices
  var p7 = await S.page('shirt'); await q(p7, 'Select shirt size');
  var cp = autoFrame('caption', 'HORIZONTAL', p7); fillHug(cp); cp.counterAxisAlignItems = 'MIN'; bindNumber(R, cp, 'itemSpacing', '--space-8', 8);
  var wi = I.warn.createInstance(); cp.appendChild(wi); wi.resize(16, 16);
  await txt(cp, '--type-b3s', '--orange-500', 'Shirt size is gender sensitive. Please select a gender first to be able to select your shirt size', 'text');
  for (var si = 1; si <= 2; si++) { var im = figma.createRectangle(); p7.appendChild(im); im.name = 'q-image'; im.resize(342, si === 1 ? Math.round(342 * 323 / 327) : 342); im.layoutSizingHorizontal = 'FILL'; bindRadius(R, im, '--radius-8', 8); await refPhoto(R, im, 'ref/img/tq/shirt-' + si + '.jpg?v=1', notes); }
  choices(p7, 'shirt');
  var p8 = await S.page('instagram'); await q(p8, 'What is your Instagram account?', true);
  var ib = autoFrame('inputbar', 'HORIZONTAL', p8); ib.counterAxisAlignItems = 'CENTER'; ib.resize(342, 48); ib.layoutSizingHorizontal = 'FILL'; ib.layoutSizingVertical = 'FIXED';
  bindNumber(R, ib, 'paddingLeft', '--space-12', 12); bindNumber(R, ib, 'paddingRight', '--space-12', 12); bindRadius(R, ib, '--radius-8', 8); ib.fills = paintFor(R, '--light-300');
  await txt(ib, '--type-b2', '--dark-200', 'Your answer', 'hint');
  var p9 = await S.page('score'); await q(p9, 'Average score on the golf course in the last 1-2 months', true); choices(p9, 'score');
  var p10 = await S.page('source'); await q(p10, 'How do you know about Golftrovert?', true); choices(p10, 'source');
  var one = function (m, props) { var i = m.createInstance(); if (props) setText(i, props); return i; };
  await screenList(R, page, scr, 'Tournament questions', async function (row) {
    await row('Avatar', partSrc('Avatar', PG) + ' · size=s initials in the player switch', [one(AV['size=s, type=initials'], { initials: 'AL' })]);
    await row('ChoiceRow', partSrc('ChoiceRow', PG) + ' · every answer list, none picked yet', [one(CR['selected=false']), one(CR['selected=true'])]);
    await row('Button', partSrc('Button', PG) + ' · s tertiary muted / danger / primary block, s solid upload', [one(BT['size=s, tone=muted, appearance=tertiary, state=default'], { label: 'Change player' }), one(BT['size=s, tone=danger, appearance=tertiary, state=default'], { label: 'Remove player' })]);
  });
  notes.push('Tournament questions: built from stat.chara.id/swing/ref/tournament-questions.html (no app bar, as on the web: it opens inside the tournament flow). The duplicated "Intermediate men" option is in the source and kept.');
  return { set: scr, count: 3, label: 'screen from 3 parts' };
}

/* ----- Tournament registration confirmation (ref/tournament-confirm.html): package card with player slots, price details, pay bar ----- */
async function buildTournamentConfirmScreen(R, notes) {
  var PG = 'Screen / Tournament confirm', page = await pageNamed(PG);
  var appBar = byName(await setWith('AppBar', 'AppBar', buildAppBarPage, R, notes, 'type=ads, scrolled=false'));
  var BT = byName(await setFrom('Button', 'Button', buildButton, R, notes));
  var DV = byName(await setFrom('Divider', 'Divider', buildDividerPage, R, notes));
  var KV = byName(await setWith('KvRow', 'KvRow', buildKvRowPage, R, notes, 'pay=true'));
  var PM = byName(await setWith('PayMethod', 'PayMethod', buildPayMethodPage, R, notes, 'type=action'));
  var P = { player: byName(await setWith('PlayerRow', 'PlayerRow', buildPlayerRowPage, R, notes, 'kind=player')), mini: byName(await setWith('MiniRow', 'MiniRow', buildMiniRowPage, R, notes, 'kind=error')),
    price: byName(await setWith('PriceRow', 'PriceRow', buildPriceRowPage, R, notes, 'kind=sub')), bar: await setFrom('PayBar', 'PayBar', buildPayBarPage, R, notes) };
  var I = { ref: await tcArt(R, 'referral', 16, notes, '--dark-500'), edit: await tcArt(R, 'edit', 14, notes, '--purple-500'), add: await tcArt(R, 'add', 14, notes, '--purple-500'),
    more: await tcArt(R, 'show-more', 14, notes, '--purple-500'), info: await tcArt(R, 'info', 16, notes, '--dark-200'), ovo: await refLogo(R, 'ovo', 'ref/img/sp/ovo.png?v=1', 22, 22, notes, await pageNamed(SPJ_PAGE)) };
  var scr = spjScreen(page, 'Tournament confirm', R);
  var bar = appBar['type=ads, scrolled=false'].createInstance(); scr.appendChild(bar); bar.layoutSizingHorizontal = 'FILL'; setText(bar, { title: 'Registration confirmation', showActions: false });
  var S = spjSections(R, scr); bindNumber(R, S.main, 'paddingTop', '--space-4', 4);
  async function txt(parent, style, color, chars, name) { var t = await styledText(R, style, color, chars); parent.appendChild(t); t.name = name; t.textAutoResize = 'HEIGHT'; t.layoutSizingHorizontal = 'FILL'; return t; }
  function divider(p) { var d = DV['type=line'].createInstance(); p.appendChild(d); d.layoutSizingHorizontal = 'FILL'; }
  async function textBtn(parent, label, icon, lead) {
    var b = autoFrame('text-button', 'HORIZONTAL', parent); hugHug(b); b.counterAxisAlignItems = 'CENTER'; bindNumber(R, b, 'itemSpacing', '--space-4', 4);
    var i = icon.createInstance(); i.resize(14, 14);
    var t = await styledText(R, '--type-cta-s', '--purple-500', label); t.textAutoResize = 'WIDTH_AND_HEIGHT';
    if (lead) { b.appendChild(i); b.appendChild(t); } else { b.appendChild(t); b.appendChild(i); }
    return b;
  }
  // 1. event, kv, Edit packages, package card, notes
  var p1 = await S.page('event');
  await txt(p1, '--type-h5', '--dark-500', 'VIVO Golf for Play Golf Staycation', 'title'); divider(p1);
  var kl = autoFrame('kv-list', 'VERTICAL', p1); fillHug(kl); bindNumber(R, kl, 'itemSpacing', '--space-8', 8);
  [['Date', '07 July 2023'], ['Starting time', 'Semi shotgun 12:30 PM'], ['Venue', 'Rainbow Hills Golf'], ['Players', '4 players']].forEach(function (r) { var i = KV['pay=false'].createInstance(); kl.appendChild(i); i.layoutSizingHorizontal = 'FILL'; setText(i, { key: r[0], value: r[1] }); });
  var eb = BT['size=s, tone=primary, appearance=tertiary, state=default'].createInstance(); p1.appendChild(eb); eb.layoutSizingHorizontal = 'FILL'; setText(eb, { label: 'Edit packages', showIconStart: false, showIconEnd: false });
  // .package-card: clip, line, radius 16, purple-50; head 16, gap 8 (referral 16, title B3s, edit 14 purple-500); body: clip, line, radius 16, white;
  // groups 8 / 16 light-300 B3s dark-300 (name + count), slots 16, gap 8
  var pc = autoFrame('package-card', 'VERTICAL', p1); fillHug(pc); pc.clipsContent = true; bindRadius(R, pc, '--radius-16', 16);
  pc.fills = paintFor(R, '--purple-50'); pc.strokes = paintFor(R, '--light-500'); pc.strokeWeight = 1; pc.strokeAlign = 'INSIDE';
  var ph = autoFrame('head', 'HORIZONTAL', pc); fillHug(ph); ph.counterAxisAlignItems = 'CENTER'; bindNumber(R, ph, 'itemSpacing', '--space-8', 8);
  ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].forEach(function (f) { bindNumber(R, ph, f, '--space-16', 16); });
  var ri = I.ref.createInstance(); ph.appendChild(ri); ri.resize(16, 16);
  await txt(ph, '--type-b3s', '--dark-500', 'Standard registration', 'title');
  var ed = I.edit.createInstance(); ph.appendChild(ed); ed.name = 'edit'; ed.resize(14, 14);
  var pb = autoFrame('body', 'VERTICAL', pc); fillHug(pb); pb.clipsContent = true; bindRadius(R, pb, '--radius-16', 16);
  pb.fills = paintFor(R, '--light-100'); pb.strokes = paintFor(R, '--light-500'); pb.strokeWeight = 1; pb.strokeAlign = 'INSIDE';
  async function group(name, count) {
    var g = autoFrame('group', 'HORIZONTAL', pb); fillHug(g); g.primaryAxisAlignItems = 'SPACE_BETWEEN'; bindNumber(R, g, 'itemSpacing', '--space-8', 8);
    bindNumber(R, g, 'paddingTop', '--space-8', 8); bindNumber(R, g, 'paddingBottom', '--space-8', 8); bindNumber(R, g, 'paddingLeft', '--space-16', 16); bindNumber(R, g, 'paddingRight', '--space-16', 16);
    g.fills = paintFor(R, '--light-300');
    var a = await styledText(R, '--type-b3s', '--dark-300', name); g.appendChild(a); a.textAutoResize = 'WIDTH_AND_HEIGHT';
    var b = await styledText(R, '--type-b3s', '--dark-300', count); g.appendChild(b); b.textAutoResize = 'WIDTH_AND_HEIGHT';
  }
  function slot() { var s0 = autoFrame('slot', 'VERTICAL', pb); fillHug(s0); ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].forEach(function (f) { bindNumber(R, s0, f, '--space-16', 16); }); bindNumber(R, s0, 'itemSpacing', '--space-8', 8); s0.fills = paintFor(R, '--light-100'); return s0; }
  await group('Single Package', '1 player');
  var s1 = slot(); var hr = P.player['kind=host'].createInstance(); s1.appendChild(hr); hr.layoutSizingHorizontal = 'FILL';
  setText(hr, { name: 'Alvin Lianto (Host)', sub: 'Swing Pass member', price: 'Rp. 1,100,000' });
  var hs = hr.findOne(function (n) { return n.type === 'TEXT' && n.name === 'sub'; }); if (hs) await fillStyle(R, hs, '--gradient-swing-pass', '--purple-500');   // .player-row__sub: gradient text
  var bd = autoFrame('breakdown', 'VERTICAL', s1); fillHug(bd); bindNumber(R, bd, 'paddingLeft', '--space-48', 48); bindNumber(R, bd, 'itemSpacing', '--space-4', 4);
  [['kind=promo', { title: 'Rp. 200,000 off on VIVO Golf for Play Golf Staycation', sub: 'The best promo auto applied!' }], ['kind=credits', null], ['kind=error', { title: 'Fill in player details' }]].forEach(function (x) {
    var m = P.mini[x[0]].createInstance(); bd.appendChild(m); m.layoutSizingHorizontal = 'FILL'; if (x[1]) setText(m, x[1]);
  });
  await group('Single Package + Stay Over', '1 player'); await textBtn(slot(), 'Add a player', I.add, true);
  await group('Couple Package + Stay Over', '2 players'); await textBtn(slot(), 'Add a player', I.add, true);
  var ib = autoFrame('inputbar', 'HORIZONTAL', p1); ib.counterAxisAlignItems = 'CENTER'; ib.resize(342, 36); ib.layoutSizingHorizontal = 'FILL'; ib.layoutSizingVertical = 'FIXED';
  bindNumber(R, ib, 'paddingLeft', '--space-12', 12); bindNumber(R, ib, 'paddingRight', '--space-12', 12); bindRadius(R, ib, '--radius-8', 8); ib.fills = paintFor(R, '--light-300');
  await txt(ib, '--type-b2', '--dark-200', 'Add notes to IXI Sports & Leisure...', 'hint');
  // 2. terms + B3s caption (dark-200, info 16, gap 8)
  var p2 = await S.page('terms', 'Terms & conditions');
  var cl = await txt(p2, '--type-b3', '--dark-500', 'L\u00f6rem ipsum sopotengen on ism de intraktigt. Plaminde plattfilm i Zoombombning dosask jag tegen. Pom\u00e4ktig biosk, diskap. Rer faktig keheten. Megab\u00e5jur bess, biomynegt. Astrosion astrokaktig homohasesk inenera. Pona myr soning hexasa bloggare. Difybel pos.', 'clamp-text');
  cl.textTruncation = 'ENDING'; cl.maxLines = 3;
  divider(p2); await textBtn(p2, 'Show more', I.more, false);
  var cp = autoFrame('caption', 'HORIZONTAL', p2); fillHug(cp); cp.counterAxisAlignItems = 'MIN'; bindNumber(R, cp, 'itemSpacing', '--space-8', 8);
  var ci = I.info.createInstance(); cp.appendChild(ci); ci.resize(16, 16);
  await txt(cp, '--type-b3s', '--dark-200', 'By tapping the \u201cPay now\u201d button, you are agreeing to the terms & conditions of the event.', 'text');
  // 3. price details
  var p3 = await S.page('price', 'Price details');
  var pr = autoFrame('price-rows', 'VERTICAL', p3); fillHug(pr); bindNumber(R, pr, 'itemSpacing', '--space-8', 8);
  [['Alvin Lianto (Host)', 'Single Package', 'Rp. 1,100,000'], ['Player 2', 'Single Package + Stay Over', 'Rp. 2,970,000'], ['Player 3', 'Couple Package + Stay Over (1/2)', 'Rp. 2,085,000'], ['Player 4', 'Couple Package + Stay Over (2/2)', 'Rp. 2,085,000']].forEach(function (r) {
    var i = P.price['kind=sub'].createInstance(); pr.appendChild(i); i.layoutSizingHorizontal = 'FILL'; setText(i, { label: r[0], sub: r[1], value: r[2] });
  });
  var fee = P.price['kind=info'].createInstance(); pr.appendChild(fee); fee.layoutSizingHorizontal = 'FILL'; setText(fee, { label: 'Processing fee', value: 'Rp. 3,000' });
  divider(p3);
  var tot = P.price['kind=total'].createInstance(); p3.appendChild(tot); tot.layoutSizingHorizontal = 'FILL'; setText(tot, { label: 'Total payment', value: 'Rp. 8,243,000' });
  var pm = PM['type=action'].createInstance(); p3.appendChild(pm); pm.layoutSizingHorizontal = 'FILL'; setText(pm, { icon: I.ovo.id, name: 'OVO' });
  var pmb = pm.findOne(function (n) { return n.type === 'INSTANCE' && n.name === 'action'; }); if (pmb) setText(pmb, { label: 'Change' });
  var bb = autoFrame('bottom-bar', 'VERTICAL', scr); fillHug(bb); padX(R, bb); bindNumber(R, bb, 'paddingTop', '--space-16', 16); bindNumber(R, bb, 'paddingBottom', '--space-32', 32);
  bb.fills = paintFor(R, '--light-100'); var up = lineBelow(R)[0]; if (up) bb.effects = [Object.assign({}, up, { offset: { x: 0, y: -1 } })];
  var pyb = P.bar.children[0].createInstance(); bb.appendChild(pyb); pyb.layoutSizingHorizontal = 'FILL'; setText(pyb, { amount: 'Rp. 8,243,000', earn: '+1,264,000 for all' });
  var pbt = pyb.findOne(function (n) { return n.type === 'INSTANCE' && n.name === 'pay'; }); if (pbt) setText(pbt, { label: 'Pay now' });
  var one = function (m, props) { var i = m.createInstance(); if (props) setText(i, props); return i; };
  await screenList(R, page, scr, 'Tournament confirm', async function (row) {
    await row('AppBar', partSrc('AppBar', PG) + ' · type=ads, no actions', [one(appBar['type=ads, scrolled=false'], { title: 'Registration confirmation', showActions: false })]);
    await row('KvRow', partSrc('KvRow', PG) + ' · 4 rows', [one(KV['pay=false'])]);
    await row('PlayerRow', partSrc('PlayerRow', PG) + ' · kind=host (Swing Pass member, gradient sub)', [one(P.player['kind=host'])]);
    await row('MiniRow', partSrc('MiniRow', PG) + ' · kind=promo, credits, error (Fill in player details)', [one(P.mini['kind=promo']), one(P.mini['kind=credits']), one(P.mini['kind=error'])]);
    await row('PriceRow', partSrc('PriceRow', PG) + ' · kind=sub (player + package), info, total', [one(P.price['kind=sub']), one(P.price['kind=info']), one(P.price['kind=total'])]);
    await row('PayMethod', partSrc('PayMethod', PG) + ' · type=action, OVO + Change', [one(PM['type=action'], { icon: I.ovo.id, name: 'OVO' })]);
    await row('Divider', partSrc('Divider', PG) + ' · type=line', [one(DV['type=line'])]);
    await row('PayBar', partSrc('PayBar', PG) + ' · Pay now', [P.bar.children[0].createInstance()]);
  });
  notes.push('Tournament confirm: built from stat.chara.id/swing/ref/tournament-confirm.html. The package card, its groups and the B3s caption are plain layers (only this screen has them); "Add a player" and "Show more" are .swing_btn_text (CTA S text); the host\'s Swing Pass sub is gradient text via the paint style.');
  return { set: scr, count: 8, label: 'screen from 8 parts' };
}

var COMPONENTS = { Color: buildColorPage, Typography: buildTypographyPage, Button: buildButton, Badge: buildBadgePage, Tag: buildTagPage,
  Checkbox: buildCheckboxPage, Radio: buildRadioPage, Switch: buildSwitchPage, Check: buildCheckPage, TextField: buildTextFieldPage,
  Select: buildSelectPage, Menu: buildMenuPage, List: buildListPage, Tabs: buildTabsPage,
  Divider: buildDividerPage, Avatar: buildAvatarPage, Caption: buildCaptionPage,
  Pagination: buildPaginationPage, Rating: buildRatingPage, Stepper: buildStepperPage,
  Pin: buildPinPage, Slider: buildSliderPage,
  Toaster: buildToasterPage, Tooltip: buildTooltipPage,
  Steps: buildStepsPage, Review: buildReviewPage,
  BottomNav: buildBottomNavPage, AppBar: buildAppBarPage,
  Card: buildCardPage, ActionCard: buildActionCardPage, FeaturedPromo: buildFeaturedPromoPage, CashbackTable: buildCashbackTablePage,
  CourseCard: buildCourseCardPage, Sheet: buildSheetPage,
  Search: buildSearchPage, DatePicker: buildDatePickerPage, TimePicker: buildTimePickerPage,
  SwingPass: buildSwingPassPage, Accordion: buildAccordionPage,
  PhotoTile: buildPhotoTilePage, PassUpsell: buildPassUpsellPage, SectionHead: buildSectionHeadPage, ProductCard: buildProductCardPage,
  PromoBanner: buildPromoBannerPage, HelpCard: buildHelpCardPage, LinkCard: buildLinkCardPage,
  ProfileHead: buildProfileHeadPage, NotifRow: buildNotifRowPage,
  CreditCard: buildCreditCardPage, AdsRow: buildAdsRowPage, RewardCard: buildRewardCardPage, AskBox: buildAskBoxPage, MailFoot: buildMailFootPage, CodeCard: buildCodeCardPage, StatPanel: buildStatPanelPage, StepCard: buildStepCardPage, FaqItem: buildFaqItemPage, CodeHero: buildCodeHeroPage, KvRow: buildKvRowPage, PassCard: buildPassCardPage, SaveCard: buildSaveCardPage, PayMethod: buildPayMethodPage, DealCard: buildDealCardPage, Perk: buildPerkPage, EventsHead: buildEventsHeadPage, EventCard: buildEventCardPage, HostCta: buildHostCtaPage, PromoCard: buildPromoCardPage, CreditStrip: buildCreditStripPage, InfoTile: buildInfoTilePage, Venue: buildVenuePage, BrandCard: buildBrandCardPage, NoteBar: buildNoteBarPage, MethodRow: buildMethodRowPage, Plan: buildPlanPage, ChoiceRow: buildChoiceRowPage, BillRow: buildBillRowPage, DateBtn: buildDateBtnPage, SessionTab: buildSessionTabPage, RateCard: buildRateCardPage, InclItem: buildInclItemPage, Amenity: buildAmenityPage, StatTile: buildStatTilePage, PayType: buildPayTypePage, PlayerRow: buildPlayerRowPage, MiniRow: buildMiniRowPage, PriceRow: buildPriceRowPage, PayBar: buildPayBarPage, RefRow: buildRefRowPage,
  Home: buildHomeScreen, Account: buildAccountScreen, Updates: buildUpdatesScreen, SwingCredits: buildSwingCreditsScreen, CreditsHistory: buildCreditsHistoryScreen, PersonalInfo: buildPersonalInfoScreen, VerifyEmail: buildVerifyEmailScreen, ReferEarn: buildReferEarnScreen, IgStory: buildIgStoryScreen, SwingPassEmail: buildSwingPassEmailScreen, SwingPassPage: buildSwingPassPageScreen, SwingPassMember: buildSwingPassMemberScreen, SwingPassEvents: buildSwingPassEventsScreen, TeeTime: buildTeeTimeScreen, SwingPassEvent: buildSwingPassEventScreen, SwingPassJoin: buildSwingPassJoinScreen, SwingPassBilling: buildSwingPassBillingScreen, SwingPassOnetime: buildSwingPassOnetimeScreen, SwingPassQris: buildSwingPassQrisScreen, SwingPassWaiting: buildSwingPassWaitingScreen, SwingPassSuccess: buildSwingPassSuccessScreen, SwingPassSuccessOnetime: buildSwingPassSuccessOnetimeScreen, SwingPassCancel: buildSwingPassCancelScreen, SwingPassHistory: buildSwingPassHistoryScreen, GolfCourse: buildGolfCourseScreen, Booking: buildBookingScreen, BookingDetails: buildBookingDetailsScreen, Track: buildTrackScreen, TournamentQuestions: buildTournamentQuestionsScreen, TournamentConfirm: buildTournamentConfirmScreen };
var SCREENS = { Home: true, Account: true, Updates: true, SwingCredits: true, CreditsHistory: true, PersonalInfo: true, VerifyEmail: true, ReferEarn: true, IgStory: true, SwingPassEmail: true, SwingPassPage: true, SwingPassMember: true, SwingPassEvents: true, TeeTime: true, SwingPassEvent: true, SwingPassJoin: true, SwingPassBilling: true, SwingPassOnetime: true, SwingPassQris: true, SwingPassWaiting: true, SwingPassSuccess: true, SwingPassSuccessOnetime: true, SwingPassCancel: true, SwingPassHistory: true, GolfCourse: true, Booking: true, BookingDetails: true, Track: true, TournamentQuestions: true, TournamentConfirm: true };   // builders that only place instances: the ones a library file may run

async function buildComponents(names) {
  var R = await loadRegistry(), notes = [], built = [], errors = [];
  LIB = null; LIB_CACHE = {};
  if (!Object.keys(R.vars).length) {
    // No local tokens: this is a file that uses the DS as a library. Only screens are built here.
    var keys = await figma.clientStorage.getAsync('libKeys');
    if (!keys || !keys.sets) return { built: [], notes: [], errors: ['No tokens in this file and no library keys yet. Import the tokens here, or open the plugin in the DS file and run Export library keys.'], missing: [] };
    names.filter(function (n) { return !SCREENS[n] && !UI_PARTS[n]; }).forEach(function (n) {
      errors.push(n + ': this file uses the ' + keys.file + ' library, so DS pages are built in that file, not here. Only UI components and screens are built here.');
    });
    names = names.filter(function (n) { return SCREENS[n] || UI_PARTS[n]; });
    LIB = keys;
    if (names.length) figma.ui.postMessage({ type: 'build-page', page: names[0], index: 0, count: names.length });
    try {
      R = await loadLibraryRegistry(keys, function (done, total) {
        figma.ui.postMessage({ type: 'build-progress', set: 'Library tokens', done: done, total: total, phase: 'variants' });
      });
    } catch (e) { LIB = null; return { built: [], notes: [], errors: errors.concat(e.message), missing: [] }; }
    notes.push('Library mode: parts come from ' + keys.file + ' (keys exported ' + new Date(keys.at).toLocaleString() + '). After changing the DS, publish it and run Export library keys there again.');
    if (R.failed) notes.push(R.failed + (R.failed === 1 ? ' library variable or style' : ' library variables or styles') + ' could not be imported (' + R.failedNames.join(', ') + (R.failed > R.failedNames.length ? ', …' : '') + ')' + (R.timedOut ? ', ' + R.timedOut + ' did not answer' : '') + '. Usually it was added to the DS after the last publish: publish again, then Export library keys.');
  }
  try {
    for (var i = 0; i < names.length; i++) {
      figma.ui.postMessage({ type: 'build-page', page: names[i], index: i, count: names.length });
      try {
        var r = await COMPONENTS[names[i]](R, notes);
        built.push(names[i] + ' (' + (r.label || r.count + ' variants') + ')');
        var rs = firstSetOf(r.set), pg = rs.parent; while (pg && pg.type !== 'PAGE') pg = pg.parent;
        await figma.setCurrentPageAsync(pg);
        figma.viewport.scrollAndZoomIntoView([rs.parent && rs.parent.type === 'FRAME' ? rs.parent : rs]);
      } catch (e) { errors.push(names[i] + ': ' + e.message); }
    }
  } finally { LIB = null; }
  return { built: built, notes: notes, errors: errors, missing: Object.keys(R.missing) };
}

/* ================= send to web (Figma variables -> tokens.css draft) ================= */

function cssHex(c) {
  function h(x) { var v = Math.round(clamp01(x) * 255).toString(16); return v.length < 2 ? '0' + v : v; }
  var s = '#' + h(c.r) + h(c.g) + h(c.b);
  if (c.a != null && c.a < 0.998) s += h(c.a);
  return s.toUpperCase();
}
function sameColor(a, b) {
  return ['r', 'g', 'b', 'a'].every(function (k) {
    var x = a[k] == null ? 1 : a[k], y = b[k] == null ? 1 : b[k];
    return Math.abs(x - y) < 0.6 / 255;
  });
}
// A Figma number written back in the unit the web value uses (px, rem, em-for-tracking, or none).
function cssNumber(n, webResolved, track) {
  var u = (String(webResolved).trim().match(/(px|rem|em)$/i) || [''])[0].toLowerCase();
  var r = function (x, d) { var p = Math.pow(10, d); return Math.round(x * p) / p; };
  if (track || u === 'em') return n === 0 ? '0' : r(n / 100, 4) + 'em';
  if (u === 'rem') return r(n / 16, 4) + 'rem';
  if (u === 'px') return r(n, 3) + 'px';
  return String(r(n, 3));
}

// Compare this file's local variables with the live tokens.css. Only plain tokens can go back:
// a hex color, a px/rem/em number, or an alias to another token. Everything else is listed as skipped.
async function syncDiff(css, collection) {
  var plan = analyze(css), T = readTokens(css), mode0 = plan.modes[0];
  var out = { changes: [], skipped: [], checked: 0, file: figma.root.name };
  var cols = await figma.variables.getLocalVariableCollectionsAsync();
  var col = cols.filter(function (c) { return c.name === collection; })[0];
  if (!col) { out.error = 'This file has no local "' + collection + '" collection. Send changes from the DS library file, where the tokens were imported.'; return out; }
  var mode = col.modes.filter(function (x) { return x.name === mode0; })[0] || col.modes[0];
  var vars = await Promise.all(col.variableIds.map(function (id) { return figma.variables.getVariableByIdAsync(id); }));
  var byKey = {}, keyOfId = {}, byId = {};
  vars.forEach(function (v) {
    if (!v) return;
    byId[v.id] = v;
    var k = (v.description || '').split('\n')[0];
    if (/^--/.test(k)) { byKey[k] = v; keyOfId[v.id] = k; }
  });
  function figColor(v, depth) {   // the color a variable shows, following aliases
    var x = v && v.valuesByMode[mode.modeId];
    if (!x || depth > 8) return null;
    if (x.type === 'VARIABLE_ALIAS') return figColor(byId[x.id], depth + 1);
    return x.r != null ? x : null;
  }
  function webColor(raw) { var c = parseColor(resolve(T, raw, 'Default').trim()); return c ? cssHex(c) : null; }

  plan.variables.forEach(function (t) {
    var v = byKey[t.key];
    if (!v) return;
    var side = t.key !== t.css || t.key.indexOf(':') >= 0;   // a shorthand side, or a text style's own size / line height / paragraph spacing
    var raw = side ? '' : (lookup(T, t.css, 'Default') || '').trim();
    var fv = v.valuesByMode[mode.modeId];
    if (fv == null) return;
    out.checked++;
    var web = t.values[mode0] || {}, nv;
    var sideSkip = function () {
      var part = t.key.split(':');
      out.skipped.push({ name: part[0], why: (/^(top|right|bottom|left|x|y)$/.test(part[1]) ? 'The ' + part[1] + ' side of a shorthand' : 'The ' + part[1] + ' of this text style') + '. Change it in tokens.css.' });
    };
    if (fv.type === 'VARIABLE_ALIAS') {
      var tk = keyOfId[fv.id];
      if (!tk) { out.skipped.push({ name: t.css, why: 'Points to a variable that is not a token.' }); return; }
      if (web.alias === tk) return;
      if (side) { sideSkip(); return; }
      nv = 'var(' + tk + ')';
    } else if (t.type === 'COLOR') {
      if (!web.alias && web.value && sameColor(web.value, fv)) return;
      nv = cssHex(fv);
    } else if (t.type === 'FLOAT') {
      if (!web.alias && web.value != null && Math.abs(web.value - fv) < 0.0005) return;
      if (side) { sideSkip(); return; }
      var res = resolve(T, raw, 'Default').trim();
      if (!aliasOf(raw) && !/^-?\d*\.?\d+(px|rem|em)?$/i.test(raw)) { out.skipped.push({ name: t.css, why: 'On the web this is ' + raw + '. Change it in tokens.css.' }); return; }
      nv = /^--opacity-/.test(t.css) ? String(Math.round(fv / 100 * 10000) / 10000)   // Figma 50 -> CSS 0.5
        : cssNumber(fv, res, /(^--|-)(track|tracking|letter-spacing)-/.test(t.css));
    } else {
      if (!web.alias && web.value === fv) return;
      out.skipped.push({ name: t.css, why: 'Font family: change it in tokens.css.' });
      return;
    }
    if (nv === raw) return;
    var ch = { name: t.css, old: raw, new: nv, type: t.type };
    if (t.type === 'COLOR') { ch.oldColor = webColor(raw); var fc = figColor(v, 0); ch.newColor = fc ? cssHex(fc) : null; }
    out.changes.push(ch);
  });
  return out;
}

/* ================= UI bridge ================= */

// What this file already has, so the UI can show each step as done or not.
async function fileStatus() {
  var R = await loadRegistry(), out = { vars: Object.keys(R.vars).length, text: Object.keys(R.text).length,
    effects: Object.keys(R.effects).length, icons: { line: 0, solid: 0 }, sets: [], lib: null };
  var lk = await figma.clientStorage.getAsync('libKeys');
  if (lk && lk.sets) out.lib = { file: lk.file, at: lk.at, sets: Object.keys(lk.sets).length, names: Object.keys(lk.logical || {}).concat(Object.keys(lk.sets)),
    tokens: ['vars', 'text', 'effects', 'paints'].reduce(function (a, k) { return a + Object.keys(lk[k] || {}).length; }, 0) };
  for (var i = 0; i < figma.root.children.length; i++) {
    var pg = figma.root.children[i];
    var screen = /^Screen \/ /.test(pg.name);
    if (!screen && ['Color', 'Typography', 'Icons', 'Button', 'Badge', 'Tag', 'Loading', 'Checkbox', 'Radio', 'Switch', 'Check', 'TextField', 'Select', 'Menu', 'List', 'Tabs', 'Divider', 'Avatar', 'Caption', 'Pagination', 'Rating', 'Stepper', 'Pin', 'Slider', 'Toaster', 'Tooltip', 'Steps', 'Review', 'BottomNav', 'AppBar', 'Card', 'ActionCard', 'FeaturedPromo', 'CashbackTable', 'CourseCard', 'Sheet', 'Search', 'DatePicker', 'TimePicker', 'SwingPass', 'Accordion', 'PhotoTile', 'PassUpsell', 'SectionHead', 'ProductCard', 'PromoBanner', 'HelpCard', 'LinkCard'].indexOf(pg.name) < 0) continue;
    await pg.loadAsync();
    if (screen) {   // a screen counts as built when its frame is there
      var sn = pg.name.slice('Screen / '.length);
      if (pg.children.some(function (n) { return n.type === 'FRAME' && n.name === sn; })) out.sets.push('screen:' + sn);
      pg.findAllWithCriteria({ types: ['COMPONENT_SET'] }).forEach(function (s) { var b = setTag(s).logical || s.name.split('/').pop(); if (UI_PARTS[b] && out.sets.indexOf(b) < 0) out.sets.push(b); });   // UI components live here (Home/swing_product_card)
      continue;
    }
    if (pg.name === 'Icons') {
      pg.findAllWithCriteria({ types: ['COMPONENT'] }).forEach(function (c) {
        if (c.name.indexOf('Icon/Line/') === 0) out.icons.line++;
        else if (c.name.indexOf('Icon/Solid/') === 0) out.icons.solid++;
      });
    } else {
      pg.findAllWithCriteria({ types: ['COMPONENT_SET'] }).forEach(function (s) { var b = setTag(s).logical || s.name; if (out.sets.indexOf(b) < 0) out.sets.push(b); });
      pg.children.forEach(function (n) { if (n.type === 'FRAME' && (n.name === 'Color' || n.name === 'Typography') && n.children.length) out.sets.push(n.name); });   // foundation pages have artboards, not sets
    }
  }
  return out;
}

async function postStatus() {
  try { figma.ui.postMessage({ type: 'status', status: await fileStatus() }); } catch (e) { /* status is a nicety */ }
}

figma.showUI(__html__, { width: 420, height: 600, themeColors: true });

(async function () {
  var prefs = (await figma.clientStorage.getAsync('prefs')) || {};
  figma.ui.postMessage({ type: 'prefs', prefs: prefs });
  figma.ui.postMessage({ type: 'sync-key', key: (await figma.clientStorage.getAsync('syncKey')) || '' });
  await postStatus();
})();

figma.ui.onmessage = async function (msg) {
  if (msg.type === 'save-prefs') {
    await figma.clientStorage.setAsync('prefs', msg.prefs);
    return;
  }
  if (msg.type === 'status') { await postStatus(); return; }
  if (msg.type === 'sync-key') { await figma.clientStorage.setAsync('syncKey', String(msg.key || '')); return; }
  if (msg.type === 'sync-diff') {
    try { figma.ui.postMessage({ type: 'sync-diff', result: await syncDiff(msg.css || '', msg.collection || 'Tokens') }); }
    catch (e) { figma.ui.postMessage({ type: 'sync-diff', result: { error: 'Could not compare: ' + e.message } }); }
    return;
  }
  if (msg.type === 'export-keys') {
    try {
      var kr = await exportLibraryKeys();
      figma.ui.postMessage({ type: 'keys-done', result: kr });
      figma.notify('Library keys saved: ' + kr.sets + ' sets, ' + kr.comps + ' components, ' + kr.vars + ' variables');
    } catch (e) { figma.ui.postMessage({ type: 'keys-done', error: e.message }); }
    await postStatus();
    return;
  }
  if (msg.type === 'icons-batch') {
    try { figma.ui.postMessage({ type: 'icons-ack', progress: await importIconBatch(msg.items) }); }
    catch (e) { figma.ui.postMessage({ type: 'icons-ack', error: e.message }); }
    return;
  }
  if (msg.type === 'icons-end') {
    var ir = endIconRun();
    figma.ui.postMessage({ type: 'icons-done', result: ir });
    if (ir) figma.notify('Icons: ' + ir.made + ' created, ' + ir.skipped + ' already there' + (ir.failedCount ? ', ' + ir.failedCount + ' failed' : ''));
    await postStatus();
    return;
  }
  if (msg.type === 'build') {
    var br = await buildComponents(msg.names || []);
    figma.ui.postMessage({ type: 'build-done', result: br });
    figma.notify(br.built.length ? 'Built: ' + br.built.join(', ') : 'Nothing built' + (br.errors.length ? ' (' + br.errors.length + ' errors)' : ''));
    await postStatus();
    return;
  }
  if (msg.type === 'check' || msg.type === 'import') {
    var plan;
    try { plan = analyze(msg.css || ''); }
    catch (e) { figma.ui.postMessage({ type: 'error', message: 'Could not read the CSS: ' + e.message }); return; }
    if (msg.type === 'check') { figma.ui.postMessage({ type: 'summary', summary: summary(plan) }); return; }
    try {
      var res = await importPlan(plan, msg.opts);
      figma.ui.postMessage({ type: 'done', summary: summary(plan), result: res });
      figma.notify('Tokens imported: ' + res.created + ' created, ' + res.updated + ' updated' +
        (res.errors.length ? ', ' + res.errors.length + ' errors' : ''));
    } catch (e) {
      figma.ui.postMessage({ type: 'error', message: e.message });
    }
    await postStatus();
  }
};
