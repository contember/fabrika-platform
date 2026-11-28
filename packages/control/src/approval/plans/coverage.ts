// What an approved plan entry binds to and what it covers (ADR-0050 §5). An entry is one subject of the access snapshot
// (`role:sales`, `endpoint:notes.create`, `migration:0042_add_index.sql`): the SHA-256 of the subject's fragment in the
// baseline the approver saw and in the candidate, and the digests of the lines the approver read for it. A later
// deploy's line is covered only when its own digest is among them and the subject's content leads from the deploy's
// baseline to its candidate through approved entries, so nothing the approver did not read rides in on an entry.

import { canonicalizeArtifact, canonicalJson, type ContractArtifact, sha256Hex } from '@fabrika/auth-core'
import type { AccessChangeDto, ApprovalPlan, ChangeSubjectDto, PlanBinding } from '@fabrika/control-contract'
import { z } from 'zod'
import type { ApprovalPlanEntryRow } from '../../db'
import { type AccessSnapshot, snapshotDigest } from '../snapshot'

const digestOf = (value: unknown): string => `sha256:${sha256Hex(canonicalJson(value ?? null))}`

/** A line's identity: every field the approver read, so a line that says anything else is another line. */
export function lineDigest(change: AccessChangeDto): string {
	return digestOf(change)
}

/** The subject a line is about, as `<kind>:<name>`; null for a line classified before lines carried one. */
export function subjectKeyOf(change: Pick<AccessChangeDto, 'rule' | 'subject'>): string | null {
	if (change.rule === undefined || change.subject === undefined) return null
	return `${change.subject.kind}:${change.subject.name}`
}

/**
 * The SHA-256 of what a subject's lines are computed from in `snapshot`: the subject's own entry of the contract, and for
 * a migration file its checksum with what the classifier read from it and the table access entries that name a view it
 * declares, whose SQL then decides access (ADR-0076). An `application` line reads the whole snapshot
 * (the staged kit, every SQL statement, the directory), so its fragment is the snapshot's digest: such a line is covered
 * only when nothing else changed either.
 */
export function subjectFragmentHash(snapshot: AccessSnapshot, subject: ChangeSubjectDto, contract: ContractArtifact | null): string {
	const name = subject.name
	switch (subject.kind) {
		case 'migration': {
			const ofFile = <T extends { readonly file: string }>(entries: readonly T[] | undefined) => (entries ?? []).filter((entry) => entry.file === name)
			const databaseCode = ofFile(snapshot.databaseCode)
			const views = new Set(databaseCode.flatMap((code) => (code.kind === 'view' ? [code.object] : [])))
			return digestOf({
				checksum: snapshot.migrations.find((migration) => migration.name === name)?.checksum ?? null,
				databaseCode,
				dataLoss: ofFile(snapshot.dataLoss),
				fileAdoptions: ofFile(snapshot.fileAdoptions),
				access: Object.entries(contract?.tables ?? {}).flatMap(([table, policy]) =>
					Object.entries(policy.access ?? {}).flatMap(([relation, access]) => (views.has(access.view) ? [{ table, relation, access }] : []))
				),
			})
		}
		case 'application':
			return snapshotDigest(snapshot)
	}
	if (contract === null) return digestOf(null)
	switch (subject.kind) {
		case 'endpoint': {
			const rows = contract.endpoints.filter((row) => row.id === name)
			const mounts = rows.flatMap((row) => (row.source.kind === 'mount' ? [row.source.name] : []))
			return digestOf({
				rows,
				procedure: contract.procedures?.[name] ?? null,
				declared: contract.declared?.[name] ?? null,
				mounts: mounts.map((mount) => contract.mounts[mount] ?? null),
			})
		}
		case 'job':
			return digestOf({ job: contract.jobs[name] ?? null, declared: contract.declared?.[`job:${name}`] ?? null })
		case 'role':
			return digestOf(contract.roles[name])
		case 'table':
			return digestOf(contract.tables[name])
		case 'dimension':
			return digestOf(contract.dimensions[name])
		case 'action':
			return digestOf(contract.actions[name])
		case 'mount':
			return digestOf(contract.mounts[name])
		case 'file-collection':
			return digestOf(contract.files[name])
		case 'file-kind':
			return digestOf(contract.fileKinds?.[name])
		case 'export':
			return digestOf(contract.exports[name])
		case 'import':
			return digestOf(contract.imports[name])
		case 'token':
			return digestOf(contract.tokens?.[name])
		case 'csp':
			return digestOf(Object.entries(contract.csp).find(([directive]) => directive === name)?.[1])
	}
}

/** A snapshot read for fragments: its contract canonicalized once, as the classifier compares it. */
export interface FragmentSource {
	readonly snapshot: AccessSnapshot
	readonly contract: ContractArtifact | null
}

export function fragmentSource(snapshot: AccessSnapshot): FragmentSource {
	return { snapshot, contract: snapshot.contract === null ? null : canonicalizeArtifact(snapshot.contract) }
}

