import { type PermissionEntry, permits } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { CONTROL_ACTIONS, CONTROL_SCOPES } from '../access'

const crm = { type: CONTROL_SCOPES.APP, value: 'crm' }
const scopedToCrm = (action: string): PermissionEntry => ({ action, scope: crm, source: 'grant' })
const global = (action: string): PermissionEntry => ({ action, scope: null, source: 'grant' })

describe('the data actions (ADR-0069 §2)', () => {
	test('an owner scoped to one application reads its metadata and runs its operations', () => {
		const owner = [scopedToCrm(CONTROL_ACTIONS.DATA_READ), scopedToCrm(CONTROL_ACTIONS.DATA_MANAGE)]
		expect(permits(owner, CONTROL_ACTIONS.DATA_READ, crm)).toBe(true)
		expect(permits(owner, CONTROL_ACTIONS.DATA_MANAGE, crm)).toBe(true)
		expect(permits(owner, CONTROL_ACTIONS.DATA_READ, { type: CONTROL_SCOPES.APP, value: 'billing' })).toBe(false)
	})

	test('data.content.read is checked as a global grant, so a grant scoped to one application never carries it', () => {
		for (const grant of [scopedToCrm(CONTROL_ACTIONS.DATA_CONTENT_READ), scopedToCrm('data.*'), scopedToCrm('*')]) {
			expect(permits([grant], CONTROL_ACTIONS.DATA_CONTENT_READ)).toBe(false)
		}
		expect(permits([global(CONTROL_ACTIONS.DATA_CONTENT_READ)], CONTROL_ACTIONS.DATA_CONTENT_READ)).toBe(true)
	})

	test('data.content.read is its own action: data.read does not imply it', () => {
		expect(permits([global(CONTROL_ACTIONS.DATA_READ), global(CONTROL_ACTIONS.DATA_MANAGE)], CONTROL_ACTIONS.DATA_CONTENT_READ)).toBe(false)
	})
})
