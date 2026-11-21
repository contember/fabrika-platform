import { CONTROL_ACTIONS } from '@fabrika/control-contract'
import { useEffect, useRef, useState } from 'react'
import { api, ApiError, type AppDto } from '../../lib/api'
import { saveSource, submitSource, workerDirPath } from '../../lib/app-source'
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
 * The branch a deploy without a concrete trigger ref runs, and the base of a workspace and of its pull request; on
 * Cloudflare also the directory a deploy runs from. Editing needs `app.manage` at the app; Control lets only a person
 * change either on an application with a protected environment, and its refusal is shown as it is.
 */
export function SourceFields({ app, readsWorkerDir, onDone }: { app: AppDto; readsWorkerDir: boolean; onDone: () => void }) {
	const access = useConsoleAccess()
	const mayEdit = access === null || holdsAtApp(access, CONTROL_ACTIONS.APP_MANAGE, app.id)
	const [editing, setEditing] = useState(false)
	const [branch, setBranch] = useState(app.defaultBranch)
	const [dir, setDir] = useState(app.workerDir ?? '')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const editButton = useRef<HTMLButtonElement>(null)
	const returnFocus = useRef(false)

	// Closing the form puts focus back on the button that opened it, which it replaced.
	useEffect(() => {
		if (editing || !returnFocus.current) return
		returnFocus.current = false
		editButton.current?.focus()
	}, [editing])

	function open() {
		setBranch(app.defaultBranch)
		setDir(workerDirPath(app.workerDir) ?? app.workerDir ?? '')
		setError(null)
		setEditing(true)
	}

	function close() {
		returnFocus.current = true
		setEditing(false)
	}

	async function save(e: React.FormEvent) {
		e.preventDefault()
		setBusy(true)
		setError(null)
		const outcome = await submitSource(
			app,
			{ defaultBranch: branch, workerDir: readsWorkerDir ? dir : null },
			(change) => saveSource(api, app.id, change),
		)
		setBusy(false)
		if (outcome.kind === 'refused') {
			setError(outcome.message)
			return
		}
		close()
		if (outcome.kind === 'saved') onDone()
	}

	if (editing) {
		return (
			<form className="form wide" onSubmit={save}>
				<label>
					Default branch
					<input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" autoComplete="off" required autoFocus />
					<span className="hint">
						What Deploy runs on an environment without a fixed trigger ref, and where a workspace starts and opens its pull request.
					</span>
				</label>
				{readsWorkerDir && (
					<label>
						Worker dir
						<input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="the repository root" autoComplete="off" />
						<span className="hint">
							The directory with the app's package.json and bun.lock, relative to the repository; empty for its root. Each environment's config path is read
							from it, so moving it moves them too.
						</span>
					</label>
				)}
				<div className="row-actions">
					<button type="submit" className="primary small" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
					<button type="button" className="small" disabled={busy} onClick={close}>Cancel</button>
				</div>
				{error && <div className="error-text small" role="alert">{error}</div>}
			</form>
		)
	}

	const path = workerDirPath(app.workerDir)
	return (
		<>
			<div>
				<h4>Default branch</h4>
				<div className="row-actions">
					<code>{app.defaultBranch}</code>
					{mayEdit && <button type="button" className="small" ref={editButton} onClick={open}>Edit source</button>}
				</div>
			</div>
			{readsWorkerDir && (
				<div>
					<h4>Worker dir</h4>
					{path === null
						? (
							<>
								<code>{app.workerDir}</code> <span className="error-text small">not a path inside the repository</span>
							</>
						)
						: path === ''
						? <span className="muted">repository root</span>
						: <code>{path}</code>}
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
