// A claim outlives the services it names until the provider confirms them gone. Releasing it is the step between
// deleting the resources at the provider and deleting the app environment, which a held claim refuses.

import type { AuthContext } from '@fabrika/auth'
import type { ControlProvider, ProviderDeploymentNamespace, ProviderEnvelope } from '@fabrika/provider-contract'
import { ProviderNamespaceError } from '@fabrika/provider-contract'
import { afterEach, describe, expect, test } from 'bun:test'
import { type ControlRepositories, createControlRepositories } from '../db'
import { acquireLease, namespaceLeaseKey } from '../lease'
import type { ControlRpcDeps } from '../services'
import { createHarness } from './helpers/harness'
import { createPostgres, hasPostgres, skipReason } from './helpers/postgres'
import { rpcRequest, rpcResult } from './helpers/rpc'

if (!hasPostgres) console.warn(`namespace-claim-release.test.ts Postgres half ${skipReason}`)

const target = (projectId: string): ProviderEnvelope => ({ provider: 'harbor', version: 1, payload: { projectId } })

interface AuditRecord {
	action: string
	resourceId?: string
	metadata?: unknown
}

/** A provider whose claimed resources exist while `live` names them; `failure` makes the read-back throw. */
interface ProviderWorld {
	live: Set<string>
	failure: Error | null
	checked: string[][]
}

const provider = (world: ProviderWorld, withCheck = true): ControlProvider => ({
	id: 'harbor',
	normalizeRegistration: (input) => input,
	deploy: () => Promise.resolve({ state: 'succeeded' }),
	namespaces: {
		normalize: (namespace: ProviderDeploymentNamespace) => namespace,
		namespaceResourceClaims: () => ['service:proxy'],
		registrationResourceClaims: (registration) => [`service:${registration.app.id}api`, `service:${registration.app.id}files`],
		provision: (input) => Promise.resolve(input.namespace),
		reconcile: (input) => Promise.resolve(input.namespace),
		...(withCheck
			? {
				claimedResources: (input) => {
					world.checked.push([...input.resourceKeys])
					if (world.failure !== null) return Promise.reject(world.failure)
					return Promise.resolve(input.resourceKeys.map((resourceKey) => ({ resourceKey, exists: world.live.has(resourceKey) })))
				},
			}
			: {}),
	},
})

interface Backend {
	repositories: ControlRepositories
	close(): Promise<void>
}

const backends: { name: string; skip: boolean; open(): Promise<Backend> }[] = [
	{
		name: 'sqlite',
		skip: false,
		open: () => {
			const harness = createHarness()
			return Promise.resolve({
				repositories: harness.repositories,
				close: () => {
					harness.sqlite.close()
					return Promise.resolve()
				},
			})
		},
	},
	{
		name: 'postgres',
		skip: !hasPostgres,
		open: async () => {
			const fixture = await createPostgres('control_claims')
			return { repositories: createControlRepositories(fixture.db), close: () => fixture.close() }
		},
	},
]

