// What a failed namespace tells an operator (backlog 72). Three live failures — a denied project
// import, a refused service-variable write and a subdomain the platform would not publish — used to
// land on the row as one identical `namespace provision failed`, and the cause was not logged either,
// so each took a hand-written reproduction against the live account to identify.
//
// What is proven here: the three arrive distinguishable, the provider's own words survive REDACTED
// rather than deleted, and a credential-shaped value injected into a provider error reaches neither
// the row nor the log.

import type { ControlProvider, ProviderDeploymentNamespace, ProviderEnvelope } from '@fabrika/provider-contract'
import { ProviderNamespaceError } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { decodeNamespaceError, encodeNamespaceError, redactNamespaceErrorText, runNamespaceJob } from '../api/namespaces'
import type { ControlRepositories, DeploymentNamespaceRow } from '../db'
import { createHarness } from './helpers/harness'
import { makeFakeLock } from './helpers/lock'

const target = (phase: string): ProviderEnvelope => ({ provider: 'harbor', version: 1, payload: { phase } })

/** A provider that hands core a checkpoint for DIFFERENT coordinates — core's own invariant, not its. */
const checkpointBreakingProvider = (): ControlProvider => ({
	id: 'harbor',
	normalizeRegistration: (input) => input,
	deploy: () => Promise.resolve({ state: 'succeeded' }),
	namespaces: {
		normalize: (namespace: ProviderDeploymentNamespace) => namespace,
		namespaceResourceClaims: () => ['service:proxy'],
		registrationResourceClaims: () => [],
		provision: (input) => input.events.checkpoint({ ...input.namespace, id: 'somewhere-else' }).then(() => input.namespace),
		reconcile: (input) => Promise.resolve(input.namespace),
	},
})

const failingProvider = (cause: unknown): ControlProvider => ({
	id: 'harbor',
	normalizeRegistration: (input) => input,
	deploy: () => Promise.resolve({ state: 'succeeded' }),
	namespaces: {
		normalize: (namespace: ProviderDeploymentNamespace) => namespace,
		namespaceResourceClaims: () => ['service:proxy'],
		registrationResourceClaims: () => [],
		provision: () => Promise.reject(cause),
		reconcile: () => Promise.reject(cause),
	},
})

/** Run one provisioning job against a provider that fails, and report the row plus everything logged. */
async function failNamespace(cause: unknown): Promise<{ row: DeploymentNamespaceRow | null; logged: string }> {
	return failWithProvider(failingProvider(cause))
}

async function failWithProvider(provider: ControlProvider): Promise<{ row: DeploymentNamespaceRow | null; logged: string }> {
	const { db }: { db: ControlRepositories } = createHarness()
	await db.registry.createDeploymentNamespace({
		id: 'apps-prod',
		env: 'prod',
		provider: 'harbor',
		exclusiveAppId: null,
		providerTargetJson: JSON.stringify(target('requested')),
		state: 'pending',
	})
	const lines: string[] = []
	const original = console.error
	console.error = (...args: unknown[]) => {
		lines.push(args.map((arg) => String(arg)).join(' '))
	}
	try {
		const result = await runNamespaceJob(
			{ repositories: db, provider, lock: makeFakeLock() },
			{ kind: 'namespace', namespaceId: 'apps-prod', mutation: 'provision' },
		)
		expect(result.status).toBe('failed')
	} finally {
		console.error = original
	}
	return { row: await db.registry.getDeploymentNamespace('apps-prod'), logged: lines.join('\n') }
}

