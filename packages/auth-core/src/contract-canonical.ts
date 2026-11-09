// The canonical form of a contract artifact. Two producers (`compileContract`, the static reader) and every digest
// over an artifact must agree byte for byte, so declaration order may not leak into it.

import type {
	BodyAdmission,
	Caller,
	ColumnTestArtifact,
	ConditionArtifact,
	ConditionLiteralArtifact,
	ConfersArtifact,
	ContractArtifact,
	CspSource,
	EndpointRow,
	MemberRevealsArtifact,
	MountArtifact,
	OutputShape,
	RevealsArtifact,
	RoleArtifact,
	SchemaShape,
	TableActionArtifact,
	TablePolicyArtifact,
} from './contract'

/**
 * The artifact with every array whose order carries no meaning sorted: endpoints by id, and every list of names.
 * Tuple items and union options keep their order, because it changes what a schema admits. Object keys are left
 * as they are; `canonicalArtifactJson` sorts them.
 */
export function canonicalizeArtifact(artifact: ContractArtifact): ContractArtifact {
	return {
		format: artifact.format,
		app: artifact.app,
		dimensions: artifact.dimensions,
		actions: artifact.actions,
		roles: mapValues(artifact.roles, canonicalRole),
		...(artifact.relations === undefined ? {} : { relations: artifact.relations }),
		mounts: mapValues(artifact.mounts, canonicalMount),
		files: mapValues(artifact.files, (collection) => ({
			...collection,
			types: sorted(collection.types),
			link: typeof collection.link === 'boolean' ? collection.link : sorted(collection.link),
		})),
		...(artifact.fileKinds === undefined
			? {}
			: { fileKinds: mapValues(artifact.fileKinds, (kind) => ({ ...kind, types: sorted(kind.types) })) }),
		jobs: mapValues(artifact.jobs, (job) => ({ ...job, actions: sorted(job.actions) })),
		exports: mapValues(artifact.exports, (declaration) => ({ ...declaration, consumers: sorted(declaration.consumers) })),
		imports: mapValues(artifact.imports, (declaration) => ({
			...declaration,
			procedures: sorted(declaration.procedures),
			usedBy: sorted(declaration.usedBy),
		})),
		csp: {
			connectSrc: sortedSources(artifact.csp.connectSrc),
			imgSrc: sortedSources(artifact.csp.imgSrc),
			frameAncestors: sortedSources(artifact.csp.frameAncestors),
			...(artifact.csp.scriptSrc === undefined ? {} : { scriptSrc: sortedSources(artifact.csp.scriptSrc) }),
			...(artifact.csp.frameSrc === undefined ? {} : { frameSrc: sortedSources(artifact.csp.frameSrc) }),
			...(artifact.csp.styleSrc === undefined ? {} : { styleSrc: sortedSources(artifact.csp.styleSrc) }),
			...(artifact.csp.fontSrc === undefined ? {} : { fontSrc: sortedSources(artifact.csp.fontSrc) }),
			...(artifact.csp.workerSrc === undefined ? {} : { workerSrc: sortedSources(artifact.csp.workerSrc) }),
		},
		tables: mapValues(artifact.tables, canonicalTable),
		endpoints: artifact.endpoints.map(canonicalizeEndpoint).sort((a, b) => compare(a.id, b.id)),
		reservedPrefixes: sorted(artifact.reservedPrefixes),
		...(artifact.declared === undefined
			? {}
			: {
				declared: mapValues(artifact.declared, (reach) => ({
					...reach,
					connect: sorted(reach.connect),
					...(reach.actions === undefined ? {} : { actions: sorted(reach.actions) }),
					...(reach.kicks === undefined ? {} : { kicks: sorted(reach.kicks) }),
					...(reach.signs === undefined ? {} : { signs: sorted(reach.signs) }),
					...(reach.egress === undefined ? {} : { egress: sorted(reach.egress) }),
				})),
			}),
		...(artifact.directories === undefined ? {} : { directories: artifact.directories }),
		...(artifact.locale === undefined ? {} : { locale: artifact.locale }),
		...(artifact.displayName === undefined ? {} : { displayName: artifact.displayName }),
		...(artifact.mail === undefined ? {} : { mail: artifact.mail }),
		...(artifact.members === undefined ? {} : { members: artifact.members }),
		...(artifact.directory === undefined ? {} : { directory: artifact.directory }),
		...(artifact.terminal === undefined ? {} : { terminal: { identify: artifact.terminal.identify } }),
		...(artifact.procedures === undefined
			? {}
			: {
				procedures: mapValues(artifact.procedures, (rules) => rules.query === undefined ? rules : { ...rules, query: canonicalShape(rules.query) }),
			}),
		...(artifact.tokens === undefined
			? {}
			: { tokens: mapValues(artifact.tokens, (purpose) => ({ claims: canonicalShape(purpose.claims), maxDays: purpose.maxDays })) }),
	}
}

