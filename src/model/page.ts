export const PALETTE = `:root {
  color-scheme: light dark;
  --surface: light-dark(#fbfbfd, #14161a);
  --surface-raised: light-dark(#ffffff, #1c1f25);
  --ink: light-dark(#1a1d23, #e6e8ec);
  --ink-dim: light-dark(#5a6270, #99a1b0);
  --line: light-dark(#d6dae1, #2e333c);
  --held: light-dark(#1f7a4d, #4ec98a);
  --unsupported: light-dark(#b3261e, #ff8a80);
  --unknown: light-dark(#8a6d1f, #e3c46a);
  --runtime-report: light-dark(#3b5bab, #8fa8f0);
  --held-fill: light-dark(#e9f7ef, #16302433);
  --unsupported-fill: light-dark(#fdecea, #3a191733);
  --unknown-fill: light-dark(#fdf5e2, #332c1233);
  --runtime-report-fill: light-dark(#ebf0fb, #1a223a33);
}`

export function escaped(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
