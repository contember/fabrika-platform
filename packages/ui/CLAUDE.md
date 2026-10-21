# @fabrika/ui

The paved-road React component kit for internal admin screens: shell, page header, tabs, filters, form fields, data
table, dialogs, toasts, timeline, state blocks, layout helpers, and a typed History API router. Public package; React 19
is a peer dependency.

## Commands

```bash
bun run --filter @fabrika/ui typecheck
bun test --isolate packages/ui        # happy-dom; import src/__tests__/dom.ts FIRST in every test file
```

## Invariants

- **Tokens live only in `src/theme.css`** — custom properties and nothing else, `:root` for light and
  `:root[data-theme='dark']` for dark, same names. Prefix `--fui-`.
- **`src/components.css` styles only through `var(--fui-*)`.** No literal colours; no literal sizes beyond `0`, `1px`
  hairlines and percentages. The breakpoint is the one exception (a custom property cannot appear in a media query).
- Class names are `fui-<component>[__part][--modifier]`. Bare elements are styled only inside `.fui-app`.
- **No runtime dependency**, no CSS-in-JS, no inline `style` attributes. An application's CSP allows inline styles, but
  the kit does not rely on them: gaps and variants are modifier classes. The one exception is `@fabrika/ui/challenge`
  (`src/Challenge.tsx`), the ALTCHA widget of a public procedure's challenge: it imports the optional peer `altcha`,
  which registers `<altcha-widget>` (with its own styles and `blob:` workers, which the framework's CSP admits for such
  an application) when the module loads. Never import it from `src/index.ts`, so an application without a challenge
  bundles none of it; its test imports `./dom` first, in a group of its own.
- **Every interactive component is keyboard operable**, with a visible `:focus-visible` ring and ARIA that tests assert.
- Every string a component renders itself is a prop with an English default, so an application can translate it.
- `FormErrorLike` stays structural: never import the framework's error union from `@fabrika/app`.
- No `as` casts (except `as const`), no `any`; the router narrows its match with a checked type predicate.
