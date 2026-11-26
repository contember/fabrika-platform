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
	test("a person's token presents the person; the same token acting for an agent presents no caller until contracts declare one", () => {
		expect(presentedBy(buildAccessClaims(person))).toMatchObject({ caller: 'human', principal: { kind: 'user', id: 'user-1' } })
		const act: AgentActClaims = { sub: AGENT_CLIENT_ID, grant: 'grant-1', scope: { mode: 'read', within: null } }
		expect(presentedBy(buildAccessClaims({ ...person, act }))).toBe('no_caller')
	})
})
