# Theming

Canvas supports light/dark themes. **Never hardcode hex colors** — use CSS variables in `style={{ }}`.

## CSS Variables

### Text

- `--color-text-primary` — main text
- `--color-text-secondary` — supporting text
- `--color-text-tertiary` — meta text, labels
- `--color-text-code` — inline code
- `--color-text-inverse` — text on dark backgrounds

### Backgrounds

- `--color-bg-base` — page background
- `--color-bg-surface` — card/section background
- `--color-bg-elevated` — floating elements
- `--color-bg-code` — code block background
- `--color-bg-input` — form input background

### Accents

- `--color-accent-green`, `--color-accent-green-muted`
- `--color-accent-amber`, `--color-accent-amber-muted`
- `--color-accent-red`, `--color-accent-red-muted`
- `--color-accent-blue`, `--color-accent-blue-muted`

### Borders

- `--color-border-subtle` — light separators
- `--color-border-medium` — visible borders
- `--color-border-hover` — interactive hover state

### Fonts

- `--font-heading` — section headings (Instrument Serif)
- `--font-body` — body text (Inter)
- `--font-mono` — code (JetBrains Mono)

## Usage

```jsx
<span style={{ color: 'var(--color-text-tertiary)', fontSize: '0.75rem' }}>meta text</span>

<div style={{
  background: 'var(--color-bg-surface)',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: '8px',
  padding: '16px',
}}>
  Custom styled container
</div>
```

## Project theme

A project can give its canvases, and the canvas UI around them, its own colours and fonts in `.agent-canvas/theme.css`
at the project root. The daemon applies it after the base theme, on the next page load or push. Keep text readable on
the backgrounds you set: the sidebar and the annotation panel use the same variables.

```css
:root {
  --color-accent-blue: #0055ff;
  --font-heading: 'Brand Serif', Georgia, serif;
}
[data-theme="light"] {
  --color-bg-base: #fbfaf7;
}
[data-theme="dark"] {
  --color-bg-base: #101418;
}
```

- Only `--color-*` and `--font-*` variables, on `:root`, `[data-theme="light"]` or `[data-theme="dark"]`.
- Values are plain colours and font lists: no `url()`, `@import`, `@font-face` or other rules. A font must already be
  installed or be one the base theme loads (Inter, Instrument Serif, JetBrains Mono).
- The file must be inside the project, not a symlink out of it, and at most 64 KB.
- A file that breaks a rule is not applied at all. The daemon log and the browser console give the line.
