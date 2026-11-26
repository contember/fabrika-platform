import { describe, expect, test } from 'bun:test'
import { AGENT_CALLER, AGENT_CLIENT_ID, agentScopeAdmits, agentScopeToken, liesWithinValue, narrowToValue, parseAgentScope } from '../agent'
import { permits } from '../permissions'
import { callerOf } from '../requirement'
import { type AgentActClaims, buildAccessClaims, parseAccessClaims } from '../token'
import { type PermissionEntry, relationInsideScope } from '../types'

const projectA = { type: 'project', value: 'a' }

describe('the scope token of an agent grant (ADR-0090 §2)', () => {
	test('reads read and write, plain or narrowed to one value, and writes them back', () => {
		for (const token of ['read', 'write', 'read:project=a', 'write:project=0198cafe-0000-7000-8000-000000000001', 'read:org=acme.eu']) {
			const scope = parseAgentScope(token)
			expect(scope).not.toBeNull()
			if (scope !== null) expect(agentScopeToken(scope)).toBe(token)
		}
		expect(parseAgentScope('read:project=a')).toEqual({ mode: 'read', within: projectA })
	})

	test('refuses another mode, a missing or reserved dimension, an empty or overlong value and non-token characters', () => {
		for (
			const token of [
				'',
				'admin',
				'read:',
				'read:project',
				'read:project=',
				'read:=a',
				'read:~rel=owner',
				'read:Project=a',
				'read:project=a b',
				'read:org=x=y',
				'read:project=a:b',
				'read:project=-a',
				'read:project="a"',
				'readwrite',
				`read:project=${'a'.repeat(101)}`,
			]
		) {
			expect(parseAgentScope(token)).toBeNull()
		}
	})

	test('read admits queries and downloads; write adds mutations and uploads; neither admits an SPA', () => {
		expect(['query', 'download', 'mutation', 'upload', 'spa'].filter((kind) => agentScopeAdmits('read', kind))).toEqual(['query', 'download'])
		expect(['query', 'download', 'mutation', 'upload', 'spa'].filter((kind) => agentScopeAdmits('write', kind))).toEqual([
			'query',
			'download',
			'mutation',
			'upload',
		])
	})
})

describe('narrowToValue (ADR-0090 §3)', () => {
	const held: PermissionEntry[] = [
		{ action: 'task.read', scope: null, source: 'grant' },
		{ action: 'task.write', scope: projectA, source: 'grant' },
		{ action: 'task.write', scope: { type: 'project', value: 'b' }, source: 'grant' },
		{ action: 'task.read', scope: { type: 'org', value: 'x' }, source: 'grant' },
		{ action: 'task.read', scope: { type: 'task', value: 't1' }, source: 'grant' },
		{ action: 'task.read', scope: { type: '~rel', value: 'owner' }, source: 'grant' },
		{ action: 'task.write', scope: relationInsideScope({ relation: 'owner', dimension: 'project', node: 'a' }), source: 'grant' },
		{ action: 'task.write', scope: relationInsideScope({ relation: 'owner', dimension: 'project', node: 'b' }), source: 'grant' },
		{ action: 'task.write', scope: relationInsideScope({ relation: 'owner', dimension: 'org', node: 'x' }), source: 'grant' },
	]

	test('a global entry moves to the value, an entry or a relation held at it stays, and the rest is dropped', () => {
		expect(narrowToValue(held, projectA)).toEqual([
			{ action: 'task.read', scope: projectA, source: 'grant' },
			{ action: 'task.write', scope: projectA, source: 'grant' },
			{ action: 'task.write', scope: relationInsideScope({ relation: 'owner', dimension: 'project', node: 'a' }), source: 'grant' },
		])
	})

	test('a relation held anywhere is dropped, never moved inside the value', () => {
		// A view bound to its member gives a hold anywhere nothing and a hold inside a node that node's rows (ADR-0076).
		const anywhere: PermissionEntry[] = [{ action: 'task.read', scope: { type: '~rel', value: 'owner' }, source: 'grant' }]
		expect(narrowToValue(anywhere, projectA)).toEqual([])
	})

	test('the narrowed set holds nothing in another project and no global grant', () => {
		const narrowed = narrowToValue(held, projectA)
		expect(permits(narrowed, 'task.read', projectA)).toBe(true)
		expect(permits(narrowed, 'task.read', { type: 'project', value: 'b' })).toBe(false)
		expect(permits(narrowed, 'task.write', { type: 'project', value: 'b' })).toBe(false)
		expect(permits(narrowed, 'task.read')).toBe(false)
		expect(liesWithinValue(narrowed, projectA)).toBe(true)
		expect(liesWithinValue(held, projectA)).toBe(false)
	})

	test('never adds an action and keeps each source', () => {
		const narrowed = narrowToValue([{ action: 'a.read', scope: null, source: 'terminal' }], projectA)
		expect(narrowed).toEqual([{ action: 'a.read', scope: projectA, source: 'terminal' }])
		expect(narrowToValue([], projectA)).toEqual([])
	})

	test('refuses to narrow to a reserved scope type', () => {
		expect(() => narrowToValue(held, { type: '~rel', value: 'owner' })).toThrow()
	})
})

