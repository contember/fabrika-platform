import { describe, expect, test } from 'bun:test'
import {
	ACTION_CATEGORIES,
	APPROVAL_CATEGORIES,
	type ApprovalPolicy,
	approvalSettingsSchema,
	APPROVER_CATEGORIES,
	type CategorizedChange,
	DEFAULT_APPROVAL_CATEGORIES,
	gate,
	modesOf,
	PERMISSIVE_POLICY,
	PERMISSIVE_SETTINGS,
	POLICY_CATEGORIES,
	policyFromCategories,
	requesterMayApprove,
	requesterPersonId,
	requiredStepUp,
	REVIEW_REASONS,
	STRICT_POLICY,
	STRICT_SETTINGS,
	waitingCategories,
} from '../index.js'

const offRoad: CategorizedChange = { effect: 'widens', review: 'closer', reason: 'off-road', rule: 'endpoint.sql' }
const deletes: CategorizedChange = { effect: 'neutral', review: 'closer', reason: 'deletes-data', rule: 'migration.statement' }
const roleGrant: CategorizedChange = { effect: 'widens', rule: 'role.grants' }
const plain: CategorizedChange = { effect: 'widens', rule: 'endpoint.added', audience: { reach: 'human', requirement: null } }
const legacyCloser: CategorizedChange = { effect: 'widens', review: 'closer' }

describe('the strict and permissive presets', () => {
	test('strict: six closer-review categories plan, deletes-data person, permissions and grants off, actions person', () => {
		expect(STRICT_POLICY).toEqual({
			'off-road': 'plan',
			'anyone-calls': 'plan',
			'get-mutation': 'plan',
			people: 'plan',
			adoption: 'plan',
			terminal: 'plan',
			'deletes-data': 'person',
			'role-actions': 'off',
			'role-external': 'off',
			'role-added': 'off',
			public: 'off',
			csp: 'off',
			grants: 'off',
			'deploy-request': 'person',
			secrets: 'person',
			variables: 'person',
			data: 'person',
			registry: 'person',
			'agent-grants': 'person',
			credentials: 'person',
		})
	})

	test('permissive: every category off', () => {
		expect(POLICY_CATEGORIES.every((category) => PERMISSIVE_POLICY[category] === 'off')).toBe(true)
	})

	test('every preset value is a mode its category takes', () => {
		for (const policy of [STRICT_POLICY, PERMISSIVE_POLICY]) {
			for (const category of POLICY_CATEGORIES) expect(modesOf(category)).toContain(policy[category])
		}
	})
})

describe('the mode matrix', () => {
	test('a deploy line takes off, plan or person; grants off or person; an action off, person or refuse', () => {
		for (const category of APPROVAL_CATEGORIES.filter((c) => c !== 'grants')) expect(modesOf(category)).toEqual(['off', 'plan', 'person'])
		expect(modesOf('grants')).toEqual(['off', 'person'])
		for (const category of ACTION_CATEGORIES) expect(modesOf(category)).toEqual(['off', 'person', 'refuse'])
	})
})

describe('gate', () => {
	test('passes a change whose every line is off, and one with no line', () => {
		expect(gate({ lines: [roleGrant, plain] }, STRICT_POLICY)).toEqual({ kind: 'pass' })
		expect(gate({ lines: [] }, STRICT_POLICY)).toEqual({ kind: 'pass' })
	})

	test('a plan line waits while no plan entry covers it, with only the uncovered lines', () => {
		expect(gate({ lines: [offRoad, plain] }, STRICT_POLICY)).toEqual({ kind: 'wait', mode: 'plan', lines: [offRoad], actions: [] })
		const plan = { covers: (change: CategorizedChange) => change === offRoad }
		expect(gate({ lines: [offRoad, plain] }, STRICT_POLICY, plan)).toEqual({ kind: 'pass' })
	})

	test('a person line waits whatever the plan covers, and the strictest mode is named', () => {
		const everything = { covers: () => true }
		expect(gate({ lines: [offRoad, deletes] }, STRICT_POLICY, everything)).toEqual({ kind: 'wait', mode: 'person', lines: [deletes], actions: [] })
		expect(gate({ lines: [offRoad, deletes] }, STRICT_POLICY)).toEqual({ kind: 'wait', mode: 'person', lines: [offRoad, deletes], actions: [] })
	})

	test('a line takes the strictest mode among its categories; a legacy closer line belongs to every reason', () => {
		const policy: ApprovalPolicy = { ...STRICT_POLICY, 'deletes-data': 'off' }
		expect(gate({ lines: [legacyCloser] }, policy)).toEqual({ kind: 'wait', mode: 'plan', lines: [legacyCloser], actions: [] })
		expect(gate({ lines: [legacyCloser] }, STRICT_POLICY)).toEqual({ kind: 'wait', mode: 'person', lines: [legacyCloser], actions: [] })
	})

	test('an action waits under person, passes under off, and is refused under refuse whatever else waits', () => {
		expect(gate({ lines: [], actions: ['deploy-request'] }, STRICT_POLICY)).toEqual({
			kind: 'wait',
			mode: 'person',
			lines: [],
			actions: ['deploy-request'],
		})
		expect(gate({ lines: [], actions: ['deploy-request'] }, PERMISSIVE_POLICY)).toEqual({ kind: 'pass' })
		const refusing: ApprovalPolicy = { ...STRICT_POLICY, 'deploy-request': 'refuse' }
		expect(gate({ lines: [offRoad], actions: ['deploy-request', 'secrets'] }, refusing)).toEqual({ kind: 'refuse', categories: ['deploy-request'] })
	})

	test('the permissive preset passes every line', () => {
		expect(gate({ lines: [offRoad, deletes, legacyCloser, roleGrant] }, PERMISSIVE_POLICY)).toEqual({ kind: 'pass' })
	})
})

