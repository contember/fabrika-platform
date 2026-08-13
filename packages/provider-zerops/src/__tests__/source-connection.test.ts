import { describe, expect, test } from 'bun:test'
import {
	serializeZeropsSourceCredentialBundle,
	sha256ZeropsSourceCredentialBundle,
	type ZeropsSourceCredentialActivateInput,
	type ZeropsSourceCredentialActivateResponseV1,
	type ZeropsSourceCredentialManager,
	type ZeropsSourceCredentialStatusInput,
	type ZeropsSourceCredentialStatusResponseV1,
	type ZeropsSourceGitHubAppIdentityV1,
} from '../source'
import {
	createZeropsSourceConnectionAdmin,
	SourceConnectionAdminError,
	type SourceConnectionInspection,
	type SourceConnectionZeropsApi,
	ZEROPS_SOURCE_CREDENTIAL_ENV,
} from '../source-connection'

const PROJECT_ID = 'project-1'
const SERVICE_ID = 'service-source'
const PEM = `-----BEGIN PRIVATE KEY-----
MAMCAQE=
-----END PRIVATE KEY-----
`
const BUNDLE = serializeZeropsSourceCredentialBundle({ version: 1, githubAppId: '123', privateKeyPem: PEM })
const IDENTITY: ZeropsSourceGitHubAppIdentityV1 = {
	id: 123,
	slug: 'fabrika-test',
	htmlUrl: 'https://github.com/apps/fabrika-test',
	public: false,
	owner: { login: 'contember', type: 'Organization' },
	permissions: { contents: 'read' },
	events: ['push'],
}

interface FakeState {
	readonly environment: Map<string, string>
	findResult?: { id: string; name: string; projectId?: string } | null
	createFailure?: Error
	delayedReads?: number
	created: Array<{ key: string; value: string }>
}

const fakeApi = (state: FakeState): SourceConnectionZeropsApi => ({
	findService: () => Promise.resolve(state.findResult === undefined ? { id: SERVICE_ID, name: 'source', projectId: PROJECT_ID } : state.findResult),
	listServiceEnv: () => {
		if ((state.delayedReads ?? 0) > 0) {
			state.delayedReads = (state.delayedReads ?? 0) - 1
			return Promise.resolve([])
		}
		return Promise.resolve(
			[...state.environment].map(([key, content], index) => ({ id: `env-${index}`, key, content, serviceStackId: SERVICE_ID })),
		)
	},
	createServiceEnv: ({ key, value }) => {
		state.created.push({ key, value })
		state.environment.set(key, value)
		return state.createFailure === undefined ? Promise.resolve() : Promise.reject(state.createFailure)
	},
})

class FakeSource implements ZeropsSourceCredentialManager {
	readonly activations: ZeropsSourceCredentialActivateInput[] = []
	statusResult: ZeropsSourceCredentialStatusResponseV1 | undefined

	async activate(input: ZeropsSourceCredentialActivateInput): Promise<ZeropsSourceCredentialActivateResponseV1> {
		this.activations.push(input)
		return {
			protocolVersion: 1,
			connectionId: input.connectionId,
			credentialVersion: 1,
			credentialSha256: input.credentialSha256,
			githubApp: IDENTITY,
		}
	}

	status(input: ZeropsSourceCredentialStatusInput): Promise<ZeropsSourceCredentialStatusResponseV1> {
		return Promise.resolve(this.statusResult ?? { protocolVersion: 1, connectionId: input.connectionId, state: 'anonymous' })
	}
}

const state = (environment: Readonly<Record<string, string>> = {}): FakeState => ({
	environment: new Map(Object.entries(environment)),
	created: [],
})

const signal = (): AbortSignal => new AbortController().signal

