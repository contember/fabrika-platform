import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { daemon } from '../lib/daemonClient'
import type { PhaseId } from '../lib/types'

const DESIGN_TOKENS_PATH = '.fabrika/architecture/design.md'
const PROJECT_PREVIEW_PATH = '.fabrika/pages/_preview.html'

const FALLBACK_ROOT = `:root{
  --color-brand:#6f4e37; --color-brand-strong:#573c2a;
  --color-surface:#fbf7f0; --color-surface-sunken:#f1e9dd;
  --color-text:#2a1e16; --color-muted:#8a7866; --color-accent:#c8853a;
  --color-border:#e7dccd; --color-on-brand:#fbf7f0;
  --space-gutter:16px; --radius-card:12px;
  --font-heading:"Instrument Serif",Georgia,serif;
  --font-body:system-ui,-apple-system,"Segoe UI",sans-serif;
}`

function extractRootCss(md: string | null): string {
	if (!md) return FALLBACK_ROOT
	const m = md.match(/:root\s*\{[^}]*\}/)
	return m ? m[0] : FALLBACK_ROOT
}

function buildCheckoutSrcdoc(rootCss: string): string {
	return `<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Serif&display=swap" />
<style>
${rootCss}
* { box-sizing: border-box; margin: 0; }
html, body { height: 100%; }
body {
  background: var(--color-surface);
  color: var(--color-text);
  font-family: var(--font-body);
  padding: 14px 16px;
  display: flex; justify-content: center; align-items: flex-start;
  -webkit-font-smoothing: antialiased;
}
.screen { width: 100%; max-width: 340px; }
.brand {
  display: flex; align-items: center; gap: 8px;
  font-size: 12px; letter-spacing: .12em; text-transform: uppercase;
  color: var(--color-muted); margin-bottom: 8px;
}
.brand .dot { width: 18px; height: 18px; border-radius: 50%; background: var(--color-brand); }
h1 {
  font-family: var(--font-heading);
  font-weight: 400; font-size: 26px; line-height: 1.1;
  margin-bottom: 2px;
}
.sub { color: var(--color-muted); font-size: 13px; margin-bottom: 12px; }
.card {
  background: #fff;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-card);
  padding: var(--space-gutter);
  box-shadow: 0 1px 2px rgba(42,30,22,.04);
}
.row { display: flex; justify-content: space-between; align-items: baseline; padding: 8px 0; }
.row + .row { border-top: 1px solid var(--color-border); }
.row .name { font-size: 14px; }
.row .qty { color: var(--color-muted); font-size: 12px; margin-left: 6px; }
.row .price { color: var(--color-accent); font-variant-numeric: tabular-nums; font-weight: 600; font-size: 14px; }
.total { margin-top: 4px; padding-top: 12px; border-top: 2px solid var(--color-border); }
.total .name { font-weight: 600; font-size: 15px; }
.total .price { font-size: 17px; }
.field { margin-top: 14px; }
.field label { display: block; font-size: 12px; color: var(--color-muted); margin-bottom: 6px; }
.field input {
  width: 100%; padding: 10px 12px;
  border: 1px solid var(--color-border); border-radius: var(--radius-card);
  font-size: 14px; font-family: inherit; color: var(--color-text); background: #fff;
}
.field input::placeholder { color: var(--color-muted); opacity: .7; }
.cta {
  width: 100%; margin-top: 14px; padding: 12px 16px;
  background: var(--color-brand); color: var(--color-on-brand);
  border: none; border-radius: var(--radius-card);
  font-size: 15px; font-weight: 600; font-family: inherit; cursor: pointer;
}
.cta:hover { background: var(--color-brand-strong); }
.pickup {
  display: flex; align-items: center; gap: 7px; justify-content: center;
  margin-top: 12px; font-size: 12px; color: var(--color-muted);
}
.pickup .pill { width: 7px; height: 7px; border-radius: 50%; background: var(--color-accent); }
</style>
</head>
<body>
<div className="screen">
  <div className="brand"><span className="dot"></span> Kávovar</div>
  <h1>Tvoje objednávka</h1>
  <div className="sub">2 položky · vyzvednutí na pobočce</div>
  <div className="card">
    <div className="row"><div><span className="name">Flat white</span><span className="qty">×1</span></div><span className="price">62 Kč</span></div>
    <div className="row"><div><span className="name">Croissant</span><span className="qty">×2</span></div><span className="price">98 Kč</span></div>
    <div className="row total"><span className="name">Celkem</span><span className="price">160 Kč</span></div>
    <div className="field">
      <label for="name">Jméno pro vyzvednutí</label>
      <input id="name" placeholder="např. Matěj" />
    </div>
    <button className="cta">Potvrdit objednávku</button>
    <div className="pickup"><span className="pill"></span> Připraveno k vyzvednutí ~ 8 min</div>
  </div>
</div>
</body>
</html>`
}