/** One entry a plan records per subject of its change. */
export interface PlannedEntry {
	readonly subject: string
	readonly beforeHash: string
	readonly afterHash: string
	readonly lines: readonly string[]
}

/**
 * The entries of a change: one per subject its lines name, with the digests of all of that subject's lines. A subject
 * whose fragment is the same on both sides has a line that depends on something its fragment does not hold, so no entry
 * could bind the change it shows: it gets none, and its lines wait for a person at the deploy.
 */
export function plannedEntries(baseline: FragmentSource, candidate: FragmentSource, changes: readonly AccessChangeDto[]): PlannedEntry[] {
	const bySubject = new Map<string, { subject: ChangeSubjectDto; lines: string[] }>()
	for (const change of changes) {
		const key = subjectKeyOf(change)
		if (key === null || change.subject === undefined) continue
		const held = bySubject.get(key) ?? { subject: change.subject, lines: [] }
		held.lines.push(lineDigest(change))
		bySubject.set(key, held)
	}
	return [...bySubject.entries()].flatMap(([subject, held]) => {
		const beforeHash = subjectFragmentHash(baseline.snapshot, held.subject, baseline.contract)
		const afterHash = subjectFragmentHash(candidate.snapshot, held.subject, candidate.contract)
		return beforeHash === afterHash ? [] : [{ subject, beforeHash, afterHash, lines: [...new Set(held.lines)].sort() }]
	})
}

/** An active entry as coverage reads it. */
export interface CoveringEntry {
	readonly id: string
	readonly subject: string
	readonly beforeHash: string
	readonly afterHash: string
	readonly lines: ReadonlySet<string>
}

const storedLines = z.array(z.string().regex(/^sha256:[0-9a-f]{64}$/))

/** A stored entry as coverage reads it; its lines parsed once, here. */
export function coveringEntry(row: ApprovalPlanEntryRow): CoveringEntry {
	return {
		id: row.id,
		subject: row.subject,
		beforeHash: row.before_hash,
		afterHash: row.after_hash,
		lines: new Set(storedLines.parse(JSON.parse(row.lines_json))),
	}
}

/** The approved entries that cover a deploy's lines, and the ones that coverage used, which its publication consumes. */
export interface PlanCoverage extends ApprovalPlan<AccessChangeDto> {
	/** The entries a covered line went through, by id. */
	used(): readonly string[]
}

/**
 * Coverage of one deploy (baseline → candidate) by the environment's active entries. Under `transition` a line is
 * covered by a chain of entries of its subject whose before and after hashes lead from the baseline's fragment to the
 * candidate's, the line among the lines of some entry in it; under `after-state` by one entry whose after hash is the
 * candidate's fragment and which holds the line. A line with no subject is never covered.
 */
export function planCoverage(
	entries: readonly CoveringEntry[],
	baseline: FragmentSource,
	candidate: FragmentSource,
	binding: PlanBinding,
): PlanCoverage {
	const used = new Set<string>()
	const bySubject = new Map<string, CoveringEntry[]>()
	for (const entry of entries) bySubject.set(entry.subject, [...bySubject.get(entry.subject) ?? [], entry])
	const chains = new Map<string, readonly CoveringEntry[] | null>()
	return {
		covers(line) {
			const key = subjectKeyOf(line)
			if (key === null || line.subject === undefined) return false
			const held = bySubject.get(key) ?? []
			const after = subjectFragmentHash(candidate.snapshot, line.subject, candidate.contract)
			const digest = lineDigest(line)
			let path: readonly CoveringEntry[] | null
			if (binding === 'after-state') {
				const entry = held.find((candidateEntry) => candidateEntry.afterHash === after && candidateEntry.lines.has(digest))
				path = entry === undefined ? null : [entry]
			} else {
				const before = subjectFragmentHash(baseline.snapshot, line.subject, baseline.contract)
				const cached = chains.get(key)
				path = cached !== undefined ? cached : chain(held, before, after)
				chains.set(key, path)
				if (path !== null && !path.some((entry) => entry.lines.has(digest))) path = null
			}
			if (path === null) return false
			for (const entry of path) used.add(entry.id)
			return true
		},
		used: () => [...used].sort(),
	}
}

/** The shortest chain of entries from `before` to `after`, each entry's before hash the previous one's after hash. */
function chain(entries: readonly CoveringEntry[], before: string, after: string): readonly CoveringEntry[] | null {
	if (before === after) return null
	const reached = new Map<string, readonly CoveringEntry[]>([[before, []]])
	let frontier = [before]
	while (frontier.length > 0) {
		const next: string[] = []
		for (const hash of frontier) {
			const path = reached.get(hash) ?? []
			for (const entry of entries) {
				if (entry.beforeHash !== hash || reached.has(entry.afterHash)) continue
				const extended = [...path, entry]
				if (entry.afterHash === after) return extended
				reached.set(entry.afterHash, extended)
				next.push(entry.afterHash)
			}
		}
		frontier = next
	}
	return null
}
