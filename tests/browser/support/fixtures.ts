import { operationsEnvelopeUrl } from '@fabrika/operations-contract'
import { getPage } from '@opice/harness'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { BROWSER_PRINCIPAL_KEY } from '../browser-auth'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const FIXTURES_FILE = resolve(REPO_ROOT, 'packages', 'local-stack', '.state', 'browser-fixtures.json')
const OPERATIONS_ORIGIN = process.env['FABRIKA_BROWSER_OPERATIONS_ORIGIN'] ?? 'http://errors.fabrika.localhost:18080'

export type BrowserFixtureSourceName = 'visible' | 'hidden'

export interface BrowserFixtureSource {
	appId: string
	environment: string
	serviceKey: string
	displayName: string
	ingestProjectId: string
	publicKey: string
	release: { name: string; runId: string }
	nextRelease?: { name: string; runId: string }
}

export interface BrowserFixtures {
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

function source(value: unknown): BrowserFixtureSource {
	if (!isRecord(value)) throw new Error('browser fixture source is invalid')
	const nextRelease = value['nextRelease']
	return {
		appId: stringProperty(value, 'appId'),
		environment: stringProperty(value, 'environment'),
		serviceKey: stringProperty(value, 'serviceKey'),
		displayName: stringProperty(value, 'displayName'),
		ingestProjectId: stringProperty(value, 'ingestProjectId'),
		publicKey: stringProperty(value, 'publicKey'),
		release: { name: stringProperty(value['release'], 'name'), runId: stringProperty(value['release'], 'runId') },
		...(nextRelease === undefined
			? {}
			: { nextRelease: { name: stringProperty(nextRelease, 'name'), runId: stringProperty(nextRelease, 'runId') } }),
	}
}

export function readBrowserFixtures(): BrowserFixtures {
	const value: unknown = JSON.parse(readFileSync(FIXTURES_FILE, 'utf8'))
	if (!isRecord(value) || value['version'] !== 1) throw new Error('browser fixtures have an unsupported version')
	return { visible: source(value['visible']), hidden: source(value['hidden']) }
}

export interface BrowserPrincipal {
	id: string
	label: string
}

/**
 * Who the browser is signed in as.
 *
 * There is nothing on the wire to read this from: the browser holds an opaque session cookie, the proxy
 * mints the access token server-side and injects it as a request header, and the console publishes no
 * `me` surface a non-admin role is allowed to call. So the auth provider that created the principal
 * records it alongside the session it hands the context (`../browser-auth.ts`), and a scenario reads it
 * back here. It is fixture data about the fixture, not a credential.
 */
export async function readBrowserPrincipal(): Promise<BrowserPrincipal> {
	const raw = await getPage().evaluate((key: string) => window.localStorage.getItem(key), BROWSER_PRINCIPAL_KEY)
	if (raw === null) throw new Error('the browser session carries no principal — is the scenario running with a role?')
	const value: unknown = JSON.parse(raw)
	if (!isRecord(value) || typeof value['id'] !== 'string' || typeof value['label'] !== 'string') {
		throw new Error('the recorded browser principal is invalid')
	}
	return { id: value['id'], label: value['label'] }
}

/** Stable, selector-safe state key for one independently runnable scenario. */
export function scenarioMarker(name: string): string {
	const stem = name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-|-$/g, '').slice(0, 40) || 'scenario'
	return `${stem}-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`
}

export async function sendErrorFixture(input: {
	scenario: string
	source?: BrowserFixtureSourceName
	title: string
	fingerprint?: string
	release?: string
}): Promise<{ eventId: string; marker: string }> {
	const fixtures = readBrowserFixtures()
	const target = fixtures[input.source ?? 'visible']
	const marker = scenarioMarker(input.scenario)
	const eventId = randomUUID().replaceAll('-', '')
	const event = {
		event_id: eventId,
		level: 'error',
		platform: 'javascript',
		release: input.release ?? target.release.name,
		environment: target.environment,
		fingerprint: [input.fingerprint ?? marker],
		exception: { values: [{ type: 'BrowserScenarioError', value: `${input.title} [${marker}]` }] },
	}
	const envelope = `${JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: 'event' })}\n${
		JSON.stringify(event)
	}\n`
	const response = await fetch(operationsEnvelopeUrl(OPERATIONS_ORIGIN, target.ingestProjectId), {
		method: 'POST',
		headers: {
			'content-type': 'application/x-sentry-envelope',
			'x-sentry-auth': `Sentry sentry_key=${target.publicKey}, sentry_version=7`,
		},
		body: envelope,
	})
	if (response.status !== 202) throw new Error(`browser fixture ingest failed with status ${response.status}`)
	return { eventId, marker }
}
