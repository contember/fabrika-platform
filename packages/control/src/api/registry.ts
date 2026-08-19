import type { AuthContext } from '@fabrika/auth'
import type {
	AppDto,
	AppEnvDto,
	AppOptionalFields,
	AppSecretDto,
	AppVarDto,
	CreateAppRequest,
	ListResponse,
	OkResponse,
	PutAppEnvRequest,
	PutAppSecretRequest,
	PutAppVarRequest,
	RegisterAppRequest,
	RegisterAppResponse,
	UpdateAppRequest,
} from '@fabrika/control-contract'
import { operationsManagedEnvironmentCollisions } from '@fabrika/operations-contract/ingest'
import { FABRIKA_RELEASE } from '@fabrika/operations-contract/releases'
import type { ControlProvider, ProviderApp, ProviderDeploymentNamespace, ProviderEnvironment, ProviderRegistration } from '@fabrika/provider-contract'
import { type AppEnvRow, type AppRow, type AppSecretRow, type AppVarRow, type ControlRepositories, NamespaceResourceClaimConflictError } from '../db'
import { readJson } from '../http'
import type { Authorized } from '../iam'
import { booleanField, nullableStringField, numberField, prop, stringField } from '../json'
import { canonicalPublicOrigin, PublicOriginValidationError } from '../public-origin'
import { normalizeRepoUrl, parseGitHubRepo, type RepoEvents } from '../repo-source'
import { fail, jsonAdapter } from './domain'
import { parseStoredEnvelope, readProviderEnvelope } from './provider-envelope'

export interface RegistryContext {
	readonly repositories: ControlRepositories
	readonly request: Request
	readonly url: URL
	readonly repoSource: RepoEvents
	readonly provider: ControlProvider
	readonly authorized: Authorized
	readonly catalogChanged?: () => void
}

export interface RegistryUseCaseContext {
	readonly repositories: ControlRepositories
	readonly repoSource: RepoEvents
	readonly provider: ControlProvider
	readonly auth: AuthContext
	readonly signal: AbortSignal
	readonly catalogChanged?: () => void
}

function useCaseContext(c: RegistryContext): RegistryUseCaseContext {
	return {
		repositories: c.repositories,
		repoSource: c.repoSource,
		provider: c.provider,
		auth: c.authorized.auth,
		signal: c.request.signal,
		...(c.catalogChanged === undefined ? {} : { catalogChanged: c.catalogChanged }),
	}
}

function toAppDto(row: AppRow): AppDto {
	return {
		id: row.id,
		repoUrl: row.repo_url,
		defaultBranch: row.default_branch,
		workerDir: row.worker_dir,
		buildCmd: row.build_cmd,
		configPath: row.config_path,
		githubConnectionId: row.github_connection_id,
		githubInstallationId: row.github_installation_id,
		createdAt: row.created_at,
	}
}

function toAppEnvDto(row: AppEnvRow): AppEnvDto {
	return {
		appId: row.app_id,
		env: row.env,
		domain: row.domain,
		publicOrigin: row.public_origin,
		triggerRef: row.trigger_ref,
		namespaceId: row.namespace_id,
		provider: row.provider,
		target: parseStoredEnvelope(row.provider_target_json, `target for ${row.app_id}/${row.env}`),
		artifact: parseStoredEnvelope(row.provider_artifact_json, `artifact for ${row.app_id}/${row.env}`),
		createdAt: row.created_at,
	}
}

function toAppSecretDto(row: AppSecretRow): AppSecretDto {
	return { appId: row.app_id, env: row.env, name: row.name, valueRef: row.value_ref, createdAt: row.created_at }
}

function toAppVarDto(row: AppVarRow): AppVarDto {
	return { appId: row.app_id, env: row.env, name: row.name, value: row.value, createdAt: row.created_at }
}

