import { useNavigate } from '@buzola/router'
import { CONTROL_ACTIONS } from '@fabrika/control-contract'
import { useId, useRef, useState } from 'react'
import { api, ApiError, type AppEnvDto, type DeploymentNamespaceDto, type TriggerDeployRequest } from '../../lib/api'
import { mayDo } from '../../lib/console-access'
import { useConsoleAccess } from '../../lib/console-caller'
import { editableTriggerRef } from '../../lib/format'
import { formProvider } from '../../lib/provider-registration'
import { ConfirmDialog } from '../ConfirmDialog'
import { Icon } from '../Icon'
import { EmptyState, Table } from '../Table'
import { EnvironmentForm } from './EnvironmentForm'

export function EnvironmentsSection(
	{ appId, envs, namespaces, providerId, onDone }: {
		appId: string
		envs: AppEnvDto[]
		namespaces: DeploymentNamespaceDto[]
		/** The installation's provider; it decides what a new environment's form collects. */
		providerId: string
		onDone: () => void
	},
) {
	const provider = formProvider(providerId)
	const [adding, setAdding] = useState(false)
	const addButton = useRef<HTMLButtonElement>(null)

	function closeAdd() {
		setAdding(false)
		requestAnimationFrame(() => addButton.current?.focus())
	}

	return (
		<section>
			<div className="section-head">
				<h2>Environments</h2>
				<span className="spacer" />
				{provider !== null && (
					<button ref={addButton} type="button" className="small" onClick={() => setAdding(true)} disabled={adding}>
						<Icon name="plus" size={13} />
						Add environment
					</button>
				)}
			</div>
			<p className="section-note">Where this app runs, how it deploys, and which other websites may call it.</p>
			<div className="environment-table">
				<Table
					colSpan={6}
					isEmpty={envs.length === 0}
					empty={<EmptyState icon="bay" title="No environments yet" body="Add an environment to give this app an address and a deployment target." />}
					head={
						<tr>
							<th>Environment</th>
							<th className="grow">Address</th>
							<th>Auto-deploy from</th>
							<th>Placement</th>
							<th>Cross-origin pages</th>
							<th aria-label="Actions" />
						</tr>
					}
				>
					{envs.map((env) => <EnvironmentRow key={env.env} appId={appId} env={env} namespaces={namespaces} onDone={onDone} />)}
				</Table>
			</div>
			{adding && provider !== null && (
				<div className="environment-editor environment-add">
					<div className="environment-head">
						<h3>New environment</h3>
					</div>
					<EnvironmentForm
						appId={appId}
						initial={null}
						existing={envs}
						provider={provider}
						namespaces={namespaces}
						onDone={() => {
							closeAdd()
							onDone()
						}}
						onCancel={closeAdd}
					/>
				</div>
			)}
			{provider === null && (
				<p className="hint">
					This console has no environment form for provider <code>{providerId}</code>.
				</p>
			)}
		</section>
	)
}

function DeployButton({ appId, env }: { appId: string; env: AppEnvDto }) {
	const access = useConsoleAccess()
	const navigate = useNavigate()
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function deploy() {
		setBusy(true)
		setError(null)
		try {
			const body: TriggerDeployRequest = { appId, env: env.env }
			const run = await api.deploy(body)
			navigate('runs/detail', { params: { id: run.id } })
		} catch (cause) {
			setError(cause instanceof ApiError ? cause.message : 'Deploy failed.')
			setBusy(false)
		}
	}

	if (!mayDo(access, CONTROL_ACTIONS.DEPLOY_TRIGGER, { app: appId, env: env.env })) return null

	return (
		<div className="environment-deploy">
			<button type="button" className="accent small" onClick={deploy} disabled={busy}>
				<Icon name="bolt" size={12} />
				{busy ? 'Deploying…' : 'Deploy'}
			</button>
			{error && <div className="error-text small" role="alert">{error}</div>}
		</div>
	)
}

function EnvironmentRow(
	{ appId, env, namespaces, onDone }: {
		appId: string
		env: AppEnvDto
		namespaces: DeploymentNamespaceDto[]
		onDone: () => void
	},
) {
	const [editing, setEditing] = useState(false)
	const [confirming, setConfirming] = useState(false)
	const editButton = useRef<HTMLButtonElement>(null)
	const editorId = useId()

	function closeEdit() {
		setEditing(false)
		requestAnimationFrame(() => editButton.current?.focus())
	}

	async function remove() {
		await api.apps.environments.delete({ appId, env: env.env })
		onDone()
	}

	return (
		<>
			<tr className="environment-row">
				<td>
					<div className="cell-stack">
						<strong>{env.env}</strong>
						<span className="muted small">{env.provider}</span>
					</div>
				</td>
				<td>
					<div className="cell-stack environment-address">
						{env.publicOrigin === null
							? <span className="muted">No public URL</span>
							: (
								<a className="environment-url" href={env.publicOrigin} target="_blank" rel="noreferrer">
									<code>{env.publicOrigin}</code>
									<Icon name="external" size={12} />
								</a>
							)}
						<span className="muted small">
							{env.domain === null ? 'No routing domain' : (
								<>
									Domain: <code>{env.domain}</code>
								</>
							)}
						</span>
					</div>
				</td>
				<td>
					{env.triggerRef === null
						? <span className="muted">Manual deploys only</span>
						: <code title={env.triggerRef}>{editableTriggerRef(env.triggerRef)}</code>}
				</td>
				<td>{env.namespaceId === null ? <span className="muted">Unassigned</span> : <code>{env.namespaceId}</code>}</td>
				<td>
					{env.crossOrigins.length === 0
						? <span className="muted small">None listed</span>
						: (
							<ul className="environment-origins">
								{env.crossOrigins.map((origin) => (
									<li key={origin}>
										<code>{origin}</code>
									</li>
								))}
							</ul>
						)}
				</td>
				<td>
					<div className="environment-row-actions">
						{!editing && <DeployButton appId={appId} env={env} />}
						<button
							ref={editButton}
							type="button"
							className="small"
							onClick={() => setEditing(true)}
							disabled={editing}
							aria-expanded={editing}
							aria-controls={editing ? editorId : undefined}
						>
							{editing ? 'Editing' : 'Edit'}
						</button>
					</div>
					{confirming && (
						<ConfirmDialog
							title="Delete environment"
							confirmLabel="Delete environment"
							body={
								<p>
									Delete environment <strong>{env.env}</strong> of <strong>{appId}</strong>?
								</p>
							}
							onConfirm={remove}
							onClose={() => setConfirming(false)}
						/>
					)}
				</td>
			</tr>
			{editing && (
				<tr className="environment-editor-row">
					<td colSpan={6}>
						<div className="environment-editor" id={editorId}>
							<div className="environment-head">
								<h3>Edit {env.env}</h3>
							</div>
							<EnvironmentForm
								appId={appId}
								initial={env}
								existing={[]}
								provider={null}
								namespaces={namespaces}
								onDone={() => {
									closeEdit()
									onDone()
								}}
								onCancel={closeEdit}
								onDelete={() => setConfirming(true)}
							/>
						</div>
					</td>
				</tr>
			)}
		</>
	)
}
