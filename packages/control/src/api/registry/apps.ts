import type { AppDto, AppOptionalFields, CreateAppRequest, ListResponse, OkResponse, UpdateAppRequest } from '@fabrika/control-contract'
import { requireHumanForProtectedDelete } from '../../approval/human'
import { AppEnvChangedError, type AppEnvRow, type AppRow, type NamespaceResourceClaimRow } from '../../db'
import { normalizeRepoUrl, parseGitHubRepo } from '../../github/triggers/push-event'
import { fail } from '../domain'
import { syncChangedNamespaceProxies } from '../namespaces'
import { notifyCatalogChanged, type RegistryUseCaseContext } from './context'
import { assertAppEnvironmentPart } from './validation'

export async function listAppsUseCase(c: RegistryUseCaseContext): Promise<ListResponse<AppDto>> {
	return { items: (await c.repositories.registry.listApps()).map(toAppDto) }
}

export async function getAppUseCase(c: RegistryUseCaseContext, id: string): Promise<AppDto> {
	const row = await c.repositories.registry.getApp(id)
	if (row === null) fail(404, 'app not found')
	return toAppDto(row)
}

export async function createAppUseCase(c: RegistryUseCaseContext, input: CreateAppRequest): Promise<AppDto> {
	assertAppEnvironmentPart('app id', input.id)
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

export async function deleteAppUseCase(c: RegistryUseCaseContext, id: string): Promise<OkResponse> {
	assertNoHeldResourceClaims(`app ${id}`, await c.repositories.registry.listNamespaceResourceClaimsForApp(id))
	const envs = await c.repositories.registry.listAppEnvs(id)
	await assertNoDevSandboxes(c, envs)
	requireHumanForProtectedDelete(c.auth, c.admission, envs)
	// Read the routed namespaces BEFORE the delete: afterwards the rows that name them are gone.
	const namespaceIds = routedNamespaceIds(envs)
	try {
		// Only the environments whose protection was checked, at those generations.
		const expected = envs.map((row) => ({ env: row.env, generation: row.generation }))
		if (!(await c.repositories.registry.deleteApp(id, expected))) fail(404, 'app not found')
	} catch (cause) {
		if (cause instanceof AppEnvChangedError) fail(409, `app ${id} changed while the request ran; retry`)
		throw cause
	}
	await c.auth.audit({ action: 'app.delete', resourceType: 'app', resourceId: id })
	notifyCatalogChanged(c)
	await syncChangedNamespaceProxies(c.namespaceProxyChanged, namespaceIds)
	return { ok: true }
}

/** The deployment namespaces whose proxy manifest lists one of these environments. */
function routedNamespaceIds(envs: readonly AppEnvRow[]): string[] {
	const ids: string[] = []
	for (const row of envs) {
		if (row.namespace_id !== null) ids.push(row.namespace_id)
	}
	return ids
}

export function toAppDto(row: AppRow): AppDto {
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

export async function sourceBindingFields(
	c: RegistryUseCaseContext,
	input: AppOptionalFields,
	repoUrl: string,
	existing?: AppRow,
): Promise<{ githubConnectionId?: string | null; githubInstallationId?: number | null }> {
	const bindsSource = input.githubInstallationId !== undefined || input.resolveInstallationId === true
	if (c.provider.source === undefined) {
		if (input.githubInstallationId === null) return { githubInstallationId: null }
		if (bindsSource) fail(409, `provider ${c.provider.id} deploys public sources only`)
		return {}
	}
	if (existing?.github_connection_id !== null && existing?.github_connection_id !== undefined) {
		if (repoOwnerChanged(existing.repo_url, repoUrl) || input.githubInstallationId === null) {
			fail(409, 'an application source connection cannot be reassigned')
		}
	}
	if (input.githubInstallationId === null) return { githubConnectionId: null, githubInstallationId: null }
	if (!bindsSource) return {}
	const repository = parseGitHubRepo(repoUrl)
	if (repository === null) fail(400, 'a private source must be a GitHub repository')
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

function repoOwnerChanged(currentRepoUrl: string, nextRepoUrl: string): boolean {
	const current = parseGitHubRepo(currentRepoUrl)
	const next = parseGitHubRepo(nextRepoUrl)
	if (current === null || next === null) return currentRepoUrl !== nextRepoUrl
	return current.owner.toLowerCase() !== next.owner.toLowerCase()
}

/**
 * Refuse a delete a resource claim holds, naming what holds it. Releasing the claim is a user decision:
 * fabrika deletes no provider resource (ADR-0034), so a freed name makes the orphaned live service
 * adoptable by the next app, carrying its old secrets.
 */
export function assertNoHeldResourceClaims(subject: string, claims: readonly NamespaceResourceClaimRow[]): void {
	if (claims.length === 0) return
	const byNamespace = new Map<string, string[]>()
	for (const claim of claims) {
		const keys = byNamespace.get(claim.namespace_id) ?? []
		keys.push(claim.resource_key)
		byNamespace.set(claim.namespace_id, keys)
	}
	const held = [...byNamespace].map(([namespaceId, keys]) => `${namespaceId} (${keys.join(', ')})`).join(', ')
	fail(409, `${subject} still holds deployment namespace resource claims: ${held}`)
}

/**
 * Deleting a `dev` environment would drop its sandbox records and leave their Box sandboxes, proxy secrets and source
 * keys behind, and deleting the environment the workspaces belong to (the authoring one) would delete workspaces that a
 * sandbox row still names. Either waits until each workspace sandbox was removed: by abandoning the workspace, or by
 * maintenance.
 */
export async function assertNoDevSandboxes(c: RegistryUseCaseContext, envs: readonly AppEnvRow[]): Promise<void> {
	for (const appEnv of envs) {
		const sandboxes = appEnv.kind === 'dev'
			? await c.repositories.devSandboxes.listByEnvironment(appEnv.app_id, appEnv.env)
			: await c.repositories.devSandboxes.listByWorkspaceEnvironment(appEnv.app_id, appEnv.env)
		if (sandboxes.length === 0) continue
		const holder = appEnv.kind === 'dev' ? 'dev environment' : 'the workspaces of environment'
		fail(
			409,
			`${holder} ${appEnv.app_id}/${appEnv.env} still ${appEnv.kind === 'dev' ? 'has' : 'have'} ${sandboxes.length} workspace sandbox(es) (workspaces `
				+ `${sandboxes.map((row) => row.workspace_id).join(', ')}); delete those workspaces with delete_workspace, or wait for `
				+ 'maintenance to remove idle ones, then retry',
		)
	}
}

export async function requireApp(c: RegistryUseCaseContext, appId: string): Promise<AppRow> {
	const app = await c.repositories.registry.getApp(appId)
	if (app === null) fail(404, 'app not found')
	return app
}
