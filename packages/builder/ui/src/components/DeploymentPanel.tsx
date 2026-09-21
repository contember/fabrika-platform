import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import type { usePlatform } from '../lib/usePlatform'

const button = 'rounded border border-border-medium px-3 py-1 text-tiny disabled:opacity-40'
const input = 'rounded border border-border-medium bg-bg-base px-2 py-1 text-body text-text-primary'

export function DeploymentPanel({ platform, live }: { platform: ReturnType<typeof usePlatform>; live: boolean }): JSX.Element {
	const [origin, setOrigin] = useState('')
	const [preview, setPreview] = useState<string | null>(null)
	const [consoleOrigin, setConsoleOrigin] = useState<string | null>(null)
	const { data, enabled, busy, error } = platform
	const connection = data?.connection
	useEffect(() => {
		if (connection) setConsoleOrigin(connection.controlOrigin)
	}, [connection?.controlOrigin])
	const pairing = data?.pairing
	const run = data?.deployment
	const running = run?.status === 'preparing' || run?.status === 'pending' || run?.status === 'running'
	const pairingActive = pairing?.status === 'pending' || pairing?.status === 'approved'
	const credentialValid = data?.credential.available && (data.credential.expiresAt === null || data.credential.expiresAt * 1000 > Date.now())
	return (
		<details className="shrink-0 border-b border-border-subtle bg-bg-surface px-6 py-2" open>
			<summary className="cursor-pointer font-heading text-section">Deployment</summary>
			<div className="max-h-64 space-y-3 overflow-y-auto py-3 text-body" aria-busy={busy}>
				{!live && <p className="text-text-tertiary">Offline / demo mode — deployment controls are disabled.</p>}
				{live && !data && !error && <p role="status">Loading project status…</p>}
				{error && <p role="alert" className="text-accent-red">{error}</p>}
				{connection
					? (
						<div className="space-y-1">
							<p>
								App <strong>{connection.receipt.app.id}</strong> · {connection.receipt.provider} · {connection.receipt.environment.env}
							</p>
							<p className="text-text-secondary">Control: {connection.controlOrigin}</p>
							<p>
								Local credential: {credentialValid ? 'available' : 'unavailable or expired'}
								{data?.credential.expiresAt != null && ` · expires ${new Date(data.credential.expiresAt * 1000).toLocaleString()}`}
							</p>
							<a className="text-accent-blue underline" href={connection.controlOrigin} target="_blank" rel="noreferrer">
								Open console to manage or revoke access
							</a>
						</div>
					)
					: <p className="text-text-secondary">No platform connection.</p>}
				{!connection && consoleOrigin && (
					<a className="text-accent-blue underline" href={consoleOrigin} target="_blank" rel="noreferrer">Open console to revoke server access</a>
				)}
				<form
					className="flex flex-wrap items-center gap-2"
					onSubmit={(event) => {
						event.preventDefault()
						void platform.act({ kind: 'connect', controlOrigin: origin })
					}}
				>
					<label htmlFor="control-origin">Control origin</label>
					<input
						className={input}
						id="control-origin"
						type="url"
						value={origin}
						onChange={(event) => setOrigin(event.currentTarget.value)}
						placeholder="https://control.example.com"
						disabled={!enabled || !!connection || pairingActive}
						required
					/>
					<button className={button} type="submit" disabled={!enabled || !!connection || pairingActive}>{busy ? 'Working…' : 'Connect'}</button>
				</form>
				{pairing?.status === 'pending' && enabled && pairing.expiresAt * 1000 > Date.now() && (
					<a className="text-accent-blue underline" href={pairing.authorizationUrl} target="_blank" rel="noreferrer">
						Review connection in platform console
					</a>
				)}
				{pairing && (
					<p role="status">
						Connection: {pairing.status}
						{(pairing.status === 'failed' || pairing.status === 'recovery_required') && ` — ${pairing.message}`}
					</p>
				)}
				<div className="flex flex-wrap items-center gap-2">
					<button
						className={button}
						type="button"
						disabled={!enabled || (!connection && !pairing)}
						onClick={() => void platform.act({ kind: 'disconnect' })}
					>
						Disconnect locally
					</button>
					<span className="text-tiny text-text-tertiary">Deletes local credentials only. Revoke server access in the console.</span>
					<button
						className={button}
						type="button"
						disabled={!enabled || !connection || !credentialValid || running || pairingActive}
						onClick={() => void platform.act({ kind: 'deploy' })}
					>
						{running ? 'Deploy in progress…' : 'Deploy pushed commit'}
					</button>
					<button className={button} type="button" disabled={!live || busy} onClick={platform.refresh}>Refresh status</button>
				</div>
				{run && (
					<div role="status" className="space-y-1">
						<p>
							Deployment: <strong>{run.status}</strong>
							{run.message && ` — ${run.message}`}
						</p>
						{run.runId && (
							<p>
								Run: <code>{run.runId}</code>
							</p>
						)}
						{run.commitSha && (
							<p>
								Commit: <code>{run.commitSha}</code>
							</p>
						)}
						{run.consoleUrl && (
							<a className="mr-4 text-accent-blue underline" href={run.consoleUrl} target="_blank" rel="noreferrer">View run in console</a>
						)}
						{run.appUrl && <a className="text-accent-blue underline" href={run.appUrl} target="_blank" rel="noreferrer">Open deployed application</a>}
					</div>
				)}
				<form
					className="flex flex-wrap items-center gap-2"
					onSubmit={(event) => {
						event.preventDefault()
						void platform.act({ kind: 'preview', url: preview ?? data?.previewUrl ?? '' })
					}}
				>
					<label htmlFor="preview-url">Local preview URL</label>
					<input
						className={input}
						id="preview-url"
						type="url"
						value={preview ?? data?.previewUrl ?? ''}
						onChange={(event) => setPreview(event.currentTarget.value)}
						placeholder={data?.previewUrl ?? 'http://localhost:3000'}
						disabled={!enabled}
						required
					/>
					<button className={button} type="submit" disabled={!enabled}>Set preview</button>
					<button
						className={button}
						type="button"
						disabled={!enabled || !data?.previewUrl}
						onClick={() => {
							setPreview(null)
							void platform.act({ kind: 'preview', url: null })
						}}
					>
						Clear preview
					</button>
					<span className="text-tiny text-text-tertiary">
						{data?.previewUrl ?? 'No local preview configured.'} · Separate from the deployed application.
					</span>
				</form>
			</div>
		</details>
	)
}