const toProviderApp = (row: AppRow): ProviderApp => ({
	id: row.id,
	source: {
		repoUrl: row.repo_url,
		ref: row.default_branch,
		...(row.worker_dir === null ? {} : { workerDir: row.worker_dir }),
		...(row.build_cmd === null ? {} : { buildCommand: row.build_cmd }),
		...(row.config_path === null ? {} : { configPath: row.config_path }),
		...(row.github_connection_id === null ? {} : { githubConnectionId: row.github_connection_id }),
		...(row.github_installation_id === null ? {} : { githubInstallationId: row.github_installation_id }),
	},
})

export async function listApps(c: RegistryContext): Promise<Response> {
	return jsonAdapter(() => listAppsUseCase(useCaseContext(c)))
}

export async function listAppsUseCase(c: RegistryUseCaseContext): Promise<ListResponse<AppDto>> {
	return { items: (await c.repositories.registry.listApps()).map(toAppDto) }
}

export async function getApp(c: RegistryContext, id: string): Promise<Response> {
	return jsonAdapter(() => getAppUseCase(useCaseContext(c), id))
}

export async function getAppUseCase(c: RegistryUseCaseContext, id: string): Promise<AppDto> {
	const row = await c.repositories.registry.getApp(id)
	if (row === null) fail(404, 'app not found')
	return toAppDto(row)
}

export async function createApp(c: RegistryContext): Promise<Response> {
	return jsonAdapter(async () => createAppUseCase(useCaseContext(c), parseCreateApp(await readJson(c.request))), { status: 201 })
}

export async function createAppUseCase(c: RegistryUseCaseContext, input: CreateAppRequest): Promise<AppDto> {
	if (await c.repositories.registry.getApp(input.id)) fail(409, 'an app with this id already exists')
	const normalized = normalizeRepoUrl(input.repoUrl)
	const sourceBinding = await sourceBindingFields(c, input, normalized)
	const row = await c.repositories.registry.createApp({
		id: input.id,
		repoUrl: normalized,
		...appFields(input),
		...sourceBinding,
	})
	await c.auth.audit({ action: 'app.create', resourceType: 'app', resourceId: input.id, metadata: { repoUrl: row.repo_url } })
	notifyCatalogChanged(c)
	return toAppDto(row)
}

export async function updateApp(c: RegistryContext, id: string): Promise<Response> {
	return jsonAdapter(async () => updateAppUseCase(useCaseContext(c), id, parseUpdateApp(await readJson(c.request))))
}

export async function updateAppUseCase(c: RegistryUseCaseContext, id: string, input: UpdateAppRequest): Promise<AppDto> {
	const existing = await c.repositories.registry.getApp(id)
	if (existing === null) fail(404, 'app not found')
	const resolveTarget = input.repoUrl === undefined ? existing.repo_url : normalizeRepoUrl(input.repoUrl)
	const sourceBinding = await sourceBindingFields(c, input, resolveTarget, existing)
	const row = await c.repositories.registry.updateApp(id, {
		...(input.repoUrl === undefined ? {} : { repoUrl: normalizeRepoUrl(input.repoUrl) }),
		...appFields(input),
		...sourceBinding,
	})
	await c.auth.audit({ action: 'app.update', resourceType: 'app', resourceId: id })
	notifyCatalogChanged(c)
	if (row === null) fail(404, 'app not found')
	return toAppDto(row)
}

export async function deleteApp(c: RegistryContext, id: string): Promise<Response> {
	return jsonAdapter(() => deleteAppUseCase(useCaseContext(c), id))
}

export async function deleteAppUseCase(c: RegistryUseCaseContext, id: string): Promise<OkResponse> {
	if (!(await c.repositories.registry.deleteApp(id))) fail(404, 'app not found')
	await c.auth.audit({ action: 'app.delete', resourceType: 'app', resourceId: id })
	notifyCatalogChanged(c)
	return { ok: true }
}

export async function listAppEnvs(c: RegistryContext, appId: string): Promise<Response> {
	return jsonAdapter(() => listAppEnvsUseCase(useCaseContext(c), appId))
}

export async function listAppEnvsUseCase(c: RegistryUseCaseContext, appId: string): Promise<ListResponse<AppEnvDto>> {
	await requireApp(c, appId)
	return { items: (await c.repositories.registry.listAppEnvs(appId)).map(toAppEnvDto) }
}

