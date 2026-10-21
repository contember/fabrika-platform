// How the approval page shows one access change (ADR-0050 §7): the classification's facts grouped by who reaches an
// endpoint and by what else they are about, one row per subject with all its lines, ranked by effect, review and
// reach, and quiet subjects that changed alike folded into one row. Pure, and it decides nothing: whether a run waits is
// the classification's outcome alone.

import {
	type AccessChangeDto,
	CHANGE_SUBJECT_KINDS,
	type ChangeAudienceDto,
	type ChangeSubjectDto,
	type ChangeSubjectKind,
	SURFACE_REACHES,
	type SurfaceReach,
} from './index.js'

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

/** One subject and its lines, most important first. */
export interface SubjectRow {
	readonly kind: 'subject'
	readonly subject: ChangeSubjectDto
	readonly audience?: ChangeAudienceDto
	readonly changes: readonly AccessChangeDto[]
}

/**
 * Quiet subjects that changed alike: each has lines of exactly these rules and effects, and none of them widens or needs
 * closer review (`rules` in order, as `rule` and `effect`).
 */
export interface FoldedRow {
	readonly kind: 'folded'
	readonly rules: readonly { readonly rule: string; readonly effect: 'narrows' | 'neutral' }[]
	readonly subjects: readonly SubjectRow[]
}

export type ChangeRow = SubjectRow | FoldedRow

export interface EffectTally {
	readonly widens: number
	readonly narrows: number
	readonly neutral: number
	readonly closer: number
}

export type ChangeGroup = (CallerGroup | SubjectGroup) & {
	readonly rows: readonly ChangeRow[]
	/** How many subjects the group holds, folded ones included. */
	readonly subjects: number
	readonly tally: EffectTally
	/** Whether the page collapses the group by default: only when it holds no widening line. */
	readonly collapsed: boolean
}

export interface ApprovalView {
	/**
	 * Per caller group the endpoints that change, apart from the removed endpoints and mounts its paths reach (a removal
	 * that widens stands with whoever its paths reach now), and the migration files the change adds or edits.
	 */
	readonly impact: {
		readonly callers: readonly {
			readonly key: string
			readonly reach: SurfaceReach
			readonly mount?: string
			readonly endpoints: number
			readonly removedEndpoints: number
			readonly removedMounts: number
		}[]
		readonly migrations: number
	}
	readonly callers: readonly ChangeGroup[]
	readonly data: readonly ChangeGroup[]
	/** The lines of a run classified before lines carried facts, in their stored order. */
	readonly unsorted: readonly AccessChangeDto[]
}

/** Quiet subjects that changed alike fold from this many on. */
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
	// A line with an audience is about who reaches something: an endpoint, or a removed mount whose paths now reach a
	// more exposed endpoint. Every other line is about data and runtime.
	for (const change of changes) {
		const subject = change.subject
		if (subject === undefined) unsorted.push(change)
		else if (change.audience !== undefined) {
			const { reach, mount } = change.audience
			const key = mount === undefined ? reach : `${reach}:${mount}`
			const group = callers.get(key)
			if (group === undefined) callers.set(key, { head: { kind: 'caller', key, reach, ...(mount === undefined ? {} : { mount }) }, changes: [change] })
			else group.changes.push(change)
		} else {
			const kind = data.get(subject.kind)
			if (kind === undefined) data.set(subject.kind, [change])
			else kind.push(change)
		}
	}
	const callerGroups = sortGroups([...callers.values()].map(({ head, changes }) => group(head, changes)), reachIndex)
	const dataGroups = sortGroups([...data].map(([subject, changes]) => group({ kind: 'subject', key: subject, subject }, changes)), subjectIndex)
	// A migration file the change adds or edits; a removed file runs nowhere.
	const migrations = new Set(
		changes.flatMap((change) =>
			change.subject?.kind === 'migration' && (change.rule === 'migration.added' || change.rule === 'migration.changed') ? [change.subject.name] : []
		),
	)
	const counted = (entry: ChangeGroup, kind: 'endpoint' | 'mount', removed: boolean) =>
		entry.rows.flatMap(subjectRows).filter((row) =>
			row.subject.kind === kind && row.changes.some((change) => change.rule === 'endpoint.removed' || change.rule === 'mount.removed') === removed
		).length
	return {
		impact: {
			callers: callerGroups.flatMap((entry) =>
				entry.kind === 'caller'
					? [{
						key: entry.key,
						reach: entry.reach,
						...(entry.mount === undefined ? {} : { mount: entry.mount }),
						endpoints: counted(entry, 'endpoint', false),
						removedEndpoints: counted(entry, 'endpoint', true),
						removedMounts: counted(entry, 'mount', true),
					}]
					: []
			),
			migrations: migrations.size,
		},
		callers: callerGroups,
		data: dataGroups,
		unsorted,
	}
}

