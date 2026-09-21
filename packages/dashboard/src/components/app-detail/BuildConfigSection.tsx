import { useState } from 'react'
import { api, ApiError, type AppDto } from '../../lib/api'
import { Icon } from '../Icon'

export function BuildConfigSection({ app, onDone }: { app: AppDto; onDone: () => void }) {
	return (
		<section>
			<div className="section-head">
				<Icon name="bolt" size={15} />
				<h2>Build config</h2>
			</div>
			<div className="detail-grid">
				<Field label="Worker dir" value={app.workerDir} mono />
				<Field label="Build command" value={app.buildCmd} mono />
				<InstallationIdField app={app} onDone={onDone} />
			</div>
		</section>
	)
}

function Field({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
	return (
		<div>
			<h4>{label}</h4>
			{value === null ? <span className="muted">—</span> : mono ? <code>{value}</code> : value}
		</div>
	)
}

/**
 * The GitHub installation id, editable in place: "Detect" auto-resolves it from the installed GitHub App
 * (server-side, by repo URL), "Edit" sets it manually. Needed to clone a private repo — a null here makes
 * fabrika treat the app as public and the clone fails.
 */
function InstallationIdField({ app, onDone }: { app: AppDto; onDone: () => void }) {
	const [editing, setEditing] = useState(false)
	const [value, setValue] = useState(app.githubInstallationId === null ? '' : String(app.githubInstallationId))
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function patch(body: { githubInstallationId: number } | { resolveInstallationId: true }) {
		setBusy(true)
		setError(null)
		try {
			await api.apps.update({ appId: app.id, app: body })
			setEditing(false)
			onDone()
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : 'Save failed.')
			setBusy(false)
		}
	}

	return (
		<div>
			<h4>GitHub installation id</h4>
			{editing
				? (
					<div className="row-actions">
						<input
							type="number"
							min="1"
							aria-label="GitHub installation id"
							value={value}
							onChange={(e) => setValue(e.target.value)}
							placeholder="12345678"
						/>
						<button
							type="button"
							className="primary small"
							disabled={busy || value.trim() === ''}
							onClick={() => patch({ githubInstallationId: Number(value.trim()) })}
						>
							{busy ? 'Saving…' : 'Save'}
						</button>
						<button type="button" className="small" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
					</div>
				)
				: (
					<div className="row-actions">
						{app.githubInstallationId === null ? <span className="muted">—</span> : <code>{String(app.githubInstallationId)}</code>}
						<button type="button" className="small" disabled={busy} onClick={() => patch({ resolveInstallationId: true })}>
							{busy ? 'Detecting…' : 'Detect'}
						</button>
						<button type="button" className="small" disabled={busy} onClick={() => setEditing(true)}>Edit</button>
					</div>
				)}
			{error && <div className="error-text small">{error}</div>}
		</div>
	)
}
