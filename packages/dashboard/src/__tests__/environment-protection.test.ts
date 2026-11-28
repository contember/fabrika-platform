import { buildRouteTree, createMemoryNavigationAdapter, Router } from '@buzola/router'
import { BuzolaProvider } from '@buzola/router/react'
import { RpcError } from '@fabrika/app'
import {
	type ApprovalStepUpChallenge,
	PERMISSIVE_POLICY,
	PERMISSIVE_SETTINGS,
	POLICY_CATEGORIES,
	type PolicyCategory,
	STRICT_POLICY,
	STRICT_SETTINGS,
} from '@fabrika/control-contract'
import { describe, expect, test } from 'bun:test'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PolicyEditor, PolicySummary, ProtectionRow, UnprotectConsequences } from '../components/app-detail/ApprovalsSection'
import { DecisionFailureText } from '../components/DecisionFailureNotice'
import { type AppEnvDto, type ApprovalDto, type ConsoleAccessDto, type ControlFetch, createControlClient } from '../lib/api'
import { planTtl } from '../lib/approval-plans'
import { ConsoleAccessContext } from '../lib/console-caller'
import {
	APPROVAL_CATEGORY_GROUPS,
	decidingText,
	loosened,
	loosenedSettings,
	nearestPreset,
	parkedRunsAt,
	policyChange,
	type PolicyChoice,
	policyDifferences,
	presetOf,
	protectionChangeFailure,
	protectionFailure,
	protectionToggle,
	requesterBlocks,
	requestTtl,
	saveStatus,
	setEnvironmentProtection,
} from '../lib/environment-protection'

const strictChoice: PolicyChoice = { policy: STRICT_POLICY, settings: STRICT_SETTINGS }

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
			pageRegistry: { 'approvals/detail': '/approvals/:id', 'apps/approvals-edit': '/apps/:id/approvals/:env/edit' },
		}),
	}, element)

