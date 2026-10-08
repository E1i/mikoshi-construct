import { PALETTE } from '../model/page.js'
import { SWITCH_STYLE } from './switch.js'

export const DOCS_STYLE = `
${PALETTE}
${SWITCH_STYLE}
* { box-sizing: border-box; }
body { margin: 0; background: var(--surface); color: var(--ink); font: 1rem/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.layout { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(16rem, 100%), 1fr)); max-inline-size: 80rem; margin-inline: auto; }
.toc { padding: 1.5rem 1rem; border-inline-end: 1px solid var(--line); font-size: 0.85rem; align-self: start; }
.toc ul { list-style: none; margin: 0 0 0.75rem; padding: 0; display: grid; gap: 0.15rem; }
.toc a { color: var(--ink-dim); text-decoration: none; }
.toc a:hover { color: var(--ink); }
.toc b { display: block; margin-block-end: 0.15rem; }
main { padding: 1.5rem 1rem; grid-column: span 3; max-inline-size: 65ch; }
h1 { font-size: 1.5rem; margin-block: 0 0.5rem; }
h2 { font-size: 1.2rem; margin-block: 2rem 0.5rem; padding-block-end: 0.3rem; border-block-end: 1px solid var(--line); }
h3 { font-size: 1rem; margin: 0; }
[data-state='held'] { --_c: var(--held); --_fill: var(--held-fill); }
[data-state='unsupported'] { --_c: var(--unsupported); --_fill: var(--unsupported-fill); }
[data-state='unknown'] { --_c: var(--unknown); --_fill: var(--unknown-fill); }
[data-state='runtime-report'] { --_c: var(--runtime-report); --_fill: var(--runtime-report-fill); }
article { border-inline-start: 0.2rem solid var(--_c); background: var(--_fill); padding: 0.5rem 0.75rem; margin-block: 0.75rem; border-radius: 0.3rem; scroll-margin-block: 1rem; }
article:target { outline: 0.2rem solid var(--_c); }
article .state { margin: 0; font-size: 0.8rem; color: var(--_c); }
article p { margin-block: 0.3rem; }
article ul { margin-block: 0.2rem; padding-inline-start: 1.2rem; font-size: 0.9rem; }
article li[data-state] { color: var(--_c); }
article a { color: var(--runtime-report); }
.empty, p.prose, footer { color: var(--ink-dim); font-size: 0.85rem; }
`
