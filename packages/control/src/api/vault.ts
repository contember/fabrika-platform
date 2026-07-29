// Vault management handlers: write-only set / rotate / delete of the encrypted per-app secret VALUES
// behind the registry's `app_secrets.value_ref` column. ACL-gated by `secret.manage` (the router does
// the can-check before these run) and audited. VALUES NEVER leave the vault — these endpoints accept a
// value, store it encrypted, and write the resulting `vault:<id>` ref back onto the row. No handler
// ever RETURNS a value, and no value is logged (audit metadata carries only names / refs / scopes).
//
// The vault holds ONLY app/app-env secrets (scope 'app'|'app-env', app-scoped ACL). Platform creds
// (the CF API token, propustka provisioning creds) are fabrika's OWN Worker secrets (src/env.ts), not
// vault entries — single-account, so there is no per-account token to manage here.
//
// On SET: store a fresh vault entry, then write its ref onto the row. If the row already pointed at a
// vault ref, the old entry is deleted (no orphaned ciphertext) — unless it was a non-vault ref (e.g.
// `env:`/`secretstore:`), which is left untouched (we don't own it). ROTATE re-encrypts the value at
// the row's existing vault ref in place. DELETE removes the vault entry (the row keeps its now-dangling
// ref; deleting the row itself is the registry's job).

import type { ControlProvider, ProviderManagedSecrets } from '@fabrika/provider-contract'
import type { AppEnvRow, Db } from '../db'
import { error, json, readJson } from '../http'
import type { Authorized } from '../iam'
import { stringField } from '../json'
import { providerEnvironment } from '../run-lifecycle'
import { parseVaultRef, type SecretScope, type Vault } from '../vault'

/** Context the vault handlers receive — the Db, the (constructed) Vault, and the auditing caller. */
export interface VaultContext {
	db: Db
	vault?: () => Promise<Vault>
	provider: ControlProvider
	request: Request
	url: URL
	authorized: Authorized
}

/**
 * `PUT /api/apps/:id/secrets/:name/value` — set an app/app-env secret VALUE (body `{ value, env? }`).
 * Stores it in the vault and upserts the app_secrets row with the `vault:<id>` ref. `env` null/omitted
 * = the all-env layer; a string narrows it to that env. Replaces any prior vault entry for the layer.
 */
export async function setAppSecretValue(c: VaultContext, appId: string, name: string): Promise<Response> {
	if (!(await c.db.getApp(appId))) {
		return error(404, 'app not found')
	}
	const body = await readJson(c.request)
	const value = stringField(body, 'value')
	if (value === undefined) {
		return error(400, 'value required')
	}
	const env = readEnv(c.url, body)
	const target = await secretTarget(c, appId, env)
	if (target instanceof Response) return target
	if (target.kind === 'provider') {
		const { valueRef: ref } = await target.secrets.put({
			environment: providerEnvironment(target.appEnv),
			name,
			value,
		})
		await c.db.upsertAppSecret({ appId, env: target.appEnv.env, name, valueRef: ref })
		await audit(c, 'app.secret.set', appId, target.appEnv.env, name, ref)
		return json({ ok: true, valueRef: ref })
	}
	const vault = await requireVault(c)
	if (vault instanceof Response) return vault
	const scope: SecretScope = env === null ? 'app' : 'app-env'
	const prior = await findAppSecretRef(c.db, appId, env, name)
	const ref = await vault.putSecret(scope, `${scope}:${appId}/${env ?? '*'}/${name}`, value)
	await c.db.upsertAppSecret({ appId, env, name, valueRef: ref })
	if (prior !== null) {
		await deletePriorVaultEntry(vault, prior)
	}
	await audit(c, 'app.secret.set', appId, env, name, ref)
	return json({ ok: true, valueRef: ref })
}

/** `PATCH /api/apps/:id/secrets/:name/value` — re-encrypt the secret VALUE in place (body `{ value, env? }`). */
export async function rotateAppSecretValue(c: VaultContext, appId: string, name: string): Promise<Response> {
	if (!(await c.db.getApp(appId))) {
		return error(404, 'app not found')
	}
	const body = await readJson(c.request)
	const value = stringField(body, 'value')
	if (value === undefined) {
		return error(400, 'value required')
	}
	const env = readEnv(c.url, body)
	const ref = await findAppSecretRef(c.db, appId, env, name)
	if (ref === null) {
		return error(404, 'secret not found')
	}
	const target = await secretTarget(c, appId, env)
	if (target instanceof Response) return target
	if (target.kind === 'provider') {
		await target.secrets.put({
			environment: providerEnvironment(target.appEnv),
			name,
			value,
		})
		await c.authorized.auth.audit({
			action: 'app.secret.rotate',
			resourceType: 'app_secret',
			resourceId: `${appId}/${target.appEnv.env}/${name}`,
			metadata: { name, env: target.appEnv.env },
		})
		return json({ ok: true })
	}
	if (parseVaultRef(ref) === null) {
		return error(409, 'secret is not stored in the vault — set it first')
	}
	const vault = await requireVault(c)
	if (vault instanceof Response) return vault
	await vault.rotate(ref, value)
	await c.authorized.auth.audit({
		action: 'app.secret.rotate',
		resourceType: 'app_secret',
		resourceId: `${appId}/${env ?? '*'}/${name}`,
		metadata: { name, env },
	})
	return json({ ok: true })
}

