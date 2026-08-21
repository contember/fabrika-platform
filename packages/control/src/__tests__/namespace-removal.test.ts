// A failed namespace can be removed (backlog 73). Before this, a namespace whose provisioning failed
// held its id for ever: `create` refuses a duplicate id with 409, so a retry had to invent a second
// name — and a second id STRANDS the project the first attempt may already have created, because the
// marker-based recovery that would re-adopt it is keyed to the original id.
//
// Removal is the narrow case only. It frees the id and releases the reservations; it deletes no
// provider resource, and the answer names what is left behind (ADR-0034).

import type { AuthContext } from '@fabrika/auth'
import type { ControlProvider, ProviderDeploymentNamespace, ProviderEnvelope } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { runNamespaceJob } from '../api/namespaces'
import { type ApiDeps, handleApi } from '../api/router'
import type { ControlRepositories } from '../db'
import { FakeRepoSource } from '../repo-source'
import type { ControlJobMessage } from '../run-lifecycle'
import { createHarness } from './helpers/harness'
import { makeFakeLock } from './helpers/lock'

const target = (projectId: string): ProviderEnvelope => ({ provider: 'harbor', version: 1, payload: { projectId } })

const provider = (): ControlProvider => ({
	id: 'harbor',
	normalizeRegistration: (input) => input,
	deploy: () => Promise.resolve({ state: 'succeeded' }),
	namespaces: {
		normalize: (namespace: ProviderDeploymentNamespace) => namespace,
		namespaceResourceClaims: () => ['service:proxy'],
		registrationResourceClaims: (registration) => [`service:${registration.app.id}`],
		provision: (input) => Promise.resolve(input.namespace),
		reconcile: (input) => Promise.resolve(input.namespace),
		operator: {
			presets: [{ id: 'shared', label: 'Shared', description: 'Shared test namespace.', requiresExclusiveApp: false }],
			plan: (input) => ({
				namespace: { id: input.id, env: input.env, target: target('project-1') },
				presentation: { preset: input.preset, title: 'Planned', facts: [], instructions: [] },
			}),
			present: (namespace) => ({
				preset: 'shared',
				title: 'Test namespace',
				facts: [{ label: 'Project', value: String(Reflect.get(Object(namespace.target.payload), 'projectId')) }],
				instructions: ['Delete the project by hand if it is no longer wanted.'],
			}),
		},
	},
})

interface AuditRecord {
	action: string
	resourceId?: string
	metadata?: unknown
}

interface Harness {
	deps: ApiDeps
	db: ControlRepositories
	audits: AuditRecord[]
	sent: ControlJobMessage[]
	drain(): Promise<Array<{ namespaceId: string; status: string }>>
}

function makeHarness(): Harness {
	const { db } = createHarness()
	const audits: AuditRecord[] = []
	const sent: ControlJobMessage[] = []
	const control = provider()
	const lock = makeFakeLock()
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
	return {
		db,
		audits,
		sent,
		deps: {
			repositories: db,
			auth,
			queue: {
				send(message) {
					sent.push(message)
					return Promise.resolve()
				},
			},
			logs: { get: () => Promise.resolve(null) },
			repoSource: new FakeRepoSource(),
			provider: control,
			cancelRun: () => Promise.resolve(),
		},
		async drain() {
			const results: Array<{ namespaceId: string; status: string }> = []
			for (const message of sent.splice(0)) {
				if (message.kind !== 'namespace') continue
				results.push(await runNamespaceJob({ repositories: db, provider: control, lock }, message))
			}
			return results
		},
	}
}

const request = (method: string, path: string, body?: unknown): Request =>
	new Request(`https://control.test/api${path}`, {
		method,
		...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
	})

const createNamespace = async (harness: Harness, id: string): Promise<Response> =>
	handleApi(request('POST', '/namespaces', { id, env: 'prod', target: target('project-1') }), harness.deps)

