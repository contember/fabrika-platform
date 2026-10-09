import type { AppEnvDto, ListResponse, OkResponse, PutAppEnvRequest } from '@fabrika/control-contract'
import type { ProviderApp, ProviderRegistration } from '@fabrika/provider-contract'
import { requireHumanForProtectedDelete } from '../../approval/human'
import { type AppEnvRow, type AppRow, NamespaceResourceClaimConflictError } from '../../db'
import { fail } from '../domain'
import { syncChangedNamespaceProxies } from '../namespaces'
import { assertNoHeldResourceClaims, requireApp } from './apps'
import { notifyCatalogChanged, type RegistryUseCaseContext } from './context'
import {
	normalizeRegistration,
	preparationFailure,
	prepareRegistration,
	registrationResourceClaims,
	resolveRegistrationNamespace,
	toAppEnvDto,
} from './registration'
import { assertAppEnvironmentPart, assertProxyDomain, canonicalOrigin } from './validation'

export async function listAppEnvsUseCase(c: RegistryUseCaseContext, appId: string): Promise<ListResponse<AppEnvDto>> {
	await requireApp(c, appId)
	return { items: (await c.repositories.registry.listAppEnvs(appId)).map(toAppEnvDto) }
}

export async function putAppEnvUseCase(c: RegistryUseCaseContext, appId: string, env: string, input: PutAppEnvRequest): Promise<AppEnvDto> {
	const app = await requireApp(c, appId)
	assertAppEnvironmentPart('environment', env)
	assertProxyDomain(input.domain)
	const existing = await c.repositories.registry.getAppEnv(appId, env)
	if (input.authoring === true) {
		assertAuthoringTarget(c.provider.id, app)
		// ADR-0049: one stage environment per app.
		const other = (await c.repositories.registry.listAppEnvs(appId)).find((row) => row.authoring === 1 && row.env !== env)
		if (other !== undefined) fail(409, `app ${appId} already authors environment ${other.env}; clear its authoring flag first`)
	}
	const publicOrigin = canonicalOrigin(input.publicOrigin, existing?.public_origin ?? null)
	const namespace = await resolveRegistrationNamespace(c, input.namespaceId, appId, env, existing)
	const nextNamespaceId = namespace?.id ?? null
	if (existing?.namespace_id !== nextNamespaceId) {
		if (await c.repositories.registry.hasInFlightRun(appId, env)) fail(409, 'deployment namespace cannot change while a deploy is in progress')
		if (await c.repositories.registry.hasSuccessfulRun(appId, env)) fail(409, 'deployment namespace cannot change after a successful deploy')
	}
	const requested: ProviderRegistration = {
		app: toProviderApp(app),
		environment: {
			appId,
			env,
			...(input.domain === undefined || input.domain === null ? {} : { domain: input.domain }),
			...(publicOrigin === null ? {} : { publicOrigin }),
			...(namespace === undefined ? {} : { namespace }),
			target: input.target,
			artifact: input.artifact,
		},
	}
	// Claimed from the REQUESTED registration, before the provider is called at all — the same order
	// `register` uses. A registration the provider refuses on its face — a proxy target with no domain —
	// must not reach `prepareRegistration`, which creates provider services.
	const resourceClaims = registrationResourceClaims(c.provider, requested)
	const preparation = c.provider.namespaces?.prepareRegistration
	let registration: ProviderRegistration
	if (preparation === undefined) {
		registration = normalizeRegistration(c.provider, requested.app, requested.environment)
	} else {
		// Unlike `register`, nothing has been written yet, so a refusal here leaves the environment as it
		// was and there is nothing to roll back.
		try {
			registration = await prepareRegistration(c, preparation, requested)
		} catch (cause) {
			return fail(502, preparationFailure(cause))
		}
	}
	const persistence = {
		appId,
		env,
		domain: registration.environment.domain ?? null,
		publicOrigin: registration.environment.publicOrigin ?? null,
		triggerRef: input.triggerRef ?? null,
		...(input.authoring === undefined ? {} : { authoring: input.authoring }),
		namespaceId: registration.environment.namespace?.id ?? null,
		provider: c.provider.id,
		providerTargetJson: JSON.stringify(registration.environment.target),
		providerArtifactJson: JSON.stringify(registration.environment.artifact),
	}
	let row: AppEnvRow
	try {
		row = registration.environment.namespace === undefined
			? await c.repositories.registry.upsertAppEnv(persistence)
			: (await c.repositories.registry.upsertAppEnvWithNamespaceResourceClaims(persistence, resourceClaims)).appEnv
	} catch (cause) {
		if (cause instanceof NamespaceResourceClaimConflictError) fail(409, cause.message)
		throw cause
	}
	await c.auth.audit({
		action: 'app.env.upsert',
		resourceType: 'app_env',
		resourceId: `${appId}/${env}`,
		metadata: {
			triggerRef: input.triggerRef ?? null,
			...(input.authoring === undefined ? {} : { authoring: input.authoring }),
			namespaceId: row.namespace_id,
			previousNamespaceId: existing?.namespace_id ?? null,
		},
	})
	notifyCatalogChanged(c)
	// The manifest carries the host, the namespace, and the artifact's own `upstream` + `gates` — and this
	// call rewrites all three. A MOVE touches both proxies: the one losing the host and the one gaining it.
	if (
		(existing?.domain ?? null) !== row.domain
		|| (existing?.namespace_id ?? null) !== row.namespace_id
		|| existing?.provider_artifact_json !== persistence.providerArtifactJson
	) {
		await syncChangedNamespaceProxies(
			c.namespaceProxyChanged,
			[existing?.namespace_id ?? null, row.namespace_id].filter((id): id is string => id !== null),
		)
	}
	return toAppEnvDto(row)
}

export async function deleteAppEnvUseCase(c: RegistryUseCaseContext, appId: string, env: string): Promise<OkResponse> {
	assertNoHeldResourceClaims(`app env ${appId}/${env}`, await c.repositories.registry.listNamespaceResourceClaimsForApp(appId, env))
	const existing = await c.repositories.registry.getAppEnv(appId, env)
	requireHumanForProtectedDelete(c.auth, c.admission, existing === null ? [] : [existing])
	const routed = existing?.namespace_id ?? null
	if (!(await c.repositories.registry.deleteAppEnv(appId, env))) fail(404, 'app env not found')
	await c.auth.audit({ action: 'app.env.delete', resourceType: 'app_env', resourceId: `${appId}/${env}` })
	notifyCatalogChanged(c)
	await syncChangedNamespaceProxies(c.namespaceProxyChanged, routed === null ? [] : [routed])
	return { ok: true }
}

/** ADR-0049: authoring is Zerops-only, and Source can reach the repository only through the app's GitHub connection. */
function assertAuthoringTarget(provider: string, app: AppRow): void {
	if (provider !== 'zerops' || app.github_connection_id === null || app.github_installation_id === null) {
		fail(409, 'only a Zerops environment of an app with a GitHub connection can be an authoring target')
	}
}

const toProviderApp = (row: AppRow): ProviderApp => ({
	id: row.id,
	source: {
		repoUrl: row.repo_url,
		ref: row.default_branch,
		...(row.worker_dir === null ? {} : { workerDir: row.worker_dir }),
		...(row.build_cmd === null ? {} : { buildCommand: row.build_cmd }),
		...(row.config_path === null ? {} : { configPath: row.config_path }),
	},
})
