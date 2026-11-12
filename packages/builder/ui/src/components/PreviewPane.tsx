import type { JSX } from 'react'

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

export function PreviewPane({ previewUrl }: { previewUrl: string | null }): JSX.Element {
	return (
		<aside className="flex h-full flex-col border-l border-border-subtle bg-bg-surface">
			<div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
				<div className="text-tiny uppercase tracking-wide text-text-tertiary">live preview</div>
				<span className="rounded bg-bg-elevated px-2 py-0.5 text-tiny text-text-secondary">app</span>
			</div>
			<div className="flex min-h-0 flex-1 flex-col p-3">
				<BuildPreview previewUrl={previewUrl} />
			</div>
		</aside>
	)
}
