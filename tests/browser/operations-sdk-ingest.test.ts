import { browserTest, byLabel, byRole, expect, getContext, getPage, invariant, step } from '@opice/harness'

const CONTROL_URL = process.env['FABRIKA_BROWSER_BASE_URL'] ?? 'http://control.localhost:18080'
const APP_URL = process.env['FABRIKA_BROWSER_APP_URL'] ?? 'http://notes.localhost:18081'
const WITNESS_URL = `${APP_URL}/operations-sdk`

interface ManagedConfig {
	dsn: string
	release: string
}

interface IssueSummary {
	id: string
	title: string
	count: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseManagedConfig(value: unknown): ManagedConfig {
	if (!isRecord(value) || typeof value['dsn'] !== 'string' || typeof value['release'] !== 'string') {
		throw new Error('Operations SDK configuration response is invalid')
	}
	return { dsn: value['dsn'], release: value['release'] }
}

function parseIssueSummaries(value: unknown): IssueSummary[] {
	if (!isRecord(value) || !Array.isArray(value['items'])) throw new Error('Operations issue list response is invalid')
	return value['items'].map((item) => {
		if (!isRecord(item) || typeof item['id'] !== 'string' || typeof item['title'] !== 'string' || typeof item['count'] !== 'number') {
			throw new Error('Operations issue summary is invalid')
		}
		return { id: item['id'], title: item['title'], count: item['count'] }
	})
}

async function operationsRpc(method: string, input: unknown): Promise<unknown> {
	const response = await getPage().evaluate(async ({ endpoint, method, input }) => {
		const result = await fetch(endpoint, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ method, input }),
		})
		const body: unknown = await result.json()
		return { status: result.status, body }
	}, { endpoint: `${CONTROL_URL}/operations/api/rpc`, method, input })
	if (response.status !== 200 || !isRecord(response.body) || response.body['error'] !== undefined || response.body['result'] === undefined) {
		throw new Error(`Operations RPC ${method} failed with status ${response.status}`)
	}
	return response.body['result']
}

function envelopeEndpoint(dsn: string): { origin: string; pathname: string } {
	const url = new URL(dsn)
	const projectId = url.pathname.split('/').filter(Boolean).at(-1)
	if (projectId === undefined) throw new Error('Operations SDK DSN is invalid')
	return { origin: url.origin, pathname: `/api/${projectId}/envelope/` }
}

function readLine(bytes: Uint8Array, offset: number): { text: string; next: number } {
	let end = offset
	while (end < bytes.length && bytes[end] !== 10) end++
	const contentEnd = end > offset && bytes[end - 1] === 13 ? end - 1 : end
	return {
		text: new TextDecoder().decode(bytes.subarray(offset, contentEnd)),
		next: end < bytes.length ? end + 1 : end,
	}
}

function parseEnvelopeItemTypes(bytes: Uint8Array): string[] {
	let offset = readLine(bytes, 0).next
	const itemTypes: string[] = []
	while (offset < bytes.length) {
		if (bytes[offset] === 10 || bytes[offset] === 13) {
			offset++
			continue
		}
		const itemLine = readLine(bytes, offset)
		offset = itemLine.next
		const itemHeader: unknown = JSON.parse(itemLine.text)
		if (!isRecord(itemHeader) || typeof itemHeader['type'] !== 'string') throw new Error('Sentry envelope item header is invalid')
		itemTypes.push(itemHeader['type'])

		const length = itemHeader['length']
		if (typeof length === 'number' && Number.isInteger(length) && length >= 0) {
			offset += length
			if (bytes[offset] === 13) offset++
			if (bytes[offset] === 10) offset++
		} else {
			offset = readLine(bytes, offset).next
		}
	}
	return itemTypes
}

async function captureManagedEnvelope(config: ManagedConfig): Promise<string[]> {
	const endpoint = envelopeEndpoint(config.dsn)
	const responsePromise = getPage().waitForResponse((response) => {
		if (response.request().method() !== 'POST') return false
		const url = new URL(response.url())
		return url.origin === endpoint.origin && url.pathname === endpoint.pathname
	})
	await byRole('button', 'Capture managed error', { exact: true }).click()
	const response = await responsePromise
	expect(response.status()).toBe(202)
	const body = response.request().postDataBuffer()
	if (body === null) throw new Error('Sentry envelope request has no body')
	return parseEnvelopeItemTypes(body)
}

async function matchingIssues(): Promise<IssueSummary[]> {
	const marker = requireMarker(runMarker)
	const title = issueTitle(marker)
	const result = await operationsRpc('issues', { query: marker, limit: 100 })
	return parseIssueSummaries(result).filter((issue) => issue.title === title)
}

async function waitForSingleIssue(expectedCount: number, expectedId?: string): Promise<string> {
	let foundId: string | null = null
	await expect.poll(async () => {
		const matches = await matchingIssues()
		if (matches.length !== 1) return { matches: matches.length, count: null, sameIssue: false }
		const issue = matches[0]
		if (issue === undefined) return { matches: 0, count: null, sameIssue: false }
		foundId = issue.id
		return { matches: 1, count: issue.count, sameIssue: expectedId === undefined || issue.id === expectedId }
	}, { timeout: 15_000 }).toEqual({ matches: 1, count: expectedCount, sameIssue: true })
	if (foundId === null) throw new Error('Operations issue did not become available')
	return foundId
}

function requireConfig(config: ManagedConfig | null): ManagedConfig {
	if (config === null) throw new Error('Operations SDK configuration was not captured')
	return config
}

function requireIssueId(issueId: string | null): string {
	if (issueId === null) throw new Error('Operations issue identity was not captured')
	return issueId
}