/** The canonical artifact as JSON with every object's keys sorted: the bytes a digest of the artifact is taken over. */
export function canonicalArtifactJson(artifact: ContractArtifact): string {
	return canonicalJson(canonicalizeArtifact(artifact))
}

/** JSON with every object's keys sorted. Arrays keep their order; canonicalize them first. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(value, sortKeys)
}

function canonicalRole(role: RoleArtifact): RoleArtifact {
	return {
		grants: sorted(role.grants),
		member: role.member === null ? null : { scope: role.member.scope, assignableBy: sorted(role.member.assignableBy) },
		...(role.external === true ? { external: true } : {}),
		...(role.via === undefined ? {} : { via: mapValues(role.via, sorted) }),
	}
}

function canonicalMount(mount: MountArtifact): MountArtifact {
	switch (mount.kind) {
		case 'rpc':
			return { ...mount, callers: sorted(mount.callers) }
		case 'link':
			return { ...mount, grants: sorted(mount.grants) }
		case 'webhook':
			return { ...mount, actions: sorted(mount.actions) }
		case 'spa':
			return mount.public === undefined ? mount : { ...mount, public: sorted(mount.public) }
		default:
			return mount
	}
}

/** Each action of one table operation, `[]` for none: how a reader of the artifact reads `actions.read` and the others. */
export function tableActions(actions: TableActionArtifact | null): readonly string[] {
	if (actions === null) {
		return []
	}
	return typeof actions === 'string' ? [actions] : actions
}

/** A list of actions sorted; one action as it is. */
function canonicalActions(actions: TableActionArtifact): TableActionArtifact {
	return typeof actions === 'string' ? actions : sorted(actions)
}

function canonicalOptionalActions(actions: TableActionArtifact | null): TableActionArtifact | null {
	return actions === null ? null : canonicalActions(actions)
}

function canonicalTable(table: TablePolicyArtifact): TablePolicyArtifact {
	const { appRead, appCount } = table.actions
	return {
		...table,
		actions: {
			read: canonicalActions(table.actions.read),
			insert: canonicalOptionalActions(table.actions.insert),
			update: canonicalOptionalActions(table.actions.update),
			delete: canonicalOptionalActions(table.actions.delete),
			...(appRead === undefined ? {} : { appRead: sorted(appRead) }),
			...(appCount === undefined ? {} : { appCount: sorted(appCount) }),
		},
		scope: table.scope.mode === 'child' ? { ...table.scope, inherit: sorted(table.scope.inherit) } : table.scope,
		insert: sorted(table.insert),
		update: sorted(table.update),
		...(table.when === undefined ? {} : { when: mapValues(table.when, canonicalCondition) }),
		...(table.confers === undefined ? {} : { confers: mapValues(table.confers, canonicalConfers) }),
		...(table.reveals === undefined ? {} : { reveals: mapValues(table.reveals, canonicalReveals) }),
		...(table.memberReveals === undefined ? {} : { memberReveals: mapValues(table.memberReveals, canonicalMemberReveals) }),
	}
}

function canonicalConfers(confers: ConfersArtifact): ConfersArtifact {
	return confers.when === undefined ? confers : { ...confers, when: canonicalCondition(confers.when) }
}

function canonicalReveals(reveals: RevealsArtifact): RevealsArtifact {
	return {
		...reveals,
		actions: sorted(reveals.actions),
		...(reveals.when === undefined ? {} : { when: canonicalCondition(reveals.when) }),
	}
}

function canonicalMemberReveals(reveals: MemberRevealsArtifact): MemberRevealsArtifact {
	return {
		...reveals,
		actions: sorted(reveals.actions),
		...(reveals.when === undefined ? {} : { when: canonicalCondition(reveals.when) }),
	}
}

/**
 * A condition with its connectives' operands and its `in` / `notIn` lists sorted by their canonical JSON: AND and OR
 * commute and a list is a set, so neither order changes which rows it admits.
 */
export function canonicalCondition(condition: ConditionArtifact): ConditionArtifact {
	if ('allOf' in condition && isConditionList(condition.allOf)) {
		return { allOf: sortedConditions(condition.allOf) }
	}
	if ('anyOf' in condition && isConditionList(condition.anyOf)) {
		return { anyOf: sortedConditions(condition.anyOf) }
	}
	if ('not' in condition && isCondition(condition.not)) {
		return { not: canonicalCondition(condition.not) }
	}
	if ('some' in condition && isConditionRecord(condition.some)) {
		return { some: mapValues(condition.some, canonicalCondition) }
	}
	if ('none' in condition && isConditionRecord(condition.none)) {
		return { none: mapValues(condition.none, canonicalCondition) }
	}
	const tests: Record<string, ColumnTestArtifact> = {}
	for (const [path, test] of Object.entries(condition)) {
		// A parsed artifact holds nothing else here; dropping an unknown test would widen what the condition admits.
		if (!isColumnTest(test)) throw new Error(`the condition test of ${path} is not a column test`)
		tests[path] = canonicalTest(test)
	}
	return tests
}

