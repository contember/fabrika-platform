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

const workflowMarkup = (workflow: GitHubSourceConnectionWorkflowDto | null, connectionCount: number, adding = false): string =>
	renderToStaticMarkup(createElement(SourceWorkflow, {
		workflow,
		connectionCount,
		adding,
		onAdd: () => undefined,
		onCancelAdd: () => undefined,
		invalidate: () => undefined,
	}))

describe('source connection collection components', () => {
	test('renders the zero-connection private setup without a public-App control', () => {
		const collection = renderToStaticMarkup(createElement(ConnectedConnections, { connections: [] }))
		const workflow = workflowMarkup({ provider: 'zerops', kind: 'github-app', state: 'anonymous' }, 0)
		expect(collection).toContain('No organizations connected')
		expect(workflow).toContain('The new App is private')
		expect(workflow).toContain('Connect GitHub source')
		expect(workflow).not.toContain('value="public"')
	})

	test('keeps a migrated connection readable, including legacy public state', () => {
		const markup = renderToStaticMarkup(createElement(ConnectedConnections, { connections: [connection('legacy-1', 'Acme', true)] }))
		expect(markup).toContain('GitHub source connection for Acme')
		expect(markup).toContain('Acme-fabrika')
		expect(markup).toContain('legacy public App')
		expect(markup).toContain('Connected')
	})

	test('distinguishes several organizations and offers an additive connection action', () => {
		const markup = renderToStaticMarkup(createElement(ConnectedConnections, {
			connections: [connection('connection-1', 'acme'), connection('connection-2', 'beta')],
		}))
		expect(markup).toContain('GitHub source connection for acme')
		expect(markup).toContain('GitHub source connection for beta')
		expect(workflowMarkup(null, 2)).toContain('Add connection')
	})

	test('offers legacy adoption only while the stable collection is empty', () => {
		const adoption: GitHubSourceConnectionWorkflowDto = { provider: 'zerops', kind: 'github-app', state: 'adoption-required' }
		expect(workflowMarkup(adoption, 0)).toContain('Adopt existing GitHub App')
		const blocked = workflowMarkup(adoption, 1)
		expect(blocked).toContain('Legacy adoption unavailable')
		expect(blocked).not.toContain('Adopt existing GitHub App')
	})

	test('renders pending setup separately without hiding stable rows and preserves callback resume', () => {
		const stable = renderToStaticMarkup(createElement(ConnectedConnections, { connections: [connection('connection-1', 'acme')] }))
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
