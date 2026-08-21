import { buildRouteTree, createMemoryNavigationAdapter, Router } from '@buzola/router'
import { BuzolaProvider } from '@buzola/router/react'
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { GitHubSourceConnectionConnectedDto, GitHubSourceConnectionWorkflowDto } from '../lib/api'
import { ConnectedConnections, SourceWorkflow } from '../routes/settings/source'

const connection = (connectionId: string, owner: string, isPublic = false): GitHubSourceConnectionConnectedDto => ({
	provider: 'zerops',
	kind: 'github-app',
	state: 'connected',
	connectionId,
	app: {
		id: connectionId.length,
		slug: `${owner}-fabrika`,
		htmlUrl: `https://github.com/apps/${owner}-fabrika`,
		public: isPublic,
		owner: { login: owner, type: 'Organization' },
		permissions: { contents: 'read' },
		events: ['push'],
	},
	installation: {
		id: connectionId.length,
		accountLogin: owner,
		repositorySelection: 'selected',
		verifiedRepositories: [{ owner, name: 'api' }],
	},
})

// The setup form reaches for the router to hand the GitHub handoff to the browser, so it needs a
// provider. A memory adapter keeps that out of the DOM.
const withRouter = (element: React.ReactElement): React.ReactElement =>
	createElement(BuzolaProvider, {
		router: new Router({
			routes: buildRouteTree([{ path: '/', component: () => null, isIndex: true }]),
			adapter: createMemoryNavigationAdapter(),
			pageRegistry: {},
		}),
	}, element)

const workflowMarkup = (workflow: GitHubSourceConnectionWorkflowDto | null, connectionCount: number, adding = false): string =>
	renderToStaticMarkup(withRouter(createElement(SourceWorkflow, {
		workflow,
		connectionCount,
		adding,
		onAdd: () => undefined,
		onCancelAdd: () => undefined,
		invalidate: () => undefined,
	})))

const connectedMarkup = (connections: readonly GitHubSourceConnectionConnectedDto[]): string =>
	renderToStaticMarkup(createElement(ConnectedConnections, { connections, invalidate: () => undefined }))

describe('source connection collection components', () => {
	test('renders the zero-connection private setup without a public-App control', () => {
		const collection = connectedMarkup([])
		const workflow = workflowMarkup({ provider: 'zerops', kind: 'github-app', state: 'anonymous' }, 0)
		expect(collection).toContain('No organizations connected')
		expect(workflow).toContain('The new App is private')
		expect(workflow).toContain('Connect GitHub source')
		expect(workflow).not.toContain('value="public"')
	})

	test('keeps a migrated connection readable, including legacy public state', () => {
		const markup = connectedMarkup([connection('legacy-1', 'Acme', true)])
		expect(markup).toContain('GitHub source connection for Acme')
		expect(markup).toContain('Acme-fabrika')
		expect(markup).toContain('legacy public App')
		expect(markup).toContain('Connected')
	})

	test('distinguishes several organizations and offers an additive connection action', () => {
		const markup = connectedMarkup([connection('connection-1', 'acme'), connection('connection-2', 'beta')])
		expect(markup).toContain('GitHub source connection for acme')
		expect(markup).toContain('GitHub source connection for beta')
		expect(markup).toContain('aria-label="Reconcile GitHub source connection acme"')
		expect(markup).toContain('data-connection-id="connection-2"')
		expect(workflowMarkup(null, 2)).toContain('Add connection')
	})

	test('renders pending setup separately without hiding stable rows and preserves callback resume', () => {
		const stable = connectedMarkup([connection('connection-1', 'acme')])
		const pending = workflowMarkup({
			provider: 'zerops',
			kind: 'github-app',
			state: 'setup-pending',
			connectionId: 'connection-2',
			phase: 'awaiting-manifest-callback',
			continuePath: '/api/source/github/manifest/connection-2',
		}, 1)
		expect(stable).toContain('GitHub source connection for acme')
		expect(pending).toContain('Setup is in progress')
		expect(pending).toContain('href="/api/source/github/manifest/connection-2"')
	})

	test('names installation and repair actions for their exact organization', () => {
		const app = connection('connection-2', 'beta').app
		const install = workflowMarkup({
			provider: 'zerops',
			kind: 'github-app',
			state: 'installation-required',
			connectionId: 'connection-2',
			app,
			installationUrl: 'https://github.com/apps/beta-fabrika/installations/new',
		}, 1)
		const repair = workflowMarkup({
			provider: 'zerops',
			kind: 'github-app',
			state: 'repair-required',
			connectionId: 'connection-2',
			reason: 'credential-activation',
			app,
		}, 1)
		expect(install).toContain('aria-label="Open GitHub installation for beta"')
		expect(install).toContain('aria-label="Verify GitHub installation for beta"')
		expect(install).toContain('data-connection-id="connection-2"')
		expect(repair).toContain('aria-label="Repair GitHub source connection beta"')
		expect(repair).toContain('data-connection-id="connection-2"')
		expect(`${install}${repair}`).not.toContain('privateKey')
	})
})
