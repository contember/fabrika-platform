import type { AuthContext, DomainEvent, PrincipalList } from '@fabrika/auth'
import type { IngestMessage } from '@fabrika/operations-contract'
import type { BlobStore, JobQueue } from '@fabrika/platform'
import { describe, expect, spyOn, test } from 'bun:test'
import { SqliteHealthRepository } from '../health-repository.js'
import { handleOperationsOperatorRequest, type OperationsOperatorOptions } from '../operator-api.js'
import { persistIngest } from '../pipeline.js'
import { createHarness } from './helpers/sqlite.js'

class MemoryBlobs implements BlobStore {
	readonly values = new Map<string, string>()

	put(key: string, value: string | ArrayBuffer | ReadableStream): Promise<void> {
		if (typeof value !== 'string') throw new Error('test blob store accepts strings only')
		this.values.set(key, value)
		return Promise.resolve()
	}

	get(key: string): Promise<{ body: ReadableStream; text(): Promise<string> } | null> {
		const value = this.values.get(key)
		if (value === undefined) return Promise.resolve(null)
		return Promise.resolve({ body: new Blob([value]).stream(), text: () => Promise.resolve(value) })
	}

	delete(key: string): Promise<void> {
		this.values.delete(key)
		return Promise.resolve()
	}
}

class EmptyQueue implements JobQueue<IngestMessage> {
	send(): Promise<void> {
		return Promise.resolve()
	}
}

function auth(input: {
	apps?: string[] | null
	actions?: string[]
	audits?: DomainEvent[]
} = {}): AuthContext {
	const apps = input.apps ?? null
	const actions = input.actions ?? ['operations.read', 'operations.triage', 'operations.manage']
	const allowed = (action: string): boolean => actions.includes(action)
	return {
		ok: true,
		principal: { id: 'operator-id', type: 'user', label: 'operator@example.test' },
		can: (action, scope) =>
			allowed(action)
			&& (apps === null || (scope?.type === 'app' && apps.includes(scope.value))),
		scopedTo: (action, dimension) => {
			if (!allowed(action)) return []
			if (apps === null) return null
			return dimension === 'app' ? apps : []
		},
		audit: (event) => {
			input.audits?.push(event)
			return Promise.resolve()
		},
	}
}

async function seedSource(
	options: OperationsOperatorOptions,
	id: string,
	appId: string,
	fingerprint: string,
	receivedAt: number,
): Promise<string> {
	await options.repositories.sources.upsert({
		id,
		appId,
		environment: 'production',
		displayName: appId,
		enabled: true,
		publicOrigin: `https://${appId}.example.test`,
	})
	await persistIngest(
		{ repositories: options.repositories, payloads: options.payloads, ingestQueue: new EmptyQueue() },
		{
			projectId: id,
			eventId: `event-${id}`,
			fingerprint,
			title: `Failure in ${appId}`,
			culprit: 'handler',
			level: 'error',
			receivedAt,
			payload: { event_id: `event-${id}`, message: `private ${appId}` },
		},
	)
	const issues = await options.repositories.operator.listIssues({ sourceIds: [id], offset: 0, limit: 10 })
	const issue = issues[0]
	if (issue === undefined) throw new Error('seeded issue is missing')
	return issue.id
}

function options(
	context: AuthContext,
	harness: ReturnType<typeof createHarness> = createHarness(() => 10_000),
): OperationsOperatorOptions {
	return {
		repositories: harness.repositories,
		health: new SqliteHealthRepository(harness.db, () => 10_000),
		payloads: new MemoryBlobs(),
		auth: context,
		principals: {
			listPrincipals: (): Promise<PrincipalList> =>
				Promise.resolve({
					ok: true,
					principals: [
						{ id: 'owner-id', type: 'user', label: 'owner@example.test', email: 'owner@example.test', disabled: false },
						{ id: 'disabled-id', type: 'user', label: 'disabled@example.test', email: 'disabled@example.test', disabled: true },
					],
				}),
		},
		now: () => 10_000,
	}
}