let runMarker: string | null = null

function requireMarker(value: string | null): string {
	if (value === null) throw new Error('Operations SDK event marker was not captured')
	return value
}

function issueTitle(marker: string): string {
	return `Error: Fabrika Operations SDK witness [${marker}]`
}

function issueFact(label: string) {
	return getPage().locator('dt', { hasText: label }).filter({ hasText: new RegExp(`^${label}$`) }).locator('..').locator('dd')
}

browserTest(
	{
		name: 'The official browser SDK creates one managed Operations issue',
		url: WITNESS_URL,
		feature: 'operations-adoption-sdk',
		seeds: ['operations-browser-fixtures'],
		roles: ['admin'],
		tier: 'critical',
	},
	async () => {
		let managedConfig: ManagedConfig | null = null
		let issueId: string | null = null
		const capturedItemTypes: string[][] = []
		const scenarioMarker = crypto.randomUUID()

		await step('the application exposes the bounded SDK witness without managed values in HTML', {
			intent: 'the browser receives only the public DSN and release through the application runtime boundary',
			manual: 'Open the Operations SDK witness. Verify that it is ready to capture a managed error.',
		}, async () => {
			await getPage().goto(`${WITNESS_URL}?marker=${encodeURIComponent(scenarioMarker)}`, { waitUntil: 'domcontentloaded' })
			await expect(byRole('heading', 'Operations SDK witness', { exact: true, level: 1 })).toBeVisible()
			await expect(byRole('status')).toHaveText('Ready')
			runMarker = await byLabel('Error marker').inputValue()
			expect(runMarker).toBe(scenarioMarker)

			const configResponse = await getContext().request.get(`${APP_URL}/operations-sdk/config`, { failOnStatusCode: false })
			expect(configResponse.status()).toBe(200)
			const configValue: unknown = await configResponse.json()
			managedConfig = parseManagedConfig(configValue)

			const documentResponse = await getContext().request.get(`${APP_URL}/operations-sdk`, { failOnStatusCode: false })
			expect(documentResponse.status()).toBe(200)
			const documentHtml = await documentResponse.text()
			const config = requireConfig(managedConfig)
			if (documentHtml.includes(config.dsn) || documentHtml.includes(config.release)) {
				throw new Error('Operations SDK witness HTML embeds managed configuration')
			}
		})

		await step('the official SDK sends the marked exception through the managed DSN', {
			intent: 'the tested @sentry/browser version reaches Fabrika ingest using its native envelope transport',
			manual: 'Select "Capture managed error". Verify that the page reports the event as sent.',
		}, async () => {
			capturedItemTypes.push(await captureManagedEnvelope(requireConfig(managedConfig)))
			expect(capturedItemTypes[0]).toEqual(['event'])
			await expect(byRole('status')).toHaveText(/^Sent [0-9a-f]{32}$/)
		})

		await step('the first event becomes one grouped issue with the managed release', {
			intent: 'asynchronous Operations processing retains the SDK exception and deploy release',
			manual: 'Open Operations Errors and find "Fabrika Operations SDK witness". Verify its release and occurrence count.',
		}, async () => {
			await getPage().goto(`${CONTROL_URL}/operations/errors`, { waitUntil: 'domcontentloaded' })
			await expect(byRole('heading', 'Errors', { exact: true, level: 1 })).toBeVisible()
			issueId = await waitForSingleIssue(1)
			await getPage().reload({ waitUntil: 'domcontentloaded' })
			await byLabel('Search').fill(requireMarker(runMarker))
			await byRole('link', issueTitle(requireMarker(runMarker)), { exact: true }).click()
			await expect(getPage()).toHaveURL(`${CONTROL_URL}/operations/errors/${requireIssueId(issueId)}`)
			await expect(byRole('heading', issueTitle(requireMarker(runMarker)), { exact: true, level: 1 })).toBeVisible()
			await expect(issueFact('Events')).toHaveText('1')
			await expect(issueFact('Release')).toHaveText(requireConfig(managedConfig).release)
		})

		await step('a second equivalent SDK exception increments the same issue', {
			intent: 'native SDK events use stable server-side grouping instead of creating duplicate issues',
			manual: 'Capture the managed error once more. Return to the same issue and verify that its occurrence count increased.',
		}, async () => {
			await getPage().goto(WITNESS_URL, { waitUntil: 'domcontentloaded' })
			await expect(byRole('status')).toHaveText('Ready')
			await expect(byLabel('Error marker')).toHaveValue(requireMarker(runMarker))
			capturedItemTypes.push(await captureManagedEnvelope(requireConfig(managedConfig)))
			expect(capturedItemTypes[1]).toEqual(['event'])
			await expect(byRole('status')).toHaveText(/^Sent [0-9a-f]{32}$/)

			const retainedIssueId = requireIssueId(issueId)
			await getPage().goto(`${CONTROL_URL}/operations/errors/${retainedIssueId}`, { waitUntil: 'domcontentloaded' })
			await waitForSingleIssue(2, retainedIssueId)
			await getPage().reload({ waitUntil: 'domcontentloaded' })
			await expect(byRole('heading', issueTitle(requireMarker(runMarker)), { exact: true, level: 1 })).toBeVisible()
			await expect(issueFact('Events')).toHaveText('2')
			await expect(issueFact('Release')).toHaveText(requireConfig(managedConfig).release)
		})

		await invariant(
			'the SDK witness sends only the documented Sentry compatibility profile',
			async () => {
				expect(capturedItemTypes).toEqual([['event'], ['event']])
			},
		)
	},
)
