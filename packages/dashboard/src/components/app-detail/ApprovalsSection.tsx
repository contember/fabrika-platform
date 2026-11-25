import { Link } from '@buzola/router'
import {
	type ApprovalPolicy,
	approvalPolicySchema,
	CONTROL_ACTIONS,
	modesOf,
	POLICY_CATEGORIES,
	type PolicyCategory,
} from '@fabrika/control-contract'
import { useState } from 'react'
import { api, type AppEnvDto, type ApprovalDto } from '../../lib/api'
import { mayDo } from '../../lib/console-access'
import { useConsoleAccess } from '../../lib/console-caller'
import {
	APPROVAL_CATEGORY_GROUPS,
	categoryLabel,
	isDefaultMode,
	loosened,
	modeLabel,
	parkedRunsAt,
	policyChange,
	presetOf,
	PRESETS,
	protectionFailure,
	protectionToggle,
	setEnvironmentProtection,
	waitingSummary,
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
				On an environment that requires approval, each kind of change has a mode: it goes through with no approval, waits for a plan or a person, waits
				for a person with{' '}
				<code>access.approve</code>, or, for what an agent or a key does, is refused. By default every change that needs closer review waits (raw SQL, a
				table read across scopes, a public endpoint, people becoming visible, a migration that may change stored data), and what an agent does waits for a
				person. The permissive preset lets everything through and keeps recording it. Only a person signed in to the console changes this, and the audit
				log records each change.
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
						? <PolicyEditor appId={appId} env={env} onDone={onDone} />
						: <span className="muted small">{waitingSummary(env.approvalPolicy)}</span>)}
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
 * What lets a change of each category through on a protected environment (ADR-0083), for a holder of `access.approve`:
 * a mode per category, the strict and permissive presets, one save, and a confirmation first when it loosens any.
 */
export function PolicyEditor({ appId, env, onDone }: { appId: string; env: AppEnvDto; onDone: () => void }) {
	const [chosen, setChosen] = useState<ApprovalPolicy>(env.approvalPolicy)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [confirming, setConfirming] = useState(false)
	const changed = POLICY_CATEGORIES.some((category) => chosen[category] !== env.approvalPolicy[category])
	const preset = presetOf(chosen)

	function choose(category: PolicyCategory, mode: string) {
		const parsed = approvalPolicySchema.safeParse({ ...chosen, [category]: mode })
		if (parsed.success) setChosen(parsed.data)
	}

	async function save() {
		await setEnvironmentProtection(api, appId, env.env, true, chosen)
		onDone()
	}

	async function apply() {
		setError(null)
		if (policyChange(env.approvalPolicy, chosen) === 'confirm') {
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

	const looser = loosened(env.approvalPolicy, chosen)
	return (
		<fieldset className="approval-categories">
			<legend className="small">What lets a change through on {env.env}</legend>
			<div className="approval-presets">
				{PRESETS.map((option) => (
					<button
						key={option.name}
						type="button"
						className={preset === option.name ? 'btn small primary' : 'btn small'}
						aria-pressed={preset === option.name}
						title={option.hint}
						disabled={busy}
						onClick={() => setChosen(option.policy)}
					>
						{option.label}
					</button>
				))}
				<span className="muted small">{preset === null ? 'Custom' : PRESETS.find((option) => option.name === preset)?.hint}</span>
			</div>
			{APPROVAL_CATEGORY_GROUPS.map((group) => (
				<div key={group.title} className="approval-category-group">
					<div className="muted small">{group.title}</div>
					{group.options.map((option) => (
						<label key={option.category} className="approval-mode" title={option.hint}>
							<span>
								{option.label}
								<span id={`approval-${env.env}-${option.category}`} className="muted small">
									{` · ${option.hint}.${option.pending === undefined ? '' : ` Not enforced yet. ${option.pending}`}`}
								</span>
							</span>
							<select
								value={chosen[option.category]}
								disabled={busy}
								aria-label={option.label}
								aria-describedby={`approval-${env.env}-${option.category}`}
								onChange={(event) => choose(option.category, event.target.value)}
							>
								{modesOf(option.category).map((mode) => (
									<option key={mode} value={mode}>
										{modeLabel(mode)}
										{isDefaultMode(option.category, mode) ? ' (default)' : ''}
									</option>
								))}
							</select>
						</label>
					))}
				</div>
			))}
			<div>
				<button type="button" className="btn small" disabled={!changed || busy} onClick={() => void apply()}>Save approvals</button>
			</div>
			{error && <div className="error-text small" role="alert">{error}</div>}
			{confirming && (
				<ConfirmDialog
					title="Approve less"
					confirmLabel="Save approvals"
					body={
						<>
							<p>
								On <strong>{env.env}</strong>, these will need less to go through:{' '}
								{looser.map((category) => `${categoryLabel(category)} (${modeLabel(chosen[category]).toLowerCase()})`).join(', ')}.
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
