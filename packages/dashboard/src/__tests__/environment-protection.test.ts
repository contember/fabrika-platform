import { buildRouteTree, createMemoryNavigationAdapter, Router } from '@buzola/router'
import { BuzolaProvider } from '@buzola/router/react'
import { RpcError } from '@fabrika/app'
import {
	type ApprovalStepUpChallenge,
	APPROVER_CATEGORIES,
	PERMISSIVE_POLICY,
	PERMISSIVE_SETTINGS,
	POLICY_CATEGORIES,
	STRICT_POLICY,
	STRICT_SETTINGS,
} from '@fabrika/control-contract'
import { describe, expect, test } from 'bun:test'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PolicyEditor, ProtectionRow, UnprotectConsequences } from '../components/app-detail/ApprovalsSection'
import { DecisionFailureText } from '../components/DecisionFailureNotice'
import { type AppEnvDto, type ApprovalDto, type ConsoleAccessDto, type ControlFetch, createControlClient } from '../lib/api'
import { ConsoleAccessContext } from '../lib/console-caller'
import {
	APPROVAL_CATEGORY_GROUPS,
	categoryLabel,
	loosened,
	loosenedSettings,
	parkedRunsAt,
	policyChange,
	presetOf,
	protectionChangeFailure,
	protectionFailure,
	protectionToggle,
	requesterBlocks,
	requestTtl,
	setEnvironmentProtection,
	settingsSummary,
	waitingSummary,
} from '../lib/environment-protection'
import { type PasskeyCredentials, toBase64Url } from '../lib/webauthn'

const environment = (env: string, isProtected: boolean): AppEnvDto => ({
	appId: 'notes',
	env,
	domain: null,
	publicOrigin: null,
	triggerRef: 'refs/heads/main',
	authoring: false,
	protected: isProtected,
	approvalCategories: ['off-road', 'anyone-calls', 'get-mutation', 'people', 'adoption', 'terminal', 'deletes-data'],
	approvalPolicy: STRICT_POLICY,
	approvalSettings: STRICT_SETTINGS,
	publishedRunId: null,
	deviationSubjects: [],
	surface: [],
	namespaceId: null,
	provider: 'zerops',
	target: { provider: 'zerops', version: 1, payload: {} },
	artifact: { provider: 'zerops', version: 1, payload: {} },
	createdAt: 0,
})

const parkedRun = (id: string, appId: string, env: string): ApprovalDto => ({
	run: {
		id,
		appId,
		env,
		ref: 'refs/heads/main',
		commitSha: null,
		trigger: 'webhook',
		actor: null,
		status: 'awaiting_approval',
		exitCode: null,
		externalRunId: null,
		logKey: null,
		createdAt: 0,
		startedAt: null,
		finishedAt: null,
		cancelRequestedAt: null,
	},
	outcome: 'widening',
	changes: [{ effect: 'widens', line: 'Role `editor` gains `notes.delete`' }],
	candidateDigest: 'candidate',
	baselineDigest: 'baseline',
	baselineRunId: null,
	protected: true,
	categories: ['off-road', 'anyone-calls', 'get-mutation', 'people', 'adoption', 'terminal', 'deletes-data'],
	approval: null,
	approvers: 1,
	requesterMayApprove: true,
	stepUp: 'none',
})

const withRouter = (element: ReactElement): ReactElement =>
	createElement(BuzolaProvider, {
		router: new Router({
			routes: buildRouteTree([{ path: '/', component: () => null, isIndex: true }]),
			adapter: createMemoryNavigationAdapter(),
			pageRegistry: { 'approvals/detail': '/approvals/:id' },
		}),
	}, element)

const row = (access: ConsoleAccessDto | null, env: AppEnvDto): string =>
	renderToStaticMarkup(
		createElement(
			ConsoleAccessContext.Provider,
			{ value: access },
			createElement('table', null, createElement('tbody', null, createElement(ProtectionRow, { appId: 'notes', env, onDone: () => undefined }))),
		),
	)

const holding = (actions: string[], scope?: { type: 'app' | 'environment'; value: string }): ConsoleAccessDto => ({
	principal: null,
	global: scope === undefined ? actions : [],
	scopes: scope === undefined ? [] : [{ ...scope, actions }],
})

