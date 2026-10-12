// The canonical form of a contract artifact. Two producers (`compileContract`, the static reader) and every digest
// over an artifact must agree byte for byte, so declaration order may not leak into it.

import type {
	BodyAdmission,
	Caller,
	ContractArtifact,
	CspSource,
	EndpointRow,
	MountArtifact,
	OutputShape,
	RoleArtifact,
	SchemaShape,
	TablePolicyArtifact,
} from './contract'

/**
 * The artifact with every array whose order carries no meaning sorted: endpoints by id, and every list of names.
 * Tuple items and union options keep their order, because it changes what a schema admits. Object keys are left
 * as they are; `canonicalArtifactJson` sorts them.
 */
export function canonicalizeArtifact(artifact: ContractArtifact): ContractArtifact {
	return {
		app: artifact.app,
		dimensions: artifact.dimensions,
		actions: artifact.actions,
		roles: mapValues(artifact.roles, canonicalRole),
		mounts: mapValues(artifact.mounts, canonicalMount),
		files: mapValues(artifact.files, (collection) => ({ ...collection, types: sorted(collection.types) })),
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
		},
		tables: mapValues(artifact.tables, canonicalTable),
		endpoints: artifact.endpoints.map(canonicalizeEndpoint).sort((a, b) => compare(a.id, b.id)),
		reservedPrefixes: sorted(artifact.reservedPrefixes),
		...(artifact.declared === undefined
			? {}
			: { declared: mapValues(artifact.declared, (reach) => ({ ...reach, connect: sorted(reach.connect) })) }),
		...(artifact.directories === undefined ? {} : { directories: artifact.directories }),
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
	}
}

function canonicalMount(mount: MountArtifact): MountArtifact {
	switch (mount.kind) {
		case 'rpc':
			return { ...mount, callers: sortedTuple(mount.callers) }
		case 'link':
			return { ...mount, grants: sorted(mount.grants) }
		case 'webhook':
			return { ...mount, actions: sorted(mount.actions) }
		default:
			return mount
	}
}

function canonicalTable(table: TablePolicyArtifact): TablePolicyArtifact {
	return {
		...table,
		scope: table.scope.mode === 'child' ? { ...table.scope, inherit: sorted(table.scope.inherit) } : table.scope,
		insert: sorted(table.insert),
		update: sorted(table.update),
	}
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