function request(path: string, init?: RequestInit): Request {
	return new Request(`https://operations.internal${path}`, init)
}

async function call(path: string, input: OperationsOperatorOptions, init?: RequestInit): Promise<Response> {
	return handleOperationsOperatorRequest(request(path, init), input)
}

describe('Operations operator API', () => {
	test('lists only scoped issues and exposes a persistent opaque id instead of fingerprints', async () => {
		const input = options(auth({ apps: ['app-a'] }))
		const issueA = await seedSource(input, 'source-a', 'app-a', 'secret-fingerprint-a', 1_000)
		await seedSource(input, 'source-b', 'app-b', 'secret-fingerprint-b', 2_000)

		const response = await call('/api/issues', input)
		expect(response.status).toBe(200)
		const text = await response.text()
		expect(text).toContain(issueA)
		expect(text).toContain('app-a')
		expect(text).not.toContain('app-b')
		expect(text).not.toContain('secret-fingerprint')

		input.repositories.operator.getIssueById(issueA)
		const second = await call('/api/issues', input)
		expect(await second.text()).toContain(issueA)
	})

	test('backfills a stable caller-generated id for rows created before the operator migration', async () => {
		const harness = createHarness(() => 10_000)
		const input = options(auth({ apps: ['app-a'] }), harness)
		const originalId = await seedSource(input, 'source-a', 'app-a', 'legacy-fingerprint', 1_000)
		harness.sqlite.run('UPDATE issues SET id = NULL WHERE source_id = ?', ['source-a'])

		const first = await input.repositories.operator.listIssues({ sourceIds: ['source-a'], offset: 0, limit: 10 })
		const replacementId = first[0]?.id
		expect(replacementId).toBeString()
		expect(replacementId).not.toBe(originalId)
		const second = await input.repositories.operator.listIssues({ sourceIds: ['source-a'], offset: 0, limit: 10 })
		expect(second[0]?.id).toBe(replacementId)
	})

	test('makes a forbidden detail indistinguishable from a missing issue and does not leak counts', async () => {
		const input = options(auth({ apps: ['app-a'] }))
		await seedSource(input, 'source-a', 'app-a', 'fingerprint-a', 1_000)
		const foreignId = await seedSource(input, 'source-b', 'app-b', 'fingerprint-b', 2_000)

		const forbidden = await call(`/api/issues/${foreignId}`, input)
		const missing = await call('/api/issues/does-not-exist', input)
		expect(forbidden.status).toBe(404)
		expect(await forbidden.text()).toBe(await missing.text())

		const list = await call('/api/issues', input)
		expect(await list.json()).toMatchObject({ summary: { total: 1, open: 1 } })
	})

	test('derives assignment labels from IAM and audits with the opaque issue id', async () => {
		const audits: DomainEvent[] = []
		const input = options(auth({ audits }))
		const issueId = await seedSource(input, 'source-a', 'app-a', 'fingerprint-a', 1_000)
		const response = await call(`/api/issues/${issueId}`, input, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ kind: 'assign', principalId: 'owner-id', principalLabel: 'spoofed' }),
		})
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({
			issue: { assignedTo: { id: 'owner-id', label: 'owner@example.test' } },
		})
		expect(audits).toEqual([{
			action: 'operations.issue.assign',
			resourceType: 'operations_issue',
			resourceId: issueId,
		}])
	})

	test('preauthorizes every bulk target before one atomic status update', async () => {
		const audits: DomainEvent[] = []
		const input = options(auth({ apps: ['app-a'], audits }))
		const issueA = await seedSource(input, 'source-a', 'app-a', 'fingerprint-a', 1_000)
		const issueB = await seedSource(input, 'source-b', 'app-b', 'fingerprint-b', 2_000)

		const forbidden = await call('/api/issues/bulk', input, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ issueIds: [issueA, issueB], status: 'resolved' }),
		})
		expect(forbidden.status).toBe(404)
		expect((await input.repositories.operator.getIssueById(issueA))?.status).toBe('open')
		expect((await input.repositories.operator.getIssueById(issueB))?.status).toBe('open')
		expect(audits).toEqual([])

		input.auth = auth({ audits })
		const updated = await call('/api/issues/bulk', input, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ issueIds: [issueA, issueB], status: 'resolved' }),
		})
		expect(updated.status).toBe(200)
		expect((await input.repositories.operator.getIssueById(issueA))?.status).toBe('resolved')
		expect((await input.repositories.operator.getIssueById(issueB))?.status).toBe('resolved')
		expect(audits.map((event) => event.resourceId).sort()).toEqual([issueA, issueB].sort())
	})

	test('redacts webhook credentials and protects alert settings with manage scope', async () => {
		const input = options(auth({ apps: ['app-a'] }))
		await seedSource(input, 'source-a', 'app-a', 'fingerprint-a', 1_000)
		await input.repositories.alerts.upsertChannel({
			id: 'channel-a',
			sourceId: 'source-a',
			scope: 'new_issue',
			type: 'webhook',
			target: 'https://hooks.example.test/private?token=secret',
			enabled: true,
		})
		const response = await call('/api/sources/source-a/alerts', input)
		const text = await response.text()
		expect(response.status).toBe(200)
		expect(text).toContain('https://hooks.example.test/…')
		expect(text).not.toContain('private')
		expect(text).not.toContain('secret')

		input.auth = auth({ apps: ['app-a'], actions: ['operations.read'] })
		expect((await call('/api/sources/source-a/alerts', input)).status).toBe(404)
	})

	test('rejects unsafe webhook targets and preserves a valid HTTPS path and query', async () => {
		const input = options(auth({ apps: ['app-a'] }))
		await seedSource(input, 'source-a', 'app-a', 'fingerprint-a', 1_000)
		const unsafeTargets = [
			'http://hooks.example.test/hook',
			'https://user:password@hooks.example.test/hook',
			'https://hooks.example.test/hook#fragment',
			'https://127.0.0.1/hook',
			'https://192.168.1.20/hook',
			'https://0x7f000001/hook',
			'https://2130706433/hook',
			'https://017700000001/hook',
			'https://127.1/hook',
			'https://[::1]/hook',
			'https://localhost/hook',
			'https://service.localhost/hook',
			'https://service.local/hook',
			'https://service.internal/hook',
			'https://single-label/hook',
		]
		for (const target of unsafeTargets) {
			const response = await call('/api/sources/source-a/alerts/channels', input, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ scope: 'new_issue', type: 'webhook', target, enabled: true }),
			})
			expect(response.status).toBe(400)
		}

		const target = 'https://hooks.example.test/private/path?token=value&kind=issue'
		const accepted = await call('/api/sources/source-a/alerts/channels', input, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ scope: 'new_issue', type: 'webhook', target, enabled: true }),
		})
		expect(accepted.status).toBe(201)
		expect((await input.repositories.alerts.listChannels('source-a'))[0]?.target).toBe(target)
	})

	test('object-scoped REST mutations hide forbidden resources before parsing malformed bodies', async () => {
		const audits: DomainEvent[] = []
		const input = options(auth({ apps: ['app-a'], audits }))
		const issueId = await seedSource(input, 'source-b', 'app-b', 'fingerprint-b', 1_000)
		await input.health.upsertCheck({
			id: 'check-b',
			sourceId: 'source-b',
			path: '/original',
			enabled: true,
			intervalMs: 60_000,
			staleAfterMs: 180_000,
		})
		await input.repositories.alerts.upsertChannel({
			id: 'channel-b',
			sourceId: 'source-b',
			scope: 'new_issue',
			type: 'webhook',
			target: 'https://hooks.example.test/original',
			enabled: true,
		})
		const malformed: RequestInit = {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: '{',
		}
		const requests: Array<[string, RequestInit]> = [
			[`/api/issues/${issueId}`, malformed],
			['/api/sources/source-b/health-checks', { ...malformed, method: 'POST' }],
			['/api/sources/source-b/health-checks/check-b', malformed],
			['/api/sources/source-b/alerts/spike', malformed],
			['/api/sources/source-b/alerts/rules/new_issue', malformed],
			['/api/sources/source-b/alerts/channels', { ...malformed, method: 'POST' }],
			['/api/sources/source-b/alerts/channels/channel-b', malformed],
		]
		for (const [path, init] of requests) {
			const response = await call(path, input, init)
			expect(response.status).toBe(404)
			const body: unknown = await response.json()
			expect(body).toEqual({ error: 'not found' })
		}

		expect((await input.repositories.operator.getIssueById(issueId))?.status).toBe('open')
		expect((await input.health.getCheck('check-b'))?.path).toBe('/original')
		expect(await input.repositories.alerts.getConfig('source-b')).toBeNull()
		expect(await input.repositories.alerts.listRules('source-b')).toEqual([])
		expect(await input.repositories.alerts.listChannels('source-b')).toHaveLength(1)
		expect((await input.repositories.alerts.listChannels('source-b'))[0]?.target).toBe('https://hooks.example.test/original')
		expect(audits).toEqual([])
	})

	test('creates and reads a source-scoped HTTP health check without accepting an arbitrary origin', async () => {
		const input = options(auth({ apps: ['app-a'] }))
		await seedSource(input, 'source-a', 'app-a', 'fingerprint-a', 1_000)
		const create = await call('/api/sources/source-a/health-checks', input, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				path: '/health',
				enabled: true,
				intervalMs: 60_000,
				timeoutMs: 5_000,
				expectedStatus: 200,
				failureThreshold: 3,
				recoveryThreshold: 2,
				staleAfterMs: 1_000,
				publicOrigin: 'https://attacker.invalid',
			}),
		})
		expect(create.status).toBe(201)
		const check = (await input.health.listChecks('source-a'))[0]
		if (check === undefined) throw new Error('created health check is missing')
		await input.health.recordHttpObservation({
			sourceId: 'source-a',
			checkId: check.id,
			observationId: 'observation-a',
			attempt: { successful: true, observedAt: 1_000, latencyMs: 12, status: 200, detailCode: 'ok' },
			decision: {
				current: {
					state: 'healthy',
					observedAt: 1_000,
					latencyMs: 12,
					detailCode: 'ok',
					consecutiveFailures: 0,
					consecutiveSuccesses: 2,
					transitionId: null,
				},
				transition: null,
			},
		})
		const response = await call('/api/sources/source-a/health', input)
		expect(await response.json()).toMatchObject({
			source: { id: 'source-a', publicOrigin: 'https://app-a.example.test' },
			httpChecks: [{ path: '/health', current: { state: 'stale' } }],
			telemetryState: 'unavailable',
		})
	})

	test('never logs a dynamic error detail from an operator request', async () => {
		const input = options(auth({ apps: ['app-a'] }))
		await seedSource(input, 'source-a', 'app-a', 'fingerprint-a', 1_000)
		input.principals = {
			listPrincipals: () => Promise.reject(new Error('https://secret.example.test/?credential=do-not-log')),
		}
		const log = spyOn(console, 'error').mockImplementation(() => undefined)
		try {
			const response = await call('/api/sources/source-a/assignees', input)
			expect(response.status).toBe(500)
			expect(log).toHaveBeenCalledWith('operations operator request failed')
			expect(JSON.stringify(log.mock.calls)).not.toContain('do-not-log')
		} finally {
			log.mockRestore()
		}
	})
})