/** `DELETE /api/apps/:id/secrets/:name/value?env=` — remove the vault entry (ref left dangling on the row). */
export async function deleteAppSecretValue(c: VaultContext, appId: string, name: string): Promise<Response> {
	if (!(await c.db.getApp(appId))) {
		return error(404, 'app not found')
	}
	const env = readEnv(c.url, undefined)
	const ref = await findAppSecretRef(c.db, appId, env, name)
	if (ref === null) {
		return error(404, 'secret not found')
	}
	const target = await secretTarget(c, appId, env)
	if (target instanceof Response) return target
	if (target.kind === 'provider') {
		await target.secrets.delete({
			environment: providerEnvironment(target.appEnv),
			name,
		})
		await c.authorized.auth.audit({
			action: 'app.secret.value.delete',
			resourceType: 'app_secret',
			resourceId: `${appId}/${target.appEnv.env}/${name}`,
			metadata: { name, env: target.appEnv.env },
		})
		return json({ ok: true })
	}
	if (parseVaultRef(ref) === null) {
		return error(409, 'secret is not stored in the vault')
	}
	const vault = await requireVault(c)
	if (vault instanceof Response) return vault
	const removed = await vault.delete(ref)
	await c.authorized.auth.audit({
		action: 'app.secret.value.delete',
		resourceType: 'app_secret',
		resourceId: `${appId}/${env ?? '*'}/${name}`,
		metadata: { name, env },
	})
	return json({ ok: removed })
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** The secret layer: `?env=` (query) or `env` (body); empty/absent → null (the all-env layer). */
function readEnv(url: URL, body: unknown): string | null {
	const fromBody = body === undefined ? undefined : stringField(body, 'env')
	const raw = fromBody ?? url.searchParams.get('env') ?? null
	return raw === null || raw === '' ? null : raw
}

/** The current `value_ref` for an (app, env, name) secret layer, or null when no such row exists. */
async function findAppSecretRef(db: Db, appId: string, env: string | null, name: string): Promise<string | null> {
	const rows = await db.listAppSecrets(appId)
	const match = rows.find((r) => r.name === name && r.env === env)
	return match ? match.value_ref : null
}

/** Delete a prior VAULT entry when replacing a ref, so no orphaned ciphertext lingers. Non-vault refs are left alone. */
async function deletePriorVaultEntry(vault: Vault, priorRef: string): Promise<void> {
	if (parseVaultRef(priorRef) !== null) {
		await vault.delete(priorRef)
	}
}

type SecretTarget =
	| { kind: 'vault' }
	| { kind: 'provider'; appEnv: AppEnvRow; secrets: ProviderManagedSecrets }

async function secretTarget(c: VaultContext, appId: string, env: string | null): Promise<SecretTarget | Response> {
	const secrets = c.provider.secrets
	if (secrets === undefined) {
		return { kind: 'vault' }
	}
	if (env === null) {
		return error(400, 'provider-managed secret values require an explicit env')
	}
	const appEnv = await c.db.getAppEnv(appId, env)
	if (appEnv === null) {
		return error(404, 'app env not found')
	}
	if (appEnv.provider !== c.provider.id) {
		return error(409, `app env belongs to provider ${appEnv.provider}`)
	}
	return { kind: 'provider', appEnv, secrets }
}

async function requireVault(c: VaultContext): Promise<Vault | Response> {
	if (c.vault === undefined) {
		return error(500, 'vault not configured (VOZKA_VAULT_KEY missing)')
	}
	try {
		return await c.vault()
	} catch {
		return error(500, 'vault unavailable (check VOZKA_VAULT_KEY)')
	}
}

async function audit(
	c: VaultContext,
	action: string,
	appId: string,
	env: string | null,
	name: string,
	valueRef: string,
): Promise<void> {
	await c.authorized.auth.audit({
		action,
		resourceType: 'app_secret',
		resourceId: `${appId}/${env ?? '*'}/${name}`,
		metadata: { name, env, valueRef },
	})
}
