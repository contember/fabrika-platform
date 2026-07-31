import type { AuthContext } from '@fabrika/auth'
import type { OkResponse, SecretValueResponse, SetSecretValueRequest } from '@fabrika/control-contract'
import type { ControlProvider, ProviderManagedSecrets } from '@fabrika/provider-contract'
import type { AppEnvRow, ControlRepositories } from '../db'
import { readJson } from '../http'
import type { Authorized } from '../iam'
import { stringField } from '../json'
import { providerEnvironment } from '../run-lifecycle'
import { parseVaultRef, type SecretScope, type Vault } from '../vault'
import { fail, jsonAdapter } from './domain'

export interface VaultContext {
	readonly repositories: ControlRepositories
	readonly vault?: () => Promise<Vault>
	readonly provider: ControlProvider
	readonly request: Request
	readonly url: URL
	readonly authorized: Authorized
}

export interface VaultUseCaseContext {
	readonly repositories: ControlRepositories
	readonly vault?: () => Promise<Vault>
	readonly provider: ControlProvider
	readonly auth: AuthContext
}

function useCaseContext(c: VaultContext): VaultUseCaseContext {
	return {
		repositories: c.repositories,
		provider: c.provider,
		auth: c.authorized.auth,
		...(c.vault === undefined ? {} : { vault: c.vault }),
	}
}

export async function setAppSecretValue(c: VaultContext, appId: string, name: string): Promise<Response> {
	return jsonAdapter(async () => setAppSecretValueUseCase(useCaseContext(c), appId, name, parseSecretValue(await readJson(c.request))))
}

export async function setAppSecretValueUseCase(
	c: VaultUseCaseContext,
	appId: string,
	name: string,
	input: SetSecretValueRequest,
): Promise<SecretValueResponse> {
	await requireApp(c, appId)
	const env = input.env ?? null
	const target = await secretTarget(c, appId, env)
	if (target.kind === 'provider') {
		const { valueRef } = await target.secrets.put({
			environment: await providerEnvironment(c.repositories.registry, target.appEnv),
			name,
			value: input.value,
		})
		await c.repositories.registry.upsertAppSecret({ appId, env: target.appEnv.env, name, valueRef })
		await audit(c, 'app.secret.set', appId, target.appEnv.env, name, valueRef)
		return { ok: true, valueRef }
	}
	const vault = await requireVault(c)
	const scope: SecretScope = env === null ? 'app' : 'app-env'
	const prior = await findAppSecretRef(c.repositories, appId, env, name)
	const valueRef = await vault.putSecret(scope, `${scope}:${appId}/${env ?? '*'}/${name}`, input.value)
	await c.repositories.registry.upsertAppSecret({ appId, env, name, valueRef })
	if (prior !== null) await deletePriorVaultEntry(vault, prior)
	await audit(c, 'app.secret.set', appId, env, name, valueRef)
	return { ok: true, valueRef }
}

export async function rotateAppSecretValue(c: VaultContext, appId: string, name: string): Promise<Response> {
	return jsonAdapter(async () => rotateAppSecretValueUseCase(useCaseContext(c), appId, name, parseSecretValue(await readJson(c.request))))
}

export async function rotateAppSecretValueUseCase(
	c: VaultUseCaseContext,
	appId: string,
	name: string,
	input: SetSecretValueRequest,
): Promise<OkResponse> {
	await requireApp(c, appId)
	const env = input.env ?? null
	const valueRef = await findAppSecretRef(c.repositories, appId, env, name)
	if (valueRef === null) fail(404, 'secret not found')
	const target = await secretTarget(c, appId, env)
	if (target.kind === 'provider') {
		await target.secrets.put({
			environment: await providerEnvironment(c.repositories.registry, target.appEnv),
			name,
			value: input.value,
		})
		await c.auth.audit({
			action: 'app.secret.rotate',
			resourceType: 'app_secret',
			resourceId: `${appId}/${target.appEnv.env}/${name}`,
			metadata: { name, env: target.appEnv.env },
		})
		return { ok: true }
	}
	if (parseVaultRef(valueRef) === null) fail(409, 'secret is not stored in the vault — set it first')
	await (await requireVault(c)).rotate(valueRef, input.value)
	await c.auth.audit({
		action: 'app.secret.rotate',
		resourceType: 'app_secret',
		resourceId: `${appId}/${env ?? '*'}/${name}`,
		metadata: { name, env },
	})
	return { ok: true }
}

