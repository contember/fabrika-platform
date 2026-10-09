// The conservative classification of an access change (ADR-0050 §3). Pure: it compares the candidate snapshot with the
// environment's active one and answers plain-language lines for the approver. Anything it cannot show to narrow
// access widens it.

import {
	canonicalizeArtifact,
	canonicalJson,
	type ContractArtifact,
	type EndpointRow,
	type FileCollectionArtifact,
	type RoleArtifact,
	type SchemaShape,
	type TablePolicyArtifact,
} from '@fabrika/auth-core'
import type { AccessSnapshot } from './snapshot'

/** One plain-language line; `widens` when the change can grant access the baseline did not. */
export interface AccessChange {
	readonly widens: boolean
	readonly line: string
}

/** `unchanged` and `removal` publish at once; `widening` waits for a human on a protected environment. */
export type AccessOutcome = 'unchanged' | 'removal' | 'widening'

export interface AccessClassification {
	readonly outcome: AccessOutcome
	readonly changes: readonly AccessChange[]
}

export function classifyAccess(baseline: AccessSnapshot, candidate: AccessSnapshot): AccessClassification {
	const changes = new Changes()
	compareContracts(changes, baseline.contract, candidate.contract)
	compareKeyed(changes, byName(baseline.migrations), byName(candidate.migrations), {
		added: (name) => `New migration \`${name}\``,
		removed: (name) => `Migration \`${name}\` is removed`,
		changed: (name, before, after) => (before.checksum === after.checksum ? [] : [widening(`Migration \`${name}\` changes`)]),
	})
	const list = changes.list
	return { outcome: list.length === 0 ? 'unchanged' : list.some((change) => change.widens) ? 'widening' : 'removal', changes: list }
}

class Changes {
	readonly list: AccessChange[] = []

	add(...changes: readonly AccessChange[]): void {
		this.list.push(...changes)
	}
}

const widening = (line: string): AccessChange => ({ widens: true, line })
const removal = (line: string): AccessChange => ({ widens: false, line })