export async function putAppEnv(c: RegistryContext, appId: string, env: string): Promise<Response> {
	return jsonAdapter(async () => putAppEnvUseCase(useCaseContext(c), appId, env, parsePutAppEnv(await readJson(c.request))))
}

export async function putAppEnvUseCase(c: RegistryUseCaseContext, appId: string, env: string, input: PutAppEnvRequest): Promise<AppEnvDto> {
	const app = await requireApp(c, appId)
	const existing = await c.repositories.registry.getAppEnv(appId, env)
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
	const preparation = c.provider.namespaces?.prepareRegistration
	let registration: ProviderRegistration
	if (preparation === undefined) {
		registration = normalizeRegistration(c.provider, requested.app, requested.environment)
	} else {
		// Unlike `register`, nothing has been written yet, so a refusal here leaves the environment as it
		// was and there is nothing to roll back.
		try {
			registration = await prepareRegistration(c, preparation, requested)
		} catch {
			return fail(502, 'provider registration preparation failed')
		}
	}
	const resourceClaims = registrationResourceClaims(c.provider, registration)
	const persistence = {
		appId,
		env,
		domain: registration.environment.domain ?? null,
		publicOrigin: registration.environment.publicOrigin ?? null,
		triggerRef: input.triggerRef ?? null,
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
		metadata: { triggerRef: input.triggerRef ?? null, namespaceId: row.namespace_id, previousNamespaceId: existing?.namespace_id ?? null },
	})
	notifyCatalogChanged(c)
	return toAppEnvDto(row)
}

export async function deleteAppEnv(c: RegistryContext, appId: string, env: string): Promise<Response> {
	return jsonAdapter(() => deleteAppEnvUseCase(useCaseContext(c), appId, env))
}

export async function deleteAppEnvUseCase(c: RegistryUseCaseContext, appId: string, env: string): Promise<OkResponse> {
	if (!(await c.repositories.registry.deleteAppEnv(appId, env))) fail(404, 'app env not found')
	await c.auth.audit({ action: 'app.env.delete', resourceType: 'app_env', resourceId: `${appId}/${env}` })
	notifyCatalogChanged(c)
	return { ok: true }
}

export async function listAppSecrets(c: RegistryContext, appId: string): Promise<Response> {
	return jsonAdapter(() => listAppSecretsUseCase(useCaseContext(c), appId))
}

export async function listAppSecretsUseCase(c: RegistryUseCaseContext, appId: string): Promise<ListResponse<AppSecretDto>> {
	await requireApp(c, appId)
	return { items: (await c.repositories.registry.listAppSecrets(appId)).map(toAppSecretDto) }
}

export async function putAppSecret(c: RegistryContext, appId: string): Promise<Response> {
	return jsonAdapter(async () => putAppSecretUseCase(useCaseContext(c), appId, parsePutSecret(await readJson(c.request))))
}

export async function putAppSecretUseCase(c: RegistryUseCaseContext, appId: string, input: PutAppSecretRequest): Promise<AppSecretDto> {
	await requireApp(c, appId)
	const env = input.env ?? null
	const row = await c.repositories.registry.upsertAppSecret({ appId, env, name: input.name, valueRef: input.valueRef })
	await c.auth.audit({
		action: 'app.secret.upsert',
		resourceType: 'app_secret',
		resourceId: `${appId}/${env ?? '*'}/${input.name}`,
		metadata: { name: input.name, env },
	})
	return toAppSecretDto(row)
}

export async function deleteAppSecret(c: RegistryContext, appId: string, name: string): Promise<Response> {
	const env = queryLayer(c.url)
	return jsonAdapter(() => deleteAppSecretUseCase(useCaseContext(c), appId, name, env))
}