describe('namespace failure projection', () => {
	test('records a denied import, a refused write, and an unpublishable subdomain as three different failures', async () => {
		const denied = await failNamespace(
			new ProviderNamespaceError('zerops: project import failed (403)', 'insufficientPermissions', false, 'client may not create projects'),
		)
		const invalid = await failNamespace(
			new ProviderNamespaceError('zerops: update service env failed (400)', 'invalidUserInput', false, 'content is not a valid value'),
		)
		const notHttp = await failNamespace(
			new ProviderNamespaceError('proxy proxy-1 exposes no deployed HTTP port', 'serviceStackIsNotHttp', false),
		)

		const stored = [denied.row?.last_error, invalid.row?.last_error, notHttp.row?.last_error]
		expect(new Set(stored).size).toBe(3)
		expect(stored.map((value) => decodeNamespaceError(value ?? null).lastErrorCode)).toEqual([
			'insufficientPermissions',
			'invalidUserInput',
			'serviceStackIsNotHttp',
		])
		// The platform's own words survive, which is the whole point: `invalidUserInput` alone is not actionable.
		expect(decodeNamespaceError(denied.row?.last_error ?? null).lastError).toBe(
			'zerops: project import failed (403) — client may not create projects',
		)
		expect(decodeNamespaceError(notHttp.row?.last_error ?? null).lastError).toBe('proxy proxy-1 exposes no deployed HTTP port')
		expect(denied.logged).toContain('insufficientPermissions')
	})

	test('a credential injected into a provider error reaches neither the row nor the log', async () => {
		const { row, logged } = await failNamespace(
			new ProviderNamespaceError(
				'zerops: project import failed (400)',
				'invalidUserInput',
				false,
				'rejected https://x-access-token:ghs_live_installation_token@github.com/acme/notes.git,'
					+ ' upload https://upload.test/archive?signature=deadbeef&key=secret,'
					+ ' credential px_live_operator_key, token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
			),
		)

		for (const text of [row?.last_error ?? '', logged]) {
			expect(text).not.toContain('ghs_live_installation_token')
			expect(text).not.toContain('x-access-token')
			expect(text).not.toContain('signature=deadbeef')
			expect(text).not.toContain('px_live_operator_key')
			expect(text).not.toContain('eyJhbGciOiJIUzI1NiJ9')
		}
		expect(row?.last_error).toContain('invalidUserInput: zerops: project import failed (400)')
		expect(row?.last_error).toContain('https://github.com/acme/notes.git')
	})

	test('an untyped provider throw is internal on the row and full, redacted, in the log', async () => {
		const { row, logged } = await failNamespace(new Error('clone https://x-access-token:ghs_untyped_token@github.com/acme/notes.git failed'))

		expect(row?.last_error).toBe('internal: namespace provision failed')
		expect(logged).toContain('namespace provision failed for apps-prod: internal:')
		expect(logged).toContain('clone https://github.com/acme/notes.git failed')
		expect(logged).not.toContain('ghs_untyped_token')
	})

	test('recognizes a typed failure from a duplicated contract module, structurally', async () => {
		// A second copy of `@fabrika/provider-contract` in the module graph makes `instanceof` false. The
		// class is still what it says it is, and every failure silently becoming `internal` is the blindness
		// this projection exists to end.
		class ForeignProviderNamespaceError extends Error {
			readonly code = 'insufficientPermissions'
			readonly retryable = false
			readonly detail = 'client may not create projects'
			constructor(message: string) {
				super(message)
				this.name = 'ProviderNamespaceError'
			}
		}

		const { row } = await failNamespace(new ForeignProviderNamespaceError('zerops: project import failed (403)'))

		expect(decodeNamespaceError(row?.last_error ?? null)).toEqual({
			lastError: 'zerops: project import failed (403) — client may not create projects',
			lastErrorCode: 'insufficientPermissions',
		})
	})

	test("records core's own checkpoint invariant under core's code, never a provider's", async () => {
		const { row } = await failWithProvider(checkpointBreakingProvider())

		expect(decodeNamespaceError(row?.last_error ?? null)).toEqual({
			lastError: 'provider checkpoint changed namespace coordinates',
			lastErrorCode: 'checkpointInvariant',
		})
	})

	test('logs the whole cause but bounds what the row carries', async () => {
		const long = 'x'.repeat(500)
		const { row, logged } = await failNamespace(new ProviderNamespaceError('zerops: project import failed (400)', 'invalidUserInput', false, long))

		expect((row?.last_error ?? '').length).toBeLessThan(360)
		expect(row?.last_error).toContain('…')
		expect(logged).toContain(long)
	})

	test('stays total when redaction empties the message', async () => {
		const { row } = await failNamespace(new ProviderNamespaceError('px_only_a_credential', 'invalidUserInput', false))

		expect(decodeNamespaceError(row?.last_error ?? null).lastError).toBe('px_***')
		const secretOnly = await failNamespace(new ProviderNamespaceError('CLOUDFLARE_API_TOKEN=looks-like-a-secret', 'invalidUserInput', false))
		expect(decodeNamespaceError(secretOnly.row?.last_error ?? null).lastError).toBe('CLOUDFLARE_API_TOKEN=***')
	})

	test('refuses to record a provider code that would not survive the column', async () => {
		const { row } = await failNamespace(new ProviderNamespaceError('provider said no', 'not a code: really', false))

		expect(decodeNamespaceError(row?.last_error ?? null)).toEqual({ lastError: 'provider said no', lastErrorCode: 'internal' })
	})
})

