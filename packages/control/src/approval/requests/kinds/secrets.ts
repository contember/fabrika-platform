// The `secrets` kinds (ADR-0083 §1, §8): an application secret's value set, rotated or deleted, and an environment's
// token key rotated, where the write is Control's own. The value an agent sends is sealed in Control's vault under the
// request's own purpose and never stored in the row, which holds its reference, its length and its fingerprint (the
// first 8 hex characters of its SHA-256). On approval the value moves to the secret's own purpose through the use case
// the procedure runs; once the request is closed, the sealed copy is deleted. A secret the provider keeps (on Zerops
// `secretTarget` answers `provider`) is written outside Control, so it is not requestable in this release.

import { sha256Hex } from '@fabrika/auth-core'
import { CONTROL_ACTIONS } from '@fabrika/control-contract'
import { z } from 'zod'
import { fail } from '../../../api/domain'
import { rotateTokenKeyUseCase } from '../../../api/registry/environments'
import { assertNoFrameworkReference, assertUnmanagedName } from '../../../api/registry/validation'
import {
	deleteAppSecretUseCase,
	findAppSecretRef,
	putAppSecretUseCase,
	requireVault,
	rotateAppSecretValueUseCase,
	secretTarget,
	setAppSecretValueUseCase,
	type VaultUseCaseContext,
} from '../../../api/vault'
import { appSecretPurpose } from '../../../secret-resolver'
import { parseVaultRef, type Vault, VaultSecretNotFoundError, type VaultSecretPurpose } from '../../../vault'
import {
	type RequestActionContext,
	type RequestExecutionContext,
	type RequestKind,
	requestKind,
	type RequestKindContext,
	type RequestOutcome,
} from '../kind'
import {
	agentText,
	appIdField,
	envField,
	generationsField,
	generationsOf,
	layerCoordinates,
	layerField,
	layerName,
	observed,
	outcomeOf,
	ownText,
	registryContext,
} from './shared'

/** The label of a request's sealed value, before its request id. */
export const REQUEST_SECRET_LABEL_PREFIX = 'platform:approval-request:'

/** The purpose a request's secret value is sealed under while it waits: the request's own, never the secret's. */
export function requestSecretPurpose(requestId: string): VaultSecretPurpose {
	return { scope: 'platform', label: `${REQUEST_SECRET_LABEL_PREFIX}${requestId}` }
}

/** The fingerprint the page shows and the agent prints: the first 8 hex characters of the value's SHA-256. */
export function secretFingerprint(value: string): string {
	return sha256Hex(value).slice(0, 8)
}

const NOT_REQUESTABLE = 'is not requestable yet'

/** Refuse a secret write that reaches outside Control: the provider keeps the environment's values (5b). */
async function requireLocalSecret(c: RequestActionContext, appId: string, env: string | null): Promise<void> {
	const target = await secretTarget(c, appId, env)
	if (target.kind === 'provider') {
		fail(
			400,
			`a secret of ${appId}@${target.appEnv.env} ${NOT_REQUESTABLE}: the ${c.provider.id} provider keeps this environment's secret values, so `
				+ 'the write reaches outside Control, and this release routes only writes Control makes itself through a request',
		)
	}
}

/** One secret, by its coordinates. */
interface SecretName {
	readonly appId: string
	readonly env: string | null
	readonly name: string
}

/** A secret value as the agent sends it. */
interface SecretValue extends SecretName {
	readonly value: string
}

const sealedField = z.object({ ref: z.string().min(1), length: z.number().int().nonnegative(), fingerprint: z.string().regex(/^[0-9a-f]{8}$/) })

/** The stored input of a value write: the secret and its sealed value, never the value itself. */
const sealedSecretInput = z.object({ appId: appIdField, env: envField.nullable(), name: z.string().min(1), sealed: sealedField })
type SealedSecretInput = z.infer<typeof sealedSecretInput>

const secretNameInput = z.object({ appId: appIdField, name: z.string().min(1), env: layerField })
type SecretNameInput = z.infer<typeof secretNameInput>

