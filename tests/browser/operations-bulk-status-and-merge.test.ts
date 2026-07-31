import { browserTest, byLabel, byRole, expect, getPage, invariant, reload, step } from '@opice/harness'
import { randomUUID } from 'node:crypto'
import { scenarioMarker, sendErrorFixture } from './support/fixtures'

const BASE_URL = process.env['FABRIKA_BROWSER_BASE_URL'] ?? 'http://control.localhost:18080'
const SCENARIO = 'operations-bulk-status-and-merge'
const RUN_MARKER = `bulk-${randomUUID().slice(0, 8)}`
const FIXTURE_MARKER = scenarioMarker(SCENARIO)
const CANONICAL_LABEL = `Canonical ${RUN_MARKER}`
const COMPANION_LABEL = `Companion ${RUN_MARKER}`
const DUPLICATE_LABEL = `Duplicate ${RUN_MARKER}`
const CANONICAL_TITLE = `BrowserScenarioError: ${CANONICAL_LABEL} [${FIXTURE_MARKER}]`
const COMPANION_TITLE = `BrowserScenarioError: ${COMPANION_LABEL} [${FIXTURE_MARKER}]`
const DUPLICATE_TITLE = `BrowserScenarioError: ${DUPLICATE_LABEL} [${FIXTURE_MARKER}]`
const CANONICAL_FINGERPRINT = `${RUN_MARKER}-canonical`
const COMPANION_FINGERPRINT = `${RUN_MARKER}-companion`
const DUPLICATE_FINGERPRINT = `${RUN_MARKER}-duplicate`
const OPERATIONS_RPC_URL = `${BASE_URL}/operations/api/rpc`

interface IssueSnapshot {
	id: string
	status: string
	count: number
	mergedIntoIssueId: string | null
}

interface ObservedMutation {
	url: string
	method: 'bulkIssueStatus' | 'mutateIssue'
	kind: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function rpcResult(body: unknown): Record<string, unknown> {
	if (!isRecord(body) || body['error'] !== undefined || !isRecord(body['result'])) throw new Error('Operations RPC response is invalid')
	return body['result']
}

function observeMutations(target: ObservedMutation[]): void {
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
		if (method !== 'bulkIssueStatus' && method !== 'mutateIssue') return
		const input = value['input']
		const mutation = isRecord(input) ? input['mutation'] : undefined
		target.push({
			url: request.url(),
			method,
			kind: isRecord(mutation) && typeof mutation['kind'] === 'string' ? mutation['kind'] : null,
		})
	})
}

async function expectMutation(observed: readonly ObservedMutation[], method: ObservedMutation['method'], kind: string | null): Promise<void> {
	await expect.poll(() => observed.some((mutation) => mutation.method === method && mutation.kind === kind)).toBe(true)
	const matching = observed.filter((mutation) => mutation.method === method && mutation.kind === kind)
	for (const mutation of matching) expect(mutation.url).toBe(OPERATIONS_RPC_URL)
}

async function browserRpc(method: string, input: unknown): Promise<Record<string, unknown>> {
	const response = await getPage().evaluate(async ({ endpoint, method, input }) => {
		const result = await fetch(endpoint, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ method, input }),
		})
		const body: unknown = await result.json()
		return { status: result.status, body }
	}, {
		endpoint: `${BASE_URL}/operations/api/rpc`,
		method,
		input,
	})
	if (response.status !== 200) throw new Error(`Operations RPC ${method} failed with status ${response.status}`)
	return rpcResult(response.body)
}

function issueItems(result: Record<string, unknown>): unknown[] {
	const items = result['items']
	if (!Array.isArray(items)) throw new Error('Operations issue response is missing items')
	return items
}

function stringProperty(value: unknown, key: string): string {
	if (!isRecord(value) || typeof value[key] !== 'string' || value[key] === '') throw new Error(`Operations issue is missing ${key}`)
	return value[key]
}

function numberProperty(value: unknown, key: string): number {
	if (!isRecord(value) || typeof value[key] !== 'number') throw new Error(`Operations issue is missing ${key}`)
	return value[key]
}

function nullableStringProperty(value: unknown, key: string): string | null {
	if (!isRecord(value) || (value[key] !== null && typeof value[key] !== 'string')) throw new Error(`Operations issue has invalid ${key}`)
	return value[key]
}

function issueByTitle(items: unknown[], title: string): unknown {
	const issue = items.find((candidate) => isRecord(candidate) && candidate['title'] === title)
	if (issue === undefined) throw new Error(`Operations issue list omitted ${title}`)
	return issue
}

