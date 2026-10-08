// The parser of a `ContractArtifact` read back as JSON (the build's own output, a file Control stored). Every
// object is strict and every field required, so a value that is not exactly an artifact is refused, not coerced.

import type {
	ArrayShape,
	ContractArtifact,
	EndpointRow,
	NumberShape,
	RecordShape,
	SchemaShape,
	StringShape,
	TablePolicyArtifact,
	TupleShape,
} from '@fabrika/auth-core'
import { z } from 'zod/v4'

const name = z.string().min(1)
const nullableName = name.nullable()
const names = z.array(name)
const record = <T extends z.core.$ZodType>(value: T) => z.record(z.string().min(1), value)

const stringShape: z.ZodType<StringShape> = z.strictObject({
	type: z.literal('string'),
	format: z.enum(['uuid', 'email', 'url', 'datetime', 'date', 'time', 'duration']).nullable(),
	minLength: z.int().nonnegative().nullable(),
	maxLength: z.int().nonnegative().nullable(),
	pattern: z.string().nullable(),
	startsWith: z.string().nullable(),
	endsWith: z.string().nullable(),
	includes: z.string().nullable(),
})

const numberShape: z.ZodType<NumberShape> = z.strictObject({
	type: z.literal('number'),
	int: z.boolean(),
	min: z.number().nullable(),
	exclusiveMin: z.boolean(),
	max: z.number().nullable(),
	exclusiveMax: z.boolean(),
	multipleOf: z.number().positive().nullable(),
})

const schemaShape: z.ZodType<SchemaShape> = z.lazy(() =>
	z.union([
		stringShape,
		numberShape,
		z.strictObject({ type: z.enum(['boolean', 'null']) }),
		z.strictObject({ type: z.literal('literal'), value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }),
		z.strictObject({ type: z.literal('enum'), values: z.array(z.string()) }),
		arrayShape,
		tupleShape,
		recordShape,
		z.strictObject({ type: z.literal('object'), fields: z.record(z.string(), schemaShape) }),
		z.strictObject({ type: z.literal('optional'), inner: schemaShape }),
		z.strictObject({ type: z.literal('nullable'), inner: schemaShape }),
		z.strictObject({ type: z.literal('union'), options: z.array(schemaShape) }),
	])
)

const arrayShape: z.ZodType<ArrayShape> = z.lazy(() =>
	z.strictObject({
		type: z.literal('array'),
		items: schemaShape,
		minItems: z.int().nonnegative().nullable(),
		maxItems: z.int().nonnegative().nullable(),
	})
)

const tupleShape: z.ZodType<TupleShape> = z.lazy(() =>
	z.strictObject({ type: z.literal('tuple'), items: z.array(schemaShape), rest: schemaShape.nullable() })
)

const recordShape: z.ZodType<RecordShape> = z.lazy(() => z.strictObject({ type: z.literal('record'), key: schemaShape, value: schemaShape }))

const caller = z.union([z.enum(['human', 'machine', 'link']), z.templateLiteral(['app:', z.string().min(1)])])
const rpcCaller = z.union([z.enum(['human', 'machine']), z.templateLiteral(['app:', z.string().min(1)])])

const accessForm = z.discriminatedUnion('form', [
	z.strictObject({ form: z.literal('over'), dimension: name }),
	z.strictObject({ form: z.literal('in'), dimension: name, from: name }),
	z.strictObject({ form: z.literal('on'), dimension: name, from: nullableName }),
	z.strictObject({ form: z.literal('creates'), dimension: name }),
])

const requirement = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('member') }),
	z.strictObject({ kind: z.literal('action'), action: name, access: accessForm }),
])

const rowBase = {
	id: name,
	source: z.strictObject({ kind: z.enum(['mount', 'export', 'files']), name }),
	method: z.enum(['GET', 'POST']),
	path: z.string().startsWith('/'),
	admission: z.strictObject({ contentTypes: z.tuple([name], name), maxBytes: z.int().positive().nullable() }).nullable(),
	input: schemaShape.nullable(),
	output: schemaShape.nullable(),
}