export async function deleteAppSecretUseCase(c: RegistryUseCaseContext, appId: string, name: string, env: string | null): Promise<OkResponse> {
	if (!(await c.repositories.registry.deleteAppSecret(appId, env, name))) fail(404, 'secret not found')
	await c.auth.audit({ action: 'app.secret.delete', resourceType: 'app_secret', resourceId: `${appId}/${env ?? '*'}/${name}` })
	return { ok: true }
}

export async function listAppVars(c: RegistryContext, appId: string): Promise<Response> {
	return jsonAdapter(() => listAppVarsUseCase(useCaseContext(c), appId))
}

export async function listAppVarsUseCase(c: RegistryUseCaseContext, appId: string): Promise<ListResponse<AppVarDto>> {
	await requireApp(c, appId)
	return { items: (await c.repositories.registry.listAppVars(appId)).map(toAppVarDto) }
}

export async function putAppVar(c: RegistryContext, appId: string): Promise<Response> {
	return jsonAdapter(async () => putAppVarUseCase(useCaseContext(c), appId, parsePutVar(await readJson(c.request))))
}

export async function putAppVarUseCase(c: RegistryUseCaseContext, appId: string, input: PutAppVarRequest): Promise<AppVarDto> {
	await requireApp(c, appId)
	if (input.name === FABRIKA_RELEASE || operationsManagedEnvironmentCollisions([input.name]).length > 0) {
		fail(400, `application variable "${input.name}" is managed by Fabrika`)
	}
	const env = input.env ?? null
	const row = await c.repositories.registry.upsertAppVar({ appId, env, name: input.name, value: input.value })
	await c.auth.audit({
		action: 'app.var.upsert',
		resourceType: 'app_var',
		resourceId: `${appId}/${env ?? '*'}/${input.name}`,
		metadata: { name: input.name, env },
	})
	return toAppVarDto(row)
}

export async function deleteAppVar(c: RegistryContext, appId: string, name: string): Promise<Response> {
	const env = queryLayer(c.url)
	return jsonAdapter(() => deleteAppVarUseCase(useCaseContext(c), appId, name, env))
}

export async function deleteAppVarUseCase(c: RegistryUseCaseContext, appId: string, name: string, env: string | null): Promise<OkResponse> {
	if (!(await c.repositories.registry.deleteAppVar(appId, env, name))) fail(404, 'var not found')
	await c.auth.audit({ action: 'app.var.delete', resourceType: 'app_var', resourceId: `${appId}/${env ?? '*'}/${name}` })
	return { ok: true }
}

export async function registerApp(c: RegistryContext): Promise<Response> {
	return jsonAdapter(async () => registerAppUseCase(useCaseContext(c), parseRegisterApp(await readJson(c.request))), { status: 201 })
}

