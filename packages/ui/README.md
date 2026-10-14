# @fabrika/ui

React components for internal admin screens on the Fabrika paved road. Accessible markup, keyboard support, and styling
only through CSS custom properties.

```ts
// the application's start module
import '@fabrika/ui/styles.css'
import './theme-overrides.css' // e.g. :root { --fui-accent: #0f766e; }
```

```tsx
import { AppShell, createRouter, DataTable, PageHeader } from '@fabrika/ui'

const { Router, useRoute, href } = createRouter({
	deals: '/deals',
	deal: '/deals/:id',
})
```

- `styles.css` — the theme tokens plus every component rule; the one file to import.
- `theme.css` — the tokens alone (`--fui-*`), light on `:root`, dark on `:root[data-theme='dark']`.
- Every plain `<a href>` inside `<Router>` navigates in-app; add `data-router="native"` to opt a link out.
