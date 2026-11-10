'use strict';
/* PDF Editor — runs entirely in the browser. Rendering: PDF.js. Writing: pdf-lib. */
const { PDFDocument, StandardFonts, rgb, degrees, LineCapStyle, BlendMode, PDFName, PDFNumber,
        pushGraphicsState, popGraphicsState } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

const $ = id => document.getElementById(id);
const viewer = $('viewer'), thumbs = $('thumbs');

const S = {
  sources: new Map(),   // id -> { bytes, doc (pdf.js), name }
  pages: [],            // { id, src, idx, rot, annots: [] }
  assets: new Map(),    // id -> { url, w, h }
  scale: 1.25, tool: 'select', sel: null, selPages: new Set(), lastThumb: null,
  undo: [], redo: [], name: 'document.pdf', nextId: 1,
  color: '#000000', font: 'sans', size: 12, bold: false, italic: false, width: 2,
  pendingImage: null,
};
let views = [];         // one per page in the main viewer
let buildGen = 0;

const FONTS = {
  sans:  { css: 'Helvetica, Arial, sans-serif', bl: 0.945, std: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'] },
  serif: { css: '"Times New Roman", Times, serif', bl: 0.938, std: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'] },
  mono:  { css: '"Courier New", Courier, monospace', bl: 0.867, std: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'] },
};
const LH = 1.2; // line height, in font sizes

/* ---------- small helpers ---------- */
let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
const svgEl = (tag, attrs) => {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
};
function drag(e, onMove, onEnd) {
  e.preventDefault();
  const mv = ev => onMove(ev);
  const up = ev => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); if (onEnd) onEnd(ev); };
  addEventListener('pointermove', mv); addEventListener('pointerup', up);
}
const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
const toHex = (r, g, b) => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
// Local frame of an item: x runs along its "right", y runs "down", both as seen when upright.
function toUser(a, lx, ly) {
  const t = a.rot * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  return [a.ux + lx * c + ly * s, a.uy + lx * s - ly * c];
}
const inField = () => { const e = document.activeElement; return e && (e.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName)); };

/* ---------- undo ---------- */
const snapshot = () => JSON.stringify(S.pages);
function pushUndo() { S.undo.push(snapshot()); if (S.undo.length > 100) S.undo.shift(); S.redo = []; syncUi(); }
function restore(from, to) {
  if (!from.length) return;
  to.push(snapshot());
  S.pages = JSON.parse(from.pop());
  S.sel = null; S.selPages.clear();
  rebuild();
}

/* ---------- opening ---------- */
async function openFiles(files, append) {
  files = [...files].filter(f => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
  if (!files.length) return;
  if (append && S.pages.length) pushUndo();
  else {
    for (const s of S.sources.values()) s.doc.destroy();
    S.sources.clear(); S.pages = []; S.undo = []; S.redo = []; S.sel = null; S.selPages.clear();
    S.name = files[0].name;
  }
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    let doc;
    try {
      doc = await pdfjsLib.getDocument({ data: bytes.slice(), cMapUrl: 'vendor/cmaps/', cMapPacked: true,
        standardFontDataUrl: 'vendor/standard_fonts/' }).promise;
    } catch (err) {
      toast(err && err.name === 'PasswordException'
        ? `"${f.name}" is password-protected, which this editor does not support.`
        : `Could not open "${f.name}": ${err.message || err}`, 6000);
      continue;
    }
    const id = S.nextId++;
    S.sources.set(id, { bytes, doc, name: f.name });
    for (let i = 0; i < doc.numPages; i++) S.pages.push({ id: S.nextId++, src: id, idx: i, rot: 0, annots: [] });
  }
  rebuild();
}
const proxyOf = p => S.sources.get(p.src).doc.getPage(p.idx + 1);

/* ---------- main viewer ---------- */
const io = new IntersectionObserver(es => {
  for (const e of es) if (e.isIntersecting) { const v = views.find(v => v.el === e.target); if (v) renderView(v); }
}, { root: viewer, rootMargin: '600px' });
const thumbIo = new IntersectionObserver(es => {
  for (const e of es) if (e.isIntersecting && e.target._render) { e.target._render(); e.target._render = null; }
}, { root: thumbs, rootMargin: '400px' });

async function rebuild() {
  const gen = ++buildGen, top = viewer.scrollTop;
  syncUi();
  const next = [];
  for (const p of S.pages) {
    const proxy = await proxyOf(p);
    if (gen !== buildGen) return;
    const rot = (proxy.rotate + p.rot) % 360;
    const vp = proxy.getViewport({ scale: S.scale, rotation: rot });
    const el = document.createElement('div');
    el.className = 'page';
    el.style.width = vp.width + 'px'; el.style.height = vp.height + 'px';
    el.style.setProperty('--scale-factor', S.scale);
    const canvas = document.createElement('canvas');
    const formDiv = document.createElement('div'); formDiv.className = 'annotationLayer';
    const ov = document.createElement('div');
    el.append(canvas, formDiv, ov);
    const v = { p, proxy, rot, vp, el, canvas, formDiv, ov, rendered: false };
    ov.addEventListener('pointerdown', e => overlayDown(e, v));
    next.push(v);
  }
  io.disconnect();
  views = next;
  viewer.replaceChildren(...(views.length ? views.map(v => v.el) : [emptyEl]));
  for (const v of views) { drawOverlay(v); io.observe(v.el); }
  viewer.scrollTop = top;
  buildThumbs(gen);
}
const emptyEl = $('empty');

