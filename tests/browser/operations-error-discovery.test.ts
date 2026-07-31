import { browserTest, byLabel, byRole, expect, getPage, invariant, step } from '@opice/harness'
import { randomUUID } from 'node:crypto'
import { readBrowserFixtures, scenarioMarker, sendErrorFixture } from './support/fixtures'
import { createBrowserIdentity } from './support/local-stack'

const BASE_URL = process.env['FABRIKA_BROWSER_BASE_URL'] ?? 'http://control.localhost:18080'
const PRIMARY_FAILURE = 'BrowserFixtureError: Browser fixture primary failure'
const MERGE_CANDIDATE = 'BrowserFixtureError: Browser fixture merge candidate'
const FILTER_SCENARIO = 'operations-discovery-status-filters'
const FILTER_RUN = `filters-${randomUUID().slice(0, 8)}`
const FILTER_FIXTURE_MARKER = scenarioMarker(FILTER_SCENARIO)
const RESOLVED_FILTER_TITLE = `BrowserScenarioError: Resolved ${FILTER_RUN} [${FILTER_FIXTURE_MARKER}]`
const IGNORED_FILTER_TITLE = `BrowserScenarioError: Ignored ${FILTER_RUN} [${FILTER_FIXTURE_MARKER}]`

interface RpcResult {
	status: number
	body: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function rpcResult(body: unknown): Record<string, unknown> {
	if (!isRecord(body) || body['error'] !== undefined || !isRecord(body['result'])) throw new Error('Operations RPC response is invalid')
	return body['result']
}

function arrayProperty(value: Record<string, unknown>, key: string): unknown[] {
	const items = value[key]
	if (!Array.isArray(items)) throw new Error(`Operations RPC response is missing ${key}`)
	return items
}

function stringProperty(value: unknown, key: string): string {
	if (!isRecord(value) || typeof value[key] !== 'string' || value[key] === '') throw new Error(`Operations RPC response is missing ${key}`)
	return value[key]
}

function itemByProperty(items: unknown[], key: string, expected: string): unknown {
	const item = items.find((candidate) => isRecord(candidate) && candidate[key] === expected)
	if (item === undefined) throw new Error(`Operations RPC response omitted ${expected}`)
	return item
}

async function browserRpc(method: string, input: unknown): Promise<RpcResult> {
	return await getPage().evaluate(async ({ method: rpcMethod, input: rpcInput }) => {
		const response = await fetch('/operations/api/rpc', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ method: rpcMethod, input: rpcInput }),
		})
		const body: unknown = await response.json()
		return { status: response.status, body }
	}, { method, input })
}

async function identityRpc(session: string, method: string, input: unknown): Promise<RpcResult> {
	const response = await fetch(`${BASE_URL}/operations/api/rpc`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			cookie: `px_session=${session}`,
			origin: BASE_URL,
		},
		body: JSON.stringify({ method, input }),
	})
	const body: unknown = await response.json()
	return { status: response.status, body }
}

function expectNotFound(result: RpcResult): void {
	expect(result.status).toBe(404)
	expect(result.body).toEqual({ error: { type: 'not_found', message: 'not found' } })
}

function expectOk(label: string, result: RpcResult): void {
	if (result.status !== 200) throw new Error(`${label} failed with status ${result.status}: ${JSON.stringify(result.body)}`)
}

async function prepareFilterIssue(title: string, status: 'resolved' | 'ignored'): Promise<void> {
	const issues = arrayProperty(rpcResult((await browserRpc('issues', { query: FILTER_RUN, limit: 100 })).body), 'items')
	const issue = itemByProperty(issues, 'title', title)
	if (stringProperty(issue, 'status') === status) return
	const mutation = await browserRpc('mutateIssue', {
		issueId: stringProperty(issue, 'id'),
		mutation: { kind: 'status', status },
	})
	expectOk(`${status} filter fixture`, mutation)
}