function respondingFetch(calls: { method: string; input: unknown }[], response: Response): ControlFetch {
	return async (_input, init) => {
		if (typeof init?.body !== 'string') throw new Error('expected JSON RPC body')
		const body: unknown = JSON.parse(init.body)
		if (body === null || typeof body !== 'object' || !('method' in body) || typeof body.method !== 'string' || !('input' in body)) {
			throw new Error('expected RPC envelope')
		}
		calls.push({ method: body.method, input: body.input })
		return response
	}
}

const CHECKBOX_LABEL = 'Require approval for access changes'

describe('turning approvals on and off for an environment', () => {
	test('the switch shows only to a caller holding access.approve at the environment', () => {
		const prod = environment('prod', true)
		expect(row(holding(['access.approve']), prod)).toContain(CHECKBOX_LABEL)
		expect(row(holding(['access.approve'], { type: 'app', value: 'notes' }), prod)).toContain(CHECKBOX_LABEL)
		expect(row(holding(['access.approve'], { type: 'environment', value: 'prod' }), prod)).toContain(CHECKBOX_LABEL)

		for (const access of [holding(['app.manage', 'deploy.trigger']), holding(['access.approve'], { type: 'environment', value: 'stage' })]) {
			const markup = row(access, prod)
			expect(markup).not.toContain(CHECKBOX_LABEL)
			expect(markup).not.toContain('type="checkbox"')
			expect(markup).toContain('Approval required')
		}
		expect(row(holding(['app.manage']), environment('stage', false))).toContain('No approval required')
	})

	test('the switch shows the stored setting', () => {
		expect(row(holding(['access.approve']), environment('prod', true))).toContain('checked=""')
		expect(row(holding(['access.approve']), environment('stage', false))).not.toContain('checked=""')
	})

	test('turning approvals off asks for a confirmation; turning them on applies at once', () => {
		expect(protectionToggle(false)).toBe('confirm')
		expect(protectionToggle(true)).toBe('apply')
	})

	test('the confirmation says what turning approvals off means', () => {
		const markup = renderToStaticMarkup(withRouter(createElement(UnprotectConsequences, { appId: 'notes', env: 'prod', parked: [], stepUp: 'none' })))
		expect(markup).toContain('publishes at once, without a person&#x27;s approval')
		expect(markup).toContain('The audit log records this change')
		expect(markup).toContain('Turning approvals back on applies from the next deploy')
		expect(markup).not.toContain('waits for approval')
		expect(markup).not.toContain('passkey')
		const passkey = renderToStaticMarkup(
			withRouter(createElement(UnprotectConsequences, { appId: 'notes', env: 'prod', parked: [], stepUp: 'webauthn' })),
		)
		expect(passkey).toContain('this change takes one of your passkeys: your browser asks for it when you confirm')
	})

	test('a deploy parked on the environment stays parked: the confirmation names it and says it still needs a decision', () => {
		const parked = parkedRunsAt(
			[
				parkedRun('01a144a6-0001', 'notes', 'prod'),
				parkedRun('01a144a6-0002', 'notes', 'stage'),
				parkedRun('01a144a6-0003', 'blog', 'prod'),
			],
			'notes',
			'prod',
		)
		expect(parked.map((approval) => approval.run.id)).toEqual(['01a144a6-0001'])

		const markup = renderToStaticMarkup(withRouter(createElement(UnprotectConsequences, { appId: 'notes', env: 'prod', parked, stepUp: 'none' })))
		expect(markup).toContain('1 deploy of prod waits for approval: <span><a href="/approvals/01a144a6-0001">run <code>01a144a6</code></a></span>')
		expect(markup).toContain('Turning approvals off does not approve it.')
		expect(markup).toContain('until a person approves, rejects or cancels it')

		const unknown = renderToStaticMarkup(
			withRouter(createElement(UnprotectConsequences, { appId: 'notes', env: 'prod', parked: null, stepUp: 'none' })),
		)
		expect(unknown).toContain('keeps waiting until a person approves, rejects or cancels it: turning approvals off approves nothing')
	})

	test('the change calls apps.environments.protect with the environment and the new value', async () => {
		const calls: { method: string; input: unknown }[] = []
		const client = createControlClient(respondingFetch(calls, Response.json({ result: environment('prod', false) })))
		const changed = await setEnvironmentProtection(client, environment('prod', false), false, undefined, null)
		expect(changed.protected).toBe(false)
		expect(calls).toEqual([{ method: 'apps.environments.protect', input: { appId: 'notes', env: 'prod', protected: false } }])
	})

	test('a running deploy (409) and a refusal (403) read as what the operator can do about them', async () => {
		const refused = async (status: number, message: string): Promise<string> => {
			const client = createControlClient(respondingFetch([], Response.json({ error: { type: 'error', message } }, { status })))
			try {
				await setEnvironmentProtection(client, environment('prod', true), true, undefined, null)
			} catch (cause) {
				return protectionFailure(cause, 'prod')
			}
			throw new Error('expected a refusal')
		}
		expect(await refused(409, 'a deployment is running; retry')).toBe(
			'A deploy of prod is running. Approvals change between deploys: try again when it finishes.',
		)
		expect(await refused(403, 'an access change is approved in the console, not with a key')).toBe(
			'Only a person signed in to the console changes approvals, never a key or an agent.',
		)
		expect(await refused(400, 'invalid input')).toBe('invalid input')
	})
})

