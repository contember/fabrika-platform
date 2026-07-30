// Registry + onboarding REST handlers: CRUD for apps, app_envs, app_secrets, plus the onboarding
// action `registerApp` (the "paste a repo + domain" entry that creates the app + its first app_env in
// one call). Every handler is ACL-gated by the router (src/api/router.ts) before it runs.
//
// Mutations audit through the authenticated `AuthContext` (propustka `audit`). Secret VALUES are stored
// as REFERENCES only (`value_ref`) — the plaintext vault is in src/vault.ts. A create endpoint accepts
// a ref, never a raw value. fabrika is single-account, so there is no `accounts` resource: the CF
// account/token + propustka coords are fabrika's own Worker config (src/env.ts).

import type { AppDto, AppEnvDto, AppSecretDto, AppVarDto, RegisterAppResponse } from '@fabrika/control-contract'
import { operationsManagedEnvironmentCollisions } from '@fabrika/operations-contract/ingest'
import { FABRIKA_RELEASE } from '@fabrika/operations-contract/releases'
import type { ControlProvider, ProviderApp, ProviderDeploymentNamespace, ProviderEnvironment, ProviderRegistration } from '@fabrika/provider-contract'
import { type AppEnvRow, type AppRow, type AppSecretRow, type AppVarRow, type ControlRepositories, NamespaceResourceClaimConflictError } from '../db'
import { error, json, readJson } from '../http'
import type { Authorized } from '../iam'
import { arrayField, booleanField, nullableStringField, numberField, prop, stringField } from '../json'
import { canonicalPublicOrigin, PublicOriginValidationError } from '../public-origin'
import { normalizeRepoUrl, type RepoSource } from '../repo-source'
import { envelopeField, parseStoredEnvelope } from './provider-envelope'

/** Context every registry handler receives. */
export interface RegistryContext {
	repositories: ControlRepositories
	request: Request
	url: URL
	/** The RepoSource — used to auto-detect an app's GitHub installation id at onboarding time. */
	repoSource: RepoSource
	/** The installation's one statically composed provider. */
	provider: ControlProvider
	/** The authenticated caller (already `can`-checked by the router); used to `audit` mutations. */
	authorized: Authorized
	/** Non-blocking Operations projection trigger. The handler never awaits it. */
	catalogChanged?: () => void
}

// ── DTO mappers (snake_case row → camelCase API; secrets stay refs) ────────────