browserTest(
	{
		name: 'A scoped operator discovers only permitted application errors',
		url: `${BASE_URL}/operations/errors`,
		feature: 'operations-adoption-discovery',
		seeds: ['operations-browser-fixtures'],
		roles: ['operations-notes'],
		tier: 'critical',
		setup: async () => {
			await Promise.all([
				sendErrorFixture({ scenario: FILTER_SCENARIO, title: `Resolved ${FILTER_RUN}`, fingerprint: `${FILTER_RUN}-resolved` }),
				sendErrorFixture({ scenario: FILTER_SCENARIO, title: `Ignored ${FILTER_RUN}`, fingerprint: `${FILTER_RUN}-ignored` }),
			])
		},
	},
	async () => {
		await step('the scoped operator sees the Browser Notes source and its primary failure', {
			intent: 'an application-scoped IAM session can discover issues for its permitted application environment',
			manual: 'Open "Errors" under Operations. Verify that "Browser fixture primary failure" appears for "Browser Notes / test".',
		}, async () => {
			await expect.poll(async () => {
				const items = arrayProperty(rpcResult((await browserRpc('issues', { query: FILTER_RUN, limit: 100 })).body), 'items')
				return [RESOLVED_FILTER_TITLE, IGNORED_FILTER_TITLE].every((title) => items.some((item) => isRecord(item) && item['title'] === title))
			}, { timeout: 15_000 }).toBe(true)
			await prepareFilterIssue(RESOLVED_FILTER_TITLE, 'resolved')
			await prepareFilterIssue(IGNORED_FILTER_TITLE, 'ignored')
			await getPage().reload({ waitUntil: 'domcontentloaded' })

			const table = byRole('table', 'Operations issues')
			await expect(table).toContainText(PRIMARY_FAILURE)
			await expect(table).toContainText('Browser Notes / test')
		})

		await step('search narrows the list to the primary failure', {
			intent: 'operators can find a known failure by title without depending on list order or global counts',
			manual: 'Enter "primary failure" in "Search". Verify that the matching error remains visible.',
		}, async () => {
			await byLabel('Search').fill('primary failure')
			const table = byRole('table', 'Operations issues')
			await expect(table).toContainText(PRIMARY_FAILURE)
			await expect(table).not.toContainText(MERGE_CANDIDATE)
		})

		await step('status filters expose the supported issue states', {
			intent: 'the error list can be narrowed by open, resolved, ignored, or all status',
			manual: 'Use "Status" to show Open, Resolved, Ignored, and All errors. Verify that the matching test error appears in each view.',
		}, async () => {
			const status = byRole('combobox', 'Status', { exact: true })
			const search = byLabel('Search')
			const table = byRole('table', 'Operations issues')

			await status.selectOption('open')
			await expect(status).toHaveValue('open')
			await search.fill('primary failure')
			await expect(table).toContainText(PRIMARY_FAILURE)

			await status.selectOption('resolved')
			await expect(status).toHaveValue('resolved')
			await search.fill(FILTER_RUN)
			await expect(table).toContainText(RESOLVED_FILTER_TITLE)

			await status.selectOption('ignored')
			await expect(status).toHaveValue('ignored')
			await expect(table).toContainText(IGNORED_FILTER_TITLE)

			await status.selectOption('all')
			await expect(status).toHaveValue('all')
			await expect(table).toContainText(RESOLVED_FILTER_TITLE)
			await expect(table).toContainText(IGNORED_FILTER_TITLE)

			await status.selectOption('open')
			await search.fill('primary failure')
			await expect(table).toContainText(PRIMARY_FAILURE)
		})

		await step('the matching row opens a scoped issue detail', {
			intent: 'list-to-detail navigation preserves the permitted issue boundary through the same-origin gateway',
			manual: 'Select "Browser fixture primary failure". Verify that its issue detail opens.',
		}, async () => {
			await byRole('link', PRIMARY_FAILURE, { exact: true }).click()
			await expect(byRole('heading', PRIMARY_FAILURE, { level: 1 })).toBeVisible()
			await expect(getPage().locator('.eyebrow')).toContainText('browser-notes · test · default')
			await expect(getPage().getByTestId('issue-status')).toHaveAttribute('data-status', 'open')
			await expect(byRole('heading', 'Latest occurrence', { level: 2 })).toBeVisible()
		})

		await invariant(
			'the scoped operator cannot infer the hidden sibling source',
			async () => {
				const fixtures = readBrowserFixtures()
				const identity = await createBrowserIdentity('admin')
				const adminSources = await identityRpc(identity.session, 'sources', undefined)
				expectOk('admin sources', adminSources)
				const hiddenSource = itemByProperty(arrayProperty(rpcResult(adminSources.body), 'items'), 'appId', fixtures.hidden.appId)
				const hiddenSourceId = stringProperty(hiddenSource, 'id')

				const adminIssues = await identityRpc(identity.session, 'issues', { sourceId: hiddenSourceId, limit: 100 })
				expectOk('admin hidden issues', adminIssues)
				const hiddenIssue = itemByProperty(
					arrayProperty(rpcResult(adminIssues.body), 'items'),
					'title',
					'BrowserFixtureError: Hidden browser fixture failure',
				)
				const hiddenIssueId = stringProperty(hiddenIssue, 'id')

				const adminReleases = await identityRpc(identity.session, 'releases', { sourceId: hiddenSourceId, limit: 100 })
				expectOk('admin hidden releases', adminReleases)
				const hiddenRelease = itemByProperty(arrayProperty(rpcResult(adminReleases.body), 'items'), 'releaseName', fixtures.hidden.release.name)
				const hiddenReleaseId = stringProperty(hiddenRelease, 'id')

				const marker = Date.now().toString(36)
				const hiddenHealthPath = `/opice-hidden-discovery-${marker}`
				const hiddenAlertTarget = `https://hidden-${marker}.example.test/fabrika`
				let healthCheckId: string | null = null
				let alertChannelId: string | null = null
				try {
					const healthCheck = await identityRpc(identity.session, 'createHealthCheck', {
						sourceId: hiddenSourceId,
						input: {
							path: hiddenHealthPath,
							enabled: false,
							intervalMs: 60_000,
							timeoutMs: 2_000,
							expectedStatus: 200,
							failureThreshold: 2,
							recoveryThreshold: 1,
							staleAfterMs: 180_000,
						},
					})
					expectOk('hidden health fixture', healthCheck)
					healthCheckId = stringProperty(rpcResult(healthCheck.body), 'id')

					const alertChannel = await identityRpc(identity.session, 'createAlertChannel', {
						sourceId: hiddenSourceId,
						input: { scope: 'new_issue', type: 'webhook', target: hiddenAlertTarget, enabled: false },
					})
					expectOk('hidden alert fixture', alertChannel)
					alertChannelId = stringProperty(rpcResult(alertChannel.body), 'id')

					const sources = await browserRpc('sources', undefined)
					const issues = await browserRpc('issues', { limit: 100 })
					const releases = await browserRpc('releases', { limit: 100 })
					const health = await browserRpc('health', undefined)
					expectOk('scoped sources', sources)
					expectOk('scoped issues', issues)
					expectOk('scoped releases', releases)
					expectOk('scoped health', health)

					const visibleSource = itemByProperty(arrayProperty(rpcResult(sources.body), 'items'), 'appId', fixtures.visible.appId)
					const visibleSourceId = stringProperty(visibleSource, 'id')
					const visibleIssues = await browserRpc('issues', { sourceId: visibleSourceId, limit: 100 })
					expectOk('scoped visible issues', visibleIssues)
					expect(rpcResult(issues.body)['summary']).toEqual(rpcResult(visibleIssues.body)['summary'])

					const hiddenIssueList = await browserRpc('issues', { sourceId: hiddenSourceId, limit: 100 })
					const hiddenReleaseList = await browserRpc('releases', { sourceId: hiddenSourceId, limit: 100 })
					expectOk('scoped hidden issue list', hiddenIssueList)
					expectOk('scoped hidden release list', hiddenReleaseList)

					const directResults = await Promise.all([
						browserRpc('source', { sourceId: hiddenSourceId }),
						browserRpc('issue', { issueId: hiddenIssueId }),
						browserRpc('release', { releaseId: hiddenReleaseId }),
						browserRpc('sourceHealth', { sourceId: hiddenSourceId }),
						browserRpc('alerts', { sourceId: hiddenSourceId }),
					])
					for (const result of directResults) expectNotFound(result)

					const protectedValues = [
						fixtures.hidden.displayName,
						fixtures.hidden.appId,
						fixtures.hidden.environment,
						fixtures.hidden.ingestProjectId,
						fixtures.hidden.publicKey,
						fixtures.hidden.release.name,
						fixtures.hidden.release.runId,
						'Hidden browser fixture failure',
						hiddenSourceId,
						hiddenIssueId,
						hiddenReleaseId,
						hiddenHealthPath,
						hiddenAlertTarget,
					]
					const scopedEvidence = JSON.stringify([
						sources.body,
						issues.body,
						releases.body,
						health.body,
						hiddenIssueList.body,
						hiddenReleaseList.body,
						...directResults.map((result) => result.body),
					])
					const pageBody = await getPage().locator('body').textContent()
					for (const protectedValue of protectedValues) {
						expect(scopedEvidence).not.toContain(protectedValue)
						expect(pageBody).not.toContain(protectedValue)
					}
				} finally {
					const cleanupResults: { label: string; result: RpcResult }[] = []
					if (alertChannelId !== null) {
						cleanupResults.push({
							label: 'hidden alert cleanup',
							result: await identityRpc(identity.session, 'deleteAlertChannel', { sourceId: hiddenSourceId, channelId: alertChannelId }),
						})
					}
					if (healthCheckId !== null) {
						cleanupResults.push({
							label: 'hidden health cleanup',
							result: await identityRpc(identity.session, 'deleteHealthCheck', { sourceId: hiddenSourceId, checkId: healthCheckId }),
						})
					}
					for (const cleanup of cleanupResults) expectOk(cleanup.label, cleanup.result)

					const cleanedHealth = await identityRpc(identity.session, 'sourceHealth', { sourceId: hiddenSourceId })
					const cleanedAlerts = await identityRpc(identity.session, 'alerts', { sourceId: hiddenSourceId })
					expectOk('hidden health cleanup verification', cleanedHealth)
					expectOk('hidden alert cleanup verification', cleanedAlerts)
					const cleanupEvidence = JSON.stringify([cleanedHealth.body, cleanedAlerts.body])
					for (const removedValue of [healthCheckId, alertChannelId, hiddenHealthPath, hiddenAlertTarget]) {
						if (removedValue !== null) expect(cleanupEvidence).not.toContain(removedValue)
					}
				}
			},
		)
	},
)