function compareContracts(changes: Changes, before: ContractArtifact | null, after: ContractArtifact | null): void {
	if (before === null && after === null) return
	if (after === null) {
		changes.add(widening('The contract is removed: the proxy no longer applies an endpoint table to this application'))
		return
	}
	const candidate = canonicalizeArtifact(after)
	const baseline = before === null ? emptyArtifact(candidate.app) : canonicalizeArtifact(before)
	if (before === null) changes.add(widening(`The application becomes the contract application \`${candidate.app}\``))
	else if (baseline.app !== candidate.app) changes.add(widening(`The contract's application changes from \`${baseline.app}\` to \`${candidate.app}\``))
	compareEndpoints(changes, baseline, candidate)
	compareSet(changes, baseline.reservedPrefixes, candidate.reservedPrefixes, {
		// A reserved prefix restricts which endpoints compete under it, so losing one widens.
		added: (prefix) => removal(`Reserved prefix \`${prefix}\` is added`),
		removed: (prefix) => widening(`Reserved prefix \`${prefix}\` is removed`),
	})
	compareKeyed(changes, record(baseline.dimensions), record(candidate.dimensions), {
		added: (name) => `New dimension \`${name}\``,
		removed: (name) => `Dimension \`${name}\` is removed`,
		changed: (name, from, to) => valueChange(`Dimension \`${name}\``, from, to),
	})
	compareKeyed(changes, record(baseline.actions), record(candidate.actions), {
		added: (name) => `New action \`${name}\``,
		removed: (name) => `Action \`${name}\` is removed`,
		changed: () => [],
	})
	compareKeyed(changes, record(baseline.roles), record(candidate.roles), {
		added: (name, role) => `New role \`${name}\` with ${listOf(role.grants, 'no actions')}`,
		removed: (name) => `Role \`${name}\` is removed`,
		changed: roleChanges,
	})
	compareKeyed(changes, record(baseline.mounts), record(candidate.mounts), {
		added: (name, mount) => `New ${mount.kind} mount \`${name}\``,
		removed: (name) => `Mount \`${name}\` is removed`,
		changed: (name, from, to) => valueChange(`Mount \`${name}\``, from, to),
	})
	compareKeyed(changes, record(baseline.files), record(candidate.files), {
		added: (name, files) => `New file collection \`${name}\`${files.link ? ', reachable through share links' : ''}`,
		removed: (name) => `File collection \`${name}\` is removed`,
		changed: fileChanges,
	})
	compareKeyed(changes, record(baseline.jobs), record(candidate.jobs), {
		added: (name, job) => `New job \`${name}\` with ${listOf(job.actions, 'no actions')}`,
		removed: (name) => `Job \`${name}\` is removed`,
		changed: (name, from, to) => [
			...setChanges(`Job \`${name}\``, from.actions, to.actions, 'gains action', 'loses action'),
			...valueChange(`Job \`${name}\` scope`, from.scope, to.scope),
		],
	})
	compareKeyed(changes, record(baseline.exports), record(candidate.exports), {
		added: (name, declaration) => `New export \`${name}\` for ${listOf(declaration.consumers, 'no consumers')}`,
		removed: (name) => `Export \`${name}\` is removed`,
		changed: (name, from, to) => [
			...setChanges(`Export \`${name}\``, from.consumers, to.consumers, 'gains consumer', 'loses consumer'),
			...valueChange(`Export \`${name}\` audience`, from.audience, to.audience),
			...valueChange(`Export \`${name}\` version`, from.version, to.version),
		],
	})
	compareKeyed(changes, record(baseline.imports), record(candidate.imports), {
		added: (name, declaration) => `New import \`${name}\` of \`${declaration.app}\`'s export \`${declaration.export}\``,
		removed: (name) => `Import \`${name}\` is removed`,
		changed: (name, from, to) => [
			...setChanges(`Import \`${name}\``, from.procedures, to.procedures, 'gains procedure', 'loses procedure'),
			...setChanges(`Import \`${name}\``, from.usedBy, to.usedBy, 'is used by', 'is no longer used by'),
			...valueChange(`Import \`${name}\``, { ...from, procedures: [], usedBy: [], timeoutMs: null }, {
				...to,
				procedures: [],
				usedBy: [],
				timeoutMs: null,
			}),
		],
	})
	for (const directive of ['connectSrc', 'imgSrc', 'frameAncestors'] as const) {
		compareSet(
			changes,
			baseline.csp[directive].map((source) => source.origin),
			candidate.csp[directive].map((source) => source.origin),
			{
				added: (origin) => widening(`CSP \`${directive}\` allows \`${origin}\``),
				removed: (origin) => removal(`CSP \`${directive}\` no longer allows \`${origin}\``),
			},
		)
	}
	compareKeyed(changes, record(baseline.tables), record(candidate.tables), {
		added: (name, table) => `New table policy \`${name}\` read with \`${table.actions.read}\``,
		removed: (name) => `Table policy \`${name}\` is removed`,
		changed: tableChanges,
	})
}

// ── Endpoints ───────────────────────────────────────────────────────────────────────────────────

