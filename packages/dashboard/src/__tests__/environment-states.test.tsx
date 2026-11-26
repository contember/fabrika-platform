// Each environment's data state shows on the Applications list, keyed by application and environment.

import { buildRouteTree, createMemoryNavigationAdapter, Router } from '@buzola/router'
import { BuzolaProvider } from '@buzola/router/react'
import type { AppEnvDto, ConsoleAccessDto } from '@fabrika/control-contract'
import { describe, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { environmentKey, useEnvironmentStatesAcross } from '../components/app/AppFrame'
import { ConsoleAccessContext } from '../lib/console-caller'
import type { EnvironmentState } from '../lib/environment-state'
import dataPage from '../routes/apps/data'
import appPage from '../routes/apps/detail'
import appsPage, { ApplicationStates, type EnvironmentsRead } from '../routes/apps/index'

const pageRegistry = {
	apps: appsPage.route,
	'apps/detail': appPage.route,
	'apps/data': dataPage.route,
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

	test('each environment shows its lamp and label, linked to its Data tab', () => {
		const html = cell('notes', { kind: 'read', items: envs }, new Map([[environmentKey('notes', 'prod'), { kind: 'mode', mode: 'closed' }]]))
		expect(html).toContain('href="/apps/notes/data/prod"')
		expect(html).toContain('href="/apps/notes/data/test"')
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