const endpointRow: z.ZodType<EndpointRow> = z.union([
	z.strictObject({
		...rowBase,
		kind: z.enum(['query', 'mutation', 'spa', 'upload', 'download']),
		callers: z.tuple([caller], caller),
		requirement,
	}),
	z.strictObject({
		...rowBase,
		kind: z.enum(['health', 'form', 'webhook', 'link-spa']),
		callers: z.tuple([]),
		requirement: z.null(),
	}),
])

const scopeBinding = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('app') }),
	z.strictObject({ kind: z.literal('dimension'), dimension: name }),
])

const mount = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('rpc'), prefix: name, callers: z.tuple([rpcCaller], rpcCaller) }),
	z.strictObject({
		kind: z.literal('link'),
		prefix: name,
		spa: name,
		dimension: name,
		grants: names,
		issuedBy: name,
		maxDays: z.int().positive(),
	}),
	z.strictObject({ kind: z.literal('spa'), prefix: name, dir: name }),
	z.strictObject({ kind: z.literal('health'), path: name }),
	z.strictObject({ kind: z.literal('form'), path: name, appendTo: name }),
	z.strictObject({ kind: z.literal('webhook'), path: name, scheme: z.literal('github-sha256'), boundTo: scopeBinding, actions: names }),
])

const cspSource = z.strictObject({ origin: name, purpose: name })

const tablePolicy: z.ZodType<TablePolicyArtifact> = z.strictObject({
	scope: z.discriminatedUnion('mode', [
		z.strictObject({
			mode: z.literal('dimension'),
			dimension: name,
			key: name,
			container: z.strictObject({ dimension: name, column: name }).nullable(),
		}),
		z.strictObject({ mode: z.literal('child'), parent: name, key: name, column: name, inherit: names }),
		z.strictObject({ mode: z.literal('inbox'), form: name }),
		z.strictObject({ mode: z.literal('reference'), reason: name }),
	]),
	actions: z.strictObject({ read: name, insert: nullableName, update: nullableName, delete: nullableName }),
	insert: names,
	update: names,
	version: nullableName,
	createdBy: nullableName,
	columns: record(z.strictObject({ read: name })),
})

export const contractArtifactSchema: z.ZodType<ContractArtifact> = z.strictObject({
	app: name,
	dimensions: record(z.strictObject({
		in: nullableName,
		creator: nullableName,
		members: z.strictObject({ manage: name, list: name }).nullable(),
	})),
	actions: record(z.string()),
	roles: record(z.strictObject({
		grants: names,
		member: z.strictObject({ scope: name, assignableBy: names }).nullable(),
	})),
	mounts: record(mount),
	files: record(z.strictObject({
		owner: name,
		read: name,
		write: name,
		delete: name,
		maxBytes: z.int().positive(),
		types: names,
		maxPerOwner: z.int().positive().nullable(),
		link: z.boolean(),
	})),
	jobs: record(z.strictObject({
		schedule: name,
		actions: names,
		scope: scopeBinding,
		timeout: nullableName,
		retries: z.int().nonnegative(),
	})),
	exports: record(z.strictObject({ version: z.int().positive(), consumers: names, audience: name })),
	imports: record(z.strictObject({
		app: name,
		export: name,
		version: z.int().positive(),
		digest: name,
		procedures: names,
		usedBy: names,
		timeoutMs: z.int().positive().nullable(),
	})),
	csp: z.strictObject({ connectSrc: z.array(cspSource), imgSrc: z.array(cspSource), frameAncestors: z.array(cspSource) }),
	tables: record(tablePolicy),
	endpoints: z.array(endpointRow),
	reservedPrefixes: names,
})

/** Parses JSON that should be a contract artifact; throws a `ZodError` naming every mismatch. */
export function parseContractArtifact(value: unknown): ContractArtifact {
	return contractArtifactSchema.parse(value)
}