const linkStub = { getDestinationHash: () => '#', getAnchorUrl: () => '#', addLinkAttributes() {}, executeNamedAction() {},
  executeSetOCGState() {}, goToDestination() {}, externalLinkEnabled: false };

async function renderView(v) {
  if (v.rendered) return;
  v.rendered = true;
  const dpr = v.dpr = Math.min(window.devicePixelRatio || 1, 2);
  v.canvas.width = Math.floor(v.vp.width * dpr); v.canvas.height = Math.floor(v.vp.height * dpr);
  try {
    await v.proxy.render({ canvasContext: v.canvas.getContext('2d'), viewport: v.vp, transform: [dpr, 0, 0, dpr, 0, 0],
      annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS }).promise;
    const widgets = (await v.proxy.getAnnotations({ intent: 'display' })).filter(a => a.subtype === 'Widget');
    if (widgets.length) {
      await new pdfjsLib.AnnotationLayer({ div: v.formDiv, page: v.proxy, viewport: v.vp.clone({ dontFlip: true }) })
        .render({ annotations: widgets, renderForms: true, linkService: linkStub,
          annotationStorage: S.sources.get(v.p.src).doc.annotationStorage });
    }
  } catch (err) { if (err.name !== 'RenderingCancelledException') console.error(err); }
  if (S.tool === 'edittext') drawOverlay(v);
}

/* ---------- thumbnails and page tools ---------- */
function buildThumbs(gen) {
  thumbIo.disconnect();
  const els = views.map((v, i) => {
    const t = document.createElement('div');
    t.className = 'thumb' + (S.selPages.has(v.p.id) ? ' sel' : '');
    t.draggable = true; t.dataset.i = i;
    const base = v.proxy.getViewport({ scale: 1, rotation: v.rot });
    const tvp = v.proxy.getViewport({ scale: 120 / Math.max(base.width, base.height), rotation: v.rot });
    const c = document.createElement('canvas');
    c.width = Math.floor(tvp.width * 1.5); c.height = Math.floor(tvp.height * 1.5);
    c.style.width = tvp.width + 'px'; c.style.height = tvp.height + 'px';
    t.append(c, String(i + 1));
    t._render = () => v.proxy.render({ canvasContext: c.getContext('2d'), viewport: tvp, transform: [1.5, 0, 0, 1.5, 0, 0] })
      .promise.catch(() => {});
    t.onclick = e => {
      if (e.shiftKey && S.lastThumb != null) {
        const [a, b] = [S.lastThumb, i].sort((x, y) => x - y);
        for (let k = a; k <= b && k < S.pages.length; k++) S.selPages.add(S.pages[k].id);
      } else if (e.ctrlKey || e.metaKey) {
        S.selPages.has(v.p.id) ? S.selPages.delete(v.p.id) : S.selPages.add(v.p.id);
      } else { S.selPages.clear(); S.selPages.add(v.p.id); v.el.scrollIntoView({ block: 'start' }); }
      S.lastThumb = i;
      [...thumbs.children].forEach((x, k) => x.classList.toggle('sel', S.selPages.has(S.pages[k].id)));
      syncUi();
    };
    t.ondragstart = e => {
      if (!S.selPages.has(v.p.id)) { S.selPages.clear(); S.selPages.add(v.p.id); t.onclick({}); }
      e.dataTransfer.setData('application/x-pdfed-pages', '1'); e.dataTransfer.effectAllowed = 'move';
    };
    t.ondragover = e => {
      if (![...e.dataTransfer.types].includes('application/x-pdfed-pages')) return;
      e.preventDefault(); e.stopPropagation();
      const r = t.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
      clearDrop(); t.classList.add(after ? 'dropAfter' : 'dropBefore');
    };
    t.ondragleave = clearDrop;
    t.ondrop = e => {
      if (![...e.dataTransfer.types].includes('application/x-pdfed-pages')) return;
      e.preventDefault(); e.stopPropagation();
      const after = t.classList.contains('dropAfter'); clearDrop();
      if (S.selPages.has(v.p.id)) return;
      pushUndo();
      const moving = S.pages.filter(p => S.selPages.has(p.id));
      const rest = S.pages.filter(p => !S.selPages.has(p.id));
      rest.splice(rest.indexOf(v.p) + (after ? 1 : 0), 0, ...moving);
      S.pages = rest; rebuild();
    };
    return t;
  });
  if (gen !== buildGen) return;
  thumbs.replaceChildren(...els);
  els.forEach(t => thumbIo.observe(t));
}
const clearDrop = () => thumbs.querySelectorAll('.dropBefore,.dropAfter').forEach(x => x.classList.remove('dropBefore', 'dropAfter'));

