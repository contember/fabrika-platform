// How the approval page shows one access change (ADR-0050 §7): the classification's facts grouped by who reaches an
// endpoint and by what else they are about, ranked by effect, review and reach, with repeated lines folded. Pure, and it
// decides nothing: whether a run waits is the classification's outcome alone.

import { type AccessChangeDto, CHANGE_SUBJECT_KINDS, type ChangeSubjectKind, SURFACE_REACHES, type SurfaceReach } from './index.js'

/** The endpoints of one caller group: everyone a reach admits, or the holders of one link mount's share links. */
export interface CallerGroup {
	readonly kind: 'caller'
	readonly key: string
	readonly reach: SurfaceReach
	readonly mount?: string
}

/** The lines about one kind of subject other than an endpoint: tables, roles, migrations, the application. */
export interface SubjectGroup {
	readonly kind: 'subject'
	readonly key: string
	readonly subject: ChangeSubjectKind
}

/** A line, or the lines of one rule and one effect on several subjects, which neither widen nor need closer review. */
export type ChangeRow =
	| { readonly kind: 'line'; readonly change: AccessChangeDto }
	| { readonly kind: 'folded'; readonly rule: string; readonly effect: 'narrows' | 'neutral'; readonly changes: readonly AccessChangeDto[] }

export interface EffectTally {
	readonly widens: number
	readonly narrows: number
	readonly neutral: number
	readonly closer: number
}

export type ChangeGroup = (CallerGroup | SubjectGroup) & {
	readonly rows: readonly ChangeRow[]
	readonly tally: EffectTally
	/** Whether the page collapses the group by default: only when it holds no widening line. */
	readonly collapsed: boolean
}

export interface ApprovalView {
	/** The endpoints that change per caller group, and the migration files the change adds or edits. */
	readonly impact: {
		readonly callers: readonly { readonly key: string; readonly reach: SurfaceReach; readonly mount?: string; readonly endpoints: number }[]
		readonly migrations: number
	}
	readonly callers: readonly ChangeGroup[]
	readonly data: readonly ChangeGroup[]
	/** The lines of a run classified before lines carried facts, in their stored order. */
	readonly unsorted: readonly AccessChangeDto[]
}

/** Lines of one rule and one effect fold from this many subjects on. */
export const FOLD_AT = 3

/**
 * A line's rank: a widening for closer review first, then a widening, a narrowing for closer review, a line that leaves
 * access unchanged, a narrowing. Nothing else enters it, so it cannot disagree with the classification.
 */
export function changeRank(change: Pick<AccessChangeDto, 'effect' | 'review'>): number {
	const closer = change.review === 'closer'
	if (change.effect === 'widens') return closer ? 0 : 1
	if (closer) return 2
	return change.effect === 'neutral' ? 3 : 4
}

export function approvalView(changes: readonly AccessChangeDto[]): ApprovalView {
	const callers = new Map<string, { readonly head: CallerGroup; readonly changes: AccessChangeDto[] }>()
	const data = new Map<ChangeSubjectKind, AccessChangeDto[]>()
	const unsorted: AccessChangeDto[] = []
	for (const change of changes) {
		const subject = change.subject
		if (subject === undefined) unsorted.push(change)
		else if (subject.kind === 'endpoint' && change.audience !== undefined) {
			const { reach, mount } = change.audience
			const key = mount === undefined ? reach : `${reach}:${mount}`
			const group = callers.get(key) ?? { head: { kind: 'caller', key, reach, ...(mount === undefined ? {} : { mount }) }, changes: [] }
			group.changes.push(change)
			callers.set(key, group)
		} else data.set(subject.kind, [...(data.get(subject.kind) ?? []), change])
	}
	const callerGroups = [...callers.values()]
		.map(({ head, changes }) => group(head, changes))
		.sort((a, b) => leadRank(a) - leadRank(b) || reachIndex(a) - reachIndex(b) || compareText(a.key, b.key))
	const dataGroups = [...data]
		.map(([subject, changes]) => group({ kind: 'subject', key: subject, subject }, changes))
		.sort((a, b) => leadRank(a) - leadRank(b) || subjectIndex(a) - subjectIndex(b))
	const migrations = new Set(changes.flatMap((change) => (change.subject?.kind === 'migration' ? [change.subject.name] : [])))
	return {
		impact: {
			callers: callerGroups.flatMap((entry) =>
				entry.kind === 'caller'
					? [{ key: entry.key, reach: entry.reach, ...(entry.mount === undefined ? {} : { mount: entry.mount }), endpoints: endpointsOf(entry) }]
					: []
			),
			migrations: migrations.size,
		},
		callers: callerGroups,
		data: dataGroups,
		unsorted,
	}
}

