import { Link } from '@buzola/router'
import { type ApprovalCategory, CONTROL_ACTIONS } from '@fabrika/control-contract'
import { useState } from 'react'
import { api, type AppEnvDto, type ApprovalDto } from '../../lib/api'
import { mayDo } from '../../lib/console-access'
import { useConsoleAccess } from '../../lib/console-caller'
import {
	APPROVAL_CATEGORY_GROUPS,
	categoryChange,
	categoryLabel,
	isDefaultCategory,
	parkedRunsAt,
	protectionFailure,
	protectionToggle,
	setEnvironmentProtection,
} from '../../lib/environment-protection'
import { ConfirmDialog } from '../ConfirmDialog'
import { Icon } from '../Icon'
import { Chip } from '../Status'
import { Table } from '../Table'

/** Whether a deploy whose change needs closer review waits for a person with `access.approve` (ADR-0050 §4). */
export function ApprovalsSection({ appId, envs, onDone }: { appId: string; envs: readonly AppEnvDto[]; onDone: () => void }) {
	if (envs.length === 0) return null
	return (
		<section>
			<div className="section-head">
				<Icon name="shield" size={15} />
				<h2>Access approvals</h2>
			</div>
			<p className="hint">
				On an environment that requires approval, a deploy with a change of a chosen kind waits until a person with <code>access.approve</code>{' '}
				approves it, and a console grant of a chosen kind waits for another IAM administrator. By default that is every change that needs closer review
				(raw SQL, a table read across scopes, a public endpoint, people becoming visible, a migration that may change stored data); permission changes may
				be added. Any other change goes out at once. A team that already reviews every merge to the trigger branch on GitHub may turn this off. Only a
				person signed in to the console changes it, and the audit log records each change.
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
	const approver = mayDo(access, CONTROL_ACTIONS.ACCESS_APPROVE, { app: appId, env: env.env })
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
					{approver
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
					{env.protected && (approver
						? <CategoryEditor appId={appId} env={env} onDone={onDone} />
						: <span className="muted small">Waits for: {env.approvalCategories.map(categoryLabel).join(', ') || 'nothing'}</span>)}
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

/**
 * The kinds of change that wait on a protected environment (ADR-0083), for a holder of `access.approve`: one save, and
 * a confirmation first when it removes a chosen kind.
 */
export function CategoryEditor({ appId, env, onDone }: { appId: string; env: AppEnvDto; onDone: () => void }) {
	const [chosen, setChosen] = useState<readonly ApprovalCategory[]>(env.approvalCategories)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [confirming, setConfirming] = useState(false)
	const changed = chosen.length !== env.approvalCategories.length || chosen.some((category) => !env.approvalCategories.includes(category))

	function toggle(category: ApprovalCategory, on: boolean) {
		setChosen((current) => (on ? [...current, category] : current.filter((other) => other !== category)))
	}

	async function save() {
		await setEnvironmentProtection(api, appId, env.env, true, chosen)
		onDone()
	}

	async function apply() {
		setError(null)
		if (categoryChange(env.approvalCategories, chosen) === 'confirm') {
			setConfirming(true)
			return
		}
		setBusy(true)
		try {
			await save()
		} catch (cause) {
			setError(protectionFailure(cause, env.env))
		} finally {
			setBusy(false)
		}
	}

	const removed = env.approvalCategories.filter((category) => !chosen.includes(category))
	return (
		<fieldset className="approval-categories">
			<legend className="small">What waits for approval on {env.env}</legend>
			{APPROVAL_CATEGORY_GROUPS.map((group) => (
				<div key={group.title} className="approval-category-group">
					<div className="muted small">{group.title}</div>
					{group.options.map((option) => (
						<label key={option.category} className="checkbox" title={option.hint}>
							<input
								type="checkbox"
								checked={chosen.includes(option.category)}
								disabled={busy}
								onChange={(event) => toggle(option.category, event.target.checked)}
							/>
							<span>
								{option.label}
								{isDefaultCategory(option.category) && (
									<>
										{' '}
										<span className="muted small">default</span>
									</>
								)}
							</span>
						</label>
					))}
				</div>
			))}
			<div>
				<button type="button" className="btn small" disabled={!changed || busy} onClick={() => void apply()}>Save approval categories</button>
			</div>
			{error && <div className="error-text small" role="alert">{error}</div>}
			{confirming && (
				<ConfirmDialog
					title="Approve fewer kinds of change"
					confirmLabel="Save approval categories"
					body={
						<>
							<p>
								On <strong>{env.env}</strong>, these will no longer wait for a person: {removed.map(categoryLabel).join(', ')}.
							</p>
							<p>The audit log records this change. A deploy or grant that already waits keeps waiting until a person decides it.</p>
						</>
					}
					onConfirm={save}
					onClose={() => setConfirming(false)}
					describeError={(cause) => protectionFailure(cause, env.env)}
				/>
			)}
		</fieldset>
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
