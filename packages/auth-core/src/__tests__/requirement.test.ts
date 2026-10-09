import { describe, expect, test } from 'bun:test'
import type { EndpointRequirement } from '../contract'
import { callerAdmittedAt, callerOf, satisfies } from '../requirement'
import type { PermissionEntry, Scope } from '../types'

const grant = (action: string, scope: Scope | null = null): PermissionEntry => ({ action, scope, source: 'grant' })
const workspace = (value: string): Scope => ({ type: 'workspace', value })

const member: EndpointRequirement = { kind: 'member' }
const deleteNote: EndpointRequirement = { kind: 'action', action: 'notes.delete', access: { form: 'on', dimension: 'note', from: 'id' } }

describe('satisfies refuses', () => {
	test.each<[string, EndpointRequirement, PermissionEntry[]]>([
		['membership without any permission: authenticated is not authorized', member, []],
		['an action without any permission', deleteNote, []],
		['an action the caller holds only a different one of', deleteNote, [grant('notes.read'), grant('notes.read', workspace('w1'))]],
		['an action outside a wildcard namespace', deleteNote, [grant('note.*'), grant('notesx.*', workspace('w1'))]],
		['an action that only shares a string prefix', { kind: 'action', action: 'notes.read', access: { form: 'over', dimension: 'workspace' } }, [
			grant('notes.readall'),
		]],
	])('%s', (_name, requirement, perms) => {
		expect(satisfies(requirement, perms)).toBe(false)
	})
})

describe('satisfies admits', () => {
	test.each<[string, EndpointRequirement, PermissionEntry[]]>([
		['membership with a global permission', member, [grant('notes.read')]],
		['membership with a scoped permission only', member, [grant('notes.read', workspace('w1'))]],
		['the action granted globally', deleteNote, [grant('notes.delete')]],
		['the action granted in one scope', deleteNote, [grant('notes.read'), grant('notes.delete', workspace('w1'))]],
		['the action in a scope of another dimension than the form names', deleteNote, [grant('notes.delete', { type: 'project', value: 'p1' })]],
		['a wildcard that covers the action globally', deleteNote, [grant('notes.*')]],
		['a wildcard that covers the action in one scope', deleteNote, [grant('notes.*', workspace('w1'))]],
		['the universal wildcard', deleteNote, [grant('*')]],
	])('%s', (_name, requirement, perms) => {
		expect(satisfies(requirement, perms)).toBe(true)
	})
})

describe('callerOf', () => {
	const base = { iss: 'https://iam.test', aud: 'notes@prod', sub: 's', iat: 0, exp: 1, perms: [], label: null }

	test('maps a principal type to its caller kind and an unbound token to a link', () => {
		expect(callerOf({ ...base, ptype: 'user' })).toBe('human')
		expect(callerOf({ ...base, ptype: 'service' })).toBe('machine')
		expect(callerOf(base)).toBe('link')
	})

	test('a connector key of application <id> is the caller app:<id>; a job or a webhook key is no caller', () => {
		expect(callerOf({ ...base, ptype: 'app', workload: 'shop' })).toBe('app:shop')
		expect(callerOf({ ...base, ptype: 'job', workload: 'nightly' })).toBeNull()
		expect(callerOf({ ...base, ptype: 'webhook', workload: 'github' })).toBeNull()
		expect(callerOf({ ...base, ptype: 'app' })).toBeNull()
	})

	test('an OAuth resource token is no caller', () => {
		expect(callerOf({ ...base, ptype: 'user', oauth: { app: 'notes@prod', clientId: 'c', scopes: [], grantId: 'g', tokenId: 't' } })).toBeNull()
	})
})

describe('callerAdmittedAt', () => {
	test('an app:<id> caller reaches only an export path', () => {
		expect(callerAdmittedAt('app:shop', '/__fabrika/connect/products.v1.get')).toBe(true)
		expect(callerAdmittedAt('app:shop', '/__fabrika/connect/products.v1')).toBe(true)
		for (const path of ['/api/notes.list', '/__fabrika/connect', '/__fabrika/connectx/a', '/', '/api/__fabrika/connect/a']) {
			expect(callerAdmittedAt('app:shop', path)).toBe(false)
		}
	})

	test('every other caller is not limited by the path', () => {
		for (const caller of ['human', 'machine', 'link'] as const) {
			expect(callerAdmittedAt(caller, '/api/notes.list')).toBe(true)
		}
	})
})
