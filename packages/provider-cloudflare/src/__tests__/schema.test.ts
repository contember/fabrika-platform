import { describe, expect, test } from 'bun:test'
import { parseAppSchema } from '..'

const refusal = (value: unknown): string => {
	const parsed = parseAppSchema(value)
	return parsed.ok ? '(accepted)' : parsed.message
}

describe('parseAppSchema', () => {
	test('accepts a well-formed vocabulary and keeps only the declared fields', () => {
		const parsed = parseAppSchema({
			scopes: [{ type: 'team', label: 'Team' }, { type: 'org' }],
			actions: [{ action: 'notes.read', description: 'Read' }, { action: 'notes.write' }],
			roles: { editor: { name: 'Editor', permissions: ['notes.*'] }, admin: { name: 'Admin', permissions: ['*'] } },
			extra: 'ignored',
		})
		expect(parsed).toEqual({
			ok: true,
			schema: {
				scopes: [{ type: 'team', label: 'Team' }, { type: 'org' }],
				actions: [{ action: 'notes.read', description: 'Read' }, { action: 'notes.write' }],
				roles: { editor: { name: 'Editor', permissions: ['notes.*'] }, admin: { name: 'Admin', permissions: ['*'] } },
			},
		})
	})

	test('refuses a malformed shape, naming the field', () => {
		expect(refusal({ scopes: {}, actions: [], roles: {} })).toContain('scopes and actions must be arrays')
		expect(refusal({ scopes: [], actions: [], roles: [] })).toContain('roles must be an object')
		expect(refusal({ scopes: [{ type: 'team', label: 42 }], actions: [], roles: {} })).toContain('each scope needs a string `type`')
		expect(refusal({ scopes: [{}], actions: [], roles: {} })).toContain('each scope needs a string `type`')
		expect(refusal({ scopes: [], actions: [{ action: 42 }], roles: {} })).toContain('each action needs a string `action`')
	})

	test('refuses a role key the object cannot hold, and a permission that is not a string', () => {
		expect(refusal({ scopes: [], actions: [], roles: { '': { name: 'X', permissions: [] } } })).toContain('is not usable')
		// JSON.parse, not a literal: only there is `__proto__` an OWN key, which is how it arrives here.
		expect(refusal(JSON.parse('{"scopes":[],"actions":[],"roles":{"__proto__":{"name":"X","permissions":[]}}}'))).toContain('is not usable')
		expect(refusal({ scopes: [], actions: [], roles: { editor: { name: 'Editor', permissions: [42] } } })).toContain(
			'needs a string name and an array of non-empty permissions',
		)
		expect(refusal({ scopes: [], actions: [], roles: { editor: { name: 'Editor', permissions: 'notes.read' } } })).toContain(
			'needs a string name and an array of non-empty permissions',
		)
	})

	test('refuses a permission naming an action the same body does not declare, and names it', () => {
		const message = refusal({
			scopes: [],
			actions: [{ action: 'notes.read' }],
			roles: { editor: { name: 'Editor', permissions: ['billing.write'] } },
		})
		expect(message).toContain('role `editor` references unknown action: `billing.write`')
		expect(refusal({ scopes: [], actions: [{ action: 'notes.read' }], roles: { r: { name: 'R', permissions: ['other.*'] } } })).toContain(
			'references unknown action',
		)
		expect(parseAppSchema({ scopes: [], actions: [{ action: 'notes.read' }], roles: { r: { name: 'R', permissions: ['notes.*'] } } }).ok).toBe(true)
	})

	test('bounds an untrusted fragment before it reaches a run log line', () => {
		const message = refusal({ scopes: [], actions: [], roles: { editor: { name: 'Editor', permissions: ['x'.repeat(5000)] } } })
		expect(message.length).toBeLessThan(200)
	})
})