// ADR-0083 §5: the mode of each category under a protected environment's switch, editable for a holder of `access.approve`.
describe('approval modes', () => {
	const editor = (env: AppEnvDto): string => renderToStaticMarkup(createElement(PolicyEditor, { appId: 'notes', env, onDone: () => undefined }))

	test('every category is offered once with only the modes it takes, the stored ones selected and the defaults marked', () => {
		const markup = editor({ ...environment('prod', true), approvalPolicy: { ...STRICT_POLICY, grants: 'person', secrets: 'refuse' } })
		const offered = APPROVAL_CATEGORY_GROUPS.flatMap((group) => group.options.map((option) => option.category))
		expect([...offered].sort()).toEqual([...POLICY_CATEGORIES].sort())
		// A mode per category; a number of approvers, whether the requester's person decides and whether a passkey confirms
		// the decision per approver category; whether a passkey confirms an agent's write access; the commits a request may
		// name; and what bounds a key an agent asks for.
		const selects = POLICY_CATEGORIES.length + APPROVER_CATEGORIES.length * 3 + 1 + 2
		expect(markup.match(/<select/g)).toHaveLength(selects)
		// 12 deploy-line categories take three modes, `grants` two, the 7 actions three, `agent-write` two; approvers one or
		// two; the requester's person or someone else; a passkey or none; commits two; the key's ceiling two.
		expect(markup.match(/<option/g)).toHaveLength(12 * 3 + 2 + 7 * 3 + 2 + APPROVER_CATEGORIES.length * 6 + 2 + 2 + 2)
		expect(markup.match(/selected=""/g)).toHaveLength(selects)
		expect(markup).toContain('<option value="refuse" selected="">Refused</option>')
		expect(markup).toContain('<option value="person" selected="">A person approves</option>')
		expect(markup).toContain('<option value="person" selected="">A person approves (default)</option>')
		expect(markup).toContain('<option value="webauthn" selected="">Passkey to decide (default)</option>')
		expect(markup).toContain('<option value="webauthn" selected="">Passkey to allow (default)</option>')
		expect(markup).toContain('<option value="off" selected="">No approval (default)</option>')
		expect(markup).toContain('Custom')
	})

	test('the presets are offered, the stored one pressed', () => {
		expect(editor(environment('prod', true))).toContain('aria-pressed="true" title="a person approves what an agent asks for; the default"')
		expect(editor({ ...environment('prod', true), approvalPolicy: PERMISSIVE_POLICY, approvalSettings: PERMISSIVE_SETTINGS })).toContain(
			'aria-pressed="true" title="an agent configures and deploys any commit with no approval"',
		)
		expect(presetOf(STRICT_POLICY, STRICT_SETTINGS)).toBe('strict')
		expect(presetOf(PERMISSIVE_POLICY, PERMISSIVE_SETTINGS)).toBe('permissive')
		expect(PERMISSIVE_SETTINGS.deployRequestCommits).toBe('any')
		// The permissive modes with merged commits only, or two approvers anywhere, are no preset.
		expect(presetOf(PERMISSIVE_POLICY, STRICT_SETTINGS)).toBeNull()
		expect(presetOf(STRICT_POLICY, { ...STRICT_SETTINGS, approvers: { ...STRICT_SETTINGS.approvers, secrets: 2 } })).toBeNull()
		expect(presetOf({ ...STRICT_POLICY, csp: 'plan' }, STRICT_SETTINGS)).toBeNull()
	})

	test('an action no request routes yet says what applies today', () => {
		const markup = editor(environment('prod', true))
		expect(markup).toContain('Not enforced yet. Today it applies at once.')
		expect(markup).toContain('aria-describedby="approval-prod-secrets"')
		expect(markup).toContain('id="approval-prod-secrets"')
	})

	test('the ceiling of a key an agent asks for is a setting, the agent’s own by default', () => {
		const markup = editor(environment('prod', true))
		expect(markup).toContain('aria-label="Actions a key an agent asks for may hold"')
		expect(markup).toContain('The agent&#x27;s own (default)')
		expect(settingsSummary({ ...STRICT_SETTINGS, credentialCeiling: 'approver' })).toContain(
			'A key an agent asks for may hold any action its approver holds.',
		)
	})

	test('a change that loosens any category asks first; one that tightens does not', () => {
		const strict = { policy: STRICT_POLICY, settings: STRICT_SETTINGS }
		expect(policyChange(strict, { policy: PERMISSIVE_POLICY, settings: PERMISSIVE_SETTINGS })).toBe('confirm')
		expect(policyChange(strict, { ...strict, policy: { ...STRICT_POLICY, 'off-road': 'person', 'role-actions': 'plan', secrets: 'refuse' } })).toBe(
			'apply',
		)
		const two = { ...STRICT_SETTINGS, requestTtlHours: 2, approvers: { ...STRICT_SETTINGS.approvers, secrets: 2 } }
		// Two approvers and a shorter wait tighten; an unmerged commit or one approver where two decided loosens.
		expect(policyChange(strict, { ...strict, settings: two })).toBe('apply')
		expect(policyChange({ ...strict, settings: two }, strict)).toBe('confirm')
		expect(loosenedSettings(two, { ...STRICT_SETTINGS, deployRequestCommits: 'any' })).toEqual([
			'an agent may ask to deploy an unmerged commit',
			'Secrets (one approver)',
		])
		expect(loosened(STRICT_POLICY, { ...STRICT_POLICY, 'deletes-data': 'plan', 'deploy-request': 'off' })).toEqual(['deletes-data', 'deploy-request'])
		// Someone other than the requester's person tightens; letting that person decide again loosens.
		const others = { ...STRICT_SETTINGS, requesterMayApprove: { ...STRICT_SETTINGS.requesterMayApprove, secrets: false } }
		expect(policyChange(strict, { ...strict, settings: others })).toBe('apply')
		expect(loosenedSettings(others, STRICT_SETTINGS)).toEqual(["Secrets (the requester's person may approve)"])
		expect(presetOf(STRICT_POLICY, others)).toBeNull()
		// A passkey on deciding tightens; deciding without one again loosens, the default's own included.
		const passkey = { ...STRICT_SETTINGS, stepUp: { ...STRICT_SETTINGS.stepUp, secrets: 'webauthn' as const } }
		expect(policyChange(strict, { ...strict, settings: passkey })).toBe('apply')
		expect(loosenedSettings(passkey, STRICT_SETTINGS)).toEqual(['Secrets (no passkey to decide)'])
		expect(policyChange(strict, { ...strict, settings: { ...STRICT_SETTINGS, stepUp: PERMISSIVE_SETTINGS.stepUp } })).toBe('confirm')
		expect(presetOf(STRICT_POLICY, passkey)).toBeNull()
		// A key bounded by its approver rather than its requester loosens; bounding it by the requester again tightens.
		const approverCeiling = { ...STRICT_SETTINGS, credentialCeiling: 'approver' as const }
		expect(loosenedSettings(STRICT_SETTINGS, approverCeiling)).toEqual(['a key an agent asks for may hold actions the agent does not'])
		expect(policyChange({ ...strict, settings: approverCeiling }, strict)).toBe('apply')
		expect(presetOf(STRICT_POLICY, approverCeiling)).toBeNull()
	})

	test("an approve button is withheld from the requester's person, and from everyone when that person is unknown", () => {
		expect(requesterBlocks(true, null, 'p-ada')).toBeNull()
		expect(requesterBlocks(false, 'p-ada', 'p-ada')).toBe('you')
		expect(requesterBlocks(false, 'p-ada', 'p-bob')).toBeNull()
		expect(requesterBlocks(false, null, 'p-bob')).toBe('nobody')
	})

	test('the hours a request waits take a whole number within their bounds', () => {
		expect(['1', '24', '168'].map(requestTtl)).toEqual([1, 24, 168])
		expect(['0', '169', '1.5', '', 'x'].map(requestTtl)).toEqual([null, null, null, null, null])
	})

	test('a reader who cannot change the policy reads what waits', () => {
		expect(waitingSummary(PERMISSIVE_POLICY)).toBe('Nothing waits.')
		expect(waitingSummary({ ...PERMISSIVE_POLICY, 'deletes-data': 'person', registry: 'refuse' })).toBe(
			'Waits for a person: Migrations that may change stored data; refused to an agent: Where a deploy points.',
		)
		expect(settingsSummary(STRICT_SETTINGS)).toBe(
			'An agent asks to deploy merged commits only. A request waits 24 h for a decision. A key an agent asks for holds only actions the agent holds. '
				+ `A passkey confirms deciding: ${categoryLabel('credentials')}. A passkey confirms letting an agent write as a person.`,
		)
		expect(settingsSummary(PERMISSIVE_SETTINGS)).not.toContain('passkey')
		expect(settingsSummary({ ...PERMISSIVE_SETTINGS, approvers: { ...STRICT_SETTINGS.approvers, 'deploy-request': 2 } })).toContain(
			'An agent may ask to deploy any commit.',
		)
		expect(settingsSummary({ ...STRICT_SETTINGS, requesterMayApprove: { ...STRICT_SETTINGS.requesterMayApprove, 'deploy-request': false } }))
			.toContain("Someone other than the requester's person decides: A deploy started by an agent or a key.")
	})

	test('the protection call sends the policy and settings only when given', async () => {
		const sent: unknown[] = []
		const fetch: ControlFetch = (_input, init) => {
			sent.push(JSON.parse(String(init?.body)))
			return Promise.resolve(Response.json({ result: environment('prod', true) }))
		}
		const client = createControlClient(fetch)
		const permissive = { ...STRICT_SETTINGS, ...PERMISSIVE_SETTINGS, stepUp: STRICT_SETTINGS.stepUp }
		await setEnvironmentProtection(client, environment('prod', true), true, {
			policy: { ...PERMISSIVE_POLICY, credentials: 'person' },
			settings: permissive,
		}, null)
		await setEnvironmentProtection(client, environment('prod', true), true, undefined, null)
		expect(sent).toEqual([
			{
				method: 'apps.environments.protect',
				input: { appId: 'notes', env: 'prod', protected: true, policy: { ...PERMISSIVE_POLICY, credentials: 'person' }, settings: permissive },
			},
			{ method: 'apps.environments.protect', input: { appId: 'notes', env: 'prod', protected: true } },
		])
	})
})

