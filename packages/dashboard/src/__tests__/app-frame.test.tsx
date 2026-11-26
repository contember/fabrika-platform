// The application page's frame offers a tab or a link only where the caller holds something Control would answer.

import { buildRouteTree, createMemoryNavigationAdapter, Router } from '@buzola/router'
import { BuzolaProvider } from '@buzola/router/react'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppFrame } from '../components/app/AppFrame'
import type { AppDto, AppEnvDto, ConsoleAccessDto } from '../lib/api'
import { ConsoleAccessContext } from '../lib/console-caller'
import type { EnvironmentState } from '../lib/environment-state'
import accessPage from '../routes/apps/access'
import approvalsPage from '../routes/apps/approvals'
import dataPage from '../routes/apps/data'
import deploysPage from '../routes/apps/deploys'
import appPage from '../routes/apps/detail'
import appsPage from '../routes/apps/index'
import secretsPage from '../routes/apps/secrets'
import settingsPage from '../routes/apps/settings'

const pageRegistry = {
	apps: appsPage.route,
	'apps/detail': appPage.route,
	'apps/deploys': deploysPage.route,
	'apps/data': dataPage.route,
	'apps/secrets': secretsPage.route,
	'apps/access': accessPage.route,
	'apps/approvals': approvalsPage.route,
	'apps/settings': settingsPage.route,
}

const app: AppDto = {
	id: 'notes',
	repoUrl: 'https://example.test/notes',
	defaultBranch: 'main',
	workerDir: null,
	buildCmd: null,
	configPath: null,
	githubInstallationId: null,
	createdAt: 1,
}

const environment = (env: string): AppEnvDto => ({
	appId: 'notes',
	env,
	kind: 'standard',
	domain: null,
	publicOrigin: null,
	crossOrigins: [],
	triggerRef: null,
	authoring: false,
	protected: false,
	publishedRunId: 'run-1',
	deviationSubjects: [],
	surface: [],
	namespaceId: null,
	provider: 'zerops',
	target: { provider: 'zerops', version: 1, payload: {} },
	artifact: { provider: 'zerops', version: 1, payload: {} },
	createdAt: 0,
})

const ENVS = [environment('prod'), environment('test')]

const holding = (global: string[], ...scopes: { type: 'app' | 'environment'; value: string; actions: string[] }[]): ConsoleAccessDto => ({
	principal: null,
	global,
	scopes,
})

const frame = (access: ConsoleAccessDto | null, states: ReadonlyMap<string, EnvironmentState> = new Map()): string =>
	renderToStaticMarkup(
		<BuzolaProvider
			router={new Router({
				routes: buildRouteTree([{ path: '/', component: () => null, isIndex: true }]),
				adapter: createMemoryNavigationAdapter(),
				pageRegistry,
			})}
		>
			<ConsoleAccessContext.Provider value={access}>
				<AppFrame app={app} envs={ENVS} tab="overview" states={states}>
					<p>content</p>
				</AppFrame>
			</ConsoleAccessContext.Provider>
		</BuzolaProvider>,
	)

const tabs = (html: string): string[] => {
	const nav = html.slice(html.indexOf('<nav class="page-tabs"'), html.indexOf('</nav>'))
	return [...nav.matchAll(/<a [^>]*>([^<]+)/g)].map((match) => match[1] ?? '')
}

describe("the application page's tabs", () => {
	test('a manager of the application alone gets no Deploys and no Data, and no environment links to data', () => {
		const html = frame(holding([], { type: 'app', value: 'notes', actions: ['app.manage'] }))
		expect(tabs(html)).toEqual(['Overview', 'Secrets and variables', 'Access', 'Approvals', 'Settings'])
		expect(html).not.toContain('/apps/notes/data/')
	})

	test('runs are listed for deploy.read at the application, not at one environment', () => {
		const atEnvironment = holding([], { type: 'app', value: 'notes', actions: ['app.manage'] }, {
			type: 'environment',
			value: 'prod',
			actions: ['deploy.read'],
		})
		expect(tabs(frame(atEnvironment))).not.toContain('Deploys')
		expect(tabs(frame(holding([], { type: 'app', value: 'notes', actions: ['app.manage', 'deploy.read'] })))).toContain('Deploys')
	})

	test('data links go only to the environments the caller reads', () => {
		const html = frame(
			holding([], { type: 'app', value: 'notes', actions: ['app.manage'] }, { type: 'environment', value: 'test', actions: ['data.read'] }),
		)
		expect(tabs(html)).toContain('Data')
		expect(html).toContain('href="/apps/notes/data/test"')
		expect(html).not.toContain('href="/apps/notes/data/prod"')
	})

	test('an environment whose data needs a person opens the Data tab and says so in text', () => {
		const html = frame(null, new Map([['test', { kind: 'mode', mode: 'closed' }]]))
		const nav = html.slice(html.indexOf('<nav class="page-tabs"'), html.indexOf('</nav>'))
		expect(nav).toContain('href="/apps/notes/data/test"')
		expect(nav).toContain('needs attention')
		expect(frame(null)).toContain('href="/apps/notes/data/prod"')
	})
})