/** What a secret write binds: the environments it reaches, and the value stored now, by its ref and the version it holds. */
const secretBefore = z.object({ generations: generationsField, ref: z.string().nullable(), version: z.string().nullable() })
type SecretBefore = z.infer<typeof secretBefore>

async function secretBeforeOf(c: RequestKindContext, secret: SecretName): Promise<SecretBefore> {
	const generations = await generationsOf(c, secret.appId, secret.env)
	const ref = await findAppSecretRef(c.repositories, secret.appId, secret.env, secret.name)
	if (ref === null || parseVaultRef(ref) === null) return { generations, ref, version: null }
	const vault = await requireVault(c)
	return { generations, ref, version: await vault.sealedVersion(ref, appSecretPurpose(secret.appId, secret.env, secret.name)) }
}

/** The value the secret holds now in the vault, or null when it holds none Control can read as its own. */
async function storedValue(c: RequestKindContext, vault: Vault, secret: SecretName): Promise<string | null> {
	const ref = await findAppSecretRef(c.repositories, secret.appId, secret.env, secret.name)
	if (ref === null || parseVaultRef(ref) === null) return null
	const purpose = appSecretPurpose(secret.appId, secret.env, secret.name)
	if ((await vault.sealedVersion(ref, purpose)) === null) return null
	return vault.getSecretForPurpose(ref, purpose)
}

/** The sealed value, or null once it is gone. */
async function sealedValue(vault: Vault, input: SealedSecretInput, requestId: string): Promise<string | null> {
	try {
		return await vault.getSecretForPurpose(input.sealed.ref, requestSecretPurpose(requestId))
	} catch (cause) {
		if (cause instanceof VaultSecretNotFoundError) return null
		throw cause
	}
}

/** Check the value as the use case would, then seal it under the request's own purpose. */
async function holdSecret(
	c: RequestActionContext,
	secret: SecretValue,
	requestId: string,
	mustExist: boolean,
): Promise<{ readonly input: SealedSecretInput; readonly fingerprint: string }> {
	assertUnmanagedName('secret', secret.name)
	assertNoFrameworkReference('secret', secret.value)
	await requireLocalSecret(c, secret.appId, secret.env)
	if (mustExist && (await findAppSecretRef(c.repositories, secret.appId, secret.env, secret.name)) === null) fail(404, 'secret not found')
	const vault = await requireVault(c)
	const purpose = requestSecretPurpose(requestId)
	const ref = await vault.putSecret(purpose.scope, purpose.label, secret.value)
	const fingerprint = secretFingerprint(secret.value)
	return {
		input: { appId: secret.appId, env: secret.env, name: secret.name, sealed: { ref, length: [...secret.value].length, fingerprint } },
		fingerprint,
	}
}

/** Delete the sealed copy once the request is closed; one already gone is not an error. */
async function discardSealed(c: RequestKindContext, input: SealedSecretInput): Promise<void> {
	const vault = await requireVault(c)
	await vault.delete(input.sealed.ref)
}

/** The value as the page shows it: never the value, its length and fingerprint. */
function valueText(input: SealedSecretInput): string {
	return `${input.sealed.length} characters, fingerprint ${input.sealed.fingerprint}`
}

interface ValueKindOptions<Asked> {
	readonly kind: 'apps.secrets.put' | 'vault.set' | 'vault.rotate'
	readonly asked: z.ZodType<Asked, z.ZodTypeDef, unknown>
	readonly secret: (asked: Asked) => SecretValue
	/** A rotation replaces the value of a secret that exists; a put or a set creates it too. */
	readonly mustExist: boolean
	readonly verb: string
	write(c: VaultUseCaseContext, input: SealedSecretInput, value: string): Promise<unknown>
}

