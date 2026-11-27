// An approval plan in the console's words (ADR-0050 §5): its state, what binds it, how long it holds, and its lines
// split by what each waits for at the deploy. The page decides nothing; Control judges every decision again.

import { type AccessChangeDto, type ApprovalPlanDto, type ApprovalPlanState, PLAN_TTL_DAYS, type PlanBinding } from '@fabrika/control-contract'
import type { Lamp } from '../components/Status'

export const PLAN_STATE_TEXT: Readonly<Record<ApprovalPlanState, string>> = {
	pending: 'Waiting for a decision',
	approved: 'Approved',
	rejected: 'Refused',
	expired: 'Expired',
	revoked: 'Revoked',
}

export function planLamp(state: ApprovalPlanState): Lamp {
	switch (state) {
		case 'approved':
			return 'ok'
		case 'pending':
			return 'idle'
		case 'rejected':
		case 'expired':
		case 'revoked':
			return 'stop'
	}
}

/** What an approved plan binds to, in the console's words. */
export function planBindingLabel(binding: PlanBinding): string {
	return binding === 'transition' ? 'The change from what runs' : 'The result alone'
}

/** A number of days an approved plan covers deploys, or null for one outside `planTtlDays`'s bounds. */
export function planTtl(text: string): number | null {
	const days = Number(text)
	return Number.isInteger(days) && days >= PLAN_TTL_DAYS.min && days <= PLAN_TTL_DAYS.max ? days : null
}

/** One subject the plan covers: its entry and the lines the approver reads for it. */
export interface PlannedSubject {
	readonly subject: string
	readonly entry: ApprovalPlanDto['entries'][number] | undefined
	readonly changes: readonly AccessChangeDto[]
}

/** The plan's lines by what each waits for: covered by an entry, still a person's at the deploy, or nothing. */
export interface PlanLines {
	readonly covered: readonly PlannedSubject[]
	readonly person: readonly AccessChangeDto[]
	readonly off: readonly AccessChangeDto[]
}

/** The subject key a change line names, as Control keys an entry: `<kind>:<name>`; a line without a rule has none. */
export function subjectKey(change: AccessChangeDto): string | null {
	return change.rule === undefined || change.subject === undefined ? null : `${change.subject.kind}:${change.subject.name}`
}

/**
 * Split the lines: a `plan` line goes under its subject's entry; one without a subject, which no entry can cover, waits
 * for a person at the deploy, as a `person` line does.
 */
export function planLines(plan: Pick<ApprovalPlanDto, 'lines' | 'entries'>): PlanLines {
	const subjects = new Map<string, AccessChangeDto[]>()
	const person: AccessChangeDto[] = []
	const off: AccessChangeDto[] = []
	for (const { change, mode } of plan.lines) {
		const key = subjectKey(change)
		if (mode === 'off') off.push(change)
		else if (mode === 'person' || key === null) person.push(change)
		else subjects.set(key, [...(subjects.get(key) ?? []), change])
	}
	const covered = [...subjects].map(([subject, changes]) => ({
		subject,
		entry: plan.entries.find((entry) => entry.subject === subject),
		changes,
	}))
	return { covered, person, off }
}

/** How many entries of an approved plan still cover a deploy. */
export function activeEntries(plan: Pick<ApprovalPlanDto, 'entries'>): number {
	return plan.entries.filter((entry) => entry.state === 'active').length
}
