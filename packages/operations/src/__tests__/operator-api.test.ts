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
	const issues = await options.repositories.operator.listIssues({ sourceIds: [id], sort: 'recent', limit: 10 })
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

async function responseObject(response: Response): Promise<Record<string, unknown>> {
	const value: unknown = await response.json()
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected response object')
	return Object.fromEntries(Object.entries(value))
}

function objectItems(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) throw new Error('expected response items')
	const items: Record<string, unknown>[] = []
	for (const item of value) {
		if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('expected response item object')
		items.push(Object.fromEntries(Object.entries(item)))
	}
	return items
}

describe('Operations operator API', () => {
	test('filters issue rows on the server and keyset-paginates every sort without skipping older rows', async () => {
		const harness = createHarness(() => 10_000)
		const input = options(auth({ apps: ['app-a'] }), harness)
		input.now = () => 40 * 24 * 60 * 60 * 1_000
		const recentId = await seedSource(input, 'source-a', 'app-a', 'recent', 39 * 24 * 60 * 60 * 1_000)
		const ingest = async (eventId: string, fingerprint: string, receivedAt: number, level: string = 'error'): Promise<void> => {
			await persistIngest(
				{ repositories: input.repositories, payloads: input.payloads, ingestQueue: new EmptyQueue() },
				{
					projectId: 'source-a',
					eventId,
					fingerprint,
					title: `Failure ${fingerprint}`,
					culprit: 'handler',
					level,
					receivedAt,
					payload: { event_id: eventId, message: fingerprint },
				},
			)
		}
		await ingest('event-middle', 'middle', 30 * 24 * 60 * 60 * 1_000, 'warning')
		await ingest('event-older', 'older%_literal', 20 * 24 * 60 * 60 * 1_000)
		await seedSource(input, 'source-foreign', 'app-b', 'foreign', 39 * 24 * 60 * 60 * 1_000)
		const older = await input.repositories.operator.getIssueByCoordinate('source-a', 'older%_literal')
		if (older === null) throw new Error('older issue is missing')
		const middle = await input.repositories.operator.getIssueByCoordinate('source-a', 'middle')
		if (middle === null) throw new Error('middle issue is missing')
		await input.repositories.issues.mutate({
			sourceId: 'source-a',
			fingerprint: 'recent',
			mutation: { kind: 'assign', principalId: 'operator-id', principalLabel: 'operator@example.test' },
			actorId: null,
			actorLabel: null,
		})
		await input.repositories.issues.mutate({
			sourceId: 'source-a',
			fingerprint: 'older%_literal',
			mutation: { kind: 'status', status: 'resolved' },
			actorId: null,
			actorLabel: null,
		})
		const harnessIssueIds = [recentId, middle.id, older.id]
		expect(
			harness.sqlite.query<{ assigned_to: string | null; last_seen: number }, []>(
				"SELECT assigned_to, last_seen FROM issues WHERE fingerprint = 'recent'",
			).get(),
		).toEqual({ assigned_to: 'operator-id', last_seen: 39 * 24 * 60 * 60 * 1_000 })

		const filtered = await responseObject(
			await call('/api/issues?sourceId=source-a&window=7d&level=error&assignee=me&query=Failure&sort=new', input),
		)
		expect(objectItems(filtered['items']).map((item) => item['id'])).toEqual([recentId])
		expect(filtered['summary']).toEqual({ total: 1, open: 1, resolved: 0, ignored: 0 })
		const none = await responseObject(await call('/api/issues?sourceId=source-a&assignee=none&status=resolved', input))
		expect(objectItems(none['items']).map((item) => item['id'])).toEqual([older.id])
		const warning = await responseObject(await call('/api/issues?sourceId=source-a&level=warning&window=30d', input))
		expect(objectItems(warning['items']).map((item) => item['id'])).toEqual([middle.id])
		const literalQuery = await responseObject(await call('/api/issues?sourceId=source-a&query=%25_', input))
		expect(objectItems(literalQuery['items']).map((item) => item['id'])).toEqual([older.id])

		for (const sort of ['recent', 'new', 'frequency']) {
			const first = await responseObject(await call(`/api/issues?sourceId=source-a&sort=${sort}&limit=1`, input))
			const firstItems = objectItems(first['items'])
			const cursor = first['nextCursor']
			if (typeof cursor !== 'string') throw new Error('expected next cursor')
			const second = await responseObject(
				await call(`/api/issues?sourceId=source-a&sort=${sort}&limit=1&cursor=${encodeURIComponent(cursor)}`, input),
			)
			const secondItems = objectItems(second['items'])
			expect(secondItems).toHaveLength(1)
			const secondId = secondItems[0]?.['id']
			if (typeof secondId !== 'string') throw new Error('expected second issue id')
			expect(secondId).not.toBe(firstItems[0]?.['id'])
			expect(harnessIssueIds).toContain(secondId)
		}
	})

	test('aggregates merged history into counts and trends and paginates selectable occurrences', async () => {
		const input = options(auth({ apps: ['app-a'] }))
		await input.repositories.sources.upsert({
			id: 'source-a',
			appId: 'app-a',
			environment: 'production',
			displayName: 'app-a',
			enabled: true,
		})
		const ingest = (eventId: string, fingerprint: string, receivedAt: number): Promise<unknown> =>
			persistIngest(
				{ repositories: input.repositories, payloads: input.payloads, ingestQueue: new EmptyQueue() },
				{
					projectId: 'source-a',
					eventId,
					fingerprint,
					title: `Failure ${fingerprint}`,
					culprit: 'handler',
					level: 'error',
					receivedAt,
					payload: { event_id: eventId, message: eventId },
				},
			)
		await ingest('target-event', 'target', 7_000)
		await ingest('child-event-a', 'child', 8_000)
		await ingest('child-event-b', 'child', 9_000)
		await ingest('other-event', 'other', 6_000)
		await input.repositories.issues.mutate({
			sourceId: 'source-a',
			fingerprint: 'child',
			mutation: { kind: 'merge', target: 'target' },
			actorId: null,
			actorLabel: null,
		})
		const target = await input.repositories.operator.getIssueByCoordinate('source-a', 'target')
		if (target === null) throw new Error('target issue is missing')

		const list = await responseObject(await call('/api/issues?sourceId=source-a', input))
		const listed = objectItems(list['items'])
		expect(listed).toHaveLength(2)
		const targetSummary = listed.find((item) => item['id'] === target.id)
		expect(targetSummary?.['count']).toBe(3)
		expect(targetSummary?.['trend']).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3])

		const first = await responseObject(await call(`/api/issues/${target.id}/occurrences?limit=1`, input))
		const firstOccurrence = objectItems(first['items'])[0]
		const occurrenceId = firstOccurrence?.['id']
		const cursor = first['nextCursor']
		if (typeof occurrenceId !== 'string' || typeof cursor !== 'string') throw new Error('expected occurrence and cursor')
		const selected = await responseObject(await call(`/api/issues/${target.id}/events/${occurrenceId}`, input))
		expect(selected['occurrenceId']).toBe(occurrenceId)
		const second = await responseObject(
			await call(`/api/issues/${target.id}/occurrences?limit=1&cursor=${encodeURIComponent(cursor)}`, input),
		)
		expect(objectItems(second['items'])[0]?.['id']).not.toBe(occurrenceId)
		const other = await input.repositories.operator.getIssueByCoordinate('source-a', 'other')
		if (other === null) throw new Error('other issue is missing')
		const otherOccurrence = await input.repositories.operator.latestOccurrence(other)
		if (otherOccurrence === null) throw new Error('other occurrence is missing')
		expect((await call(`/api/issues/${target.id}/events/${otherOccurrence.id}`, input)).status).toBe(404)
	})

	test('exposes notification delivery attempts only through their source alert settings', async () => {
		const harness = createHarness(() => 10_000)
		const input = options(auth(), harness)
		await seedSource(input, 'source-a', 'app-a', 'fingerprint-a', 1_000)
		await seedSource(input, 'source-b', 'app-b', 'fingerprint-b', 1_000)
		for (const sourceId of ['source-a', 'source-b']) {
			await input.repositories.alerts.upsertChannel({
				id: `channel-${sourceId}`,
				sourceId,
				scope: 'new_issue',
				type: 'webhook',
				target: 'https://hooks.example.test/private?token=target-secret',
				enabled: true,
			})
			await input.repositories.alerts.enqueueNotification({
				dedupKey: `delivery-${sourceId}`,
				sourceId,
				channelId: `channel-${sourceId}`,
				kind: 'new_issue',
				payload: { sourceId, secret: 'payload-secret' },
			})
		}
		const claimed = await input.repositories.alerts.claimNotifications({ limit: 10, leaseMs: 1_000 })
		for (const notification of claimed) {
			await input.repositories.alerts.completeNotification({
				id: notification.id,
				claimToken: notification.claimToken,
				delivered: notification.dedupKey === 'delivery-source-a',
				...(notification.dedupKey === 'delivery-source-a' ? {} : { errorCode: 'rejected' }),
			})
		}
		const response = await responseObject(await call('/api/sources/source-a/alerts', input))
		const deliveries = objectItems(response['deliveries'])
		expect(deliveries).toHaveLength(1)
		expect(deliveries[0]).toMatchObject({ kind: 'new_issue', status: 'delivered', attemptCount: 1 })
		expect(deliveries[0]?.['attempts']).toEqual([expect.objectContaining({ delivered: true, errorCode: null })])
		const serialized = JSON.stringify(response)
		expect(serialized).not.toContain('source-b')
		expect(serialized).not.toContain('target-secret')
		expect(serialized).not.toContain('payload-secret')
	})

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

		const first = await input.repositories.operator.listIssues({ sourceIds: ['source-a'], sort: 'recent', limit: 10 })
		const replacementId = first[0]?.id
		expect(replacementId).toBeString()
		expect(replacementId).not.toBe(originalId)
		const second = await input.repositories.operator.listIssues({ sourceIds: ['source-a'], sort: 'recent', limit: 10 })
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
