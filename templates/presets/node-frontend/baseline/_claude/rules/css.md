---
paths:
  - "**/*.css"
  - "**/*.vue"
  - "**/*.astro"
---

# CSS

Modern, platform-native CSS. No preprocessor — nesting, custom properties, colour functions and
container queries are all in the language now.

## State as attributes, variants as custom properties

- **Everything that crosses from JS into CSS crosses as an attribute.** Templates and scripts toggle
  `data-*`, or an ARIA attribute where one already carries the meaning (`aria-expanded`,
  `aria-pressed`, `aria-checked`, `[hidden]`). JS does not add or remove styling classes and does not
  write inline styles for state.
- **An attribute selector re-binds custom properties; it does not restate declarations.** The block
  declares its private `--_*` properties and consumes them once; each variant only changes the values.
- Classes name *things* — a component, a layout primitive, a utility — and stay where they are genuinely
  useful as hooks. They never encode state or variant: no `--modifier` classes, no new `.is-*`.

```css
/* ✅ */
.pill {
  --_bg: var(--color-surface-container-high);
  --_fg: var(--color-on-surface);
  --_bd: transparent;

  background: var(--_bg);
  color: var(--_fg);
  border: 1px solid var(--_bd);

  &[data-tone='info'] { --_bg: var(--color-info-bg); --_fg: var(--color-info); }
  &[data-outlined]    { --_bg: transparent; --_bd: var(--color-primary); }
}

/* ❌ modifier classes toggled from JS, declarations restated per variant */
.pill--info { background: …; color: …; border: …; }
```

## Nesting

Native CSS nesting with `&`. Nest to express relationship — variants, states, parts — not to mirror
the DOM tree depth-for-depth.

## Container queries over media queries

- `@media` is for **preferences and devices**: `prefers-reduced-motion`, `pointer: coarse`, print. A
  width-based `@media` is an anti-pattern — a component should react to the space it is in, not to the
  viewport.
- Use `@container` with range syntax: `@container (inline-size <= 48rem) { … }`. Keep the breakpoints
  as rem tokens (`--bp-cq-md: 48rem`). Name a container (`container: split-card / inline-size`) once
  more than one rule targets it.
- Use **style container queries** when a parent decides a child's layout mode: the host sets
  `container-type: inline-size` and stamps a custom property; descendants read it.

```css
.u-section { container-type: inline-size; --cq-size: lg; }
@container (inline-size <= 48rem) { .u-section > * { --cq-size: sm; } }
@container style(--cq-size: lg) { .bento-grid { grid-template-columns: repeat(3, 1fr); } }
```

- Theming is `color-scheme: light dark` plus `light-dark()`, not `@media (prefers-color-scheme)`.

## Logical properties

`inline-size` / `block-size`, `min-` and `max-inline-size`, `padding-inline` / `padding-block`,
`margin-inline` / `margin-block`, `inset-block-start` / `inset-inline-start`, `border-inline`,
`text-align: start`. Physical `width` / `height` / `top` / `left` survive only where the value really is
physical: SVG geometry attributes, hairlines, `minmax()` track sizes.

## Units — relative by default, and the right relative one

- `rem` for length and spacing; `em` for what should scale with the element's own font size (icon
  `inline-size: 1em`, letter-spacing); `ch` for measure (`--body-max-inline-size: 65ch`); `lh` for
  vertical rhythm (`padding: 0.25lh 1ch`); `%` / `fr` / `vi` where that *is* the meaning.
- `px` only for hairlines, shadow offsets and 1px-scale detail — never for spacing or type.
- Fluid type and space come from `clamp()` on a scale, not from size swaps at breakpoints.
- This is a default, not a purity test: pick the unit that expresses the intent.

## Custom properties and tokens

Colour, space, radius, duration and z-index come from tokens — a raw value in a component is a missing
token. `--_name` marks a component-private property. Derive colours with relative colour syntax
(`oklch(from var(--color-primary) calc(l + 0.08) c h)`) rather than hand-picking shades.

## Smart layouts

Layout is a small set of reusable primitives that respond to available space **intrinsically** — no
breakpoints, no per-component grid code. Compose pages from them; when none fits, add a primitive to
the shared stylesheet rather than a one-off grid to a component.

- **Page shell, named grid lines.** One grid declares `[full-start] … [popout-start] …
  [content-start] … [narrow-start] …` tracks; children default to `grid-column: content` and opt out
  with `.layout-full` / `.layout-popout` / `.layout-narrow`. Full-bleed comes from the shell, never
  from negative margins or `100vw`.
- **Card grids, `auto-fit` / `auto-fill` + `minmax`.**
  `grid-template-columns: repeat(auto-fit, minmax(min(var(--card-min-width), 100%), 1fr))`. The inner
  `min(…, 100%)` is what stops it overflowing a narrow container — it is required, not decoration.
  `auto-fit` when the row should stretch to fill, `auto-fill` when empty tracks must be kept.
- **Parameterised by custom properties and `data-*`, never by variant classes.** A caller retunes a
  primitive by setting `--card-min-width` / `--column-inline-size` / `--grid-gap`, or by stamping an
  attribute the CSS reads directly.

```css
.grid-auto-fit-max-column-count {
  --_max-cols: 3;
  --_max-cols: attr(data-max-cols type(<number>), 3);
  --_min-col: var(--column-inline-size, var(--card-min-width));
  --_col-size: calc((100% - (var(--_max-cols) - 1) * var(--grid-gap)) / var(--_max-cols));

  display: grid;
  gap: var(--grid-gap);
  grid-template-columns: repeat(auto-fit, minmax(min(100%, max(var(--_min-col), var(--_col-size))), 1fr));
}
```

```html
<ul class="grid-auto-fit-max-column-count" data-max-cols="4">
```

(The plain `--_max-cols: 3` line above the typed `attr()` is the fallback for engines without typed
`attr()`; keep both.)

- **Line layouts.** One wrapping flex primitive — `display: flex; flex-wrap: wrap; gap: var(--_gap);
  align-items: center` with `--_gap` overridable — before writing another one-off flex row.
- **Mode switches.** Where a layout must change *shape* rather than reflow, the host stamps `--cq-size`
  and the shape lives behind `@container style(--cq-size: lg)`.
- `gap` is the spacing mechanism; margins between siblings are a smell. `subgrid` when a child must
  align to an ancestor's tracks. Respect a project's `@layer` order and put a component's styles in the
  layer its siblings use.

## Animations

Keyframe animations use **dashed idents** with an `--animation-` prefix.

```css
/* ✅ */
@keyframes --animation-charities-skeleton-pulse { /* … */ }
.el {
  animation: --animation-charities-skeleton-pulse 1.4s ease-in-out infinite;
}

/* ❌ bare names */
@keyframes charities-skeleton-pulse { /* … */ }
.el {
  animation: fade-in 0.3s ease;
}
```

- Declare as `@keyframes --animation-<descriptive-name>`, reference via
  `animation: --animation-<descriptive-name> …` or `animation-name: --animation-<descriptive-name>`.
- `animation: none` is fine.
- This is only about `@keyframes` / `animation-name`. Do **not** rename transition tokens
  (`--transition-base` and friends).
- Applies to `.css` files and to `<style>` blocks in `.astro` / `.vue` components alike.
