import { Link } from '@buzola/router'
import {
	type ApprovalPolicy,
	approvalPolicySchema,
	type ApprovalSettings,
	type ApproverCount,
	CONTROL_ACTIONS,
	isApproverCategory,
	modesOf,
	POLICY_CATEGORIES,
	type PolicyCategory,
	REQUEST_TTL_HOURS,
	type StepUpMode,
	STRICT_SETTINGS,
} from '@fabrika/control-contract'
import { useState } from 'react'
import { api, type AppEnvDto, type ApprovalDto } from '../../lib/api'
import { mayDo } from '../../lib/console-access'
import { useConsoleAccess } from '../../lib/console-caller'
import type { DecisionFailure } from '../../lib/decision-step-up'
import {
	APPROVAL_CATEGORY_GROUPS,
	categoryLabel,
	isDefaultMode,
	loosened,
	loosenedSettings,
	modeLabel,
	parkedRunsAt,
	policyChange,
	presetOf,
	PRESETS,
	protectionChangeFailure,
	protectionFailure,
	protectionStepUp,
	protectionToggle,
	requestTtl,
	sameSettings,
	setEnvironmentProtection,
	settingsSummary,
	waitingSummary,
} from '../../lib/environment-protection'
import { browserCredentials, type PasskeyCredentials } from '../../lib/webauthn'
import { ConfirmDialog } from '../ConfirmDialog'
import { DecisionFailureText } from '../DecisionFailureNotice'
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
export function ProtectionRow({ appId, env, onDone, credentials = browserCredentials() }: {
	appId: string
	env: AppEnvDto
	onDone: () => void
	credentials?: PasskeyCredentials | null
}) {
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
			await setEnvironmentProtection(api, env, true, undefined, credentials)
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
		await setEnvironmentProtection(api, env, false, undefined, credentials)
		onDone()
	}

	const unprotectStepUp = protectionStepUp(env, false)

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
						? <PolicyEditor appId={appId} env={env} onDone={onDone} credentials={credentials} />
						: <span className="muted small">{waitingSummary(env.approvalPolicy)} {settingsSummary(env.approvalSettings)}</span>)}
				</div>
				{confirming && (
					<ConfirmDialog
						title="Turn off approvals"
						confirmLabel="Turn off approvals"
						body={<UnprotectConsequences appId={appId} env={env.env} parked={parked} stepUp={unprotectStepUp} />}
						onConfirm={unprotect}
						onClose={() => setConfirming(false)}
						describeError={(cause) => <DecisionFailureText failure={protectionChangeFailure(cause, env.env, unprotectStepUp)} />}
					/>
				)}
			</td>
		</tr>
	)
}

/**
 * What lets a change of each category through on a protected environment (ADR-0083), for a holder of `access.approve`:
 * a mode and a number of approvers per category, the settings beside them, the strict and permissive presets, one save,
 * and a confirmation first when it loosens any. A save that weakens a passkey on deciding runs the passkey prompt first.
 */
