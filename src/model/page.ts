import type { ModelGraph, PictureState } from './graph.js'
import { PICTURE_STATES } from './graph.js'
import { COLOUR_IS_NOT_STRENGTH, STATE_LEGEND, svgFromGraph } from './svg.js'

export interface PageMeta {
  title: string
  prose: string
  generatedFrom: string
}

const STYLE = `
:root {
  color-scheme: light dark;
  --surface: light-dark(#fbfbfd, #14161a);
  --surface-raised: light-dark(#ffffff, #1c1f25);
  --ink: light-dark(#1a1d23, #e6e8ec);
  --ink-dim: light-dark(#5a6270, #99a1b0);
  --line: light-dark(#d6dae1, #2e333c);
  --held: light-dark(#1f7a4d, #4ec98a);
  --unsupported: light-dark(#b3261e, #ff8a80);
  --unknown: light-dark(#8a6d1f, #e3c46a);
  --held-fill: light-dark(#e9f7ef, #16302433);
  --unsupported-fill: light-dark(#fdecea, #3a191733);
  --unknown-fill: light-dark(#fdf5e2, #332c1233);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 2rem 1rem;
  background: var(--surface);
  color: var(--ink);
  font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-inline-size: 76rem; margin-inline: auto; }
h1 { font-size: 1.35rem; margin: 0 0 0.35rem; }
p.prose { color: var(--ink-dim); margin: 0 0 1.25rem; max-inline-size: 62ch; }
figure { margin: 0; overflow-x: auto; background: var(--surface-raised); border: 1px solid var(--line); border-radius: 10px; padding: 0.5rem; }
svg { display: block; }
.box { stroke-width: 1.5; }
.box.held { fill: var(--held-fill); stroke: var(--held); }
.box.unsupported { fill: var(--unsupported-fill); stroke: var(--unsupported); }
.box.unknown { fill: var(--unknown-fill); stroke: var(--unknown); }
.label { font: 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace; fill: var(--ink-dim); }
.label.first { font-weight: 600; fill: var(--ink); }
.heading { font: 600 12px/1 ui-sans-serif, system-ui, sans-serif; fill: var(--ink-dim); letter-spacing: 0.06em; text-transform: uppercase; }
.stage { font: 11px/1 ui-sans-serif, system-ui, sans-serif; fill: var(--ink-dim); paint-order: stroke; stroke: var(--surface-raised); stroke-width: 3px; }
.edge { fill: none; stroke-width: 1.5; opacity: 0.75; }
.edge.held { stroke: var(--held); }
.edge.unsupported { stroke: var(--unsupported); }
.edge.unknown { stroke: var(--unknown); }
ul.legend { list-style: none; display: flex; flex-wrap: wrap; gap: 0.75rem 1.5rem; padding: 0; margin: 1.25rem 0 0; }
ul.legend li { display: flex; align-items: baseline; gap: 0.5rem; color: var(--ink-dim); font-size: 0.85rem; }
ul.legend b { font-weight: 600; }
ul.legend li[data-state='held'] b { color: var(--held); }
ul.legend li[data-state='unsupported'] b { color: var(--unsupported); }
ul.legend li[data-state='unknown'] b { color: var(--unknown); }
p.legend-caveat { margin: 0.6rem 0 0; color: var(--ink-dim); font-size: 0.85rem; max-inline-size: 72ch; }
footer { margin-block-start: 1.5rem; color: var(--ink-dim); font-size: 0.8rem; }
`

function escaped(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function legend(states: Set<PictureState>): string {
  return PICTURE_STATES
    .filter(state => states.has(state))
    .map(state => `      <li data-state="${state}"><b>${state}</b> — ${escaped(STATE_LEGEND[state])}</li>`)
    .join('\n')
}

export function htmlFromGraph(graph: ModelGraph, meta: PageMeta): string {
  const states = new Set(graph.nodes.map(node => node.state))
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escaped(meta.title)}</title>
<style>${STYLE}</style>
</head>
<body>
  <main>
    <h1>${escaped(meta.title)}</h1>
    <p class="prose">${escaped(meta.prose)}</p>
    <figure>
${svgFromGraph(graph).split('\n').map(line => `      ${line}`).join('\n')}
    </figure>
    <ul class="legend">
${legend(states)}
    </ul>
    <p class="legend-caveat">${escaped(COLOUR_IS_NOT_STRENGTH)}</p>
    <footer>Every state is derived on read, never stored. Rendered from ${escaped(meta.generatedFrom)} by construct graph; nothing here is fetched when you open it.</footer>
  </main>
</body>
</html>
`
}
