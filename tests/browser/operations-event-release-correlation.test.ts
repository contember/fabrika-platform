import { browserTest, byLabel, byRole, el, expect, getPage, invariant, step } from '@opice/harness'
import { randomUUID } from 'node:crypto'
import { type BrowserFixtures, readBrowserFixtures, sendErrorFixture } from './support/fixtures'

const BASE_URL = process.env['FABRIKA_BROWSER_BASE_URL'] ?? 'http://control.fabrika.localhost:18080'
const SCENARIO_NAME = 'An operator correlates event context with its release'
const PRIMARY_FAILURE = 'BrowserFixtureError: Browser fixture primary failure'
const RUN_ID = randomUUID()
const REGRESSION_TITLE = `Browser release regression ${RUN_ID}`
const OPERATIONS_RPC_URL = `${BASE_URL}/operations/api/rpc`

interface ScenarioFixtures {
	fixtures: BrowserFixtures
	marker: string
	nextRelease: { name: string; runId: string }
}

let scenarioFixtures: ScenarioFixtures | null = null
let regressionIssueUrl: string | null = null
const visibleEvidence: string[] = []
const resolveInReleaseRequests: string[] = []

function currentFixtures(): ScenarioFixtures {
	if (scenarioFixtures === null) throw new Error('correlation fixtures were not created')
	return scenarioFixtures
}