function group(head: CallerGroup | SubjectGroup, changes: readonly AccessChangeDto[]): ChangeGroup {
	const ranked = changes.map((change, index) => ({ change, index }))
		.sort((a, b) => changeRank(a.change) - changeRank(b.change) || compareText(subjectName(a.change), subjectName(b.change)) || a.index - b.index)
		.map(({ change }) => change)
	return { ...head, rows: fold(ranked), tally: tallyOf(changes), collapsed: !changes.some((change) => change.effect === 'widens') }
}

/**
 * Lines of one rule and one effect on `FOLD_AT` subjects or more become one row at the place of the first of them. A
 * widening or a line for closer review never folds, so every one of them is in view without expanding anything.
 */
function fold(ranked: readonly AccessChangeDto[]): ChangeRow[] {
	const foldable = (change: AccessChangeDto): change is AccessChangeDto & { effect: 'narrows' | 'neutral'; rule: string } =>
		change.effect !== 'widens' && change.review !== 'closer' && change.rule !== undefined
	const families = new Map<string, AccessChangeDto[]>()
	for (const change of ranked) {
		if (!foldable(change)) continue
		const key = `${change.rule} ${change.effect}`
		families.set(key, [...(families.get(key) ?? []), change])
	}
	const rows: ChangeRow[] = []
	const placed = new Set<string>()
	for (const change of ranked) {
		if (!foldable(change)) {
			rows.push({ kind: 'line', change })
			continue
		}
		const key = `${change.rule} ${change.effect}`
		const family = families.get(key) ?? []
		if (family.length < FOLD_AT) rows.push({ kind: 'line', change })
		else if (!placed.has(key)) {
			placed.add(key)
			rows.push({ kind: 'folded', rule: change.rule, effect: change.effect, changes: family })
		}
	}
	return rows
}

function tallyOf(changes: readonly AccessChangeDto[]): EffectTally {
	return {
		widens: changes.filter((change) => change.effect === 'widens').length,
		narrows: changes.filter((change) => change.effect === 'narrows').length,
		neutral: changes.filter((change) => change.effect === 'neutral').length,
		closer: changes.filter((change) => change.review === 'closer').length,
	}
}

function endpointsOf(entry: ChangeGroup): number {
	const lines = entry.rows.flatMap((row) => (row.kind === 'line' ? [row.change] : row.changes))
	return new Set(lines.map(subjectName)).size
}

function leadRank(entry: ChangeGroup): number {
	const first = entry.rows[0]
	if (first === undefined) return Number.POSITIVE_INFINITY
	return changeRank(first.kind === 'line' ? first.change : { effect: first.effect })
}

function reachIndex(entry: ChangeGroup): number {
	return entry.kind === 'caller' ? SURFACE_REACHES.indexOf(entry.reach) : 0
}

function subjectIndex(entry: ChangeGroup): number {
	return entry.kind === 'subject' ? CHANGE_SUBJECT_KINDS.indexOf(entry.subject) : 0
}

const subjectName = (change: AccessChangeDto): string => change.subject?.name ?? ''

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
