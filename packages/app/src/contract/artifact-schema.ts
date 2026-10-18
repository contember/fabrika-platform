// The parser of a `ContractArtifact` read back as JSON (the build's own output, a file Control stored). Every
// object is strict and every field required, so a value that is not exactly an artifact is refused, not coerced.

import {
	ANY_ORIGIN_KINDS,
	type ArrayShape,
	type AttachmentShape,
	BUILTIN_ROLE_KEYS,
	type ContractArtifact,
	CROSS_ORIGIN_KINDS,
	displayNameProblem,
	type EndpointRow,
	JOB_MAILERS,
	LOCALES,
	mailTemplateProblems,
	type MessageKind,
	type NumberShape,
	type OutputShape,
	type RecordShape,
	type SchemaShape,
	type StringShape,
	type TablePolicyArtifact,
	type TupleShape,
} from '@fabrika/auth-core'
import { z } from 'zod/v4'
import { FORM_LIMITS } from './defaults'

const name = z.string().min(1)
const nullableName = name.nullable()
const names = z.array(name)
const record = <T extends z.core.$ZodType>(value: T) => z.record(z.string().min(1), value)
/** A contract's actions are exact: IAM treats `*` as a pattern, which would widen every grant naming it. */
const action = name.refine((value) => !value.includes('*'), 'an action is exact; * is not an action')
const nullableAction = action.nullable()
const actions = z.array(action)
/** IAM's own role keys win over an application role of the same key at resolution. */
const roleKey = name.refine((key) => !BUILTIN_ROLE_KEYS.includes(key), 'a built-in IAM role key is not a contract role name')

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

/** A `SchemaShape` read back as JSON. */
export const schemaShapeSchema: z.ZodType<SchemaShape> = z.lazy(() =>
	z.union([
		stringShape,
		numberShape,
		z.strictObject({ type: z.enum(['boolean', 'null']) }),
		z.strictObject({ type: z.literal('literal'), value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }),
		z.strictObject({ type: z.literal('enum'), values: z.array(z.string()) }),
		arrayShape,
		tupleShape,
		recordShape,
		z.strictObject({ type: z.literal('object'), fields: z.record(z.string(), schemaShapeSchema) }),
		z.strictObject({ type: z.literal('optional'), inner: schemaShapeSchema }),
		z.strictObject({ type: z.literal('nullable'), inner: schemaShapeSchema }),
		z.strictObject({ type: z.literal('union'), options: z.array(schemaShapeSchema) }),
	])
)

const arrayShape: z.ZodType<ArrayShape> = z.lazy(() =>
	z.strictObject({
		type: z.literal('array'),
		items: schemaShapeSchema,
		minItems: z.int().nonnegative().nullable(),
		maxItems: z.int().nonnegative().nullable(),
	})
)

const tupleShape: z.ZodType<TupleShape> = z.lazy(() =>
	z.strictObject({ type: z.literal('tuple'), items: z.array(schemaShapeSchema), rest: schemaShapeSchema.nullable() })
)

const recordShape: z.ZodType<RecordShape> = z.lazy(() =>
	z.strictObject({ type: z.literal('record'), key: schemaShapeSchema, value: schemaShapeSchema })
)

const attachmentShape: z.ZodType<AttachmentShape> = z.strictObject({
	type: z.literal('attachment'),
	format: z.enum(['csv', 'xlsx']),
	filename: name,
	maxBytes: z.int().positive(),
	maxRows: z.int().positive(),
	columns: z.array(z.strictObject({ name: z.string(), shape: schemaShapeSchema })).min(1),
})

/** What a procedure answers: a schema shape, or an attachment's file. */
export const outputShapeSchema: z.ZodType<OutputShape> = z.union([schemaShapeSchema, attachmentShape])

const caller = z.union([z.enum(['human', 'machine', 'link']), z.templateLiteral(['app:', z.string().min(1)])])
const rpcCaller = z.enum(['human', 'machine'])

