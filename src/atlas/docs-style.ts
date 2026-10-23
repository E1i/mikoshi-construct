import { SKIN_STYLE } from './skin.js'
import { SWITCH_STYLE } from './switch.js'

export const DOCS_STYLE = `
${SKIN_STYLE}
${SWITCH_STYLE}
.page { --_page: 80rem; }
.cols { display: grid; grid-template-columns: minmax(13.75rem, 18.75rem) minmax(0, 1fr); gap: var(--gap); align-items: start; }
.toc { position: sticky; inset-block-start: 3.5rem; max-block-size: calc(100dvh - 4.5rem); overflow: auto; padding-block-end: 0.625rem; font: 0.75rem var(--f-mono); scrollbar-color: var(--signal) var(--panel); }
@container (inline-size <= 54rem) {
  .cols { grid-template-columns: minmax(0, 1fr); }
  .toc { position: static; max-block-size: none; }
}
.toc ul { list-style: none; margin: 0; padding-block: 0.375rem; border-block-end: 1px solid var(--line-2); }
.toc li a { display: block; padding: 0.2rem 0.875rem; color: var(--wire); text-decoration: none; overflow-wrap: anywhere; border-inline-start: 2px solid transparent; }
.toc li a:hover { background: var(--wire-soft); border-inline-start-color: var(--wire); }
.toc li b a { color: var(--text); font: 700 0.75rem var(--f-display); letter-spacing: 0.08em; text-transform: uppercase; }
.reading { display: grid; gap: var(--gap); }
.summary { margin: 0; font-weight: 600; }
.prose { margin: 0; color: var(--dim); max-inline-size: 72ch; }
.chapter { padding: 0 0.875rem 0.875rem; scroll-margin-block-start: 4rem; }
.chapter > .ph { margin: 0 -0.875rem 0.625rem; }
.chapter > .notice { margin-block-end: 0.5rem; }
article { display: grid; gap: 0.25rem; margin-block-start: 0.5rem; padding: 0.625rem 0.875rem; border: 1px solid var(--line); border-inline-start: 3px solid var(--_c); background: var(--_fill); scroll-margin-block-start: 4rem; }
article:target { outline: 2px solid var(--wire); outline-offset: 2px; box-shadow: 0 0 18px var(--wire-glow); }
article h3 { margin: 0; font: 700 0.875rem var(--f-display); letter-spacing: 0.06em; overflow-wrap: anywhere; }
article p { margin: 0; max-inline-size: 78ch; }
article .state { font: 700 0.65625rem var(--f-mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--_c); }
article .status { font: 0.75rem var(--f-mono); color: var(--dim); }
article .does b { font: 700 0.65625rem var(--f-mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--dim); margin-inline-end: 0.375rem; }
article ul { margin: 0.125rem 0; padding-inline-start: 1.2rem; font-size: 0.8125rem; }
article li[data-state] { color: var(--_c); }
article a { color: var(--wire); text-decoration: underline dashed var(--wire-glow); text-underline-offset: 3px; font: 0.78rem var(--f-mono); }
article a:hover { background: var(--wire); color: var(--void); text-decoration: none; }
details > summary { cursor: pointer; font: 600 0.75rem var(--f-mono); color: var(--wire); list-style: none; padding-block: 0.125rem; }
details > summary::-webkit-details-marker { display: none; }
details > summary::before { content: "▸ "; color: var(--signal); }
details[open] > summary::before { content: "▾ "; }
details > summary:hover { text-decoration: underline; }
.tree { list-style: none; margin: 0.125rem 0; padding-inline-start: 0.875rem; border-inline-start: 1px dashed var(--line); font: 0.75rem var(--f-mono); color: var(--text); }
.tree li { padding-block: 0.0625rem; }
`