export async function registerAppUseCase(c: RegistryUseCaseContext, input: RegisterAppRequest): Promise<RegisterAppResponse> {
	const { id, repoUrl, env } = input
	if (await c.repositories.registry.getApp(id)) fail(409, 'an app with this id already exists')
	const normalized = normalizeRepoUrl(repoUrl)
	const sourceBinding = await sourceBindingFields(c, input, normalized)
	const publicOrigin = canonicalOrigin(input.publicOrigin, null)
	const providerApp: ProviderApp = {
		id,
		source: {
			repoUrl: normalized,
			ref: input.defaultBranch ?? 'main',
			...(input.workerDir === undefined || input.workerDir === null ? {} : { workerDir: input.workerDir }),
			...(input.buildCmd === undefined || input.buildCmd === null ? {} : { buildCommand: input.buildCmd }),
			...(input.configPath === undefined || input.configPath === null ? {} : { configPath: input.configPath }),
			...(sourceBinding.githubConnectionId === undefined || sourceBinding.githubConnectionId === null
				? {}
				: { githubConnectionId: sourceBinding.githubConnectionId }),
			...(sourceBinding.githubInstallationId === undefined || sourceBinding.githubInstallationId === null
				? {}
				: { githubInstallationId: sourceBinding.githubInstallationId }),
		},
	}
	const namespace = await resolveRegistrationNamespace(c, input.namespaceId, id, env, null)
	const preparation = c.provider.namespaces?.prepareRegistration
	let registration: ProviderRegistration = {
		app: providerApp,
		environment: {
			appId: id,
			env,
			...(input.domain === undefined || input.domain === null ? {} : { domain: input.domain }),
			...(publicOrigin === null ? {} : { publicOrigin }),
			...(namespace === undefined ? {} : { namespace }),
			target: input.target,
			artifact: input.artifact,
		},
	}
	if (preparation === undefined) registration = normalizeRegistration(c.provider, providerApp, registration.environment)
	const resourceClaims = registrationResourceClaims(c.provider, registration)
	const source = registration.app.source
	const appInput = {
		id: registration.app.id,
		repoUrl: source.repoUrl,
		defaultBranch: source.ref,
		workerDir: source.workerDir ?? null,
		buildCmd: source.buildCommand ?? null,
		configPath: source.configPath ?? null,
		githubConnectionId: source.githubConnectionId ?? null,
		githubInstallationId: source.githubInstallationId ?? null,
	}
	const environmentInput = {
		appId: registration.app.id,
		env: registration.environment.env,
		domain: registration.environment.domain ?? null,
		publicOrigin: registration.environment.publicOrigin ?? null,
		triggerRef: input.triggerRef ?? null,
		namespaceId: registration.environment.namespace?.id ?? null,
		provider: c.provider.id,
		providerTargetJson: JSON.stringify(registration.environment.target),
		providerArtifactJson: JSON.stringify(registration.environment.artifact),
	}
	let app: AppRow
	let appEnv: AppEnvRow
	try {
		if (registration.environment.namespace === undefined) {
			app = await c.repositories.registry.createApp(appInput)
			appEnv = await c.repositories.registry.upsertAppEnv(environmentInput)
		} else {
			const created = await c.repositories.registry.createAppWithEnvironmentAndNamespaceResourceClaims(appInput, environmentInput, resourceClaims)
			app = created.app
			appEnv = created.appEnv
		}
	} catch (cause) {
		if (cause instanceof NamespaceResourceClaimConflictError) fail(409, cause.message)
		throw cause
	}
	if (preparation !== undefined) {
		try {
			registration = await prepareRegistration(c, preparation, registration)
			appEnv = (await c.repositories.registry.upsertAppEnvWithNamespaceResourceClaims({
				...environmentInput,
				domain: registration.environment.domain ?? null,
				publicOrigin: registration.environment.publicOrigin ?? null,
				namespaceId: registration.environment.namespace?.id ?? null,
				providerTargetJson: JSON.stringify(registration.environment.target),
				providerArtifactJson: JSON.stringify(registration.environment.artifact),
			}, resourceClaims)).appEnv
		} catch {
			if (namespace !== undefined) await c.repositories.registry.deleteNamespaceResourceClaimsForOwner(namespace.id, id, env)
			await c.repositories.registry.deleteApp(id)
			fail(502, 'provider registration preparation failed')
		}
	}
	await c.auth.audit({
		action: 'app.create',
		resourceType: 'app',
		resourceId: id,
		metadata: { repoUrl, env, namespaceId: appEnv.namespace_id, onboarding: true },
	})
	notifyCatalogChanged(c)
	return { app: toAppDto(app), env: toAppEnvDto(appEnv) }
}

/**
 * Run the provider's registration preparation and normalise what it hands back.
 *
 * A provider that has one OWNS the target envelope: on Zerops the target is a service id the provider
 * discovers by importing the app's provisioning document, and a caller cannot know it. Both the
 * create path and the update path go through here, or the two disagree about who builds the target —
 * which is how `apps.environments.put` came to refuse every Zerops manifest whose artifact codec had
 * moved on, while `register` accepted it.
 */
