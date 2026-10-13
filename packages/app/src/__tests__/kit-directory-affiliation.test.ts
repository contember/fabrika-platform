// The test kit answers a member directory as IAM does (ADR-0051): each member carries its affiliation, so a staff UI
// under test can show who is from outside the organization. A kit caller is `internal` unless a test says otherwise.

import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import type { TestCaller } from '../testing/caller'
import { kitDirectory } from '../testing/directory'
import { testKit } from '../testing/kit'
import { notesApp } from './fixtures/implement/app'

const W1 = { type: 'workspace', value: 'w1' } as const

function caller(id: string, affiliation: TestCaller['affiliation'], actions: readonly string[]): TestCaller {
	return {
		kind: 'human',
		app: null,
		link: null,
		id,
		label: `${id}@notes.test`,
		affiliation,
		perms: actions.map((action) => ({ action, scope: W1, source: 'grant' })),
		key: `px_${id}`,
		cookie: null,
	}
}

describe("the kit's member directory", () => {
	test('lists each member with its affiliation', async () => {
		const owner = caller('owner', 'internal', ['notes.read', 'notes.admin'])
		const partner = caller('partner', 'external', ['notes.read'])
		const members = [
			{ caller: owner, memberships: [{ role: 'owner', scope: W1 }] },
			{ caller: partner, memberships: [{ role: 'editor', scope: W1 }] },
		]
		const directory = kitDirectory(notesArtifact, {
			byCredential: (credential) => members.find((member) => member.caller.key === credential)?.caller,
			all: () => members,
		})

		const listed = await directory.listMembers({ app: 'notes', credential: 'px_owner', requestId: 'r1', scope: W1 })
		if (!listed.ok) throw new Error(`no list: ${listed.reason}`)
		expect(listed.members.map((member) => [member.principalId, member.affiliation])).toEqual([['owner', 'internal'], ['partner', 'external']])
	})

	test('an external kit caller holds only roles the contract declares external', () => {
		const kit = testKit(notesApp(new Map()))
		expect(() => kit.testCaller([{ role: 'editor', scope: W1 }], { affiliation: 'external' })).toThrow(
			'an external caller holds only roles the contract declares external',
		)
		expect(() => kit.testCaller([{ action: 'notes.read', scope: W1 }], { affiliation: 'external' })).toThrow()
		expect(() => kit.testCaller([], { kind: 'machine', affiliation: 'external' })).toThrow('only a human is external')
		expect(kit.testCaller([{ role: 'editor', scope: W1 }]).affiliation).toBe('internal')
	})
})
