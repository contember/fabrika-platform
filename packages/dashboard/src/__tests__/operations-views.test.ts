import type { ActivityItem, DisplayFrame } from '@fabrika/operations-contract'
import { describe, expect, test } from 'bun:test'
import { fmtDate } from '../lib/format'
import { formatQuery, parseQuery } from '../lib/query-search'
import { activityPayloadLabel, frameLocation } from '../operations/views/ErrorDetail'
import {
	DEFAULT_ISSUE_FILTERS,
	issueFiltersFromQuery,
	issueFiltersToQuery,
	issueQuery,
	issueQueryLanguage,
	sourceNames,
	trendPoints,
} from '../operations/views/Errors'
import { aggregateHealth } from '../routes/operations/health/index'

describe('issue views', () => {
	test('builds a bounded server-side query from visible filters', () => {
		expect(issueQuery({ ...DEFAULT_ISSUE_FILTERS, query: ' handle ', sourceId: 'source-1', level: 'error' }, 'cursor-1')).toEqual({
			query: 'handle',
			sourceId: 'source-1',
			status: 'open',
			level: 'error',
			window: '24h',
			assignee: 'all',
			sort: 'recent',
			cursor: 'cursor-1',
			limit: 50,
		})
	})

	test('the search field shows exactly what is filtered, and reads back to the same filters', () => {
		const source = (id: string, displayName: string, environment: string) => ({
			id,
			appId: 'notes',
			environment,
			serviceKey: 'default',
			displayName,
			publicOrigin: null,
			enabled: true,
		})
		const sources = [
			source('s1', 'Browser Notes / test', 'test'),
			source('s2', 'api', 'prod'),
			source('s3', 'api', 'stage'),
			source('s4', 'web', 'prod'),
			source('s5', 'web', 'prod'),
		]
		const language = issueQueryLanguage(sources)

		// The defaults narrow to open issues of the last day, and say so.
		expect(formatQuery(language, issueFiltersToQuery(DEFAULT_ISSUE_FILTERS, sources))).toBe('status:open window:24h')
		const filters = { ...DEFAULT_ISSUE_FILTERS, query: 'checkout failed', sourceId: 's1', level: 'error' as const, sort: 'frequency' as const }
		const text = formatQuery(language, issueFiltersToQuery(filters, sources), filters.query)
		expect(text).toBe('status:open level:error source:"Browser Notes / test" window:24h sort:frequency checkout failed')
		const parsed = parseQuery(language, text)
		expect(issueFiltersFromQuery(parsed.filters, parsed.text, sources)).toEqual(filters)

		// A shared name is told apart by its environment, and by the id where that is shared too.
		expect(sourceNames(sources).get('s2')).toBe('api/prod')
		expect(sourceNames(sources).get('s4')).toBe('s4')
		// A source the list does not carry still narrows, by its id.
		expect(issueFiltersFromQuery({ source: 's9' }, '', sources).sourceId).toBe('s9')

		// An emptied field narrows nothing.
		expect(issueFiltersFromQuery({}, '', sources)).toEqual({
			query: '',
			sourceId: '',
			status: 'all',
			level: 'all',
			window: 'all',
			assignee: 'all',
			sort: 'recent',
		})
	})

	test('plots trends relative to the visible peak', () => {
		expect(trendPoints([])).toBe('')
		expect(trendPoints([0, 2, 4], 10, 10)).toBe('0,10 5,5 10,0')
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

	test('renders only typed activity payload values', () => {
		const activity = (kind: ActivityItem['kind'], data: ActivityItem['data']): ActivityItem => ({
			id: `activity-${kind}`,
			kind,
			actorLabel: 'Operator',
			data,
			at: 1_700_000_000_000,
		})
		expect(activityPayloadLabel(activity('comment', { text: 'Investigating the failing job.', secret: 'hidden' }))).toBe(
			'Investigating the failing job.',
		)
		expect(activityPayloadLabel(activity('assigned', { to: 'On-call engineer', toId: 'principal-1' }))).toBe(
			'Assigned to On-call engineer',
		)
		expect(activityPayloadLabel(activity('snoozed', { until: 1_700_000_000_000 }))).toBe(
			`Snoozed until ${fmtDate(1_700_000_000)}`,
		)
		expect(activityPayloadLabel(activity('snoozed', { release: 'release-2026-07-31' }))).toBe(
			'Resolved in release release-2026-07-31',
		)
		expect(activityPayloadLabel(activity('merged', { into: 'opaque-issue-target' }))).toBe('Merged into opaque-issue-target')
		expect(activityPayloadLabel(activity('regressed', { secret: 'hidden' }))).toBeNull()
	})

	test('aggregates the worst visible health state without inventing availability', () => {
		expect(aggregateHealth('healthy', ['healthy'])).toBe('healthy')
		expect(aggregateHealth('healthy', ['stale'])).toBe('stale')
		expect(aggregateHealth('degraded', ['failed'])).toBe('failed')
		expect(aggregateHealth('unavailable', [])).toBe('unavailable')
	})
})