function listSnapshot(value: unknown): IssueSnapshot {
	return {
		id: stringProperty(value, 'id'),
		status: stringProperty(value, 'status'),
		count: numberProperty(value, 'count'),
		mergedIntoIssueId: null,
	}
}

function detailSnapshot(result: Record<string, unknown>): IssueSnapshot {
	const issue = result['issue']
	return {
		id: stringProperty(issue, 'id'),
		status: stringProperty(issue, 'status'),
		count: numberProperty(issue, 'count'),
		mergedIntoIssueId: nullableStringProperty(issue, 'mergedIntoIssueId'),
	}
}

function requireSnapshot(value: IssueSnapshot | null, label: string): IssueSnapshot {
	if (value === null) throw new Error(`${label} was not captured`)
	return value
}

browserTest(
	{
		name: 'A scoped operator changes multiple issues and merges a duplicate',
		url: `${BASE_URL}/operations/errors`,
		feature: 'operations-adoption-bulk-merge',
		seeds: ['operations-browser-fixtures'],
		roles: ['operations-notes'],
		tier: 'extended',
		setup: async () => {
			await Promise.all([
				sendErrorFixture({ scenario: SCENARIO, title: CANONICAL_LABEL, fingerprint: CANONICAL_FINGERPRINT }),
				sendErrorFixture({ scenario: SCENARIO, title: COMPANION_LABEL, fingerprint: COMPANION_FINGERPRINT }),
				sendErrorFixture({ scenario: SCENARIO, title: DUPLICATE_LABEL, fingerprint: DUPLICATE_FINGERPRINT }),
			])
		},
	},
	async () => {
		const observedMutations: ObservedMutation[] = []
		let canonicalBefore: IssueSnapshot | null = null
		let companionBefore: IssueSnapshot | null = null
		let duplicateBefore: IssueSnapshot | null = null
		let primaryBefore: IssueSnapshot | null = null
		observeMutations(observedMutations)

		await step('three scenario-specific issues are available in the open list', {
			intent: 'bulk and merge mutations operate on unique issues owned by this independent scenario',
			manual: 'Open "Errors" under Operations. Verify that the three errors created for this test appear.',
		}, async () => {
			await expect.poll(async () => {
				const items = issueItems(await browserRpc('issues', { query: RUN_MARKER, limit: 100 }))
				return [CANONICAL_TITLE, COMPANION_TITLE, DUPLICATE_TITLE].every((title) => items.some((issue) => isRecord(issue) && issue['title'] === title))
			}, { timeout: 15_000 }).toBe(true)
			await reload()
			await byLabel('Search').fill(RUN_MARKER)
			const table = byRole('table', 'Operations issues')
			await expect(table).toContainText(CANONICAL_TITLE)
			await expect(table).toContainText(COMPANION_TITLE)
			await expect(table).toContainText(DUPLICATE_TITLE)

			const scenarioIssues = issueItems(await browserRpc('issues', { query: RUN_MARKER, limit: 100 }))
			canonicalBefore = listSnapshot(issueByTitle(scenarioIssues, CANONICAL_TITLE))
			companionBefore = listSnapshot(issueByTitle(scenarioIssues, COMPANION_TITLE))
			duplicateBefore = listSnapshot(issueByTitle(scenarioIssues, DUPLICATE_TITLE))
			const primaryIssues = issueItems(await browserRpc('issues', { query: 'Browser fixture primary failure', limit: 100 }))
			const primary = issueByTitle(primaryIssues, 'BrowserFixtureError: Browser fixture primary failure')
			primaryBefore = detailSnapshot(await browserRpc('issue', { issueId: stringProperty(primary, 'id') }))
		})

		await step('the operator resolves two selected issues together', {
			intent: 'bulk status changes apply to exactly the selected permitted issues',
			manual: 'Select two of the test errors and select "Resolve" in the bulk toolbar. Verify that both errors become resolved.',
		}, async () => {
			await byRole('checkbox', `Select ${CANONICAL_TITLE}`, { exact: true }).check()
			await byRole('checkbox', `Select ${COMPANION_TITLE}`, { exact: true }).check()
			await getPage().locator('.ops-bulk').getByRole('button', { name: 'Resolve', exact: true }).click()
			await expectMutation(observedMutations, 'bulkIssueStatus', null)
			await byRole('combobox', 'Status', { exact: true }).selectOption('all')

			for (const title of [CANONICAL_TITLE, COMPANION_TITLE]) {
				const row = byRole('row').filter({ hasText: title })
				await expect(row.getByTestId('issue-status')).toHaveAttribute('data-status', 'resolved')
			}
			const duplicateRow = byRole('row').filter({ hasText: DUPLICATE_TITLE })
			await expect(duplicateRow.getByTestId('issue-status')).toHaveAttribute('data-status', 'open')
		})

		await step('the remaining duplicate is merged into a resolved target', {
			intent: 'operators can consolidate a duplicate into another issue using its opaque issue token',
			manual: 'Open the remaining test error. Enter the target issue token under "Merge into issue" and select "Merge".',
		}, async () => {
			const canonical = requireSnapshot(canonicalBefore, 'canonical issue')
			const canonicalHref = await byRole('link', CANONICAL_TITLE, { exact: true }).getAttribute('href')
			expect(canonicalHref).not.toBeNull()
			if (canonicalHref === null) throw new Error('canonical issue link has no href')
			expect(new URL(canonicalHref, BASE_URL).pathname.endsWith(`/${canonical.id}`)).toBe(true)

			await byRole('link', DUPLICATE_TITLE, { exact: true }).click()
			await byLabel('Merge into issue').fill(canonical.id)
			await byRole('button', 'Merge', { exact: true }).click()
			await expectMutation(observedMutations, 'mutateIssue', 'merge')
			await expect.poll(async () =>
				detailSnapshot(
					await browserRpc('issue', {
						issueId: requireSnapshot(duplicateBefore, 'duplicate issue').id,
					}),
				).mergedIntoIssueId
			).toBe(canonical.id)
			await expect(getPage().locator('[data-testid="activity-entry"][data-activity-kind="merged"]')).toContainText('Merged into')
		})

		await step('the merged result and bulk statuses persist after navigation', {
			intent: 'bulk and merge outcomes are repository state rather than transient component state',
			manual: 'Return to "Errors", select "All" status, and verify the resolved target remains while the merged duplicate is no longer separate.',
		}, async () => {
			await byRole('link', '← All errors', { exact: true }).click()
			await byRole('combobox', 'Status', { exact: true }).selectOption('all')
			await byLabel('Search').fill(RUN_MARKER)
			await reload()
			await byRole('combobox', 'Status', { exact: true }).selectOption('all')
			await byLabel('Search').fill(RUN_MARKER)

			const table = byRole('table', 'Operations issues')
			await expect(table).toContainText(CANONICAL_TITLE)
			await expect(table).toContainText(COMPANION_TITLE)
			await expect(table).not.toContainText(DUPLICATE_TITLE)

			const canonical = requireSnapshot(canonicalBefore, 'canonical issue')
			const companion = requireSnapshot(companionBefore, 'companion issue')
			const duplicate = requireSnapshot(duplicateBefore, 'duplicate issue')
			const persistedCanonical = detailSnapshot(await browserRpc('issue', { issueId: canonical.id }))
			const persistedCompanion = detailSnapshot(await browserRpc('issue', { issueId: companion.id }))
			const persistedDuplicate = detailSnapshot(await browserRpc('issue', { issueId: duplicate.id }))
			expect(persistedCanonical.status).toBe('resolved')
			expect(persistedCanonical.count).toBe(canonical.count)
			expect(persistedCompanion.status).toBe('resolved')
			expect(persistedCompanion.count).toBe(companion.count)
			expect(persistedDuplicate.mergedIntoIssueId).toBe(canonical.id)

			const listed = issueItems(await browserRpc('issues', { query: RUN_MARKER, limit: 100 }))
			expect(listed.some((issue) => isRecord(issue) && issue['id'] === duplicate.id)).toBe(false)
		})

		await invariant(
			'bulk status and merge mutations use the same-origin Operations gateway',
			async () => {
				await expectMutation(observedMutations, 'bulkIssueStatus', null)
				await expectMutation(observedMutations, 'mutateIssue', 'merge')
			},
		)

		await invariant(
			'no Browser Notes issue outside this scenario changes status or merge identity',
			async () => {
				const before = requireSnapshot(primaryBefore, 'seeded primary issue')
				const after = detailSnapshot(await browserRpc('issue', { issueId: before.id }))
				expect(after.status).toBe(before.status)
				expect(after.mergedIntoIssueId).toBe(before.mergedIntoIssueId)
			},
		)
	},
)
