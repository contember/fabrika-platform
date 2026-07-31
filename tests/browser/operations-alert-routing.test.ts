import { browserTest, byLabel, byRole, expect, getContext, getPage, invariant, step } from '@opice/harness'
import { randomUUID } from 'node:crypto'
import type { Response } from 'playwright'

const BASE_URL = process.env['FABRIKA_BROWSER_BASE_URL'] ?? 'http://control.localhost:18080'
const RUN_ID = randomUUID()
const WEBHOOK_URL = `https://${RUN_ID}.hooks.example.test/${randomUUID()}`
const WEBHOOK_DISPLAY = `https://${RUN_ID}.hooks.example.test/…`
const SCENARIO_THRESHOLD = 30 + Number.parseInt(RUN_ID.slice(0, 2), 16) % 60

interface SeededAlertState {
	spike: { threshold: number; enabled: boolean }
	regressionEnabled: boolean
}

let sourceId: string | null = null
let channelId: string | null = null
let seededState: SeededAlertState | null = null
const responseBodies: string[] = []
const pagePostUrls: string[] = []

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringProperty(value: unknown, key: string): string {
	if (!isRecord(value) || typeof value[key] !== 'string' || value[key] === '') throw new Error(`alert response is missing ${key}`)
	return value[key]
}

function booleanProperty(value: unknown, key: string): boolean {
	if (!isRecord(value) || typeof value[key] !== 'boolean') throw new Error(`alert response is missing ${key}`)
	return value[key]
}

function numberProperty(value: unknown, key: string): number {
	if (!isRecord(value) || typeof value[key] !== 'number') throw new Error(`alert response is missing ${key}`)
	return value[key]
}

async function browserRpc(method: string, input: unknown): Promise<Record<string, unknown>> {
	const response = await getContext().request.post(`${BASE_URL}/operations/api/rpc`, {
		data: { method, input },
		headers: { origin: BASE_URL },
		failOnStatusCode: false,
	})
	const body: unknown = await response.json()
	if (response.status() !== 200 || !isRecord(body) || body['error'] !== undefined || !isRecord(body['result'])) {
		throw new Error(`${method} failed with status ${response.status()}`)
	}
	return body['result']
}

function observeResponse(response: Response): void {
	if (response.request().method() !== 'POST') return
	const url = new URL(response.url())
	if (url.origin !== new URL(BASE_URL).origin || !url.pathname.startsWith('/operations/')) return
	pagePostUrls.push(response.url())
	void response.text().then((body) => responseBodies.push(body), () => undefined)
}

function currentSourceId(): string {
	if (sourceId === null) throw new Error('visible source id is missing')
	return sourceId
}

function currentSeededState(): SeededAlertState {
	if (seededState === null) throw new Error('seeded alert state is missing')
	return seededState
}

function regressionEnabled(settings: Record<string, unknown>): boolean {
	const rules = settings['rules']
	if (!Array.isArray(rules)) throw new Error('alert response is missing rules')
	const rule = rules.find((candidate) => isRecord(candidate) && candidate['kind'] === 'regression')
	return rule === undefined ? false : booleanProperty(rule, 'enabled')
}

async function alertSettings(): Promise<Record<string, unknown>> {
	return browserRpc('alerts', { sourceId: currentSourceId() })
}

function spikeState(settings: Record<string, unknown>): { threshold: number; enabled: boolean } {
	const spike = settings['spike']
	if (!isRecord(spike)) throw new Error('alert response is missing spike settings')
	return { threshold: numberProperty(spike, 'threshold'), enabled: booleanProperty(spike, 'enabled') }
}

function channelRow() {
	return byRole('table', 'Webhook channels for Browser Notes / test').getByRole('row').filter({ hasText: WEBHOOK_DISPLAY })
}

async function readScenarioChannel(): Promise<{ id: string; enabled: boolean } | null> {
	const channels = (await alertSettings())['channels']
	if (!Array.isArray(channels)) throw new Error('alert response is missing channels')
	const channel = channels.find((candidate) => isRecord(candidate) && candidate['targetDisplay'] === WEBHOOK_DISPLAY)
	if (channel === undefined) return null
	return { id: stringProperty(channel, 'id'), enabled: booleanProperty(channel, 'enabled') }
}