/** Every line a row holds. */
export function rowChanges(row: ChangeRow): readonly AccessChangeDto[] {
	return row.kind === 'subject' ? row.changes : row.subjects.flatMap((subject) => subject.changes)
}

/** Every subject a row holds. */
function subjectRows(row: ChangeRow): readonly SubjectRow[] {
	return row.kind === 'subject' ? [row] : row.subjects
}

/** Groups in rank order: the group whose most important line ranks first, then by `index` (reach or subject kind). */
function sortGroups(groups: readonly ChangeGroup[], index: (entry: ChangeGroup) => number): ChangeGroup[] {
	const ranked = groups.map((entry) => ({ entry, rank: Math.min(...entry.rows.flatMap(rowChanges).map(changeRank)) }))
	return ranked.sort((a, b) => a.rank - b.rank || index(a.entry) - index(b.entry) || compareText(a.entry.key, b.entry.key)).map(({ entry }) => entry)
}

function group(head: CallerGroup | SubjectGroup, changes: readonly AccessChangeDto[]): ChangeGroup {
	const bySubject = new Map<string, { subject: ChangeSubjectDto; audience?: ChangeAudienceDto; changes: AccessChangeDto[] }>()
	for (const change of changes) {
		const subject = change.subject
		if (subject === undefined) continue
		// A removed mount and an endpoint may share a name; a subject is its kind and its name.
		const key = `${subject.kind}:${subject.name}`
		const entry = bySubject.get(key)
		if (entry === undefined) bySubject.set(key, { subject, ...(change.audience === undefined ? {} : { audience: change.audience }), changes: [change] })
		else entry.changes.push(change)
	}
	const rows = [...bySubject.values()].map((entry): SubjectRow => ({
		kind: 'subject',
		subject: entry.subject,
		...(entry.audience === undefined ? {} : { audience: entry.audience }),
		changes: entry.changes.map((change, index) => ({ change, index })).sort((a, b) => changeRank(a.change) - changeRank(b.change) || a.index - b.index)
			.map(({ change }) => change),
	}))
	return {
		...head,
		rows: fold(rows.sort((a, b) => rowRank(a) - rowRank(b) || compareText(a.subject.name, b.subject.name))),
		subjects: rows.length,
		tally: tallyOf(changes),
		collapsed: !changes.some((change) => change.effect === 'widens'),
	}
}

/**
 * A subject is quiet when none of its lines widens or needs closer review. Quiet subjects whose lines have the same rules
 * and effects become one row, from `FOLD_AT` of them on, at the place of the first; every other subject keeps its row,
 * so every widening and every line for closer review is in view without expanding anything.
 */
function fold(rows: readonly SubjectRow[]): ChangeRow[] {
	const keys = new Map(rows.map((row) => [row, quietKey(row)]))
	const families = new Map<string, SubjectRow[]>()
	for (const [row, key] of keys) {
		if (key === undefined) continue
		const family = families.get(key)
		if (family === undefined) families.set(key, [row])
		else family.push(row)
	}
	const folded: ChangeRow[] = []
	const placed = new Set<string>()
	for (const row of rows) {
		const key = keys.get(row)
		const family = key === undefined ? [] : (families.get(key) ?? [])
		if (key === undefined || family.length < FOLD_AT) folded.push(row)
		else if (!placed.has(key)) {
			placed.add(key)
			folded.push({ kind: 'folded', rules: quietRules(row), subjects: family })
		}
	}
	return folded
}

function quietRules(row: SubjectRow): { rule: string; effect: 'narrows' | 'neutral' }[] {
	const rules = new Map<string, { rule: string; effect: 'narrows' | 'neutral' }>()
	for (const change of row.changes) {
		if (change.rule !== undefined && change.effect !== 'widens') {
			rules.set(`${change.rule} ${change.effect}`, { rule: change.rule, effect: change.effect })
		}
	}
	return [...rules.values()]
}

function quietKey(row: SubjectRow): string | undefined {
	const quiet = row.changes.every((change) => change.effect !== 'widens' && change.review !== 'closer' && change.rule !== undefined)
	return quiet ? quietRules(row).map(({ rule, effect }) => `${rule} ${effect}`).join('|') : undefined
}

function tallyOf(changes: readonly AccessChangeDto[]): EffectTally {
	return {
		widens: changes.filter((change) => change.effect === 'widens').length,
		narrows: changes.filter((change) => change.effect === 'narrows').length,
		neutral: changes.filter((change) => change.effect === 'neutral').length,
		closer: changes.filter((change) => change.review === 'closer').length,
	}
}

function rowRank(row: SubjectRow): number {
	return Math.min(...row.changes.map(changeRank))
}

function reachIndex(entry: ChangeGroup): number {
	return entry.kind === 'caller' ? SURFACE_REACHES.indexOf(entry.reach) : 0
}

function subjectIndex(entry: ChangeGroup): number {
	return entry.kind === 'subject' ? CHANGE_SUBJECT_KINDS.indexOf(entry.subject) : 0
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
