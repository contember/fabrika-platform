import { browserTest, byLabel, byRole, el, expect, getContext, getPage, invariant, step } from '@opice/harness'
import { randomUUID } from 'node:crypto'
import type { Request } from 'playwright'
import { sendErrorFixture } from './support/fixtures'

const BASE_URL = process.env['FABRIKA_BROWSER_BASE_URL'] ?? 'http://control.localhost:18080'
const SCENARIO_NAME = 'A scoped operator records and persists issue triage'
const RUN_ID = randomUUID()
const ISSUE_TITLE = `Browser triage ${RUN_ID}`
const COMMENT_MARKER = `Browser triage comment ${RUN_ID}`

let fixture: Awaited<ReturnType<typeof sendErrorFixture>> | null = null
let browserPrincipal: { id: string; label: string } | null = null
const operationsPostUrls: string[] = []
const mutationKinds = new Set<string>()

function currentFixture(): Awaited<ReturnType<typeof sendErrorFixture>> {
	if (fixture === null) throw new Error('triage fixture was not created')
	return fixture
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function observeOperationsRequests(request: Request): void {
	if (request.method() !== 'POST') return
	const url = new URL(request.url())
	if (url.origin !== new URL(BASE_URL).origin || !url.pathname.startsWith('/operations/')) return
	operationsPostUrls.push(request.url())

	let body: unknown
	try {
		body = request.postDataJSON()
	} catch {
		return
	}
	if (!isRecord(body) || body['method'] !== 'mutateIssue' || !isRecord(body['input']) || !isRecord(body['input']['mutation'])) return
	const kind = body['input']['mutation']['kind']
	if (typeof kind === 'string') mutationKinds.add(kind)
}

async function currentBrowserPrincipal(): Promise<{ id: string; label: string }> {
	if (browserPrincipal !== null) return browserPrincipal

	await expect.poll(async () => (await getContext().cookies(BASE_URL)).some((cookie) => cookie.name === 'px_token')).toBe(true)
	const token = (await getContext().cookies(BASE_URL)).find((cookie) => cookie.name === 'px_token')?.value
	if (token === undefined) throw new Error('application token is missing')
	const payloadPart = token.split('.')[1]
	if (payloadPart === undefined) throw new Error('application token payload is missing')
	const payload: unknown = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'))
	if (!isRecord(payload) || typeof payload['sub'] !== 'string' || typeof payload['label'] !== 'string') {
		throw new Error('application token principal is invalid')
	}
	browserPrincipal = { id: payload['sub'], label: payload['label'] }
	return browserPrincipal
}

function assignedActivity(label: string) {
	return el('activity-entry').filter({ hasText: `Assigned to ${label}` })
}

function commentActivity() {
	return el('activity-entry').filter({ hasText: COMMENT_MARKER })
}

function snoozeActivity() {
	return getPage().locator('[data-testid="activity-entry"][data-activity-kind="snoozed"]')
}

browserTest(
	{
		name: SCENARIO_NAME,
		url: `${BASE_URL}/operations/errors`,
		feature: 'operations-adoption-triage',
		seeds: ['operations-browser-fixtures'],
		roles: ['operations-notes'],
		tier: 'standard',
		setup: async () => {
			fixture = await sendErrorFixture({ scenario: SCENARIO_NAME, title: ISSUE_TITLE, fingerprint: RUN_ID })
		},
	},
	async () => {
		await step('a scenario-specific open issue is available for triage', {
			intent: 'the scenario owns a uniquely marked issue and does not mutate another scenario or a previous run',
			manual: 'Open "Errors" under Operations. Verify that the error created for this test appears.',
		}, async () => {
			getPage().on('request', observeOperationsRequests)
			const created = currentFixture()
			const issueLink = byRole('link', ISSUE_TITLE)
			await expect.poll(async () => {
				await getPage().reload({ waitUntil: 'domcontentloaded' })
				await byLabel('Search').fill(ISSUE_TITLE)
				return issueLink.count()
			}, { timeout: 15_000 }).toBe(1)
			await expect(issueLink).toBeVisible()
			await issueLink.click()
			const heading = byRole('heading', ISSUE_TITLE, { level: 1 })
			await expect(heading).toContainText(`[${created.marker}]`)
			await expect(el('issue-status')).toHaveAttribute('data-status', 'open')
		})

		await step('the operator assigns the issue to the current browser principal', {
			intent: 'assignment uses a real IAM principal and persists through the Operations mutation contract',
			manual: 'In "Assignee", select the browser operator and select "Assign". Verify that the issue shows the selected assignee.',
		}, async () => {
			const principal = await currentBrowserPrincipal()
			await byLabel('Assignee').selectOption(principal.id)
			await expect(byLabel('Assignee')).toHaveValue(principal.id)
			await byRole('button', 'Assign', { exact: true }).click()
			await expect(byRole('definition').filter({ hasText: principal.label })).toBeVisible()
			await expect(assignedActivity(principal.label)).toBeVisible()

			await getPage().reload({ waitUntil: 'domcontentloaded' })
			await expect(byRole('definition').filter({ hasText: principal.label })).toBeVisible()
			await expect(assignedActivity(principal.label)).toBeVisible()
		})

		await step('the operator adds a uniquely marked comment', {
			intent: 'issue discussion is retained as attributed triage activity',
			manual: 'Enter a test comment in "Comment" and select "Add comment". Verify that the comment appears in Activity.',
		}, async () => {
			await byLabel('Comment').fill(COMMENT_MARKER)
			await byRole('button', 'Add comment', { exact: true }).click()
			await expect(commentActivity()).toBeVisible()

			await getPage().reload({ waitUntil: 'domcontentloaded' })
			await expect(commentActivity()).toBeVisible()
		})

		await step('the operator snoozes the issue for 24 hours', {
			intent: 'the supported time-based snooze is persisted and visible in issue activity',
			manual: 'Select "Snooze 24 h". Verify that Activity records the snooze.',
		}, async () => {
			const beforeSnooze = Date.now()
			await byRole('button', 'Snooze 24 h', { exact: true }).click()
			const activity = snoozeActivity()
			await expect(activity).toBeVisible()
			const payload = await activity.getByTestId('activity-payload').textContent()
			const until = payload?.replace('Snoozed until ', '')
			if (until === undefined) throw new Error('snooze activity timestamp is missing')
			expect(Date.parse(until)).toBeGreaterThan(beforeSnooze)

			await getPage().reload({ waitUntil: 'domcontentloaded' })
			await expect(snoozeActivity()).toBeVisible()
		})

		await step('the operator ignores the issue and the status survives reload', {
			intent: 'ignored status removes the issue from active triage without deleting its history',
			manual: 'Select "Ignore". Reload the page and verify that the issue status is "ignored".',
		}, async () => {
			await byRole('button', 'Ignore', { exact: true }).click()
			await expect(el('issue-status')).toHaveAttribute('data-status', 'ignored')

			await getPage().reload({ waitUntil: 'domcontentloaded' })
			await expect(el('issue-status')).toHaveAttribute('data-status', 'ignored')
			const principal = await currentBrowserPrincipal()
			await expect(assignedActivity(principal.label)).toBeVisible()
			await expect(commentActivity()).toBeVisible()
			await expect(snoozeActivity()).toBeVisible()
		})

		await invariant('all triage mutations use the same-origin Operations gateway', async () => {
			for (const kind of ['assign', 'comment', 'snooze_until', 'status']) expect(mutationKinds.has(kind)).toBe(true)
			expect(operationsPostUrls.length).toBeGreaterThan(0)
			for (const requestUrl of operationsPostUrls) {
				const url = new URL(requestUrl)
				expect(url.origin).toBe(new URL(BASE_URL).origin)
				expect(url.pathname).toBe('/operations/api/rpc')
			}
		})
	},
)