export async function deleteAppSecretValue(c: VaultContext, appId: string, name: string): Promise<Response> {
	return jsonAdapter(() => deleteAppSecretValueUseCase(useCaseContext(c), appId, name, queryLayer(c.url)))
}

export async function deleteAppSecretValueUseCase(
	c: VaultUseCaseContext,
	appId: string,
	name: string,
	env: string | null,
): Promise<OkResponse> {
	await requireApp(c, appId)
	const valueRef = await findAppSecretRef(c.repositories, appId, env, name)
	if (valueRef === null) fail(404, 'secret not found')
	const target = await secretTarget(c, appId, env)
	if (target.kind === 'provider') {
		await target.secrets.delete({
			environment: await providerEnvironment(c.repositories.registry, target.appEnv),
			name,
		})
		await c.auth.audit({
			action: 'app.secret.value.delete',
			resourceType: 'app_secret',
			resourceId: `${appId}/${target.appEnv.env}/${name}`,
			metadata: { name, env: target.appEnv.env },
		})
		return { ok: true }
	}
	if (parseVaultRef(valueRef) === null) fail(409, 'secret is not stored in the vault')
	const removed = await (await requireVault(c)).delete(valueRef)
	await c.auth.audit({
		action: 'app.secret.value.delete',
		resourceType: 'app_secret',
		resourceId: `${appId}/${env ?? '*'}/${name}`,
		metadata: { name, env },
	})
	return { ok: removed }
}

function parseSecretValue(body: unknown): SetSecretValueRequest {
	const value = stringField(body, 'value')
	if (value === undefined) fail(400, 'value required')
	const env = stringField(body, 'env')
	return { value, ...(env === undefined ? {} : { env }) }
}

function queryLayer(url: URL): string | null {
	const value = url.searchParams.get('env')
	return value === null || value === '' ? null : value
}

async function requireApp(c: VaultUseCaseContext, appId: string): Promise<void> {
	if (!(await c.repositories.registry.getApp(appId))) fail(404, 'app not found')
}

async function findAppSecretRef(repositories: ControlRepositories, appId: string, env: string | null, name: string): Promise<string | null> {
	const match = (await repositories.registry.listAppSecrets(appId)).find((row) => row.name === name && row.env === env)
	return match?.value_ref ?? null
}

async function deletePriorVaultEntry(vault: Vault, priorRef: string): Promise<void> {
	if (parseVaultRef(priorRef) !== null) await vault.delete(priorRef)
}

type SecretTarget =
	| { kind: 'vault' }
	| { kind: 'provider'; appEnv: AppEnvRow; secrets: ProviderManagedSecrets }

async function secretTarget(c: VaultUseCaseContext, appId: string, env: string | null): Promise<SecretTarget> {
	const secrets = c.provider.secrets
	if (secrets === undefined) return { kind: 'vault' }
	if (env === null) fail(400, 'provider-managed secret values require an explicit env')
	const appEnv = await c.repositories.registry.getAppEnv(appId, env)
	if (appEnv === null) fail(404, 'app env not found')
	if (appEnv.provider !== c.provider.id) fail(409, `app env belongs to provider ${appEnv.provider}`)
	return { kind: 'provider', appEnv, secrets }
}

async function requireVault(c: VaultUseCaseContext): Promise<Vault> {
	if (c.vault === undefined) fail(500, 'vault not configured (FABRIKA_CONTROL_VAULT_KEY missing)')
	try {
		return await c.vault()
	} catch {
		fail(500, 'vault unavailable (check FABRIKA_CONTROL_VAULT_KEY)')
	}
}

async function audit(c: VaultUseCaseContext, action: string, appId: string, env: string | null, name: string, valueRef: string): Promise<void> {
	await c.auth.audit({
		action,
		resourceType: 'app_secret',
		resourceId: `${appId}/${env ?? '*'}/${name}`,
		metadata: { name, env, valueRef },
	})
}
