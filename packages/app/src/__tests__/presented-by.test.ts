import { AGENT_CLIENT_ID, type AgentActClaims, buildAccessClaims } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { presentedBy } from '../implement/principal'

const person = {
	iss: 'https://iam.example.com',
	app: 'tasks@prod',
	subject: 'user-1',
	type: 'user' as const,
	label: 'Ann',
	email: 'ann@example.com',
	permissions: [{ action: 'task.read', scope: null, source: 'grant' as const }],
	issuedAt: 1000,
	expiresAt: 1300,
}

describe('presentedBy', () => {
	test("a person's token presents the person; acting for an agent, it presents the agent caller, the person and the grant", () => {
		expect(presentedBy(buildAccessClaims(person))).toMatchObject({ caller: 'human', principal: { kind: 'user', id: 'user-1' }, agent: null })
		const act: AgentActClaims = { sub: AGENT_CLIENT_ID, grant: 'grant-1', scope: { mode: 'read', within: null }, label: 'my agent' }
		expect(presentedBy(buildAccessClaims({ ...person, act }))).toEqual({
			caller: 'agent',
			principal: { kind: 'user', id: 'user-1', label: 'Ann', email: 'ann@example.com' },
			agent: { grant: 'grant-1', label: 'my agent', scope: { mode: 'read', within: null } },
		})
	})

	test('an agent token without the mailbox presents nobody, as a person token without one', () => {
		const { email: _email, ...noMailbox } = person
		const act: AgentActClaims = { sub: AGENT_CLIENT_ID, grant: 'grant-1', scope: { mode: 'read', within: null } }
		expect(presentedBy(buildAccessClaims({ ...noMailbox, act }))).toBe('no_mailbox')
	})
})
