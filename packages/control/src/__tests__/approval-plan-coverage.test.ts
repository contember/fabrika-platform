// What a plan entry binds to (ADR-0050 §5): a subject's content before and after, and the lines the approver read for
// it. Entries chain: `A → B` and `B → C` cover a deploy `A → C`, but only the lines some entry of the chain showed.

import type { AccessChangeDto } from '@fabrika/control-contract'
import { describe, expect, test } from 'bun:test'
import { classifyAccess } from '../approval/diff'
import { type CoveringEntry, fragmentSource, planCoverage, plannedEntries, subjectFragmentHash } from '../approval/plans/coverage'
import { readAccessSnapshot } from '../approval/read'
import type { AccessSnapshot } from '../approval/snapshot'
import { memoryCommits } from './helpers/commits'
import { BASE, edited } from './helpers/contracts'
import { kitFiles } from './helpers/kit-contract'

const DELETES = edited("editor: { grants: ['notes.read', 'notes.write']", "editor: { grants: ['notes.read', 'notes.write', 'notes.delete']")
const ASSIGNABLE = edited("assignableBy: ['owner'] } },\n\t},", "assignableBy: ['owner', 'editor'] } },\n\t},", DELETES)

async function snapshot(source: string): Promise<AccessSnapshot> {
	const commit = await memoryCommits({ 'fabrika.contract.ts': source }).open({
		repoUrl: 'github.com/acme/notes',
		commitSha: 'a'.repeat(40),
		wanted: () => true,
		signal: AbortSignal.timeout(10_000),
	})
	return readAccessSnapshot(commit, '', 'notes')
}

function entriesOf(from: AccessSnapshot, to: AccessSnapshot, prefix: string): CoveringEntry[] {
	const changes: AccessChangeDto[] = [...classifyAccess(from, to).changes]
	return plannedEntries(fragmentSource(from), fragmentSource(to), changes).map((entry, index) => ({
		...entry,
		id: `${prefix}-${index}`,
		lines: new Set(entry.lines),
	}))
}

describe('plan coverage', () => {
	test('a chain of transitions covers the deploy of both, and both entries are used', async () => {
		const [a, b, c] = await Promise.all([snapshot(BASE), snapshot(DELETES), snapshot(ASSIGNABLE)])
		const entries = [...entriesOf(a, b, 'first'), ...entriesOf(b, c, 'second')]
		const deploy = classifyAccess(a, c).changes.filter((change) => change.rule === 'role.grants')
		expect(deploy.length).toBe(1)
		const coverage = planCoverage(entries, fragmentSource(a), fragmentSource(c), 'transition')
		expect(deploy.every((line) => coverage.covers(line))).toBe(true)
		expect(coverage.used()).toEqual(['first-0', 'second-0'])
	})

	test('a broken chain covers nothing; after-state covers the line by the last entry alone', async () => {
		const [a, b, c] = await Promise.all([snapshot(BASE), snapshot(DELETES), snapshot(ASSIGNABLE)])
		const line = classifyAccess(a, c).changes.find((change) => change.rule === 'role.grants')
		if (line === undefined) throw new Error('no role.grants line')
		expect(planCoverage(entriesOf(b, c, 'second'), fragmentSource(a), fragmentSource(c), 'transition').covers(line)).toBe(false)
		// The last transition did not show the line itself, so even the after-state does not cover it.
		expect(planCoverage(entriesOf(b, c, 'second'), fragmentSource(a), fragmentSource(c), 'after-state').covers(line)).toBe(false)
		expect(planCoverage(entriesOf(a, c, 'direct'), fragmentSource(b), fragmentSource(c), 'after-state').covers(line)).toBe(true)
	})

	test('a line of another subject, or with other words, is never covered', async () => {
		const [a, b] = await Promise.all([snapshot(BASE), snapshot(DELETES)])
		const coverage = planCoverage(entriesOf(a, b, 'first'), fragmentSource(a), fragmentSource(b), 'transition')
		const line = classifyAccess(a, b).changes.find((change) => change.rule === 'role.grants')
		if (line === undefined) throw new Error('no role.grants line')
		expect(coverage.covers(line)).toBe(true)
		expect(coverage.covers({ ...line, line: `${line.line}, and more` })).toBe(false)
		expect(coverage.covers({ ...line, subject: { kind: 'role', name: 'owner' } })).toBe(false)
		const { subject: _, ...unplaced } = line
		expect(coverage.covers(unplaced)).toBe(false)
	})

	test("a migration's fragment holds the access entries that name its views; a subject whose fragment did not change gets no entry", async () => {
		const commit = await memoryCommits(kitFiles()).open({
			repoUrl: 'github.com/acme/notes',
			commitSha: 'a'.repeat(40),
			wanted: () => true,
			signal: AbortSignal.timeout(10_000),
		})
		const base = await readAccessSnapshot(commit, '', 'notes')
		const contract = base.contract
		const notes = contract?.tables['notes']
		if (contract === null || notes === undefined) throw new Error('the kit contract has a notes table')
		const file = '20261012110000_shared.sql'
		const declared: AccessSnapshot = { ...base, databaseCode: [{ kind: 'view', object: 'shared_notes', file, line: 1 }] }
		const named: AccessSnapshot = {
			...declared,
			contract: {
				...contract,
				tables: {
					...contract.tables,
					notes: { ...notes, access: { member: { view: 'shared_notes', row: 'note_id', principal: 'principal_id', member: null } } },
				},
			},
		}
		const subject = { kind: 'migration' as const, name: file }
		const hash = (of: AccessSnapshot) => subjectFragmentHash(of, subject, fragmentSource(of).contract)
		// An access entry naming the file's view changes the file's fragment, though the file did not change.
		expect(hash(named)).not.toBe(hash(declared))
		const line: AccessChangeDto = { effect: 'widens', line: `Migration ${file} declares view shared_notes`, rule: 'migration.database-code', subject }
		expect(plannedEntries(fragmentSource(declared), fragmentSource(named), [line]).map((entry) => entry.subject)).toEqual([`migration:${file}`])
		// The same fragment on both sides: no entry could bind what the line shows.
		expect(plannedEntries(fragmentSource(declared), fragmentSource(declared), [line])).toEqual([])
	})
})