const row = (access: ConsoleAccessDto | null, env: AppEnvDto): string =>
	renderToStaticMarkup(
		createElement(
			ConsoleAccessContext.Provider,
			{ value: access },
			withRouter(
				createElement('table', null, createElement('tbody', null, createElement(ProtectionRow, { appId: 'notes', env, onDone: () => undefined }))),
			),
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

describe('turning approvals on and off for an environment', () => {
	test('turning approval off and editing the rules show only to a caller holding access.approve at the environment', () => {
		const prod = environment('prod', true)
		for (
			const access of [
				holding(['access.approve']),
				holding(['access.approve'], { type: 'app', value: 'notes' }),
				holding(['access.approve'], { type: 'environment', value: 'prod' }),
			]
		) {
			const markup = row(access, prod)
			expect(markup).toContain('Turn off<span class="sr-only"> approval on prod</span>')
			expect(markup).toContain('href="/apps/notes/approvals/prod/edit"')
		}
		for (const access of [holding(['app.manage', 'deploy.trigger']), holding(['access.approve'], { type: 'environment', value: 'stage' })]) {
			const markup = row(access, prod)
			expect(markup).not.toContain('Turn off')
			expect(markup).not.toContain('/edit')
			expect(markup).toContain('On</span>')
		}
	})

	test('the row shows the stored setting: on with its rules, off with what that means and a way to turn it on', () => {
		const on = row(holding(['access.approve']), environment('prod', true))
		expect(on).toContain('On</span>')
		expect(on).toContain('<strong>Strict</strong>')
		const off = row(holding(['access.approve']), environment('stage', false))
		expect(off).toContain('Off</span>')
		expect(off).toContain('A deploy that widens access publishes at once.')
		expect(off).toContain('Turn on<span class="sr-only"> approval on stage</span>')
		expect(off).not.toContain('/edit')
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
		expect(passkey).toContain('this change takes one of your passkeys: when you confirm, the console links to IAM&#x27;s page')
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
		const changed = await setEnvironmentProtection(client, environment('prod', false), false, undefined)
		expect(changed).toMatchObject({ kind: 'posted', value: { protected: false } })
		expect(calls).toEqual([{ method: 'apps.environments.protect', input: { appId: 'notes', env: 'prod', protected: false } }])
	})

	test('a running deploy (409) and a refusal (403) read as what the operator can do about them', async () => {
		const refused = async (status: number, message: string): Promise<string> => {
			const client = createControlClient(respondingFetch([], Response.json({ error: { type: 'error', message } }, { status })))
			try {
				await setEnvironmentProtection(client, environment('prod', true), true, undefined)
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
	const editor = (env: AppEnvDto): string =>
		renderToStaticMarkup(createElement(PolicyEditor, { appId: 'notes', env, onDone: () => undefined, onCancel: () => undefined }))
	const radios = (markup: string, category: string): string[] =>
		[...markup.matchAll(new RegExp(`<input type="radio"[^>]*name="prod-${category}"[^>]*>`, 'g'))].map((match) => match[0])

	test("every category is one row with a radio for each mode it takes, the stored one checked and the preset's marked", () => {
		const markup = editor({ ...environment('prod', true), approvalPolicy: { ...STRICT_POLICY, grants: 'person', secrets: 'refuse' } })
		const offered = APPROVAL_CATEGORY_GROUPS.flatMap((group) => group.options.map((option) => option.category))
		expect([...offered].sort()).toEqual([...POLICY_CATEGORIES].sort())
		// 12 deploy-line categories take three modes, `grants` two, the 7 actions three, `agent-write` two.
		expect(markup.match(/<input type="radio"[^>]*name="prod-[a-z-]+"[^>]*>/g)).toHaveLength(12 * 3 + 2 + 7 * 3 + 2)
		for (const category of POLICY_CATEGORIES) expect(radios(markup, category).filter((input) => input.includes('checked=""'))).toHaveLength(1)
		expect(radios(markup, 'secrets').find((input) => input.includes('checked=""'))).toContain('aria-label="Secrets: Refused"')
		expect(radios(markup, 'grants').find((input) => input.includes('checked=""'))).toContain(
			'aria-label="Console grants and revocations: A person approves"',
		)
		// The preset's choice is marked once per category, for the eye and in the radio's name.
		expect(markup.match(/aria-label="[^"]*: [^"]* \(Strict\)"/g)).toHaveLength(POLICY_CATEGORIES.length)
		expect(markup.match(/<span class="preset-mark"[^>]*aria-hidden="true">•<\/span>/g)).toHaveLength(POLICY_CATEGORIES.length)
		// No dropdowns per rule: who decides is one cell, opened on demand; the three are two request settings and the plan binding.
		expect(markup.match(/<select/g)).toHaveLength(3)
		expect(markup).toContain('1 person · passkey')
	})

	test('a group whose rules follow the preset is folded and says so; one with a change opens, names the count and offers a reset', () => {
		const markup = editor({ ...environment('prod', true), approvalPolicy: { ...STRICT_POLICY, secrets: 'off' } })
		expect(markup).toContain(
			'<details class="rule-group"><summary><span class="disclosure-title">Closer review</span><span class="muted">7 rules, all as Strict</span>',
		)
		expect(markup).toContain(
			'<details class="rule-group" open=""><summary><span class="disclosure-title">What an agent or a key does</span><span class="muted">8 rules, 1 changed from Strict</span>',
		)
		expect(markup).toContain('1 change from Strict')
		expect(markup).toContain('Reset to Strict<span class="sr-only">: Secrets</span>')
		expect(markup).toContain('No changes')
		expect(markup).toMatch(/<button type="button" class="primary" disabled="">Save approvals<\/button>/)
	})

	test('the presets are offered, the nearest one pressed', () => {
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

	test('an action no request routes yet is marked and says what applies today', () => {
		const markup = editor(environment('prod', true))
		expect(markup).toContain('<span class="chip">not enforced yet</span> <span class="muted">Today it applies at once.</span>')
	})

	test('the ceiling of a key an agent asks for is a setting, the agent’s own by default', () => {
		const markup = editor(environment('prod', true))
		expect(markup).toContain('Actions a key an agent asks for may hold<select>')
		expect(markup).toContain('<option value="requester" selected="">The agent&#x27;s own</option>')
		expect(policyDifferences({ policy: STRICT_POLICY, settings: { ...STRICT_SETTINGS, credentialCeiling: 'approver' } }, strictChoice)).toEqual([
			{ key: 'credentialCeiling', label: 'Actions a key an agent asks for may hold', value: "The approver's", other: "The agent's own" },
		])
	})

	test('the plan settings: what a plan binds to and how long it covers, compared, loosened and parsed', () => {
		const markup = editor(environment('prod', true))
		expect(markup).toContain('What an approved plan binds to<select>')
		expect(markup).toContain('<option value="transition" selected="">The change from what runs</option>')
		const afterState = { ...STRICT_SETTINGS, planBinding: 'after-state' as const, planTtlDays: 60 }
		expect(policyDifferences({ policy: STRICT_POLICY, settings: afterState }, strictChoice)).toEqual([
			{ key: 'planBinding', label: 'What an approved plan binds to', value: 'The result alone', other: 'The change from what runs' },
			{ key: 'planTtlDays', label: 'Days an approved plan covers a deploy', value: '60 d', other: '30 d' },
		])
		// Binding the result alone, or covering longer, loosens; the way back tightens.
		expect(loosenedSettings(STRICT_SETTINGS, afterState)).toEqual([
			'an approved plan covers its result reached from a state its approver did not see',
			'an approved plan covers a deploy for 60 days',
		])
		expect(loosenedSettings(afterState, STRICT_SETTINGS)).toEqual([])
		expect(presetOf(STRICT_POLICY, afterState)).toBeNull()
		expect(['1', '30', '365'].map(planTtl)).toEqual([1, 30, 365])
		expect(['0', '366', '1.5', '', 'x'].map(planTtl)).toEqual([null, null, null, null, null])
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

	test('a reader who cannot change the policy reads every rule, with who decides where it takes effect', () => {
		const html = renderToStaticMarkup(
			createElement(PolicySummary, { env: { env: 'prod', approvalPolicy: STRICT_POLICY, approvalSettings: STRICT_SETTINGS } }),
		)
		// An agent writes as a person with no approval, after its person's passkey.
		expect(html).toContain('<dt>An agent writing as a person</dt><dd>No approval<span class="muted"> · passkey</span></dd>')
		expect(html).toContain('<dt>A key an agent asks for</dt><dd>A person approves<span class="muted"> · 1 person · passkey</span></dd>')
		// Under no approval nobody decides, so no one is named.
		expect(html).toContain('<dt>A new role</dt><dd>No approval</dd>')
		// A rule no request routes yet says what applies today.
		expect(html).toContain(
			'<dt>Variables</dt><dd>A person approves<span class="muted"> · 1 person</span> <span class="chip">not enforced yet</span> <span class="muted">Today it applies at once.</span></dd>',
		)
		expect(html).toContain('<dt>Hours a request waits for a decision</dt><dd>24 h</dd>')
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
		})
		await setEnvironmentProtection(client, environment('prod', true), true, undefined)
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
	const ISSUED: ApprovalStepUpChallenge = {
		kind: 'challenge',
		challenge: { challengeId: 'challenge-1', expiresAt: 0, url: 'https://iam.example.test/auth/step-up?challenge=challenge-1' },
	}

	/** A Control that records, in order, what it was asked; the challenge answers `issued`. */
	function console(issued: ApprovalStepUpChallenge = ISSUED) {
		const sent: { method: string; input: unknown }[] = []
		const fetch: ControlFetch = (_input, init) => {
			const body: { method: string; input: unknown } = JSON.parse(String(init?.body))
			sent.push(body)
			return Promise.resolve(Response.json({ result: body.method === 'apps.environments.protectChallenge' ? issued : environment('prod', true) }))
		}
		return { sent, methods: () => sent.map((call) => call.method), client: createControlClient(fetch) }
	}

	test("unprotecting, or dropping the passkey, sends nothing until the person continues from IAM's check, then sends its id", async () => {
		const off = console()
		const started = await setEnvironmentProtection(off.client, environment('prod', true), false, undefined)
		expect(off.sent).toEqual([{ method: 'apps.environments.protectChallenge', input: { appId: 'notes', env: 'prod', protected: false } }])
		if (started.kind !== 'confirm') throw new Error('expected a passkey check')
		expect(started.check.url).toBe('https://iam.example.test/auth/step-up?challenge=challenge-1')
		await started.check.post()
		expect(off.methods()).toEqual(['apps.environments.protectChallenge', 'apps.environments.protect'])
		expect(off.sent[1]?.input).toEqual({ appId: 'notes', env: 'prod', protected: false, stepUp: { challengeId: 'challenge-1' } })

		const dropped = console()
		const settings = { ...STRICT_SETTINGS, stepUp: { ...STRICT_SETTINGS.stepUp, credentials: 'none' as const } }
		const pending = await setEnvironmentProtection(dropped.client, environment('prod', true), true, { policy: STRICT_POLICY, settings })
		expect(dropped.methods()).toEqual(['apps.environments.protectChallenge'])
		expect(dropped.sent[0]?.input).toEqual({ appId: 'notes', env: 'prod', protected: true, policy: STRICT_POLICY, settings })
		expect(pending.kind).toBe('confirm')
	})

	test('a tightening, a change elsewhere and an unprotected environment are sent at once', async () => {
		const c = console()
		const tighter = { ...STRICT_SETTINGS, approvers: { ...STRICT_SETTINGS.approvers, credentials: 2 as const } }
		const results = [
			await setEnvironmentProtection(c.client, environment('prod', true), true, { policy: STRICT_POLICY, settings: tighter }),
			await setEnvironmentProtection(c.client, environment('prod', true), true, {
				policy: { ...STRICT_POLICY, secrets: 'off' },
				settings: STRICT_SETTINGS,
			}),
			await setEnvironmentProtection(c.client, environment('stage', false), false, { policy: PERMISSIVE_POLICY, settings: PERMISSIVE_SETTINGS }),
		]
		expect(c.methods()).toEqual(['apps.environments.protect', 'apps.environments.protect', 'apps.environments.protect'])
		expect(results.map((result) => result.kind)).toEqual(['posted', 'posted', 'posted'])
	})

	test('a person without a passkey is told so and pointed to their IAM account page, and nothing changes', async () => {
		const c = console({ kind: 'no-passkey' })
		const cause = await setEnvironmentProtection(c.client, environment('prod', true), false, undefined).catch((error: unknown) => error)
		expect(c.methods()).toEqual(['apps.environments.protectChallenge'])
		const failure = protectionChangeFailure(cause, 'prod', 'webauthn')
		expect(failure).toEqual({
			message: 'You have no passkey, and this change takes one. Add one on your IAM account page, then save again.',
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

	test("the editor's save bar never reads as saved while a change waits for its passkey", () => {
		expect(saveStatus(0, false)).toBe('No changes')
		expect(saveStatus(1, false)).toBe('1 change to save')
		expect(saveStatus(2, false)).toBe('2 changes to save')
		expect(saveStatus(1, true)).toBe('Not saved yet: the change waits for your passkey')
	})
})

describe("an environment's rules at a glance", () => {
	const strict = { policy: STRICT_POLICY, settings: STRICT_SETTINGS }

	test('who decides reads as one person by default, then only what differs', () => {
		expect(decidingText('secrets', STRICT_SETTINGS)).toBe('1 person')
		expect(decidingText('credentials', STRICT_SETTINGS)).toBe('1 person · passkey')
		expect(decidingText('agent-write', STRICT_SETTINGS)).toBe('passkey')
		expect(decidingText('grants', STRICT_SETTINGS)).toBeNull()
		const tighter = {
			...STRICT_SETTINGS,
			approvers: { ...STRICT_SETTINGS.approvers, secrets: 2 },
			requesterMayApprove: { ...STRICT_SETTINGS.requesterMayApprove, secrets: false },
		}
		expect(decidingText('secrets', tighter)).toBe('2 people · not the requester')
	})

	test('the differences from a preset name each changed rule and setting, with what the preset says', () => {
		expect(policyDifferences(strict, strict)).toEqual([])
		const choice: PolicyChoice = {
			policy: { ...STRICT_POLICY, secrets: 'off' },
			settings: { ...STRICT_SETTINGS, requestTtlHours: 48, approvers: { ...STRICT_SETTINGS.approvers, 'deletes-data': 2 } },
		}
		expect(policyDifferences(choice, strict)).toEqual([
			{
				key: 'deletes-data',
				label: 'Migrations that may change stored data',
				value: 'A person approves · 2 people',
				other: 'A person approves · 1 person',
			},
			{ key: 'secrets', label: 'Secrets', value: 'No approval', other: 'A person approves', pending: 'Today it applies at once.' },
			{ key: 'requestTtlHours', label: 'Hours a request waits for a decision', value: '48 h', other: '24 h' },
		])
	})

	test('the nearest preset is the one with fewer differences, Strict on a tie', () => {
		expect(nearestPreset(strict).preset.name).toBe('strict')
		expect(nearestPreset({ policy: PERMISSIVE_POLICY, settings: PERMISSIVE_SETTINGS }).preset.name).toBe('permissive')
		const nearPermissive = nearestPreset({ policy: { ...PERMISSIVE_POLICY, secrets: 'person' }, settings: PERMISSIVE_SETTINGS })
		expect([nearPermissive.preset.name, nearPermissive.differences.length]).toEqual(['permissive', 1])
		// Nine rules as Permissive says and one as neither does: ten differences from each.
		const fromPermissive: readonly PolicyCategory[] = [
			'anyone-calls',
			'get-mutation',
			'people',
			'adoption',
			'terminal',
			'deletes-data',
			'role-external',
			'public',
			'csp',
		]
		const halfway: PolicyChoice = {
			policy: fromPermissive.reduce((policy, category) => ({ ...policy, [category]: PERMISSIVE_POLICY[category] }), {
				...STRICT_POLICY,
				'off-road': 'person',
			}),
			settings: STRICT_SETTINGS,
		}
		const permissive: PolicyChoice = { policy: PERMISSIVE_POLICY, settings: PERMISSIVE_SETTINGS }
		expect([policyDifferences(halfway, strictChoice).length, policyDifferences(halfway, permissive).length]).toEqual([10, 10])
		expect(nearestPreset(halfway).preset.name).toBe('strict')
	})

	test('the summary leads with the preset and lists only what differs; every rule is one disclosure', () => {
		const html = renderToStaticMarkup(
			createElement(PolicySummary, { env: { env: 'prod', approvalPolicy: { ...STRICT_POLICY, secrets: 'off' }, approvalSettings: STRICT_SETTINGS } }),
		)
		expect(html).toContain('<strong>Strict</strong><span class="muted">, 1 change</span>')
		// A rule no request routes yet says so where it differs, not only in the editor.
		expect(html).toContain(
			'<dt>Secrets</dt><dd>No approval <span class="muted">(Strict: A person approves)</span> <span class="chip">not enforced yet</span> <span class="muted">Today it applies at once.</span></dd>',
		)
		expect(html).toContain('<details class="disclosure"><summary><span class="disclosure-title">Every rule on prod</span>')
		// Rules Strict asks a person for but no request routes yet are named, not left to read as protection.
		expect(html).toContain(
			'<span class="chip">not enforced yet</span> <span class="muted">Variables, Data operations, Where a deploy points: stored, but no request routes them yet; the editor says what applies today.</span>',
		)
		expect(
			renderToStaticMarkup(createElement(PolicySummary, { env: { env: 'prod', approvalPolicy: STRICT_POLICY, approvalSettings: STRICT_SETTINGS } })),
		)
			.toContain(', as the preset says')
	})
})