describe('namespace error encoding', () => {
	test('round-trips a code and its message through one column', () => {
		expect(decodeNamespaceError(encodeNamespaceError('insufficientPermissions', 'import failed (403)'))).toEqual({
			lastError: 'import failed (403)',
			lastErrorCode: 'insufficientPermissions',
		})
	})

	test('reads a row written before the codes existed as a message with no code', () => {
		expect(decodeNamespaceError('namespace provision failed')).toEqual({ lastError: 'namespace provision failed', lastErrorCode: null })
		expect(decodeNamespaceError('provider reconcile failed: nothing to resume')).toEqual({
			lastError: 'provider reconcile failed: nothing to resume',
			lastErrorCode: null,
		})
		expect(decodeNamespaceError(null)).toEqual({ lastError: null, lastErrorCode: null })
	})
})

describe('redactNamespaceErrorText', () => {
	test('strips userinfo, signed query strings, api keys and signed tokens', () => {
		expect(redactNamespaceErrorText('clone https://x-access-token:ghs_secret@github.com/acme/notes.git')).toBe(
			'clone https://github.com/acme/notes.git',
		)
		expect(redactNamespaceErrorText('PUT https://upload.test/archive?signature=abc&expires=1')).toBe('PUT https://upload.test/archive?***')
		expect(redactNamespaceErrorText('credential px_operator_key was refused')).toBe('credential px_*** was refused')
		expect(redactNamespaceErrorText('bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln')).toBe('bearer ***')
		expect(redactNamespaceErrorText('token github_pat_11ABCDEF_secret')).toBe('token ***')
	})

	test('masks an environment assignment quoted back at us', () => {
		expect(redactNamespaceErrorText('assets exploded with CLOUDFLARE_API_TOKEN=looks-like-a-secret')).toBe(
			'assets exploded with CLOUDFLARE_API_TOKEN=***',
		)
		expect(redactNamespaceErrorText('FABRIKA_IAM_KEY=abc123 rejected')).toBe('FABRIKA_IAM_KEY=*** rejected')
		// A lowercase word before `=` is prose, not an assignment, and stays readable.
		expect(redactNamespaceErrorText('expected version=2')).toBe('expected version=2')
	})

	test('bounds the row but never the log', () => {
		expect(redactNamespaceErrorText('x'.repeat(400), { cap: false })).toHaveLength(400)
	})

	test('keeps what an operator needs and bounds what a provider may say', () => {
		expect(redactNamespaceErrorText('  project\n  import failed (403)  ')).toBe('project import failed (403)')
		expect(redactNamespaceErrorText('x'.repeat(400))).toHaveLength(301)
	})
})