function selectedPages() {
  const sel = S.pages.filter(p => S.selPages.has(p.id));
  if (!sel.length) toast('Select one or more pages in the left panel first (Ctrl or Shift for several).');
  return sel;
}
function rotatePages(d) {
  const sel = selectedPages(); if (!sel.length) return;
  pushUndo(); sel.forEach(p => p.rot = (p.rot + d + 360) % 360); rebuild();
}
function deletePages() {
  const sel = selectedPages(); if (!sel.length) return;
  if (sel.length === S.pages.length) return toast('A PDF needs at least one page.');
  pushUndo(); S.pages = S.pages.filter(p => !S.selPages.has(p.id)); S.selPages.clear(); rebuild();
}

/* ---------- overlay: drawing the user's items ---------- */
function placeEl(el, v, a) {
  const [x, y] = v.vp.convertToViewportPoint(a.ux, a.uy);
  el.style.left = x + 'px'; el.style.top = y + 'px';
  el.style.transform = `rotate(${v.rot - a.rot}deg)`;
}
function drawOverlay(v) {
  const ov = v.ov, sc = S.scale;
  ov.className = 'overlay tool-' + S.tool;
  ov.replaceChildren();
  const svg = svgEl('svg', { width: v.vp.width, height: v.vp.height });
  ov.append(svg);
  for (const a of v.p.annots) {
    if (a.type === 'ink') {
      const pts = a.pts.length === 1 ? [a.pts[0], a.pts[0]] : a.pts;
      const pl = svgEl('polyline', { points: pts.map(p => v.vp.convertToViewportPoint(p[0], p[1]).join(',')).join(' '),
        stroke: a.color, 'stroke-width': a.width * sc, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
      pl.classList.add('annot'); if (a === S.sel) pl.classList.add('sel');
      pl.addEventListener('pointerdown', e => itemDown(e, v, a));
      svg.append(pl);
      continue;
    }
    const el = document.createElement('div');
    el.className = 'annot ' + a.type + (a === S.sel ? ' sel' : '');
    el.dataset.id = a.id;
    placeEl(el, v, a);
    if (a.type === 'text') {
      el.textContent = a.text;
      Object.assign(el.style, { fontFamily: FONTS[a.font].css, fontSize: a.size * sc + 'px', color: a.color,
        fontWeight: a.bold ? '700' : '400', fontStyle: a.italic ? 'italic' : 'normal',
        background: a.bg || 'transparent', minWidth: (a.minW || 0) * sc + 'px', minHeight: a.size * LH * sc + 'px' });
      ov.append(el);
      a.w = el.offsetWidth / sc; a.h = el.offsetHeight / sc;
    } else {
      el.style.width = a.w * sc + 'px'; el.style.height = a.h * sc + 'px';
      if (a.type === 'image') { const img = new Image(); img.src = S.assets.get(a.asset).url; img.draggable = false; el.append(img); }
      else el.style.background = a.color;
      if (a === S.sel) {
        const h = document.createElement('div'); h.className = 'handle';
        h.addEventListener('pointerdown', e => resizeDown(e, v, a));
        el.append(h);
      }
      ov.append(el);
    }
    el.addEventListener('pointerdown', e => itemDown(e, v, a));
  }
  if (S.tool === 'edittext' && v.rendered) addTextZones(v);
}
const redrawAll = () => views.forEach(drawOverlay);
function select(a) { S.sel = a; if (a) propsFrom(a); redrawAll(); syncUi(); }

let lastClick = { id: 0, t: 0 };
function itemDown(e, v, a) {
  if (S.tool !== 'select' || e.target.isContentEditable || e.button !== 0) return;
  e.stopPropagation();
  const now = Date.now(), dbl = lastClick.id === a.id && now - lastClick.t < 400;
  lastClick = { id: a.id, t: now };
  if (S.sel !== a) select(a);
  if (dbl && a.type === 'text') { e.preventDefault(); return startEdit(v, a); }
  const x0 = e.clientX, y0 = e.clientY, orig = JSON.parse(JSON.stringify(a));
  let moved = false;
  const shift = (ux, uy, dx, dy) => { const [x, y] = v.vp.convertToViewportPoint(ux, uy); return v.vp.convertToPdfPoint(x + dx, y + dy); };
  drag(e, ev => {
    const dx = ev.clientX - x0, dy = ev.clientY - y0;
    if (!moved && Math.hypot(dx, dy) < 3) return;
    if (!moved) { pushUndo(); moved = true; }
    if (a.type === 'ink') a.pts = orig.pts.map(p => shift(p[0], p[1], dx, dy));
    else [a.ux, a.uy] = shift(orig.ux, orig.uy, dx, dy);
    drawOverlay(v);
  });
}
function resizeDown(e, v, a) {
  e.stopPropagation();
  const x0 = e.clientX, y0 = e.clientY, w0 = a.w, h0 = a.h, t = (v.rot - a.rot) * Math.PI / 180;
  let moved = false;
  drag(e, ev => {
    const dx = ev.clientX - x0, dy = ev.clientY - y0;
    if (!moved) { pushUndo(); moved = true; }
    const lx = (dx * Math.cos(t) + dy * Math.sin(t)) / S.scale, ly = (-dx * Math.sin(t) + dy * Math.cos(t)) / S.scale;
    a.w = Math.max(4, w0 + lx);
    a.h = a.type === 'image' && !ev.shiftKey ? a.w * h0 / w0 : Math.max(4, h0 + ly);
    drawOverlay(v);
  });
}

/* ---------- overlay: creating items ---------- */
function overlayDown(e, v) {
  if (S.tool === 'select' || e.button !== 0 || e.target.isContentEditable) return;
  if (e.target.classList.contains('tl')) return;
  const r = v.el.getBoundingClientRect(), pos = ev => [ev.clientX - r.left, ev.clientY - r.top];
  const [x0, y0] = pos(e), sc = S.scale;
  const base = () => ({ id: S.nextId++, rot: v.rot });
  if (S.tool === 'text') {
    e.preventDefault();
    if (document.activeElement && document.activeElement.isContentEditable) return document.activeElement.blur();
    pushUndo();
    const [ux, uy] = v.vp.convertToPdfPoint(x0, y0 - S.size * LH * sc / 2);
    const a = { ...base(), type: 'text', ux, uy, text: '', size: S.size, font: S.font, bold: S.bold, italic: S.italic, color: S.color };
    v.p.annots.push(a); S.sel = a; redrawAll();
    startEdit(v, a, true);
  } else if (S.tool === 'highlight' || S.tool === 'whiteout') {
    const rb = document.createElement('div'); rb.className = 'rubber'; v.ov.append(rb);
    let box = null;
    drag(e, ev => {
      const [x, y] = pos(ev);
      box = [Math.min(x0, x), Math.min(y0, y), Math.abs(x - x0), Math.abs(y - y0)];
      Object.assign(rb.style, { left: box[0] + 'px', top: box[1] + 'px', width: box[2] + 'px', height: box[3] + 'px' });
    }, () => {
      rb.remove();
      if (!box || box[2] < 3 || box[3] < 3) return;
      pushUndo();
      const [ux, uy] = v.vp.convertToPdfPoint(box[0], box[1]);
      v.p.annots.push({ ...base(), type: S.tool, ux, uy, w: box[2] / sc, h: box[3] / sc,
        color: S.tool === 'highlight' ? '#ffe600' : '#ffffff' });
      drawOverlay(v);
    });
  } else if (S.tool === 'draw') {
    pushUndo();
    const a = { id: S.nextId++, type: 'ink', pts: [v.vp.convertToPdfPoint(x0, y0)], color: S.color, width: S.width };
    v.p.annots.push(a); drawOverlay(v);
    drag(e, ev => { a.pts.push(v.vp.convertToPdfPoint(...pos(ev))); drawOverlay(v); });
  } else if (S.tool === 'image' || S.tool === 'sign') {
    e.preventDefault();
    const asset = S.pendingImage && S.assets.get(S.pendingImage);
    if (!asset) return;
    pushUndo();
    const pageW = v.vp.width / sc;
    const w = Math.min(S.tool === 'sign' ? 150 : 220, pageW * 0.8, asset.w), h = w * asset.h / asset.w;
    const [ux, uy] = v.vp.convertToPdfPoint(x0 - w * sc / 2, y0 - h * sc / 2);
    const a = { ...base(), type: 'image', ux, uy, w, h, asset: S.pendingImage };
    v.p.annots.push(a);
    setTool('select'); select(a);
  }
}

function startEdit(v, a, isNew) {
  const el = v.ov.querySelector(`[data-id="${a.id}"]`); if (!el) return;
  try { el.contentEditable = 'plaintext-only'; } catch { el.contentEditable = 'true'; }
  el.classList.add('editing'); el.spellcheck = false;
  el.focus();
  const sel = getSelection(); sel.selectAllChildren(el); if (!isNew && !a.srcLine && a.srcLine !== 0) sel.collapseToEnd();
  el.addEventListener('keydown', e => { if (e.key === 'Escape') el.blur(); e.stopPropagation(); });
  el.addEventListener('blur', () => {
    const text = el.innerText.replace(/\r/g, '').replace(/\n$/, '');
    if (text !== a.text && !isNew) pushUndo();
    a.text = text;
    if (!text.trim() && !a.bg) { v.p.annots.splice(v.p.annots.indexOf(a), 1); if (S.sel === a) S.sel = null; }
    if (S.tool === 'text') setTool('select'); else redrawAll();
    syncUi();
  }, { once: true });
}

/* ---------- editing existing text ---------- */
const lineCache = new WeakMap();
async function getLines(v) {
  if (lineCache.has(v.proxy)) return lineCache.get(v.proxy);
  const tc = await v.proxy.getTextContent();
  const lines = []; let L = null;
  for (const it of tc.items) {
    if (!it.str) { if (it.hasEOL) L = null; continue; }
    const m = it.transform, size = Math.hypot(m[2], m[3]) || it.height;
    if (!size || !it.str.trim() && !L) continue;
    const ang = Math.atan2(m[1], m[0]), c = Math.cos(ang), s = Math.sin(ang);
    if (L) {
      const dx = m[4] - L.e, dy = m[5] - L.f, along = dx * c + dy * s, perp = -dx * s + dy * c, gap = along - L.len;
      if (Math.abs(ang - L.ang) < 0.02 && Math.abs(size - L.size) < 0.1 * size && Math.abs(perp) < 0.3 * size && gap > -0.5 * size && gap < 1.5 * size) {
        if (gap > 0.2 * size && !/\s$/.test(L.str) && !/^\s/.test(it.str)) L.str += ' ';
        L.str += it.str; L.len = along + it.width;
        if (it.hasEOL) L = null;
        continue;
      }
    }
    L = { e: m[4], f: m[5], ang, size, len: it.width, str: it.str, fontName: it.fontName,
      family: (tc.styles[it.fontName] || {}).fontFamily || '' };
    lines.push(L);
    if (it.hasEOL) L = null;
  }
  const out = lines.filter(l => l.str.trim()).map(l => {
    const font = /mono/i.test(l.family) ? 'mono' : /sans/i.test(l.family) ? 'sans' : 'serif';
    const up = FONTS[font].bl * l.size;
    let name = '';
    try { name = v.proxy.commonObjs.get(l.fontName).name || ''; } catch {}
    return { ux: l.e - Math.sin(l.ang) * up, uy: l.f + Math.cos(l.ang) * up, rot: l.ang * 180 / Math.PI, w: l.len, h: l.size * LH,
      size: Math.round(l.size * 10) / 10, str: l.str.replace(/\s+$/, ''), font, bold: /bold|black|heavy/i.test(name), italic: /italic|oblique/i.test(name) };
  });
  lineCache.set(v.proxy, out);
  return out;
}
async function addTextZones(v) {
  const tok = v.zoneTok = (v.zoneTok || 0) + 1;
  const lines = await getLines(v);
  if (tok !== v.zoneTok || S.tool !== 'edittext') return;
  lines.forEach((L, i) => {
    if (v.p.annots.some(a => a.srcLine === i)) return;
    const el = document.createElement('div'); el.className = 'tl';
    placeEl(el, v, L);
    el.style.width = L.w * S.scale + 'px'; el.style.height = L.h * S.scale + 'px';
    el.addEventListener('click', () => replaceLine(v, L, i));
    v.ov.append(el);
  });
}
function sampleColors(v, L) {
  const pts = [[0, 0], [L.w, 0], [0, L.h], [L.w, L.h]].map(([x, y]) => v.vp.convertToViewportPoint(...toUser(L, x, y)));
  const d = v.dpr, cw = v.canvas.width, ch = v.canvas.height;
  const x0 = Math.max(0, Math.floor(Math.min(...pts.map(p => p[0])) * d)), y0 = Math.max(0, Math.floor(Math.min(...pts.map(p => p[1])) * d));
  const x1 = Math.min(cw, Math.ceil(Math.max(...pts.map(p => p[0])) * d)), y1 = Math.min(ch, Math.ceil(Math.max(...pts.map(p => p[1])) * d));
  const w = x1 - x0, h = y1 - y0;
  if (w < 2 || h < 2) return { bg: '#ffffff', fg: '#000000' };
  const px = v.canvas.getContext('2d').getImageData(x0, y0, w, h).data;
  const at = (x, y) => { const i = (y * w + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
  const buckets = new Map();
  const vote = c => { const k = (c[0] >> 4) << 8 | (c[1] >> 4) << 4 | c[2] >> 4; const b = buckets.get(k) || [0, 0, 0, 0]; b[0]++; b[1] += c[0]; b[2] += c[1]; b[3] += c[2]; buckets.set(k, b); };
  for (let x = 0; x < w; x++) { vote(at(x, 0)); vote(at(x, h - 1)); }
  for (let y = 0; y < h; y++) { vote(at(0, y)); vote(at(w - 1, y)); }
  const best = [...buckets.values()].sort((a, b) => b[0] - a[0])[0];
  const bg = [best[1] / best[0], best[2] / best[0], best[3] / best[0]];
  let fg = [0, 0, 0], far = 60;
  const step = Math.max(1, Math.floor(Math.sqrt(w * h / 20000)));
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const c = at(x, y), dist = Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]);
    if (dist > far) { far = dist; fg = c; }
  }
  return { bg: toHex(...bg), fg: toHex(...fg) };
}
function replaceLine(v, L, i) {
  const { bg, fg } = sampleColors(v, L);
  pushUndo();
  const a = { id: S.nextId++, type: 'text', ux: L.ux, uy: L.uy, rot: L.rot, text: L.str, size: L.size, font: L.font,
    bold: L.bold, italic: L.italic, color: fg, bg, minW: L.w, srcLine: i };
  v.p.annots.push(a);
  setTool('select'); select(a);
  startEdit(v, a, true);
}

/* ---------- images and signature ---------- */
function loadImage(url) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; }); }
async function addAsset(url) {
  const img = await loadImage(url);
  if (!/^data:image\/(png|jpeg)/.test(url)) {   // normalise other formats to PNG
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0); url = c.toDataURL('image/png');
  }
  const id = S.nextId++;
  S.assets.set(id, { url, w: img.naturalWidth, h: img.naturalHeight });
  return id;
}
const readUrl = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });

