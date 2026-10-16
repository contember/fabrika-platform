import { Link } from '@buzola/router'
import { CONTROL_ACTIONS } from '@fabrika/control-contract'
import { useState } from 'react'
import { api, type AppEnvDto, type ApprovalDto } from '../../lib/api'
import { mayDo } from '../../lib/console-access'
import { useConsoleAccess } from '../../lib/console-caller'
import { parkedRunsAt, protectionFailure, protectionToggle, setEnvironmentProtection } from '../../lib/environment-protection'
import { ConfirmDialog } from '../ConfirmDialog'
import { Icon } from '../Icon'
import { Chip } from '../Status'
import { Table } from '../Table'

/** Whether a deploy that widens an environment's access waits for a person with `access.approve` (ADR-0050 §4). */
export function ApprovalsSection({ appId, envs, onDone }: { appId: string; envs: readonly AppEnvDto[]; onDone: () => void }) {
	if (envs.length === 0) return null
	return (
		<section>
			<div className="section-head">
				<Icon name="shield" size={15} />
				<h2>Access approvals</h2>
			</div>
			<p className="hint">
				A deploy that widens access on an environment that requires approval waits until a person with <code>access.approve</code>{' '}
				approves it. A team that already reviews every merge to the trigger branch on GitHub may turn this off. Only a person signed in to the console
				changes it, and the audit log records each change.
			</p>
			<Table
				head={
					<tr>
						<th>Env</th>
						<th className="grow">Access changes</th>
					</tr>
				}
			>
				{envs.map((env) => <ProtectionRow key={env.env} appId={appId} env={env} onDone={onDone} />)}
			</Table>
		</section>
	)
}

/** Holders of `access.approve` at the environment get the switch; everyone else reads the setting. */
export function ProtectionRow({ appId, env, onDone }: { appId: string; env: AppEnvDto; onDone: () => void }) {
	const access = useConsoleAccess()
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [confirming, setConfirming] = useState(false)
	// Null until Control lists them, or when it does not: the dialog then states the rule without a count.
	const [parked, setParked] = useState<readonly ApprovalDto[] | null>(null)

	async function protect() {
		setBusy(true)
		try {
			await setEnvironmentProtection(api, appId, env.env, true)
			onDone()
		} catch (cause) {
			setError(protectionFailure(cause, env.env))
		} finally {
			setBusy(false)
		}
	}

	function toggle(next: boolean) {
		setError(null)
		if (protectionToggle(next) === 'apply') {
			void protect()
			return
		}
		setParked(null)
		setConfirming(true)
		api.approvals.list().then(
			(approvals) => setParked(parkedRunsAt(approvals.items, appId, env.env)),
			() => setParked(null),
		)
	}

	async function unprotect() {
		await setEnvironmentProtection(api, appId, env.env, false)
		onDone()
	}

	return (
		<tr>
			<td>
				<Chip>{env.env}</Chip>
			</td>
			<td>
				<div className="cell-stack">
					{mayDo(access, CONTROL_ACTIONS.ACCESS_APPROVE, { app: appId, env: env.env })
						? (
							<label className="checkbox">
								<input type="checkbox" checked={env.protected} disabled={busy} onChange={(event) => toggle(event.target.checked)} />
								Require approval for access changes
							</label>
						)
						: <span>{env.protected ? 'Approval required' : 'No approval required'}</span>}
					<span className="muted small">
						{env.protected
							? 'A deploy that widens access waits for a person with access.approve.'
							: 'A deploy that widens access publishes at once.'}
					</span>
					{error && <div className="error-text small" role="alert">{error}</div>}
				</div>
				{confirming && (
					<ConfirmDialog
						title="Turn off approvals"
						confirmLabel="Turn off approvals"
						body={<UnprotectConsequences appId={appId} env={env.env} parked={parked} />}
						onConfirm={unprotect}
						onClose={() => setConfirming(false)}
						describeError={(cause) => protectionFailure(cause, env.env)}
					/>
				)}
			</td>
		</tr>
	)
}

/** What turning approvals off means, read before it happens. `parked` is null while unknown. */
export function UnprotectConsequences({ appId, env, parked }: { appId: string; env: string; parked: readonly ApprovalDto[] | null }) {
	return (
		<>
			<p>
				Turn off approvals for <strong>{appId}</strong> · <strong>{env}</strong>?
			</p>
			<ul>
				<li>A deploy that widens access on {env} publishes at once, without a person's approval.</li>
				<li>The audit log records this change and who made it.</li>
				<li>Turning approvals back on applies from the next deploy. Access published while they are off stays published.</li>
			</ul>
			{parked === null
				? (
					<p>
						A deploy that already waits for approval on {env}{' '}
						keeps waiting until a person approves, rejects or cancels it: turning approvals off approves nothing.
					</p>
				)
				: parked.length > 0 && <ParkedRuns env={env} parked={parked} />}
		</>
	)
}

function ParkedRuns({ env, parked }: { env: string; parked: readonly ApprovalDto[] }) {
	const one = parked.length === 1
	return (
		<p>
			{one ? `1 deploy of ${env} waits` : `${parked.length} deploys of ${env} wait`} for approval:{' '}
			{parked.map((approval, index) => (
				<span key={approval.run.id}>
					{index > 0 && ', '}
					<Link to="approvals/detail" params={{ id: approval.run.id }}>
						run <code>{approval.run.id.slice(0, 8)}</code>
					</Link>
				</span>
			))}. Turning approvals off does not approve {one ? 'it' : 'them'}. {one ? 'It keeps' : 'Each keeps'}{' '}
			waiting until a person approves, rejects or cancels it; once approved, it deploys.
		</p>
	)
}