const accessForm = z.discriminatedUnion('form', [
	z.strictObject({ form: z.literal('over'), dimension: name }),
	z.strictObject({ form: z.literal('in'), dimension: name, from: name }),
	z.strictObject({ form: z.literal('on'), dimension: name, from: nullableName }),
	z.strictObject({ form: z.literal('creates'), dimension: name }),
	z.strictObject({ form: z.literal('app') }),
])

const requirement = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('member') }),
	z.strictObject({ kind: z.literal('action'), action, access: accessForm }),
])

const rowBase = {
	id: name,
	source: z.strictObject({ kind: z.enum(['mount', 'export', 'files']), name }),
	method: z.enum(['GET', 'POST']),
	path: z.string().startsWith('/'),
	admission: z.strictObject({ contentTypes: z.tuple([name], name), maxBytes: z.int().positive().nullable() }).nullable(),
	input: schemaShapeSchema.nullable(),
	output: outputShapeSchema.nullable(),
}

const endpointRow: z.ZodType<EndpointRow> = z.union([
	z.strictObject({
		...rowBase,
		kind: z.enum(['query', 'mutation', 'spa', 'upload', 'download']),
		callers: z.tuple([caller], caller),
		requirement,
		crossOrigin: z.literal('environment').optional(),
	}),
	z.strictObject({
		...rowBase,
		kind: z.enum(['health', 'form', 'webhook', 'link-spa']),
		callers: z.tuple([]),
		requirement: z.null(),
		crossOrigin: z.enum(['environment', 'any']).optional(),
	}),
	// A public SPA is a fixed static row: GET only, no body, no schemas.
	z.strictObject({
		...rowBase,
		kind: z.literal('public-spa'),
		method: z.literal('GET'),
		admission: z.null(),
		input: z.null(),
		output: z.null(),
		callers: z.tuple([]),
		requirement: z.null(),
	}),
]).refine(
	// Only an RPC procedure and a form open to another origin, and only a form to any (ADR-0022).
	(row) =>
		!('crossOrigin' in row) || row.crossOrigin === undefined
		|| (CROSS_ORIGIN_KINDS.includes(row.kind) && (row.crossOrigin !== 'any' || ANY_ORIGIN_KINDS.includes(row.kind))),
	'this endpoint kind cannot be called cross-origin',
)

const scopeBinding = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('app') }),
	z.strictObject({ kind: z.literal('dimension'), dimension: name }),
])

const formRate = z.int().positive().max(FORM_LIMITS.maxPerMinute)
const applicationVariable = z.string().regex(/^[A-Z][A-Z0-9_]*$/)

const mount = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('rpc'), prefix: name, callers: z.tuple([rpcCaller], rpcCaller) }),
	z.strictObject({
		kind: z.literal('link'),
		prefix: name,
		spa: name,
		dimension: name,
		grants: actions,
		issuedBy: action,
		maxDays: z.int().positive(),
	}),
	z.strictObject({ kind: z.literal('spa'), prefix: name, dir: name, public: z.array(applicationVariable).nonempty().optional() }),
	z.strictObject({ kind: z.literal('health'), path: name }),
	z.strictObject({
		kind: z.literal('form'),
		path: name,
		appendTo: name,
		rate: z.strictObject({ perClient: formRate.optional(), perForm: formRate.optional() }).optional(),
		honeypot: name.optional(),
		challenge: z.strictObject({ provider: z.literal('turnstile'), secret: applicationVariable, siteKey: applicationVariable.optional() }).optional(),
		then: name.optional(),
		files: z.record(name, z.strictObject({ collection: name, required: z.boolean() })).optional(),
	}),
	z.strictObject({ kind: z.literal('webhook'), path: name, scheme: z.literal('github-sha256'), boundTo: scopeBinding, actions }),
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
		z.strictObject({ mode: z.literal('app'), reason: name, key: name }),
	]),
	actions: z.strictObject({
		read: action,
		insert: nullableAction,
		update: nullableAction,
		delete: nullableAction,
		appRead: z.array(action).nonempty().optional(),
		appCount: z.array(action).nonempty().optional(),
	}),
	insert: names,
	update: names,
	version: nullableName,
	createdBy: nullableName,
	columns: record(z.strictObject({ read: action.optional(), write: action.optional() })),
})

