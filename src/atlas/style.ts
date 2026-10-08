import { PALETTE } from '../model/page.js'

export const ATLAS_STYLE = `
${PALETTE}
* { box-sizing: border-box; }
body { margin: 0; padding: 1.5rem 1rem; background: var(--surface); color: var(--ink); font: 1rem/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-inline-size: 80rem; margin-inline: auto; container: atlas / inline-size; }
h1 { font-size: 1.35rem; margin-block: 0 0.35rem; }
h2 { font-size: 0.8rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-dim); margin-block: 0 0.75rem; }
h3 { font-size: 1rem; margin: 0; }
p.prose { color: var(--ink-dim); margin-block: 0 1rem; max-inline-size: 65ch; }
.map { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(16rem, 100%), 1fr)); gap: 1rem; align-items: start; }
.stage { background: var(--surface-raised); border: 1px solid var(--line); border-radius: 0.6rem; padding: 0.75rem; }
.stage ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.6rem; }
.node { --_c: var(--ink-dim); --_fill: transparent; border: 1.5px solid var(--_c); background: var(--_fill); border-radius: 0.4rem; padding: 0.5rem 0.65rem; scroll-margin-block: 1rem; }
.node[data-state='held'] { --_c: var(--held); --_fill: var(--held-fill); }
.node[data-state='unsupported'] { --_c: var(--unsupported); --_fill: var(--unsupported-fill); }
.node[data-state='unknown'] { --_c: var(--unknown); --_fill: var(--unknown-fill); border-style: dashed; }
.node[data-state='runtime-report'] { --_c: var(--runtime-report); --_fill: var(--runtime-report-fill); border-style: dashed; }
.node:target { outline: 0.2rem solid var(--_c); outline-offset: 0.15rem; }
.node:target::after { content: 'you are here'; display: block; font-size: 0.75rem; color: var(--_c); }
.node a.name { color: inherit; text-decoration: none; }
.node .state { margin: 0; font-size: 0.8rem; color: var(--_c); }
.node:not(:target) .panel { display: none; }
.panel { margin-block-start: 0.5rem; display: grid; gap: 0.4rem; }
details { border-block-start: 1px solid var(--line); padding-block-start: 0.3rem; }
summary { cursor: pointer; font-size: 0.85rem; }
details ul { list-style: none; padding: 0; margin: 0.3rem 0 0; font-size: 0.85rem; display: grid; gap: 0.2rem; }
.panel a { color: var(--runtime-report); }
.empty { color: var(--ink-dim); font-size: 0.85rem; margin: 0; }
.scheme { overflow-x: auto; }
.scheme svg { display: block; min-inline-size: 36rem; }
.box { stroke-width: 1.5; }
.box.held { fill: var(--held-fill); stroke: var(--held); }
.box.unknown { fill: var(--unknown-fill); stroke: var(--unknown); stroke-dasharray: 4 3; }
.label { font: 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace; fill: var(--ink); }
.edge { fill: none; stroke-width: 1.5; opacity: 0.75; }
.edge.held { stroke: var(--held); }
.edge.unknown { stroke: var(--unknown); stroke-dasharray: 4 3; }
section[data-layer='mechanics'] { margin-block-start: 1rem; }
ul.legend { list-style: none; display: flex; flex-wrap: wrap; gap: 0.5rem 1.5rem; padding: 0; margin: 1rem 0 0; font-size: 0.85rem; color: var(--ink-dim); }
ul.legend b { font-weight: 600; }
ul.legend li[data-state='held'] b { color: var(--held); }
ul.legend li[data-state='unsupported'] b { color: var(--unsupported); }
ul.legend li[data-state='unknown'] b { color: var(--unknown); }
ul.legend li[data-state='runtime-report'] b { color: var(--runtime-report); }
footer { margin-block-start: 1.5rem; color: var(--ink-dim); font-size: 0.8rem; }
`
