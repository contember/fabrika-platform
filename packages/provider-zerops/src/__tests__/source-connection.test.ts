import { describe, expect, test } from 'bun:test'
import {
	buildZeropsSourceCredentialBundleV2,
	serializeZeropsSourceCredentialBundleV2,
	sha256ZeropsSourceCredentialBundleV2,
	type ZeropsSourceCredentialActivateInput,
	type ZeropsSourceCredentialActivateResponseV2,
	zeropsSourceCredentialEnvV2,
	type ZeropsSourceCredentialManager,
	type ZeropsSourceCredentialManagerV2,
	type ZeropsSourceCredentialStatusInput,
	type ZeropsSourceCredentialStatusResponseV2,
	type ZeropsSourceGitHubAppIdentityV1,
} from '../source'
import {
	createZeropsSourceConnectionAdmin,
	type SourceConnectionActivateInput,
	SourceConnectionAdminError,
	type SourceConnectionZeropsApi,
} from '../source-connection'

const PROJECT_ID = 'project-1'
const SERVICE_ID = 'service-source'
const PEM = `-----BEGIN PRIVATE KEY-----
MAMCAQE=
-----END PRIVATE KEY-----
`
const CONNECTION_1 = 'connection-1'
const CONNECTION_2 = 'connection-2'
const BUNDLE_V2_1 = serializeZeropsSourceCredentialBundleV2(buildZeropsSourceCredentialBundleV2({
	connectionId: CONNECTION_1,
	githubAppId: '123',
	privateKeyPem: PEM,
}))
const BUNDLE_V2_2 = serializeZeropsSourceCredentialBundleV2(buildZeropsSourceCredentialBundleV2({
	connectionId: CONNECTION_2,
	githubAppId: '456',
	privateKeyPem: PEM,
}))
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
	environmentEntries?: Array<{ readonly key: string; readonly content: string }>
	findResult?: { id: string; name: string; projectId?: string } | null
	listFailure?: Error
	createFailure?: Error
	delayedReads?: number
	created: Array<{ key: string; value: string }>
}

const fakeApi = (state: FakeState): SourceConnectionZeropsApi => ({
	findService: () => Promise.resolve(state.findResult === undefined ? { id: SERVICE_ID, name: 'source', projectId: PROJECT_ID } : state.findResult),
	listServiceEnv: () => {
		if (state.listFailure !== undefined) return Promise.reject(state.listFailure)
		if ((state.delayedReads ?? 0) > 0) {
			state.delayedReads = (state.delayedReads ?? 0) - 1
			return Promise.resolve([])
		}
		const entries = state.environmentEntries ?? [...state.environment].map(([key, content]) => ({ key, content }))
		return Promise.resolve(entries.map((entry, index) => ({ id: `env-${index}`, ...entry, serviceStackId: SERVICE_ID })))
	},
	createServiceEnv: ({ key, value }) => {
		state.created.push({ key, value })
		state.environment.set(key, value)
		return state.createFailure === undefined ? Promise.resolve() : Promise.reject(state.createFailure)
	},
})

class FakeSource implements ZeropsSourceCredentialManager, ZeropsSourceCredentialManagerV2 {
	readonly activationsV2: ZeropsSourceCredentialActivateInput[] = []
	activationFailureV2?: Error
	statusResultV2 = new Map<string, ZeropsSourceCredentialStatusResponseV2>()

	async activateV2(input: ZeropsSourceCredentialActivateInput): Promise<ZeropsSourceCredentialActivateResponseV2> {
		this.activationsV2.push(input)
		if (this.activationFailureV2 !== undefined) throw this.activationFailureV2
		return {
			protocolVersion: 2,
			connectionId: input.connectionId,
			credentialVersion: 2,
			credentialSha256: input.credentialSha256,
			githubApp: IDENTITY,
		}
	}

	statusV2(input: ZeropsSourceCredentialStatusInput): Promise<ZeropsSourceCredentialStatusResponseV2> {
		return Promise.resolve(
			this.statusResultV2.get(input.connectionId) ?? { protocolVersion: 2, connectionId: input.connectionId, state: 'anonymous' },
		)
	}