// ADR-0050 §5: a change that weakens what deciding takes where a passkey confirms it takes a passkey too.
describe('a change that weakens a passkey on deciding', () => {
	const bytes = (...values: number[]) => Uint8Array.from(values).buffer
	const ISSUED: ApprovalStepUpChallenge = {
		kind: 'challenge',
		challenge: {
			challengeId: 'challenge-1',
			expiresAt: 0,
			options: {
				challenge: toBase64Url(bytes(4, 5, 6)),
				rpId: 'console.example.test',
				timeout: 300_000,
				allowCredentials: [{ type: 'public-key', id: toBase64Url(bytes(7, 7)) }],
				userVerification: 'required',
			},
		},
	}

	/** A Control and a browser that record, in order, what each was asked; the challenge answers `issued`. */
	function console(issued: ApprovalStepUpChallenge = ISSUED) {
		const steps: string[] = []
		const sent: { method: string; input: unknown }[] = []
		const fetch: ControlFetch = (_input, init) => {
			const body: { method: string; input: unknown } = JSON.parse(String(init?.body))
			steps.push(body.method)
			sent.push(body)
			return Promise.resolve(Response.json({ result: body.method === 'apps.environments.protectChallenge' ? issued : environment('prod', true) }))
		}
		const credentials: PasskeyCredentials = {
			create: () => Promise.reject(new Error('not asked')),
			get: () => {
				steps.push('passkey')
				return Promise.resolve({
					type: 'public-key',
					rawId: bytes(0xfb, 0xff),
					response: { clientDataJSON: bytes(1), authenticatorData: bytes(2), signature: bytes(3), userHandle: null },
				})
			},
		}
		return { steps, sent, client: createControlClient(fetch), credentials }
	}

	test('unprotecting, or dropping the passkey, runs the prompt first on a challenge for that change, which carries its answer', async () => {
		const off = console()
		await setEnvironmentProtection(off.client, environment('prod', true), false, undefined, off.credentials)
		expect(off.steps).toEqual(['apps.environments.protectChallenge', 'passkey', 'apps.environments.protect'])
		expect(off.sent[0]).toEqual({ method: 'apps.environments.protectChallenge', input: { appId: 'notes', env: 'prod', protected: false } })
		expect(off.sent[1]?.input).toMatchObject({ appId: 'notes', env: 'prod', protected: false, stepUp: { challengeId: 'challenge-1' } })

		const dropped = console()
		const settings = { ...STRICT_SETTINGS, stepUp: { ...STRICT_SETTINGS.stepUp, credentials: 'none' as const } }
		await setEnvironmentProtection(dropped.client, environment('prod', true), true, { policy: STRICT_POLICY, settings }, dropped.credentials)
		expect(dropped.steps).toEqual(['apps.environments.protectChallenge', 'passkey', 'apps.environments.protect'])
		expect(dropped.sent[0]?.input).toEqual({ appId: 'notes', env: 'prod', protected: true, policy: STRICT_POLICY, settings })
	})

	test('a tightening, a change elsewhere and an unprotected environment are sent as they are', async () => {
		const c = console()
		const tighter = { ...STRICT_SETTINGS, approvers: { ...STRICT_SETTINGS.approvers, credentials: 2 as const } }
		await setEnvironmentProtection(c.client, environment('prod', true), true, { policy: STRICT_POLICY, settings: tighter }, c.credentials)
		await setEnvironmentProtection(c.client, environment('prod', true), true, {
			policy: { ...STRICT_POLICY, secrets: 'off' },
			settings: STRICT_SETTINGS,
		}, c.credentials)
		await setEnvironmentProtection(
			c.client,
			environment('stage', false),
			false,
			{ policy: PERMISSIVE_POLICY, settings: PERMISSIVE_SETTINGS },
			c.credentials,
		)
		expect(c.steps).toEqual(['apps.environments.protect', 'apps.environments.protect', 'apps.environments.protect'])
	})

	test('a person without a passkey is told so and where to register one, and nothing changes', async () => {
		const c = console({ kind: 'no-passkey' })
		const cause = await setEnvironmentProtection(c.client, environment('prod', true), false, undefined, c.credentials).catch((error: unknown) => error)
		expect(c.steps).toEqual(['apps.environments.protectChallenge'])
		const failure = protectionChangeFailure(cause, 'prod', 'webauthn')
		expect(failure).toEqual({
			message: 'You have no passkey, and this change takes one. Register one under Account → Passkeys, then save again.',
			noPasskey: true,
		})
		const router = new Router({
			routes: buildRouteTree([{ path: '/', component: () => null, isIndex: true }]),
			adapter: createMemoryNavigationAdapter(),
			pageRegistry: { 'account/passkeys': '/account/passkeys' },
		})
		const markup = renderToStaticMarkup(createElement(BuzolaProvider, { router }, createElement(DecisionFailureText, { failure })))
		expect(markup).toContain('<a href="/account/passkeys">Account → Passkeys</a>')
	})

	test("Control's refusal of a change that took a passkey reads in Control's words", () => {
		const refusal = (message: string) => new RpcError({ type: 'forbidden', message, httpStatus: 403 })
		expect(protectionChangeFailure(refusal('the passkey check failed, so nothing was changed; try again'), 'prod', 'webauthn')).toEqual({
			message: 'the passkey check failed, so nothing was changed; try again',
			noPasskey: false,
		})
		// A page that expected no passkey, while Control holds that the change takes one, reads Control's reason too.
		expect(protectionChangeFailure(refusal('this change takes a passkey: confirm it with one of your passkeys'), 'prod', 'none')).toEqual({
			message: 'this change takes a passkey: confirm it with one of your passkeys',
			noPasskey: false,
		})
	})

	test("a conflict on a change that takes a passkey reads in Control's words; one without, as a running deploy", () => {
		const conflict = (message: string) => new RpcError({ type: 'conflict', message, httpStatus: 409 })
		expect(protectionChangeFailure(conflict('this change takes no passkey'), 'prod', 'webauthn')).toEqual({
			message: 'this change takes no passkey',
			noPasskey: false,
		})
		expect(protectionChangeFailure(conflict('a deployment is running; retry'), 'prod', 'none')).toEqual({
			message: 'A deploy of prod is running. Approvals change between deploys: try again when it finishes.',
			noPasskey: false,
		})
	})
})
