// The conservative classification of an access change (ADR-0050 §3). Pure: it compares the candidate snapshot with the
// environment's active one and answers plain-language lines for the approver. Anything it cannot show to narrow
// access widens it.

import {
	type AttachmentShape,
	canonicalizeArtifact,
	canonicalJson,
	type ColumnPolicyArtifact,
	type ContractArtifact,
	type DeclaredReach,
	type DimensionArtifact,
	type EndpointDirectory,
	endpointMembers,
	type EndpointRow,
	type FileCollectionArtifact,
	isAttachmentShape,
	JOB_SITE_PREFIX,
	type MountArtifact,
	type NumberShape,
	type OutputShape,
	type RoleArtifact,
	type SchemaShape,
	type StringShape,
	type TablePolicyArtifact,
} from '@fabrika/auth-core'
import type { MigrationDeviation } from '@fabrika/platform-node/sql'
import { type AccessSnapshot, deviationKey } from './snapshot'

/**
 * One plain-language line; `widens` when the change can grant access the baseline did not. `review: 'closer'` marks a
 * step off the paved road (declared reach, database code) or a change the diff cannot classify: the approver reads the
 * code behind it, not only the line.
 */
export interface AccessChange {
	readonly widens: boolean
	readonly line: string
	readonly review?: 'closer'
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
	compareDatabaseCode(changes, baseline, candidate)
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
const closerWidening = (line: string): AccessChange => ({ widens: true, line, review: 'closer' })

function compareContracts(changes: Changes, before: ContractArtifact | null, after: ContractArtifact | null): void {
	if (before === null && after === null) return
	if (after === null) {
		changes.add(widening('The contract is removed: the proxy no longer applies an endpoint table to this application'))
		return
	}
	const candidate = canonicalizeArtifact(after)
	const baseline = before === null ? emptyArtifact(candidate) : canonicalizeArtifact(before)
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
		changed: dimensionChanges,
	})
	for (const [name, dimension] of Object.entries(candidate.dimensions)) {
		if (!Object.hasOwn(baseline.dimensions, name)) changes.add(...directoryChange(name, undefined, dimension.directory))
	}
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
		changed: mountChanges,
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
	for (const directive of ['connectSrc', 'imgSrc', 'frameAncestors', 'scriptSrc', 'frameSrc'] as const) {
		compareSet(
			changes,
			(baseline.csp[directive] ?? []).map((source) => source.origin),
			(candidate.csp[directive] ?? []).map((source) => source.origin),
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
	compareDeclared(changes, baseline.declared, candidate.declared)
	compareDirectories(changes, baseline, candidate)
}

// ── Member directories ──────────────────────────────────────────────────────────────────────────

type Directories = Readonly<Record<string, EndpointDirectory>>

/**
 * The directory reach of the baseline: what it records, or, for an artifact compiled before it recorded any, the one
 * reach the runtime gave then: `list()` of an endpoint whose action is its own dimension's `members.list`.
 */
function baselineDirectories(artifact: ContractArtifact): Directories {
	if (artifact.directories !== undefined) return artifact.directories
	const implied: Record<string, EndpointDirectory> = {}
	for (const row of artifact.endpoints) {
		if (row.requirement?.kind === 'action' && endpointMembers(artifact, row) === 'list') {
			implied[row.id] = { dimension: row.requirement.access.dimension, lists: true }
		}
	}
	return implied
}

/**
 * The member directory each endpoint reads. A new reach widens: an endpoint that looks a member up learns whether a
 * person it names is a member, one that lists learns them all; where the dimension shows labels, the approver reads
 * the code behind it, because a label spells an email address. A removed reach narrows.
 */
function compareDirectories(changes: Changes, baseline: ContractArtifact, candidate: ContractArtifact): void {
	const before = baselineDirectories(baseline)
	const after = candidate.directories ?? {}
	const reachOf = (reach: EndpointDirectory): string =>
		reach.lists ? `lists the members of \`${reach.dimension}\`` : `looks up one member of \`${reach.dimension}\``
	for (const endpoint of union(Object.keys(before), Object.keys(after))) {
		const from = before[endpoint]
		const to = after[endpoint]
		if (to === undefined) {
			if (from !== undefined) changes.add(removal(`Endpoint \`${endpoint}\` no longer reads the members of \`${from.dimension}\``))
			continue
		}
		if (from !== undefined && from.dimension === to.dimension && (from.lists || !to.lists)) {
			if (from.lists && !to.lists) changes.add(removal(`Endpoint \`${endpoint}\` no longer lists the members of \`${to.dimension}\``))
			continue
		}
		const labels = candidate.dimensions[to.dimension]?.directory === 'labels'
		changes.add(
			labels
				? closerWidening(`Endpoint \`${endpoint}\` ${reachOf(to)}, with their labels, which spell users' email addresses`)
				: widening(`Endpoint \`${endpoint}\` ${reachOf(to)}`),
		)
	}
}

// ── Steps off the paved road ────────────────────────────────────────────────────────────────────

/**
 * The reach each site declares (`sql`, `unscoped`, `connect`, link issuing). A site is keyed by its endpoint id or job,
 * so a handler that moves keeps its site; each effect is compared on its own. A new site, table, connector or mount and
 * `read` → `write` widen with closer review; a removal and `write` → `read` narrow.
 */
function compareDeclared(
	changes: Changes,
	before: Readonly<Record<string, DeclaredReach>> | undefined,
	after: Readonly<Record<string, DeclaredReach>> | undefined,
): void {
	if (before !== undefined && after === undefined) {
		// A `defineContract` contract records no reach: its sites reach what the handlers say, unreviewed.
		changes.add(closerWidening("The contract leaves the staged kit: its sites' reach off the paved road is no longer declared"))
		return
	}
	if (after === undefined) return
	if (before === undefined) changes.add(removal('The contract moves to the staged kit: each site reaches only what it declares'))
	const sites = before ?? {}
	for (const site of union(Object.keys(sites), Object.keys(after))) {
		changes.add(...reachChanges(site, sites[site] ?? NO_REACH, after[site] ?? NO_REACH))
	}
}

const NO_REACH: DeclaredReach = { sql: null, unscoped: {}, connect: [], issues: null }

function reachChanges(site: string, from: DeclaredReach, to: DeclaredReach): AccessChange[] {
	const name = siteName(site)
	const changes: AccessChange[] = [...modeChange(name, 'raw SQL', from.sql, to.sql)]
	for (const table of union(Object.keys(from.unscoped), Object.keys(to.unscoped))) {
		changes.push(...modeChange(name, `table \`${table}\` unscoped`, from.unscoped[table] ?? null, to.unscoped[table] ?? null))
	}
	for (const connector of union(from.connect, to.connect)) {
		if (!from.connect.includes(connector)) changes.push(closerWidening(`${name} calls connector \`${connector}\``))
		else if (!to.connect.includes(connector)) changes.push(removal(`${name} no longer calls connector \`${connector}\``))
	}
	if (from.issues !== to.issues) {
		if (to.issues !== null) changes.push(closerWidening(`${name} issues share links of mount \`${to.issues}\``))
		if (from.issues !== null) changes.push(removal(`${name} no longer issues share links of mount \`${from.issues}\``))
	}
	return changes
}

/** `null` is undeclared; `write` reaches more than `read`. */
function modeChange(name: string, reach: string, from: 'read' | 'write' | null, to: 'read' | 'write' | null): AccessChange[] {
	if (from === to) return []
	if (to === null) return [removal(`${name} no longer declares ${reach}`)]
	if (from === null) return [closerWidening(declaredLine(name, reach, to))]
	return [
		to === 'write'
			? closerWidening(`${name} ${reach} changes from \`read\` to \`write\``)
			: removal(`${name} ${reach} changes from \`write\` to \`read\``),
	]
}

function declaredLine(name: string, reach: string, mode: 'read' | 'write'): string {
	return `${name} declares ${reach} (\`${mode}\`)`
}

function siteName(site: string): string {
	return site.startsWith(JOB_SITE_PREFIX) ? `Job \`${site.slice(JOB_SITE_PREFIX.length)}\`` : `Endpoint \`${site}\``
}

/**
 * The database code the migrations declare, keyed by file, kind and object. New code widens with closer review, and so
 * does code in a file whose text changed, since the diff cannot tell what changed in it; removed code narrows.
 */
function compareDatabaseCode(changes: Changes, baseline: AccessSnapshot, candidate: AccessSnapshot): void {
	const before = new Map((baseline.databaseCode ?? []).map((deviation) => [deviationKey(deviation), deviation]))
	const after = new Map((candidate.databaseCode ?? []).map((deviation) => [deviationKey(deviation), deviation]))
	const beforeFiles = byName(baseline.migrations)
	const afterFiles = byName(candidate.migrations)
	for (const key of union([...before.keys()], [...after.keys()])) {
		const from = before.get(key)
		const to = after.get(key)
		if (to === undefined) {
			if (from !== undefined) changes.add(removal(`Migration \`${from.file}\` no longer declares ${databaseObject(from)}`))
		} else if (from === undefined) changes.add(closerWidening(databaseCodeLine(to)))
		else if (beforeFiles.get(to.file)?.checksum !== afterFiles.get(to.file)?.checksum) {
			changes.add(closerWidening(`Migration \`${to.file}\` changes, and declares ${databaseObject(to)}`))
		}
	}
}

function databaseCodeLine(deviation: MigrationDeviation): string {
	return `Migration \`${deviation.file}\` declares ${databaseObject(deviation)}`
}

function databaseObject(deviation: MigrationDeviation): string {
	if (deviation.kind === 'do') return `a \`DO\` block (\`${deviation.object}\`)`
	if (deviation.kind === 'expression') return `an expression that calls database code (\`${deviation.object}\`)`
	return `${deviation.kind} \`${deviation.object}\``
}

/**
 * Every step off the paved road a snapshot holds, one line each: the reach its sites declare and the database code its
 * migrations declare. Each needs closer review; the environment page lists them for the published snapshot.
 */
export function snapshotDeviations(snapshot: AccessSnapshot): string[] {
	const sites = Object.entries(snapshot.contract?.declared ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	return [
		...sites.flatMap(([site, reach]) => reachChanges(site, NO_REACH, reach).map((change) => change.line)),
		...(snapshot.databaseCode ?? []).map(databaseCodeLine),
	]
}

// ── Endpoints ───────────────────────────────────────────────────────────────────────────────────

function compareEndpoints(changes: Changes, baseline: ContractArtifact, candidate: ContractArtifact): void {
	compareKeyed(changes, endpointMap(baseline.endpoints), endpointMap(candidate.endpoints), {
		added: (id, row) => `New endpoint \`${id}\` (${row.method} ${row.path}) ${audience(row)}${answersFile(row)}`,
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
	const becomesPublic = from.requirement !== null && to.kind === 'public-spa'
	return [
		...(becomesPublic ? [widening(`${name} becomes public: anyone opens it without signing in`)] : []),
		...valueChange(`${name} kind`, from.kind, to.kind),
		...valueChange(`${name} route`, `${from.method} ${from.path}`, `${to.method} ${to.path}`),
		...setChanges(name, from.callers, to.callers, 'gains caller', 'loses caller'),
		...valueChange(`${name} requirement`, from.requirement, to.requirement),
		...admissionChanges(name, from, to),
		...schemaChanges({ endpoint: name, side: 'input', path: '' }, from.input, to.input),
		...outputChanges(name, from.output, to.output),
	]
}

/** `, answering the file …` for an endpoint whose output is an attachment: the approver sees that data leaves as a file. */
function answersFile(row: EndpointRow): string {
	return row.output !== null && isAttachmentShape(row.output)
		? `, answering the ${row.output.format.toUpperCase()} file \`${row.output.filename}\``
		: ''
}

/**
 * An output: two schemas compare as schemas; two attachments by their limits and columns; a change between a JSON
 * answer and a file widens. A file's name and its column order grant nothing, so they narrow at most.
 */
function outputChanges(name: string, from: OutputShape | null, to: OutputShape | null): AccessChange[] {
	if (from !== null && isAttachmentShape(from) && to !== null && isAttachmentShape(to)) {
		return attachmentChanges(name, from, to)
	}
	if ((from === null || !isAttachmentShape(from)) && (to === null || !isAttachmentShape(to))) {
		return schemaChanges({ endpoint: name, side: 'output', path: '' }, from, to)
	}
	return [widening(`${name} output changes from ${outputKind(from)} to ${outputKind(to)}`)]
}

function outputKind(shape: OutputShape | null): string {
	if (shape === null) return 'none'
	return isAttachmentShape(shape) ? `the ${shape.format.toUpperCase()} file \`${shape.filename}\`` : 'JSON'
}

function attachmentChanges(name: string, from: AttachmentShape, to: AttachmentShape): AccessChange[] {
	const file = `${name} file`
	const renamed = from.filename === to.filename ? [] : [removal(`${file} name changes from \`${from.filename}\` to \`${to.filename}\``)]
	const columns = (shape: AttachmentShape) => Object.fromEntries(shape.columns.map((column) => [column.name, column.shape]))
	return [
		...valueChange(`${file} format`, from.format, to.format),
		...renamed,
		...limitChange(`${file} size limit`, from.maxBytes, to.maxBytes),
		...limitChange(`${file} row limit`, from.maxRows, to.maxRows),
		...fieldChanges({ endpoint: name, side: 'output', path: '' }, columns(from), columns(to)),
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

// ── Schemas ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Where a schema change lies: the endpoint, its input or output, and the field path (`items[].stage`). The two sides
 * differ only for a removed required field: an input without it was refused before, an output without it tells less.
 */
interface SchemaSite {
	readonly endpoint: string
	readonly side: 'input' | 'output'
	readonly path: string
}

function siteLabel(site: SchemaSite): string {
	return site.path === '' ? `${site.endpoint} ${site.side}` : `${site.endpoint} ${site.side} \`${site.path}\``
}

function fieldSite(site: SchemaSite, field: string): SchemaSite {
	return { ...site, path: site.path === '' ? field : `${site.path}.${field}` }
}

function itemsSite(site: SchemaSite): SchemaSite {
	return { ...site, path: `${site.path}[]` }
}

/**
 * The values a schema admits, compared structurally: a change that can only admit fewer values narrows, any other
 * change widens. No logical implication between schemas is attempted, so an equivalent rewrite widens too.
 */
function schemaChanges(site: SchemaSite, from: SchemaShape | null, to: SchemaShape | null): AccessChange[] {
	if (canonicalJson(from) === canonicalJson(to)) return []
	if (from === null || to === null) return valueChange(siteLabel(site), from, to)
	const before = unwrapped(from)
	const after = unwrapped(to)
	const label = siteLabel(site)
	return [
		...flagChange(before.optional, after.optional, widening(`${label} becomes optional`), removal(`${label} becomes required`)),
		...flagChange(before.nullable, after.nullable, widening(`${label} admits null`), removal(`${label} no longer admits null`)),
		...coreChanges(site, before.core, after.core),
	]
}

interface Unwrapped {
	readonly optional: boolean
	readonly nullable: boolean
	readonly core: SchemaShape
}

function unwrapped(shape: SchemaShape): Unwrapped {
	let optional = false
	let nullable = false
	let core = shape
	for (;;) {
		if (core.type === 'optional') optional = true
		else if (core.type === 'nullable') nullable = true
		else return { optional, nullable, core }
		core = core.inner
	}
}

function flagChange(before: boolean, after: boolean, gained: AccessChange, lost: AccessChange): AccessChange[] {
	return before === after ? [] : [after ? gained : lost]
}

function coreChanges(site: SchemaSite, from: SchemaShape, to: SchemaShape): AccessChange[] {
	if (canonicalJson(from) === canonicalJson(to)) return []
	const label = siteLabel(site)
	const fromValues = finiteValues(from)
	const toValues = finiteValues(to)
	if (fromValues !== null && toValues !== null) return valueSetChanges(label, fromValues, toValues)
	if (from.type === 'object' && to.type === 'object') return fieldChanges(site, from.fields, to.fields)
	if (from.type === 'string' && to.type === 'string') return stringChanges(label, from, to)
	if (from.type === 'number' && to.type === 'number') return numberChanges(label, from, to)
	if (from.type === 'array' && to.type === 'array') {
		return [
			...lowerLimitChange(`${label} minimum items`, from.minItems, to.minItems),
			...limitChange(`${label} maximum items`, from.maxItems, to.maxItems),
			...schemaChanges(itemsSite(site), from.items, to.items),
		]
	}
	// Every union change widens, a removed or reordered option too: the first option that accepts a value decides what
	// projection keeps of it, so another option can pass on fields the old one stripped.
	return valueChange(label, from, to)
}

function fieldChanges(site: SchemaSite, from: Readonly<Record<string, SchemaShape>>, to: Readonly<Record<string, SchemaShape>>): AccessChange[] {
	const label = siteLabel(site)
	const changes: AccessChange[] = []
	for (const field of union(Object.keys(from), Object.keys(to))) {
		const before = from[field]
		const after = to[field]
		if (before === undefined) changes.push(widening(`${label} gains field \`${field}\``))
		else if (after === undefined) {
			const required = site.side === 'input' && !unwrapped(before).optional
			changes.push(required ? widening(`${label} loses required field \`${field}\``) : removal(`${label} loses field \`${field}\``))
		} else changes.push(...schemaChanges(fieldSite(site, field), before, after))
	}
	return changes
}

/** The values of a literal or an enum, as canonical JSON; `null` for a schema that admits more than a listed set. */
function finiteValues(shape: SchemaShape): string[] | null {
	if (shape.type === 'literal') return [canonicalJson(shape.value)]
	if (shape.type === 'enum') return shape.values.map((value) => canonicalJson(value))
	return null
}

function valueSetChanges(label: string, from: readonly string[], to: readonly string[]): AccessChange[] {
	const changes = new Changes()
	compareSet(changes, from, to, {
		added: (value) => widening(`${label} admits ${shownValue(value)}`),
		removed: (value) => removal(`${label} no longer admits ${shownValue(value)}`),
	})
	return changes.list
}

function stringChanges(label: string, from: StringShape, to: StringShape): AccessChange[] {
	return [
		...constraintChange(`${label} format`, from.format, to.format),
		...lowerLimitChange(`${label} minimum length`, from.minLength, to.minLength),
		...limitChange(`${label} maximum length`, from.maxLength, to.maxLength),
		...constraintChange(`${label} pattern`, from.pattern, to.pattern),
		...constraintChange(`${label} prefix`, from.startsWith, to.startsWith),
		...constraintChange(`${label} suffix`, from.endsWith, to.endsWith),
		...constraintChange(`${label} required substring`, from.includes, to.includes),
	]
}

function numberChanges(label: string, from: NumberShape, to: NumberShape): AccessChange[] {
	const integer = flagChange(from.int, to.int, removal(`${label} admits only integers`), widening(`${label} admits non-integers`))
	return [
		...integer,
		...boundChange(`${label} minimum`, { value: from.min, exclusive: from.exclusiveMin }, { value: to.min, exclusive: to.exclusiveMin }, 1),
		...boundChange(`${label} maximum`, { value: from.max, exclusive: from.exclusiveMax }, { value: to.max, exclusive: to.exclusiveMax }, -1),
		...constraintChange(`${label} multiple`, from.multipleOf, to.multipleOf),
	]
}

/** A constraint added where there was none narrows; any other change of it widens. */
function constraintChange(subject: string, before: string | number | null, after: string | number | null): AccessChange[] {
	if (before === after) return []
	return [
		(before === null ? removal : widening)(`${subject} changes from ${shownValue(canonicalJson(before))} to ${shownValue(canonicalJson(after))}`),
	]
}

interface Bound {
	readonly value: number | null
	readonly exclusive: boolean
}

/**
 * A numeric bound: `direction` is 1 for a minimum (a higher one narrows) and -1 for a maximum. At the same value an
 * exclusive bound is the tighter one.
 */
function boundChange(subject: string, before: Bound, after: Bound, direction: 1 | -1): AccessChange[] {
	if (before.value === after.value && before.exclusive === after.exclusive) return []
	const tighter = after.value !== null && (before.value === null || (after.value - before.value) * direction > 0
		|| (after.value === before.value && after.exclusive))
	return [(tighter ? removal : widening)(`${subject} changes from ${boundText(before)} to ${boundText(after)}`)]
}

function boundText(bound: Bound): string {
	return bound.value === null ? 'none' : `${bound.value}${bound.exclusive ? ' (exclusive)' : ''}`
}

/** A higher minimum narrows; a lower or removed one widens. `null` is no limit. */
function lowerLimitChange(subject: string, before: number | null, after: number | null): AccessChange[] {
	if (before === after) return []
	const higher = after !== null && (before === null || after > before)
	return [(higher ? removal : widening)(`${subject} changes from ${before ?? 'none'} to ${after ?? 'none'}`)]
}

/** A string value bare, any other JSON value as written. */
function shownValue(json: string): string {
	const value: unknown = JSON.parse(json)
	return typeof value === 'string' ? `\`${value}\`` : shown(json)
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
	if (row.kind === 'public-spa') return 'for anyone, without signing in'
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
	// Without scanning, an upload is served the moment it is written.
	const scanChange = (from.scan === true) === (to.scan === true)
		? []
		: [
			to.scan === true ? removal(`${files} scans every upload for malware before serving it`) : widening(`${files} stops scanning uploads for malware`),
		]
	return [
		...valueChange(`${files} owner`, from.owner, to.owner),
		...valueChange(`${files} read action`, from.read, to.read),
		...valueChange(`${files} write action`, from.write, to.write),
		...valueChange(`${files} delete action`, from.delete, to.delete),
		...limitChange(`${files} size limit`, from.maxBytes, to.maxBytes),
		...limitChange(`${files} limit per owner`, from.maxPerOwner, to.maxPerOwner),
		...setChanges(files, from.types, to.types, 'accepts', 'no longer accepts'),
		...linkChange,
		...scanChange,
	]
}

function tableChanges(name: string, from: TablePolicyArtifact, to: TablePolicyArtifact): AccessChange[] {
	const table = `Table \`${name}\``
	const columns: AccessChange[] = []
	for (const column of union(Object.keys(from.columns), Object.keys(to.columns))) {
		const subject = `Column \`${name}.${column}\``
		const before: ColumnPolicyArtifact = from.columns[column] ?? {}
		const after: ColumnPolicyArtifact = to.columns[column] ?? {}
		if (before.read === undefined && after.read !== undefined) {
			columns.push(removal(`${subject} is read with \`${after.read}\` instead of \`${from.actions.read}\``))
		} else if (before.read !== undefined && after.read === undefined) {
			// Without its own policy the column falls back to the table's read action (ADR-0050 §3).
			columns.push(widening(`${subject} loses its read policy \`${before.read}\` and is read with \`${to.actions.read}\``))
		} else if (before.read !== undefined && after.read !== undefined) {
			columns.push(...valueChange(`${subject} read action`, before.read, after.read))
		}
		// A column's own write action is one more action that updates the table; the update list's lines cover the rest.
		if (before.write === undefined && after.write !== undefined) {
			columns.push(widening(`${subject} is updated with its own write action \`${after.write}\``))
		} else if (before.write !== undefined && after.write === undefined) {
			columns.push(removal(`${subject} is no longer updated with its own write action \`${before.write}\``))
		} else if (before.write !== undefined && after.write !== undefined) {
			columns.push(...valueChange(`${subject} write action`, before.write, after.write))
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

function dimensionChanges(name: string, from: DimensionArtifact, to: DimensionArtifact): AccessChange[] {
	const { directory: before, ...fromRest } = from
	const { directory: after, ...toRest } = to
	return [...valueChange(`Dimension \`${name}\``, fromRest, toRest), ...directoryChange(name, before, after)]
}

/**
 * A directory that shows labels lets every `members.list` holder read each member's label, which spells an address, and
 * every endpoint on, in or below the dimension read the label of a member it looks up (`ctx.members.get`).
 */
function directoryChange(name: string, before: 'labels' | undefined, after: 'labels' | undefined): AccessChange[] {
	if (before === after) return []
	return after === 'labels'
		? [
			closerWidening(
				`Holders of the members.list action of \`${name}\` see each member's label, and every endpoint on, in or below \`${name}\` reads the label of a member it looks up; a label spells a user's email address`,
			),
		]
		: [removal(`Holders of the members.list action of \`${name}\` and the endpoints below \`${name}\` no longer see member labels`)]
}

/**
 * A form's `then` reaches only a job of the same approved contract, which runs under its own declared actions and
 * coalesces on its lease, so a change of it alone widens nothing. The rest of a mount is compared as a value.
 */
function mountChanges(name: string, from: MountArtifact, to: MountArtifact): AccessChange[] {
	if (from.kind !== 'form' || to.kind !== 'form') return valueChange(`Mount \`${name}\``, from, to)
	const { then: before, ...fromRest } = from
	const { then: after, ...toRest } = to
	return [...valueChange(`Mount \`${name}\``, fromRest, toRest), ...kickChange(name, before, after)]
}

function kickChange(name: string, before: string | undefined, after: string | undefined): AccessChange[] {
	if (before === after) return []
	const line = after === undefined
		? `Form \`${name}\` no longer starts job \`${before}\` after a submission`
		: `Form \`${name}\` starts job \`${after}\` after each accepted submission, beside its schedule`
	return [{ widens: false, line }]
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

/** The baseline of a first contract; a staged-kit candidate is compared with sites that declare nothing. */
function emptyArtifact(candidate: ContractArtifact): ContractArtifact {
	return {
		app: candidate.app,
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
		...(candidate.declared === undefined ? {} : { declared: {} }),
	}
}