const pad = $('sigPad'), pctx = pad.getContext('2d');
let padDirty = false;
function openSigDialog() { pctx.clearRect(0, 0, pad.width, pad.height); padDirty = false; $('sigDlg').showModal(); }
pad.addEventListener('pointerdown', e => {
  const r = pad.getBoundingClientRect(), p = ev => [(ev.clientX - r.left) * pad.width / r.width, (ev.clientY - r.top) * pad.height / r.height];
  pctx.lineWidth = 2.6; pctx.lineCap = pctx.lineJoin = 'round'; pctx.strokeStyle = '#0b1f66';
  let last = p(e); padDirty = true;
  pctx.beginPath(); pctx.arc(last[0], last[1], 1.3, 0, 7); pctx.fillStyle = '#0b1f66'; pctx.fill();
  drag(e, ev => { const n = p(ev); pctx.beginPath(); pctx.moveTo(...last); pctx.lineTo(...n); pctx.stroke(); last = n; });
});
$('sigClear').onclick = () => { pctx.clearRect(0, 0, pad.width, pad.height); padDirty = false; };
$('sigCancel').onclick = () => $('sigDlg').close();
$('sigOk').onclick = async () => {
  if (!padDirty) return toast('Draw your signature first.');
  const d = pctx.getImageData(0, 0, pad.width, pad.height).data;
  let x0 = pad.width, y0 = pad.height, x1 = 0, y1 = 0;
  for (let y = 0; y < pad.height; y++) for (let x = 0; x < pad.width; x++) if (d[(y * pad.width + x) * 4 + 3] > 0) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const c = document.createElement('canvas'); c.width = x1 - x0 + 9; c.height = y1 - y0 + 9;
  c.getContext('2d').drawImage(pad, x0 - 4, y0 - 4, c.width, c.height, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/png');
  try { localStorage.setItem('pdfed.signature', url); } catch {}
  $('sigDlg').close();
  S.sigAsset = await addAsset(url);
  setTool('sign');
};
async function signatureAsset() {
  if (S.sigAsset) return S.sigAsset;
  let url = null; try { url = localStorage.getItem('pdfed.signature'); } catch {}
  return url ? (S.sigAsset = await addAsset(url)) : null;
}

/* ---------- tools and properties ---------- */
async function setTool(t) {
  if (t === 'image' && S.tool !== 'image') return $('fImg').click();
  if (t === 'sign') {
    const id = await signatureAsset();
    if (!id) return openSigDialog();
    S.pendingImage = id; toast('Click where the signature should go.');
  }
  S.tool = t;
  if (t !== 'select') S.sel = null;
  redrawAll(); syncUi();
}
$('fImg').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { S.pendingImage = await addAsset(await readUrl(f)); } catch { return toast('That image could not be read.'); }
  S.tool = 'image'; S.sel = null; redrawAll(); syncUi();
  toast('Click where the image should go.');
};
function propsFrom(a) {
  if (a.color) { S.color = a.type === 'highlight' || a.type === 'whiteout' ? S.color : a.color; $('pColor').value = a.color; }
  if (a.type === 'text') { S.font = a.font; S.size = a.size; S.bold = a.bold; S.italic = a.italic; }
  if (a.type === 'ink') S.width = a.width;
  $('pFont').value = S.font; $('pSize').value = S.size; $('pWidth').value = S.width;
}
function setProp(k, val) {
  const a = S.sel;
  const applies = a && ((k === 'color' && a.type !== 'image') || (a.type === 'text' && ['font', 'size', 'bold', 'italic'].includes(k)) || (a.type === 'ink' && k === 'width'));
  if (applies) { pushUndo(); a[k] = val; redrawAll(); }
  if (!(k === 'color' && a && (a.type === 'highlight' || a.type === 'whiteout'))) S[k] = val;
  syncUi();
}
$('pColor').onchange = e => setProp('color', e.target.value);
$('pFont').onchange = e => setProp('font', e.target.value);
$('pSize').onchange = e => setProp('size', Math.min(144, Math.max(4, +e.target.value || 12)));
$('pWidth').onchange = e => setProp('width', Math.min(20, Math.max(0.5, +e.target.value || 2)));
$('pBold').onclick = () => setProp('bold', !(S.sel && S.sel.type === 'text' ? S.sel.bold : S.bold));
$('pItalic').onclick = () => setProp('italic', !(S.sel && S.sel.type === 'text' ? S.sel.italic : S.italic));

