import { SESSION_COOKIE } from '@fabrika/auth-core'
import { buildOperationsDsn, operationsEnvelopeUrl } from '@fabrika/operations-contract'
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import type { z } from 'zod'
import { type browserFixtureSourceSchema, type browserIdentitySchema, parseBrowserFixtures, parseBrowserIdentity } from './browser-fixture-schemas'
import { compose } from './compose'
import { seedNotesAgentChange } from './notes-agent-change'
import { STATE_DIR } from './prepare'
import {
	alertChannelFixtureSchema,
	alertsFixtureSchema,
	healthCheckFixtureSchema,
	healthFixtureSchema,
	idResponseSchema,
	itemsResponseSchema,
	rpcResponseSchema,
	sourceFixtureSchema,
} from './response-schemas'
import { upLocalComposition } from './up'

export {
	issueNotesKey,
	NOTES_AGENT_CHANGE_WORKSPACE,
	type NotesAgentChange,
	type NotesKey,
	readNotesAgentChange,
	waitForNotesDeploy,
} from './notes-agent-change'
export { followNotesDeploy } from './notes-follow'

const CONTROL_ORIGIN = 'http://control.fabrika.localhost:18080'
const IAM_ORIGIN = 'http://iam.fabrika.localhost:18080'
const OPERATIONS_ORIGIN = 'http://errors.fabrika.localhost:18080'
const FIXTURES_FILE = resolve(STATE_DIR, 'browser-fixtures.json')
const IDENTITIES_DIR = resolve(STATE_DIR, 'browser-identities')
const HOST_USER = hostUser()

function hostUser(): string {
	const getuid = process.getuid
	const getgid = process.getgid
	if (getuid === undefined || getgid === undefined) throw new Error('browser stack requires a POSIX host')
	return `${getuid()}:${getgid()}`
}

export type BrowserIdentity = z.infer<typeof browserIdentitySchema>
export type BrowserIdentityRole = BrowserIdentity['role']
type BrowserFixtureSource = z.infer<typeof browserFixtureSourceSchema>

function readFixtures() {
	const value: unknown = JSON.parse(readFileSync(FIXTURES_FILE, 'utf8'))
	return parseBrowserFixtures(value)
}

export async function createBrowserIdentity(role: BrowserIdentityRole): Promise<BrowserIdentity> {
	const outputId = randomUUID()
	const output = resolve(IDENTITIES_DIR, `${outputId}.json`)
	await compose(
		['exec', '-T', '--user', HOST_USER, 'iam', 'bun', 'packages/iam/src/node/browser-identity.ts', role, outputId],
		{ browser: true, showOutput: false },
	)
	try {
		const value: unknown = JSON.parse(readFileSync(output, 'utf8'))
		return parseBrowserIdentity(value)
	} finally {
		unlinkSync(output)
	}
}

export async function startBrowserStack(): Promise<void> {
	await upLocalComposition({ browser: true })
	await seedBrowserFixtures()
}

export async function resetBrowserStack(): Promise<void> {
	await compose(['down', '--volumes', '--remove-orphans'], { browser: true, showOutput: false })
	rmSync(STATE_DIR, { recursive: true, force: true })
	await startBrowserStack()
}

export async function stopBrowserStack(options: { volumes?: boolean } = {}): Promise<void> {
	await compose(['down', ...(options.volumes ? ['--volumes'] : []), '--remove-orphans'], { browser: true })
}

async function seedBrowserFixtures(): Promise<void> {
	await compose(
		['exec', '-T', '--user', HOST_USER, 'operations', 'bun', 'packages/local-stack/src/browser-fixture-seed.ts'],
		{ browser: true },
	)
	const fixtures = readFixtures()
	await compose(['up', '--detach', '--wait', '--force-recreate', 'operations-witness'], {
		browser: true,
		env: {
			FABRIKA_BROWSER_OPERATIONS_DSN: buildOperationsDsn(OPERATIONS_ORIGIN, fixtures.visible.publicKey, fixtures.visible.ingestProjectId),
			FABRIKA_BROWSER_RELEASE: fixtures.visible.release.name,
		},
	})
	await Promise.all([
		seedSourceEvents(fixtures.visible, 'Browser fixture primary failure', 2),
		seedSourceEvents(fixtures.visible, 'Browser fixture merge candidate', 1),
		seedSourceEvents(fixtures.hidden, 'Hidden browser fixture failure', 1),
	])
	await completeBrowserOperatorFixtures()
	await seedNotesAgentChange({ origin: IAM_ORIGIN, session: (await createBrowserIdentity('admin')).session })
}

export async function completeBrowserOperatorFixtures(): Promise<void> {
	const identity = await createBrowserIdentity('admin')
	await seedOperatorConfiguration(readFixtures().visible, identity.session)
	await compose(['exec', '-T', 'operations', 'bun', 'packages/operations/src/node/cron.ts'], { browser: true, showOutput: false })
}