function secretValueKind<Asked>(options: ValueKindOptions<Asked>): RequestKind {
	return requestKind<SealedSecretInput, SecretBefore, Asked>({
		kind: options.kind,
		category: 'secrets',
		input: sealedSecretInput,
		before: secretBefore,
		coordinates: (input) => layerCoordinates(input.appId, input.env),
		requesterAction: CONTROL_ACTIONS.SECRET_MANAGE,
		requesterAt: 'app',
		asked: {
			schema: options.asked,
			coordinates: (asked) => {
				const secret = options.secret(asked)
				return layerCoordinates(secret.appId, secret.env)
			},
			hold: (c, asked, requestId) => holdSecret(c, options.secret(asked), requestId, options.mustExist),
		},
		captureBefore: (c, input) => secretBeforeOf(c, input),
		execute: async (c: RequestExecutionContext, input, execution): Promise<RequestOutcome> => {
			const vault = await requireVault(c)
			const value = await sealedValue(vault, input, execution.requestId)
			if (value === null) return { state: 'failed', error: 'the sealed value is gone, so nothing changed; ask again' }
			return outcomeOf(async () => {
				await options.write(c, input, value)
				return { name: input.name, env: input.env, fingerprint: input.sealed.fingerprint }
			})
		},
		follow: async (c, input, execution) => {
			const vault = await requireVault(c)
			const value = await sealedValue(vault, input, execution.requestId)
			// The sealed copy is deleted only once the request is closed, so a lost one leaves nothing to compare.
			if (value === null) return { state: 'unknown' }
			return observed((await storedValue(c, vault, input)) === value, { name: input.name, env: input.env, fingerprint: input.sealed.fingerprint })
		},
		discard: (c, input) => discardSealed(c, input),
		describe: (input, before) => ({
			summary: [
				ownText(`${options.verb} secret `),
				agentText(input.name),
				ownText(` of ${layerName(input.appId, input.env)}, ${valueText(input)}`),
			],
			facts: [
				{ label: 'Secret', value: agentText(input.name) },
				{ label: 'New value', value: ownText(valueText(input)) },
				{ label: 'Now', value: ownText(before.ref === null ? 'not set' : 'set; approving replaces its value') },
			],
		}),
	})
}

const putSecretAsked = z.object({ appId: appIdField, secret: z.object({ name: z.string().min(1), value: z.string(), env: layerField }) })
const secretValueAsked = z.object({ appId: appIdField, name: z.string().min(1), env: layerField, value: z.string() })
type SecretValueAsked = z.infer<typeof secretValueAsked>

const fromValueAsked = (asked: SecretValueAsked): SecretValue => ({
	appId: asked.appId,
	env: asked.env ?? null,
	name: asked.name,
	value: asked.value,
})

export const putAppSecretKind = secretValueKind({
	kind: 'apps.secrets.put',
	asked: putSecretAsked,
	secret: (asked) => ({ appId: asked.appId, env: asked.secret.env ?? null, name: asked.secret.name, value: asked.secret.value }),
	mustExist: false,
	verb: 'Set',
	write: (c, input, value) => putAppSecretUseCase(c, input.appId, { name: input.name, value, env: input.env }),
})

export const setVaultSecretKind = secretValueKind({
	kind: 'vault.set',
	asked: secretValueAsked,
	secret: fromValueAsked,
	mustExist: false,
	verb: 'Set',
	write: (c, input, value) => setAppSecretValueUseCase(c, input.appId, input.name, { value, env: input.env }),
})

export const rotateVaultSecretKind = secretValueKind({
	kind: 'vault.rotate',
	asked: secretValueAsked,
	secret: fromValueAsked,
	mustExist: true,
	verb: 'Rotate',
	write: (c, input, value) => rotateAppSecretValueUseCase(c, input.appId, input.name, { value, env: input.env }),
})

/**
 * Whether deleting the secret stays in Control: its value is in the vault, or it is a row that holds its value itself;
 * one the provider keeps is deleted there first (`deleteAppSecretUseCase`).
 */
