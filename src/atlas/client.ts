export const ATLAS_DATA_MARK = '__ATLAS_DATA__'

export const ATLAS_SCRIPT = `
'use strict';
(function () {
  const DATA = ${ATLAS_DATA_MARK};
  const STATES = ['held', 'unknown', 'absent'];
  const CROSSINGS = ['inside', 'through', 'bypass', 'direct'];
  const W = 220, H = 60, GAP = 28, PAD = 16, HEAD = 26, ROW = 18, WRAP = 1500;
  const svg = document.getElementById('atlas-svg');
  const viewport = document.getElementById('atlas-viewport');
  const panel = document.getElementById('atlas-panel');
  const tip = document.getElementById('atlas-tip');
  const search = document.getElementById('atlas-search');
  const results = document.getElementById('atlas-results');
  const open = new Set(DATA.open);
  const expanded = new Set();
  let selected = null;
  let view = { x: 0, y: 0, k: 1 };
  const boxes = new Map();

  const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const file = (index) => DATA.files[index];
  const groupOfContour = new Map();
  for (const group of DATA.groups) group.contours.forEach((id) => groupOfContour.set(id, group));
  const closedGroup = (contour) => {
    const group = groupOfContour.get(contour.id);
    return group && !open.has(group.id) ? group : null;
  };
  const contourOfFile = new Map();
  const componentOfFile = new Map();
  for (const contour of DATA.contours) {
    for (const component of contour.components) {
      for (const index of component.files) {
        contourOfFile.set(file(index), contour);
        componentOfFile.set(file(index), component);
      }
    }
  }
  const counts = (entry) => STATES.map((state, at) => entry.counts[at] + ' ' + state).join(' · ');
  const href = (path) => {
    const encoded = path.split('/').filter((segment) => segment !== '').map(encodeURIComponent).join('/');
    return (DATA.root === '' ? '' : DATA.root.split('/').map(encodeURIComponent).join('/') + '/') + encoded;
  };

  function visible() {
    const nodes = [];
    for (const contour of DATA.contours) {
      const group = closedGroup(contour);
      if (group) { if (!nodes.includes(group.id)) nodes.push(group.id); }
      else if (open.has(contour.id)) contour.components.forEach((component) => nodes.push(component.id));
      else nodes.push(contour.id);
    }
    return new Set(nodes);
  }

  function componentHeight(component) {
    return expanded.has(component.id) ? H + component.files.length * ROW + 6 : H;
  }

  function nodeMarkup(entry, x, y, kind) {
    const height = kind === 'component' ? componentHeight(entry) : H;
    boxes.set(entry.id, { x, y, w: W, h: height });
    const isOpen = kind === 'component' && expanded.has(entry.id);
    const sub = kind === 'group' ? entry.contours.length + ' contours' : kind === 'contour' ? entry.kind + ' · ' + entry.components.length + ' parts' : (entry.purpose === null ? entry.files.length + ' files · not interpreted' : entry.purpose);
    let markup = '<g class="box" data-node="' + esc(entry.id) + '" data-kind="' + kind + '" data-state="' + entry.state + '"' + (isOpen ? ' data-open=""' : '') + (selected === entry.id ? ' aria-current="true"' : '') + ' tabindex="0">'
      + '<title>' + esc(entry.name + ' — ' + counts(entry)) + '</title>'
      + '<rect x="' + x + '" y="' + y + '" width="' + W + '" height="' + height + '" rx="6"></rect>'
      + '<text class="name" x="' + (x + 8) + '" y="' + (y + 20) + '">' + esc(entry.name.length > 30 ? '…' + entry.name.slice(-29) : entry.name) + '</text>'
      + '<text class="sub" x="' + (x + 8) + '" y="' + (y + 38) + '">' + esc(sub.length > 36 ? sub.slice(0, 35) + '…' : sub) + '</text>'
      + bar(entry, x + 8, y + 46)
      + '</g>';
    if (isOpen) {
      entry.files.forEach((index, at) => {
        const path = file(index);
        const state = DATA.states[index];
        markup += '<g class="file" data-file="' + esc(path) + '" data-state="' + state + '"' + (selected === path ? ' aria-current="true"' : '') + '>'
          + '<text x="' + (x + 14) + '" y="' + (y + H + at * ROW + 12) + '">' + esc(path.split('/').pop()) + '</text></g>';
      });
    }
    return markup;
  }

  function bar(entry, x, y) {
    const total = entry.counts[0] + entry.counts[1] + entry.counts[2];
    if (total === 0) return '';
    let offset = 0;
    return STATES.map((state, at) => {
      const width = (W - 16) * entry.counts[at] / total;
      const part = width === 0 ? '' : '<rect class="bar" data-state="' + state + '" x="' + (x + offset) + '" y="' + y + '" width="' + width + '" height="5"></rect>';
      offset += width;
      return part;
    }).join('');
  }

  function layout() {
    boxes.clear();
    let markup = '';
    let x = 0, y = 0, rowHeight = 0;
    const place = (width, height) => {
      if (x > 0 && x + width > WRAP) { x = 0; y += rowHeight + GAP; rowHeight = 0; }
      const at = { x, y };
      x += width + GAP;
      rowHeight = Math.max(rowHeight, height);
      return at;
    };
    const drawnGroups = new Set();
    for (const contour of DATA.contours) {
      const group = closedGroup(contour);
      if (group) {
        if (drawnGroups.has(group.id)) continue;
        drawnGroups.add(group.id);
        const at = place(W, H);
        markup += nodeMarkup(group, at.x, at.y, 'group');
        continue;
      }
      if (!open.has(contour.id)) {
        const at = place(W, H);
        markup += nodeMarkup(contour, at.x, at.y, 'contour');
        continue;
      }
      const columns = Math.max(1, Math.min(5, Math.ceil(Math.sqrt(contour.components.length))));
      const rows = [];
      contour.components.forEach((component, index) => {
        const row = Math.floor(index / columns);
        rows[row] = Math.max(rows[row] || 0, componentHeight(component));
      });
      const width = PAD * 2 + columns * W + (columns - 1) * GAP;
      const height = HEAD + PAD + rows.reduce((total, value) => total + value, 0) + (rows.length - 1) * GAP + PAD;
      const at = place(width, height);
      markup += '<g class="frame" data-node="' + esc(contour.id) + '" data-kind="contour" data-open="" data-state="' + contour.state + '">'
        + '<rect x="' + at.x + '" y="' + at.y + '" width="' + width + '" height="' + height + '" rx="10"></rect>'
        + '<text class="name" x="' + (at.x + PAD) + '" y="' + (at.y + 18) + '">' + esc(contour.name + ' · ' + contour.kind + ' · ' + counts(contour)) + '</text></g>';
      let top = at.y + HEAD + PAD;
      rows.forEach((rowHeightOf, row) => {
        contour.components.slice(row * columns, row * columns + columns).forEach((component, column) => {
          markup += nodeMarkup(component, at.x + PAD + column * (W + GAP), top, 'component');
        });
        top += rowHeightOf + GAP;
      });
    }
    const shown = visible();
    const arrows = DATA.arrows.filter((arrow) => shown.has(arrow.from) && shown.has(arrow.to));
    const edges = arrows.map((arrow, index) => edgeMarkup(arrow, index)).join('');
    viewport.innerHTML = '<g class="edges">' + edges + '</g>' + markup;
    viewport.setAttribute('data-arrows', String(arrows.length));
    viewport.setAttribute('data-nodes', String(shown.size));
    transform();
  }

  function border(box, toward) {
    const cx = box.x + box.w / 2, cy = box.y + Math.min(box.h, H) / 2;
    const dx = toward.x - cx, dy = toward.y - cy;
    if (dx === 0 && dy === 0) return { x: cx, y: cy };
    const scale = Math.min(Math.abs((box.w / 2) / (dx || 1e-9)), Math.abs((Math.min(box.h, H) / 2) / (dy || 1e-9)));
    return { x: cx + dx * Math.min(scale, 1), y: cy + dy * Math.min(scale, 1) };
  }

  function edgeMarkup(arrow, index) {
    const from = boxes.get(arrow.from), to = boxes.get(arrow.to);
    if (!from || !to) return '';
    const fromCentre = { x: from.x + from.w / 2, y: from.y + Math.min(from.h, H) / 2 };
    const toCentre = { x: to.x + to.w / 2, y: to.y + Math.min(to.h, H) / 2 };
    const start = border(from, toCentre), end = border(to, fromCentre);
    const bend = (CROSSINGS.indexOf(arrow.crossing) + 1) * 14;
    const mx = (start.x + end.x) / 2 - (end.y - start.y) * bend / 400;
    const my = (start.y + end.y) / 2 + (end.x - start.x) * bend / 400;
    const width = Math.min(6, 1 + Math.log2(arrow.count));
    const label = arrow.crossing === 'through' ? arrow.count + ' · contract' : String(arrow.count);
    return '<g class="edge" data-arrow="' + index + '" data-crossing="' + arrow.crossing + '">'
      + '<path d="M ' + start.x + ' ' + start.y + ' Q ' + mx + ' ' + my + ' ' + end.x + ' ' + end.y + '" stroke-width="' + width + '"></path>'
      + '<path class="hit" d="M ' + start.x + ' ' + start.y + ' Q ' + mx + ' ' + my + ' ' + end.x + ' ' + end.y + '"></path>'
      + '<text x="' + mx + '" y="' + my + '">' + esc(label) + '</text>'
      + '<title>' + esc(arrow.crossing + ': ' + arrow.count + ' — ' + arrow.examples.join(', ')) + '</title></g>';
  }

  function transform() {
    viewport.setAttribute('transform', 'translate(' + view.x + ' ' + view.y + ') scale(' + view.k + ')');
  }

  function relationsOf(path) {
    const index = DATA.files.indexOf(path);
    const out = [], into = [];
    for (const relation of DATA.relations) {
      if (relation[0] === index) out.push(relation);
      if (relation[1] === index) into.push(relation);
    }
    const unresolved = DATA.unresolved.filter((entry) => entry[0] === index);
    return { out, into, unresolved };
  }

  function relationItem(relation, other) {
    const at = file(relation[0]) + ':' + relation[2];
    return '<li data-at="' + esc(at) + '" data-crossing="' + CROSSINGS[relation[3]] + '"><a href="' + esc(href(file(relation[0]))) + '">' + esc(at) + '</a> ' + esc(other) + '</li>';
  }

  function show(id) {
    selected = id;
    const group = DATA.groups.find((entry) => entry.id === id);
    const contour = DATA.contours.find((entry) => entry.id === id);
    const component = contour || group ? null : DATA.contours.flatMap((entry) => entry.components).find((entry) => entry.id === id);
    let body;
    if (group) {
      body = '<h2>' + esc(group.name) + '</h2><p data-state="' + group.state + '">' + esc(counts(group)) + '</p><ul>'
        + group.contours.map((member) => '<li>' + esc(DATA.contours.find((entry) => entry.id === member).name) + '</li>').join('') + '</ul>';
    }
    else if (contour) {
      body = '<h2>' + esc(contour.name) + '</h2><p>' + esc(contour.kind + ', declared by ' + contour.declaredBy) + '</p><p data-state="' + contour.state + '">' + esc(counts(contour)) + '</p>'
        + (contour.entries.length === 0 ? '<p class="empty">Declares no public entry.</p>' : '<p>Public entry:</p><ul>' + contour.entries.map((entry) => '<li>' + esc(entry) + '</li>').join('') + '</ul>');
    }
    else if (component) {
      body = '<h2>' + esc(component.name) + '</h2><p>' + esc(component.purpose === null ? 'Not interpreted yet: grouped by directory until discovery names it.' : component.purpose) + '</p><p data-state="' + component.state + '">' + esc(counts(component)) + '</p>';
    }
    else {
      panel.setAttribute('data-file', id);
      const state = DATA.states[DATA.files.indexOf(id)];
      const reason = DATA.reasons[id];
      const found = relationsOf(id);
      body = '<h2>' + esc(id) + '</h2><p data-state="' + state + '">' + esc(state + (reason ? ' — ' + reason : '')) + '</p>'
        + '<p><a href="' + esc(href(id)) + '" data-source="">Open the source</a></p>'
        + '<h3>Reaches (' + found.out.length + ')</h3><ul>' + found.out.map((relation) => relationItem(relation, '→ ' + file(relation[1]))).join('') + found.unresolved.map((entry) => '<li data-at="' + esc(id + ':' + entry[1]) + '" data-state="unknown">' + esc(id + ':' + entry[1] + ' → ' + entry[2] + ' (unresolved)') + '</li>').join('') + '</ul>'
        + '<h3>Reached from (' + found.into.length + ')</h3><ul>' + found.into.map((relation) => relationItem(relation, '← ' + file(relation[0]))).join('') + '</ul>';
      panel.innerHTML = body;
      layout();
      return;
    }
    panel.removeAttribute('data-file');
    panel.innerHTML = body;
    layout();
  }

  function element(selector, value) {
    return Array.from(viewport.querySelectorAll('[' + selector + ']')).find((candidate) => candidate.getAttribute(selector) === value) || null;
  }

  function reveal(path) {
    const contour = contourOfFile.get(path);
    const component = componentOfFile.get(path);
    if (!contour || !component) return false;
    const group = closedGroup(contour);
    if (group) element('data-node', group.id).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    if (!open.has(contour.id)) element('data-node', contour.id).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    if (!expanded.has(component.id)) element('data-node', component.id).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    element('data-file', path).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  }

  viewport.addEventListener('click', (event) => {
    const fileElement = event.target.closest('[data-file]');
    if (fileElement) { show(fileElement.getAttribute('data-file')); return; }
    const node = event.target.closest('[data-node]');
    if (!node) return;
    const id = node.getAttribute('data-node');
    if (node.getAttribute('data-kind') !== 'component') {
      if (open.has(id)) open.delete(id); else open.add(id);
    }
    else if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    show(id);
  });

  viewport.addEventListener('pointerover', (event) => {
    const edge = event.target.closest('[data-arrow]');
    if (!edge) return;
    const arrow = DATA.arrows.filter((entry) => visible().has(entry.from) && visible().has(entry.to))[Number(edge.getAttribute('data-arrow'))];
    if (!arrow) return;
    tip.hidden = false;
    tip.setAttribute('data-crossing', arrow.crossing);
    tip.innerHTML = '<b>' + esc(arrow.count + ' ' + arrow.crossing) + '</b><ul>' + arrow.examples.map((example) => '<li data-at="' + esc(example) + '">' + esc(example) + '</li>').join('') + '</ul>';
  });
  viewport.addEventListener('pointerout', (event) => {
    if (event.target.closest('[data-arrow]')) tip.hidden = true;
  });

  let drag = null;
  svg.addEventListener('pointerdown', (event) => {
    if (event.target.closest('[data-node], [data-file], [data-arrow]')) return;
    drag = { x: event.clientX - view.x, y: event.clientY - view.y };
  });
  svg.addEventListener('pointermove', (event) => {
    if (!drag) return;
    view.x = event.clientX - drag.x;
    view.y = event.clientY - drag.y;
    transform();
  });
  window.addEventListener('pointerup', () => { drag = null; });
  svg.addEventListener('wheel', (event) => {
    event.preventDefault();
    const rect = svg.getBoundingClientRect();
    const px = event.clientX - rect.left, py = event.clientY - rect.top;
    const k = Math.min(4, Math.max(0.15, view.k * Math.exp(-event.deltaY / 400)));
    view.x = px - (px - view.x) * k / view.k;
    view.y = py - (py - view.y) * k / view.k;
    view.k = k;
    transform();
  }, { passive: false });

  search.addEventListener('input', () => {
    const query = search.value.trim().toLowerCase();
    const found = query === '' ? [] : DATA.files.filter((path) => path.split('/').pop().toLowerCase().includes(query) && componentOfFile.has(path)).slice(0, 30);
    results.innerHTML = found.map((path) => '<li><button type="button" data-reveal="' + esc(path) + '">' + esc(path) + '</button></li>').join('');
  });
  results.addEventListener('click', (event) => {
    const button = event.target.closest('[data-reveal]');
    if (button) reveal(button.getAttribute('data-reveal'));
  });

  layout();
  const fit = svg.getBoundingClientRect();
  const drawn = viewport.getBBox();
  if (drawn.width > 0 && fit.width > 0) {
    view.k = Math.min(1, fit.width / (drawn.width + 40), fit.height / (drawn.height + 40));
    view.x = 20;
    view.y = 20;
    transform();
  }
  if (location.hash.length > 1) reveal(decodeURIComponent(location.hash.slice(1)));
})();
`
