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
.scheme { overflow-x: auto; }
.scheme svg { display: block; min-inline-size: 36rem; }
.scheme rect { fill: var(--_fill); stroke: var(--_c); stroke-width: 1.5; stroke-dasharray: var(--_dash); }
.scheme text { font: 0.75rem ui-monospace, SFMono-Regular, Menlo, monospace; fill: var(--ink); }
.scheme path { fill: none; stroke: var(--_c); stroke-width: 1.5; stroke-dasharray: var(--_dash); opacity: 0.75; }
section[data-layer='mechanics'] { margin-block-start: 1rem; }
ul.legend { list-style: none; display: flex; flex-wrap: wrap; gap: 0.5rem 1.5rem; padding: 0; margin: 1rem 0 0; font-size: 0.85rem; color: var(--ink-dim); }
ul.legend b { font-weight: 600; }
ul.legend li[data-state] b { color: var(--_c); }
footer { margin-block-start: 1.5rem; color: var(--ink-dim); font-size: 0.8rem; }
`
