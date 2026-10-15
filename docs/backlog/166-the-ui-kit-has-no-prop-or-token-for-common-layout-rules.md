---
id: 166
title: The UI kit has no prop or token for common layout rules
blocked-by: []
---

# 166 — The UI kit has no prop or token for common layout rules

**Summary.** An application built on the paved road restyles `@fabrika/ui` class names to meet its wireframes, because
several components have no prop and several rules read no token. Each restyle ties the application to the kit's
internal class names. Effort: M (many small, independent changes).

## Problem

Components:

- **`DataTable`'s selection toolbar shows only while something is selected** (`packages/ui/src/DataTable.tsx:118`).
  A screen whose bulk actions apply to every filtered row when nothing is ticked needs the bar at all times, so it
  renders its own bar and hides the kit's.
- **`PageHeader` has no slot for the record's state** (`packages/ui/src/PageHeader.tsx:25`). A status pill placed in
  `title` becomes part of the `h1`'s text and accessible name; `meta` sits under the lead.
- **`Checkbox` is no `Field` control** (`packages/ui/src/inputs.tsx:109`). `Input`, `DateInput`, `Textarea` and
  `Select` take `id`, `name`, `aria-describedby` and `aria-invalid` from their `Field` through `useFieldAttributes`
  (`inputs.tsx:8`, `:15`, `:22`, `:38`); `Checkbox` renders its own label and takes none, so a required consent's
  error and focus are wired by hand. The kit also has no file input and no combobox.

Rules:

- **A wrapped column breaks inside words.** `fui-table__cell--wrap` sets `overflow-wrap: anywhere`
  (`packages/ui/src/components.css:798`). That lowers the min-content width, so in an auto-layout table a wrapped
  column without a `width` shrinks to a few letters per line. Every wrapped column then needs a `width`.
- **A control's horizontal padding has no token.** `.fui-input` pads `0 var(--fui-space-2)` (`components.css:405`)
  and `.fui-textarea` re-pads all sides (`components.css:442`). An application that widens the single-line padding
  must override `.fui-input`, which outranks `.fui-textarea` and flattens a textarea's first line onto its top edge.
- **No token reaches these rules** (`packages/ui/src/theme.css:69` lists the layout tokens there are): the sidebar's
  background and padding (`components.css:69`), a nav item's colours and a badge off the current item
  (`components.css:92`), the page header's gap and title row (`components.css:200`), a card header's rule and the
  card's inner padding (`components.css:916`), an outlined secondary or danger button (`packages/ui/src/Button.tsx:4`
  has `primary | secondary | ghost | danger` only), a table head's background and a cell's padding
  (`components.css:758`, `:775`), a pill's size and radius (`components.css:651`), and the form actions' alignment
  (`components.css:367`).

## Approach / acceptance

- `DataTable`: a prop that keeps the toolbar shown with an empty selection (for example `toolbar: 'always'`) and a
  label callback given the selected and the total count. Witness: a `DataTable` test renders the toolbar and its
  actions with nothing selected.
- `PageHeader`: a `status` slot rendered beside the `h1`, outside it. Witness: the heading's text is the title only.
- `Checkbox` reads `useFieldAttributes`, so `Form` shows its field error and sets `aria-invalid`. Witness: a `Form`
  test with a required checkbox field. A file input and a combobox are separate decisions; file them only when an
  application needs them beyond `Input type="file"` and `<datalist>`.
- Wrap with `overflow-wrap: break-word`. Witness: a CSS assertion in the kit's tests, or a note in the column docs if
  no test can see layout.
- Tokens: `--fui-control-padding-x` (read by `.fui-input`; `.fui-textarea` keeps its own block padding), and one
  token per rule above, defaulting to today's values. Witness: `theme.css` declares them and every rule above reads
  them; the kit's rendered output does not change with the defaults.

## Touch points

`packages/ui/src/{DataTable.tsx,PageHeader.tsx,inputs.tsx,Button.tsx,components.css,theme.css}`,
`packages/ui/src/__tests__/`, the UI section of `packages/app/skill/references/spa.md`.

<!-- Origin: framework gaps an application built on the paved road met on the 0.4.1 React stack. -->