async function captureVisibleEvidence(): Promise<void> {
	visibleEvidence.push(await getPage().locator('main').innerText())
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function observeResolveInReleaseRequests(): void {
	getPage().on('request', (request) => {
		const body = request.postData()
		if (body === null) return
		let value: unknown
		try {
			value = JSON.parse(body)
		} catch {
			return
		}
		if (!isRecord(value) || value['method'] !== 'mutateIssue') return
		const input = value['input']
		const mutation = isRecord(input) ? input['mutation'] : undefined
		if (isRecord(mutation) && mutation['kind'] === 'resolve_in_release') resolveInReleaseRequests.push(request.url())
	})
}

async function expectResolveInReleaseUsesGateway(): Promise<void> {
	await expect.poll(() => resolveInReleaseRequests.length).toBeGreaterThan(0)
	for (const url of resolveInReleaseRequests) expect(url).toBe(OPERATIONS_RPC_URL)
}

browserTest(
	{
		name: SCENARIO_NAME,
		url: `${BASE_URL}/operations/errors`,
		feature: 'operations-adoption-correlation',
		seeds: ['operations-browser-fixtures'],
		roles: ['operations-notes'],
		tier: 'standard',
		setup: async () => {
			const fixtures = readBrowserFixtures()
			const nextRelease = fixtures.visible.nextRelease
			if (nextRelease === undefined) throw new Error('browser fixtures are missing the next visible release')
			const created = await sendErrorFixture({
				scenario: `${SCENARIO_NAME} regression`,
				title: REGRESSION_TITLE,
				fingerprint: RUN_ID,
				release: fixtures.visible.release.name,
			})
			scenarioFixtures = { fixtures, marker: created.marker, nextRelease }
		},
	},
	async () => {
		observeResolveInReleaseRequests()

		await step('the seeded primary failure detail retains its latest occurrence', {
			intent: 'a grouped issue leads to the concrete event context retained by Operations',
			manual: 'Open "Browser fixture primary failure". Verify that "Latest occurrence" shows the exception and event context.',
		}, async () => {
			await byLabel('Search').fill('Browser fixture primary failure')
			await byRole('link', PRIMARY_FAILURE, { exact: true }).click()
			await expect(byRole('heading', PRIMARY_FAILURE, { exact: true, level: 1 })).toBeVisible()
			await expect(byRole('heading', 'Latest occurrence', { exact: true, level: 2 })).toBeVisible()
			await expect(byRole('heading', PRIMARY_FAILURE, { exact: true, level: 3 })).toBeVisible()
			const eventId = getPage().locator('dt').filter({ hasText: /^Event ID$/ })
			await expect(eventId).toBeVisible()
			await expect(eventId.locator('xpath=following-sibling::dd[1]')).toHaveText(/^[0-9a-f]{32}$/)
			const rawEvent = getPage().locator('details').filter({ has: getPage().locator('summary').filter({ hasText: /^Raw event$/ }) })
			await expect(rawEvent).toBeVisible()
		})

		await step('the displayed stack frame is resolved to browser fixture source', {
			intent: 'the uploaded source map makes the retained browser stack frame readable',
			manual: 'Inspect the stack frame. Verify that it points to "src/browser-fixture.ts" and shows source text.',
		}, async () => {
			const frame = el('stack-frame').first()
			await expect(frame).toHaveAttribute('data-frame-in-app', 'true')
			await expect(frame).toHaveAttribute('data-frame-resolved', 'true')
			await expect(frame.getByTestId('frame-location')).toContainText('src/browser-fixture.ts:1:1')
			await expect(frame.getByTestId('frame-source')).toContainText("throw new Error('Browser fixture primary failure')")
		})

		await step('the issue identifies the projected release', {
			intent: 'operators can connect an occurrence to the release projected from Delivery',
			manual: 'Find "Release" in the issue facts. Verify that it shows the Browser Notes test release.',
		}, async () => {
			const release = currentFixtures().fixtures.visible.release.name
			await expect(byRole('definition').filter({ hasText: release })).toBeVisible()
		})

		await step('the release detail links back to its correlated new issue', {
			intent: 'release correlation exposes the seeded failure as a new issue for that release',
			manual: 'Open "Releases", select the Browser Notes release, and verify that "Browser fixture primary failure" appears under "Correlated issues".',
		}, async () => {
			const release = currentFixtures().fixtures.visible.release.name
			await byRole('link', 'Releases', { exact: true }).click()
			await byLabel('Source').selectOption({ label: 'Browser Notes / test' })
			const releaseLink = byRole('link', release, { exact: true })
			await expect(releaseLink).toBeVisible()
			await releaseLink.click()
			await expect(byRole('heading', release, { exact: true, level: 1 })).toBeVisible()
			await expect(byRole('table', 'Release correlated issues')).toContainText(PRIMARY_FAILURE)
			await captureVisibleEvidence()
		})

		await step('a post-resolution occurrence is shown as a regression for the same release context', {
			intent: 'a new occurrence reopens a resolved issue and records regression correlation instead of losing its history',
			manual: 'Resolve the test issue, send the same error again, and verify that the issue reopens as "regressed".',
		}, async () => {
			const state = currentFixtures()
			await byRole('link', 'Errors', { exact: true }).click()
			await byLabel('Search').fill(REGRESSION_TITLE)
			await byRole('link', REGRESSION_TITLE).click()
			regressionIssueUrl = getPage().url()
			await expect(byRole('heading', REGRESSION_TITLE, { level: 1 })).toContainText(`[${state.marker}]`)
			await expect(el('issue-status')).toHaveAttribute('data-status', 'open')

			const releaseSelect = byLabel('Resolve in release')
			await releaseSelect.selectOption({ label: state.fixtures.visible.release.name })
			await byRole('button', 'Apply', { exact: true }).click()
			await expectResolveInReleaseUsesGateway()
			await expect(el('issue-status')).toHaveAttribute('data-status', 'resolved')
			await getPage().reload({ waitUntil: 'domcontentloaded' })
			await expect(el('issue-status')).toHaveAttribute('data-status', 'resolved')
			await expect(byRole('link', state.fixtures.visible.release.name, { exact: true })).toBeVisible()

			await sendErrorFixture({
				scenario: `${SCENARIO_NAME} regression`,
				title: REGRESSION_TITLE,
				fingerprint: RUN_ID,
				release: state.nextRelease.name,
			})
			await expect.poll(async () => {
				await getPage().reload({ waitUntil: 'domcontentloaded' })
				return (await el('issue-status').textContent())?.trim()
			}).toBe('regressed')
			expect(getPage().url()).toBe(regressionIssueUrl)
			await expect(el('issue-status')).toHaveAttribute('data-status', 'open')
			await expect(byRole('definition').filter({ hasText: state.nextRelease.name })).toBeVisible()
			await captureVisibleEvidence()

			await byRole('link', 'Releases', { exact: true }).click()
			const nextReleaseLink = byRole('link', state.nextRelease.name, { exact: true })
			await expect(nextReleaseLink).toBeVisible()
			await nextReleaseLink.click()
			const correlationTable = byRole('table', 'Release correlated issues')
			await expect(correlationTable).toContainText(REGRESSION_TITLE)
			await expect(correlationTable).toContainText('open')
			await captureVisibleEvidence()
		})

		await invariant('new-issue and regression correlation stay attached to the visible Browser Notes release only', async () => {
			const hidden = currentFixtures().fixtures.hidden
			const evidence = visibleEvidence.join('\n')
			for (const protectedValue of [hidden.displayName, hidden.appId, hidden.environment, hidden.release.name, hidden.nextRelease?.name]) {
				if (protectedValue !== undefined) expect(evidence).not.toContain(protectedValue)
			}
		})

		await invariant('resolve-in-release uses the same-origin Operations gateway', expectResolveInReleaseUsesGateway)
	},
)
