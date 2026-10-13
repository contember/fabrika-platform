import type { IamMembershipRpc } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { buildAuthContext } from '../client'
import { createIamMembership, IamMembership } from '../membership'
import { HttpIamRpc, IamTransportError } from '../rpc-http'

// The SDK half of the membership operations requests and decides nothing: it forwards the caller's own
// token and the app id it was built with, and hands back IAM's answer. Over HTTP a decided refusal is a
// result and a body that breaks the contract is a transport fault.

const caller = { credential: 'proxy-token', requestId: 'req-1' }
const scope = { type: 'workspace', value: 'w1' }

function http(body: unknown): { rpc: HttpIamRpc; calls: { url: string; body: unknown }[] } {
	const calls: { url: string; body: unknown }[] = []
	const rpc = new HttpIamRpc({
		origin: 'http://iam:3000',
		key: 'transport-key-0123456789abcdef',
		fetch: (url, init) => {
			calls.push({ url, body: JSON.parse(String(init.body)) })
			return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))
		},
	})
	return { rpc, calls }
}

describe('IamMembership', () => {
	test('forwards the app id, the caller token and the request id, and names no actor', async () => {
		const { rpc, calls } = http({ ok: true, assigned: { principalId: 'p1', role: 'editor' } })
		const membership = new IamMembership(rpc, 'notes@prod')
		expect(await membership.assignMember(caller, 'grant', scope, 'editor', { principalId: 'p1' })).toEqual({
			ok: true,
			assigned: { principalId: 'p1', role: 'editor' },
		})
		expect(calls).toEqual([{
			url: 'http://iam:3000/rpc/assignMember',
			body: {
				app: 'notes@prod',
				credential: 'proxy-token',
				requestId: 'req-1',
				delegation: 'grant',
				scope,
				role: 'editor',
				member: { principalId: 'p1' },
			},
		}])
	})

	test('createIamMembership needs an app id and a binding', () => {
		const { rpc } = http({})
		expect(() => createIamMembership({ IAM: rpc })).toThrow('app id is required')
		expect(() => createIamMembership({ FABRIKA_IAM_APP_ID: 'notes@prod' })).toThrow('IAM binding is missing')
		expect(createIamMembership({ IAM: rpc, FABRIKA_IAM_APP_ID: 'notes@prod' })).toBeInstanceOf(IamMembership)
	})

	test('a binding passes straight through', async () => {
		const answered: IamMembershipRpc = {
			requestDelegation: (input) => Promise.resolve({ ok: true, grant: `g-${input.endpoint}`, expiresAt: 1 }),
			createScope: () => Promise.resolve({ ok: true, scope, role: 'owner' }),
			assignMember: () => Promise.resolve({ ok: false, reason: 'not_allowed' }),
			revokeMember: () => Promise.resolve({ ok: false, reason: 'last_creator' }),
			listMembers: () => Promise.resolve({ ok: true, members: [], invitations: [] }),
			findMember: (input) =>
				Promise.resolve({ ok: true, member: { principalId: input.principalId, label: null, disabled: false, affiliation: 'internal' } }),
			issueLink: () => Promise.resolve({ ok: true, key: 'px_k', id: 'c1', expiresAt: 2 }),
			revokeLink: () => Promise.resolve({ ok: true }),
		}
		const membership = new IamMembership(answered, 'notes@prod')
		expect(await membership.requestDelegation(caller, 'api.invite')).toEqual({ ok: true, grant: 'g-api.invite', expiresAt: 1 })
		expect(await membership.createScope(caller, 'g', 'workspace')).toEqual({ ok: true, scope, role: 'owner' })
		expect(await membership.revokeMember(caller, 'g', scope, { principalId: 'p1' })).toEqual({ ok: false, reason: 'last_creator' })
		expect(await membership.issueLink(caller, 'shared', [scope], 3)).toEqual({ ok: true, key: 'px_k', id: 'c1', expiresAt: 2 })
		expect(await membership.findMember(caller, scope, 'p2', 'notes.read')).toEqual({
			ok: true,
			member: { principalId: 'p2', label: null, disabled: false, affiliation: 'internal' },
		})
	})
})