async function requireLocalDelete(c: RequestActionContext, input: SecretNameInput): Promise<void> {
	const env = input.env ?? null
	const ref = await findAppSecretRef(c.repositories, input.appId, env, input.name)
	if (ref === null) fail(404, 'secret not found')
	if (parseVaultRef(ref) !== null || c.provider.secrets === undefined || env === null) return
	await requireLocalSecret(c, input.appId, env)
}

function deleteSecretKind(kind: 'apps.secrets.delete' | 'vault.delete'): RequestKind {
	return requestKind<SecretNameInput, SecretBefore>({
		kind,
		category: 'secrets',
		input: secretNameInput,
		before: secretBefore,
		coordinates: (input) => layerCoordinates(input.appId, input.env),
		requesterAction: CONTROL_ACTIONS.SECRET_MANAGE,
		requesterAt: 'app',
		admit: requireLocalDelete,
		captureBefore: (c, input) => secretBeforeOf(c, { appId: input.appId, env: input.env ?? null, name: input.name }),
		execute: (c, input) =>
			outcomeOf(async () => {
				await deleteAppSecretUseCase(c, input.appId, input.name, input.env ?? null)
				return { name: input.name, env: input.env ?? null }
			}),
		follow: async (c, input) => {
			const ref = await findAppSecretRef(c.repositories, input.appId, input.env ?? null, input.name)
			return observed(ref === null, { name: input.name, env: input.env ?? null })
		},
		describe: (input) => ({
			summary: [ownText('Delete secret '), agentText(input.name), ownText(` of ${layerName(input.appId, input.env ?? null)}`)],
			facts: [{ label: 'Secret', value: agentText(input.name) }],
		}),
	})
}

export const deleteAppSecretKind = deleteSecretKind('apps.secrets.delete')
export const deleteVaultSecretKind = deleteSecretKind('vault.delete')

const tokenKeyInput = z.object({ appId: appIdField, env: envField })
type TokenKeyInput = z.infer<typeof tokenKeyInput>

/** What a rotation binds: the environment, and the signing key with whether its rotation is asked already. */
const tokenKeyBefore = z.object({ generation: z.number(), keyId: z.string().nullable(), rotationRequested: z.boolean() })
type TokenKeyBefore = z.infer<typeof tokenKeyBefore>

async function signingKey(c: RequestKindContext, input: TokenKeyInput): Promise<{ keyId: string | null; rotationRequested: boolean }> {
	const active = (await c.repositories.tokenKeys.list(input.appId, input.env)).find((key) => key.retired_at === null)
	return { keyId: active?.key_id ?? null, rotationRequested: active !== undefined && active.rotation_requested_at !== null }
}

export const rotateTokenKeyKind = requestKind<TokenKeyInput, TokenKeyBefore>({
	kind: 'apps.environments.rotateTokenKey',
	category: 'secrets',
	input: tokenKeyInput,
	before: tokenKeyBefore,
	coordinates: (input) => ({ appId: input.appId, env: input.env }),
	requesterAction: CONTROL_ACTIONS.SECRET_MANAGE,
	requesterAt: 'app',
	captureBefore: async (c, input) => ({
		generation: (await c.repositories.registry.getAppEnv(input.appId, input.env))?.generation ?? 0,
		...(await signingKey(c, input)),
	}),
	execute: (c, input, execution) =>
		outcomeOf(async () => {
			const rotated = await rotateTokenKeyUseCase(registryContext(c, execution), input.appId, input.env, Math.floor(Date.now() / 1000))
			return { requested: rotated.requested }
		}),
	follow: async (c, input) => {
		const key = await signingKey(c, input)
		return key.keyId === null ? { state: 'executed', result: { requested: false } } : observed(key.rotationRequested, { requested: true })
	},
	describe: (input, before) => ({
		summary: [ownText(`Rotate the token signing key of ${input.appId}@${input.env} at its next deploy`)],
		facts: [{ label: 'Now', value: ownText(before.keyId === null ? 'no signing key yet: nothing to rotate' : `signing with key ${before.keyId}`) }],
	}),
})