function toAppDto(row: AppRow): AppDto {
	return {
		id: row.id,
		repoUrl: row.repo_url,
		defaultBranch: row.default_branch,
		workerDir: row.worker_dir,
		buildCmd: row.build_cmd,
		configPath: row.config_path,
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

const toProviderApp = (row: AppRow): ProviderApp => ({
	id: row.id,
	source: {
		repoUrl: row.repo_url,
		ref: row.default_branch,
		...(row.worker_dir === null ? {} : { workerDir: row.worker_dir }),
		...(row.build_cmd === null ? {} : { buildCommand: row.build_cmd }),
		...(row.config_path === null ? {} : { configPath: row.config_path }),
		...(row.github_installation_id === null ? {} : { githubInstallationId: row.github_installation_id }),
	},
})

function normalizeRegistration(
	provider: ControlProvider,
	app: ProviderApp,
	environment: ProviderEnvironment,
): ProviderRegistration | Response {
	try {
		const registration = provider.normalizeRegistration({ app, environment })
		if (
			registration.app.id !== app.id
			|| registration.environment.appId !== app.id
			|| registration.environment.env !== environment.env
			|| registration.environment.publicOrigin !== environment.publicOrigin
			|| registration.environment.target.provider !== provider.id
			|| registration.environment.artifact.provider !== provider.id
			|| !sameNamespaceCoordinates(registration.environment.namespace, environment.namespace, provider.id)
		) {
			return error(400, 'provider returned a registration for different coordinates')
		}
		return registration
	} catch (cause) {
		return error(400, cause instanceof Error ? cause.message : 'invalid provider registration')
	}
}

function sameNamespaceCoordinates(
	actual: ProviderDeploymentNamespace | undefined,
	expected: ProviderDeploymentNamespace | undefined,
	providerId: string,
): boolean {
	if (actual === undefined || expected === undefined) {
		return actual === expected
	}
	return actual.id === expected.id
		&& actual.env === expected.env
		&& actual.exclusiveAppId === expected.exclusiveAppId
		&& actual.target.provider === providerId
}

function registrationEnvironment(
	body: unknown,
	provider: ControlProvider,
	app: ProviderApp,
	env: string,
	domain: string | null,
	publicOrigin: string | null,
	namespace?: ProviderDeploymentNamespace,
): ProviderRegistration | Response {
	const target = envelopeField(body, 'target')
	if (target instanceof Response) return target
	const artifact = envelopeField(body, 'artifact')
	if (artifact instanceof Response) return artifact
	return normalizeRegistration(provider, app, {
		appId: app.id,
		env,
		...(domain === null ? {} : { domain }),
		...(publicOrigin === null ? {} : { publicOrigin }),
		...(namespace === undefined ? {} : { namespace }),
		target,
		artifact,
	})
}

function publicOriginField(body: unknown, fallback: string | null): string | null | Response {
	const value = prop(body, 'publicOrigin')
	if (value === undefined) return fallback
	if (value === null) return null
	if (typeof value !== 'string') return error(400, 'publicOrigin must be an exact HTTP(S) origin')
	try {
		return canonicalPublicOrigin(value)
	} catch (cause) {
		if (cause instanceof PublicOriginValidationError) return error(400, cause.message)
		throw cause
	}
}

function registrationResourceClaims(
	provider: ControlProvider,
	registration: ProviderRegistration,
): readonly string[] | Response {
	if (registration.environment.namespace === undefined) {
		return []
	}
	const capabilities = provider.namespaces
	if (capabilities === undefined) {
		return error(409, `provider ${provider.id} does not support deployment namespaces`)
	}
	try {
		return capabilities.registrationResourceClaims(registration)
	} catch (cause) {
		return error(400, cause instanceof Error ? cause.message : 'invalid namespace resource claims')
	}
}

async function resolveRegistrationNamespace(
	c: RegistryContext,
	body: unknown,
	appId: string,
	env: string,
	existing: AppEnvRow | null,
): Promise<ProviderDeploymentNamespace | undefined | Response> {
	const rawNamespaceId = prop(body, 'namespaceId')
	const parsedNamespaceId = nullableStringField(body, 'namespaceId')
	if (rawNamespaceId !== undefined && (parsedNamespaceId === undefined || parsedNamespaceId === '')) {
		return error(400, 'namespaceId must be a non-empty string or null')
	}
	const namespaceId = rawNamespaceId === undefined ? existing?.namespace_id ?? null : parsedNamespaceId ?? null
	if (c.provider.namespaces === undefined) {
		return namespaceId === null ? undefined : error(409, `provider ${c.provider.id} does not support deployment namespaces`)
	}
	if (namespaceId === null) {
		return error(400, 'namespaceId is required by this provider')
	}
	const row = await c.repositories.registry.getDeploymentNamespace(namespaceId)
	if (row === null) {
		return error(404, 'deployment namespace not found')
	}
	if (row.provider !== c.provider.id) {
		return error(409, `deployment namespace belongs to provider ${row.provider}`)
	}
	if (row.env !== env) {
		return error(409, `deployment namespace belongs to environment ${row.env}`)
	}
	if (row.exclusive_app_id !== null && row.exclusive_app_id !== appId) {
		return error(409, `deployment namespace is exclusive to app ${row.exclusive_app_id}`)
	}
	if (existing?.namespace_id !== namespaceId && row.state !== 'ready') {
		return error(409, `deployment namespace is ${row.state}`)
	}
	return {
		id: row.id,
		env: row.env,
		...(row.exclusive_app_id === null ? {} : { exclusiveAppId: row.exclusive_app_id }),
		target: parseStoredEnvelope(row.provider_target_json, `target for namespace ${row.id}`),
	}
}
function toAppSecretDto(row: AppSecretRow): AppSecretDto {
	// value_ref IS exposed (it's a reference, not the value) — the dashboard needs to show which ref a
	// secret maps to. The actual value never leaves the vault (M4).
	return { appId: row.app_id, env: row.env, name: row.name, valueRef: row.value_ref, createdAt: row.created_at }
}

// ── Apps ──────────────────────────────────────────────────────────────────────

export async function listApps(c: RegistryContext): Promise<Response> {
	const rows = await c.repositories.registry.listApps()
	return json({ items: rows.map(toAppDto) })
}

export async function getApp(c: RegistryContext, id: string): Promise<Response> {
	const row = await c.repositories.registry.getApp(id)
	return row ? json(toAppDto(row)) : error(404, 'app not found')
}

export async function createApp(c: RegistryContext): Promise<Response> {
	const body = await readJson(c.request)
	const id = stringField(body, 'id')
	const repoUrl = stringField(body, 'repoUrl')
	if (!id || !repoUrl) {
		return error(400, 'id and repoUrl required')
	}
	if (await c.repositories.registry.getApp(id)) {
		return error(409, 'an app with this id already exists')
	}
	// Store the NORMALIZED repo URL so the webhook's normalized push URL matches it (see
	// normalizeRepoUrl). The original form is not needed — the canonical host/owner/repo is the key.
	const normalized = normalizeRepoUrl(repoUrl)
	const row = await c.repositories.registry.createApp({
		id,
		repoUrl: normalized,
		...optionalAppFields(body),
		...(await installationIdField(c, body, normalized)),
	})
	await c.authorized.auth.audit({ action: 'app.create', resourceType: 'app', resourceId: id, metadata: { repoUrl: row.repo_url } })
	notifyCatalogChanged(c)
	return json(toAppDto(row), { status: 201 })
}

export async function updateApp(c: RegistryContext, id: string): Promise<Response> {
	const existing = await c.repositories.registry.getApp(id)
	if (!existing) {
		return error(404, 'app not found')
	}
	const body = await readJson(c.request)
	const repoUrl = stringField(body, 'repoUrl')
	// Auto-detect resolves against the new repoUrl when one is supplied, else the app's existing one.
	const resolveTarget = repoUrl !== undefined ? normalizeRepoUrl(repoUrl) : existing.repo_url
	const row = await c.repositories.registry.updateApp(id, {
		...(repoUrl !== undefined ? { repoUrl: normalizeRepoUrl(repoUrl) } : {}),
		...optionalAppFields(body),
		...(await installationIdField(c, body, resolveTarget)),
	})
	await c.authorized.auth.audit({ action: 'app.update', resourceType: 'app', resourceId: id })
	notifyCatalogChanged(c)
	return row ? json(toAppDto(row)) : error(404, 'app not found')
}

export async function deleteApp(c: RegistryContext, id: string): Promise<Response> {
	const ok = await c.repositories.registry.deleteApp(id)
	if (!ok) {
		return error(404, 'app not found')
	}
	await c.authorized.auth.audit({ action: 'app.delete', resourceType: 'app', resourceId: id })
	notifyCatalogChanged(c)
	return json({ ok: true })
}

/** Shared optional-column reader for create/update app (defaultBranch / dirs / build). */
function optionalAppFields(body: unknown): {
	defaultBranch?: string
	workerDir?: string | null
	buildCmd?: string | null
	configPath?: string | null
} {
	const defaultBranch = stringField(body, 'defaultBranch')
	const workerDir = nullableStringField(body, 'workerDir')
	const buildCmd = nullableStringField(body, 'buildCmd')
	const configPath = nullableStringField(body, 'configPath')
	return {
		...(defaultBranch !== undefined ? { defaultBranch } : {}),
		...(workerDir !== undefined ? { workerDir } : {}),
		...(buildCmd !== undefined ? { buildCmd } : {}),
		...(configPath !== undefined ? { configPath } : {}),
	}
}

/**
 * Resolve the app's GitHub installation id from the request body, kept out of `optionalAppFields` because
 * it can require a network lookup. Precedence:
 *   1. an explicit numeric `githubInstallationId` in the body → used verbatim (MANUAL override);
 *   2. else, `resolveInstallationId: true` → looked up from the GitHub App by `repoUrl` (AUTO-detect);
 *   3. else → `undefined` (leave the column untouched — null on create).
 * A failed auto-detect yields null (never throws) so onboarding still succeeds; the operator can set it
 * later. Returns `{}` when untouched so callers can spread it into the create/update input.
 */
async function installationIdField(c: RegistryContext, body: unknown, repoUrl: string): Promise<{ githubInstallationId?: number | null }> {
	const explicit = numberField(body, 'githubInstallationId')
	if (explicit !== undefined) {
		return { githubInstallationId: explicit }
	}
	if (booleanField(body, 'resolveInstallationId') === true) {
		return { githubInstallationId: await c.repoSource.resolveInstallationId(repoUrl) }
	}
	return {}
}

// ── App environments ──────────────────────────────────────────────────────────

export async function listAppEnvs(c: RegistryContext, appId: string): Promise<Response> {
	if (!(await c.repositories.registry.getApp(appId))) {
		return error(404, 'app not found')
	}
	const rows = await c.repositories.registry.listAppEnvs(appId)
	return json({ items: rows.map(toAppEnvDto) })
}

export async function putAppEnv(c: RegistryContext, appId: string, env: string): Promise<Response> {
	const app = await c.repositories.registry.getApp(appId)
	if (app === null) {
		return error(404, 'app not found')
	}
	const body = await readJson(c.request)
	const domain = nullableStringField(body, 'domain') ?? null
	const triggerRef = nullableStringField(body, 'triggerRef') ?? null
	const existing = await c.repositories.registry.getAppEnv(appId, env)
	const publicOrigin = publicOriginField(body, existing?.public_origin ?? null)
	if (publicOrigin instanceof Response) return publicOrigin
	const namespace = await resolveRegistrationNamespace(c, body, appId, env, existing)
	if (namespace instanceof Response) return namespace
	const nextNamespaceId = namespace?.id ?? null
	if (existing?.namespace_id !== nextNamespaceId) {
		if (await c.repositories.registry.hasInFlightRun(appId, env)) {
			return error(409, 'deployment namespace cannot change while a deploy is in progress')
		}
		if (await c.repositories.registry.hasSuccessfulRun(appId, env)) {
			return error(409, 'deployment namespace cannot change after a successful deploy')
		}
	}
	const registration = registrationEnvironment(body, c.provider, toProviderApp(app), env, domain, publicOrigin, namespace)
	if (registration instanceof Response) return registration
	const resourceClaims = registrationResourceClaims(c.provider, registration)
	if (resourceClaims instanceof Response) return resourceClaims
	const input = {
		appId,
		env,
		domain: registration.environment.domain ?? null,
		publicOrigin: registration.environment.publicOrigin ?? null,
		triggerRef,
		namespaceId: registration.environment.namespace?.id ?? null,
		provider: c.provider.id,
		providerTargetJson: JSON.stringify(registration.environment.target),
		providerArtifactJson: JSON.stringify(registration.environment.artifact),
	}
	let row: AppEnvRow
	try {
		row = registration.environment.namespace === undefined
			? await c.repositories.registry.upsertAppEnv(input)
			: (await c.repositories.registry.upsertAppEnvWithNamespaceResourceClaims(input, resourceClaims)).appEnv
	} catch (cause) {
		if (cause instanceof NamespaceResourceClaimConflictError) {
			return error(409, cause.message)
		}
		throw cause
	}
	await c.authorized.auth.audit({
		action: 'app.env.upsert',
		resourceType: 'app_env',
		resourceId: `${appId}/${env}`,
		metadata: { triggerRef, namespaceId: row.namespace_id, previousNamespaceId: existing?.namespace_id ?? null },
	})
	notifyCatalogChanged(c)
	return json(toAppEnvDto(row))
}
export async function deleteAppEnv(c: RegistryContext, appId: string, env: string): Promise<Response> {
	const ok = await c.repositories.registry.deleteAppEnv(appId, env)
	if (!ok) {
		return error(404, 'app env not found')
	}
	await c.authorized.auth.audit({ action: 'app.env.delete', resourceType: 'app_env', resourceId: `${appId}/${env}` })
	notifyCatalogChanged(c)
	return json({ ok: true })
}

// ── App secrets (refs only; the M4 vault fills values) ─────────────────────────

export async function listAppSecrets(c: RegistryContext, appId: string): Promise<Response> {
	if (!(await c.repositories.registry.getApp(appId))) {
		return error(404, 'app not found')
	}
	const rows = await c.repositories.registry.listAppSecrets(appId)
	return json({ items: rows.map(toAppSecretDto) })
}

export async function putAppSecret(c: RegistryContext, appId: string): Promise<Response> {
	if (!(await c.repositories.registry.getApp(appId))) {
		return error(404, 'app not found')
	}
	const body = await readJson(c.request)
	const name = stringField(body, 'name')
	const valueRef = stringField(body, 'valueRef')
	if (!name || !valueRef) {
		return error(400, 'name and valueRef required (valueRef is a vault reference, never the value)')
	}
	// env null = all-env layer; a string narrows it to that env.
	const env = nullableStringField(body, 'env') ?? null
	const row = await c.repositories.registry.upsertAppSecret({ appId, env, name, valueRef })
	await c.authorized.auth.audit({
		action: 'app.secret.upsert',
		resourceType: 'app_secret',
		resourceId: `${appId}/${env ?? '*'}/${name}`,
		// NEVER log the ref's tail beyond the name — the ref scheme is fine, the value is not present.
		metadata: { name, env },
	})
	return json(toAppSecretDto(row))
}

export async function deleteAppSecret(c: RegistryContext, appId: string, name: string): Promise<Response> {
	// env is a query param (?env=); absent → the all-env layer.
	const envParam = c.url.searchParams.get('env')
	const env = envParam === null || envParam === '' ? null : envParam
	const ok = await c.repositories.registry.deleteAppSecret(appId, env, name)
	if (!ok) {
		return error(404, 'secret not found')
	}
	await c.authorized.auth.audit({ action: 'app.secret.delete', resourceType: 'app_secret', resourceId: `${appId}/${env ?? '*'}/${name}` })
	return json({ ok: true })
}

// ── App vars (non-secret deploy-time config; PLAINTEXT, readable — unlike secrets) ──

function toAppVarDto(row: AppVarRow): AppVarDto {
	// `value` IS exposed: these are NON-secret per-app-env config (e.g. PROPUSTKA_ACCESS_APPS). Secrets
	// (app_secrets) expose only a ref; vars are plaintext config the dashboard can show + edit.
	return { appId: row.app_id, env: row.env, name: row.name, value: row.value, createdAt: row.created_at }
}

export async function listAppVars(c: RegistryContext, appId: string): Promise<Response> {
	if (!(await c.repositories.registry.getApp(appId))) {
		return error(404, 'app not found')
	}
	const rows = await c.repositories.registry.listAppVars(appId)
	return json({ items: rows.map(toAppVarDto) })
}

export async function putAppVar(c: RegistryContext, appId: string): Promise<Response> {
	if (!(await c.repositories.registry.getApp(appId))) {
		return error(404, 'app not found')
	}
	const body = await readJson(c.request)
	const name = stringField(body, 'name')
	const value = stringField(body, 'value')
	if (!name || !value) {
		return error(400, 'name and value required (value is plaintext config — use a secret for sensitive values)')
	}
	if (name === FABRIKA_RELEASE || operationsManagedEnvironmentCollisions([name]).length > 0) {
		return error(400, `application variable "${name}" is managed by Fabrika`)
	}
	// env null = all-env layer; a string narrows it to that env.
	const env = nullableStringField(body, 'env') ?? null
	const row = await c.repositories.registry.upsertAppVar({ appId, env, name, value })
	await c.authorized.auth.audit({
		action: 'app.var.upsert',
		resourceType: 'app_var',
		resourceId: `${appId}/${env ?? '*'}/${name}`,
		// NEVER log the value — even though it's non-secret, treat config as untrusted; only name + env.
		metadata: { name, env },
	})
	return json(toAppVarDto(row))
}

export async function deleteAppVar(c: RegistryContext, appId: string, name: string): Promise<Response> {
	// env is a query param (?env=); absent → the all-env layer.
	const envParam = c.url.searchParams.get('env')
	const env = envParam === null || envParam === '' ? null : envParam
	const ok = await c.repositories.registry.deleteAppVar(appId, env, name)
	if (!ok) {
		return error(404, 'var not found')
	}
	await c.authorized.auth.audit({ action: 'app.var.delete', resourceType: 'app_var', resourceId: `${appId}/${env ?? '*'}/${name}` })
	return json({ ok: true })
}

// ── Onboarding ──────────────────────────────────────────────────────────────

/**
 * The "paste a repo + domain" entry: create the app + its first app_env in one call. Idempotency is
 * left to the caller (a duplicate id is a 409). Optional fields shape the registry rows (worker dir,
 * build cmd, domain, trigger ref, install id). The deploy target account is fabrika's own (single-account).
 */
export async function registerApp(c: RegistryContext): Promise<Response> {
	const body = await readJson(c.request)
	const id = stringField(body, 'id')
	const repoUrl = stringField(body, 'repoUrl')
	const env = stringField(body, 'env')
	if (!id || !repoUrl || !env) {
		return error(400, 'id, repoUrl and env required')
	}
	if (await c.repositories.registry.getApp(id)) {
		return error(409, 'an app with this id already exists')
	}
	const normalized = normalizeRepoUrl(repoUrl)
	const optional = optionalAppFields(body)
	const installation = await installationIdField(c, body, normalized)
	const domain = nullableStringField(body, 'domain') ?? null
	const publicOrigin = publicOriginField(body, null)
	if (publicOrigin instanceof Response) return publicOrigin
	const triggerRef = nullableStringField(body, 'triggerRef') ?? null
	const providerApp: ProviderApp = {
		id,
		source: {
			repoUrl: normalized,
			ref: optional.defaultBranch ?? 'main',
			...(optional.workerDir === undefined || optional.workerDir === null ? {} : { workerDir: optional.workerDir }),
			...(optional.buildCmd === undefined || optional.buildCmd === null ? {} : { buildCommand: optional.buildCmd }),
			...(optional.configPath === undefined || optional.configPath === null ? {} : { configPath: optional.configPath }),
			...(installation.githubInstallationId === undefined || installation.githubInstallationId === null
				? {}
				: { githubInstallationId: installation.githubInstallationId }),
		},
	}
	const namespace = await resolveRegistrationNamespace(c, body, id, env, null)
	if (namespace instanceof Response) return namespace
	const target = envelopeField(body, 'target')
	if (target instanceof Response) return target
	const artifact = envelopeField(body, 'artifact')
	if (artifact instanceof Response) return artifact
	const preparation = c.provider.namespaces?.prepareRegistration
	let registration: ProviderRegistration = {
		app: providerApp,
		environment: {
			appId: id,
			env,
			...(domain === null ? {} : { domain }),
			...(publicOrigin === null ? {} : { publicOrigin }),
			...(namespace === undefined ? {} : { namespace }),
			target,
			artifact,
		},
	}
	if (preparation === undefined) {
		const normalizedRegistration = normalizeRegistration(c.provider, providerApp, registration.environment)
		if (normalizedRegistration instanceof Response) return normalizedRegistration
		registration = normalizedRegistration
	}
	const resourceClaims = registrationResourceClaims(c.provider, registration)
	if (resourceClaims instanceof Response) return resourceClaims
	const source = registration.app.source
	const appInput = {
		id: registration.app.id,
		repoUrl: source.repoUrl,
		defaultBranch: source.ref,
		workerDir: source.workerDir ?? null,
		buildCmd: source.buildCommand ?? null,
		configPath: source.configPath ?? null,
		githubInstallationId: source.githubInstallationId ?? null,
	}
	const environmentInput = {
		appId: registration.app.id,
		env: registration.environment.env,
		domain: registration.environment.domain ?? null,
		publicOrigin: registration.environment.publicOrigin ?? null,
		triggerRef,
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
		if (cause instanceof NamespaceResourceClaimConflictError) {
			return error(409, cause.message)
		}
		throw cause
	}
	if (preparation !== undefined) {
		try {
			const prepared = await preparation({ registration, signal: c.request.signal })
			if (
				prepared.app.id !== id
				|| prepared.environment.appId !== id
				|| prepared.environment.env !== env
				|| prepared.environment.publicOrigin !== registration.environment.publicOrigin
				|| !sameNamespaceCoordinates(prepared.environment.namespace, registration.environment.namespace, c.provider.id)
			) {
				throw new Error('provider returned a prepared registration for different coordinates')
			}
			const normalized = normalizeRegistration(c.provider, prepared.app, prepared.environment)
			if (normalized instanceof Response) {
				throw new Error('provider returned an invalid prepared registration')
			}
			registration = normalized
			const updated = await c.repositories.registry.upsertAppEnvWithNamespaceResourceClaims({
				...environmentInput,
				domain: registration.environment.domain ?? null,
				publicOrigin: registration.environment.publicOrigin ?? null,
				namespaceId: registration.environment.namespace?.id ?? null,
				providerTargetJson: JSON.stringify(registration.environment.target),
				providerArtifactJson: JSON.stringify(registration.environment.artifact),
			}, resourceClaims)
			appEnv = updated.appEnv
		} catch {
			if (namespace !== undefined) {
				await c.repositories.registry.deleteNamespaceResourceClaimsForOwner(namespace.id, id, env)
			}
			await c.repositories.registry.deleteApp(id)
			return error(502, 'provider registration preparation failed')
		}
	}
	await c.authorized.auth.audit({
		action: 'app.create',
		resourceType: 'app',
		resourceId: id,
		metadata: { repoUrl, env, namespaceId: appEnv.namespace_id, onboarding: true },
	})
	notifyCatalogChanged(c)
	const response: RegisterAppResponse = { app: toAppDto(app), env: toAppEnvDto(appEnv) }
	return json(response, { status: 201 })
}

// Re-export the field readers the router uses to validate query params consistently.
export { arrayField, booleanField }

function notifyCatalogChanged(c: RegistryContext): void {
	try {
		c.catalogChanged?.()
	} catch {
		// An Operations scheduling failure must not turn a committed registry mutation into an API error.
		console.warn('operations catalog scheduling failed')
	}
}
