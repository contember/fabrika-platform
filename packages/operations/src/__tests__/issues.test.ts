import { describe, expect, test } from 'bun:test'
import type { PriorIssueState } from '@fabrika/operations-contract'
import { applyIssueMutation, decideOccurrenceTransition } from '../issues.js'

const resolved: PriorIssueState = {
	status: 'resolved',
	resolvedInRelease: null,
	snoozeUntil: null,
	snoozeUntilCount: null,
}

describe('issue lifecycle semantics', () => {
	test('a plain resolved issue regresses on its first new occurrence', () => {
		expect(
			decideOccurrenceTransition(
				resolved,
				[
					{ receivedAt: 200, release: 'v2' },
					{ receivedAt: 100, release: 'v1' },
				],
				2,
			),
		).toEqual({ reopen: true, regression: true, at: 100, release: 'v1', activity: 'regressed' })
	})

	test('resolve-in-release waits for a different release', () => {
		const prior: PriorIssueState = { ...resolved, resolvedInRelease: 'v1' }
		expect(decideOccurrenceTransition(prior, [{ receivedAt: 100, release: 'v1' }], 5).reopen).toBeFalse()
		expect(decideOccurrenceTransition(prior, [{ receivedAt: 200, release: 'v2' }], 6)).toEqual({
			reopen: true,
			regression: true,
			at: 200,
			release: 'v2',
			activity: 'regressed',
		})
	})

	test('plain ignore stays muted while time and count snoozes reopen without regression', () => {
		const ignored: PriorIssueState = {
			status: 'ignored',
			resolvedInRelease: null,
			snoozeUntil: null,
			snoozeUntilCount: null,
		}
		expect(decideOccurrenceTransition(ignored, [{ receivedAt: 200 }], 20).reopen).toBeFalse()
		expect(decideOccurrenceTransition({ ...ignored, snoozeUntilCount: 20 }, [{ receivedAt: 200 }], 20)).toEqual({
			reopen: true,
			regression: false,
			at: 200,
			release: null,
			activity: 'unsnoozed',
		})
	})

	test('normalises mutation data before persistence adapters see it', () => {
		expect(applyIssueMutation(resolved, { kind: 'comment', text: '  investigate this  ' }).activity).toEqual({
			kind: 'comment',
			data: { text: 'investigate this' },
		})
		expect(applyIssueMutation(resolved, { kind: 'snooze_count', additional: 5, currentCount: 12 })).toMatchObject({
			status: 'ignored',
			snoozeUntilCount: 17,
			activity: { kind: 'snoozed', data: { count: 5 } },
		})
		expect(applyIssueMutation(resolved, { kind: 'resolve_in_release', release: '  v3  ' })).toMatchObject({
			status: 'resolved',
			resolvedInRelease: 'v3',
		})
	})
})