describe('the conversion from the earlier category list', () => {
	test('the default list converts to the strict preset', () => {
		expect(policyFromCategories(DEFAULT_APPROVAL_CATEGORIES)).toEqual(STRICT_POLICY)
	})

	test('an added category becomes person, a removed one off; the actions keep their defaults', () => {
		const policy = policyFromCategories([...REVIEW_REASONS.filter((reason) => reason !== 'people'), 'role-actions', 'grants'])
		expect(policy).toEqual({ ...STRICT_POLICY, people: 'off', 'role-actions': 'person', grants: 'person' })
	})

	test('the categories that wait read back the list the policy came from, so a Control rolled back reads it as before', () => {
		const chosen = ['off-road', 'terminal', 'csp', 'grants'] as const
		expect(waitingCategories(policyFromCategories(chosen))).toEqual([...chosen])
		expect(waitingCategories(STRICT_POLICY)).toEqual([...DEFAULT_APPROVAL_CATEGORIES])
		expect(waitingCategories(PERMISSIVE_POLICY)).toEqual([])
	})

	test('the gate under a converted list waits exactly where the list waited', () => {
		const waits = (list: readonly (typeof APPROVAL_CATEGORIES)[number][], line: CategorizedChange) =>
			gate({ lines: [line] }, policyFromCategories(list)).kind !== 'pass'
		expect([offRoad, deletes, roleGrant, plain, legacyCloser].map((line) => waits(DEFAULT_APPROVAL_CATEGORIES, line))).toEqual([
			true,
			true,
			false,
			false,
			true,
		])
		expect([offRoad, deletes, roleGrant, plain, legacyCloser].map((line) => waits([], line))).toEqual([false, false, false, false, false])
		expect([offRoad, deletes, roleGrant, plain, legacyCloser].map((line) => waits(['role-actions', 'terminal'], line))).toEqual([
			false,
			false,
			true,
			false,
			true,
		])
	})
})

describe('who decides a pending item (ADR-0083 §8)', () => {
	test("the requester may approve unless a waiting category says otherwise; grants keep IAM's rule", () => {
		const others = { ...STRICT_SETTINGS, requesterMayApprove: { ...STRICT_SETTINGS.requesterMayApprove, secrets: false } }
		expect(requesterMayApprove(STRICT_SETTINGS, ['secrets', 'deploy-request'])).toBe(true)
		expect(requesterMayApprove(others, ['deploy-request'])).toBe(true)
		expect(requesterMayApprove(others, ['deploy-request', 'secrets'])).toBe(false)
		expect(requesterMayApprove(others, ['grants'])).toBe(true)
	})

	test("the requester's person: the user behind a token or key, a service key's issuer, else unknown", () => {
		expect(requesterPersonId({ id: 'p-ada', type: 'user' })).toBe('p-ada')
		expect(requesterPersonId({ id: 'svc', type: 'service' }, 'p-bob')).toBe('p-bob')
		expect(requesterPersonId({ id: 'svc', type: 'service' })).toBeNull()
		expect(requesterPersonId({ id: 'svc', type: 'service' }, null)).toBeNull()
	})
})

describe('the step-up on deciding (ADR-0050 §5)', () => {
	test('the default asks a passkey only for a credential; the permissive preset asks none', () => {
		expect(APPROVER_CATEGORIES.filter((category) => STRICT_SETTINGS.stepUp[category] === 'webauthn')).toEqual(['credentials'])
		expect(APPROVER_CATEGORIES.filter((category) => PERMISSIVE_SETTINGS.stepUp[category] !== 'none')).toEqual([])
		expect(approvalSettingsSchema.parse(PERMISSIVE_SETTINGS)).toEqual(PERMISSIVE_SETTINGS)
	})

	test("any waiting category asking for a passkey makes the decision take one; grants keep IAM's rule", () => {
		expect(requiredStepUp(STRICT_SETTINGS, ['secrets', 'deploy-request'])).toBe('none')
		expect(requiredStepUp(STRICT_SETTINGS, ['secrets', 'credentials'])).toBe('webauthn')
		expect(requiredStepUp({ ...STRICT_SETTINGS, stepUp: { ...STRICT_SETTINGS.stepUp, 'off-road': 'webauthn' } }, ['off-road'])).toBe('webauthn')
		expect(requiredStepUp(STRICT_SETTINGS, ['grants'])).toBe('none')
		expect(requiredStepUp(STRICT_SETTINGS, [])).toBe('none')
	})
})
