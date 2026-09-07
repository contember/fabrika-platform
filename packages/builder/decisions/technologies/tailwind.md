---
id: tailwind
kind: technology
title: Tailwind CSS (utility styling)
slot: styling
provides: [styling, css-utilities, design-tokens]
requires: []
recommends: []
conflicts: []
npm: ["tailwindcss@^4"]
status: stable
sources:
  - where: "tailwindcss.com/docs (v4) + @tailwindcss/vite"
    read: "v4 setup, the CSS-first config, and how design tokens map to utilities/CSS vars."
  - where: ".fabrika/architecture/design.md (fabrika design phase) + nua/@nuasite/components"
    read: "How fabrika's semantic design tokens compile to Tailwind/CSS vars, and a real component set."
---

# Tailwind CSS

## What it is

The utility-first styling layer. fabrika's **design phase** defines _semantic_ tokens
(`--surface`, `--accent`, …) that map to Tailwind/CSS vars, so mockups and the built
app share one token system. v4 is CSS-first (config in CSS, `@tailwindcss/vite` or
the CLI).

## When & why to use

- Default styling for app UIs — semantic tokens → utilities, no separate CSS-in-JS runtime.
- Pairs with the design-tokens phase (`design.md`) and with accessible semantic markup (good for opice selectors).

## When NOT to use

- A design system that mandates a different styling engine; or a content site already styled by its framework.

## Impacts & gotchas

- v4 changed setup (CSS-first); verify the plugin/config against the installed major.
- Keep color/contrast in **accessible tokens**, not color-only signals (severity/status as text too — opice/accessibility rule).
- The visual editor in `nuasite` parses `class="…"`, so its content must be Tailwind-classed, not inline styles.

## Relationships — why

- **slot `styling`** — the styling system; recommended by `react`, `pletivo`, `nuasite`.