async function prepareRegistration(
	c: RegistryUseCaseContext,
	preparation: NonNullable<NonNullable<ControlProvider['namespaces']>['prepareRegistration']>,
	requested: ProviderRegistration,
): Promise<ProviderRegistration> {
	const prepared = await preparation({ registration: requested, signal: c.signal })
	if (
		prepared.app.id !== requested.app.id
		|| !sameGitHubSourceBinding(prepared.app, requested.app)
		|| prepared.environment.appId !== requested.app.id
		|| prepared.environment.env !== requested.environment.env
		|| prepared.environment.publicOrigin !== requested.environment.publicOrigin
		|| !sameNamespaceCoordinates(prepared.environment.namespace, requested.environment.namespace, c.provider.id)
	) throw new Error('provider returned a prepared registration for different coordinates')
	return normalizeRegistration(c.provider, prepared.app, prepared.environment)
}

function normalizeRegistration(provider: ControlProvider, app: ProviderApp, environment: ProviderEnvironment): ProviderRegistration {
	try {
		const registration = provider.normalizeRegistration({ app, environment })
		if (
			registration.app.id !== app.id
			|| !sameGitHubSourceBinding(registration.app, app)
			|| registration.environment.appId !== app.id
			|| registration.environment.env !== environment.env
			|| registration.environment.publicOrigin !== environment.publicOrigin
			|| registration.environment.target.provider !== provider.id
			|| registration.environment.artifact.provider !== provider.id
			|| !sameNamespaceCoordinates(registration.environment.namespace, environment.namespace, provider.id)
		) fail(400, 'provider returned a registration for different coordinates')
		return registration
	} catch (cause) {
		if (isDomainError(cause)) throw cause
		fail(400, cause instanceof Error ? cause.message : 'invalid provider registration')
	}
}

function sameGitHubSourceBinding(actual: ProviderApp, expected: ProviderApp): boolean {
	return actual.source.githubConnectionId === expected.source.githubConnectionId
		&& actual.source.githubInstallationId === expected.source.githubInstallationId
}

function sameNamespaceCoordinates(
	actual: ProviderDeploymentNamespace | undefined,
	expected: ProviderDeploymentNamespace | undefined,
	providerId: string,
): boolean {
	if (actual === undefined || expected === undefined) return actual === expected
	return actual.id === expected.id
		&& actual.env === expected.env
		&& actual.exclusiveAppId === expected.exclusiveAppId
		&& actual.target.provider === providerId
}

function registrationResourceClaims(provider: ControlProvider, registration: ProviderRegistration): readonly string[] {
	if (registration.environment.namespace === undefined) return []
	const capabilities = provider.namespaces
	if (capabilities === undefined) fail(409, `provider ${provider.id} does not support deployment namespaces`)
	try {
		return capabilities.registrationResourceClaims(registration)
	} catch (cause) {
		fail(400, cause instanceof Error ? cause.message : 'invalid namespace resource claims')
	}
}

async function resolveRegistrationNamespace(
	c: RegistryUseCaseContext,
	namespaceIdInput: string | null | undefined,
	appId: string,
	env: string,
	existing: AppEnvRow | null,
): Promise<ProviderDeploymentNamespace | undefined> {
	const namespaceId = namespaceIdInput === undefined ? existing?.namespace_id ?? null : namespaceIdInput
	if (namespaceId === '') fail(400, 'namespaceId must be a non-empty string or null')
	if (c.provider.namespaces === undefined) {
		if (namespaceId === null) return undefined
		fail(409, `provider ${c.provider.id} does not support deployment namespaces`)
	}
	if (namespaceId === null) fail(400, 'namespaceId is required by this provider')
	const row = await c.repositories.registry.getDeploymentNamespace(namespaceId)
	if (row === null) fail(404, 'deployment namespace not found')
	if (row.provider !== c.provider.id) fail(409, `deployment namespace belongs to provider ${row.provider}`)
	if (row.env !== env) fail(409, `deployment namespace belongs to environment ${row.env}`)
	if (row.exclusive_app_id !== null && row.exclusive_app_id !== appId) fail(409, `deployment namespace is exclusive to app ${row.exclusive_app_id}`)
	if (existing?.namespace_id !== namespaceId && row.state !== 'ready') fail(409, `deployment namespace is ${row.state}`)
	return {
		id: row.id,
		env: row.env,
		...(row.exclusive_app_id === null ? {} : { exclusiveAppId: row.exclusive_app_id }),
		target: parseStoredEnvelope(row.provider_target_json, `target for namespace ${row.id}`),
	}
}

