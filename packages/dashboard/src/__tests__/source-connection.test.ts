import { describe, expect, jest, test } from 'bun:test'
import {
	GITHUB_SOURCE_CONNECTION_DEFAULT_PAGE_SIZE,
	type GitHubSourceConnectionConnectedDto,
	type GitHubSourceConnectionListResponse,
	type GitHubSourceConnectionStatusDto,
} from '../lib/api'
import {
	appendSourceConnectionPage,
	initialSourceConnectionCollection,
	MAX_SOURCE_REPOSITORIES,
	parseSourceRepositories,
	privateSourceConnectionRequest,
	reconcileSourceConnectionFirstPage,
	scheduleSourceConnectionPoll,
	sourceChain,
	sourceConnectionInput,
	sourceManifestContinuePath,
	sourceStartContinuePath,
} from '../lib/source-connection'

const connection = (connectionId: string, owner: string): GitHubSourceConnectionConnectedDto => ({
	provider: 'zerops',
	kind: 'github-app',
	state: 'connected',
	connectionId,
	app: {
		id: connectionId.length,
		slug: `${owner}-fabrika`,
		htmlUrl: `https://github.com/apps/${owner}-fabrika`,
		public: false,
		owner: { login: owner, type: 'Organization' },
		permissions: { contents: 'read' },
		events: ['push'],
	},
	installation: { id: connectionId.length, accountLogin: owner, repositorySelection: 'all', verifiedRepositories: [] },
})

const page = (
	items: readonly GitHubSourceConnectionConnectedDto[],
	nextCursor: string | null,
	workflow: GitHubSourceConnectionListResponse['workflow'] = null,
): GitHubSourceConnectionListResponse => ({ items, nextCursor, workflow })