function canonicalTest(test: ColumnTestArtifact): ColumnTestArtifact {
	return {
		...test,
		...(test.in === undefined ? {} : { in: sortedLiterals(test.in) }),
		...(test.notIn === undefined ? {} : { notIn: sortedLiterals(test.notIn) }),
	}
}

function sortedConditions(conditions: readonly ConditionArtifact[]): ConditionArtifact[] {
	return conditions.map(canonicalCondition).sort((a, b) => compare(canonicalJson(a), canonicalJson(b)))
}

function sortedLiterals(values: readonly ConditionLiteralArtifact[]): ConditionLiteralArtifact[] {
	return [...values].sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)))
}

function isCondition(value: unknown): value is ConditionArtifact {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isConditionRecord(value: unknown): value is Readonly<Record<string, ConditionArtifact>> {
	return isCondition(value) && Object.values(value).every(isCondition)
}

function isConditionList(value: unknown): value is readonly ConditionArtifact[] {
	return Array.isArray(value) && value.every(isCondition)
}

const COLUMN_TEST_OPERATORS: ReadonlySet<string> = new Set(['eq', 'notEq', 'in', 'notIn', 'isNull', 'lt', 'lte', 'gt', 'gte'])

function isColumnTest(value: unknown): value is ColumnTestArtifact {
	return isCondition(value) && Object.keys(value).every((operator) => COLUMN_TEST_OPERATORS.has(operator))
}

function canonicalizeEndpoint(row: EndpointRow): EndpointRow {
	const shared = {
		admission: row.admission === null ? null : canonicalAdmission(row.admission),
		input: row.input === null ? null : canonicalShape(row.input),
		output: row.output === null ? null : canonicalOutput(row.output),
	}
	if (row.requirement === null) {
		return { ...row, ...shared }
	}
	return { ...row, ...shared, callers: sortedTuple<Caller>(row.callers) }
}

/** A body admission with its content types sorted. */
export function canonicalAdmission(admission: BodyAdmission): BodyAdmission {
	return { contentTypes: sortedTuple(admission.contentTypes), maxBytes: admission.maxBytes }
}

/** An output shape: an attachment keeps its column order, which is the file's; each column's shape is canonical. */
export function canonicalOutput(shape: OutputShape): OutputShape {
	if (shape.type === 'redirect') {
		return { type: 'redirect', origins: sorted(shape.origins) }
	}
	if (shape.type !== 'attachment') {
		return canonicalShape(shape)
	}
	return { ...shape, columns: shape.columns.map((column) => ({ name: column.name, shape: canonicalShape(column.shape) })) }
}

/** A schema shape with its enum values sorted; tuple items and union options keep their order. */
export function canonicalShape(shape: SchemaShape): SchemaShape {
	switch (shape.type) {
		case 'enum':
			return { type: 'enum', values: sorted(shape.values) }
		case 'array':
			return { ...shape, items: canonicalShape(shape.items) }
		case 'tuple':
			return { type: 'tuple', items: shape.items.map(canonicalShape), rest: shape.rest === null ? null : canonicalShape(shape.rest) }
		case 'record':
			return { type: 'record', key: canonicalShape(shape.key), value: canonicalShape(shape.value) }
		case 'object':
			return { type: 'object', fields: mapValues(shape.fields, canonicalShape) }
		case 'optional':
		case 'nullable':
			return { type: shape.type, inner: canonicalShape(shape.inner) }
		case 'union':
			return { type: 'union', options: shape.options.map(canonicalShape) }
		default:
			return shape
	}
}

/** Code-unit order: unlike `localeCompare`, it is the same on every machine. */
function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

function sorted<T extends string>(values: readonly T[]): T[] {
	return [...values].sort(compare)
}

function sortedTuple<T extends string>(values: readonly [T, ...T[]]): [T, ...T[]] {
	const [head] = values
	const [first = head, ...rest] = sorted(values)
	return [first, ...rest]
}

function sortedSources(sources: readonly CspSource[]): CspSource[] {
	return [...sources].sort((a, b) => compare(a.origin, b.origin))
}

function mapValues<T, U>(record: Readonly<Record<string, T>>, map: (value: T) => U): Record<string, U> {
	return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, map(value)]))
}

function sortKeys(_key: string, value: unknown): unknown {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return value
	}
	return Object.fromEntries(Object.entries(value).sort(([a], [b]) => compare(a, b)))
}