function buildProjectSrcdoc(html: string, rootCss: string): string {
	const style = `<style>${rootCss}</style>`
	const i = html.indexOf('<head>')
	if (i !== -1) return html.slice(0, i + '<head>'.length) + style + html.slice(i + '<head>'.length)
	return `${style}${html}`
}

function Chrome({ url, children }: { url: string; children: JSX.Element }): JSX.Element {
	return (
		<div className="flex h-full flex-col overflow-hidden rounded-md border border-border-medium bg-bg-base">
			{/* fake browser chrome */}
			<div className="flex items-center gap-1.5 border-b border-border-subtle bg-bg-elevated px-3 py-2">
				<span className="h-2.5 w-2.5 rounded-full bg-accent-red/60" />
				<span className="h-2.5 w-2.5 rounded-full bg-accent-amber/60" />
				<span className="h-2.5 w-2.5 rounded-full bg-accent-green/60" />
				<span className="ml-2 truncate font-mono text-tiny text-text-tertiary">{url}</span>
			</div>
			{children}
		</div>
	)
}

function DesignPreview({ sessionId, live }: { sessionId: string; live: boolean }): JSX.Element {
	const [rootCss, setRootCss] = useState<string>(FALLBACK_ROOT)
	const [projectHtml, setProjectHtml] = useState<string | null>(null)

	useEffect(() => {
		if (!live) return
		let cancelled = false
		daemon.artifact(sessionId, DESIGN_TOKENS_PATH).then((md) => {
			if (!cancelled) setRootCss(extractRootCss(md))
		})
		daemon.artifact(sessionId, PROJECT_PREVIEW_PATH).then((html) => {
			if (!cancelled) setProjectHtml(html?.trim() ? html : null)
		}).catch(() => {})
		return () => {
			cancelled = true
		}
	}, [sessionId, live])

	const usingProject = projectHtml !== null
	const srcDoc = usingProject
		? buildProjectSrcdoc(projectHtml!, rootCss)
		: buildCheckoutSrcdoc(rootCss)

	return (
		<>
			<Chrome url={usingProject ? 'pages/_preview.html' : 'pages/checkout.jsx'}>
				<iframe
					srcDoc={srcDoc}
					className="min-h-0 flex-1 bg-white"
					title="screen mockup"
					sandbox="allow-same-origin"
				/>
			</Chrome>
			<p className="mt-2 px-0.5 text-tiny text-text-tertiary">
				{usingProject
					? (
						<>
							Primary screen mockup (<span className="font-mono">pages/_preview.html</span>), themed live by{' '}
							<span className="font-mono">architecture/design.md</span> tokens.
						</>
					)
					: (
						<>
							Built-in demo screen, themed live by <span className="font-mono">architecture/design.md</span> tokens — drop a{' '}
							<span className="font-mono">pages/_preview.html</span> to preview your own.
						</>
					)}
			</p>
		</>
	)
}

export function BuildPreview({ previewUrl }: { previewUrl: string | null }): JSX.Element {
	if (!previewUrl) return <p className="text-body text-text-tertiary">No local preview configured. Set a local preview URL in Deployment.</p>
	return (
		<>
			<Chrome url={previewUrl}>
				<iframe
					src={previewUrl}
					className="min-h-0 flex-1 bg-white"
					title="Local application preview"
				/>
			</Chrome>
			<p className="mt-2 px-0.5 text-tiny text-text-tertiary">
				Local development preview. This is separate from the deployed application.
			</p>
		</>
	)
}

export function PreviewPane({
	phase,
	sessionId,
	live,
	previewUrl,
}: {
	phase: PhaseId
	sessionId: string
	live: boolean
	previewUrl: string | null
}): JSX.Element {
	const badge = phase === 'build' ? 'app' : 'mockup'
	return (
		<aside className="flex h-full flex-col border-l border-border-subtle bg-bg-surface">
			<div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
				<div className="text-tiny uppercase tracking-wide text-text-tertiary">live preview</div>
				<span className="rounded bg-bg-elevated px-2 py-0.5 text-tiny text-text-secondary">
					{badge}
				</span>
			</div>
			<div className="flex min-h-0 flex-1 flex-col p-3">
				{phase === 'build' ? <BuildPreview previewUrl={previewUrl} /> : <DesignPreview sessionId={sessionId} live={live} />}
			</div>
		</aside>
	)
}