function deleteItem() {
  if (!S.sel) return;
  const p = S.pages.find(p => p.annots.includes(S.sel)); if (!p) return;
  pushUndo(); p.annots.splice(p.annots.indexOf(S.sel), 1); S.sel = null; redrawAll(); syncUi();
}
function syncUi() {
  const has = S.pages.length > 0, t = S.sel && S.sel.type === 'text' ? S.sel : S;
  document.querySelectorAll('#tools [data-tool]').forEach(b => { b.classList.toggle('on', b.dataset.tool === S.tool); b.disabled = !has; });
  for (const id of ['bAdd', 'bSave', 'bRotL', 'bRotR', 'bDelPages', 'bExtract', 'bZoomIn', 'bZoomOut', 'bFit']) $(id).disabled = !has;
  $('bUndo').disabled = !S.undo.length; $('bRedo').disabled = !S.redo.length; $('bDel').disabled = !S.sel;
  $('pBold').classList.toggle('on', !!t.bold); $('pItalic').classList.toggle('on', !!t.italic);
  $('zoomLbl').textContent = Math.round(S.scale * 100) + '%';
  document.title = has ? `${S.name} — PDF Editor` : 'PDF Editor';
}

/* ---------- export ---------- */
async function buildPdf(pages) {
  const warnings = new Set();
  const lib = new Map();
  const srcIds = [...new Set(pages.map(p => p.src))];
  for (const id of srcIds) {
    const src = S.sources.get(id);
    let bytes = src.bytes;
    if (src.doc.annotationStorage.size > 0) {       // form values typed in the viewer
      try { bytes = await src.doc.saveDocument(); } catch (e) { console.error(e); warnings.add('some form values could not be saved'); }
    }
    lib.set(id, await PDFDocument.load(bytes, { ignoreEncryption: true }));
  }
  let out, outPages;
  if (srcIds.length === 1) {
    // One source: keep the original file (and its live form fields) and only rearrange its pages.
    out = lib.get(srcIds[0]);
    const all = out.getPages();
    outPages = pages.map(p => all[p.idx]);
    if (outPages.length !== all.length || outPages.some((pg, i) => pg !== all[i])) {
      const rootRef = out.catalog.get(PDFName.of('Pages')), root = out.catalog.Pages();
      for (const pg of outPages) {
        for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
          const name = PDFName.of(key);
          if (!pg.node.get(name)) { const val = pg.node.getInheritableAttribute(name); if (val) pg.node.set(name, val); }
        }
        pg.node.setParent(rootRef);
      }
      root.set(PDFName.of('Kids'), out.context.obj(outPages.map(pg => pg.ref)));
      root.set(PDFName.of('Count'), PDFNumber.of(outPages.length));
    }
  } else {
    // Several sources: form fields cannot be carried across files, so they are flattened into the page.
    out = await PDFDocument.create();
    outPages = new Array(pages.length);
    for (const id of srcIds) {
      const doc = lib.get(id);
      try { const form = doc.getForm(); if (form.getFields().length) { form.flatten(); warnings.add('form fields were flattened because PDFs were merged'); } }
      catch (e) { console.error(e); }
      const slots = pages.map((p, i) => p.src === id ? i : -1).filter(i => i >= 0);
      const copied = await out.copyPages(doc, slots.map(i => pages[i].idx));
      slots.forEach((slot, k) => outPages[slot] = copied[k]);
    }
    outPages.forEach(pg => out.addPage(pg));
  }

  const fonts = new Map(), images = new Map();
  const fontFor = async a => {
    const key = FONTS[a.font].std[(a.bold ? 1 : 0) + (a.italic ? 2 : 0)];
    if (!fonts.has(key)) fonts.set(key, await out.embedFont(StandardFonts[key]));
    return fonts.get(key);
  };
  const imageFor = async id => {
    if (!images.has(id)) {
      const url = S.assets.get(id).url, bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      images.set(id, url.startsWith('data:image/png') ? await out.embedPng(bytes) : await out.embedJpg(bytes));
    }
    return images.get(id);
  };
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i], pg = outPages[i];
    if (p.rot) pg.setRotation(degrees((pg.getRotation().angle + p.rot) % 360));
    if (!p.annots.length) continue;
    // Isolate the original content so its leftover graphics state cannot distort what we add.
    pg.node.normalize();
    pg.node.wrapContentStreams(out.context.register(out.context.contentStream([pushGraphicsState()])),
      out.context.register(out.context.contentStream([popGraphicsState()])));
    for (const a of p.annots) {
      const rotate = degrees(a.rot || 0);
      if (a.type === 'ink') {
        const color = rgb(...hexRgb(a.color));
        const pts = a.pts.length === 1 ? [a.pts[0], a.pts[0]] : a.pts;
        for (let k = 1; k < pts.length; k++) pg.drawLine({ start: { x: pts[k - 1][0], y: pts[k - 1][1] }, end: { x: pts[k][0], y: pts[k][1] },
          thickness: a.width, color, lineCap: LineCapStyle.Round });
      } else if (a.type === 'image') {
        const [x, y] = toUser(a, 0, a.h);
        pg.drawImage(await imageFor(a.asset), { x, y, width: a.w, height: a.h, rotate });
      } else if (a.type === 'highlight' || a.type === 'whiteout') {
        const [x, y] = toUser(a, 0, a.h);
        pg.drawRectangle({ x, y, width: a.w, height: a.h, rotate, color: rgb(...hexRgb(a.color)),
          ...(a.type === 'highlight' ? { opacity: 0.4, blendMode: BlendMode.Multiply } : {}) });
      } else if (a.type === 'text') {
        if (a.bg) { const [x, y] = toUser(a, 0, a.h); pg.drawRectangle({ x, y, width: a.w, height: a.h, rotate, color: rgb(...hexRgb(a.bg)) }); }
        const font = await fontFor(a), ok = new Set(font.getCharacterSet()), color = rgb(...hexRgb(a.color));
        a.text.split('\n').forEach((line, n) => {
          const clean = [...line.replace(/\t/g, '    ')].map(ch => ok.has(ch.codePointAt(0)) ? ch : (warnings.add('some characters are outside the built-in fonts and were replaced with "?"'), '?')).join('');
          const [x, y] = toUser(a, 0, (n * LH + FONTS[a.font].bl) * a.size);
          if (clean) pg.drawText(clean, { x, y, size: a.size, font, color, rotate });
        });
      }
    }
  }
  return { bytes: await out.save(), warnings: [...warnings] };
}

