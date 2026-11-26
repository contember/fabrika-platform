import { Link } from '@buzola/router'
import {
	APPROVAL_MODES,
	type ApprovalMode,
	type ApprovalPolicy,
	approvalPolicySchema,
	type ApprovalSettings,
	CONTROL_ACTIONS,
	isApproverCategory,
	isStepUpCategory,
	modesOf,
	type PolicyCategory,
	REQUEST_TTL_HOURS,
	type StepUpMode,
} from '@fabrika/control-contract'
import { useState } from 'react'
import { api, type AppEnvDto, type ApprovalDto } from '../../lib/api'
import { mayDo } from '../../lib/console-access'
import { useConsoleAccess } from '../../lib/console-caller'
import type { DecisionFailure, PasskeyCheck, StartedDecision } from '../../lib/decision-step-up'
import {
	APPROVAL_CATEGORY_GROUPS,
	categoryLabel,
	type CategoryOption,
	decidingText,
	loosened,
	loosenedSettings,
	modeLabel,
	nearestPreset,
	parkedRunsAt,
	policyChange,
	type PolicyChoice,
	policyDifferences,
	type PresetName,
	PRESETS,
	protectionChangeFailure,
	protectionStepUp,
	protectionToggle,
	requestTtl,
	setEnvironmentProtection,
} from '../../lib/environment-protection'
import { ConfirmDialog } from '../ConfirmDialog'
import { DecisionFailureText } from '../DecisionFailureNotice'
import { Icon } from '../Icon'
import { PasskeyCheckPrompt } from '../PasskeyCheckPrompt'
import { Chip, Status } from '../Status'
import { Table } from '../Table'

/**
 * Whether a change waits for a person on each environment (ADR-0050 §4, ADR-0083): its preset and only the rules that
 * differ from it, each with what the preset says. The full list is one disclosure; editing is its own page.
 */
export function ApprovalsSection({ appId, envs, onDone }: { appId: string; envs: readonly AppEnvDto[]; onDone: () => void }) {
	if (envs.length === 0) return null
	return (
		<section>
			<div className="section-head">
				<h2>What lets a change through</h2>
			</div>
			<p className="section-note">
				On an environment with approval on, a change that needs closer review, a new permission or what an agent or a key does waits for a person with
				{' '}
				<code>access.approve</code>, as its rules say. The audit log records each change of these rules.
			</p>
			<Table
				colSpan={4}
				head={
					<tr>
						<th>Environment</th>
						<th>Approval</th>
						<th className="grow">Rules</th>
						<th />
					</tr>
				}
			>
				{envs.map((env) => <ProtectionRow key={env.env} appId={appId} env={env} onDone={onDone} />)}
			</Table>
		</section>
	)
}

