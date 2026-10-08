import type { AuthContext } from '@fabrika/auth'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { createHarness } from '../../../__tests__/helpers/harness'
import type { Env } from '../../../env'
import { Vault } from '../../../vault'
import { gitHubAppClientFactory } from '../../connections/credentials'
import { manifestCallback, startSourceConnection } from '../../connections/manifest'
import { createSourceConnections } from '../../connections/port'
import { createGitHubSource } from '..'
import { DESCRIPTOR, descriptor, descriptorSha256, file, handCommitSha, handPrefix, handTarball, repository, uploadUrl } from './fixtures'

const TOKEN = 'ghs_must_not_leak'
const CODELOAD = 'https://codeload.github.com/contember/fixture/legacy.tar.gz/aaaa?token=codeload-secret'
const PEM = '-----BEGIN PRIVATE KEY-----\nMAMCAQE=\n-----END PRIVATE KEY-----\n'
const MARKERS = ['-----BEGIN', 'PRIVATE KEY', 'ghs_', 'codeload', 'signature=private', 'MAMCAQE']
const ORIGIN = 'https://control.example'

const CONSOLE_METHODS: ReadonlyArray<'log' | 'info' | 'warn' | 'error' | 'debug'> = ['log', 'info', 'warn', 'error', 'debug']
const captured: string[] = []
const spies: Array<{ mockRestore(): void }> = []

beforeEach(() => {
	captured.splice(0)
	for (const method of CONSOLE_METHODS) {
		spies.push(
			spyOn(console, method).mockImplementation((...values: unknown[]) => {
				captured.push(values.map((value) => (value instanceof Error ? `${value.message} ${value.stack ?? ''}` : String(value))).join(' '))
			}),
		)
	}
})

afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore()
})

/** Everything an operator or a browser could see of a failure: its text, its fields, its stack. */
function exposure(error: unknown): string {
	if (!(error instanceof Error)) return String(error)
	return `${String(error)} ${JSON.stringify(error)} ${error.stack ?? ''}`
}

function expectNoCredential(texts: readonly string[]): void {
	expect([...texts, ...captured].flatMap((text) => MARKERS.filter((marker) => text.includes(marker)))).toEqual([])
}

const leakyError = (url: string): TypeError => new TypeError(`request to ${url} with Authorization: Bearer ${TOKEN} failed`)

function leakySource(failAt: 'metadata' | 'codeload' | 'put') {
	return createGitHubSource({
		credentials: { repositoryToken: async () => TOKEN },
		descriptor: DESCRIPTOR,
		isUploadDestination: (url) => url === uploadUrl,
		metadataFetch: async (input) => {
			if (failAt === 'metadata') throw leakyError(String(input))
			return Response.json({ sha: handCommitSha })
		},
		downloadFetch: async (url) => {
			if (url.startsWith('https://api.github.com/')) return new Response(null, { status: 302, headers: { location: CODELOAD } })
			if (failAt === 'codeload') throw leakyError(url)
			return new Response(Bun.gzipSync(handTarball([file(`${handPrefix}zerops.yaml`, descriptor)])))
		},
		uploadFetch: async (url) => {
			throw leakyError(String(url))
		},
	})
}

const privateBinding = { connectionId: 'connection-1', installationId: 42 }

describe('no credential reaches an error or a log', () => {
	test('resolve', async () => {
		const raised = await leakySource('metadata')
			.resolve({ repository, requestedRef: 'main', privateBinding, descriptorSha256, signal: new AbortController().signal })
			.then(() => undefined, (error: unknown) => error)
		expect(raised).toMatchObject({ code: 'internal', stage: 'resolve' })
		expectNoCredential([exposure(raised)])
	})

	test('upload, at the tarball and at the destination', async () => {
		const failures: ReadonlyArray<'codeload' | 'put'> = ['codeload', 'put']
		for (const failAt of failures) {
			const raised = await leakySource(failAt).upload({
				repository,
				commitSha: handCommitSha,
				descriptorSha256,
				archive: { kind: 'application', privateBinding },
				uploadUrl,
				signal: new AbortController().signal,
			}).then(() => undefined, (error: unknown) => error)
			expect(raised).toMatchObject({ stage: failAt === 'put' ? 'upload' : 'archive' })
			expectNoCredential([exposure(raised)])
		}
	})

	test('the manifest callback, when GitHub refuses the freshly stored key', async () => {
		const harness = createHarness(() => 1_000)
		let binary = ''
		for (let index = 0; index < 32; index++) binary += String.fromCharCode(index + 1)
		const env: Env = {
			DB: harness.d1,
			REPOSITORIES: harness.repositories,
			ASSETS: { fetch: () => Promise.resolve(new Response()) },
			RUN_LOGS: { put: () => Promise.resolve(), get: () => Promise.resolve(null), delete: () => Promise.resolve() },
			DEPLOY_QUEUE: { send: () => Promise.resolve() },
			WAIT_UNTIL: () => {},
			ENVIRONMENT: 'test',
			FABRIKA_CONTROL_DOMAIN: ORIGIN,
			FABRIKA_CONTROL_VAULT_KEY: btoa(binary),
		}
		const auth: AuthContext = {
			ok: true,
			principal: { id: 'user-1', type: 'user', label: 'user@example.test' },
			can: () => true,
			scopedTo: () => null,
			audit: () => Promise.resolve(),
		}
		const source = createSourceConnections({
			provider: 'zerops',
			vault: () => Vault.create(env.DB, btoa(binary)),
			// The real client: it signs with the stored key, and GitHub answers with an error page that echoes it.
			createClient: gitHubAppClientFactory(async () => new Response(`bad key ${PEM}`, { status: 500 })),
		})
		const randomBytes = (length: number): Uint8Array => new Uint8Array(length).fill(7)
		await startSourceConnection(
			{ env, source, auth, request: new Request(`${ORIGIN}/api/rpc`, { method: 'POST', headers: { origin: ORIGIN } }), now: () => 1_000, randomBytes },
			{ organization: 'acme', appName: 'fabrika-source', visibility: 'private', repositories: [] },
		)
		const state = btoa(String.fromCharCode(...randomBytes(32))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
		const response = await manifestCallback({
			env,
			source,
			auth,
			request: new Request(`${ORIGIN}/api/source/github/callback?code=one-time&state=${state}`),
			now: () => 1_000,
			randomBytes,
			exchangeManifest: async () => ({
				id: 123,
				slug: 'fabrika-source',
				htmlUrl: 'https://github.com/apps/fabrika-source',
				pem: PEM,
				webhookSecret: 'x',
			}),
		})
		expect(response.status).toBe(303)
		expect((await env.REPOSITORIES.githubConnections.getWorkflowAttempt())?.status).toBe('repair_required')
		const rows = await env.DB.prepare('SELECT * FROM github_source_setup_attempts').all<Record<string, unknown>>()
		const vaultRows = await env.DB.prepare('SELECT * FROM vault').all<Record<string, unknown>>()
		expectNoCredential([await response.text(), JSON.stringify(rows.results), JSON.stringify(vaultRows.results)])
	})
})
