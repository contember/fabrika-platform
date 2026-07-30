import type { DisplayFrame, IssueListItem } from '@fabrika/operations-contract'
import { describe, expect, test } from 'bun:test'
import { frameLocation } from '../views/ErrorDetail'
import { filterIssues, type OperationsIssueListEntry } from '../views/Errors'

const issue: IssueListItem = {
	fingerprint: 'TypeError:/src/job.ts:17',
	projectId: 'worker-api',
	title: 'Cannot read properties of undefined',
	culprit: 'handleJob',
	level: 'error',
	status: 'open',
	assignedTo: null,
	regressedAt: null,
	firstSeen: 1_700_000_000_000,
	lastSeen: 1_700_000_100_000,
	count: 12,
	trend: [1, 3, 8],
}

describe('issue views', () => {
	test('filters by status and operator-visible fields', () => {
		const entry: OperationsIssueListEntry = { id: 'opaque-issue-id', issue }
		expect(filterIssues([entry], 'handle', 'open')).toEqual([entry])
		expect(filterIssues([entry], 'worker', 'resolved')).toEqual([])
	})

	test('renders complete and partial frame positions', () => {
		const frame: DisplayFrame = {
			file: '/src/job.ts',
			function: 'handleJob',
			line: 17,
			column: 9,
			inApp: true,
			resolved: true,
		}
		expect(frameLocation(frame)).toBe('/src/job.ts:17:9')
		expect(frameLocation({ ...frame, line: null, column: null })).toBe('/src/job.ts')
	})
})