function canonicalOrigin(value: string | null | undefined, fallback: string | null): string | null {
	if (value === undefined) return fallback
	if (value === null) return null
	try {
		return canonicalPublicOrigin(value)
	} catch (cause) {
		if (cause instanceof PublicOriginValidationError) fail(400, cause.message)
		throw cause
	}
}

async function requireApp(c: RegistryUseCaseContext, appId: string): Promise<AppRow> {
	const app = await c.repositories.registry.getApp(appId)
	if (app === null) fail(404, 'app not found')
	return app
}

function appFields(input: AppOptionalFields): {
	defaultBranch?: string
	workerDir?: string | null
	buildCmd?: string | null
	configPath?: string | null
} {
	return {
		...(input.defaultBranch === undefined ? {} : { defaultBranch: input.defaultBranch }),
		...(input.workerDir === undefined ? {} : { workerDir: input.workerDir }),
		...(input.buildCmd === undefined ? {} : { buildCmd: input.buildCmd }),
		...(input.configPath === undefined ? {} : { configPath: input.configPath }),
	}
}

async function sourceBindingFields(
	c: RegistryUseCaseContext,
	input: AppOptionalFields,
	repoUrl: string,
	existing?: AppRow,
): Promise<{ githubConnectionId?: string | null; githubInstallationId?: number | null }> {
	if (c.provider.id !== 'zerops') {
		if (input.githubInstallationId !== undefined) return { githubInstallationId: input.githubInstallationId }
		if (input.resolveInstallationId === true) return { githubInstallationId: await c.repoSource.resolveInstallationId(repoUrl, c.signal) }
		return {}
	}
	if (existing?.github_connection_id !== null && existing?.github_connection_id !== undefined) {
		if (repoOwnerChanged(existing.repo_url, repoUrl) || input.githubInstallationId === null) {
			fail(409, 'an application source connection cannot be reassigned')
		}
	}
	if (input.githubInstallationId === null) return { githubConnectionId: null, githubInstallationId: null }
	if (input.githubInstallationId !== undefined || input.resolveInstallationId === true) {
		const repository = parseGitHubRepo(repoUrl)
		if (repository === null) fail(400, 'a private Zerops source must be a GitHub repository')
		const connection = await c.repositories.githubConnections.getConnectionByOwner(repository.owner)
		if (connection === null) fail(409, 'the repository organization has no GitHub source connection')
		if (
			existing?.github_connection_id !== null && existing?.github_connection_id !== undefined
			&& existing.github_connection_id !== connection.connectionId
		) {
			fail(409, 'an application source connection cannot be reassigned')
		}
		if (input.githubInstallationId !== undefined && input.githubInstallationId !== connection.installationId) {
			fail(409, 'the GitHub installation does not match the repository organization')
		}
		return { githubConnectionId: connection.connectionId, githubInstallationId: connection.installationId }
	}
	return {}
}

function repoOwnerChanged(currentRepoUrl: string, nextRepoUrl: string): boolean {
	const current = parseGitHubRepo(currentRepoUrl)
	const next = parseGitHubRepo(nextRepoUrl)
	if (current === null || next === null) return currentRepoUrl !== nextRepoUrl
	return current.owner.toLowerCase() !== next.owner.toLowerCase()
}

function parseCreateApp(body: unknown): CreateAppRequest {
	const id = stringField(body, 'id')
	const repoUrl = stringField(body, 'repoUrl')
	if (!id || !repoUrl) fail(400, 'id and repoUrl required')
	return { id, repoUrl, ...parseAppOptionalFields(body) }
}

function parseUpdateApp(body: unknown): UpdateAppRequest {
	const repoUrl = stringField(body, 'repoUrl')
	return { ...(repoUrl === undefined ? {} : { repoUrl }), ...parseAppOptionalFields(body) }
}

