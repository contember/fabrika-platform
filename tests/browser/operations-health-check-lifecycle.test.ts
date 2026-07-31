import { browserTest, byLabel, byRole, expect, getPage, invariant, open, reload, step } from '@opice/harness'

const BASE_URL = process.env['FABRIKA_BROWSER_BASE_URL'] ?? 'http://control.localhost:18080'
const OPERATIONS_RPC_URL = `${BASE_URL}/operations/api/rpc`

interface SourceSummary {
	id: string
	appId: string
	environment: string
}

interface HealthCheck {
	id: string
	path: string
	enabled: boolean
	expectedStatus: number
	intervalMs: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function operationsRpc(method: string, input: unknown): Promise<unknown> {
	const response: unknown = await getPage().evaluate(async ({ method: rpcMethod, input: rpcInput }) => {
		const result = await fetch('/operations/api/rpc', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ method: rpcMethod, input: rpcInput }),
		})
		const value: unknown = await result.json()
		return { ok: result.ok, status: result.status, value }
	}, { method, input })
	if (!isRecord(response) || response['ok'] !== true || typeof response['status'] !== 'number' || !isRecord(response['value'])) {
		throw new Error(`Operations RPC ${method} failed`)
	}
	const value = response['value']
	if (value['error'] !== undefined || value['result'] === undefined) {
		throw new Error(`Operations RPC ${method} failed with status ${response['status']}`)
	}
	return value['result']
}

function parseSource(value: unknown): SourceSummary {
	if (
		!isRecord(value) || typeof value['id'] !== 'string' || typeof value['appId'] !== 'string'
		|| typeof value['environment'] !== 'string'
	) {
		throw new Error('Operations source summary is invalid')
	}
	return { id: value['id'], appId: value['appId'], environment: value['environment'] }
}

async function browserNotesSource(): Promise<SourceSummary> {
	const result = await operationsRpc('sources', null)
	if (!isRecord(result) || !Array.isArray(result['items'])) throw new Error('Operations source list response is invalid')
	const source = result['items'].map(parseSource).find((item) => item.appId === 'browser-notes' && item.environment === 'test')
	if (source === undefined) throw new Error('Browser Notes source is unavailable')
	return source
}

function parseHealthCheck(value: unknown): HealthCheck {
	if (
		!isRecord(value) || typeof value['id'] !== 'string' || typeof value['path'] !== 'string' || typeof value['enabled'] !== 'boolean'
		|| typeof value['expectedStatus'] !== 'number' || typeof value['intervalMs'] !== 'number'
	) {
		throw new Error('Operations health check response is invalid')
	}
	return {
		id: value['id'],
		path: value['path'],
		enabled: value['enabled'],
		expectedStatus: value['expectedStatus'],
		intervalMs: value['intervalMs'],
	}
}

async function healthCheck(sourceId: string, path: string): Promise<HealthCheck | null> {
	const result = await operationsRpc('sourceHealth', { sourceId })
	if (!isRecord(result) || !Array.isArray(result['httpChecks'])) throw new Error('Operations source health response is invalid')
	const check = result['httpChecks'].map(parseHealthCheck).find((item) => item.path === path)
	return check ?? null
}

async function waitForHealthCheck(sourceId: string, path: string, enabled: boolean, expectedId?: string): Promise<HealthCheck> {
	let found: HealthCheck | null = null
	await expect.poll(async () => {
		found = await healthCheck(sourceId, path)
		return found === null
			? { present: false, enabled: null, sameId: false }
			: { present: true, enabled: found.enabled, sameId: expectedId === undefined || found.id === expectedId }
	}, { timeout: 10_000 }).toEqual({ present: true, enabled, sameId: true })
	if (found === null) throw new Error('Operations health check did not become available')
	return found
}

function healthCheckRow(path: string) {
	return byRole('row').filter({ has: getPage().getByText(path, { exact: true }) })
}

function sourceFact(label: string) {
	return getPage().locator('dt', { hasText: label }).filter({ hasText: new RegExp(`^${label}$`) }).locator('..').locator('dd')
}

function observeHealthMutationRequests(target: string[]): void {
	getPage().on('request', (request) => {
		const body = request.postData()
		if (body === null) return
		let value: unknown
		try {
			value = JSON.parse(body)
		} catch {
			return
		}
		if (!isRecord(value)) return
		const method = value['method']
		if (method === 'createHealthCheck' || method === 'updateHealthCheck' || method === 'deleteHealthCheck') target.push(request.url())
	})
}

async function expectLatestMutationUsesGateway(observed: readonly string[], expectedCount: number): Promise<void> {
	await expect.poll(() => observed.length).toBe(expectedCount)
	expect(observed.at(-1)).toBe(OPERATIONS_RPC_URL)
}

async function cleanupHealthCheck(sourceId: string, path: string, observedMutations: readonly string[]): Promise<void> {
	const existing = await healthCheck(sourceId, path)
	if (existing !== null) {
		await open(`${BASE_URL}/operations/sources/${sourceId}`)
		await expect(healthCheckRow(path)).toBeVisible()
		const mutationCount = observedMutations.length
		await byRole('button', `Delete health check ${path}`, { exact: true }).click()
		await expectLatestMutationUsesGateway(observedMutations, mutationCount + 1)
	}
	await expect.poll(async () => await healthCheck(sourceId, path)).toBeNull()
	if (getPage().url() === `${BASE_URL}/operations/sources/${sourceId}`) {
		await expect(healthCheckRow(path)).toHaveCount(0)
		await reload()
		await expect(healthCheckRow(path)).toHaveCount(0)
	}
}

