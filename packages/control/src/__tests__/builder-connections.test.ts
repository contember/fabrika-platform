import type { AuthContext } from '@fabrika/auth'
import { type BuilderConnectionReceiptDto, parseBuilderConnectionReceipt } from '@fabrika/control-contract'
import type { ControlProvider } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { type ControlRepositories, createControlRepositories, uuidv7 } from '../db'
import { appScope } from '../iam'
import { FakeRepoSource } from '../repo-source'
import type { ControlRpcDeps } from '../services'
import { approvalVerifier, pairingIam, pairingRequest as rpcRequest } from './helpers/builder-pairing'
import { createHarness } from './helpers/harness'
import { allowAllAuth, authWithPermissions } from './helpers/iam'
import { createPostgres, hasPostgres, skipReason } from './helpers/postgres'
import { providerEnvironment } from './helpers/provider'
import { rpcResult } from './helpers/rpc'

const target = JSON.stringify({ provider: 'harbor', version: 1, payload: {} })
const selection = { env: 'prod', namespaceId: 'shared-prod', domain: 'notes.example', publicOrigin: 'https://notes.example', triggerRef: null }

function unexpected(): never {
	throw new Error('receipt must not invoke provider capabilities or side effects')
}

const provider: ControlProvider = {
	id: 'harbor',
	normalizeRegistration: unexpected,
	deploy: unexpected,
	namespaces: {
		normalize: unexpected,
		namespaceResourceClaims: unexpected,
		registrationResourceClaims: unexpected,
		prepareRegistration: unexpected,
		provision: unexpected,
		reconcile: unexpected,
	},
}

function deps(repositories: ControlRepositories, auth = allowAllAuth()): ControlRpcDeps {
	return {
		builderPairingIam: pairingIam().iam,
		repositories,
		auth,
		provider,
		repoSource: new FakeRepoSource({ fakeInstallationId: null }),
		queue: { send: unexpected },
		logs: { get: unexpected },
		cancelRun: unexpected,
		catalogChanged: unexpected,
		namespaceProxyChanged: unexpected,
	}
}

async function seed(repositories: ControlRepositories): Promise<void> {
	await repositories.registry.createApp({ id: 'notes', repoUrl: 'https://github.com/example/notes' })
	await repositories.registry.createApp({ id: 'other', repoUrl: 'https://github.com/example/other' })
	await repositories.registry.createDeploymentNamespace({
		id: 'shared-prod',
		env: 'prod',
		provider: 'harbor',
		exclusiveAppId: null,
		providerTargetJson: target,
		state: 'ready',
	})
}

async function receipt(response: Response): Promise<BuilderConnectionReceiptDto> {
	expect(response.status).toBe(200)
	const value: unknown = await response.json()
	return parseBuilderConnectionReceipt(value)
}

function ownAppAuth(appId = 'notes', machine = false): AuthContext {
	const auth = authWithPermissions([{ action: 'app.manage', scope: appScope(appId) }])
	return machine ? { ...auth, principal: { id: 'builder-key', type: 'service', label: 'builder' } } : auth
}

interface Fixture {
	repositories: ControlRepositories
	close(): Promise<void>
}

