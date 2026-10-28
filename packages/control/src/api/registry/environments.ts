import type { AppEnvDto, ListResponse, OkResponse, PutAppEnvRequest, RotateTokenKeyResponse } from '@fabrika/control-contract'
import type { ControlProvider, ProviderApp, ProviderRegistration } from '@fabrika/provider-contract'
import { requireHumanForProtectedDelete } from '../../approval/human'
import {
	AppEnvChangedError,
	appEnvCrossOrigins,
	type AppEnvExpectation,
	type AppEnvRow,
	AppEnvTriggerRefConflictError,
	type AppRow,
	NamespaceResourceClaimConflictError,
} from '../../db'
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
import { assertAppEnvironmentPart, assertCrossOrigins, assertProxyDomain, canonicalOrigin, triggerRefInput } from './validation'

export async function listAppEnvsUseCase(c: RegistryUseCaseContext, appId: string): Promise<ListResponse<AppEnvDto>> {
	await requireApp(c, appId)
	return { items: (await c.repositories.registry.listAppEnvs(appId)).map(toAppEnvDto) }
}

export async function putAppEnvUseCase(c: RegistryUseCaseContext, appId: string, env: string, input: PutAppEnvRequest): Promise<AppEnvDto> {
	const app = await requireApp(c, appId)
	assertAppEnvironmentPart('environment', env)
	assertProxyDomain(input.domain)
	const triggerRef = triggerRefInput(input.triggerRef)
	const existing = await c.repositories.registry.getAppEnv(appId, env)
	// Omitted keeps the stored list, which the new domain may now collide with, so the list in effect is what is judged.
	assertCrossOrigins(input.crossOrigins ?? (existing === null ? [] : appEnvCrossOrigins(existing)), input.domain ?? null)
	if (input.kind !== undefined && existing !== null && input.kind !== existing.kind) {
		fail(409, `environment ${env} is ${existing.kind}; an environment's kind is set when it is created`)
	}
	const kind = existing?.kind ?? input.kind ?? 'standard'
	if (kind === 'dev') await assertDevEnvironment(c, app, env, existing, input.authoring === true, triggerRef, input.domain ?? null)
	if (input.authoring === true) {
		assertAuthoringTarget(c.provider, app)
		// ADR-0049: one stage environment per app.
		const other = (await c.repositories.registry.listAppEnvs(appId)).find((row) => row.authoring === 1 && row.env !== env)
		if (other !== undefined) fail(409, `app ${appId} already authors environment ${other.env}; clear its authoring flag first`)
	}
	await assertTriggerRefFree(c, appId, env, triggerRef)
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
			...(kind === 'dev' ? { kind } : {}),
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
		...(input.crossOrigins === undefined ? {} : { crossOrigins: input.crossOrigins }),
		triggerRef,
		...(input.authoring === undefined ? {} : { authoring: input.authoring }),
		kind,
		namespaceId: registration.environment.namespace?.id ?? null,
		provider: c.provider.id,
		providerTargetJson: JSON.stringify(registration.environment.target),
		providerArtifactJson: JSON.stringify(registration.environment.artifact),
	}
	// Every check above read `existing`; the write applies only while the environment is still that one (ADR-0050).
	const expected: AppEnvExpectation = existing === null ? { absent: true } : { generation: existing.generation }
	let row: AppEnvRow
	try {
		row = registration.environment.namespace === undefined
			? await c.repositories.registry.upsertAppEnv(persistence, expected)
			: (await c.repositories.registry.upsertAppEnvWithNamespaceResourceClaims(persistence, resourceClaims, expected)).appEnv
	} catch (cause) {
		if (cause instanceof NamespaceResourceClaimConflictError) fail(409, cause.message)
		if (cause instanceof AppEnvChangedError) fail(409, `${cause.message}; retry`)
		if (cause instanceof AppEnvTriggerRefConflictError) fail(409, cause.message)
		throw cause
	}
	await c.auth.audit({
		action: 'app.env.upsert',
		resourceType: 'app_env',
		resourceId: `${appId}/${env}`,
		metadata: {
			triggerRef,
			kind: row.kind,
			...(input.authoring === undefined ? {} : { authoring: input.authoring }),
			...(input.crossOrigins === undefined ? {} : { crossOrigins: input.crossOrigins }),
			namespaceId: row.namespace_id,
			previousNamespaceId: existing?.namespace_id ?? null,
		},
	})
	notifyCatalogChanged(c)
	// The manifest carries the host, the namespace, the artifact's `upstream` and the cross-origin list, and this call
	// rewrites all four. A MOVE touches both proxies: the one losing the host and the one gaining it.
	if (
		(existing?.domain ?? null) !== row.domain
		|| (existing?.cross_origins_json ?? '[]') !== row.cross_origins_json
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

/**
 * An app's environments deploy on distinct trigger refs. Checked before the provider prepares anything, because
 * preparation creates provider services; the write repeats the check for a concurrent put.
 */
async function assertTriggerRefFree(c: RegistryUseCaseContext, appId: string, env: string, triggerRef: string | null): Promise<void> {
	if (triggerRef === null) return
	const holder = await c.repositories.registry.getAppEnvByTriggerRef(appId, triggerRef)
	if (holder !== null && holder.env !== env) fail(409, new AppEnvTriggerRefConflictError(appId, env, triggerRef, holder.env).message)
}

export async function deleteAppEnvUseCase(c: RegistryUseCaseContext, appId: string, env: string): Promise<OkResponse> {
	assertNoHeldResourceClaims(`app env ${appId}/${env}`, await c.repositories.registry.listNamespaceResourceClaimsForApp(appId, env))
	const existing = await c.repositories.registry.getAppEnv(appId, env)
	requireHumanForProtectedDelete(c.auth, c.admission, existing === null ? [] : [existing])
	if (existing === null) fail(404, 'app env not found')
	const routed = existing.namespace_id
	try {
		// At the generation whose protection was checked: a protection change in between refuses the delete.
		if (!(await c.repositories.registry.deleteAppEnv(appId, env, existing.generation))) fail(404, 'app env not found')
	} catch (cause) {
		if (cause instanceof AppEnvChangedError) fail(409, `${cause.message}; retry`)
		throw cause
	}
	await c.auth.audit({ action: 'app.env.delete', resourceType: 'app_env', resourceId: `${appId}/${env}` })
	notifyCatalogChanged(c)
	await syncChangedNamespaceProxies(c.namespaceProxyChanged, routed === null ? [] : [routed])
	return { ok: true }
}

/**
 * Asks the environment's next deploy to rotate the key its signed tokens are signed with. The retired key keeps verifying
 * until the last token it signed may expire; a platform upgrade rotates nothing. `requested` is `false` when the
 * environment has not deployed a contract with a token purpose yet, so it has no key to rotate.
 */
export async function rotateTokenKeyUseCase(c: RegistryUseCaseContext, appId: string, env: string, now: number): Promise<RotateTokenKeyResponse> {
	if ((await c.repositories.registry.getAppEnv(appId, env)) === null) fail(404, 'app env not found')
	const requested = await c.repositories.tokenKeys.requestRotation(appId, env, now)
	await c.auth.audit({ action: 'app.env.token_key.rotate', resourceType: 'app_env', resourceId: `${appId}/${env}` })
	return { requested }
}

/** ADR-0049: only a provider that declares authoring, and Source reaches the repository only through the app's GitHub connection. */
function assertAuthoringTarget(provider: ControlProvider, app: AppRow): void {
	if (provider.authoring === undefined) fail(409, `a ${provider.id} environment cannot be an authoring target`)
	if (app.github_connection_id === null || app.github_installation_id === null) {
		fail(409, 'only an environment of an app with a GitHub connection can be an authoring target')
	}
}

/**
 * ADR-0049: one `dev` environment per app, on a provider that runs one, for an app whose workspaces Control can read.
 * It is never production, never protected (ADR-0050), never an authoring target, and deploys only through `bind_dev`.
 * Where each workspace gets its own sandbox, served at `<workspace id>.<domain>`, its domain is that wildcard base.
 */
async function assertDevEnvironment(
	c: RegistryUseCaseContext,
	app: AppRow,
	env: string,
	existing: AppEnvRow | null,
	authoring: boolean,
	triggerRef: string | null,
	domain: string | null,
): Promise<void> {
	if (c.provider.devSandboxes === undefined && c.provider.devEnvironments === undefined) {
		fail(409, `the ${c.provider.id} provider runs no dev environment; it runs on Zerops only`)
	}
	if (c.provider.devSandboxes !== undefined && (domain === null || domain === '')) {
		fail(409, 'a dev environment serves each workspace at <workspace id>.<domain>, so it needs a domain: the wildcard base, such as dev.example.com')
	}
	if (app.github_connection_id === null || app.github_installation_id === null) {
		fail(409, 'a dev environment follows a workspace, so its app needs a GitHub connection')
	}
	if (env === 'prod') fail(409, 'a dev environment is never production; give it another name, such as dev')
	if (authoring) fail(409, "a dev environment is not an authoring target: bind_dev binds a workspace of the app's authoring environment to it")
	if (triggerRef !== null) fail(409, 'a dev environment deploys only through bind_dev, so it has no trigger ref')
	if (existing === null && (await c.repositories.registry.getKeptProtection(app.id, env)) === 1) {
		fail(409, `environment ${env} was protected before it was deleted, and a dev environment never is; give it another name`)
	}
	const other = (await c.repositories.registry.listAppEnvs(app.id)).find((row) => row.kind === 'dev' && row.env !== env)
	if (other !== undefined) fail(409, `app ${app.id} already has the dev environment ${other.env}`)
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
