import type { DisplayFrame } from '@fabrika/operations-contract'
import type { OperationsIssueSummaryDto } from '@fabrika/operations-contract/operator-api'
import { describe, expect, test } from 'bun:test'
import { aggregateHealth } from '../routes/health'
import { frameLocation } from '../views/ErrorDetail'
import { filterIssues } from '../views/Errors'

const issue: OperationsIssueSummaryDto = {
	id: 'opaque-issue-id',
	source: {
		id: 'opaque-source-id',
		appId: 'worker-api',
		environment: 'production',
		serviceKey: 'default',
		displayName: 'Worker API',
		publicOrigin: 'https://worker.example.test',
		enabled: true,
	},
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
		expect(filterIssues([issue], 'handle', 'open')).toEqual([issue])
		expect(filterIssues([issue], 'worker', 'resolved')).toEqual([])
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

	test('aggregates the worst visible health state without inventing availability', () => {
		expect(aggregateHealth('healthy', ['healthy'])).toBe('healthy')
		expect(aggregateHealth('healthy', ['stale'])).toBe('stale')
		expect(aggregateHealth('degraded', ['failed'])).toBe('failed')
		expect(aggregateHealth('unavailable', [])).toBe('unavailable')
	})
})
