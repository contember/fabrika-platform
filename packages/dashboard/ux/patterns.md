# Console patterns

A new console screen follows these; `packages/dashboard/CLAUDE.md` holds the full rules.

- **Status is a lamp, a category is a chip** (`components/Status.tsx`).
- **One filled button per page**, its single constructive step. Filtering, editing and repairing are outline or
  ghost; a row's main verb is `accent`. Irreversible acts sit in a `.danger-zone` at the foot of the page and confirm
  in a dialog (`ConfirmDialog`).
- **A page head** is a back link, the title and one line of purpose.
- **An application's page is one tab per task** (`components/app/AppFrame.tsx`); its head shows each environment's
  state lamp.
- **Editing:** one value inline in its row; several fields in a form that opens in place of the section or in a
  modal; a confirmation or a destructive act in a modal.
- **Lists** filter through one `.filters` bar; a table marks the column that takes slack with `className="grow"`.
- **States:** a read that is refused, unavailable, empty or limited says which; "None" is only an answer.
