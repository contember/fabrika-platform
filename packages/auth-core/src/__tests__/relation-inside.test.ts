// A relation held inside one node travels as its own reserved scope type: an older reader, which knows `~rel` only,
// ignores it, and the proxy counts it towards an action requirement exactly as it counts `~rel`.

import { describe, expect, test } from 'bun:test'
import { permits, scopedValues } from '../permissions'
import { satisfies } from '../requirement'
import { parseRelationInside, RELATION_INSIDE_SCOPE_TYPE, RELATION_SCOPE_TYPE, relationInsideScope } from '../types'
import type { PermissionEntry } from '../types'

describe('a relation held inside a node', () => {
	test('reads back its relation, dimension and node, the node verbatim with its colons', () => {
		const scope = relationInsideScope({ relation: 'assignee', dimension: 'org', node: 'urn:org:o1' })
		expect(scope).toEqual({ type: '~relin', value: 'assignee:org:urn:org:o1' })
		expect(parseRelationInside(scope)).toEqual({ relation: 'assignee', dimension: 'org', node: 'urn:org:o1' })
	})

	test('refuses a relation or dimension name that holds a colon, and reads no malformed value', () => {
		expect(() => relationInsideScope({ relation: 'a:b', dimension: 'org', node: 'o1' })).toThrow('without ":"')
		expect(() => relationInsideScope({ relation: 'assignee', dimension: 'o:rg', node: 'o1' })).toThrow('without ":"')
		for (const value of ['assignee', 'assignee:org', ':org:o1', 'assignee::o1', 'assignee:org:']) {
			expect(parseRelationInside({ type: RELATION_INSIDE_SCOPE_TYPE, value })).toBeNull()
		}
		expect(parseRelationInside({ type: RELATION_SCOPE_TYPE, value: 'assignee:org:o1' })).toBeNull()
	})

	test('is no global grant and no scope value, and counts towards an action requirement as ~rel does', () => {
		const inside: PermissionEntry = {
			action: 'tasks.read',
			scope: relationInsideScope({ relation: 'assignee', dimension: 'org', node: 'o1' }),
			source: 'grant',
		}
		const anywhere: PermissionEntry = { action: 'tasks.read', scope: { type: RELATION_SCOPE_TYPE, value: 'assignee' }, source: 'grant' }
		for (const entry of [inside, anywhere]) {
			expect(permits([entry], 'tasks.read')).toBe(false)
			expect(permits([entry], 'tasks.read', { type: 'org', value: 'o1' })).toBe(false)
			expect(scopedValues([entry], 'tasks.read', 'org')).toEqual([])
			expect(satisfies({ kind: 'action', action: 'tasks.read', access: { form: 'over', dimension: 'org' } }, [entry])).toBe(true)
			expect(satisfies({ kind: 'action', action: 'tasks.read', access: { form: 'app' } }, [entry])).toBe(false)
		}
	})
})