describe('the act claim of an agent token', () => {
	const base = {
		iss: 'https://iam.example.com',
		app: 'tasks@prod',
		subject: 'user-1',
		type: 'user' as const,
		label: 'Ann',
		email: 'ann@example.com',
		issuedAt: 1000,
		expiresAt: 1300,
	}
	const narrowed = narrowToValue([{ action: 'task.read', scope: null, source: 'grant' }], projectA)
	const act: AgentActClaims = { sub: AGENT_CLIENT_ID, grant: 'grant-1', scope: 'read:project=a', label: 'my agent' }

	test('a person token with act round-trips it and presents the caller agent', () => {
		const built = buildAccessClaims({ ...base, permissions: narrowed, act })
		const parsed = parseAccessClaims(JSON.parse(JSON.stringify(built)))
		expect(parsed?.act).toEqual(act)
		expect(parsed === null ? null : callerOf(parsed)).toBe(AGENT_CALLER)
		const plain = parseAccessClaims(JSON.parse(JSON.stringify(buildAccessClaims({ ...base, permissions: narrowed }))))
		expect(plain === null ? null : callerOf(plain)).toBe('human')
	})

	test('an unnarrowed scope carries the person set as it is, and the label is optional', () => {
		const built = buildAccessClaims({
			...base,
			permissions: [{ action: 'task.read', scope: null, source: 'grant' }],
			act: { sub: AGENT_CLIENT_ID, grant: 'grant-1', scope: 'write' },
		})
		expect(parseAccessClaims(JSON.parse(JSON.stringify(built)))?.act).toEqual({ sub: AGENT_CLIENT_ID, grant: 'grant-1', scope: 'write' })
	})

	test('a narrowed token carrying an entry outside its value is refused, built or parsed', () => {
		const wide: PermissionEntry[] = [...narrowed, { action: 'task.read', scope: null, source: 'grant' }]
		expect(() => buildAccessClaims({ ...base, permissions: wide, act })).toThrow()
		const payload = { ...JSON.parse(JSON.stringify(buildAccessClaims({ ...base, permissions: narrowed, act }))), perms: wide }
		expect(parseAccessClaims(payload)).toBeNull()
		const other = { ...payload, perms: [{ action: 'task.read', scope: { type: 'project', value: 'b' }, source: 'grant' }] }
		expect(parseAccessClaims(other)).toBeNull()
	})

	test('act is refused beside a session, a terminal, a service, a share link or a malformed field', () => {
		expect(() => buildAccessClaims({ ...base, permissions: narrowed, act, session: true })).toThrow()
		expect(() => buildAccessClaims({ ...base, type: 'service', email: undefined, permissions: narrowed, act })).toThrow()
		const good = JSON.parse(JSON.stringify(buildAccessClaims({ ...base, permissions: narrowed, act })))
		const refused: unknown[] = [
			{ ...good, session: true },
			{ ...good, amr: 'terminal_assertion', terminal: { id: 't', label: 'T' }, session: true },
			{ ...good, ptype: 'service', email: undefined },
			{ ...good, act: { ...act, sub: 'fabrika-cli' } },
			{ ...good, act: { ...act, grant: '' } },
			{ ...good, act: { ...act, scope: 'admin' } },
			{ ...good, act: { ...act, label: 'x'.repeat(65) } },
			{ ...good, act: { ...act, label: 7 } },
			{ ...good, act: 'agent-cli' },
		]
		for (const payload of refused) {
			expect(parseAccessClaims(payload)).toBeNull()
		}
	})
})
