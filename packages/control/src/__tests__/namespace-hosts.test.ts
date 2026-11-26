// A namespace's entry point routes each host to one member. An environment put that names a domain another environment
// of the installation holds is refused before the provider is asked for anything, routed or not, in any namespace. Only
// the dev members of several applications share one wildcard base: each is routed only through its workspaces' hosts.

import { type SqlDatabase, uuidv7 } from '@fabrika/platform'
import type { ControlProvider, ProviderEnvelope, ProviderNamespaceMemberRouting } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { ControlApiError } from '../api/domain'
import { putAppEnvUseCase } from '../api/registry/environments'
import { createHarness } from './helpers/harness'
import { CONNECTION_ID, INSTALLATION_ID, registryContext, seedWorkspaceWorld, zeropsProvider } from './helpers/workspaces'

const envelope = (payload: Record<string, boolean>): ProviderEnvelope => ({ provider: 'zerops', version: 1, payload })
const ARTIFACT = envelope({ proxy: true })

/** Zerops' routing rule (`namespaceMemberHosts`, pinned against its manifest compiler in provider-zerops). */
const memberHosts = (member: ProviderNamespaceMemberRouting): string[] => {
	if (member.devSandboxes !== undefined) return member.devSandboxes.map((sandbox) => sandbox.host.toLowerCase())
	const payload = member.artifact.payload
	const proxy = typeof payload === 'object' && payload !== null && !Array.isArray(payload) && payload.proxy === true
	return member.access === undefined || !proxy || member.domain === undefined ? [] : [member.domain.toLowerCase()]
}

function namespacedProvider(prepared: string[]): ControlProvider {
	return {
		...zeropsProvider,
		devSandboxes: {
			admit: () => {},
			ensure: () => Promise.reject(new Error('not expected')),
			park: () => Promise.resolve(),
			wake: () => Promise.resolve(),
			remove: () => Promise.resolve(),
		},
		namespaces: {
			normalize: (namespace) => namespace,
			namespaceResourceClaims: () => ['service:proxy'],
			registrationResourceClaims: (registration) => registration.environment.kind === 'dev' ? [] : [`service:${registration.app.id}`],
			prepareRegistration: (input) => {
				prepared.push(`${input.registration.app.id}/${input.registration.environment.env}`)
				return Promise.resolve(input.registration)
			},
			memberHosts,
			provision: (input) => Promise.resolve(input.namespace),
			reconcile: (input) => Promise.resolve(input.namespace),
		},
	}
}

async function world() {
	const harness = createHarness()
	const repositories = harness.repositories
	await seedWorkspaceWorld(repositories, harness.d1)
	await repositories.registry.createApp({
		id: 'other',
		repoUrl: 'github.com/acme/other',
		defaultBranch: 'main',
		githubConnectionId: CONNECTION_ID,
		githubInstallationId: INSTALLATION_ID,
	})
	for (const env of ['live', 'dev']) {
		await repositories.registry.createDeploymentNamespaceWithResourceClaims({
			id: `apps-${env}`,
			env,
			provider: 'zerops',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify({ provider: 'zerops', version: 1, payload: {} }),
			state: 'ready',
		}, ['service:proxy'])
	}
	const prepared: string[] = []
	const context = registryContext(repositories, namespacedProvider(prepared))
	/** An environment already in its namespace; `published` gives it an approved contract, which the proxy routes. */
	const member = async (appId: string, env: string, domain: string, options: { kind?: 'dev'; published: boolean }) => {
		await repositories.registry.upsertAppEnvWithNamespaceResourceClaims({
			appId,
			env,
			domain,
			...(options.kind === undefined ? {} : { kind: options.kind }),
			namespaceId: `apps-${env}`,
			provider: 'zerops',
			providerTargetJson: JSON.stringify(envelope({})),
			providerArtifactJson: JSON.stringify(ARTIFACT),
		}, options.kind === 'dev' ? [] : [`service:${appId}`])
		if (options.published) await publish(harness.d1, appId, env)
	}
	return { repositories, d1: harness.d1, context, prepared, member }
}

async function publish(d1: SqlDatabase, appId: string, env: string): Promise<void> {
	const snapshot = JSON.stringify({ version: 1, contract: notesArtifact, migrations: [], checker: '0.9.0' })
	await d1
		.prepare('UPDATE app_envs SET published_run_id = ?, published_snapshot_json = ? WHERE app_id = ? AND env = ?')
		.bind(uuidv7(), snapshot, appId, env)
		.run()
}

const HELD = (domain: string): string =>
	`domain ${domain} is already held by another application environment; a domain serves one environment of the installation`

async function refusal(promise: Promise<unknown>): Promise<ControlApiError> {
	try {
		await promise
	} catch (error) {
		if (error instanceof ControlApiError) return error
		throw error
	}
	throw new Error('expected a refusal')
}

