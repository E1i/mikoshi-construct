import { SKIN_STYLE } from './skin.js'
import { SWITCH_STYLE } from './switch.js'

export const ATLAS_STYLE = `
${SKIN_STYLE}
${SWITCH_STYLE}
.hint { margin: 0; padding: 0.5rem 0.875rem; color: var(--dim); font-size: 0.78rem; border-block-end: 1px solid var(--line-2); }
.hint b { color: var(--text); font-weight: 600; }
.tools { display: flex; flex-wrap: wrap; gap: 0.5rem 0.875rem; align-items: center; padding: 0.625rem 0.875rem; border-block-end: 1px solid var(--line-2); }
.tool-k { font: 700 0.625rem var(--f-mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--dim); }
.search-wrap { position: relative; flex: 1 1 17.5rem; min-inline-size: 0; display: flex; }
.search-wrap::before { content: ">"; position: absolute; inset-inline-start: 0.625rem; inset-block-start: 50%; translate: 0 -50%; color: var(--signal); font: 700 0.8125rem var(--f-mono); }
#atlas-search { inline-size: 100%; padding: 0.45rem 0.625rem 0.45rem 1.625rem; border: 1px solid var(--wire-glow); background: var(--panel-2); color: var(--text); font: 0.8125rem var(--f-mono); }
#atlas-search:focus { border-color: var(--wire); outline: none; box-shadow: 0 0 0 1px var(--wire), 0 0 14px var(--wire-glow); }
#atlas-search::placeholder { color: var(--dim); }
#atlas-results { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.25rem; font: 0.72rem var(--f-mono); }
#atlas-results:empty { display: none; }
#atlas-results button, #atlas-legend button, #atlas-sort button { cursor: pointer; font: 600 0.6875rem var(--f-mono); letter-spacing: 0.06em; background: transparent; border: 1px solid var(--wire-glow); color: var(--wire); padding: 0.2rem 0.55rem; clip-path: polygon(0.375rem 0, 100% 0, calc(100% - 0.375rem) 100%, 0 100%); }
#atlas-results button:hover, #atlas-sort button:hover { background: var(--wire-soft); border-color: var(--wire); }
#atlas-legend, #atlas-sort { display: flex; flex-wrap: wrap; gap: 0.25rem; align-items: center; }
#atlas-legend button { color: var(--_edge, var(--text)); border-color: var(--_edge, var(--line)); text-transform: uppercase; }
#atlas-legend button::before { content: "■ "; }
#atlas-legend button:hover { background: var(--wire-soft); }
#atlas-legend button[aria-pressed='false'] { opacity: 0.45; text-decoration: line-through; }
#atlas-legend button[aria-pressed='false']::before { content: "□ "; }
#atlas-sort button { text-transform: uppercase; }
#atlas-sort button[aria-pressed='true'] { background: var(--wire); color: var(--void); border-color: var(--wire); }
#atlas-hidden { margin: 0; padding: 0.375rem 0.875rem; color: var(--amber); font: 0.75rem var(--f-mono); border-block-end: 1px solid var(--line-2); }
.canvas { --_canvas: max(28.75rem, calc(100dvh - 9.5rem)); position: relative; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 24rem); }
@container (inline-size <= 52rem) {
  .canvas { grid-template-columns: minmax(0, 1fr); }
  #atlas-panel { position: absolute; inset-inline: 0.5rem; inset-block-end: 0.5rem; max-block-size: 48%; min-block-size: 0; z-index: 2; box-shadow: 0 6px 24px var(--shade); }
}
#atlas-svg { display: block; inline-size: 100%; block-size: var(--_canvas); background: radial-gradient(circle, var(--line) 1px, transparent 1.5px) 0 0 / 1.5rem 1.5rem, var(--panel-2); touch-action: none; cursor: grab; }
#atlas-svg:active { cursor: grabbing; }
#atlas-svg text { font: 0.75rem var(--f-mono); fill: var(--text); pointer-events: none; }
#atlas-svg text.name { font: 700 0.78rem var(--f-display); letter-spacing: 0.06em; }
#atlas-svg text.sub { fill: var(--dim); font-size: 0.6875rem; }
#atlas-svg .box, #atlas-svg .file, #atlas-svg .frame { cursor: pointer; }
#atlas-svg .box rect:first-of-type { fill: var(--_fill); stroke: var(--_c); stroke-width: 1.4; stroke-dasharray: var(--_dash); rx: 2; }
#atlas-svg .box:hover rect:first-of-type { stroke-width: 2.4; filter: drop-shadow(0 0 6px var(--wire-glow)); }
#atlas-svg .box[aria-current] rect:first-of-type { stroke: var(--wire); stroke-width: 3; filter: drop-shadow(0 0 10px var(--wire-glow)); }
#atlas-svg .frame > rect { fill: none; stroke: var(--_c); stroke-width: 1; stroke-dasharray: 8 5; rx: 2; }
#atlas-svg .frame:hover > rect { stroke-width: 2; }
#atlas-svg rect.bar { fill: var(--_c); stroke: none; }
#atlas-svg .file text { fill: var(--_c); pointer-events: auto; }
#atlas-svg .file:hover text { text-decoration: underline; }
#atlas-svg .file[aria-current] text { text-decoration: underline; font-weight: 700; fill: var(--wire); }
#atlas-svg .edge path { fill: none; stroke: var(--_edge); opacity: 0.6; }
#atlas-svg .edge path.hit { stroke: transparent; stroke-width: 12; opacity: 1; }
#atlas-svg .edge text { display: none; fill: var(--_edge); font-size: 0.65625rem; }
#atlas-svg[data-labels] .edge text, #atlas-svg .edge:hover text, #atlas-svg .edge[data-near] text { display: inline; }
#atlas-svg .edge:hover path:first-of-type, #atlas-svg .edge[data-near] path:first-of-type { opacity: 1; stroke-width: 2; }
#atlas-svg [data-dim] { opacity: 0.15; }
#atlas-svg .box[data-near] rect:first-of-type { stroke-width: 2.5; }
#atlas-svg text.mark { fill: var(--unsupported); text-anchor: end; font-weight: 700; }
#atlas-svg .edge[data-crossing='through'] path:first-of-type { stroke-dasharray: 8 4; }
#atlas-svg .edge[data-layer='file'] path:first-of-type { stroke-dasharray: 3 3; }
#atlas-svg .frame[data-layer] > rect { stroke: var(--_c); }
[data-crossing] { --_edge: var(--dim); }
[data-crossing='through'] { --_edge: var(--wire); }
[data-crossing='bypass'] { --_edge: var(--signal); }
[data-crossing='direct'] { --_edge: var(--amber); }
[data-layer] { --_edge: var(--ok); --_c: var(--ok); --_fill: var(--panel); --_dash: none; }
[data-layer='file'] { --_edge: var(--violet); }
#atlas-tip { position: absolute; inset-block-start: 0.625rem; inset-inline-start: 0.625rem; max-inline-size: 28rem; background: var(--panel); border: 1px solid var(--_edge, var(--wire)); padding: 0.375rem 0.625rem; font: 0.75rem var(--f-mono); pointer-events: none; box-shadow: 0 0 16px var(--wire-glow); }
#atlas-tip ul, #atlas-panel ul { list-style: none; margin: 0.25rem 0 0; padding: 0; display: grid; gap: 0.125rem; font: 0.75rem var(--f-mono); }
#atlas-panel { display: grid; align-content: start; gap: 0.375rem; min-block-size: 0; max-block-size: var(--_canvas); overflow: auto; padding: 0.75rem 0.875rem; background: var(--panel); border-inline-start: 1px solid var(--line); font-size: 0.8125rem; }
#atlas-panel:has(> [data-empty-hint]) { align-content: center; text-align: center; }
#atlas-panel > [data-empty-hint] { margin: 0; color: var(--dim); font: 0.75rem/1.8 var(--f-mono); letter-spacing: 0.04em; }
#atlas-panel > [data-empty-hint] b { color: var(--text); letter-spacing: 0.14em; text-transform: uppercase; }
#atlas-panel h2 { margin: 0; padding-block-end: 0.375rem; border-block-end: 1px solid var(--signal); font: 700 0.9375rem var(--f-display); letter-spacing: 0.06em; color: var(--text); overflow-wrap: anywhere; }
#atlas-panel h3 { margin: 0.625rem 0 0; font: 700 0.65625rem var(--f-mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--amber); }
#atlas-panel p { margin: 0; }
#atlas-panel [data-state] { color: var(--_c); font: 0.75rem var(--f-mono); }
#atlas-panel li { padding-block: 0.125rem; border-block-end: 1px dashed var(--line-2); overflow-wrap: anywhere; }
#atlas-panel li[data-crossing='bypass'] { color: var(--signal); }
#atlas-panel a { color: var(--wire); overflow-wrap: anywhere; text-decoration: underline dashed var(--wire-glow); text-underline-offset: 3px; }
#atlas-panel a:hover { background: var(--wire); color: var(--void); text-decoration: none; }
#atlas-panel a[data-source] { display: inline-block; margin-block-start: 0.25rem; padding: 0.2rem 0.55rem; border: 1px solid var(--wire-glow); font: 700 0.6875rem var(--f-mono); letter-spacing: 0.1em; text-transform: uppercase; text-decoration: none; }
#atlas-panel a[data-source]::after { content: " ›"; }
.legend { list-style: none; margin: 0; padding: 0.625rem 0.875rem; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 18.75rem), 1fr)); gap: 0.375rem 1.125rem; font-size: 0.75rem; color: var(--dim); }
.legend li { display: grid; grid-template-columns: 4.75rem 1fr; gap: 0.625rem; align-items: baseline; }
.legend b { font: 700 0.6875rem var(--f-mono); letter-spacing: 0.1em; text-transform: uppercase; }
.legend li[data-state] b { color: var(--_c); }
.legend li[data-crossing] b, .legend li[data-layer] b { color: var(--_edge); }
`
