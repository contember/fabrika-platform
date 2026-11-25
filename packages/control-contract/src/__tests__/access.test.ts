import { type PermissionEntry, permits } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { CONTROL_ACTIONS, CONTROL_SCOPES } from '../access'
import { CONTROL_CLI_RESOURCES } from '../cli-access'

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

describe('the approval actions (ADR-0050 §5, ADR-0083 §8)', () => {
	test('neither access.approve nor access.request is under deploy.* or the other, and no command-line preset carries either', () => {
		const deployer = [global('deploy.*'), global('operations.*')]
		for (const action of [CONTROL_ACTIONS.ACCESS_APPROVE, CONTROL_ACTIONS.ACCESS_REQUEST]) {
			expect(permits(deployer, action, crm)).toBe(false)
			expect(permits([global('*')], action, crm)).toBe(true)
			for (const resource of CONTROL_CLI_RESOURCES) {
				for (const grant of resource.grants) expect(grant.actions).not.toContain(action)
			}
		}
		expect(permits([global(CONTROL_ACTIONS.ACCESS_REQUEST)], CONTROL_ACTIONS.ACCESS_APPROVE, crm)).toBe(false)
		expect(permits([global(CONTROL_ACTIONS.ACCESS_APPROVE)], CONTROL_ACTIONS.ACCESS_REQUEST, crm)).toBe(false)
	})
})