function behaviorSuite(name: string, fixture: () => Promise<Fixture>, enabled = true): void {
	describe.skipIf(!enabled)(name, () => {
		test('receipt precedes any artifact, leaves placement unreserved, retries are immutable, deletion cascades', async () => {
			const f = await fixture()
			try {
				await seed(f.repositories)
				const d = deps(f.repositories)
				const input = { attemptId: uuidv7(), approvalVerifier, appId: 'notes', environment: selection }
				const first = await receipt(await rpcResult(rpcRequest('builderConnections.createReceipt', input), d))
				expect(first).toMatchObject({ version: 1, attemptId: input.attemptId, provider: 'harbor', app: { id: 'notes' }, environment: selection })
				expect(await f.repositories.registry.listAppEnvs('notes')).toEqual([])
				expect(await f.repositories.registry.listNamespaceResourceClaimsForApp('notes')).toEqual([])
				await f.repositories.registry.updateApp('notes', { defaultBranch: 'changed' })
				expect(await receipt(await rpcResult(rpcRequest('builderConnections.createReceipt', input), d))).toEqual(first)
				const conflicting = await rpcResult(
					rpcRequest('builderConnections.createReceipt', { ...input, environment: { ...selection, domain: 'other.example' } }),
					d,
				)
				expect(conflicting.status).toBe(409)
				expect(
					(await rpcResult(
						rpcRequest('builderConnections.createReceipt', {
							...input,
							environment: { env: 'prod', namespaceId: selection.namespaceId },
						}),
						d,
					)).status,
				).toBe(400)
				expect(await receipt(await rpcResult(rpcRequest('builderConnections.getReceipt', { attemptId: input.attemptId }), d))).toEqual(first)
				await f.repositories.registry.deleteApp('notes')
				expect(await f.repositories.builderConnections.get(input.attemptId)).toBeNull()
			} finally {
				await f.close()
			}
		})

		test('concurrent identical attempts share one snapshot; different selections have one winner', async () => {
			const f = await fixture()
			try {
				await seed(f.repositories)
				const d = deps(f.repositories)
				const input = { attemptId: uuidv7(), approvalVerifier, appId: 'notes', environment: selection }
				const identical = await Promise.all(
					Array.from({ length: 4 }, () => rpcResult(rpcRequest('builderConnections.createReceipt', input), d).then(receipt)),
				)
				for (const item of identical) expect(item).toEqual(identical[0])
				const attemptId = uuidv7()
				const different = await Promise.all(['one.example', 'two.example'].map((domain) =>
					rpcResult(
						rpcRequest('builderConnections.createReceipt', {
							...input,
							attemptId,
							environment: { ...selection, domain },
						}),
						d,
					)
				))
				expect(different.map((response) => response.status).sort()).toEqual([200, 409])
			} finally {
				await f.close()
			}
		})
	})
}

behaviorSuite('builder receipts SQLite', async () => {
	const h = createHarness(() => 1234567890)
	return { repositories: h.repositories, close: async () => h.sqlite.close() }
})

if (!hasPostgres) console.warn(`builder-connections.test.ts ${skipReason}`)
behaviorSuite('builder receipts Postgres', async () => {
	const f = await createPostgres('builder_receipts')
	return { repositories: createControlRepositories(f.db, { now: () => 1234567890 }), close: f.close }
}, hasPostgres)

