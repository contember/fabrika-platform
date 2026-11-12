# Component: Download

Hands the user a file you produced: a generated report, a patch, an export. Renders a download link.

The daemon serves the file only because this canvas names it, so write `path` as a string literal
(`path="/abs/out/report.pdf"` or `path={"/abs/out/report.pdf"}`). A path computed at run time is refused. The file
is sent as an attachment and never opened in the canvas.

## Props

- `path` (string, required) — an absolute path, or one relative to the project root.
- `label` (string) — the link text; the file name by default.

## Usage

```jsx
<Section title="Migration report">
	The dry run touched 1,204 rows. The full report is below.
	<Download
		path="/home/user/project/out/migration-report.csv"
		label="Migration report (CSV)"
	/>
	<Download path="/home/user/project/out/fix.patch" />
</Section>
```

Write the file before you push the canvas. On a shared link the component shows the file name only; the file stays
on your machine.
