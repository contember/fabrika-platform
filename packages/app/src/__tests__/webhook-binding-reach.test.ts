// A webhook binding outlives the request that made it, so it binds only with a Ref an IAM grant holds: a Ref held
// through a relation, a member reveal or a secondary path is re-read at every statement, and a binding never is.

import type { ContainerGrant, RelationHold } from '@fabrika/db/capability'
import { describe, expect, test } from 'bun:test'
import { CapabilityRefusedError, createCapabilityIssuer, RequestFrame, runInRequest } from '../implement/capability'
import { webhookBindings } from '../implement/webhook'

const team: ContainerGrant = { dimension: 'team', values: ['t1'] }

interface Held {
	readonly relations?: readonly RelationHold[]
	readonly revealing?: readonly ContainerGrant[]
	readonly paths?: readonly ContainerGrant[]
}

/** Binds with a project Ref held as `held` says; the session stands for the write, so reaching it means the Ref was taken. */
async function bindHeld(held: Held): Promise<unknown> {
	const { mint, authority } = createCapabilityIssuer()
	const frame = new RequestFrame('request-1')
	const bindings = webhookBindings({
		site: 'projects.connect',
		webhook: { name: 'github', path: '/hooks/github', scheme: 'github-sha256', boundTo: { kind: 'dimension', dimension: 'project' } },
		tables: () => ({
			createBinding: async () => {},
			binding: async () => null,
			replaceSecret: async () => false,
			removeBinding: async () => false,
			claimDelivery: async () => null,
			completeDelivery: async () => false,
			releaseDelivery: async () => {},
		}),
		authority,
		session: () => Promise.reject(new Error('reached the write')),
		check: () => {},
		principal: 'user:alice',
	})('github')
	try {
		return await runInRequest(frame, async () => {
			const ref = mint.ref(frame, 'project', 'projects.connect', 'user:alice', 'p1', new Map(), held.relations, held.revealing, held.paths)
			return await bindings.bind(ref, 'installation:1')
		})
	} finally {
		frame.end()
	}
}

describe('a webhook binding', () => {
	const held: [string, Held][] = [
		['a relation', { relations: [{ relation: 'maintainer', inside: null }] }],
		['a relation held inside a node', { relations: [{ relation: 'maintainer', inside: { dimension: 'org', values: ['o1'] } }] }],
		['a member reveal', { revealing: [team] }],
		['a secondary path', { paths: [team] }],
	]
	test.each(held)('refuses a Ref held through %s', async (_, through) => {
		await expect(bindHeld(through)).rejects.toThrow(CapabilityRefusedError)
		await expect(bindHeld(through)).rejects.toThrow('binds only with a Ref an IAM grant holds')
	})

	test('binds with a Ref an IAM grant holds', async () => {
		await expect(bindHeld({})).rejects.toThrow('reached the write')
	})
})