export function PolicyEditor({ appId, env, onDone, credentials = browserCredentials() }: {
	appId: string
	env: AppEnvDto
	onDone: () => void
	credentials?: PasskeyCredentials | null
}) {
	const [chosen, setChosen] = useState<ApprovalPolicy>(env.approvalPolicy)
	const [settings, setSettings] = useState<ApprovalSettings>(env.approvalSettings)
	const [ttlText, setTtlText] = useState(String(env.approvalSettings.requestTtlHours))
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<DecisionFailure | null>(null)
	const [confirming, setConfirming] = useState(false)
	const ttl = requestTtl(ttlText)
	const changed = POLICY_CATEGORIES.some((category) => chosen[category] !== env.approvalPolicy[category])
		|| !sameSettings(settings, env.approvalSettings)
	const preset = presetOf(chosen, settings)
	const before = { policy: env.approvalPolicy, settings: env.approvalSettings }
	const after = { policy: chosen, settings }
	const stepUp = protectionStepUp(env, true, after)

	function choose(category: PolicyCategory, mode: string) {
		const parsed = approvalPolicySchema.safeParse({ ...chosen, [category]: mode })
		if (parsed.success) setChosen(parsed.data)
	}

	function chooseApprovers(category: PolicyCategory, count: ApproverCount) {
		if (isApproverCategory(category)) setSettings({ ...settings, approvers: { ...settings.approvers, [category]: count } })
	}

	function chooseRequesterMayApprove(category: PolicyCategory, may: boolean) {
		if (isApproverCategory(category)) setSettings({ ...settings, requesterMayApprove: { ...settings.requesterMayApprove, [category]: may } })
	}

	function chooseStepUp(category: PolicyCategory, mode: StepUpMode) {
		if (isApproverCategory(category)) setSettings({ ...settings, stepUp: { ...settings.stepUp, [category]: mode } })
	}

	function chooseTtl(text: string) {
		setTtlText(text)
		const hours = requestTtl(text)
		if (hours !== null) setSettings({ ...settings, requestTtlHours: hours })
	}

	function choosePreset(option: (typeof PRESETS)[number]) {
		setChosen(option.policy)
		setSettings(option.settings)
		setTtlText(String(option.settings.requestTtlHours))
	}

	async function save() {
		await setEnvironmentProtection(api, env, true, after, credentials)
		onDone()
	}

	async function apply() {
		setError(null)
		if (policyChange(before, after) === 'confirm') {
			setConfirming(true)
			return
		}
		setBusy(true)
		try {
			await save()
		} catch (cause) {
			setError(protectionChangeFailure(cause, env.env, stepUp))
		} finally {
			setBusy(false)
		}
	}

	const looser = [
		...loosened(env.approvalPolicy, chosen).map((category) => `${categoryLabel(category)} (${modeLabel(chosen[category]).toLowerCase()})`),
		...loosenedSettings(env.approvalSettings, settings),
	]
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
						onClick={() => choosePreset(option)}
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
							<span className="approval-mode-controls">
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
								{isApproverCategory(option.category) && (
									<select
										value={settings.approvers[option.category]}
										disabled={busy}
										aria-label={`${option.label}: approvers`}
										onChange={(event) => chooseApprovers(option.category, event.target.value === '2' ? 2 : 1)}
									>
										<option value="1">One person decides (default)</option>
										<option value="2">Two people decide</option>
									</select>
								)}
								{isApproverCategory(option.category) && (
									<select
										value={settings.requesterMayApprove[option.category] ? 'yes' : 'no'}
										disabled={busy}
										aria-label={`${option.label}: who decides an agent's request`}
										onChange={(event) => chooseRequesterMayApprove(option.category, event.target.value === 'yes')}
									>
										<option value="yes">Requester may decide (default)</option>
										<option value="no">Someone else decides</option>
									</select>
								)}
								{isApproverCategory(option.category) && (
									<select
										value={settings.stepUp[option.category]}
										disabled={busy}
										aria-label={`${option.label}: confirming a decision`}
										onChange={(event) => chooseStepUp(option.category, event.target.value === 'webauthn' ? 'webauthn' : 'none')}
									>
										<option value="none">
											No passkey to decide{STRICT_SETTINGS.stepUp[option.category] === 'none' ? ' (default)' : ''}
										</option>
										<option value="webauthn">
											Passkey to decide{STRICT_SETTINGS.stepUp[option.category] === 'webauthn' ? ' (default)' : ''}
										</option>
									</select>
								)}
							</span>
						</label>
					))}
				</div>
			))}
			<div className="approval-category-group">
				<div className="muted small">Requests</div>
				<label className="approval-mode">
					<span>
						Commits an agent may ask to deploy
						<span className="muted small">
							{' · '}merged means reachable from the trigger branch, or the default branch when it is a pattern; never a workspace branch, whichever is
							chosen.
						</span>
					</span>
					<span className="approval-mode-controls">
						<select
							value={settings.deployRequestCommits}
							disabled={busy}
							aria-label="Commits an agent may ask to deploy"
							onChange={(event) => setSettings({ ...settings, deployRequestCommits: event.target.value === 'any' ? 'any' : 'merged' })}
						>
							<option value="merged">Merged commits (default)</option>
							<option value="any">Any commit</option>
						</select>
					</span>
				</label>
				<label className="approval-mode">
					<span>
						Hours a request waits for a decision
						<span className="muted small">
							{` · ${REQUEST_TTL_HOURS.min}–${REQUEST_TTL_HOURS.max}, ${REQUEST_TTL_HOURS.default} by default; past it, the request expires.`}
						</span>
					</span>
					<span className="approval-mode-controls">
						<input
							type="number"
							min={REQUEST_TTL_HOURS.min}
							max={REQUEST_TTL_HOURS.max}
							value={ttlText}
							disabled={busy}
							aria-label="Hours a request waits for a decision"
							aria-invalid={ttl === null}
							onChange={(event) => chooseTtl(event.target.value)}
						/>
					</span>
				</label>
			</div>
			<div>
				<button type="button" className="btn small" disabled={!changed || ttl === null || busy} onClick={() => void apply()}>
					Save approvals
				</button>
			</div>
			{error !== null && (
				<div className="error-text small" role="alert">
					<DecisionFailureText failure={error} />
				</div>
			)}
			{confirming && (
				<ConfirmDialog
					title="Approve less"
					confirmLabel="Save approvals"
					body={
						<>
							<p>
								On <strong>{env.env}</strong>, these will need less to go through: {looser.join(', ')}.
							</p>
							<p>The audit log records this change. A deploy or grant that already waits keeps waiting until a person decides it.</p>
							<StepUpNote stepUp={stepUp} />
						</>
					}
					onConfirm={save}
					onClose={() => setConfirming(false)}
					describeError={(cause) => <DecisionFailureText failure={protectionChangeFailure(cause, env.env, stepUp)} />}
				/>
			)}
		</fieldset>
	)
}

/** What a confirmation says before a change that takes one of the person's passkeys. */
function StepUpNote({ stepUp }: { stepUp: StepUpMode }) {
	if (stepUp === 'none') return null
	return <p>A passkey confirms deciding here, so this change takes one of your passkeys: your browser asks for it when you confirm.</p>
}

/** What turning approvals off means, read before it happens. `parked` is null while unknown. */
export function UnprotectConsequences({ appId, env, parked, stepUp }: {
	appId: string
	env: string
	parked: readonly ApprovalDto[] | null
	stepUp: StepUpMode
}) {
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
			<StepUpNote stepUp={stepUp} />
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
