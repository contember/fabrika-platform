// Each environment's data state shows on the Applications list and the console overview, keyed by application and
// environment, and a state that needs a person is listed in "Needs attention", linking to its Data tab.

import { buildRouteTree, createMemoryNavigationAdapter, Router } from '@buzola/router'
import { BuzolaProvider } from '@buzola/router/react'
import type { RpcFetch } from '@fabrika/app'
import type { AppDto, AppEnvDto, AppSecretDto, ConsoleAccessDto, DataOperationDto } from '@fabrika/control-contract'
import { describe, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { z } from 'zod'
import { environmentKey, useEnvironmentStatesAcross } from '../components/app/AppFrame'
import { Applications } from '../components/overview/Applications'
import { Attention } from '../components/overview/Attention'
import { ApiError } from '../lib/api'
import type { ConsoleCaller } from '../lib/console-access'
import { ConsoleAccessContext } from '../lib/console-caller'
import type { EnvironmentState } from '../lib/environment-state'
import { loadOverview, type OverviewData } from '../lib/overview'
import dataPage from '../routes/apps/data'
import appPage from '../routes/apps/detail'
import appsPage, { ApplicationStates, environmentsFailure, type EnvironmentsRead } from '../routes/apps/index'
import secretsPage from '../routes/apps/secrets'
import healthPage from '../routes/operations/health/index'

const pageRegistry = {
	apps: appsPage.route,
	'apps/detail': appPage.route,
	'apps/data': dataPage.route,
	'apps/secrets': secretsPage.route,
	'operations/health': healthPage.route,
}

const render = (node: ReactNode, access: ConsoleAccessDto | null = null): string =>
	renderToStaticMarkup(
		<BuzolaProvider
			router={new Router({
				routes: buildRouteTree([{ path: '/', component: () => null, isIndex: true }]),
				adapter: createMemoryNavigationAdapter(),
				pageRegistry,
			})}
		>
			<ConsoleAccessContext.Provider value={access}>{node}</ConsoleAccessContext.Provider>
		</BuzolaProvider>,
	)

const environment = (appId: string, env: string): AppEnvDto => ({
	appId,
	env,
	kind: 'standard',
	domain: null,
	publicOrigin: null,
	crossOrigins: [],
	triggerRef: null,
	authoring: false,
	protected: false,
	publishedRunId: null,
	deviationSubjects: [],
	surface: [],
	namespaceId: null,
	provider: 'zerops',
	target: { provider: 'zerops', version: 1, payload: {} },
	artifact: { provider: 'zerops', version: 1, payload: {} },
	createdAt: 0,
})

const readingAt = (appId: string, actions: string[]): ConsoleAccessDto => ({
	principal: null,
	global: [],
	scopes: [{ type: 'app', value: appId, actions }],
})

const cell = (appId: string, read: EnvironmentsRead, states: ReadonlyMap<string, EnvironmentState>, access: ConsoleAccessDto | null = null) =>
	render(<ApplicationStates appId={appId} read={read} states={states} />, access)

describe("the Applications list's State column", () => {
	const envs = [environment('notes', 'prod'), environment('notes', 'test')]

	test('a refused environment list reads as not readable, any other failure as unavailable', () => {
		const refusal = (httpStatus: number) => new ApiError({ type: 'error', httpStatus, message: 'refused' })
		expect(environmentsFailure(refusal(403))).toBe('forbidden')
		expect(environmentsFailure(refusal(404))).toBe('forbidden')
		expect(environmentsFailure(refusal(500))).toBe('unavailable')
		expect(environmentsFailure(new TypeError('Failed to fetch'))).toBe('unavailable')
	})

	test('each environment shows its lamp and label, linked to its Data tab', () => {
		const html = cell('notes', { kind: 'read', items: envs }, new Map([[environmentKey('notes', 'prod'), { kind: 'mode', mode: 'closed' }]]))
		expect(html).toContain('href="/apps/notes/data/prod"')
		expect(html).toContain('href="/apps/notes/data/test"')
		expect(html).toContain('title="Open the data of prod"')
		expect(html).toContain('<span class="sr-only">, open its data</span>')
		expect(html).toContain('status-stop')
		expect(html).toContain('Closed')
		// An environment whose state has not answered reads as such, and holds nothing else.
		expect(html).toContain('Reading…')
	})

	test('an environment whose data the caller may not read is plain text, not a link', () => {
		const html = cell('notes', { kind: 'read', items: envs }, new Map(), readingAt('other', ['data.read']))
		expect(html).toContain('<strong>prod</strong>')
		expect(html).not.toContain('/apps/notes/data/')
	})

	test('an environment list that has not answered, failed, was refused or is empty says which', () => {
		expect(cell('notes', { kind: 'reading' }, new Map())).toContain('Reading…')
		expect(cell('notes', { kind: 'failed', reason: 'unavailable' }, new Map())).toContain('Environments unavailable')
		expect(cell('notes', { kind: 'failed', reason: 'forbidden' }, new Map())).toContain('Environments not readable')
		expect(cell('notes', { kind: 'read', items: [] }, new Map())).toContain('No environments')
	})

	test('two applications with the same environment name keep their own state', () => {
		const crm = [environment('crm', 'prod')]
		const notes = [environment('notes', 'prod')]
		// Only notes' data is readable: crm's prod is not asked and says so, notes' prod waits for its read.
		function Both() {
			const states = useEnvironmentStatesAcross([...crm, ...notes])
			return (
				<>
					<ApplicationStates appId="crm" read={{ kind: 'read', items: crm }} states={states} />
					<ApplicationStates appId="notes" read={{ kind: 'read', items: notes }} states={states} />
				</>
			)
		}
		const html = render(<Both />, readingAt('notes', ['data.read']))
		const [crmCell = '', notesCell = ''] = html.split('aria-label="Environments of notes"')
		expect(crmCell).toContain('State not readable')
		expect(crmCell).not.toContain('Reading…')
		expect(notesCell).toContain('Reading…')
		expect(notesCell).not.toContain('State not readable')
	})
})

const application = (id: string): AppDto => ({
	id,
	repoUrl: `https://example.test/${id}`,
	defaultBranch: 'main',
	workerDir: null,
	buildCmd: null,
	configPath: null,
	githubInstallationId: null,
	createdAt: 1,
})

const failedRestore: DataOperationDto = {
	id: 'op-1',
	appId: 'crm',
	env: 'test',
	kind: 'restore',
	step: 'restrict',
	targetMode: 'closed',
	generation: 3,
	state: 'failed',
	errorCode: 'restore_failed',
	actor: 'principal-1',
	createdAt: 1_790_000_000,
	updatedAt: 1_790_000_010,
	finishedAt: 1_790_000_010,
	recoversOperationId: null,
	resolution: null,
	runId: null,
	recordsBookmark: false,
	migrationFailure: null,
	revertRunId: null,
	candidateRecovered: false,
}

const requestBody = z.object({ method: z.string(), input: z.unknown() })
const appInput = z.object({ appId: z.string() })
const caller: ConsoleCaller = { access: null, iam: { kind: 'installation' }, administersPeople: false }

/** An installation of crm and notes, each with prod and test, and nothing else to attend to. */
const fetchOverview: RpcFetch = async (_url, init) => {
	const body = requestBody.parse(JSON.parse(String(init?.body)))
	switch (body.method) {
		case 'apps.list':
			return Response.json({ result: { items: [application('crm'), application('notes')] } })
		case 'apps.environments.list': {
			const { appId } = appInput.parse(body.input)
			return Response.json({ result: { items: [environment(appId, 'prod'), environment(appId, 'test')] } })
		}
		case 'health':
			return Response.json({ result: { sources: [] } })
		case 'issues':
			return Response.json({ result: { items: [], nextCursor: null, summary: { total: 0, open: 0, resolved: 0, ignored: 0 } } })
		default:
			return Response.json({ result: { items: [], nextCursor: null } })
	}
}

const STATES: ReadonlyMap<string, EnvironmentState> = new Map([
	[environmentKey('crm', 'prod'), { kind: 'mode', mode: 'closed' }],
	[environmentKey('crm', 'test'), { kind: 'operation', operation: failedRestore }],
	[environmentKey('notes', 'prod'), { kind: 'serving', published: true, source: 'object' }],
	[environmentKey('notes', 'test'), { kind: 'boot-failure', at: '2026-10-24T09:30:00.000Z' }],
])

const attention = (data: OverviewData, states: ReadonlyMap<string, EnvironmentState>): string => render(<Attention data={data} states={states} />)

describe('the console overview', () => {
	test("the applications table shows each environment's data state, linked to its Data tab", async () => {
		const data = await loadOverview(caller, fetchOverview)
		const html = render(<Applications data={data} states={STATES} />)
		expect(html).toContain('<th>State</th>')
		expect(html).toContain('href="/apps/crm/data/prod"')
		// Each link names its environment for a screen reader, not only "Closed".
		expect(html).toContain('<span class="sr-only">crm / prod data:</span>')
		expect(html).toContain('Closed')
		expect(html).toContain('Restore failed')
		expect(html).toContain('Fails to boot')
		expect(html).toContain('Open')
	})

	test('a state the caller may not read is not a link to its Data tab', async () => {
		const data = await loadOverview(caller, fetchOverview)
		data.caller = { ...caller, access: readingAt('notes', ['data.read']) }
		const html = render(<Applications data={data} states={new Map()} />)
		expect(html).toContain('href="/apps/notes/data/prod"')
		expect(html).not.toContain('/apps/crm/data/')
	})

	test('"Needs attention" lists a closed, a failing and a booting-failure environment, and not an open one', async () => {
		const data = await loadOverview(caller, fetchOverview)
		const html = attention(data, STATES)
		expect(html).toContain('crm / prod: Closed')
		expect(html).toContain('href="/apps/crm/data/prod"')
		expect(html).toContain('crm / test: Restore failed')
		expect(html).toContain('href="/apps/crm/data/test"')
		expect(html).toContain('notes / test: Fails to boot')
		expect(html).toContain('href="/apps/notes/data/test"')
		expect(html).not.toContain('href="/apps/notes/data/prod"')
		// Production first: a closed production environment outranks a failure in test.
		expect(html.indexOf('crm / prod')).toBeLessThan(html.indexOf('notes / test'))
	})

	test('an environment still being read says so instead of reporting nothing to do', async () => {
		const data = await loadOverview(caller, fetchOverview)
		const html = attention(data, new Map([[environmentKey('crm', 'prod'), { kind: 'reading' }]]))
		expect(html).toContain('Checking environment states…')
		expect(html).not.toContain('No attention items in the visible data.')
	})

	test('an environment that is not readable, offline or serving needs no one', async () => {
		const data = await loadOverview(caller, fetchOverview)
		const quiet: ReadonlyMap<string, EnvironmentState> = new Map([
			[environmentKey('crm', 'prod'), { kind: 'suspended', at: 1_790_000_000 }],
			[environmentKey('crm', 'test'), { kind: 'unknown', reason: 'not-allowed' }],
			[environmentKey('notes', 'prod'), { kind: 'serving', published: false, source: 'control' }],
		])
		const html = attention(data, quiet)
		expect(html).not.toContain('/data/')
		expect(html).toContain('No attention items in the visible data.')
	})

	test('an unavailable state read is disclosed rather than read as nothing to do', async () => {
		const data = await loadOverview(caller, fetchOverview)
		const html = attention(data, new Map([[environmentKey('crm', 'prod'), { kind: 'unknown', reason: 'unavailable' }]]))
		expect(html).toContain('Some checks could not be read')
	})
})

const secret = (appId: string, name: string, env: string | null): AppSecretDto => ({
	appId,
	env,
	name,
	storage: 'vault',
	valueRef: `vault:${appId}-${name}-${env ?? 'all'}`,
	createdAt: 0,
})

/** `fetchOverview`, whose crm holds these secrets; `secretsFail` answers the secrets read with that status instead. */
const withSecrets = (secrets: AppSecretDto[], secretsFail: number | null = null): RpcFetch => async (url, init) => {
	const body = requestBody.parse(JSON.parse(String(init?.body)))
	if (body.method !== 'apps.secrets.list') return fetchOverview(url, init)
	if (secretsFail !== null) return Response.json({ error: { type: 'error', message: 'no' } }, { status: secretsFail })
	const { appId } = appInput.parse(body.input)
	return Response.json({ result: { items: appId === 'crm' ? secrets : [], nextCursor: null } })
}

describe("the overview's missing secrets", () => {
	test('a secret set on one environment only is listed as missing on the other, linked to Secrets', async () => {
		const data = await loadOverview(caller, withSecrets([secret('crm', 'PAYMENT_API_KEY', 'prod'), secret('crm', 'SESSION_KEY', 'prod')]))
		const html = attention(data, new Map())
		expect(html).toContain('crm / test: 2 secrets missing')
		expect(html).toContain('PAYMENT_API_KEY, SESSION_KEY are set on another environment, not on test')
		expect(html).toContain('href="/apps/crm/secrets"')
		expect(html).not.toContain('crm / prod: ')
	})

	test('a secret only a deleted environment held is no gap: no current environment has it', async () => {
		const data = await loadOverview(caller, withSecrets([secret('crm', 'OLD_KEY', 'stage')]))
		expect(attention(data, new Map())).not.toContain('missing')
	})

	test('a value for all environments, or an own value everywhere, leaves no gap', async () => {
		const data = await loadOverview(
			caller,
			withSecrets([secret('crm', 'A', null), secret('crm', 'A', 'prod'), secret('crm', 'B', 'prod'), secret('crm', 'B', 'test')]),
		)
		expect(attention(data, new Map())).not.toContain('missing')
	})

	test('secrets are not read where the caller may not manage them, and a failed read is disclosed', async () => {
		const scoped: ConsoleCaller = {
			...caller,
			access: { ...readingAt('notes', ['secret.manage']), global: ['app.manage', 'namespace.manage', 'deploy.read'] },
		}
		const refused = await loadOverview(scoped, withSecrets([secret('crm', 'A', 'prod')]))
		expect(refused.secrets.get('crm')?.problem).toBe('forbidden')
		expect(refused.secrets.get('notes')?.problem).toBeNull()

		const failed = await loadOverview(caller, withSecrets([], 500))
		expect(attention(failed, new Map())).toContain('Some checks could not be read')
	})
})