describe('source connection presentation', () => {
	test('accepts only unique repositories owned by the selected organization', () => {
		expect(parseSourceRepositories('Acme/API\nacme/web', ' ACME ')).toEqual([
			{ owner: 'acme', name: 'api' },
			{ owner: 'acme', name: 'web' },
		])
		for (const value of ['other/api', 'acme/api/extra', 'acme/..', 'acme/api\nacme/API']) {
			expect(() => parseSourceRepositories(value, 'acme')).toThrow()
		}
		const tooMany = Array.from({ length: MAX_SOURCE_REPOSITORIES + 1 }, (_, index) => `acme/repo-${index}`).join('\n')
		expect(() => parseSourceRepositories(tooMany, 'acme')).toThrow(`Enter no more than ${MAX_SOURCE_REPOSITORIES} repositories.`)
	})

	test('builds only private organization connection requests and exact keyed mutations', () => {
		expect(privateSourceConnectionRequest(' Acme ', ' acme-fabrika ', [{ owner: 'acme', name: 'api' }])).toEqual({
			organization: 'acme',
			appName: 'acme-fabrika',
			visibility: 'private',
			repositories: [{ owner: 'acme', name: 'api' }],
		})
		expect(sourceConnectionInput('connection-2')).toEqual({ connectionId: 'connection-2' })
	})

	test('reopens exhausted ascending pagination once when a pending workflow becomes connection 52', () => {
		const original = Array.from({ length: GITHUB_SOURCE_CONNECTION_DEFAULT_PAGE_SIZE + 1 }, (_, index) => {
			const sequence = String(index + 1).padStart(3, '0')
			return connection(`connection-${sequence}`, `owner-${sequence}`)
		})
		const originalFirstPage = original.slice(0, GITHUB_SOURCE_CONNECTION_DEFAULT_PAGE_SIZE)
		const originalLastPage = original.slice(GITHUB_SOURCE_CONNECTION_DEFAULT_PAGE_SIZE)
		const firstPageCursor = originalFirstPage.at(-1)?.connectionId ?? ''
		const pendingWorkflow: GitHubSourceConnectionListResponse['workflow'] = {
			provider: 'zerops',
			kind: 'github-app',
			state: 'setup-pending',
			connectionId: 'connection-052',
			phase: 'activating',
		}
		let collection = initialSourceConnectionCollection(page(originalFirstPage, firstPageCursor, pendingWorkflow))
		collection = appendSourceConnectionPage(collection, page(originalLastPage, null, pendingWorkflow))
		expect(collection.items).toHaveLength(GITHUB_SOURCE_CONNECTION_DEFAULT_PAGE_SIZE + 1)
		expect(collection.nextCursor).toBeNull()

		const unchangedPending = reconcileSourceConnectionFirstPage(
			collection,
			page(originalFirstPage, firstPageCursor, pendingWorkflow),
		)
		expect(unchangedPending.nextCursor).toBeNull()
		expect(unchangedPending.loadedBeyondFirstPage).toBe(true)

		collection = reconcileSourceConnectionFirstPage(
			unchangedPending,
			page(originalFirstPage, firstPageCursor),
		)
		expect(collection.nextCursor).toBe(firstPageCursor)
		expect(collection.loadedBeyondFirstPage).toBe(false)
		expect(collection.items).toHaveLength(GITHUB_SOURCE_CONNECTION_DEFAULT_PAGE_SIZE + 1)

		const completed = connection('connection-052', 'owner-052')
		collection = appendSourceConnectionPage(collection, page([...originalLastPage, completed], null))
		expect(collection.items).toHaveLength(GITHUB_SOURCE_CONNECTION_DEFAULT_PAGE_SIZE + 2)
		expect(new Set(collection.items.map((item) => item.connectionId)).size).toBe(collection.items.length)
		expect(collection.nextCursor).toBeNull()

		const stableRefresh = reconcileSourceConnectionFirstPage(
			collection,
			page(originalFirstPage, firstPageCursor),
		)
		expect(stableRefresh.nextCursor).toBeNull()
		expect(stableRefresh.loadedBeyondFirstPage).toBe(true)
	})

	test('schedules one refresh per pending render and stops after a terminal response', () => {
		jest.useFakeTimers()
		try {
			let idleSchedules = 0
			scheduleSourceConnectionPoll(null, () => undefined, () => {
				idleSchedules++
				return () => undefined
			})
			expect(idleSchedules).toBe(0)
			const pending = (phase: 'starting' | 'awaiting-manifest-callback'): GitHubSourceConnectionStatusDto => ({
				provider: 'zerops',
				kind: 'github-app',
				state: 'setup-pending',
				connectionId: 'connection-1',
				phase,
			})
			const terminal: GitHubSourceConnectionStatusDto = { provider: 'zerops', kind: 'github-app', state: 'anonymous' }
			const responses: readonly GitHubSourceConnectionStatusDto[] = [
				pending('starting'),
				pending('awaiting-manifest-callback'),
				terminal,
			]
			let responseIndex = 0
			let refreshes = 0
			let cancel = () => undefined
			const schedule = (callback: () => void, delayMs: number) => {
				const timer = setTimeout(callback, delayMs)
				return () => clearTimeout(timer)
			}
			const render = () => {
				cancel()
				cancel = scheduleSourceConnectionPoll(responses[responseIndex] ?? terminal, () => {
					refreshes++
					responseIndex++
					render()
				}, schedule)
			}

			render()
			jest.advanceTimersByTime(6_000)
			expect(refreshes).toBe(2)
			cancel()
		} finally {
			jest.useRealTimers()
		}
	})

	test('resumes a lost start response only from the exact server-bound manifest path', () => {
		const pending: GitHubSourceConnectionStatusDto = {
			provider: 'zerops',
			kind: 'github-app',
			state: 'setup-pending',
			connectionId: 'connection-1',
			phase: 'awaiting-manifest-callback',
			continuePath: '/api/source/github/manifest/connection-1',
		}
		expect(sourceManifestContinuePath(pending)).toBe('/api/source/github/manifest/connection-1')
		expect(sourceManifestContinuePath({ ...pending, phase: 'activating' })).toBeNull()
		expect(sourceManifestContinuePath({ ...pending, continuePath: '//evil.example/manifest/connection-1' })).toBeNull()
		expect(sourceStartContinuePath({ connectionId: 'connection-1', continuePath: '/api/source/github/manifest/connection-1' })).toBe(
			'/api/source/github/manifest/connection-1',
		)
		expect(sourceStartContinuePath({ connectionId: 'connection-1', continuePath: 'https://evil.example/manifest' })).toBeNull()
	})

	test('maps durable backend phases to the three physical connection lamps', () => {
		const pending: GitHubSourceConnectionStatusDto = {
			provider: 'zerops',
			kind: 'github-app',
			state: 'setup-pending',
			connectionId: 'connection-1',
			phase: 'activating',
		}
		expect(sourceChain(pending).map((node) => [node.label, node.lamp])).toEqual([
			['GitHub App', 'ok'],
			['Private source', 'run'],
			['Webhook', 'idle'],
		])
		const unavailable: GitHubSourceConnectionStatusDto = { provider: 'legacy', kind: 'github-app', state: 'unavailable' }
		expect(sourceChain(unavailable).every((node) => node.lamp === 'idle')).toBe(true)
	})
})