describe('Zerops source connection administration', () => {
	test('classifies anonymous, complete legacy, partial legacy, and canonical durable state without exposing values', async () => {
		const source = new FakeSource()
		const cases: Array<{ readonly environment: Readonly<Record<string, string>>; readonly expected: SourceConnectionInspection }> = [
			{ environment: {}, expected: { state: 'anonymous' } },
			{ environment: { GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: PEM }, expected: { state: 'legacy-complete' } },
			{ environment: { GITHUB_APP_ID: '123' }, expected: { state: 'legacy-partial' } },
		]
		for (const current of cases) {
			const admin = createZeropsSourceConnectionAdmin({ api: fakeApi(state(current.environment)), source, projectId: PROJECT_ID })
			expect(await admin.inspect(signal())).toEqual(current.expected)
		}
		const digest = await sha256ZeropsSourceCredentialBundle(BUNDLE)
		const admin = createZeropsSourceConnectionAdmin({
			api: fakeApi(state({ [ZEROPS_SOURCE_CREDENTIAL_ENV]: BUNDLE })),
			source,
			projectId: PROJECT_ID,
		})
		expect(await admin.inspect(signal())).toEqual({ state: 'durable', credentialSha256: digest })
		expect(JSON.stringify(await admin.inspect(signal()))).not.toContain(PEM)
		const compatible = createZeropsSourceConnectionAdmin({
			api: fakeApi(state({
				[ZEROPS_SOURCE_CREDENTIAL_ENV]: BUNDLE,
				GITHUB_APP_ID: '123',
				GITHUB_APP_PRIVATE_KEY: PEM,
			})),
			source,
			projectId: PROJECT_ID,
		})
		expect(await compatible.inspect(signal())).toEqual({ state: 'durable', credentialSha256: digest })
	})

	test('adopts a complete legacy pair through one create-only canonical bundle write', async () => {
		const legacy = state({ GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: PEM })
		const source = new FakeSource()
		const admin = createZeropsSourceConnectionAdmin({ api: fakeApi(legacy), source, projectId: PROJECT_ID })
		const credentialSha256 = await sha256ZeropsSourceCredentialBundle(BUNDLE)
		await expect(
			admin.activate({ connectionId: 'connection-1', credentialBundle: BUNDLE, credentialSha256, signal: signal() }),
		).resolves.toMatchObject({ credentialSha256 })
		expect(legacy.created).toEqual([{ key: ZEROPS_SOURCE_CREDENTIAL_ENV, value: BUNDLE }])
		expect(await admin.inspect(signal())).toEqual({ state: 'durable', credentialSha256 })
	})

	test('creates one atomic bundle, proves an exact bounded reread, and activates the same digest', async () => {
		const durable = state()
		durable.delayedReads = 2
		const source = new FakeSource()
		const admin = createZeropsSourceConnectionAdmin({
			api: fakeApi(durable),
			source,
			projectId: PROJECT_ID,
			reread: { attempts: 4, delayMs: 0, sleep: () => Promise.resolve() },
		})
		const credentialSha256 = await sha256ZeropsSourceCredentialBundle(BUNDLE)
		await expect(
			admin.activate({ connectionId: 'connection-1', credentialBundle: BUNDLE, credentialSha256, signal: signal() }),
		).resolves.toMatchObject({ connectionId: 'connection-1', credentialSha256 })
		expect(durable.created).toEqual([{ key: ZEROPS_SOURCE_CREDENTIAL_ENV, value: BUNDLE }])
		expect(source.activations).toHaveLength(1)
	})

	test('recovers an ambiguous create only after exact reread and never creates twice', async () => {
		const durable = state()
		durable.createFailure = new Error(`upstream echoed ${BUNDLE}`)
		const source = new FakeSource()
		const admin = createZeropsSourceConnectionAdmin({ api: fakeApi(durable), source, projectId: PROJECT_ID })
		const credentialSha256 = await sha256ZeropsSourceCredentialBundle(BUNDLE)
		await admin.activate({ connectionId: 'connection-1', credentialBundle: BUNDLE, credentialSha256, signal: signal() })
		await admin.activate({ connectionId: 'connection-1', credentialBundle: BUNDLE, credentialSha256, signal: signal() })
		expect(durable.created).toHaveLength(1)
	})

	test('fails closed on partial or mismatched legacy, mismatched durable values, and non-exact service discovery', async () => {
		const digest = await sha256ZeropsSourceCredentialBundle(BUNDLE)
		const cases = [
			state({ GITHUB_APP_ID: '123' }),
			state({ GITHUB_APP_ID: '124', GITHUB_APP_PRIVATE_KEY: PEM }),
			state({ [ZEROPS_SOURCE_CREDENTIAL_ENV]: BUNDLE, GITHUB_APP_ID: '124', GITHUB_APP_PRIVATE_KEY: PEM }),
			state({ [ZEROPS_SOURCE_CREDENTIAL_ENV]: serializeZeropsSourceCredentialBundle({ version: 1, githubAppId: '124', privateKeyPem: PEM }) }),
			Object.assign(state(), { findResult: { id: SERVICE_ID, name: 'source', projectId: 'other-project' } }),
		]
		for (const current of cases) {
			const admin = createZeropsSourceConnectionAdmin({ api: fakeApi(current), source: new FakeSource(), projectId: PROJECT_ID })
			const raised = await admin.activate({ connectionId: 'connection-1', credentialBundle: BUNDLE, credentialSha256: digest, signal: signal() })
				.catch((error: unknown) => error)
			expect(raised).toBeInstanceOf(SourceConnectionAdminError)
			expect(raised instanceof Error ? raised.message : '').not.toContain(BUNDLE)
			expect(current.created).toHaveLength(0)
		}
	})

	test('combines durable and runtime status and detects stale activation', async () => {
		const digest = await sha256ZeropsSourceCredentialBundle(BUNDLE)
		const source = new FakeSource()
		const admin = createZeropsSourceConnectionAdmin({
			api: fakeApi(state({ [ZEROPS_SOURCE_CREDENTIAL_ENV]: BUNDLE })),
			source,
			projectId: PROJECT_ID,
		})
		expect(await admin.status({ connectionId: 'connection-1', signal: signal() })).toEqual({
			state: 'activation-required',
			credentialSha256: digest,
		})
		source.statusResult = {
			protocolVersion: 1,
			connectionId: 'connection-1',
			state: 'active',
			credentialVersion: 1,
			credentialSha256: digest,
			githubApp: IDENTITY,
		}
		expect(await admin.status({ connectionId: 'connection-1', signal: signal() })).toEqual({
			state: 'active',
			credentialSha256: digest,
			githubApp: IDENTITY,
		})
	})

	test('preserves abort without including its reason', async () => {
		const controller = new AbortController()
		controller.abort(`private ${BUNDLE}`)
		const admin = createZeropsSourceConnectionAdmin({ api: fakeApi(state()), source: new FakeSource(), projectId: PROJECT_ID })
		const raised = await admin.inspect(controller.signal).catch((error: unknown) => error)
		expect(raised).toBeInstanceOf(DOMException)
		expect(raised instanceof Error ? raised.message : '').not.toContain(BUNDLE)
	})
})