async function cleanupAlerts(): Promise<void> {
	if (sourceId === null || seededState === null) return
	const id = channelId
	if (id !== null) {
		await getContext().request.post(`${BASE_URL}/operations/api/rpc`, {
			data: { method: 'deleteAlertChannel', input: { sourceId, channelId: id } },
			headers: { origin: BASE_URL },
			failOnStatusCode: false,
		}).catch(() => undefined)
		channelId = null
	}
	await Promise.all([
		browserRpc('updateSpikeAlert', { sourceId, input: seededState.spike }).catch(() => undefined),
		browserRpc('updateAlertRule', { sourceId, kind: 'regression', input: { enabled: seededState.regressionEnabled } }).catch(() => undefined),
	])
}

browserTest(
	{
		name: 'A scoped operator manages alert rules and a redacted webhook',
		url: `${BASE_URL}/operations/sources`,
		feature: 'operations-adoption-alert-routing',
		seeds: ['operations-browser-fixtures'],
		roles: ['operations-notes'],
		tier: 'extended',
	},
	async () => {
		try {
			await step('the Browser Notes alert page shows seeded spike and issue settings', {
				intent: 'alert routing starts from the source-owned settings projected for the permitted application environment',
				manual: 'Open "Browser Notes / test" and select "Alert routing". Verify that spike detection and event rules appear.',
			}, async () => {
				getPage().on('response', observeResponse)
				await byRole('link', 'Browser Notes / test', { exact: true }).click()
				await byRole('link', 'Alert routing', { exact: true }).click()
				const match = new URL(getPage().url()).pathname.match(/^\/operations\/sources\/([^/]+)\/alerts$/)
				if (match?.[1] === undefined) throw new Error('alert route omitted the source id')
				sourceId = match[1]
				const settings = await alertSettings()
				seededState = { spike: spikeState(settings), regressionEnabled: regressionEnabled(settings) }
				await expect(byLabel('Events in the evaluation window')).toHaveValue('25')
				await expect(byRole('button', 'Disable New Issue alerts', { exact: true })).toBeVisible()
				const seededWebhook = byRole('table', 'Webhook channels for Browser Notes / test').getByRole('row').filter({
					hasText: 'https://alerts.example.test/…',
				})
				await expect(seededWebhook).toContainText('disabled')
			})

			await step('the operator changes and disables spike detection', {
				intent: 'spike threshold and enabled state are mutable and persisted independently from ingest',
				manual:
					'Change "Events in the evaluation window", select "Save and enable", then select "Disable". Reload and verify the saved threshold remains.',
			}, async () => {
				const threshold = String(SCENARIO_THRESHOLD)
				await byLabel('Events in the evaluation window').fill(threshold)
				await byRole('button', 'Save and enable', { exact: true }).click()
				await expect.poll(async () => spikeState(await alertSettings())).toEqual({ threshold: SCENARIO_THRESHOLD, enabled: true })
				await byRole('button', 'Disable', { exact: true }).click()
				await expect.poll(async () => spikeState(await alertSettings())).toEqual({ threshold: SCENARIO_THRESHOLD, enabled: false })
				await getPage().reload({ waitUntil: 'domcontentloaded' })
				await expect(byLabel('Events in the evaluation window')).toHaveValue(threshold)
				expect(spikeState(await alertSettings())).toEqual({ threshold: SCENARIO_THRESHOLD, enabled: false })
			})

			await step('the operator toggles the regression rule', {
				intent: 'event-rule enablement persists per alert kind',
				manual: 'Toggle "Regression" alerts. Reload the page and verify that the new state remains.',
			}, async () => {
				const initial = currentSeededState().regressionEnabled
				const action = initial ? 'Disable Regression alerts' : 'Enable Regression alerts'
				const oppositeAction = initial ? 'Enable Regression alerts' : 'Disable Regression alerts'
				await byRole('button', action, { exact: true }).click()
				await expect.poll(async () => regressionEnabled(await alertSettings())).toBe(!initial)
				await getPage().reload({ waitUntil: 'domcontentloaded' })
				await expect(byRole('button', oppositeAction, { exact: true })).toBeVisible()
				expect(regressionEnabled(await alertSettings())).toBe(!initial)
			})

			await step('the operator creates a uniquely marked webhook channel', {
				intent: 'a permitted operator can add a source-scoped webhook destination for one alert kind',
				manual: 'Choose an alert scope, enter the test webhook URL, and select "Add channel". Verify that a new webhook row appears.',
			}, async () => {
				await byLabel('Alert scope').selectOption('regression')
				await byLabel('Webhook URL').fill(WEBHOOK_URL)
				await byRole('button', 'Add channel', { exact: true }).click()
				await expect(channelRow()).toContainText(WEBHOOK_DISPLAY)
				await expect(byLabel('Webhook URL')).toHaveValue('')
				await expect(getPage().locator('body')).not.toContainText(WEBHOOK_URL)
				await expect.poll(async () => (await readScenarioChannel()) !== null).toBe(true)
				const channel = await readScenarioChannel()
				if (channel === null) throw new Error('created webhook is missing from redacted read-back')
				channelId = channel.id
				expect(channel.enabled).toBe(true)
				expect(JSON.stringify(await alertSettings())).not.toContain(WEBHOOK_URL)
			})

			await step('the stored webhook remains redacted through enable and disable', {
				intent: 'read-back never exposes the complete write-only webhook destination while lifecycle controls remain usable',
				manual: 'Disable the new webhook, reload, and enable it again. Verify that the destination stays redacted.',
			}, async () => {
				await byRole('button', `Disable Regression webhook ${WEBHOOK_DISPLAY}`, { exact: true }).click()
				await expect.poll(async () => (await readScenarioChannel())?.enabled).toBe(false)
				await getPage().reload({ waitUntil: 'domcontentloaded' })
				await expect(channelRow()).toContainText('disabled')
				await expect(getPage().locator('body')).not.toContainText(WEBHOOK_URL)
				await byRole('button', `Enable Regression webhook ${WEBHOOK_DISPLAY}`, { exact: true }).click()
				await expect.poll(async () => (await readScenarioChannel())?.enabled).toBe(true)
				await getPage().reload({ waitUntil: 'domcontentloaded' })
				await expect(channelRow()).toContainText('enabled')
				await expect(channelRow()).toContainText(WEBHOOK_DISPLAY)
				await expect(getPage().locator('body')).not.toContainText(WEBHOOK_URL)
			})

			await step('the operator deletes the scenario webhook and restores seeded settings', {
				intent: 'alert configuration cleanup leaves shared fixtures deterministic for another independent run',
				manual: 'Delete the test webhook. Restore spike detection and the Regression rule to their original states.',
			}, async () => {
				try {
					const id = channelId
					if (id === null) throw new Error('scenario webhook id is missing')
				} finally {
					await cleanupAlerts()
				}
				await getPage().reload({ waitUntil: 'domcontentloaded' })
				await expect(channelRow()).toHaveCount(0)
				const seeded = currentSeededState()
				await expect(byLabel('Events in the evaluation window')).toHaveValue(String(seeded.spike.threshold))
				const restoredRuleAction = seeded.regressionEnabled ? 'Disable Regression alerts' : 'Enable Regression alerts'
				await expect(byRole('button', restoredRuleAction, { exact: true })).toBeVisible()
			})

			await invariant('no complete webhook destination is returned or rendered after creation', async () => {
				await expect(getPage().locator('body')).not.toContainText(WEBHOOK_URL)
				for (const body of responseBodies) expect(body).not.toContain(WEBHOOK_URL)
				expect(pagePostUrls.length).toBeGreaterThan(0)
				for (const requestUrl of pagePostUrls) {
					const url = new URL(requestUrl)
					expect(url.origin).toBe(new URL(BASE_URL).origin)
					expect(url.pathname).toBe('/operations/api/rpc')
				}
			})
		} finally {
			await cleanupAlerts()
		}
	},
)