describe('deployment namespace removal', () => {
	test('frees the id of a failed namespace, releases its claims, and audits the removal', async () => {
		const harness = makeHarness()
		expect((await createNamespace(harness, 'apps-prod')).status).toBe(201)
		await harness.db.registry.updateDeploymentNamespace({
			id: 'apps-prod',
			providerTargetJson: JSON.stringify(target('project-1')),
			state: 'failed',
			lastError: 'insufficientPermissions: zerops: project import failed (403)',
		})
		harness.sent.splice(0)

		const removed = await handleApi(request('DELETE', '/namespaces/apps-prod'), harness.deps)

		expect(removed.status).toBe(200)
		const body: { removed: { id: string; state: string; lastErrorCode: string | null } } = await removed.json()
		expect(body.removed).toMatchObject({ id: 'apps-prod', state: 'failed', lastErrorCode: 'insufficientPermissions' })
		expect(await harness.db.registry.getDeploymentNamespace('apps-prod')).toBeNull()
		expect(await harness.db.registry.listNamespaceResourceClaims('apps-prod')).toEqual([])
		// The audit is written from the row the DELETE returned, and carries the credential-free provider
		// target — without it the trail cannot answer what the removal orphaned.
		expect(harness.audits.at(-1)).toEqual(expect.objectContaining({
			action: 'namespace.remove',
			resourceId: 'apps-prod',
			metadata: expect.objectContaining({ state: 'failed', target: { provider: 'harbor', version: 1, payload: { projectId: 'project-1' } } }),
		}))

		// The whole point: the SAME name is usable again, so a retry reuses the id its recovery is keyed to.
		expect((await createNamespace(harness, 'apps-prod')).status).toBe(201)
	})

	test('answers from the row the delete returned, not from the read before it', async () => {
		const harness = makeHarness()
		await createNamespace(harness, 'apps-prod')
		await harness.drain()
		// The read the use case starts from is `ready`; so is the row the statement removes. What is proven
		// here is that the ANSWER and the audit are the same object — one description of one removal.
		const removed = await handleApi(request('DELETE', '/namespaces/apps-prod'), harness.deps)
		const body: { removed: { id: string; state: string; createdAt: number } } = await removed.json()

		expect(harness.audits.at(-1)?.metadata).toEqual(expect.objectContaining({ state: body.removed.state }))
		expect(body.removed.createdAt).toBeGreaterThan(0)
	})

	test('names the provider resources it will not delete', async () => {
		const harness = makeHarness()
		await createNamespace(harness, 'apps-prod')
		await harness.drain()

		const removed = await handleApi(request('DELETE', '/namespaces/apps-prod'), harness.deps)

		expect(removed.status).toBe(200)
		const body: {
			removed: { state: string; target: { payload: { projectId: string } }; presentation: { facts: Array<{ label: string; value: string }> } }
		} = await removed.json()
		expect(body.removed.state).toBe('ready')
		expect(body.removed.target.payload.projectId).toBe('project-1')
		expect(body.removed.presentation.facts).toContainEqual({ label: 'Project', value: 'project-1' })
	})

	test('refuses while an app environment is registered, naming the app', async () => {
		const harness = makeHarness()
		await createNamespace(harness, 'apps-prod')
		await harness.drain()
		await harness.db.registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes' })
		const registered = await handleApi(
			request('PUT', '/apps/notes/envs/prod', {
				namespaceId: 'apps-prod',
				target: target('project-1'),
				artifact: { provider: 'harbor', version: 1, payload: { image: 'registry.example/notes:v1' } },
			}),
			harness.deps,
		)
		expect(registered.status).toBe(200)

		const refused = await handleApi(request('DELETE', '/namespaces/apps-prod'), harness.deps)

		expect(refused.status).toBe(409)
		const refusal: { error: string } = await refused.json()
		expect(refusal).toEqual({ error: 'deployment namespace is registered to notes' })
		expect(await harness.db.registry.getDeploymentNamespace('apps-prod')).not.toBeNull()
		// A refused removal must not have released the reservations it left in place.
		expect((await harness.db.registry.listNamespaceResourceClaims('apps-prod')).map((claim) => claim.resource_key)).toEqual([
			'service:notes',
			'service:proxy',
		])
	})

	test('refuses a namespace a worker is still settling', async () => {
		const harness = makeHarness()
		await createNamespace(harness, 'apps-prod')
		await harness.db.registry.updateDeploymentNamespace({
			id: 'apps-prod',
			providerTargetJson: JSON.stringify(target('project-1')),
			state: 'provisioning',
			lastError: null,
		})

		const refused = await handleApi(request('DELETE', '/namespaces/apps-prod'), harness.deps)

		expect(refused.status).toBe(409)
		const refusal: { error: string } = await refused.json()
		expect(refusal).toEqual({ error: 'deployment namespace provisioning is in progress' })
		expect((await harness.db.registry.listNamespaceResourceClaims('apps-prod')).map((claim) => claim.resource_key)).toEqual(['service:proxy'])
	})

	test('answers 404 for an unknown namespace and 409 for another provider', async () => {
		const harness = makeHarness()
		await harness.db.registry.createDeploymentNamespace({
			id: 'foreign-prod',
			env: 'prod',
			provider: 'other',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify({ provider: 'other', version: 1, payload: {} }),
			state: 'ready',
		})

		expect((await handleApi(request('DELETE', '/namespaces/missing'), harness.deps)).status).toBe(404)
		expect((await handleApi(request('DELETE', '/namespaces/foreign-prod'), harness.deps)).status).toBe(409)
	})

	test('a queued job whose namespace was removed is a no-op', async () => {
		const harness = makeHarness()
		await createNamespace(harness, 'apps-prod')
		expect((await handleApi(request('DELETE', '/namespaces/apps-prod'), harness.deps)).status).toBe(200)

		expect(await harness.drain()).toEqual([{ namespaceId: 'apps-prod', status: 'skipped' }])
	})

	test('requires namespace.manage', async () => {
		const harness = makeHarness()
		await createNamespace(harness, 'apps-prod')
		const denied: ApiDeps = { ...harness.deps, auth: { ...harness.deps.auth, can: (action) => action !== 'namespace.manage' } }

		expect((await handleApi(request('DELETE', '/namespaces/apps-prod'), denied)).status).toBe(403)
	})
})
