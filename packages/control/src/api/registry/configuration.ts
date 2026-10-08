import type { AppSecretDto, AppVarDto, ListResponse, OkResponse, PutAppVarRequest } from '@fabrika/control-contract'
import type { ControlProvider } from '@fabrika/provider-contract'
import { type AppSecretRow, type AppVarRow } from '../../db'
import { parseVaultRef } from '../../vault'
import { fail } from '../domain'
import { parseStoredEnvelope } from '../provider-envelope'
import { requireApp } from './apps'
import { type RegistryUseCaseContext } from './context'
import { assertAppVarValue, assertNoFrameworkReference, assertUnmanagedName } from './validation'

export async function listAppSecretsUseCase(c: RegistryUseCaseContext, appId: string): Promise<ListResponse<AppSecretDto>> {
	await requireApp(c, appId)
	return { items: (await c.repositories.registry.listAppSecrets(appId)).map((row) => toAppSecretDto(row, c.provider)) }
}

export async function deleteAppSecretUseCase(c: RegistryUseCaseContext, appId: string, name: string, env: string | null): Promise<OkResponse> {
	if (!(await c.repositories.registry.deleteAppSecret(appId, env, name))) fail(404, 'secret not found')
	await c.auth.audit({ action: 'app.secret.delete', resourceType: 'app_secret', resourceId: `${appId}/${env ?? '*'}/${name}` })
	return { ok: true }
}

export async function listAppVarsUseCase(c: RegistryUseCaseContext, appId: string): Promise<ListResponse<AppVarDto>> {
	await requireApp(c, appId)
	return { items: (await c.repositories.registry.listAppVars(appId)).map(toAppVarDto) }
}

export async function putAppVarUseCase(c: RegistryUseCaseContext, appId: string, input: PutAppVarRequest): Promise<AppVarDto> {
	await requireApp(c, appId)
	assertUnmanagedName('variable', input.name)
	assertAppVarValue(input.value)
	assertNoFrameworkReference('variable', input.value)
	const env = input.env ?? null
	await assertDeclaredVariable(c, appId, env, input.name)
	const row = await c.repositories.registry.upsertAppVar({ appId, env, name: input.name, value: input.value })
	await c.auth.audit({
		action: 'app.var.upsert',
		resourceType: 'app_var',
		resourceId: `${appId}/${env ?? '*'}/${input.name}`,
		metadata: { name: input.name, env },
	})
	return toAppVarDto(row)
}

/**
 * Refuse a variable the app's artifact does not declare, at the point it is SET.
 *
 * A variable is an input to the app's own configuration on both providers — the deploy forwards it and
 * the config decides what to do with it — so a name the config never reads is stored and then ignored.
 * Accepting it silently is how the worked example's one required value came to be set in three places
 * and take effect in none ([ADR-0035](../../../docs/decisions/0035-the-platform-owns-the-application-iam-issuer.md)).
 *
 * Only a provider that CAN answer constrains anything, and only against environments that exist: an
 * app registered in no environment yet has nothing to check against, and refusing there would break
 * setting a value before the first registration.
 */
async function assertDeclaredVariable(c: RegistryUseCaseContext, appId: string, env: string | null, name: string): Promise<void> {
	const declaredVariables = c.provider.declaredVariables
	if (declaredVariables === undefined) return
	const rows = (await c.repositories.registry.listAppEnvs(appId)).filter((row) => row.provider === c.provider.id && (env === null || row.env === env))
	if (rows.length === 0) return
	const declared = new Set<string>()
	let answered = false
	for (const row of rows) {
		const names = declaredVariables({ artifact: parseStoredEnvelope(row.provider_artifact_json, `app env ${appId}/${row.env} artifact`) })
		if (names === undefined) continue
		answered = true
		for (const declaredName of names) declared.add(declaredName)
	}
	if (!answered || declared.has(name)) return
	fail(
		400,
		`application variable "${name}" is not declared by ${appId}${
			env === null ? '' : `/${env}`
		} — add it to \`pipeline.vars\` in the app's config and register the rebuilt manifest`,
	)
}

export async function deleteAppVarUseCase(c: RegistryUseCaseContext, appId: string, name: string, env: string | null): Promise<OkResponse> {
	if (!(await c.repositories.registry.deleteAppVar(appId, env, name))) fail(404, 'var not found')
	await c.auth.audit({ action: 'app.var.delete', resourceType: 'app_var', resourceId: `${appId}/${env ?? '*'}/${name}` })
	return { ok: true }
}

/**
 * Never echo a ref control cannot vouch for: a pre-D4 `literal:` row holds the plaintext itself. The
 * provider-managed case relies on such an installation writing every app secret through the provider.
 */
export function toAppSecretDto(row: AppSecretRow, provider: Pick<ControlProvider, 'secrets'>): AppSecretDto {
	const common = { appId: row.app_id, env: row.env, name: row.name, createdAt: row.created_at }
	if (parseVaultRef(row.value_ref) !== null) return { ...common, storage: 'vault', valueRef: row.value_ref }
	return { ...common, storage: provider.secrets === undefined ? 'legacy' : 'provider', valueRef: null }
}

function toAppVarDto(row: AppVarRow): AppVarDto {
	return { appId: row.app_id, env: row.env, name: row.name, value: row.value, createdAt: row.created_at }
}