describe('a namespace routes each host to one member', () => {
	test('a routed member cannot move onto a host a routed sibling holds, in any case', async () => {
		const w = await world()
		await w.member('shop', 'live', 'shop.example.com', { published: true })
		await w.member('other', 'live', 'other.example.com', { published: true })

		const error = await refusal(
			putAppEnvUseCase(w.context, 'other', 'live', { namespaceId: 'apps-live', domain: 'SHOP.example.com', target: envelope({}), artifact: ARTIFACT }),
		)

		expect(error.httpStatus).toBe(409)
		expect(error.message).toBe(HELD('SHOP.example.com'))
		expect(w.prepared).toEqual([])
		expect((await w.repositories.registry.getAppEnv('other', 'live'))?.domain).toBe('other.example.com')
		// Its own host, re-put, is still its own.
		await putAppEnvUseCase(w.context, 'other', 'live', {
			namespaceId: 'apps-live',
			domain: 'other.example.com',
			target: envelope({}),
			artifact: ARTIFACT,
		})
		expect(w.prepared).toEqual(['other/live'])
	})

	test('a member the proxy does not route cannot name a sibling host either, routed or not', async () => {
		const w = await world()
		await w.member('shop', 'live', 'shop.example.com', { published: true })
		await w.member('plain', 'live', 'plain.example.com', { published: false })
		const put = (appId: string, domain: string, artifact = ARTIFACT) =>
			putAppEnvUseCase(w.context, appId, 'live', { namespaceId: 'apps-live', domain, target: envelope({}), artifact })

		// Not published, so the proxy would route nothing for it: the domain is still held installation-wide.
		expect((await refusal(put('other', 'SHOP.example.com'))).message).toBe(HELD('SHOP.example.com'))
		// A published member moving onto the host of a sibling the proxy does not route.
		expect((await refusal(put('shop', 'plain.example.com'))).message).toBe(HELD('plain.example.com'))
		// A member without a proxy target holds its domain all the same.
		expect((await refusal(put('other', 'plain.example.com', envelope({ proxy: false })))).message).toBe(HELD('plain.example.com'))
		expect(w.prepared).toEqual([])
		expect(await w.repositories.registry.getAppEnv('other', 'live')).toBeNull()
		expect((await w.repositories.registry.getAppEnv('shop', 'live'))?.domain).toBe('shop.example.com')
	})

	test('a domain a member of another namespace holds is refused all the same', async () => {
		const w = await world()
		await w.member('shop', 'live', 'shop.example.com', { published: false })

		const error = await refusal(
			putAppEnvUseCase(w.context, 'other', 'dev', { namespaceId: 'apps-dev', domain: 'Shop.example.com', target: envelope({}), artifact: ARTIFACT }),
		)

		expect(error.httpStatus).toBe(409)
		expect(error.message).toBe(HELD('Shop.example.com'))
		expect(w.prepared).toEqual([])
		expect(await w.repositories.registry.getAppEnv('other', 'dev')).toBeNull()
	})

	test('a dev wildcard base holds every name under it against a standard environment, in either direction', async () => {
		const w = await world()
		await w.member('shop', 'dev', 'dev.example.com', { kind: 'dev', published: true })
		await w.member('plain', 'live', 'app.dev2.example.com', { published: false })
		const live = (domain: string) =>
			putAppEnvUseCase(w.context, 'other', 'live', { namespaceId: 'apps-live', domain, target: envelope({}), artifact: ARTIFACT })

		expect((await refusal(live('dev.example.com'))).message).toBe(HELD('dev.example.com'))
		expect((await refusal(live('0190a3f2-0000-7000-8000-000000000000.DEV.example.com'))).message).toBe(
			HELD('0190a3f2-0000-7000-8000-000000000000.DEV.example.com'),
		)
		// A dev base above a standard environment's domain would serve that name as a workspace host.
		const dev = await refusal(
			putAppEnvUseCase(w.context, 'other', 'dev', {
				namespaceId: 'apps-dev',
				kind: 'dev',
				domain: 'dev2.example.com',
				target: envelope({}),
				artifact: ARTIFACT,
			}),
		)
		expect(dev.message).toBe(HELD('dev2.example.com'))
		expect(w.prepared).toEqual([])
		// A name beside the base, not under it, is free.
		await live('notdev.example.com')
		expect(w.prepared).toEqual(['other/live'])
	})

	test('dev members share one wildcard base: each is routed only on its workspaces hosts', async () => {
		const w = await world()
		await w.member('shop', 'dev', 'dev.example.com', { kind: 'dev', published: true })
		await w.member('other', 'dev', 'other-dev.example.com', { kind: 'dev', published: true })

		await putAppEnvUseCase(w.context, 'other', 'dev', { namespaceId: 'apps-dev', domain: 'dev.example.com', target: envelope({}), artifact: ARTIFACT })

		expect((await w.repositories.registry.getAppEnv('other', 'dev'))?.domain).toBe('dev.example.com')
		expect(w.prepared).toEqual(['other/dev'])
	})
})
