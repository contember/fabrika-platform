import { z } from 'zod'

export interface RouterLeaf {
	method: string
	requirements: number
	/** Top-level keys of the procedure's input object; empty only for a procedure that takes no input. */
	inputKeys: string[]
}

/** Every procedure in a shipped router, as `a.b.c` with its authz requirement count and input keys. */
export function routerLeaves(node: unknown, path: string[] = []): RouterLeaf[] {
	if (node === null || typeof node !== 'object') {
		return []
	}
	const tag = Reflect.get(node, '_tag')
	if (tag === 'procedure') {
		const requirements = Reflect.get(node, 'requirements')
		return [{
			method: path.join('.'),
			requirements: Array.isArray(requirements) ? requirements.length : 0,
			inputKeys: objectKeys(Reflect.get(node, 'input')),
		}]
	}
	if (tag === 'router') {
		const def = Reflect.get(node, '_def')
		if (def === null || typeof def !== 'object') {
			return []
		}
		return Object.entries(def).flatMap(([key, child]) => routerLeaves(child, [...path, key]))
	}
	return []
}

/**
 * Fails closed: an input schema this cannot read throws, so a key check can never pass by reading
 * nothing. Only the builder's implicit "no input" schema has no keys.
 */
function objectKeys(schema: unknown): string[] {
	const unwrapped = unwrap(schema)
	if (unwrapped instanceof z.ZodObject) {
		return Object.keys(unwrapped.shape)
	}
	if (!(unwrapped instanceof z.ZodType) && isImplicitVoidInput(unwrapped)) {
		return []
	}
	throw new Error('unrecognized procedure input schema')
}

function unwrap(schema: unknown): unknown {
	if (schema instanceof z.ZodEffects) return unwrap(schema.innerType())
	if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) return unwrap(schema.unwrap())
	if (schema instanceof z.ZodDefault) return unwrap(schema.removeDefault())
	if (schema instanceof z.ZodPipeline) return unwrap(schema._def.in)
	return schema
}

function isImplicitVoidInput(schema: unknown): boolean {
	if (schema === null || typeof schema !== 'object') {
		return false
	}
	const standard = Reflect.get(schema, '~standard')
	return standard !== null && typeof standard === 'object' && Reflect.get(standard, 'vendor') === 'fabrika'
}

/** The procedures a user administrator calls too (ADR-0058), gated by `context` instead of `.require`. */
export const USER_ADMINISTRATION = [
	'apps.getSchema',
	'apps.list',
	'grants.create',
	'grants.delete',
	'me',
	'passwords.disable',
	'passwords.issueEnrollment',
	'passwords.issueReset',
	'policies.list',
	'principals.get',
	'principals.invite',
	'principals.list',
	'principals.update',
	'roles.list',
	'sessions.list',
	'sessions.revoke',
	'sessions.revokeAll',
]

/**
 * A minimally-shaped input for each method — enough to pass validation IF the gate were missing, so a
 * 400 can never be mistaken for a refusal. Anything absent here gets `{}`, which is correct for every
 * procedure whose input is fully optional.
 */
const INPUTS: Record<string, unknown> = {
	// `null` = "no input", which is what a procedure with no `.input()` schema accepts.
	me: null,
	'apps.list': null,
	'apiKeys.list': null,
	'shareLinks.list': null,
	'principals.get': { principalId: 'nobody' },
	'principals.invite': { email: 'nobody@example.com' },
	'principals.update': { principalId: 'nobody', disabled: true },
	'principals.promote': { principalId: 'nobody' },
	'sessions.list': { principalId: 'nobody' },
	'sessions.revoke': { id: 'nobody' },
	'sessions.revokeAll': { principalId: 'nobody' },
	'passwords.issueEnrollment': { principalId: 'nobody' },
	'passwords.issueReset': { principalId: 'nobody' },
	'passwords.disable': { principalId: 'nobody' },
	'grants.create': { principalId: 'nobody', roleKey: 'admin' },
	'grants.delete': { id: 'nobody' },
	'apps.getSchema': { app: 'nowhere' },
	'apps.setReturnOrigins': { app: 'nowhere', origins: ['https://nowhere.example.com'] },
	'roles.list': { app: null },
	'policies.list': { app: 'nowhere' },
	'policies.create': { app: 'nowhere', policy: { key: 'k', name: 'n', permissions: ['*'] } },
	'policies.update': { app: 'nowhere', key: 'k', policy: { name: 'n', permissions: ['*'] } },
	'policies.delete': { app: 'nowhere', key: 'k' },
	'apiKeys.provision': { label: 'l', type: 'service', permissions: ['*'] },
	'apiKeys.rotate': { principalId: 'nobody' },
	'apiKeys.revoke': { principalId: 'nobody' },
	'workloads.issueKey': { app: 'nowhere@prod', kind: 'job', name: 'nightly', expiresAt: 4_102_444_800, keep: null },
	'workloads.revokeKeys': { app: 'nowhere@prod', kind: 'app', name: 'shop' },
	'membershipKeys.issue': { app: 'nowhere@prod', expiresAt: 4_102_444_800, keep: null },
	'shareLinks.issue': { app: 'nowhere', grants: [{ action: 'a' }], expiresAt: 1 },
	'shareLinks.revoke': { id: 'nobody' },
	'appPeople.apps': null,
	'appPeople.list': { app: 'nowhere@prod' },
	'appPeople.grant': { app: 'nowhere@prod', role: 'staff', email: 'nobody@example.com' },
	'appPeople.revoke': { app: 'nowhere@prod', role: 'staff', principalId: 'nobody' },
}

/** The input `INPUTS` names for `method`, or `{}`. */
export function procedureInput(method: string): unknown {
	return Object.hasOwn(INPUTS, method) ? INPUTS[method] : {}
}