browserTest(
	{
		name: 'A scoped operator manages an HTTP health check lifecycle',
		url: `${BASE_URL}/operations/sources`,
		feature: 'operations-adoption-health',
		seeds: ['operations-browser-fixtures'],
		roles: ['operations-notes'],
		tier: 'extended',
	},
	async () => {
		const source = await browserNotesSource()
		const uniquePath = `/opice-health-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
		const observedMutations: string[] = []
		let checkId: string | null = null
		observeHealthMutationRequests(observedMutations)

		try {
			await step('the operator adds a scenario-specific health check to Browser Notes', {
				intent: 'the scoped source exposes its managed public origin and accepts a uniquely identified health-check policy',
				manual:
					'Open "Browser Notes / test" from "Sources". Verify "/healthz", enter a test-specific path, and select "Add check". Verify the new check appears.',
			}, async () => {
				await expect(byRole('heading', 'Telemetry sources', { exact: true, level: 1 })).toBeVisible()
				await byRole('link', 'Browser Notes / test', { exact: true }).click()
				await expect(getPage()).toHaveURL(`${BASE_URL}/operations/sources/${source.id}`)
				await expect(byRole('heading', 'Browser Notes / test', { exact: true, level: 1 })).toBeVisible()
				await expect(sourceFact('Application')).toHaveText('browser-notes')
				await expect(sourceFact('Environment')).toHaveText('test')
				await expect(byRole('heading', 'HTTP health checks', { exact: true, level: 2 })).toBeVisible()
				await expect(healthCheckRow('/healthz')).toBeVisible()

				await byLabel('Path on the configured public origin').fill(uniquePath)
				await byRole('button', 'Add check', { exact: true }).click()
				await expectLatestMutationUsesGateway(observedMutations, 1)
				const created = await waitForHealthCheck(source.id, uniquePath, true)
				checkId = created.id
				const row = healthCheckRow(uniquePath)
				await expect(row).toBeVisible()
				await expect(row).toContainText('200 · 60s')
				await expect(row).not.toContainText('disabled')
			})

			await step('the operator disables the scenario health check', {
				intent: 'the supported health-check update changes enabled state without replacing the check identity',
				manual: 'Select "Disable" for the test-specific health check. Verify that its state changes to "disabled".',
			}, async () => {
				if (checkId === null) throw new Error('Scenario health check identity is unavailable')
				await byRole('button', `Disable health check ${uniquePath}`, { exact: true }).click()
				await expectLatestMutationUsesGateway(observedMutations, 2)
				await expect(healthCheckRow(uniquePath)).toContainText('disabled')
				await expect(byRole('button', `Enable health check ${uniquePath}`, { exact: true })).toBeVisible()
				await waitForHealthCheck(source.id, uniquePath, false, checkId)
			})

			await step('the disabled state survives reload', {
				intent: 'health-check changes persist in Operations storage',
				manual: 'Reload the source page. Verify that the test-specific health check is still disabled.',
			}, async () => {
				if (checkId === null) throw new Error('Scenario health check identity is unavailable')
				await reload()
				const row = healthCheckRow(uniquePath)
				await expect(row).toBeVisible()
				await expect(row).toContainText('disabled')
				await expect(row).toContainText('200 · 60s')
				await expect(byRole('button', `Enable health check ${uniquePath}`, { exact: true })).toBeVisible()
				const persisted = await waitForHealthCheck(source.id, uniquePath, false, checkId)
				expect(persisted.expectedStatus).toBe(200)
				expect(persisted.intervalMs).toBe(60_000)
			})

			await step('the operator enables the same health check again', {
				intent: 'the existing check can be updated back to active through the same lifecycle control',
				manual: 'Select "Enable" for the test-specific health check. Reload the page and verify that it is no longer disabled.',
			}, async () => {
				if (checkId === null) throw new Error('Scenario health check identity is unavailable')
				await byRole('button', `Enable health check ${uniquePath}`, { exact: true }).click()
				await expectLatestMutationUsesGateway(observedMutations, 3)
				await waitForHealthCheck(source.id, uniquePath, true, checkId)
				await reload()
				const row = healthCheckRow(uniquePath)
				await expect(row).toBeVisible()
				await expect(row).not.toContainText('disabled')
				await expect(row).toContainText('200 · 60s')
				await expect(byRole('button', `Disable health check ${uniquePath}`, { exact: true })).toBeVisible()
			})

			await step('the aggregate Health page includes only the permitted source', {
				intent: 'source health rolls up within the same IAM visibility boundary',
				manual: 'Open "Health" under Operations. Verify that "Browser Notes / test" appears.',
			}, async () => {
				await byRole('link', 'Health', { exact: true }).click()
				await expect(getPage()).toHaveURL(`${BASE_URL}/operations/health`)
				await expect(byRole('heading', 'Health and telemetry', { exact: true, level: 1 })).toBeVisible()
				const table = byRole('table', 'Operations health', { exact: true })
				await expect(table.getByRole('link', { name: 'Browser Notes / test', exact: true })).toBeVisible()
				await expect(table).not.toContainText('Hidden sibling / secret')
			})
		} finally {
			await cleanupHealthCheck(source.id, uniquePath, observedMutations)
			await invariant(
				'the scenario leaves the seeded /healthz check enabled for later independent runs',
				async () => {
					expect(await healthCheck(source.id, uniquePath)).toBeNull()
					const seeded = await healthCheck(source.id, '/healthz')
					if (seeded === null) throw new Error('Seeded health check is unavailable')
					expect(seeded.enabled).toBe(true)
				},
			)
		}
	},
)
