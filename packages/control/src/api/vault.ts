import type { AuthContext } from '@fabrika/auth'
import type { AppSecretDto, OkResponse, PutAppSecretRequest, SecretValueResponse, SetSecretValueRequest } from '@fabrika/control-contract'
import {
	type ControlProvider,
	type ProviderManagedSecrets,
	ProviderSecretError,
	type ProviderSecretPutInput,
	type ProviderSecretPutResult,
} from '@fabrika/provider-contract'
import type { AppEnvRow, AppSecretRow, ControlRepositories } from '../db'
import { providerEnvironment } from '../run-lifecycle'
import { appSecretPurpose } from '../secret-resolver'
import { parseVaultRef, type Vault, type VaultSecretPurpose } from '../vault'
import { fail } from './domain'
import { toAppSecretDto } from './registry/configuration'
import { assertUnmanagedName } from './registry/validation'

export interface VaultUseCaseContext {
	readonly repositories: ControlRepositories
	readonly vault?: () => Promise<Vault>
	readonly provider: ControlProvider
	readonly auth: AuthContext
}

export async function setAppSecretValueUseCase(
	c: VaultUseCaseContext,
	appId: string,
	name: string,
	input: SetSecretValueRequest,
): Promise<SecretValueResponse> {
	const row = await writeAppSecretValue(c, appId, name, input, 'app.secret.set')
	return { ok: true, valueRef: row.value_ref }
}

export async function putAppSecretUseCase(c: VaultUseCaseContext, appId: string, input: PutAppSecretRequest): Promise<AppSecretDto> {
	const row = await writeAppSecretValue(c, appId, input.name, { value: input.value, env: input.env ?? null }, 'app.secret.upsert')
	return toAppSecretDto(row, c.provider)
}

/** Seal the value where this installation keeps app secrets and point the registry row at it. */
async function writeAppSecretValue(
	c: VaultUseCaseContext,
	appId: string,
	name: string,
	input: SetSecretValueRequest,
	auditAction: 'app.secret.set' | 'app.secret.upsert',
): Promise<AppSecretRow> {
	await requireApp(c, appId)
	assertUnmanagedName('secret', name)
	const env = input.env ?? null
	const target = await secretTarget(c, appId, env)
	if (target.kind === 'provider') {
		const { valueRef } = await putProviderSecret(target.secrets, {
			environment: await providerEnvironment(c.repositories.registry, target.appEnv),
			name,
			value: input.value,
		})
		const row = await c.repositories.registry.upsertAppSecret({ appId, env: target.appEnv.env, name, valueRef })
		await audit(c, auditAction, appId, target.appEnv.env, name, valueRef)
		return row
	}
	const vault = await requireVault(c)
	const purpose = appSecretPurpose(appId, env, name)
	const prior = await findAppSecretRef(c.repositories, appId, env, name)
	// Ownership of the PRIOR row is settled before anything is written, so a ref this app does not own
	// leaves both the vault and the registry exactly as they were.
	if (prior !== null && parseVaultRef(prior) !== null) await assertVaultOwnership(vault, prior, purpose)
	const valueRef = await vault.putSecret(purpose.scope, purpose.label, input.value)
	const row = await c.repositories.registry.upsertAppSecret({ appId, env, name, valueRef })
	if (prior !== null) await deletePriorVaultEntry(vault, prior)
	await audit(c, auditAction, appId, env, name, valueRef)
	return row
}

/**
 * Refuse a ref whose row belongs to another purpose, naming neither the row's scope nor its label.
 *
 * A vault that cannot ANSWER — missing KEK, tampered ciphertext, database down — must not read as "you
 * do not own this", so the refusal is confirmed rather than assumed: if the ref resolves without the
 * purpose, the vault is healthy and the row simply is not ours. Anything else propagates as a 500, which
 * is also what a dangling ref has always done here.
 */
async function assertVaultOwnership(vault: Vault, ref: string, purpose: VaultSecretPurpose): Promise<void> {
	try {
		await vault.getSecretForPurpose(ref, purpose)
		return
	} catch {
		// Decided by the probe below; the plaintext it may return is discarded and never logged.
	}
	await vault.getSecret(ref)
	fail(403, 'the stored secret reference does not belong to this application secret')
}

export async function rotateAppSecretValueUseCase(
	c: VaultUseCaseContext,
	appId: string,
	name: string,
	input: SetSecretValueRequest,
): Promise<OkResponse> {
	await requireApp(c, appId)
	assertUnmanagedName('secret', name)
	const env = input.env ?? null
	const valueRef = await findAppSecretRef(c.repositories, appId, env, name)
	if (valueRef === null) fail(404, 'secret not found')
	const target = await secretTarget(c, appId, env)
	if (target.kind === 'provider') {
		await putProviderSecret(target.secrets, {
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
	const rotateVault = await requireVault(c)
	await assertVaultOwnership(rotateVault, valueRef, appSecretPurpose(appId, env, name))
	await rotateVault.rotate(valueRef, input.value)
	await c.auth.audit({
		action: 'app.secret.rotate',
		resourceType: 'app_secret',
		resourceId: `${appId}/${env ?? '*'}/${name}`,
		metadata: { name, env },
	})
	return { ok: true }
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
	const deleteVault = await requireVault(c)
	await assertVaultOwnership(deleteVault, valueRef, appSecretPurpose(appId, env, name))
	const removed = await deleteVault.delete(valueRef)
	await c.auth.audit({
		action: 'app.secret.value.delete',
		resourceType: 'app_secret',
		resourceId: `${appId}/${env ?? '*'}/${name}`,
		metadata: { name, env },
	})
	return { ok: removed }
}

/** A provider's typed refusal of the value is the caller's to fix; any other failure stays a 500. */
async function putProviderSecret(secrets: ProviderManagedSecrets, input: ProviderSecretPutInput): Promise<ProviderSecretPutResult> {
	try {
		return await secrets.put(input)
	} catch (cause) {
		if (cause instanceof ProviderSecretError || (cause instanceof Error && cause.name === 'ProviderSecretError')) fail(422, cause.message)
		throw cause
	}
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
