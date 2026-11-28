// An approval plan in the console's words (ADR-0050 §5): its state, what binds it, how long it holds, and its lines
// split by what each waits for at the deploy. The page decides nothing; Control judges every decision again.

import {
	type AccessChangeDto,
	type ApprovalPlanDto,
	type ApprovalPlanLineDto,
	type ApprovalPlanState,
	PLAN_TTL_DAYS,
	type PlanBinding,
} from '@fabrika/control-contract'
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

/** One subject the plan holds: its entry, the lines the approver reads for it, and what they wait for now. */
export interface PlannedSubject {
	readonly subject: string
	readonly entry: ApprovalPlanDto['entries'][number] | undefined
	readonly changes: readonly AccessChangeDto[]
	/** The strictest mode among its lines now: `plan` as when the plan was made, or what the policy changed it to. */
	readonly mode: ApprovalPlanLineDto['mode']
}

/** The plan's lines: held by an entry, not held but waiting for a person at the deploy, or waiting for nothing. */
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
 * Split the lines as Control marks them: a held line goes under its subject's entry, whatever the policy says of it now;
 * any other line waits for a person at the deploy, or for nothing.
 */
export function planLines(plan: Pick<ApprovalPlanDto, 'lines' | 'entries'>): PlanLines {
	const subjects = new Map<string, ApprovalPlanLineDto[]>()
	const person: AccessChangeDto[] = []
	const off: AccessChangeDto[] = []
	for (const line of plan.lines) {
		const key = subjectKey(line.change)
		if (line.held && key !== null) subjects.set(key, [...(subjects.get(key) ?? []), line])
		else if (line.mode === 'off') off.push(line.change)
		else person.push(line.change)
	}
	const rank: Record<ApprovalPlanLineDto['mode'], number> = { off: 0, plan: 1, person: 2 }
	const covered = [...subjects].map(([subject, lines]) => ({
		subject,
		entry: plan.entries.find((entry) => entry.subject === subject),
		changes: lines.map((line) => line.change),
		mode: lines.reduce<ApprovalPlanLineDto['mode']>((strictest, line) => (rank[line.mode] > rank[strictest] ? line.mode : strictest), 'off'),
	}))
	return { covered, person, off }
}

/** How many entries of an approved plan still cover a deploy. */
export function activeEntries(plan: Pick<ApprovalPlanDto, 'entries'>): number {
	return plan.entries.filter((entry) => entry.state === 'active').length
}