async function seedSourceEvents(source: BrowserFixtureSource, marker: string, count: number): Promise<void> {
	for (let index = 0; index < count; index++) {
		const eventId = randomUUID().replaceAll('-', '')
		const event = {
			event_id: eventId,
			level: 'error',
			platform: 'javascript',
			release: source.release.name,
			environment: source.environment,
			fingerprint: [marker],
			exception: {
				values: [{
					type: 'BrowserFixtureError',
					value: marker,
					stacktrace: {
						frames: [{
							function: 'browserFixture',
							filename: 'http://control:3000/assets/browser.js',
							lineno: 1,
							colno: 1,
							in_app: true,
						}],
					},
				}],
			},
		}
		const envelope = `${JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: 'event' })}\n${
			JSON.stringify(event)
		}\n`
		const response = await fetch(operationsEnvelopeUrl(OPERATIONS_ORIGIN, source.ingestProjectId), {
			method: 'POST',
			headers: {
				'content-type': 'application/x-sentry-envelope',
				'x-sentry-auth': `Sentry sentry_key=${source.publicKey}, sentry_version=7`,
			},
			body: envelope,
		})
		if (response.status !== 202) throw new Error(`browser event fixture failed with status ${response.status}`)
	}
}

async function seedOperatorConfiguration(source: BrowserFixtureSource, session: string): Promise<void> {
	const id = await sourceId(session, source)
	const healthInput = {
		path: '/healthz',
		enabled: true,
		intervalMs: 60_000,
		timeoutMs: 2_000,
		expectedStatus: 200,
		failureThreshold: 2,
		recoveryThreshold: 1,
		staleAfterMs: 180_000,
	}
	const health = healthFixtureSchema.parse(await operationsRpc(session, 'sourceHealth', { sourceId: id }))
	const existingCheck = health.httpChecks.map((check) => healthCheckFixtureSchema.safeParse(check))
		.find((check) => check.success && check.data.path === healthInput.path)
	const check = existingCheck?.success ? existingCheck.data : undefined
	await operationsRpc(session, check === undefined ? 'createHealthCheck' : 'updateHealthCheck', {
		sourceId: id,
		...(check === undefined ? {} : { checkId: fixtureId(check) }),
		input: healthInput,
	})
	await operationsRpc(session, 'updateSpikeAlert', { sourceId: id, input: { threshold: 25, enabled: true } })
	await operationsRpc(session, 'updateAlertRule', { sourceId: id, kind: 'new_issue', input: { enabled: true } })
	const alerts = alertsFixtureSchema.parse(await operationsRpc(session, 'alerts', { sourceId: id }))
	const matchedChannel = alerts.channels.map((channel) => alertChannelFixtureSchema.safeParse(channel))
		.find((channel) => channel.success && channel.data.targetDisplay === 'https://alerts.example.test/…')
	const existingChannel = matchedChannel?.success ? matchedChannel.data : undefined
	if (existingChannel === undefined) {
		await operationsRpc(session, 'createAlertChannel', {
			sourceId: id,
			input: { scope: 'new_issue', type: 'webhook', target: 'https://alerts.example.test/fabrika', enabled: false },
		})
	} else {
		await operationsRpc(session, 'updateAlertChannel', {
			sourceId: id,
			channelId: fixtureId(existingChannel),
			input: { scope: 'new_issue', enabled: false },
		})
	}
}

async function sourceId(session: string, source: BrowserFixtureSource): Promise<string> {
	const result = await operationsRpc(session, 'sources', null)
	const parsed = itemsResponseSchema.safeParse(result)
	if (!parsed.success) throw new Error('Operations source list fixture response is invalid')
	const item = parsed.data.items.map((candidate) => sourceFixtureSchema.safeParse(candidate))
		.find((candidate) => candidate.success && candidate.data.appId === source.appId && candidate.data.environment === source.environment)
	return fixtureId(item?.success ? item.data : undefined)
}

function fixtureId(value: unknown): string {
	const parsed = idResponseSchema.safeParse(value)
	if (!parsed.success) throw new Error('browser fixture is missing id')
	return parsed.data.id
}

async function operationsRpc(session: string, method: string, input: unknown): Promise<unknown> {
	const response = await fetch(`${CONTROL_ORIGIN}/operations/api/rpc`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			cookie: `${SESSION_COOKIE}=${session}`,
			origin: CONTROL_ORIGIN,
		},
		body: JSON.stringify({ method, input }),
	})
	const value: unknown = await response.json()
	const parsed = rpcResponseSchema.safeParse(value)
	if (!response.ok || !parsed.success) {
		throw new Error(`Operations RPC fixture ${method} failed with status ${response.status}`)
	}
	return parsed.data.result
}