function parseAppOptionalFields(body: unknown): AppOptionalFields {
	const defaultBranch = stringField(body, 'defaultBranch')
	const workerDir = nullableStringField(body, 'workerDir')
	const buildCmd = nullableStringField(body, 'buildCmd')
	const configPath = nullableStringField(body, 'configPath')
	const githubInstallationId = numberField(body, 'githubInstallationId')
	const resolveInstallationId = booleanField(body, 'resolveInstallationId')
	return {
		...(defaultBranch === undefined ? {} : { defaultBranch }),
		...(workerDir === undefined ? {} : { workerDir }),
		...(buildCmd === undefined ? {} : { buildCmd }),
		...(configPath === undefined ? {} : { configPath }),
		...(githubInstallationId === undefined ? {} : { githubInstallationId }),
		...(resolveInstallationId === undefined ? {} : { resolveInstallationId }),
	}
}

function parsePutAppEnv(body: unknown): PutAppEnvRequest {
	const target = readProviderEnvelope(prop(body, 'target'))
	const artifact = readProviderEnvelope(prop(body, 'artifact'))
	if (target === null) fail(400, 'target must be a versioned provider envelope')
	if (artifact === null) fail(400, 'artifact must be a versioned provider envelope')
	const domain = nullableStringField(body, 'domain')
	const rawPublicOrigin = prop(body, 'publicOrigin')
	if (rawPublicOrigin !== undefined && rawPublicOrigin !== null && typeof rawPublicOrigin !== 'string') {
		fail(400, 'publicOrigin must be an exact HTTP(S) origin')
	}
	const publicOrigin = nullableStringField(body, 'publicOrigin')
	const triggerRef = nullableStringField(body, 'triggerRef')
	const rawNamespaceId = prop(body, 'namespaceId')
	const namespaceId = nullableStringField(body, 'namespaceId')
	if (rawNamespaceId !== undefined && (namespaceId === undefined || namespaceId === '')) {
		fail(400, 'namespaceId must be a non-empty string or null')
	}
	return {
		target,
		artifact,
		...(domain === undefined ? {} : { domain }),
		...(publicOrigin === undefined ? {} : { publicOrigin }),
		...(triggerRef === undefined ? {} : { triggerRef }),
		...(namespaceId === undefined ? {} : { namespaceId }),
	}
}

function parsePutSecret(body: unknown): PutAppSecretRequest {
	const name = stringField(body, 'name')
	const valueRef = stringField(body, 'valueRef')
	if (!name || !valueRef) fail(400, 'name and valueRef required (valueRef is a vault reference, never the value)')
	const env = nullableStringField(body, 'env')
	return { name, valueRef, ...(env === undefined ? {} : { env }) }
}

function parsePutVar(body: unknown): PutAppVarRequest {
	const name = stringField(body, 'name')
	const value = stringField(body, 'value')
	if (!name || !value) fail(400, 'name and value required (value is plaintext config — use a secret for sensitive values)')
	const env = nullableStringField(body, 'env')
	return { name, value, ...(env === undefined ? {} : { env }) }
}

function parseRegisterApp(body: unknown): RegisterAppRequest {
	const id = stringField(body, 'id')
	const repoUrl = stringField(body, 'repoUrl')
	const env = stringField(body, 'env')
	if (!id || !repoUrl || !env) fail(400, 'id, repoUrl and env required')
	const registration = parsePutAppEnv(body)
	return { id, repoUrl, env, ...registration, ...parseAppOptionalFields(body) }
}

function queryLayer(url: URL): string | null {
	const value = url.searchParams.get('env')
	return value === null || value === '' ? null : value
}

function notifyCatalogChanged(c: RegistryUseCaseContext): void {
	try {
		c.catalogChanged?.()
	} catch {
		console.warn('operations catalog scheduling failed')
	}
}

function isDomainError(cause: unknown): cause is { httpStatus: number; type: string } {
	return typeof cause === 'object'
		&& cause !== null
		&& typeof Reflect.get(cause, 'httpStatus') === 'number'
		&& typeof Reflect.get(cause, 'type') === 'string'
}