	configureWebhook(
		input: Parameters<ZeropsSourceCredentialManager['configureWebhook']>[0],
	): ReturnType<ZeropsSourceCredentialManager['configureWebhook']> {
		return Promise.resolve({
			protocolVersion: 1,
			connectionId: input.connectionId,
			credentialSha256: input.credentialSha256,
			webhook: { url: input.url, contentType: 'json', insecureSsl: '0' },
		})
	}

	verifyInstallations(
		input: Parameters<ZeropsSourceCredentialManager['verifyInstallations']>[0],
	): ReturnType<ZeropsSourceCredentialManager['verifyInstallations']> {
		const accountLogin = input.scope.kind === 'organization' ? input.scope.organization : input.scope.repositories[0]?.owner ?? 'missing'
		return Promise.resolve({
			protocolVersion: 1,
			connectionId: input.connectionId,
			credentialSha256: input.credentialSha256,
			installation: { status: 'installed', installationId: 42, accountLogin, repositorySelection: 'selected' },
		})
	}
}

const state = (environment: Readonly<Record<string, string>> = {}): FakeState => ({
	environment: new Map(Object.entries(environment)),
	created: [],
})

const signal = (): AbortSignal => new AbortController().signal

describe('Zerops source connection administration', () => {
	test('reports anonymous once the exact source service and its environment are readable', async () => {
		const source = new FakeSource()
		const populated = state({ UNRELATED: 'value' })
		const admin = createZeropsSourceConnectionAdmin({ api: fakeApi(populated), source, projectId: PROJECT_ID })
		expect(await admin.inspect(signal())).toEqual({ state: 'anonymous' })
		// A keyed slot is a connection fact, not an installation-wide one: `inspect` still says anonymous.
		const keyed = state({ [await zeropsSourceCredentialEnvV2(CONNECTION_1)]: BUNDLE_V2_1 })
		const withSlot = createZeropsSourceConnectionAdmin({ api: fakeApi(keyed), source, projectId: PROJECT_ID })
		expect(await withSlot.inspect(signal())).toEqual({ state: 'anonymous' })
		expect(JSON.stringify(await withSlot.inspect(signal()))).not.toContain(PEM)
	})

	test('refuses a missing or non-exact source service', async () => {
		for (
			const [current, code] of [
				[Object.assign(state(), { findResult: null }), 'source_not_found'],
				[Object.assign(state(), { findResult: { id: SERVICE_ID, name: 'source', projectId: 'other-project' } }), 'source_mismatch'],
				[Object.assign(state(), { findResult: { id: '', name: 'source', projectId: PROJECT_ID } }), 'source_mismatch'],
			] as const
		) {
			const admin = createZeropsSourceConnectionAdmin({ api: fakeApi(current), source: new FakeSource(), projectId: PROJECT_ID })
			await expect(admin.inspect(signal())).rejects.toMatchObject({ code })
		}
	})

	test('maps an invalid environment response to a detail-free persistence error', async () => {
		const secret = 'invalid-response-bytes-that-must-not-leak'
		const current = state()
		current.listFailure = new Error(`invalid environment response: ${secret}`)
		const admin = createZeropsSourceConnectionAdmin({ api: fakeApi(current), source: new FakeSource(), projectId: PROJECT_ID })

		const error = await admin.inspect(signal()).catch((cause: unknown) => cause)
		expect(error).toBeInstanceOf(SourceConnectionAdminError)
		expect(error).toMatchObject({ code: 'credential_persistence' })
		expect(error instanceof Error ? error.message : '').toBe('source connection administration failed (credential_persistence)')
		expect(error instanceof Error ? error.message : '').not.toContain(secret)
	})

	test('proves an exact bounded reread before it activates a new slot', async () => {
		const durable = state()
		durable.delayedReads = 2
		const source = new FakeSource()
		const admin = createZeropsSourceConnectionAdmin({
			api: fakeApi(durable),
			source,
			projectId: PROJECT_ID,
			reread: { attempts: 4, delayMs: 0, sleep: () => Promise.resolve() },
		})
		const credentialSha256 = await sha256ZeropsSourceCredentialBundleV2(BUNDLE_V2_1)
		await expect(
			admin.activateV2({ connectionId: CONNECTION_1, credentialBundle: BUNDLE_V2_1, credentialSha256, signal: signal() }),
		).resolves.toMatchObject({ connectionId: CONNECTION_1, credentialSha256 })
		expect(durable.created).toEqual([{ key: await zeropsSourceCredentialEnvV2(CONNECTION_1), value: BUNDLE_V2_1 }])
		expect(source.activationsV2).toHaveLength(1)
	})

	test('fails the persistence proof when the slot never becomes readable', async () => {
		const durable = state()
		durable.delayedReads = 10
		const admin = createZeropsSourceConnectionAdmin({
			api: fakeApi(durable),
			source: new FakeSource(),
			projectId: PROJECT_ID,
			reread: { attempts: 3, delayMs: 0, sleep: () => Promise.resolve() },
		})
		const credentialSha256 = await sha256ZeropsSourceCredentialBundleV2(BUNDLE_V2_1)
		await expect(
			admin.activateV2({ connectionId: CONNECTION_1, credentialBundle: BUNDLE_V2_1, credentialSha256, signal: signal() }),
		).rejects.toMatchObject({ code: 'credential_persistence' })
	})

	test('persists distinct create-only v2 slots and makes repeated activation idempotent', async () => {
		const durable = state()
		const source = new FakeSource()
		const admin = createZeropsSourceConnectionAdmin({ api: fakeApi(durable), source, projectId: PROJECT_ID })
		const digest1 = await sha256ZeropsSourceCredentialBundleV2(BUNDLE_V2_1)
		const digest2 = await sha256ZeropsSourceCredentialBundleV2(BUNDLE_V2_2)

		await admin.activateV2({ connectionId: CONNECTION_1, credentialBundle: BUNDLE_V2_1, credentialSha256: digest1, signal: signal() })
		await admin.activateV2({ connectionId: CONNECTION_2, credentialBundle: BUNDLE_V2_2, credentialSha256: digest2, signal: signal() })
		await admin.activateV2({ connectionId: CONNECTION_1, credentialBundle: BUNDLE_V2_1, credentialSha256: digest1, signal: signal() })

		expect(durable.created).toEqual([
			{ key: await zeropsSourceCredentialEnvV2(CONNECTION_1), value: BUNDLE_V2_1 },
			{ key: await zeropsSourceCredentialEnvV2(CONNECTION_2), value: BUNDLE_V2_2 },
		])
		expect(source.activationsV2.map((input) => input.connectionId)).toEqual([CONNECTION_1, CONNECTION_2, CONNECTION_1])
		expect(await admin.statusV2({ connectionId: CONNECTION_1, signal: signal() })).toEqual({
			state: 'activation-required',
			credentialSha256: digest1,
		})
		source.statusResultV2.set(CONNECTION_1, {
			protocolVersion: 2,
			connectionId: CONNECTION_1,
			state: 'active',
			credentialVersion: 2,
			credentialSha256: digest1,
			githubApp: IDENTITY,
		})
		expect(await admin.statusV2({ connectionId: CONNECTION_1, signal: signal() })).toEqual({
			state: 'active',
			credentialSha256: digest1,
			githubApp: IDENTITY,
		})
	})

	test('refuses a runtime status whose digest is not the durable slot', async () => {
		const slot = await zeropsSourceCredentialEnvV2(CONNECTION_1)
		const source = new FakeSource()
		source.statusResultV2.set(CONNECTION_1, {
			protocolVersion: 2,
			connectionId: CONNECTION_1,
			state: 'active',
			credentialVersion: 2,
			credentialSha256: 'f'.repeat(64),
			githubApp: IDENTITY,
		})
		const admin = createZeropsSourceConnectionAdmin({ api: fakeApi(state({ [slot]: BUNDLE_V2_1 })), source, projectId: PROJECT_ID })
		await expect(admin.statusV2({ connectionId: CONNECTION_1, signal: signal() })).rejects.toMatchObject({ code: 'credential_conflict' })
	})

	test('recovers an ambiguous v2 create only from the exact connection slot', async () => {
		const durable = state()
		durable.createFailure = new Error(`upstream echoed ${BUNDLE_V2_1}`)
		const source = new FakeSource()
		const admin = createZeropsSourceConnectionAdmin({ api: fakeApi(durable), source, projectId: PROJECT_ID })
		const digest = await sha256ZeropsSourceCredentialBundleV2(BUNDLE_V2_1)

		await expect(
			admin.activateV2({ connectionId: CONNECTION_1, credentialBundle: BUNDLE_V2_1, credentialSha256: digest, signal: signal() }),
		).resolves.toMatchObject({ protocolVersion: 2, connectionId: CONNECTION_1, credentialSha256: digest })
		expect(durable.created).toEqual([{ key: await zeropsSourceCredentialEnvV2(CONNECTION_1), value: BUNDLE_V2_1 }])
	})

	test('recovers an ambiguous v2 activation only through an exact runtime status readback', async () => {
		const slot = await zeropsSourceCredentialEnvV2(CONNECTION_1)
		const digest = await sha256ZeropsSourceCredentialBundleV2(BUNDLE_V2_1)
		const source = new FakeSource()
		source.activationFailureV2 = new Error('lost activation response with private upstream detail')
		source.statusResultV2.set(CONNECTION_1, {
			protocolVersion: 2,
			connectionId: CONNECTION_1,
			state: 'active',
			credentialVersion: 2,
			credentialSha256: digest,
			githubApp: IDENTITY,
		})
		const admin = createZeropsSourceConnectionAdmin({ api: fakeApi(state({ [slot]: BUNDLE_V2_1 })), source, projectId: PROJECT_ID })
		await expect(admin.activateV2({ connectionId: CONNECTION_1, credentialBundle: BUNDLE_V2_1, credentialSha256: digest, signal: signal() }))
			.resolves.toMatchObject({ connectionId: CONNECTION_1, credentialSha256: digest, githubApp: IDENTITY })
		source.statusResultV2.set(CONNECTION_1, {
			protocolVersion: 2,
			connectionId: CONNECTION_1,
			state: 'active',
			credentialVersion: 2,
			credentialSha256: 'f'.repeat(64),
			githubApp: IDENTITY,
		})
		const raised = await admin.activateV2({ connectionId: CONNECTION_1, credentialBundle: BUNDLE_V2_1, credentialSha256: digest, signal: signal() })
			.catch((error: unknown) => error)
		expect(raised).toMatchObject({ code: 'credential_activation' })
		expect(raised instanceof Error ? raised.message : '').not.toContain('private upstream detail')
	})

	test('rejects v2 slot, bundle, request, and digest mismatches without rewriting durable state', async () => {
		const slot1 = await zeropsSourceCredentialEnvV2(CONNECTION_1)
		const mismatchedBundle = serializeZeropsSourceCredentialBundleV2(buildZeropsSourceCredentialBundleV2({
			connectionId: CONNECTION_1,
			githubAppId: '789',
			privateKeyPem: PEM,
		}))
		const digest1 = await sha256ZeropsSourceCredentialBundleV2(BUNDLE_V2_1)
		const cases: Array<{ durable: FakeState; input: SourceConnectionActivateInput }> = [
			{
				durable: state({ [slot1]: mismatchedBundle }),
				input: { connectionId: CONNECTION_1, credentialBundle: BUNDLE_V2_1, credentialSha256: digest1, signal: signal() },
			},
			{
				durable: state({ [slot1]: BUNDLE_V2_2 }),
				input: { connectionId: CONNECTION_1, credentialBundle: BUNDLE_V2_1, credentialSha256: digest1, signal: signal() },
			},
			{
				durable: state(),
				input: { connectionId: CONNECTION_2, credentialBundle: BUNDLE_V2_1, credentialSha256: digest1, signal: signal() },
			},
			{
				durable: state(),
				input: { connectionId: CONNECTION_1, credentialBundle: BUNDLE_V2_1, credentialSha256: 'f'.repeat(64), signal: signal() },
			},
		]
		const duplicate = state()
		duplicate.environmentEntries = [{ key: slot1, content: BUNDLE_V2_1 }, { key: slot1, content: BUNDLE_V2_1 }]
		cases.push({
			durable: duplicate,
			input: { connectionId: CONNECTION_1, credentialBundle: BUNDLE_V2_1, credentialSha256: digest1, signal: signal() },
		})
		for (const current of cases) {
			const admin = createZeropsSourceConnectionAdmin({ api: fakeApi(current.durable), source: new FakeSource(), projectId: PROJECT_ID })
			await expect(admin.activateV2(current.input)).rejects.toMatchObject({ code: 'credential_conflict' })
			expect(current.durable.created).toHaveLength(0)
		}
	})

	test('does not impose an aggregate environment-entry count cap', async () => {
		const manyEntries: Record<string, string> = {}
		for (let index = 0; index < 600; index++) manyEntries[`UNRELATED_${index}`] = `value-${index}`
		const admin = createZeropsSourceConnectionAdmin({
			api: fakeApi(state(manyEntries)),
			source: new FakeSource(),
			projectId: PROJECT_ID,
		})
		await expect(admin.inspect(signal())).resolves.toEqual({ state: 'anonymous' })
		await expect(admin.statusV2({ connectionId: CONNECTION_1, signal: signal() })).resolves.toEqual({ state: 'anonymous' })
	})

	test('binds webhook and installation administration to the exact keyed slot digest', async () => {
		const slot = await zeropsSourceCredentialEnvV2(CONNECTION_1)
		const digest = await sha256ZeropsSourceCredentialBundleV2(BUNDLE_V2_1)
		const admin = createZeropsSourceConnectionAdmin({
			api: fakeApi(state({ [slot]: BUNDLE_V2_1 })),
			source: new FakeSource(),
			projectId: PROJECT_ID,
		})
		await expect(admin.configureWebhook({
			connectionId: CONNECTION_1,
			credentialSha256: digest,
			url: 'https://control.example.test/webhooks/github/connection-1',
			secret: 'must-not-leak',
			signal: signal(),
		})).resolves.toMatchObject({ credentialSha256: digest, webhook: { contentType: 'json', insecureSsl: '0' } })
		await expect(admin.verifyInstallations({
			connectionId: CONNECTION_1,
			credentialSha256: digest,
			scope: { kind: 'organization', organization: 'contember' },
			signal: signal(),
		})).resolves.toMatchObject({
			installation: { status: 'installed', installationId: 42, accountLogin: 'contember', repositorySelection: 'selected' },
		})
		await expect(admin.configureWebhook({
			connectionId: CONNECTION_1,
			credentialSha256: 'd'.repeat(64),
			url: 'https://control.example.test/webhooks/github/connection-1',
			secret: 'must-not-leak',
			signal: signal(),
		})).rejects.toMatchObject({ code: 'credential_conflict' })
		// A connection with no durable slot has no credential to administer, and never borrows another's.
		await expect(admin.configureWebhook({
			connectionId: CONNECTION_2,
			credentialSha256: digest,
			url: 'https://control.example.test/webhooks/github/connection-2',
			secret: 'must-not-leak',
			signal: signal(),
		})).rejects.toMatchObject({ code: 'credential_conflict' })
	})

	test('preserves abort without including its reason', async () => {
		const controller = new AbortController()
		controller.abort(`private ${BUNDLE_V2_1}`)
		const admin = createZeropsSourceConnectionAdmin({ api: fakeApi(state()), source: new FakeSource(), projectId: PROJECT_ID })
		const raised = await admin.inspect(controller.signal).catch((error: unknown) => error)
		expect(raised).toBeInstanceOf(DOMException)
		expect(raised instanceof Error ? raised.message : '').not.toContain(BUNDLE_V2_1)
	})
})
