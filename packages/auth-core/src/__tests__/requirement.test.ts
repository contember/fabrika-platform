import { describe, expect, test } from 'bun:test'
import type { EndpointRequirement } from '../contract'
import { satisfies } from '../requirement'
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
