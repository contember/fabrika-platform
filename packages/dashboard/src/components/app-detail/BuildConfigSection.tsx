import { CONTROL_ACTIONS } from '@fabrika/control-contract'
import { useState } from 'react'
import { api, ApiError, type AppDto } from '../../lib/api'
import { saveSource, sourceChange, workerDirPath } from '../../lib/app-source'
import { holdsAtApp, holdsGlobally } from '../../lib/console-access'
import { useConsoleAccess } from '../../lib/console-caller'
import { Icon } from '../Icon'

export function BuildConfigSection({ app, providerId, onDone }: { app: AppDto; providerId: string; onDone: () => void }) {
	// Only the Cloudflare provider deploys from a worker directory; elsewhere it is shown as stored, read-only.
	const readsWorkerDir = providerId === 'cloudflare'
	return (
		<section>
			<div className="section-head">
				<Icon name="bolt" size={15} />
				<h2>Build config</h2>
			</div>
			<div className="detail-grid">
				<SourceFields app={app} readsWorkerDir={readsWorkerDir} onDone={onDone} />
				{!readsWorkerDir && <Field label="Worker dir" value={app.workerDir} mono />}
				<Field label="Build command" value={app.buildCmd} mono />
				<InstallationIdField app={app} onDone={onDone} />
			</div>
		</section>
	)
}

/**
 * The branch a deploy without a concrete trigger ref runs, and the base of a new workspace; on Cloudflare also the
 * directory a deploy runs from. Editing needs `app.manage` at the app; Control lets only a person change either on an
 * application with a protected environment, and its refusal is shown as it is.
 */
export function SourceFields({ app, readsWorkerDir, onDone }: { app: AppDto; readsWorkerDir: boolean; onDone: () => void }) {
	const access = useConsoleAccess()
	const mayEdit = access === null || holdsAtApp(access, CONTROL_ACTIONS.APP_MANAGE, app.id)
	const [editing, setEditing] = useState(false)
	const [branch, setBranch] = useState(app.defaultBranch)
	const [dir, setDir] = useState(workerDirPath(app.workerDir))
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	function open() {
		setBranch(app.defaultBranch)
		setDir(workerDirPath(app.workerDir))
		setError(null)
		setEditing(true)
	}

	async function save(e: React.FormEvent) {
		e.preventDefault()
		const result = sourceChange(app, { defaultBranch: branch, workerDir: readsWorkerDir ? dir : null })
		if ('problem' in result) {
			setError(result.problem)
			return
		}
		if (result.change === null) {
			setEditing(false)
			return
		}
		setBusy(true)
		setError(null)
		try {
			await saveSource(api, app.id, result.change)
			setEditing(false)
			onDone()
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : 'Save failed.')
		} finally {
			setBusy(false)
		}
	}

	if (editing) {
		return (
			<form className="form wide" onSubmit={save}>
				<label>
					Default branch
					<input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" autoComplete="off" required />
					<span className="hint">What Deploy runs on an environment without a fixed trigger ref, and where a new workspace starts.</span>
				</label>
				{readsWorkerDir && (
					<label>
						Worker dir
						<input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="the repository root" autoComplete="off" />
						<span className="hint">The directory with the app's package.json and bun.lock, relative to the repository. Empty for its root.</span>
					</label>
				)}
				<div className="row-actions">
					<button type="submit" className="primary small" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
					<button type="button" className="small" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
				</div>
				{error && <div className="error-text small">{error}</div>}
			</form>
		)
	}

	const root = workerDirPath(app.workerDir)
	return (
		<>
			<div>
				<h4>Default branch</h4>
				<div className="row-actions">
					<code>{app.defaultBranch}</code>
					{mayEdit && <button type="button" className="small" onClick={open}>Edit</button>}
				</div>
			</div>
			{readsWorkerDir && (
				<div>
					<h4>Worker dir</h4>
					{root === '' ? <span className="muted">repository root</span> : <code>{root}</code>}
				</div>
			)}
		</>
	)
}

function Field({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
	return (
		<div>
			<h4>{label}</h4>
			{value === null ? <span className="muted">none</span> : mono ? <code>{value}</code> : value}
		</div>
	)
}

/**
 * The app's GitHub source binding: "Detect" binds the source connection of the repository's owner
 * (server-side); "Edit" names the installation, which must be that connection's. Without one the app is public.
 * Changing it needs global `app.manage`, as registration does; an app-scoped holder sees it read-only.
 */
function InstallationIdField({ app, onDone }: { app: AppDto; onDone: () => void }) {
	const access = useConsoleAccess()
	const mayBind = access === null || holdsGlobally(access, CONTROL_ACTIONS.APP_MANAGE)
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
						{app.githubInstallationId === null ? <span className="muted">none</span> : <code>{String(app.githubInstallationId)}</code>}
						{mayBind && (
							<>
								<button type="button" className="small" disabled={busy} onClick={() => patch({ resolveInstallationId: true })}>
									{busy ? 'Detecting…' : 'Detect'}
								</button>
								<button type="button" className="small" disabled={busy} onClick={() => setEditing(true)}>Edit</button>
							</>
						)}
					</div>
				)}
			{error && <div className="error-text small">{error}</div>}
		</div>
	)
}