describe('HttpIamRpc — the membership methods', () => {
	test('a decided refusal is a result, an invalid request keeps its message, and an unknown reason is not_allowed', async () => {
		expect(await http({ ok: false, reason: 'invalid_delegation' }).rpc.revokeLink({ app: 'a', credential: 't', requestId: 'r', id: 'c' })).toEqual({
			ok: false,
			reason: 'invalid_delegation',
		})
		expect(
			await http({ ok: false, reason: 'invalid_request', message: 'unknown role' }).rpc.createScope({
				app: 'a',
				credential: 't',
				requestId: 'r',
				delegation: 'g',
				dimension: 'w',
			}),
		)
			.toEqual({ ok: false, reason: 'invalid_request', message: 'unknown role' })
		expect(await http({ ok: false, reason: 'granted_anyway' }).rpc.listMembers({ app: 'a', credential: 't', requestId: 'r', scope })).toEqual({
			ok: false,
			reason: 'not_allowed',
		})
	})

	test('a revoke is acknowledged only by an ok envelope', async () => {
		const base = { app: 'a', credential: 't', requestId: 'r' }
		for (const body of [{}, { revoked: true }, { ok: 'true' }]) {
			await expect(http(body).rpc.revokeMember({ ...base, delegation: 'g', scope, member: { principalId: 'p' } })).rejects.toBeInstanceOf(
				IamTransportError,
			)
			await expect(http(body).rpc.revokeLink({ ...base, id: 'c' })).rejects.toBeInstanceOf(IamTransportError)
		}
		await expect(http({ grant: 'g', expiresAt: 1 }).rpc.requestDelegation({ ...base, endpoint: 'e' })).rejects.toBeInstanceOf(IamTransportError)
		await expect(http({ ok: true, key: 'px_k', id: 'c' }).rpc.issueLink({ ...base, mount: 'm', chain: [scope], days: 1 })).rejects.toBeInstanceOf(
			IamTransportError,
		)
	})

	test('every success decodes, and a body that breaks the contract throws', async () => {
		const base = { app: 'a', credential: 't', requestId: 'r' }
		expect(await http({ ok: true, grant: 'g', expiresAt: 1 }).rpc.requestDelegation({ ...base, endpoint: 'e' })).toEqual({
			ok: true,
			grant: 'g',
			expiresAt: 1,
		})
		expect(
			await http({ ok: true, invited: { invitationId: 'i', role: 'editor', expiresAt: 3 } }).rpc.assignMember({
				...base,
				delegation: 'g',
				scope,
				role: 'editor',
				member: { email: 'a@b.test' },
			}),
		).toEqual({ ok: true, invited: { invitationId: 'i', role: 'editor', expiresAt: 3 } })
		expect(await http({ ok: true }).rpc.revokeMember({ ...base, delegation: 'g', scope, member: { invitationId: 'i' } })).toEqual({ ok: true })
		expect(await http({ ok: true, key: 'px_k', id: 'c', expiresAt: 4 }).rpc.issueLink({ ...base, mount: 'm', chain: [scope], days: 1 })).toEqual({
			ok: true,
			key: 'px_k',
			id: 'c',
			expiresAt: 4,
		})
		await expect(http({ ok: true, members: 'everyone' }).rpc.listMembers({ ...base, scope })).rejects.toBeInstanceOf(IamTransportError)
		await expect(http({ ok: true, scope: 'w1' }).rpc.createScope({ ...base, delegation: 'g', dimension: 'w' })).rejects.toBeInstanceOf(
			IamTransportError,
		)
	})
})

describe('AuthContext of a share-link token', () => {
	test('carries the link mount and chain, and no principal', () => {
		const link = { mount: 'shared', chain: [{ type: 'note', value: 'n1' }, scope] }
		const context = buildAuthContext(
			{
				getJwks: () => Promise.resolve({ keys: [] }),
				listPrincipals: () => Promise.resolve({ ok: true, principals: [] }),
				audit: () => Promise.resolve(),
			},
			'token',
			{ iss: 'https://iam.test', aud: 'notes@prod', sub: 'cred-1', iat: 1, exp: 2, perms: [], label: 'link:shared', link },
			'req',
		)
		expect(context.link).toEqual(link)
		expect(context.principal).toBeNull()
	})
})