/** Holders of `access.approve` at the environment turn approval on or off and open the editor; everyone else reads it. */
export function ProtectionRow({ appId, env, onDone }: { appId: string; env: AppEnvDto; onDone: () => void }) {
	const access = useConsoleAccess()
	const approver = mayDo(access, CONTROL_ACTIONS.ACCESS_APPROVE, { app: appId, env: env.env })
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<DecisionFailure | null>(null)
	const [confirming, setConfirming] = useState(false)
	const [check, setCheck] = useState<PasskeyCheck<AppEnvDto> | null>(null)
	// Null until Control lists them, or when it does not: the dialog then states the rule without a count.
	const [parked, setParked] = useState<readonly ApprovalDto[] | null>(null)

	async function protect() {
		setBusy(true)
		try {
			settle(await setEnvironmentProtection(api, env, true, undefined))
		} catch (cause) {
			setError(protectionChangeFailure(cause, env.env, protectionStepUp(env, true)))
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
		settle(await setEnvironmentProtection(api, env, false, undefined))
	}

	function settle(started: StartedDecision<AppEnvDto>) {
		if (started.kind === 'posted') onDone()
		else setCheck(started.check)
	}

	const unprotectStepUp = protectionStepUp(env, false)

	return (
		<tr>
			<th scope="row">{env.env}</th>
			<td>
				<Status lamp={env.protected ? 'ok' : 'idle'}>{env.protected ? 'On' : 'Off'}</Status>
			</td>
			<td>
				{env.protected
					? <PolicySummary env={env} />
					: <span className="muted">A deploy that widens access publishes at once.</span>}
				{error !== null && (
					<div className="error-text small" role="alert">
						<DecisionFailureText failure={error} />
					</div>
				)}
				{check !== null && (
					<PasskeyCheckPrompt
						check={check}
						onDone={onDone}
						onCancel={() => setCheck(null)}
						describeFailure={(cause) => protectionChangeFailure(cause, env.env, 'webauthn')}
					/>
				)}
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
			<td>
				{approver && (
					<div className="row-actions">
						{env.protected && (
							<Link to="apps/approvals-edit" params={{ id: appId, env: env.env }} className="btn small">
								Edit<span className="sr-only">{` the rules of ${env.env}`}</span>
							</Link>
						)}
						<button type="button" className="small" disabled={busy || check !== null} onClick={() => toggle(!env.protected)}>
							{env.protected ? 'Turn off' : 'Turn on'}
							<span className="sr-only">{` approval on ${env.env}`}</span>
						</button>
					</div>
				)}
			</td>
		</tr>
	)
}

/** An environment's rules as its nearest preset and what differs from it; every rule behind one disclosure. */
export function PolicySummary({ env }: { env: Pick<AppEnvDto, 'env' | 'approvalPolicy' | 'approvalSettings'> }) {
	const choice = { policy: env.approvalPolicy, settings: env.approvalSettings }
	const { preset, differences } = nearestPreset(choice)
	return (
		<div className="policy-summary">
			<div>
				<strong>{preset.label}</strong>
				<span className="muted">
					{differences.length === 0 ? ', as the preset says' : `, ${differences.length} ${differences.length === 1 ? 'change' : 'changes'}`}
				</span>
			</div>
			{differences.length > 0 && (
				<dl className="policy-differences">
					{differences.map((difference) => (
						<div key={difference.key}>
							<dt>{difference.label}</dt>
							<dd>
								{difference.value} <span className="muted">({preset.label}: {difference.other})</span>
							</dd>
						</div>
					))}
				</dl>
			)}
			<details className="disclosure">
				<summary>
					<span className="disclosure-title">Every rule on {env.env}</span>
				</summary>
				<AllRules choice={choice} />
			</details>
		</div>
	)
}

/** Every category's mode and deciding, then the request settings, read only. */
function AllRules({ choice }: { choice: PolicyChoice }) {
	return (
		<dl className="policy-differences">
			{APPROVAL_CATEGORY_GROUPS.flatMap((group) => group.options).map((option) => {
				const deciding = decidingText(option.category, choice.settings)
				const mode = choice.policy[option.category]
				return (
					<div key={option.category}>
						<dt>{option.label}</dt>
						<dd>
							{modeLabel(mode)}
							{deciding !== null && mode !== 'off' && mode !== 'refuse' && <span className="muted">{` · ${deciding}`}</span>}
						</dd>
					</div>
				)
			})}
			<div>
				<dt>Commits an agent may ask to deploy</dt>
				<dd>{choice.settings.deployRequestCommits === 'merged' ? 'Merged commits' : 'Any commit'}</dd>
			</div>
			<div>
				<dt>Actions a key an agent asks for may hold</dt>
				<dd>{choice.settings.credentialCeiling === 'requester' ? "The agent's own" : "The approver's"}</dd>
			</div>
			<div>
				<dt>Hours a request waits for a decision</dt>
				<dd>{choice.settings.requestTtlHours} h</dd>
			</div>
		</dl>
	)
}

/**
 * What lets a change of each category through on a protected environment (ADR-0083), for a holder of `access.approve`:
 * one row per category and one radio column per mode, the preset's choice marked, how many people decide folded into
 * one cell, the request settings, and one save that names its changes and confirms first when it loosens any. A save
 * that weakens a passkey on deciding waits for its check on IAM's page, and the choice stays fixed until it is sent or
 * cancelled.
 */
export function PolicyEditor({ appId, env, onDone, onCancel }: { appId: string; env: AppEnvDto; onDone: () => void; onCancel: () => void }) {
	const saved: PolicyChoice = { policy: env.approvalPolicy, settings: env.approvalSettings }
	const [chosen, setChosen] = useState<ApprovalPolicy>(env.approvalPolicy)
	const [settings, setSettings] = useState<ApprovalSettings>(env.approvalSettings)
	const [ttlText, setTtlText] = useState(String(env.approvalSettings.requestTtlHours))
	const [base, setBase] = useState<PresetName>(() => nearestPreset(saved).preset.name)
	const [deciding, setDeciding] = useState<PolicyCategory | null>(null)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<DecisionFailure | null>(null)
	const [confirming, setConfirming] = useState(false)
	const [check, setCheck] = useState<PasskeyCheck<AppEnvDto> | null>(null)
	// The check is bound to the choice it was issued for, so the choice stays fixed while it waits.
	const locked = busy || check !== null
	const ttl = requestTtl(ttlText)
	const after: PolicyChoice = { policy: chosen, settings }
	const changes = policyDifferences(after, saved).length
	const preset = PRESETS.find((option) => option.name === base) ?? PRESETS[0]
	const fromPreset = policyDifferences(after, preset)
	const stepUp = protectionStepUp(env, true, after)

	function choose(category: PolicyCategory, mode: ApprovalMode) {
		const parsed = approvalPolicySchema.safeParse({ ...chosen, [category]: mode })
		if (parsed.success) setChosen(parsed.data)
	}

	function resetRule(category: PolicyCategory) {
		choose(category, preset.policy[category])
		setSettings(withDecidingOf(settings, preset.settings, category))
	}

	function chooseTtl(text: string) {
		setTtlText(text)
		const hours = requestTtl(text)
		if (hours !== null) setSettings({ ...settings, requestTtlHours: hours })
	}

	function startFrom(option: (typeof PRESETS)[number]) {
		setBase(option.name)
		setChosen(option.policy)
		setSettings(option.settings)
		setTtlText(String(option.settings.requestTtlHours))
	}

	function discard() {
		setChosen(saved.policy)
		setSettings(saved.settings)
		setTtlText(String(saved.settings.requestTtlHours))
		setError(null)
	}

	async function save() {
		const started = await setEnvironmentProtection(api, env, true, after)
		if (started.kind === 'posted') onDone()
		else setCheck(started.check)
	}

	async function apply() {
		setError(null)
		if (policyChange(saved, after) === 'confirm') {
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
		<div className="policy-editor">
			<div className="toolbar">
				<span className="muted">Start from</span>
				<div className="filter-group" role="group" aria-label="Start from a preset">
					{PRESETS.map((option) => (
						<button
							key={option.name}
							type="button"
							className="filter-option"
							aria-pressed={base === option.name}
							title={option.hint}
							disabled={locked}
							onClick={() => startFrom(option)}
						>
							{option.label}
						</button>
					))}
				</div>
				<span className="muted">
					{fromPreset.length === 0
						? `As ${preset.label} says: ${preset.hint}.`
						: `${fromPreset.length} ${fromPreset.length === 1 ? 'change' : 'changes'} from ${preset.label}`}
				</span>
			</div>
			{APPROVAL_CATEGORY_GROUPS.map((group) => (
				<RuleGroup
					key={group.title}
					env={env.env}
					title={group.title}
					options={group.options}
					policy={chosen}
					settings={settings}
					preset={preset}
					locked={locked}
					deciding={deciding}
					onChoose={choose}
					onReset={resetRule}
					onDeciding={(category) => setDeciding(deciding === category ? null : category)}
					onSettings={setSettings}
				/>
			))}
			<RequestSettings
				settings={settings}
				ttlText={ttlText}
				ttlValid={ttl !== null}
				preset={preset}
				locked={locked}
				onSettings={setSettings}
				onTtl={chooseTtl}
			/>
			<div className="save-bar">
				<span className="muted">
					{changes === 0 ? 'No changes' : `${changes} ${changes === 1 ? 'change' : 'changes'} to save`}
				</span>
				<span className="spacer" />
				<button type="button" onClick={changes === 0 ? onCancel : discard} disabled={locked}>
					{changes === 0 ? 'Back' : 'Discard'}
				</button>
				<button type="button" className="primary" disabled={changes === 0 || ttl === null || locked} onClick={() => void apply()}>
					Save approvals
				</button>
			</div>
			{error !== null && (
				<div className="error-text small" role="alert">
					<DecisionFailureText failure={error} />
				</div>
			)}
			{check !== null && (
				<PasskeyCheckPrompt
					check={check}
					onDone={onDone}
					onCancel={() => setCheck(null)}
					describeFailure={(cause) => protectionChangeFailure(cause, env.env, 'webauthn')}
				/>
			)}
			{confirming && (
				<ConfirmDialog
					title="Approve less"
					confirmLabel="Save approvals"
					body={
						<>
							<p>
								On <strong>{env.env}</strong> of <strong>{appId}</strong>, these will need less to go through: {looser.join(', ')}.
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
		</div>
	)
}

/** `settings` with one category's approvers, requester rule and passkey taken from `from`. */
function withDecidingOf(settings: ApprovalSettings, from: ApprovalSettings, category: PolicyCategory): ApprovalSettings {
	return {
		...settings,
		approvers: isApproverCategory(category) ? { ...settings.approvers, [category]: from.approvers[category] } : settings.approvers,
		requesterMayApprove: isApproverCategory(category)
			? { ...settings.requesterMayApprove, [category]: from.requesterMayApprove[category] }
			: settings.requesterMayApprove,
		stepUp: isStepUpCategory(category) ? { ...settings.stepUp, [category]: from.stepUp[category] } : settings.stepUp,
	}
}

/** One group of categories as a matrix: folded when every rule follows the preset, open when one differs. */
function RuleGroup(
	{ env, title, options, policy, settings, preset, locked, deciding, onChoose, onReset, onDeciding, onSettings }: {
		env: string
		title: string
		options: readonly CategoryOption[]
		policy: ApprovalPolicy
		settings: ApprovalSettings
		preset: (typeof PRESETS)[number]
		locked: boolean
		deciding: PolicyCategory | null
		onChoose: (category: PolicyCategory, mode: ApprovalMode) => void
		onReset: (category: PolicyCategory) => void
		onDeciding: (category: PolicyCategory) => void
		onSettings: (settings: ApprovalSettings) => void
	},
) {
	const differs = (category: PolicyCategory) =>
		policy[category] !== preset.policy[category] || decidingText(category, settings) !== decidingText(category, preset.settings)
	const changed = options.filter((option) => differs(option.category)).length
	// Open as the page opens when a rule differs; afterwards the person folds and unfolds it.
	const [open] = useState(changed > 0)
	return (
		<details className="rule-group" open={open}>
			<summary>
				<span className="disclosure-title">{title}</span>
				<span className="muted">
					{options.length} rules, {changed === 0 ? `all as ${preset.label}` : `${changed} changed from ${preset.label}`}
				</span>
			</summary>
			<div className="table-wrap">
				<table className="rule-matrix">
					<thead>
						<tr>
							<th className="grow">Rule</th>
							{APPROVAL_MODES.map((mode) => <th key={mode}>{modeLabel(mode)}</th>)}
							<th>Deciding</th>
						</tr>
					</thead>
					<tbody>
						{options.flatMap((option) => {
							const category = option.category
							const modes = modesOf(category)
							const text = decidingText(category, settings)
							const row = (
								<tr key={category} className={differs(category) ? 'changed' : undefined}>
									<th scope="row">
										{option.label}
										<div className="muted small">{option.hint}</div>
										{option.pending !== undefined && (
											<div className="small">
												<Chip>not enforced yet</Chip> <span className="muted">{option.pending}</span>
											</div>
										)}
										{differs(category) && (
											<button type="button" className="ghost small" disabled={locked} onClick={() => onReset(category)}>
												Reset to {preset.label}
												<span className="sr-only">{`: ${option.label}`}</span>
											</button>
										)}
									</th>
									{APPROVAL_MODES.map((mode) => (
										<td key={mode} className="matrix-cell">
											{modes.includes(mode) && (
												<label>
													<input
														type="radio"
														name={`${env}-${category}`}
														checked={policy[category] === mode}
														disabled={locked}
														onChange={() => onChoose(category, mode)}
														aria-label={`${option.label}: ${modeLabel(mode)}`}
													/>
													{preset.policy[category] === mode && (
														<span className="preset-mark" title={`${preset.label}'s choice`}>
															<span aria-hidden="true">•</span>
															<span className="sr-only">{` (${preset.label})`}</span>
														</span>
													)}
												</label>
											)}
										</td>
									))}
									<td>
										{text === null
											? <span className="muted small">IAM's own rule</span>
											: (
												<button
													type="button"
													className="ghost small deciding-toggle"
													aria-expanded={deciding === category}
													disabled={locked}
													onClick={() => onDeciding(category)}
												>
													{text}
													<Icon name="chevron-down" size={13} />
													<span className="sr-only">{`: who decides ${option.label}`}</span>
												</button>
											)}
									</td>
								</tr>
							)
							if (deciding !== category || text === null) return [row]
							return [
								row,
								<tr key={`${category}-deciding`} className="deciding-row">
									<td colSpan={APPROVAL_MODES.length + 2}>
										<DecidingControls env={env} category={category} label={option.label} settings={settings} locked={locked} onSettings={onSettings} />
									</td>
								</tr>,
							]
						})}
					</tbody>
				</table>
			</div>
		</details>
	)
}

/** The second level: how many people decide, whether the requester's person may, and whether a passkey confirms. */
function DecidingControls(
	{ env, category, label, settings, locked, onSettings }: {
		env: string
		category: PolicyCategory
		label: string
		settings: ApprovalSettings
		locked: boolean
		onSettings: (settings: ApprovalSettings) => void
	},
) {
	return (
		<fieldset className="deciding-controls" disabled={locked}>
			<legend className="sr-only">Who decides {label}</legend>
			{isApproverCategory(category) && (
				<>
					<label className="radio">
						<input
							type="radio"
							name={`${env}-${category}-approvers`}
							checked={settings.approvers[category] === 1}
							onChange={() => onSettings({ ...settings, approvers: { ...settings.approvers, [category]: 1 } })}
						/>
						One person decides
					</label>
					<label className="radio">
						<input
							type="radio"
							name={`${env}-${category}-approvers`}
							checked={settings.approvers[category] === 2}
							onChange={() => onSettings({ ...settings, approvers: { ...settings.approvers, [category]: 2 } })}
						/>
						Two people decide
					</label>
					<label className="checkbox">
						<input
							type="checkbox"
							checked={settings.requesterMayApprove[category]}
							onChange={(event) => onSettings({ ...settings, requesterMayApprove: { ...settings.requesterMayApprove, [category]: event.target.checked } })}
						/>
						The requester's own person may decide an agent's request
					</label>
				</>
			)}
			{isStepUpCategory(category) && (
				<label className="checkbox">
					<input
						type="checkbox"
						checked={settings.stepUp[category] === 'webauthn'}
						onChange={(event) => onSettings({ ...settings, stepUp: { ...settings.stepUp, [category]: event.target.checked ? 'webauthn' : 'none' } })}
					/>
					{category === 'agent-write' ? 'A passkey confirms allowing an agent to write' : 'A passkey confirms deciding'}
				</label>
			)}
		</fieldset>
	)
}

/** The three request settings, as their own group. */
function RequestSettings(
	{ settings, ttlText, ttlValid, preset, locked, onSettings, onTtl }: {
		settings: ApprovalSettings
		ttlText: string
		ttlValid: boolean
		preset: (typeof PRESETS)[number]
		locked: boolean
		onSettings: (settings: ApprovalSettings) => void
		onTtl: (text: string) => void
	},
) {
	const changed = [
		settings.deployRequestCommits !== preset.settings.deployRequestCommits,
		settings.credentialCeiling !== preset.settings.credentialCeiling,
		settings.requestTtlHours !== preset.settings.requestTtlHours,
	].filter(Boolean).length
	const [open] = useState(changed > 0)
	return (
		<details className="rule-group" open={open}>
			<summary>
				<span className="disclosure-title">Agent requests</span>
				<span className="muted">3 settings, {changed === 0 ? `all as ${preset.label}` : `${changed} changed from ${preset.label}`}</span>
			</summary>
			<div className="form">
				<label>
					Commits an agent may ask to deploy
					<select
						value={settings.deployRequestCommits}
						disabled={locked}
						onChange={(event) => onSettings({ ...settings, deployRequestCommits: event.target.value === 'any' ? 'any' : 'merged' })}
					>
						<option value="merged">Merged commits</option>
						<option value="any">Any commit</option>
					</select>
					<span className="hint">
						Merged means reachable from the trigger branch, or the default branch when it is a pattern; never a workspace branch, whichever is chosen.
					</span>
				</label>
				<label>
					Actions a key an agent asks for may hold
					<select
						value={settings.credentialCeiling}
						disabled={locked}
						onChange={(event) => onSettings({ ...settings, credentialCeiling: event.target.value === 'approver' ? 'approver' : 'requester' })}
					>
						<option value="requester">The agent's own</option>
						<option value="approver">The approver's</option>
					</select>
					<span className="hint">
						The agent's own: only actions the agent holds at the application when it asks. The approver's: any action the approver holds; the request page
						marks those the agent lacks.
					</span>
				</label>
				<label>
					Hours a request waits for a decision
					<input
						type="number"
						min={REQUEST_TTL_HOURS.min}
						max={REQUEST_TTL_HOURS.max}
						value={ttlText}
						disabled={locked}
						aria-invalid={!ttlValid}
						onChange={(event) => onTtl(event.target.value)}
					/>
					<span className="hint">
						{`${REQUEST_TTL_HOURS.min}–${REQUEST_TTL_HOURS.max}, ${REQUEST_TTL_HOURS.default} by default; past it, the request expires.`}
					</span>
					{!ttlValid && <span className="error-text small">A whole number of hours from {REQUEST_TTL_HOURS.min} to {REQUEST_TTL_HOURS.max}.</span>}
				</label>
			</div>
		</details>
	)
}

/** What a confirmation says before a change that takes one of the person's passkeys. */
function StepUpNote({ stepUp }: { stepUp: StepUpMode }) {
	if (stepUp === 'none') return null
	return (
		<p>
			A passkey confirms deciding here, so this change takes one of your passkeys: when you confirm, the console links to IAM's page, where you confirm
			it with a passkey.
		</p>
	)
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