export const contractArtifactSchema: z.ZodType<ContractArtifact> = z.strictObject({
	app: name,
	dimensions: record(z.strictObject({
		in: nullableName,
		creator: nullableName,
		members: z.strictObject({ manage: action, list: action }).nullable(),
		directory: z.literal('labels').optional(),
	})),
	actions: z.record(action, z.string()),
	roles: z.record(
		roleKey,
		z.strictObject({
			grants: actions,
			member: z.strictObject({ scope: name, assignableBy: z.array(roleKey) }).nullable(),
			external: z.literal(true).optional(),
		}).refine((role) => role.external !== true || role.member !== null, {
			path: ['external'],
			message: 'only a membership role admits external principals',
		}),
	),
	mounts: record(mount),
	files: record(z.strictObject({
		owner: name,
		read: action,
		write: action,
		delete: action,
		maxBytes: z.int().positive(),
		types: names,
		maxPerOwner: z.int().positive().nullable(),
		link: z.union([z.boolean(), z.array(name).nonempty()]),
		scan: z.literal(true).optional(),
	})),
	jobs: record(z.strictObject({
		schedule: name,
		actions,
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
	csp: z.strictObject({
		connectSrc: z.array(cspSource),
		imgSrc: z.array(cspSource),
		frameAncestors: z.array(cspSource),
		scriptSrc: z.array(cspSource).nonempty().optional(),
		frameSrc: z.array(cspSource).nonempty().optional(),
		styleSrc: z.array(cspSource).nonempty().optional(),
		fontSrc: z.array(cspSource).nonempty().optional(),
	}),
	tables: record(tablePolicy),
	endpoints: z.array(endpointRow).superRefine((rows, context) => {
		for (const [index, row] of rows.entries()) {
			if (row.source.kind !== 'export' && row.callers.some((caller) => caller.startsWith('app:'))) {
				context.addIssue({ code: 'custom', path: [index, 'callers'], message: 'an app:<id> caller reaches only an export row' })
			}
			if (row.source.kind === 'export' && row.requirement?.kind !== 'action') {
				context.addIssue({ code: 'custom', path: [index, 'requirement'], message: 'an export row requires an action' })
			}
			if (row.source.kind === 'export' && row.requirement?.kind === 'action' && row.requirement.access.form === 'app') {
				context.addIssue({ code: 'custom', path: [index, 'requirement'], message: 'an export row reads in one dimension, never app-wide' })
			}
		}
	}),
	reservedPrefixes: names,
	declared: record(z.strictObject({
		sql: z.enum(['read', 'write']).nullable(),
		unscoped: record(z.enum(['read', 'write'])),
		connect: names,
		issues: nullableName,
		then: name.optional(),
		mailer: z.enum(JOB_MAILERS).optional(),
	})).optional(),
	directories: record(z.strictObject({ dimension: name, lists: z.boolean() })).optional(),
	locale: z.enum(LOCALES).optional(),
	displayName: z.string().refine((value) => displayNameProblem(value) === null, 'not a display name').optional(),
	mail: z.strictObject({ invitation: mailLocales('invitation'), enrollment: mailLocales('enrollment'), reset: mailLocales('reset') }).partial()
		.optional(),
	members: z.strictObject({ manage: action, list: action }).optional(),
	directory: z.literal('labels').optional(),
})

function mailLocales(kind: MessageKind) {
	const template = z.strictObject({ subject: z.string(), text: z.string(), html: z.string().optional() }).superRefine((value, context) => {
		for (const message of mailTemplateProblems(kind, value)) context.addIssue({ code: 'custom', message })
	})
	return z.partialRecord(z.enum(LOCALES), template)
}

/** Parses JSON that should be a contract artifact; throws a `ZodError` naming every mismatch. */
export function parseContractArtifact(value: unknown): ContractArtifact {
	return contractArtifactSchema.parse(value)
}
