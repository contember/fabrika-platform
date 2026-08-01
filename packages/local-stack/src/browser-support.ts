import { buildOperationsDsn, operationsEnvelopeUrl } from '@fabrika/operations-contract'
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { compose } from './compose'
import { prepareLocalStack, STATE_DIR } from './prepare'

const CONTROL_ORIGIN = 'http://control.fabrika.localhost:18080'
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

export type BrowserIdentityRole = 'admin' | 'operations-notes'

export interface BrowserIdentity {
	role: BrowserIdentityRole
	principalId: string
	label: string
	session: string
	expiresAt: number
}

interface BrowserFixtureSource {
	appId: string
	environment: string
	serviceKey: string
	displayName: string
	credentialId: string
	publicKey: string
	ingestProjectId: string
	release: { name: string; runId: string; uploadBearer: string }
}

interface BrowserFixtures {
	version: 1
	visible: BrowserFixtureSource
	hidden: BrowserFixtureSource
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringProperty(value: unknown, key: string): string {
	if (!isRecord(value) || typeof value[key] !== 'string' || value[key] === '') throw new Error(`browser fixture is missing ${key}`)
	return value[key]
}

function numberProperty(value: unknown, key: string): number {
	if (!isRecord(value) || typeof value[key] !== 'number') throw new Error(`browser fixture is missing ${key}`)
	return value[key]
}

function parseIdentity(value: unknown): BrowserIdentity {
	const role = stringProperty(value, 'role')
	if (role !== 'admin' && role !== 'operations-notes') throw new Error('browser identity has an invalid role')
	return {
		role,
		principalId: stringProperty(value, 'principalId'),
		label: stringProperty(value, 'label'),
		session: stringProperty(value, 'session'),
		expiresAt: numberProperty(value, 'expiresAt'),
	}
}

function parseFixtureSource(value: unknown): BrowserFixtureSource {
	if (!isRecord(value)) throw new Error('browser fixture source is invalid')
	const release = value['release']
	return {
		appId: stringProperty(value, 'appId'),
		environment: stringProperty(value, 'environment'),
		serviceKey: stringProperty(value, 'serviceKey'),
		displayName: stringProperty(value, 'displayName'),
		credentialId: stringProperty(value, 'credentialId'),
		publicKey: stringProperty(value, 'publicKey'),
		ingestProjectId: stringProperty(value, 'ingestProjectId'),
		release: {
			name: stringProperty(release, 'name'),
			runId: stringProperty(release, 'runId'),
			uploadBearer: stringProperty(release, 'uploadBearer'),
		},
	}
}

function readFixtures(): BrowserFixtures {
	const value: unknown = JSON.parse(readFileSync(FIXTURES_FILE, 'utf8'))
	if (!isRecord(value) || value['version'] !== 1) throw new Error('browser fixtures have an unsupported version')
	return { version: 1, visible: parseFixtureSource(value['visible']), hidden: parseFixtureSource(value['hidden']) }
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
		return parseIdentity(value)
	} finally {
		unlinkSync(output)
	}
}

export async function startBrowserStack(): Promise<void> {
	await prepareLocalStack()
	await compose(['up', '--detach', '--wait', '--remove-orphans'], { browser: true })
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
	await compose(['up', '--detach', '--wait', '--force-recreate', 'notes'], {
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
	const health = await operationsRpc(session, 'sourceHealth', { sourceId: id })
	const checks = isRecord(health) && Array.isArray(health['httpChecks']) ? health['httpChecks'] : []
	const existingCheck = checks.find((check) => isRecord(check) && check['path'] === healthInput.path)
	await operationsRpc(session, existingCheck === undefined ? 'createHealthCheck' : 'updateHealthCheck', {
		sourceId: id,
		...(existingCheck === undefined ? {} : { checkId: stringProperty(existingCheck, 'id') }),
		input: healthInput,
	})
	await operationsRpc(session, 'updateSpikeAlert', { sourceId: id, input: { threshold: 25, enabled: true } })
	await operationsRpc(session, 'updateAlertRule', { sourceId: id, kind: 'new_issue', input: { enabled: true } })
	const alerts = await operationsRpc(session, 'alerts', { sourceId: id })
	const channels = isRecord(alerts) && Array.isArray(alerts['channels']) ? alerts['channels'] : []
	const existingChannel = channels.find((channel) => isRecord(channel) && channel['targetDisplay'] === 'https://alerts.example.test/…')
	if (existingChannel === undefined) {
		await operationsRpc(session, 'createAlertChannel', {
			sourceId: id,
			input: { scope: 'new_issue', type: 'webhook', target: 'https://alerts.example.test/fabrika', enabled: false },
		})
	} else {
		await operationsRpc(session, 'updateAlertChannel', {
			sourceId: id,
			channelId: stringProperty(existingChannel, 'id'),
			input: { scope: 'new_issue', enabled: false },
		})
	}
}

async function sourceId(session: string, source: BrowserFixtureSource): Promise<string> {
	const result = await operationsRpc(session, 'sources', null)
	if (!isRecord(result) || !Array.isArray(result['items'])) throw new Error('Operations source list fixture response is invalid')
	const item = result['items'].find((candidate) =>
		isRecord(candidate) && candidate['appId'] === source.appId && candidate['environment'] === source.environment
	)
	return stringProperty(item, 'id')
}

async function operationsRpc(session: string, method: string, input: unknown): Promise<unknown> {
	const response = await fetch(`${CONTROL_ORIGIN}/operations/api/rpc`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			cookie: `px_session=${session}`,
			origin: CONTROL_ORIGIN,
		},
		body: JSON.stringify({ method, input }),
	})
	const value: unknown = await response.json()
	if (!response.ok || !isRecord(value) || value['error'] !== undefined) {
		throw new Error(`Operations RPC fixture ${method} failed with status ${response.status}`)
	}
	return value['result']
}
