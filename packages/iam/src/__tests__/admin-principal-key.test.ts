/**
 * Every admin RPC procedure that names a principal keys it `principalId` (backlog 80).
 *
 * Walks the shipped router's input schemas rather than listing procedures, so a new procedure that
 * names a principal `id`, `userId` or anything else fails here without anyone remembering to add it.
 */

import { describe, expect, test } from 'bun:test'
import { adminRpcRouter } from '../admin/rpc'
import { routerLeaves } from './helpers/admin-router'

/** The only procedures whose bare `id` names something other than a principal, and what it names. */
const NON_PRINCIPAL_ID: Record<string, string> = {
	'sessions.revoke': 'session',
	'grants.delete': 'grant',
	'shareLinks.revoke': 'share link',
}

const PRINCIPAL_KEY = /principal|user|subject|member|account/i

describe('the admin RPC principal key', () => {
	test('every input that names a principal uses `principalId`, across the whole contract', () => {
		const leaves = routerLeaves(adminRpcRouter)
		const offenders = leaves.flatMap((leaf) =>
			leaf.inputKeys
				.filter((key) => key === 'id' ? NON_PRINCIPAL_ID[leaf.method] === undefined : PRINCIPAL_KEY.test(key) && key !== 'principalId')
				.map((key) => `${leaf.method}: ${key}`)
		)

		// Guards against a walker that reads no schemas and so passes vacuously.
		expect(leaves.filter((leaf) => leaf.inputKeys.length > 0).length).toBeGreaterThan(20)
		expect(offenders).toEqual([])
	})
})