describe('builder receipt authorization and validation', () => {
	test('service cannot create; app key can read only its own receipt without global authority', async () => {
		const h = createHarness()
		try {
			await seed(h.repositories)
			const input = { attemptId: uuidv7(), approvalVerifier, appId: 'notes', environment: selection }
			await receipt(await rpcResult(rpcRequest('builderConnections.createReceipt', input), deps(h.repositories)))
			const service = deps(h.repositories, { ...allowAllAuth(), principal: { id: 'service', type: 'service', label: 'service' } })
			expect((await rpcResult(rpcRequest('builderConnections.createReceipt', input), service)).status).toBe(403)
			const read = rpcRequest('builderConnections.getReceipt', { attemptId: input.attemptId })
			expect((await rpcResult(read, deps(h.repositories, ownAppAuth('notes', true)))).status).toBe(200)
			expect(
				(await rpcResult(rpcRequest('builderConnections.getReceipt', { attemptId: input.attemptId }), deps(h.repositories, ownAppAuth('other', true))))
					.status,
			).toBe(404)
			expect((await rpcResult(rpcRequest('builderConnections.getReceipt', { attemptId: uuidv7() }), service)).status).toBe(404)
			expect(
				(await rpcResult(rpcRequest('builderConnections.createReceipt', { ...input, attemptId: uuidv7() }), deps(h.repositories, ownAppAuth()))).status,
			).toBe(403)
			expect((await rpcResult(rpcRequest('builderConnections.createReceipt', input), deps(h.repositories, ownAppAuth('other')))).status).toBe(403)
		} finally {
			h.sqlite.close()
		}
	})

	test('new placement validates namespace readiness, provider, environment and exclusivity', async () => {
		const h = createHarness()
		try {
			await seed(h.repositories)
			const d = deps(h.repositories)
			const create = (namespaceId: string | null) =>
				rpcResult(
					rpcRequest('builderConnections.createReceipt', {
						attemptId: uuidv7(),
						approvalVerifier,
						appId: 'notes',
						environment: { ...selection, namespaceId },
					}),
					d,
				)
			expect((await create(null)).status).toBe(400)
			expect((await create('missing')).status).toBe(404)
			for (
				const invalid of [
					{ id: 'pending', state: 'pending' },
					{ id: 'foreign-provider', provider: 'foreign' },
					{ id: 'foreign-env', env: 'stage' },
					{ id: 'exclusive', exclusiveAppId: 'other' },
				]
			) {
				await h.repositories.registry.createDeploymentNamespace({
					id: invalid.id,
					env: invalid.env ?? 'prod',
					provider: invalid.provider ?? 'harbor',
					exclusiveAppId: invalid.exclusiveAppId ?? null,
					providerTargetJson: target,
					state: invalid.state === 'pending' ? 'pending' : 'ready',
				})
				expect((await create(invalid.id)).status).toBe(409)
			}
		} finally {
			h.sqlite.close()
		}
	})

	test('existing placement must be explicit; stale fields and explicit clears conflict', async () => {
		const h = createHarness()
		try {
			await seed(h.repositories)
			await h.repositories.registry.upsertAppEnv({ ...providerEnvironment('notes', 'prod', selection), namespaceId: selection.namespaceId })
			const d = deps(h.repositories, ownAppAuth())
			const input = { attemptId: uuidv7(), approvalVerifier, appId: 'notes', environment: selection }
			const created = await receipt(await rpcResult(rpcRequest('builderConnections.createReceipt', input), d))
			expect(created.environment).toEqual(selection)
			await h.repositories.registry.upsertAppEnv({
				...providerEnvironment('notes', 'prod', { ...selection, domain: 'changed.example' }),
				namespaceId: selection.namespaceId,
			})
			expect(await receipt(await rpcResult(rpcRequest('builderConnections.createReceipt', input), d))).toEqual(created)
			await h.repositories.registry.upsertAppEnv({ ...providerEnvironment('notes', 'prod', selection), namespaceId: selection.namespaceId })
			for (const mismatch of [{ namespaceId: null }, { domain: null }, { publicOrigin: null }, { triggerRef: 'refs/heads/other' }]) {
				expect(
					(await rpcResult(
						rpcRequest('builderConnections.createReceipt', {
							...input,
							attemptId: uuidv7(),
							environment: { ...selection, ...mismatch },
						}),
						d,
					)).status,
				).toBe(409)
			}
			expect(await h.repositories.registry.getAppEnv('notes', 'prod')).toMatchObject({ domain: selection.domain, public_origin: selection.publicOrigin })
		} finally {
			h.sqlite.close()
		}
	})

	test('RPC rejects unsafe identifiers, invalid domain/origin and undeclared payload fields', async () => {
		const h = createHarness()
		try {
			await seed(h.repositories)
			const d = deps(h.repositories)
			const input = { attemptId: uuidv7(), approvalVerifier, appId: 'notes', environment: selection }
			for (
				const invalid of [
					{ ...input, attemptId: '../attempt' },
					{ ...input, appId: 'x'.repeat(129) },
					{ ...input, environment: { ...selection, env: '../prod' } },
					{ ...input, environment: { ...selection, domain: '*.example' } },
					{ ...input, environment: { ...selection, publicOrigin: 'https://example/path' } },
					{ ...input, environment: { ...selection, artifact: {} } },
					{ ...input, secret: 'no' },
				]
			) expect((await rpcResult(rpcRequest('builderConnections.createReceipt', invalid), d)).status).toBe(400)
		} finally {
			h.sqlite.close()
		}
	})

	test('stored DTO parser rejects malformed app snapshots, unknown fields and mismatched coordinates', async () => {
		const h = createHarness()
		try {
			await seed(h.repositories)
			const d = deps(h.repositories)
			const input = { attemptId: uuidv7(), approvalVerifier, appId: 'notes', environment: selection }
			const created = await receipt(await rpcResult(rpcRequest('builderConnections.createReceipt', input), d))
			for (
				const invalid of [
					{ ...created, app: { ...created.app, githubInstallationId: '1' } },
					{ ...created, app: { ...created.app, buildCmd: undefined } },
					{ ...created, environment: { ...created.environment, target: {} } },
					{ ...created, createdAt: '123' },
					{ ...created, app: { ...created.app, id: 'other' } },
				]
			) {
				h.sqlite.query('UPDATE builder_connection_receipts SET receipt_json = ? WHERE attempt_id = ?').run(JSON.stringify(invalid), input.attemptId)
				await expect(h.repositories.builderConnections.get(input.attemptId)).rejects.toThrow()
			}
		} finally {
			h.sqlite.close()
		}
	})
})
