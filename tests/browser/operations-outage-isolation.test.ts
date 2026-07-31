import { browserTest, byRole, expect, getPage, invariant, open, reload, step } from '@opice/harness'
import { compose } from '../../packages/local-stack/src/compose'

const BASE_URL = process.env['FABRIKA_BROWSER_BASE_URL'] ?? 'http://control.localhost:18080'

interface OperationsWitness {
	source: {
		id: string
		appId: string
		environment: string
		serviceKey: string
	}
	issue: {
		id: string
		title: string
		count: number
		status: string
	}
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

function stringProperty(value: unknown, key: string): string {
	if (!isRecord(value) || typeof value[key] !== 'string') throw new Error(`Operations witness is missing ${key}`)
	return value[key]
}

function numberProperty(value: unknown, key: string): number {
	if (!isRecord(value) || typeof value[key] !== 'number') throw new Error(`Operations witness is missing ${key}`)
	return value[key]
}

async function operationsWitness(): Promise<OperationsWitness> {
	const sources = await operationsRpc('sources', null)
	if (!isRecord(sources) || !Array.isArray(sources['items'])) throw new Error('Operations source list response is invalid')
	const source = sources['items'].find((item) => isRecord(item) && item['appId'] === 'browser-notes' && item['environment'] === 'test')
	if (source === undefined) throw new Error('Browser Notes source is unavailable')

	const issues = await operationsRpc('issues', { query: 'Browser fixture primary failure', limit: 100 })
	if (!isRecord(issues) || !Array.isArray(issues['items'])) throw new Error('Operations issue list response is invalid')
	const issue = issues['items'].find((item) => isRecord(item) && item['title'] === 'BrowserFixtureError: Browser fixture primary failure')
	if (issue === undefined) throw new Error('Browser fixture primary issue is unavailable')

	return {
		source: {
			id: stringProperty(source, 'id'),
			appId: stringProperty(source, 'appId'),
			environment: stringProperty(source, 'environment'),
			serviceKey: stringProperty(source, 'serviceKey'),
		},
		issue: {
			id: stringProperty(issue, 'id'),
			title: stringProperty(issue, 'title'),
			count: numberProperty(issue, 'count'),
			status: stringProperty(issue, 'status'),
		},
	}
}

function requireWitness(value: OperationsWitness | null): OperationsWitness {
	if (value === null) throw new Error('Pre-outage Operations witness is unavailable')
	return value
}

async function expectOperationsOverview(): Promise<void> {
	await expect(byRole('heading', 'Operations overview', { exact: true, level: 1 })).toBeVisible()
	const main = getPage().locator('main')
	await expect(main.getByRole('link', { name: /^Errors\b/ })).toBeVisible()
	await expect(main.getByRole('link', { name: /^Sources\b/ })).toBeVisible()
	await expect(main.getByRole('link', { name: /^Releases\b/ })).toBeVisible()
	await expect(main.getByRole('link', { name: /^Health\b/ })).toBeVisible()
}

async function stopOperations(): Promise<void> {
	await compose(['stop', '--timeout', '10', 'operations'], { browser: true, showOutput: false })
}

async function startOperationsAndWait(): Promise<void> {
	await compose(['up', '--detach', '--wait', '--no-deps', 'operations'], { browser: true, showOutput: false })
}

browserTest(
	{
		name: 'An Operations outage stays bounded to its console plane',
		url: `${BASE_URL}/operations`,
		feature: 'operations-adoption-outage',
		seeds: ['local-stack'],
		roles: ['admin'],
		tier: 'extended',
	},
	async () => {
		let before: OperationsWitness | null = null
		try {
			await step('the Operations overview is healthy before disruption', {
				intent: 'the outage witness starts from a known working Operations boundary',
				manual: 'Open the Operations overview. Verify that its summary cards load.',
			}, async () => {
				await expectOperationsOverview()
				before = await operationsWitness()
			})

			await step('stopping only Operations produces an explicit unavailable state', {
				intent: 'the control gateway and client surface a bounded Operations transport failure instead of hanging or crashing the shell',
				manual: 'Stop the Operations service and reload the page. Verify that "Operations is unavailable" appears.',
			}, async () => {
				await stopOperations()
				await reload()
				await expect(byRole('heading', 'Operations is unavailable', { exact: true, level: 1 })).toBeVisible({ timeout: 15_000 })
				await expect(byRole('button', 'Retry connection', { exact: true })).toBeVisible()
				await expect(byRole('navigation', 'Console navigation')).toBeVisible()
			})

			await step('Delivery remains usable during the Operations outage', {
				intent: 'Operations failure does not remove the Delivery plane or its control data',
				manual: 'Select "Applications" under Delivery. Verify that the Applications page still opens.',
			}, async () => {
				await byRole('link', 'Applications', { exact: true }).click()
				await expect(getPage()).toHaveURL(`${BASE_URL}/apps`)
				await expect(byRole('heading', 'Applications', { exact: true, level: 1 })).toBeVisible()
				await expect(byRole('navigation', 'Console navigation')).toBeVisible()
			})

			await step('Access remains usable during the Operations outage', {
				intent: 'Operations failure does not remove the Access plane or its IAM boundary',
				manual: 'Select "Overview" under Access. Verify that the Access overview still opens.',
			}, async () => {
				await byRole('link', 'Access overview', { exact: true }).click()
				await expect(getPage()).toHaveURL(`${BASE_URL}/access`)
				await expect(byRole('heading', 'Access overview', { exact: true, level: 1 })).toBeVisible()
				await expect(byRole('navigation', 'Console navigation')).toBeVisible()
			})

			await step('Operations recovers after its service restarts', {
				intent: 'restarting Operations restores the plane without resetting shared platform state',
				manual: 'Restart the Operations service and return to its overview. Verify that the summary cards load again.',
			}, async () => {
				await startOperationsAndWait()
				await open(`${BASE_URL}/operations`)
				await expectOperationsOverview()
				expect(await operationsWitness()).toEqual(requireWitness(before))
			})
		} finally {
			await startOperationsAndWait()
			await open(`${BASE_URL}/operations`)
			await invariant(
				'the Operations service is running when the scenario exits',
				async () => {
					await expectOperationsOverview()
					if (before !== null) expect(await operationsWitness()).toEqual(before)
				},
			)
		}
	},
)