function compareEndpoints(changes: Changes, baseline: ContractArtifact, candidate: ContractArtifact): void {
	compareKeyed(changes, endpointMap(baseline.endpoints), endpointMap(candidate.endpoints), {
		added: (id, row) => `New endpoint \`${id}\` (${row.method} ${row.path}) ${audience(row)}`,
		removed: () => [],
		changed: endpointChanges,
	})
	const remaining = endpointMap(candidate.endpoints)
	for (const row of baseline.endpoints) {
		if (remaining.has(row.id)) continue
		// The proxy selects the most specific endpoint, so a removed one may have shadowed a broader one (ADR-0050 §3).
		const reserved = reservedPrefixOf(row.path, candidate.reservedPrefixes)
		const reached = candidate.endpoints.filter((other) =>
			other.method === row.method && pathsOverlap(row.path, other.path) && (reserved === null || other.path.startsWith(`${reserved}/`))
		)
		changes.add(
			reached.length === 0
				? removal(`Endpoint \`${row.id}\` (${row.method} ${row.path}) is removed; its paths are denied`)
				: widening(
					`Endpoint \`${row.id}\` (${row.method} ${row.path}) is removed; its paths now reach ${reached.map((other) => `\`${other.id}\``).join(', ')}`,
				),
		)
	}
}

function endpointChanges(id: string, from: EndpointRow, to: EndpointRow): AccessChange[] {
	const name = `Endpoint \`${id}\``
	return [
		...valueChange(`${name} kind`, from.kind, to.kind),
		...valueChange(`${name} route`, `${from.method} ${from.path}`, `${to.method} ${to.path}`),
		...setChanges(name, from.callers, to.callers, 'gains caller', 'loses caller'),
		...valueChange(`${name} requirement`, from.requirement, to.requirement),
		...admissionChanges(name, from, to),
		...shapeChanges(`${name} output`, from.output, to.output),
	]
}

function admissionChanges(name: string, from: EndpointRow, to: EndpointRow): AccessChange[] {
	const before = from.admission
	const after = to.admission
	if (before === null || after === null) {
		if (before === after) return []
		return [after === null ? removal(`${name} no longer admits a body`) : widening(`${name} admits a body of ${after.contentTypes.join(', ')}`)]
	}
	const bigger = after.maxBytes === null ? before.maxBytes !== null : before.maxBytes !== null && after.maxBytes > before.maxBytes
	const sizeChange = before.maxBytes === after.maxBytes
		? []
		: [(bigger ? widening : removal)(`${name} body limit changes from ${bytes(before.maxBytes)} to ${bytes(after.maxBytes)}`)]
	return [...setChanges(name, before.contentTypes, after.contentTypes, 'admits', 'no longer admits'), ...sizeChange]
}

/** Output fields an endpoint returns: a new field widens, a removed one narrows, any other change widens. */
function shapeChanges(name: string, from: SchemaShape | null, to: SchemaShape | null): AccessChange[] {
	if (from?.type === 'object' && to?.type === 'object') {
		const changes: AccessChange[] = []
		for (const field of union(Object.keys(from.fields), Object.keys(to.fields))) {
			const before = from.fields[field]
			const after = to.fields[field]
			if (before === undefined) changes.push(widening(`${name} gains field \`${field}\``))
			else if (after === undefined) changes.push(removal(`${name} loses field \`${field}\``))
			else changes.push(...shapeChanges(`${name} field \`${field}\``, before, after))
		}
		return changes
	}
	return canonicalJson(from) === canonicalJson(to) ? [] : [widening(`${name} changes`)]
}

/**
 * Whether some path matches both patterns: literal segments must agree, a parameter takes any non-empty segment and a
 * terminal `*` the rest. Reserved prefixes are ignored, so the answer only ever errs towards an overlap.
 */
export function pathsOverlap(a: string, b: string): boolean {
	const left = segmentsOf(a)
	const right = segmentsOf(b)
	for (let index = 0;; index++) {
		const x = left[index]
		const y = right[index]
		if (x === '*' || y === '*') {
			// A non-root wildcard needs a segment at its position, as the matcher's `/x/*` does.
			const other = x === '*' ? y : x
			return index === 0 || other !== undefined
		}
		if (x === undefined || y === undefined) return x === y
		if (x.startsWith(':') && y.startsWith(':')) continue
		if (x.startsWith(':') || y.startsWith(':')) {
			if ((x.startsWith(':') ? y : x) === '') return false
			continue
		}
		if (x !== y) return false
	}
}

/**
 * The longest reserved prefix the pattern lies under by its literal text. Every path it matches lies under that prefix
 * or a longer one, so only endpoints under it compete for those paths.
 */
function reservedPrefixOf(path: string, prefixes: readonly string[]): string | null {
	let longest: string | null = null
	for (const prefix of prefixes) {
		if (path.startsWith(`${prefix}/`) && (longest === null || prefix.length > longest.length)) longest = prefix
	}
	return longest
}

function segmentsOf(path: string): string[] {
	return path === '/' ? [] : path.slice(1).split('/')
}

function audience(row: EndpointRow): string {
	if (row.requirement === null) return `for anonymous ${row.kind} requests`
	const callers = row.callers.join(', ')
	return row.requirement.kind === 'member'
		? `for ${callers} callers who are members`
		: `for ${callers} callers with \`${row.requirement.action}\` (${row.requirement.access.form} \`${row.requirement.access.dimension}\`)`
}

function endpointMap(rows: readonly EndpointRow[]): Map<string, EndpointRow> {
	return new Map(rows.map((row) => [row.id, row]))
}

// ── Roles, files, tables ────────────────────────────────────────────────────────────────────────

function roleChanges(name: string, from: RoleArtifact, to: RoleArtifact): AccessChange[] {
	const role = `Role \`${name}\``
	if (from.member === null || to.member === null || from.member.scope !== to.member.scope) {
		return [
			...setChanges(role, from.grants, to.grants, 'gains', 'loses'),
			...valueChange(`${role} membership`, from.member, to.member),
		]
	}
	return [
		...setChanges(role, from.grants, to.grants, 'gains', 'loses'),
		...setChanges(role, from.member.assignableBy, to.member.assignableBy, 'can be assigned by', 'can no longer be assigned by'),
	]
}

function fileChanges(name: string, from: FileCollectionArtifact, to: FileCollectionArtifact): AccessChange[] {
	const files = `File collection \`${name}\``
	const linkChange = from.link === to.link
		? []
		: [to.link ? widening(`${files} becomes reachable through share links`) : removal(`${files} is no longer reachable through share links`)]
	return [
		...valueChange(`${files} owner`, from.owner, to.owner),
		...valueChange(`${files} read action`, from.read, to.read),
		...valueChange(`${files} write action`, from.write, to.write),
		...valueChange(`${files} delete action`, from.delete, to.delete),
		...limitChange(`${files} size limit`, from.maxBytes, to.maxBytes),
		...limitChange(`${files} limit per owner`, from.maxPerOwner, to.maxPerOwner),
		...setChanges(files, from.types, to.types, 'accepts', 'no longer accepts'),
		...linkChange,
	]
}

function tableChanges(name: string, from: TablePolicyArtifact, to: TablePolicyArtifact): AccessChange[] {
	const table = `Table \`${name}\``
	const columns: AccessChange[] = []
	for (const column of union(Object.keys(from.columns), Object.keys(to.columns))) {
		const before = from.columns[column]
		const after = to.columns[column]
		if (before === undefined && after !== undefined) {
			columns.push(removal(`Column \`${name}.${column}\` is read with \`${after.read}\` instead of \`${from.actions.read}\``))
		} else if (before !== undefined && after === undefined) {
			// Without its own policy the column falls back to the table's read action (ADR-0050 §3).
			columns.push(widening(`Column \`${name}.${column}\` loses its read policy \`${before.read}\` and is read with \`${to.actions.read}\``))
		} else if (before !== undefined && after !== undefined) {
			columns.push(...valueChange(`Column \`${name}.${column}\` read action`, before.read, after.read))
		}
	}
	return [
		...valueChange(`${table} scope`, from.scope, to.scope),
		...valueChange(`${table} read action`, from.actions.read, to.actions.read),
		...valueChange(`${table} insert action`, from.actions.insert, to.actions.insert),
		...valueChange(`${table} update action`, from.actions.update, to.actions.update),
		...valueChange(`${table} delete action`, from.actions.delete, to.actions.delete),
		...setChanges(table, from.insert, to.insert, 'accepts inserts of', 'no longer accepts inserts of'),
		...setChanges(table, from.update, to.update, 'accepts updates of', 'no longer accepts updates of'),
		...valueChange(`${table} version column`, from.version, to.version),
		...valueChange(`${table} creator column`, from.createdBy, to.createdBy),
		...columns,
	]
}

// ── Generic comparisons ─────────────────────────────────────────────────────────────────────────

interface KeyedLines<T> {
	added(key: string, value: T): string
	removed(key: string, value: T): string | readonly AccessChange[]
	changed(key: string, before: T, after: T): readonly AccessChange[]
}

/** A new key widens, a removed key narrows; a key in both is compared by `changed` unless the two are equal. */
function compareKeyed<T>(changes: Changes, before: ReadonlyMap<string, T>, after: ReadonlyMap<string, T>, lines: KeyedLines<T>): void {
	for (const key of union([...before.keys()], [...after.keys()])) {
		const from = before.get(key)
		const to = after.get(key)
		if (from === undefined && to !== undefined) changes.add(widening(lines.added(key, to)))
		else if (from !== undefined && to === undefined) {
			const removed = lines.removed(key, from)
			if (typeof removed === 'string') changes.add(removal(removed))
			else changes.add(...removed)
		} else if (from !== undefined && to !== undefined && canonicalJson(from) !== canonicalJson(to)) changes.add(...lines.changed(key, from, to))
	}
}

function compareSet(
	changes: Changes,
	before: readonly string[],
	after: readonly string[],
	lines: { added(value: string): AccessChange; removed(value: string): AccessChange },
): void {
	for (const value of union(before, after)) {
		if (!before.includes(value)) changes.add(lines.added(value))
		else if (!after.includes(value)) changes.add(lines.removed(value))
	}
}

function setChanges(subject: string, before: readonly string[], after: readonly string[], gains: string, loses: string): AccessChange[] {
	const changes = new Changes()
	compareSet(changes, before, after, {
		added: (value) => widening(`${subject} ${gains} \`${value}\``),
		removed: (value) => removal(`${subject} ${loses} \`${value}\``),
	})
	return changes.list
}

/** Any change of a value the diff does not order widens. */
function valueChange(subject: string, before: unknown, after: unknown): AccessChange[] {
	const from = canonicalJson(before)
	const to = canonicalJson(after)
	return from === to ? [] : [widening(`${subject} changes from ${shown(from)} to ${shown(to)}`)]
}

/** A larger or removed limit widens; a smaller one narrows. `null` is no limit. */
function limitChange(subject: string, before: number | null, after: number | null): AccessChange[] {
	if (before === after) return []
	const larger = after === null || (before !== null && after > before)
	return [(larger ? widening : removal)(`${subject} changes from ${before ?? 'none'} to ${after ?? 'none'}`)]
}

const SHOWN_MAX = 120

function shown(json: string): string {
	return `\`${json.length > SHOWN_MAX ? `${json.slice(0, SHOWN_MAX)}…` : json}\``
}

function bytes(value: number | null): string {
	return value === null ? 'none' : `${value} bytes`
}

function listOf(values: readonly string[], none: string): string {
	return values.length === 0 ? none : values.map((value) => `\`${value}\``).join(', ')
}

function union(a: readonly string[], b: readonly string[]): string[] {
	return [...new Set([...a, ...b])].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))
}

function record<T>(value: Readonly<Record<string, T>>): Map<string, T> {
	return new Map(Object.entries(value))
}

function byName(migrations: AccessSnapshot['migrations']): Map<string, AccessSnapshot['migrations'][number]> {
	return new Map(migrations.map((migration) => [migration.name, migration]))
}

function emptyArtifact(app: string): ContractArtifact {
	return {
		app,
		dimensions: {},
		actions: {},
		roles: {},
		mounts: {},
		files: {},
		jobs: {},
		exports: {},
		imports: {},
		csp: { connectSrc: [], imgSrc: [], frameAncestors: [] },
		tables: {},
		endpoints: [],
		reservedPrefixes: [],
	}
}
