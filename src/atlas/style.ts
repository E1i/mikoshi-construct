import { PALETTE } from '../model/page.js'
import { SWITCH_STYLE } from './switch.js'

export const ATLAS_STYLE = `
${PALETTE}
${SWITCH_STYLE}
* { box-sizing: border-box; }
body { margin: 0; padding: 1.5rem 1rem; background: var(--surface); color: var(--ink); font: 1rem/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-inline-size: 80rem; margin-inline: auto; }
h1 { font-size: 1.35rem; margin-block: 0 0.35rem; }
h2 { font-size: 0.8rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-dim); margin-block: 0 0.75rem; }
h3 { font-size: 1rem; margin: 0; }
p.prose { color: var(--ink-dim); margin-block: 0 1rem; max-inline-size: 65ch; }
.map { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(16rem, 100%), 1fr)); gap: 1rem; align-items: start; }
.stage { background: var(--surface-raised); border: 1px solid var(--line); border-radius: 0.6rem; padding: 0.75rem; }
.stage ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.6rem; }
[data-state='held'] { --_c: var(--held); --_fill: var(--held-fill); --_line: solid; --_dash: none; }
[data-state='unsupported'] { --_c: var(--unsupported); --_fill: var(--unsupported-fill); --_line: solid; --_dash: none; }
[data-state='unknown'] { --_c: var(--unknown); --_fill: var(--unknown-fill); --_line: dashed; --_dash: 4 3; }
[data-state='runtime-report'] { --_c: var(--runtime-report); --_fill: var(--runtime-report-fill); --_line: dashed; --_dash: 4 3; }
.node { border: 0.1rem var(--_line) var(--_c); background: var(--_fill); border-radius: 0.4rem; padding: 0.5rem 0.65rem; scroll-margin-block: 1rem; }
.node:target { outline: 0.2rem solid var(--_c); outline-offset: 0.15rem; }
.node a.name { color: inherit; text-decoration: none; }
.node .state, .node .here { margin: 0; font-size: 0.8rem; color: var(--_c); }
.node:not(:target) .panel { display: none; }
.panel { margin-block-start: 0.5rem; display: grid; gap: 0.4rem; }
details { border-block-start: 1px solid var(--line); padding-block-start: 0.3rem; }
summary { cursor: pointer; font-size: 0.85rem; }
details ul { list-style: none; padding: 0; margin-block: 0.3rem 0; margin-inline: 0; font-size: 0.85rem; display: grid; gap: 0.2rem; }
details li[data-state] { color: var(--_c); }
.panel a { color: var(--runtime-report); }
.empty { color: var(--ink-dim); font-size: 0.85rem; margin: 0; }
.atlas-map { margin-block-end: 1.5rem; }
.atlas-map .tools { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: start; margin-block-end: 0.5rem; }
#atlas-search { font: inherit; padding: 0.3rem 0.6rem; border: 1px solid var(--line); border-radius: 0.4rem; background: var(--surface-raised); color: var(--ink); min-inline-size: 16rem; }
#atlas-results { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.3rem; font-size: 0.8rem; }
#atlas-results button { font: inherit; cursor: pointer; border: 1px solid var(--line); border-radius: 1rem; background: var(--surface-raised); color: var(--ink); padding: 0.1rem 0.6rem; }
.canvas { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 22rem); gap: 0.75rem; }
@container (inline-size <= 48rem) { .canvas { grid-template-columns: minmax(0, 1fr); } }
main { container-type: inline-size; }
#atlas-svg { inline-size: 100%; block-size: 70vh; background: var(--surface-raised); border: 1px solid var(--line); border-radius: 0.6rem; touch-action: none; cursor: grab; }
#atlas-svg text { font: 0.75rem ui-monospace, SFMono-Regular, Menlo, monospace; fill: var(--ink); pointer-events: none; }
#atlas-svg text.name { font-weight: 600; font-size: 0.8rem; }
#atlas-svg text.sub { fill: var(--ink-dim); }
#atlas-svg .box, #atlas-svg .file, #atlas-svg .frame { cursor: pointer; }
#atlas-svg .box rect:first-of-type { fill: var(--_fill); stroke: var(--_c); stroke-width: 1.5; stroke-dasharray: var(--_dash); }
#atlas-svg .box[aria-current] rect:first-of-type { stroke-width: 3; }
#atlas-svg .frame > rect { fill: none; stroke: var(--_c); stroke-width: 1; stroke-dasharray: 6 4; }
#atlas-svg rect.bar { fill: var(--_c); stroke: none; }
#atlas-svg .file text { fill: var(--_c); pointer-events: auto; }
#atlas-svg .file[aria-current] text { text-decoration: underline; font-weight: 600; }
#atlas-svg .edge path { fill: none; stroke: var(--_edge); opacity: 0.7; }
#atlas-svg .edge path.hit { stroke: transparent; stroke-width: 12; opacity: 1; }
#atlas-svg .edge text { fill: var(--_edge); font-size: 0.7rem; }
#atlas-svg .edge:hover path:first-of-type { opacity: 1; }
[data-state='absent'] { --_c: var(--unsupported); --_fill: var(--unsupported-fill); --_line: solid; --_dash: 2 2; }
[data-crossing] { --_edge: var(--ink-dim); }
[data-crossing='through'] { --_edge: var(--runtime-report); }
[data-crossing='bypass'] { --_edge: var(--unsupported); }
#atlas-svg .edge[data-crossing='through'] path:first-of-type { stroke-dasharray: 8 4; }
[data-layer] { --_edge: var(--held); --_c: var(--held); --_fill: var(--surface); --_dash: none; }
[data-layer='file'] { --_edge: var(--runtime-report); }
#atlas-svg .edge[data-layer='file'] path:first-of-type { stroke-dasharray: 3 3; }
#atlas-svg .frame[data-layer] > rect { stroke: var(--_c); }
ul.legend li[data-layer] b { color: var(--_edge); }
#atlas-tip { position: absolute; inset-block-start: 0.5rem; inset-inline-start: 0.5rem; max-inline-size: 28rem; background: var(--surface); border: 1px solid var(--_edge); border-radius: 0.4rem; padding: 0.4rem 0.6rem; font-size: 0.8rem; pointer-events: none; }
#atlas-tip ul, #atlas-panel ul { list-style: none; margin: 0.2rem 0 0; padding: 0; display: grid; gap: 0.15rem; font-size: 0.8rem; }
#atlas-panel { background: var(--surface-raised); border: 1px solid var(--line); border-radius: 0.6rem; padding: 0.6rem 0.75rem; max-block-size: 70vh; overflow: auto; font-size: 0.85rem; }
#atlas-panel:empty { display: none; }
#atlas-panel h2 { text-transform: none; letter-spacing: 0; color: var(--ink); font-size: 0.95rem; overflow-wrap: anywhere; }
#atlas-panel h3 { font-size: 0.8rem; margin-block: 0.6rem 0; color: var(--ink-dim); }
#atlas-panel [data-state] { color: var(--_c); }
#atlas-panel li[data-crossing='bypass'] { color: var(--unsupported); }
#atlas-panel a { color: var(--runtime-report); overflow-wrap: anywhere; }
ul.legend li[data-crossing] b { color: var(--_edge); }
ul.legend { list-style: none; display: flex; flex-wrap: wrap; gap: 0.5rem 1.5rem; padding: 0; margin: 1rem 0 0; font-size: 0.85rem; color: var(--ink-dim); }
ul.legend b { font-weight: 600; }
ul.legend li[data-state] b { color: var(--_c); }
footer { margin-block-start: 1.5rem; color: var(--ink-dim); font-size: 0.8rem; }
`
