import { buildRouteTree, createMemoryNavigationAdapter, Router } from '@buzola/router'
import { BuzolaProvider } from '@buzola/router/react'
import { PERMISSIVE_POLICY, POLICY_CATEGORIES, STRICT_POLICY } from '@fabrika/control-contract'
import { describe, expect, test } from 'bun:test'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PolicyEditor, ProtectionRow, UnprotectConsequences } from '../components/app-detail/ApprovalsSection'
import { type AppEnvDto, type ApprovalDto, type ConsoleAccessDto, type ControlFetch, createControlClient } from '../lib/api'
import { ConsoleAccessContext } from '../lib/console-caller'
import {
	APPROVAL_CATEGORY_GROUPS,
	loosened,
	parkedRunsAt,
	policyChange,
	presetOf,
	protectionFailure,
	protectionToggle,
	setEnvironmentProtection,
	waitingSummary,
} from '../lib/environment-protection'

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
		const markup = renderToStaticMarkup(withRouter(createElement(UnprotectConsequences, { appId: 'notes', env: 'prod', parked: [] })))
		expect(markup).toContain('publishes at once, without a person&#x27;s approval')
		expect(markup).toContain('The audit log records this change')
		expect(markup).toContain('Turning approvals back on applies from the next deploy')
		expect(markup).not.toContain('waits for approval')
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

		const markup = renderToStaticMarkup(withRouter(createElement(UnprotectConsequences, { appId: 'notes', env: 'prod', parked })))
		expect(markup).toContain('1 deploy of prod waits for approval: <span><a href="/approvals/01a144a6-0001">run <code>01a144a6</code></a></span>')
		expect(markup).toContain('Turning approvals off does not approve it.')
		expect(markup).toContain('until a person approves, rejects or cancels it')

		const unknown = renderToStaticMarkup(withRouter(createElement(UnprotectConsequences, { appId: 'notes', env: 'prod', parked: null })))
		expect(unknown).toContain('keeps waiting until a person approves, rejects or cancels it: turning approvals off approves nothing')
	})

	test('the change calls apps.environments.protect with the environment and the new value', async () => {
		const calls: { method: string; input: unknown }[] = []
		const client = createControlClient(respondingFetch(calls, Response.json({ result: environment('prod', false) })))
		const changed = await setEnvironmentProtection(client, 'notes', 'prod', false)
		expect(changed.protected).toBe(false)
		expect(calls).toEqual([{ method: 'apps.environments.protect', input: { appId: 'notes', env: 'prod', protected: false } }])
	})

	test('a running deploy (409) and a refusal (403) read as what the operator can do about them', async () => {
		const refused = async (status: number, message: string): Promise<string> => {
			const client = createControlClient(respondingFetch([], Response.json({ error: { type: 'error', message } }, { status })))
			try {
				await setEnvironmentProtection(client, 'notes', 'prod', false)
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
		expect(markup.match(/<select/g)).toHaveLength(POLICY_CATEGORIES.length)
		// 12 deploy-line categories take three modes, `grants` two, the 7 actions three.
		expect(markup.match(/<option/g)).toHaveLength(12 * 3 + 2 + 7 * 3)
		expect(markup.match(/selected=""/g)).toHaveLength(POLICY_CATEGORIES.length)
		expect(markup).toContain('<option value="refuse" selected="">Refused</option>')
		expect(markup).toContain('<option value="person" selected="">A person approves</option>')
		expect(markup).toContain('<option value="person" selected="">A person approves (default)</option>')
		expect(markup).toContain('Custom')
	})

	test('the presets are offered, the stored one pressed', () => {
		expect(editor(environment('prod', true))).toContain('aria-pressed="true" title="a person approves what an agent asks for; the default"')
		expect(editor({ ...environment('prod', true), approvalPolicy: PERMISSIVE_POLICY })).toContain(
			'aria-pressed="true" title="an agent configures and deploys with no approval"',
		)
		expect(presetOf(STRICT_POLICY)).toBe('strict')
		expect(presetOf(PERMISSIVE_POLICY)).toBe('permissive')
		expect(presetOf({ ...STRICT_POLICY, csp: 'plan' })).toBeNull()
	})

	test('an action no request routes yet says what applies today', () => {
		const markup = editor(environment('prod', true))
		expect(markup).toContain('Not enforced yet. Today it applies at once.')
		expect(markup).toContain('aria-describedby="approval-prod-secrets"')
		expect(markup).toContain('id="approval-prod-secrets"')
	})

	test('a change that loosens any category asks first; one that tightens does not', () => {
		expect(policyChange(STRICT_POLICY, PERMISSIVE_POLICY)).toBe('confirm')
		expect(policyChange(STRICT_POLICY, { ...STRICT_POLICY, 'off-road': 'person', csp: 'plan', secrets: 'refuse' })).toBe('apply')
		expect(loosened(STRICT_POLICY, { ...STRICT_POLICY, 'deletes-data': 'plan', 'deploy-request': 'off' })).toEqual(['deletes-data', 'deploy-request'])
	})

	test('a reader who cannot change the policy reads what waits', () => {
		expect(waitingSummary(PERMISSIVE_POLICY)).toBe('Nothing waits.')
		expect(waitingSummary({ ...PERMISSIVE_POLICY, 'deletes-data': 'person', registry: 'refuse' })).toBe(
			'Waits for a person: Migrations that may change stored data; refused to an agent: Where a deploy points.',
		)
	})

	test('the protection call sends the policy only when given', async () => {
		const sent: unknown[] = []
		const fetch: ControlFetch = (_input, init) => {
			sent.push(JSON.parse(String(init?.body)))
			return Promise.resolve(Response.json({ result: environment('prod', true) }))
		}
		const client = createControlClient(fetch)
		await setEnvironmentProtection(client, 'notes', 'prod', true, PERMISSIVE_POLICY)
		await setEnvironmentProtection(client, 'notes', 'prod', true)
		expect(sent).toEqual([
			{ method: 'apps.environments.protect', input: { appId: 'notes', env: 'prod', protected: true, policy: PERMISSIVE_POLICY } },
			{ method: 'apps.environments.protect', input: { appId: 'notes', env: 'prod', protected: true } },
		])
	})
})
