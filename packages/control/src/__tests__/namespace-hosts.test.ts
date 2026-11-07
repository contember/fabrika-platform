// A namespace's entry point routes each host to one member. An environment put that would route a member on a host a
// sibling is already routed on is refused before the provider is asked for anything; a member the entry point does not
// route on its domain (no approved contract, or a dev member, routed only through its workspace sandboxes) holds no host.

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
		expect(error.message).toBe('host shop.example.com is already routed to shop/live in deployment namespace apps-live')
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

	test('a member the proxy does not route shares a routed sibling host, in either direction', async () => {
		const w = await world()
		await w.member('shop', 'live', 'shop.example.com', { published: true })
		const put = (appId: string, domain: string, artifact = ARTIFACT) =>
			putAppEnvUseCase(w.context, appId, 'live', { namespaceId: 'apps-live', domain, target: envelope({}), artifact })

		// Not published yet, so the proxy routes nothing for it.
		await put('other', 'SHOP.example.com')
		// A published member moving onto the host of a sibling the proxy does not route.
		await w.member('plain', 'live', 'plain.example.com', { published: false })
		await put('shop', 'plain.example.com')
		await publish(w.d1, 'other', 'live')
		// A published member without a proxy target holds no host, while the routed sibling holds it.
		await put('shop', 'shop.example.com', envelope({ proxy: false }))
		expect(w.prepared).toEqual(['other/live', 'shop/live', 'shop/live'])
		expect((await refusal(put('shop', 'shop.example.com'))).message).toBe(
			'host shop.example.com is already routed to other/live in deployment namespace apps-live',
		)
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
