// The Worker bindings a contract application's object boots with, each read structurally: IAM's application
// entrypoint, the SPA's Workers Assets and the owners' proxy Workers.

import { DecodedIamMembership } from '@fabrika/auth'
import type { IamMembershipRpc, MintFromKeyResult } from '@fabrika/auth-core'
import { parseJwks } from '@fabrika/jwks'
import { z } from 'zod/v4'
import type { IamKeySource } from '../implement/boot.js'
import { CONNECT_BINDING_PREFIX, type ConnectFetch } from '../implement/connect.js'
import type { SpaAssets } from '../implement/dispatch.js'
import type { WorkloadTokenSource } from '../implement/workload.js'

/** The method `name` of a binding, bound to it, or `null` when it has none. */
export function method(target: unknown, name: string): ((...args: unknown[]) => unknown) | null {
	if (typeof target !== 'object' || target === null || !(name in target)) {
		return null
	}
	const found: unknown = Reflect.get(target, name)
	return typeof found === 'function' ? (...args) => Reflect.apply(found, target, args) : null
}

export function bindingKeySource(binding: unknown): IamKeySource {
	const getJwks = method(binding, 'getJwks')
	if (getJwks === null) {
		throw new Error('the IAM binding is missing (env.IAM); the platform binds it to every application Worker')
	}
	return {
		async getJwks() {
			const jwks = parseJwks(await getJwks())
			if (jwks === null) {
				throw new Error('IAM returned no usable key set')
			}
			return jwks
		},
	}
}

/**
 * IAM's membership operations on the `IAM` binding (`PropustkaApplication`), every answer decoded like the HTTP
 * transport's. A binding without them is no membership transport, and `boot` refuses a contract that needs one.
 */
export function bindingMembership(binding: unknown): IamMembershipRpc | undefined {
	const methods = ['requestDelegation', 'createScope', 'assignMember', 'revokeMember', 'listMembers', 'issueLink', 'revokeLink'] as const
	if (!methods.every((name) => method(binding, name) !== null)) {
		return undefined
	}
	return new DecodedIamMembership(async (name, input) => {
		const call = method(binding, name)
		if (call === null) {
			throw new Error(`the IAM binding has no ${name}`)
		}
		return await call(input)
	})
}

const mintFromKeyResultSchema = z.union([
	z.strictObject({ ok: z.literal(true), token: z.string().min(1), expiresAt: z.number() }),
	z.strictObject({ ok: z.literal(false), reason: z.enum(['invalid_key', 'unknown_principal', 'disabled', 'token_too_large']) }),
])

/**
 * IAM's token exchange on the `IAM` binding (`mintFromKey`), for the keys of the jobs, webhooks and public procedures.
 * An answer that is not IAM's decided outcome throws: "IAM could not be asked".
 */
export function bindingWorkloadTokens(binding: unknown): WorkloadTokenSource | undefined {
	if (method(binding, 'mintFromKey') === null) {
		return undefined
	}
	return {
		async exchange(input): Promise<MintFromKeyResult> {
			const mint = method(binding, 'mintFromKey')
			if (mint === null) {
				throw new Error('the IAM binding has no mintFromKey')
			}
			const parsed = mintFromKeyResultSchema.safeParse(await mint({ app: input.app, key: input.key, requestId: crypto.randomUUID() }))
			if (!parsed.success) {
				throw new Error('IAM answered the workload token exchange with something that is not its outcome')
			}
			return parsed.data
		},
	}
}

export function bindingAssets(binding: unknown): SpaAssets | undefined {
	const fetchAsset = method(binding, 'fetch')
	if (fetchAsset === null) {
		return undefined
	}
	return {
		async serve(_mount, request) {
			const response: unknown = await fetchAsset(request)
			if (!(response instanceof Response)) {
				throw new Error('the ASSETS binding answered something that is not a Response')
			}
			return response
		},
	}
}

/**
 * The service bindings to owners' proxy Workers (`FABRIKA_CONNECT_<IMPORT>`), which `captureEnvironment` keeps from
 * the application because no `FABRIKA_*` value reaches it. A binding routes by itself: the URL it is called with
 * carries the owner's host, which the proxy Worker selects the application by.
 */
export function connectBindings(env: Readonly<Record<string, unknown>>): Record<string, ConnectFetch> {
	const bindings: Record<string, ConnectFetch> = {}
	for (const [name, binding] of Object.entries(env)) {
		// Read, not tested with `in`: a binding stub may answer `fetch` without owning the property (Lopata's does not).
		const fetchOwner: unknown = name.startsWith(CONNECT_BINDING_PREFIX) && typeof binding === 'object' && binding !== null
			? Reflect.get(binding, 'fetch')
			: undefined
		if (typeof fetchOwner === 'function') {
			bindings[name] = async (request) => {
				const response: unknown = await Reflect.apply(fetchOwner, binding, [request])
				if (!(response instanceof Response)) {
					throw new Error(`the ${name} binding answered something that is not a Response`)
				}
				return response
			}
		}
	}
	return bindings
}
