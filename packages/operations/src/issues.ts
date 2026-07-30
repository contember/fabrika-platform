import type {
	IssueMutation,
	IssueMutationDecision,
	Occurrence,
	OccurrenceTransition,
	PriorIssueState,
} from '@fabrika/operations-contract'

function noTransition(): OccurrenceTransition {
	return { reopen: false, regression: false, at: null, release: null, activity: null }
}

export function decideOccurrenceTransition(
	prior: PriorIssueState | null,
	occurrences: Occurrence[],
	totalCount: number,
): OccurrenceTransition {
	if (!prior || occurrences.length === 0 || prior.status === 'open') return noTransition()
	const ordered = [...occurrences].sort((left, right) => left.receivedAt - right.receivedAt)
	if (prior.status === 'resolved') {
		const trigger = prior.resolvedInRelease === null
			? ordered[0]
			: ordered.find((occurrence) => Boolean(occurrence.release) && occurrence.release !== prior.resolvedInRelease)
		if (!trigger) return noTransition()
		return {
			reopen: true,
			regression: true,
			at: trigger.receivedAt,
			release: trigger.release ?? null,
			activity: 'regressed',
		}
	}
	const latest = ordered.at(-1)
	if (!latest) return noTransition()
	const timeReached = prior.snoozeUntil !== null && latest.receivedAt >= prior.snoozeUntil
	const countReached = prior.snoozeUntilCount !== null && totalCount >= prior.snoozeUntilCount
	return timeReached || countReached
		? { reopen: true, regression: false, at: latest.receivedAt, release: null, activity: 'unsnoozed' }
		: noTransition()
}

export function applyIssueMutation(prior: PriorIssueState, mutation: IssueMutation): IssueMutationDecision {
	if (mutation.kind === 'status') {
		return {
			status: mutation.status,
			activity: mutation.status === prior.status
				? null
				: { kind: 'status', data: { from: prior.status, to: mutation.status } },
		}
	}
	if (mutation.kind === 'comment') {
		const text = mutation.text.trim()
		if (text.length === 0 || text.length > 5000) throw new RangeError('Comment must contain between 1 and 5000 characters.')
		return { status: prior.status, activity: { kind: 'comment', data: { text } } }
	}
	if (mutation.kind === 'assign') {
		return {
			status: prior.status,
			assignedTo: mutation.principalId,
			assignedToLabel: mutation.principalLabel,
			activity: {
				kind: 'assigned',
				data: { to: mutation.principalLabel, toId: mutation.principalId },
			},
		}
	}
	if (mutation.kind === 'snooze_until') {
		if (!Number.isInteger(mutation.until) || mutation.until <= 0) throw new RangeError('Snooze time must be a positive integer.')
		return {
			status: 'ignored',
			snoozeUntil: mutation.until,
			snoozeUntilCount: null,
			resolvedInRelease: null,
			activity: { kind: 'snoozed', data: { until: mutation.until } },
		}
	}
	if (mutation.kind === 'snooze_count') {
		if (!Number.isInteger(mutation.additional) || mutation.additional <= 0 || mutation.additional > 100_000) {
			throw new RangeError('Snooze count must be between 1 and 100000.')
		}
		return {
			status: 'ignored',
			snoozeUntil: null,
			snoozeUntilCount: mutation.currentCount + mutation.additional,
			resolvedInRelease: null,
			activity: { kind: 'snoozed', data: { count: mutation.additional } },
		}
	}
	if (mutation.kind === 'resolve_in_release') {
		const release = mutation.release?.trim() || null
		return {
			status: 'resolved',
			snoozeUntil: null,
			snoozeUntilCount: null,
			resolvedInRelease: release,
			activity: { kind: 'snoozed', data: { release } },
		}
	}
	if (!mutation.target) throw new RangeError('Merge target is required.')
	return {
		status: prior.status,
		mergedInto: mutation.target,
		activity: { kind: 'merged', data: { into: mutation.target } },
	}
}