async function saveAs(pages, suggested) {
  if (document.activeElement && document.activeElement.isContentEditable) document.activeElement.blur();
  let handle = null;
  if (window.showSaveFilePicker) {
    try { handle = await showSaveFilePicker({ suggestedName: suggested, types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] }); }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  let res;
  try { res = await buildPdf(pages); }
  catch (e) { console.error(e); return toast('Saving failed: ' + (e.message || e), 8000); }
  if (handle) { const w = await handle.createWritable(); await w.write(res.bytes); await w.close(); }
  else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([res.bytes], { type: 'application/pdf' })); a.download = suggested;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }
  toast(res.warnings.length ? 'Saved. Note: ' + res.warnings.join('; ') + '.' : 'Saved.', res.warnings.length ? 8000 : 2500);
}
const stem = () => S.name.replace(/\.pdf$/i, '');

/* ---------- wiring ---------- */
$('bOpen').onclick = () => $('fOpen').click();
$('bAdd').onclick = () => $('fAdd').click();
$('fOpen').onchange = e => { openFiles(e.target.files, false); e.target.value = ''; };
$('fAdd').onchange = e => { openFiles(e.target.files, true); e.target.value = ''; };
$('bSave').onclick = () => saveAs(S.pages, stem() + '-edited.pdf');
$('bExtract').onclick = () => { const sel = selectedPages(); if (sel.length) saveAs(sel, stem() + '-pages.pdf'); };
$('bUndo').onclick = () => restore(S.undo, S.redo);
$('bRedo').onclick = () => restore(S.redo, S.undo);
$('bRotL').onclick = () => rotatePages(-90);
$('bRotR').onclick = () => rotatePages(90);
$('bDelPages').onclick = deletePages;
$('bDel').onclick = deleteItem;
$('bSigEdit').onclick = openSigDialog;
document.querySelectorAll('#tools [data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
const zoom = s => { S.scale = Math.min(4, Math.max(0.25, s)); rebuild(); };
$('bZoomIn').onclick = () => zoom(S.scale * 1.2);
$('bZoomOut').onclick = () => zoom(S.scale / 1.2);
$('bFit').onclick = () => { if (views[0]) zoom((viewer.clientWidth - 48) / (views[0].vp.width / S.scale)); };

viewer.addEventListener('pointerdown', e => { if (S.tool === 'select' && S.sel && !e.target.closest('.annot')) select(null); });
addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && k === 's') { e.preventDefault(); if (S.pages.length) $('bSave').click(); return; }
  if (mod && k === 'o') { e.preventDefault(); $('bOpen').click(); return; }
  if (inField()) return;
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? restore(S.redo, S.undo) : restore(S.undo, S.redo); }
  else if (mod && k === 'y') { e.preventDefault(); restore(S.redo, S.undo); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { if (S.sel) { e.preventDefault(); deleteItem(); } }
  else if (e.key === 'Escape' && S.pages.length) setTool('select');
});
addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); document.body.classList.add('dragover'); } });
addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragover'); });
addEventListener('drop', e => {
  document.body.classList.remove('dragover');
  if (!e.dataTransfer.files.length) return;
  e.preventDefault(); openFiles(e.dataTransfer.files, S.pages.length > 0 && e.shiftKey);
});
addEventListener('beforeunload', e => { if (S.undo.length) { e.preventDefault(); e.returnValue = ''; } });
syncUi();