for (const backend of backends) {
	describe.skipIf(backend.skip)(`namespace claim release (${backend.name})`, () => {
		let opened: Backend | null = null
		afterEach(async () => {
			await opened?.close()
			opened = null
		})

		/** A ready namespace `dev` with `notes@dev` registered in it, holding `service:notesapi` and `service:notesfiles`. */
		async function world(withCheck = true) {
			opened = await backend.open()
			const db = opened.repositories
			const resources: ProviderWorld = { live: new Set(['service:notesapi', 'service:notesfiles']), failure: null, checked: [] }
			const audits: AuditRecord[] = []
			const auth: AuthContext = {
				ok: true,
				principal: { id: 'operator', type: 'user', label: 'operator@test' },
				can: () => true,
				scopedTo: () => null,
				audit: (event) => {
					audits.push(event)
					return Promise.resolve()
				},
			}
			const deps: ControlRpcDeps = {
				repositories: db,
				auth,
				queue: { send: () => Promise.resolve() },
				logs: { get: () => Promise.resolve(null) },
				provider: provider(resources, withCheck),
				cancelRun: () => Promise.resolve(),
			}
			await db.registry.createDeploymentNamespace({
				id: 'dev',
				env: 'dev',
				provider: 'harbor',
				exclusiveAppId: null,
				providerTargetJson: JSON.stringify(target('project-1')),
				state: 'ready',
			})
			await db.registry.createNamespaceResourceClaim({ namespaceId: 'dev', resourceKey: 'service:proxy', ownerAppId: null, ownerEnv: null })
			await db.registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes' })
			const registered = await rpcResult(
				rpcRequest('apps.environments.put', {
					appId: 'notes',
					env: 'dev',
					environment: {
						namespaceId: 'dev',
						target: target('project-1'),
						artifact: { provider: 'harbor', version: 1, payload: { image: 'registry.example/notes:v1' } },
					},
				}),
				deps,
			)
			expect(registered.status).toBe(200)
			const call = (method: string, input: unknown, as: ControlRpcDeps = deps) => rpcResult(rpcRequest(method, input), as)
			const release = (as: ControlRpcDeps = deps) => call('namespaces.releaseClaims', { namespaceId: 'dev', appId: 'notes', env: 'dev' }, as)
			const claims = async () => (await db.registry.listNamespaceResourceClaims('dev')).map((claim) => claim.resource_key)
			return { db, deps, resources, audits, call, release, claims }
		}

		test('refuses while a claimed resource still exists, naming it, and releases nothing', async () => {
			const w = await world()
			w.resources.live.delete('service:notesfiles')

			const refused = await w.release()

			expect(refused.status).toBe(409)
			expect(await refused.json()).toEqual({
				error: 'app env notes/dev still has service:notesapi in deployment namespace dev; delete it at the provider first, fabrika deletes none',
			})
			expect(w.resources.checked).toEqual([['service:notesapi', 'service:notesfiles']])
			expect(await w.claims()).toEqual(['service:notesapi', 'service:notesfiles', 'service:proxy'])
			expect(w.audits.filter((audit) => audit.action === 'namespace.claims.release')).toEqual([])
		})

		test('once the provider confirms every resource gone, releases the claims, audits it, and the env and namespace delete', async () => {
			const w = await world()
			expect((await w.call('apps.environments.delete', { appId: 'notes', env: 'dev' })).status).toBe(409)
			w.resources.live.clear()

			const released = await w.release()

			expect(released.status).toBe(200)
			expect(await released.json()).toEqual({ released: ['service:notesapi', 'service:notesfiles'] })
			// The namespace's own reservation is not the owner's to release.
			expect(await w.claims()).toEqual(['service:proxy'])
			expect(w.audits.at(-1)).toEqual(expect.objectContaining({
				action: 'namespace.claims.release',
				resourceId: 'dev',
				metadata: expect.objectContaining({ appId: 'notes', env: 'dev', released: ['service:notesapi', 'service:notesfiles'] }),
			}))

			expect((await w.call('apps.environments.delete', { appId: 'notes', env: 'dev' })).status).toBe(200)
			expect((await w.call('namespaces.remove', { namespaceId: 'dev' })).status).toBe(200)
			expect(await w.db.registry.getDeploymentNamespace('dev')).toBeNull()
		})

		test('a read-back that fails releases nothing and says why', async () => {
			const w = await world()
			w.resources.live.clear()
			w.resources.failure = new ProviderNamespaceError('zerops: get project failed (403)', 'insufficientPermissions', false)

			const failed = await w.release()

			expect(failed.status).toBe(502)
			const body: { error: string } = await failed.json()
			expect(body.error).toContain('could not confirm that the claimed resources are gone')
			expect(body.error).toContain('get project failed (403)')
			expect(await w.claims()).toEqual(['service:notesapi', 'service:notesfiles', 'service:proxy'])
		})

		test('refuses while another operation holds the namespace lease, such as a deploy into it', async () => {
			const w = await world()
			w.resources.live.clear()
			const held = await acquireLease(w.db.registry.namespaceLocks(), namespaceLeaseKey('dev'))
			expect(held).not.toBeNull()

			const refused = await w.release()

			expect(refused.status).toBe(409)
			expect(w.resources.checked).toEqual([])
			expect(await w.claims()).toEqual(['service:notesapi', 'service:notesfiles', 'service:proxy'])
			await held?.release()
		})

		test('requires namespace.manage, answers 404 for an owner with no claim, and 409 for a provider that cannot check', async () => {
			const w = await world()
			w.resources.live.clear()
			const denied: ControlRpcDeps = { ...w.deps, auth: { ...w.deps.auth, can: (action) => action !== 'namespace.manage' } }
			expect((await w.release(denied)).status).toBe(403)
			expect((await w.call('namespaces.releaseClaims', { namespaceId: 'dev', appId: 'notes', env: 'prod' })).status).toBe(404)
			expect((await w.call('namespaces.releaseClaims', { namespaceId: 'missing', appId: 'notes', env: 'dev' })).status).toBe(404)
			expect(await w.claims()).toEqual(['service:notesapi', 'service:notesfiles', 'service:proxy'])
		})

		test('a provider without a read-back releases no claim', async () => {
			const w = await world(false)
			const refused = await w.release()
			expect(refused.status).toBe(409)
			expect(await refused.json()).toEqual({ error: 'provider harbor cannot confirm that a claimed resource is gone, so it releases no claim' })
		})
	})
}
