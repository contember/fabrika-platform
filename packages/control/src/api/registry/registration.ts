import { isStructuralError } from '@fabrika/app'
import type { AppEnvDto, RegisterAppRequest, RegisterAppResponse } from '@fabrika/control-contract'
import type { ControlProvider, ProviderApp, ProviderDeploymentNamespace, ProviderEnvironment, ProviderRegistration } from '@fabrika/provider-contract'
import { type AppEnvRow, type AppRow, NamespaceResourceClaimConflictError } from '../../db'
import { normalizeRepoUrl } from '../../repo-source'
import { fail } from '../domain'
import { parseStoredEnvelope } from '../provider-envelope'
import { sourceBindingFields, toAppDto } from './apps'
import { notifyCatalogChanged, type RegistryUseCaseContext } from './context'
import { assertProxyDomain, canonicalOrigin } from './validation'

export async function registerAppUseCase(c: RegistryUseCaseContext, input: RegisterAppRequest): Promise<RegisterAppResponse> {
	const { id, repoUrl, env } = input
	if (await c.repositories.registry.getApp(id)) fail(409, 'an app with this id already exists')
	assertProxyDomain(input.domain)
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
		githubConnectionId: sourceBinding.githubConnectionId ?? null,
		githubInstallationId: sourceBinding.githubInstallationId ?? null,
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
		} catch (cause) {
			if (namespace !== undefined) await c.repositories.registry.deleteNamespaceResourceClaimsForOwner(namespace.id, id, env)
			await c.repositories.registry.deleteApp(id)
			fail(502, preparationFailure(cause))
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
export async function prepareRegistration(
	c: RegistryUseCaseContext,
	preparation: NonNullable<NonNullable<ControlProvider['namespaces']>['prepareRegistration']>,
	requested: ProviderRegistration,
): Promise<ProviderRegistration> {
	const prepared = await preparation({ registration: requested, signal: c.signal })
	if (
		prepared.app.id !== requested.app.id
		|| prepared.environment.appId !== requested.app.id
		|| prepared.environment.env !== requested.environment.env
		|| prepared.environment.publicOrigin !== requested.environment.publicOrigin
		|| !sameNamespaceCoordinates(prepared.environment.namespace, requested.environment.namespace, c.provider.id)
	) throw new Error('provider returned a prepared registration for different coordinates')
	return normalizeRegistration(c.provider, prepared.app, prepared.environment)
}

export function normalizeRegistration(provider: ControlProvider, app: ProviderApp, environment: ProviderEnvironment): ProviderRegistration {
	try {
		const registration = provider.normalizeRegistration?.({ app, environment }) ?? { app, environment }
		if (
			registration.app.id !== app.id
			|| registration.environment.appId !== app.id
			|| registration.environment.env !== environment.env
			|| registration.environment.publicOrigin !== environment.publicOrigin
			|| registration.environment.target.provider !== provider.id
			|| registration.environment.artifact.provider !== provider.id
			|| !sameNamespaceCoordinates(registration.environment.namespace, environment.namespace, provider.id)
		) fail(400, 'provider returned a registration for different coordinates')
		return registration
	} catch (cause) {
		if (isStructuralError(cause)) throw cause
		fail(400, cause instanceof Error ? cause.message : 'invalid provider registration')
	}
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

export function registrationResourceClaims(provider: ControlProvider, registration: ProviderRegistration): readonly string[] {
	if (registration.environment.namespace === undefined) return []
	const capabilities = provider.namespaces
	if (capabilities === undefined) fail(409, `provider ${provider.id} does not support deployment namespaces`)
	try {
		return capabilities.registrationResourceClaims(registration)
	} catch (cause) {
		fail(400, cause instanceof Error ? cause.message : 'invalid namespace resource claims')
	}
}

export async function resolveRegistrationNamespace(
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

/** The response stays opaque (provider detail must not escape); the log names the refusal so an operator can act. */
export function preparationFailure(cause: unknown): string {
	const reason = cause instanceof Error && cause.message !== '' ? cause.message.slice(0, 300) : 'unknown error'
	console.error(`provider registration preparation failed: ${reason}`)
	return 'provider registration preparation failed'
}

export function toAppEnvDto(row: AppEnvRow): AppEnvDto {
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
