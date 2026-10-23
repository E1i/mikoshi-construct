export const SKIN_STYLE = `
:root {
  color-scheme: light dark;
  --void: light-dark(#f1efe9, #07080d);
  --panel: light-dark(#fbfaf6, #0d1018);
  --panel-2: light-dark(#f5f3ec, #0a0d14);
  --line: light-dark(#d9d4c7, #232a3a);
  --line-2: light-dark(#e6e1d5, #1a2030);
  --text: light-dark(#1b1d26, #c9d1e4);
  --dim: light-dark(#5d6274, #7a85a0);
  --signal: light-dark(#d4183c, #ff3b5c);
  --signal-soft: light-dark(#d4183c14, #ff3b5c22);
  --wire: light-dark(#007f86, #2de2e6);
  --wire-soft: light-dark(#007f8612, #2de2e61a);
  --wire-glow: light-dark(#007f8640, #2de2e655);
  --amber: light-dark(#9a6a00, #f5c542);
  --ok: light-dark(#1f7a4d, #5fe08a);
  --violet: light-dark(#6b3fc4, #b48cff);
  --grid: light-dark(#e3ded2, #232a3a);
  --scan: light-dark(transparent, #ffffff06);
  --glow: light-dark(transparent, #ff3b5c55);
  --shade: light-dark(#0003, #0008);
  --surface: var(--void);
  --surface-raised: var(--panel);
  --ink: var(--text);
  --ink-dim: var(--dim);
  --held: var(--ok);
  --unsupported: var(--signal);
  --unknown: var(--amber);
  --runtime-report: var(--wire);
  --held-fill: light-dark(#1f7a4d0f, #5fe08a14);
  --unsupported-fill: light-dark(#d4183c12, #ff3b5c1c);
  --unknown-fill: light-dark(#9a6a0012, #f5c54214);
  --runtime-report-fill: light-dark(#007f8610, #2de2e614);
  --f-display: "Eurostile", "Bank Gothic", ui-sans-serif, system-ui, sans-serif;
  --f-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  --f-body: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --cut: 0.875rem;
  --gap: 0.875rem;
  --pad-inline: max(1rem, env(safe-area-inset-left, 0px));
}
:root[data-theme='light'] { color-scheme: light; }
:root[data-theme='dark'] { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { min-block-size: 100%; }
body {
  margin: 0;
  color: var(--text);
  font: 0.875rem/1.55 var(--f-body);
  background: linear-gradient(var(--grid) 1px, transparent 1px) -1px -1px / 3rem 3rem, linear-gradient(90deg, var(--grid) 1px, transparent 1px) -1px -1px / 3rem 3rem, var(--void);
}
body::after { content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 50; background: repeating-linear-gradient(0deg, var(--scan) 0 1px, transparent 1px 3px); }
button, input { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }
.topbar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.625rem 1rem; padding: 0.625rem var(--pad-inline); border-block-end: 1px solid var(--line); background: var(--panel); position: sticky; inset-block-start: 0; z-index: 20; }
.mark { display: flex; align-items: baseline; gap: 0.625rem; font: 700 0.8125rem var(--f-display); letter-spacing: 0.24em; text-transform: uppercase; color: var(--signal); text-shadow: -1px 0 var(--wire), 0 0 12px var(--glow); }
.mark small { font: 600 0.65625rem var(--f-mono); letter-spacing: 0.08em; text-transform: none; color: var(--dim); text-shadow: none; }
.topbar > .mark + * { margin-inline-start: auto; }
.theme { cursor: pointer; background: transparent; border: 1px solid var(--wire-glow); color: var(--wire); font: 700 0.6875rem var(--f-mono); letter-spacing: 0.12em; text-transform: uppercase; padding: 0.3rem 0.625rem; }
.theme:hover { background: var(--wire-soft); border-color: var(--wire); }
.page { display: grid; gap: var(--gap); padding: var(--gap) var(--pad-inline) 1.5rem; max-inline-size: var(--_page, 100rem); margin-inline: auto; container-type: inline-size; }
.page > * { min-inline-size: 0; }
.hero { display: grid; gap: 0.625rem; padding: 1.125rem 1.375rem; border: 1px solid var(--signal); background: radial-gradient(120% 160% at 0% 0%, var(--signal-soft), transparent 55%), var(--panel); clip-path: polygon(0 0, calc(100% - 1.375rem) 0, 100% 1.375rem, 100% 100%, 1.375rem 100%, 0 calc(100% - 1.375rem)); }
.eyebrow { display: flex; flex-wrap: wrap; gap: 0.375rem 0.875rem; font: 700 0.6875rem var(--f-mono); letter-spacing: 0.2em; text-transform: uppercase; color: var(--signal); }
.eyebrow span { color: var(--dim); letter-spacing: 0.08em; }
.repo { margin: 0; font: 700 clamp(1.625rem, 4.6cqi, 2.875rem)/1.02 var(--f-display); letter-spacing: 0.06em; text-wrap: balance; overflow-wrap: anywhere; }
.stats { display: flex; flex-wrap: wrap; gap: 1px; background: var(--line); border: 1px solid var(--line); margin-block-start: 0.25rem; }
.stat { flex: 1; display: grid; min-inline-size: 7rem; padding: 0.5rem 0.875rem; background: var(--panel-2); }
.stat b { font: 700 1.375rem var(--f-display); letter-spacing: 0.04em; font-variant-numeric: tabular-nums; color: var(--_c, var(--text)); }
.stat span { font: 600 0.625rem var(--f-mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--dim); }
.meter { display: block; inline-size: 100%; block-size: 0.375rem; background: var(--line); }
.meter rect { fill: var(--_c); }
.panelbox { min-inline-size: 0; background: var(--panel); border: 1px solid var(--line); clip-path: polygon(0 0, calc(100% - var(--cut)) 0, 100% var(--cut), 100% 100%, var(--cut) 100%, 0 calc(100% - var(--cut))); }
.ph { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.75rem; padding: 0.5rem 0.875rem; border-block-end: 1px solid var(--line); background: linear-gradient(90deg, var(--signal-soft), transparent 60%); }
.ph h2 { margin: 0; font: 700 0.9375rem/1 var(--f-display); letter-spacing: 0.18em; text-transform: uppercase; color: var(--signal); overflow-wrap: anywhere; }
.ph h2::before { content: "▌"; color: var(--wire); margin-inline-end: 0.375rem; }
.ph .meta { color: var(--dim); font: 0.6875rem var(--f-mono); letter-spacing: 0.04em; }
.ph .meta + .meta { margin-inline-start: auto; }
.notice { margin: 0; padding: 0.5rem 0.75rem; border-inline-start: 3px solid var(--amber); background: var(--unknown-fill); font-size: 0.8125rem; max-inline-size: 80ch; }
.notice code { font: 0.75rem var(--f-mono); color: var(--amber); }
footer.status { display: flex; flex-wrap: wrap; font: 0.72rem var(--f-mono); border: 1px solid var(--line); background: var(--panel); }
footer.status span { padding: 0.3rem 0.75rem; border-inline-end: 1px solid var(--line); color: var(--dim); }
footer.status b { color: var(--text); font-weight: 600; }
footer.status .mode { background: var(--signal); color: var(--void); font-weight: 700; letter-spacing: 0.12em; }
footer.status .cursor { margin-inline-start: auto; }
footer.status .cursor::after { content: "█"; color: var(--wire); margin-inline-start: 0.25rem; animation: --animation-atlas-cursor-blink 1s steps(1) infinite; }
@keyframes --animation-atlas-cursor-blink { 50% { opacity: 0.2; } }
@media (prefers-reduced-motion: reduce) { footer.status .cursor::after { animation: none; } }
[data-state='held'] { --_c: var(--held); --_fill: var(--held-fill); --_line: solid; --_dash: none; }
[data-state='unsupported'] { --_c: var(--unsupported); --_fill: var(--unsupported-fill); --_line: solid; --_dash: none; }
[data-state='unknown'] { --_c: var(--unknown); --_fill: var(--unknown-fill); --_line: dashed; --_dash: 4 3; }
[data-state='runtime-report'] { --_c: var(--runtime-report); --_fill: var(--runtime-report-fill); --_line: dashed; --_dash: 4 3; }
[data-state='absent'] { --_c: var(--unsupported); --_fill: var(--unsupported-fill); --_line: solid; --_dash: 2 2; }
.empty { color: var(--dim); }
`
