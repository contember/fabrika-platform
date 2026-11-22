// The parser of a `ContractArtifact` read back as JSON (the build's own output, a file Control stored). Every
// object is strict and every field required, so a value that is not exactly an artifact is refused, not coerced.

import {
	ANY_ORIGIN_KINDS,
	type ArrayShape,
	type AttachmentShape,
	BUILTIN_ROLE_KEYS,
	type ColumnTestArtifact,
	type ConditionArtifact,
	CONTRACT_FORMAT,
	type ContractArtifact,
	CROSS_ORIGIN_KINDS,
	displayNameProblem,
	type EndpointRow,
	FILE_RESPONSE_KINDS,
	fileKindsIn,
	isAnyOfList,
	isOwnWorkloadName,
	JOB_MAILERS,
	JOB_SITE_PREFIX,
	LOCALES,
	mailTemplateProblems,
	MAX_ANY_OF,
	MAX_CACHE_AGE_SECONDS,
	type MessageKind,
	type NumberShape,
	type OutputShape,
	parseEgressEntry,
	PUBLIC_EGRESS,
	type RecordShape,
	type RowsTestArtifact,
	type SchemaShape,
	SHARED_SHAPES_ENCODING,
	type StringShape,
	type TablePolicyArtifact,
	terminalIdentifyProblem,
	type TupleShape,
} from '@fabrika/auth-core'
import { inlineFileTypes, WORKER_BLOB_SOURCE } from '@fabrika/proxy-core/headers'
import { z } from 'zod/v4'
import {
	ALTCHA_LIMITS,
	altchaSolvable,
	CHALLENGE_ACTION,
	CHALLENGE_PREFIX,
	challengePath,
	challengeRowId,
	JOB_LIMITS,
	PROCEDURE_LIMITS,
} from './defaults'
import { TOKEN_MAX_DAYS } from './token'
import { webhookSchemeSchema } from './webhook-scheme'

const name = z.string().min(1)
const nullableName = name.nullable()
const names = z.array(name)
const record = <T extends z.core.$ZodType>(value: T) => z.record(z.string().min(1), value)
/** A contract's actions are exact: IAM treats `*` as a pattern, which would widen every grant naming it. */
const action = name.refine((value) => !value.includes('*'), 'an action is exact; * is not an action')
const actions = z.array(action)
/** A file's object key starts with its kind: the framework keeps its own objects in the files bucket under this prefix. */
export const RESERVED_FILE_KIND_PREFIX = '__fabrika'
const fileKindName = name.refine(
	(kind) => !kind.startsWith(RESERVED_FILE_KIND_PREFIX),
	`a file kind name the framework reserves (${RESERVED_FILE_KIND_PREFIX}*)`,
)
/** IAM's own role keys win over an application role of the same key at resolution. */
const roleKey = name.refine((key) => !BUILTIN_ROLE_KEYS.includes(key), 'a built-in IAM role key is not a contract role name')

/**
 * The parser of a schema shape. Plain (`shared` null): every constraint present, null when unset, as `canonicalShape`
 * writes it. Shared, as `encodeArtifact` writes it: a null constraint is absent, and `{ type: 'shared', index }` is the
 * shape `shared[index]`, the same object wherever it is referenced. `shared` holds only the shapes parsed before, so a
 * reference reaches back only, and no shape contains itself.
 */
function shapeSchemaOf(shared: readonly SchemaShape[] | null): z.ZodType<SchemaShape> {
	const absentIsNull = shared !== null
	const nonNegative = orNull(z.int().nonnegative(), absentIsNull)
	const text = orNull(z.string(), absentIsNull)
	const bound = orNull(z.number(), absentIsNull)
	const stringShape = z.strictObject({
		type: z.literal('string'),
		format: orNull(z.enum(['uuid', 'email', 'url', 'datetime', 'date', 'time', 'duration']), absentIsNull),
		minLength: nonNegative,
		maxLength: nonNegative,
		pattern: text,
		startsWith: text,
		endsWith: text,
		includes: text,
	}) satisfies z.ZodType<StringShape>
	const numberShape = z.strictObject({
		type: z.literal('number'),
		int: z.boolean(),
		min: bound,
		exclusiveMin: z.boolean(),
		max: bound,
		exclusiveMax: z.boolean(),
		multipleOf: orNull(z.number().positive(), absentIsNull),
	}) satisfies z.ZodType<NumberShape>
	const forms = () =>
		[
			stringShape,
			numberShape,
			z.strictObject({ type: z.enum(['boolean', 'null']) }),
			z.strictObject({ type: z.literal('literal'), value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }),
			z.strictObject({ type: z.literal('enum'), values: z.array(z.string()) }),
			z.strictObject({ type: z.literal('array'), items: shape, minItems: nonNegative, maxItems: nonNegative }) satisfies z.ZodType<ArrayShape>,
			z.strictObject({ type: z.literal('tuple'), items: z.array(shape), rest: orNull(shape, absentIsNull) }) satisfies z.ZodType<TupleShape>,
			z.strictObject({ type: z.literal('record'), key: shape, value: shape }) satisfies z.ZodType<RecordShape>,
			z.strictObject({ type: z.literal('object'), fields: z.record(z.string(), shape) }),
			z.strictObject({ type: z.literal('optional'), inner: shape }),
			z.strictObject({ type: z.literal('nullable'), inner: shape }),
			z.strictObject({ type: z.literal('union'), options: z.array(shape) }),
			z.strictObject({ type: z.literal('token'), purpose: name }),
			z.strictObject({ type: z.literal('file'), kind: z.string().min(1) }),
		] as const
	// Dispatched on `type`: one form per node, never a trial of each.
	const shape: z.ZodType<SchemaShape> = shared === null
		? z.lazy(() => z.discriminatedUnion('type', forms()))
		: z.lazy(() =>
			z.discriminatedUnion('type', [...forms(), z.strictObject({ type: z.literal('shared'), index: z.int().nonnegative() })]).transform(
				(written, context): SchemaShape => {
					if (written.type !== 'shared') return written
					const target = shared[written.index]
					if (target === undefined) {
						context.addIssue({ code: 'custom', message: `shape ${written.index} is not written before it is referenced` })
						return z.NEVER
					}
					return target
				},
			)
		)
	return shape
}

/** A constraint that is null when unset; absent stands for null where `absentIsNull`. */
function orNull<T extends z.ZodType>(schema: T, absentIsNull: boolean): z.ZodType<z.output<T> | null, z.input<T> | null | undefined> {
	return absentIsNull ? schema.nullable().default(null) : schema.nullable()
}

/** A `SchemaShape` read back as JSON. */
export const schemaShapeSchema: z.ZodType<SchemaShape> = shapeSchemaOf(null)

/** What a procedure answers: a schema shape, or an attachment's file. */
function outputShapeSchemaOf(shape: z.ZodType<SchemaShape>): z.ZodType<OutputShape> {
	const attachmentShape: z.ZodType<AttachmentShape> = z.strictObject({
		type: z.literal('attachment'),
		format: z.enum(['csv', 'xlsx']),
		filename: name,
		maxBytes: z.int().positive(),
		maxRows: z.int().positive(),
		columns: z.array(z.strictObject({ name: z.string(), shape })).min(1),
	})
	const redirectShape = z.strictObject({ type: z.literal('redirect'), origins: z.array(z.string().startsWith('https://')) })
	return z.union([shape, attachmentShape, redirectShape])
}

export const outputShapeSchema: z.ZodType<OutputShape> = outputShapeSchemaOf(schemaShapeSchema)

const caller = z.union([z.enum(['human', 'machine', 'link']), z.templateLiteral(['app:', z.string().min(1)])])
const rpcCaller = z.enum(['human', 'machine'])

const accessForm = z.discriminatedUnion('form', [
	z.strictObject({ form: z.literal('over'), dimension: name }),
	z.strictObject({ form: z.literal('in'), dimension: name, from: name }),
	z.strictObject({ form: z.literal('on'), dimension: name, from: nullableName }),
	z.strictObject({ form: z.literal('creates'), dimension: name }),
	z.strictObject({ form: z.literal('app') }),
])

const capabilityForm = z.discriminatedUnion('form', [
	z.strictObject({ form: z.literal('over'), dimension: name }),
	z.strictObject({ form: z.literal('in'), dimension: name, from: name }),
	z.strictObject({ form: z.literal('on'), dimension: name, from: name }),
])

const requirement = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('member') }),
	z.strictObject({ kind: z.literal('action'), action, access: accessForm }),
	z.strictObject({
		kind: z.literal('anyOf'),
		actions: z.tuple([action, action], action).refine(isAnyOfList, `two to ${MAX_ANY_OF} distinct actions, sorted`),
		access: z.strictObject({ form: z.literal('app') }),
	}),
	z.strictObject({
		kind: z.literal('capabilities'),
		capabilities: record(z.strictObject({ action, access: capabilityForm })).refine(
			(capabilities) => Object.keys(capabilities).length >= 2,
			'several capabilities are at least two',
		),
	}),
])

const endpointCacheSchema = z.union([
	z.literal('immutable'),
	z.strictObject({ maxAgeSeconds: z.int().min(1).max(MAX_CACHE_AGE_SECONDS) }),
])

function rowBaseOf(shape: z.ZodType<SchemaShape>, output: z.ZodType<OutputShape>) {
	return {
		id: name,
		source: z.strictObject({ kind: z.enum(['mount', 'export', 'files']), name }),
		method: z.enum(['GET', 'POST']),
		path: z.string().startsWith('/'),
		admission: z.strictObject({ contentTypes: z.tuple([name], name), maxBytes: z.int().positive().nullable() }).nullable(),
		input: shape.nullable(),
		output: output.nullable(),
		response: z.enum(['file', 'inline-file']).optional(),
	}
}

/** An endpoint row whose schemas `shape` parses. */
function endpointRowOf(shape: z.ZodType<SchemaShape>): z.ZodType<EndpointRow> {
	const output = outputShapeSchemaOf(shape)
	const rowBase = rowBaseOf(shape, output)
	return z.union([
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
			authorization: z.literal('forward').optional(),
		}).refine((row) => row.authorization === undefined || row.kind === 'webhook', "only a webhook forwards the request's Authorization"),
		// A public procedure is a mount's procedure anyone calls: it admits a body and answers its output.
		z.strictObject({
			...rowBase,
			kind: z.literal('public'),
			source: z.strictObject({ kind: z.literal('mount'), name }),
			output,
			callers: z.tuple([]),
			requirement: z.null(),
			crossOrigin: z.enum(['environment', 'any']).optional(),
			cache: endpointCacheSchema.optional(),
		}).refine((row) => row.cache === undefined || row.method === 'GET', 'only a GET answer is cached'),
		// The framework's own GET that issues the ALTCHA challenge of the public procedure its source names: no body, no schemas.
		z.strictObject({
			...rowBase,
			kind: z.literal('public'),
			source: z.strictObject({ kind: z.literal('challenge'), name }),
			method: z.literal('GET'),
			admission: z.null(),
			input: z.null(),
			output: z.null(),
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
		// Only a procedure answers a stored file, and exactly when its output is one.
		(row) => (row.response !== undefined) === (row.output?.type === 'file') && (row.response === undefined || FILE_RESPONSE_KINDS.includes(row.kind)),
		'only a procedure whose output is a file answers a stored file',
	).refine(
		// Only an RPC procedure, a public procedure and a form open to another origin, and only the anonymous two to any (ADR-0022).
		(row) =>
			!('crossOrigin' in row) || row.crossOrigin === undefined
			|| (CROSS_ORIGIN_KINDS.includes(row.kind) && (row.crossOrigin !== 'any' || ANY_ORIGIN_KINDS.includes(row.kind))),
		'this endpoint kind cannot be called cross-origin',
	)
}

const scopeBinding = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('app') }),
	z.strictObject({ kind: z.literal('dimension'), dimension: name }),
])

/** A form's rate, per minute, as the releases that declared forms (up to 0.5) bounded it. */
const formRate = z.int().positive().max(10_000)
const applicationVariable = z.string().regex(/^[A-Z][A-Z0-9_]*$/)
const bucket = z.int().positive().max(PROCEDURE_LIMITS.maxPerMinute).nullable()
const challenge = z.strictObject({ provider: z.literal('turnstile'), secret: applicationVariable, siteKey: applicationVariable.optional() })
const challengeActionSchema = z.string().regex(CHALLENGE_ACTION)
const procedureChallenge = z.discriminatedUnion('provider', [
	challenge.extend({ action: challengeActionSchema }),
	z.strictObject({
		provider: z.literal('altcha'),
		secret: applicationVariable,
		action: challengeActionSchema,
		cost: z.int().min(ALTCHA_LIMITS.minCost).max(ALTCHA_LIMITS.maxCost),
		maxAgeMs: z.int().min(ALTCHA_LIMITS.minMaxAgeMs).max(ALTCHA_LIMITS.maxMaxAgeMs),
	}).refine((challenge) => altchaSolvable(challenge.cost, challenge.maxAgeMs), 'a slow phone does not solve this challenge in time'),
])

const mount = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('rpc'), prefix: name, callers: z.array(rpcCaller), compatibility: z.literal('backward').optional() }),
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
		rate: z.strictObject({ perClient: formRate.optional(), perForm: formRate.optional(), bytesPerHour: z.int().positive().optional() }).optional(),
		honeypot: name.optional(),
		challenge: challenge.optional(),
		then: name.optional(),
		files: z.record(name, z.strictObject({ collection: name, required: z.boolean() })).optional(),
	}),
	z.strictObject({
		kind: z.literal('webhook'),
		path: name,
		scheme: webhookSchemeSchema,
		boundTo: scopeBinding,
		actions,
		timeoutMs: z.int().positive().max(PROCEDURE_LIMITS.maxTimeoutMs),
	}),
])

const cspSource = z.strictObject({ origin: name, purpose: name })

/** One action as its text (every release's form), or several distinct ones as a list of at least two. */
const tableAction = z.union([
	action,
	z.array(action).min(2).refine((list) => new Set(list).size === list.length, 'a table operation names each action once'),
])

const literal = z.union([z.string(), z.number().finite(), z.boolean()])
const ordered = z.union([literal, z.strictObject({ now: z.literal(true) })])

/** Exactly one operator per column test, as the policy parse reads it. */
const columnTest: z.ZodType<ColumnTestArtifact> = z.strictObject({
	eq: literal.optional(),
	notEq: literal.optional(),
	in: z.array(literal).nonempty().optional(),
	notIn: z.array(literal).nonempty().optional(),
	isNull: z.boolean().optional(),
	lt: ordered.optional(),
	lte: ordered.optional(),
	gt: ordered.optional(),
	gte: ordered.optional(),
}).refine((test) => Object.values(test).filter((value) => value !== undefined).length === 1, 'a column test states exactly one operator')

/** `some` or `none` of one table's rows: a condition of its own, or the test at the end of a path. */
const rowsTest: z.ZodType<RowsTestArtifact> = z.lazy(() =>
	z.union([
		z.strictObject({ some: z.record(name, condition).refine((rows) => Object.keys(rows).length === 1, 'some names exactly one table') }),
		z.strictObject({ none: z.record(name, condition).refine((rows) => Object.keys(rows).length === 1, 'none names exactly one table') }),
	])
)

const condition: z.ZodType<ConditionArtifact> = z.lazy(() =>
	z.union([
		z.strictObject({ allOf: z.array(condition).nonempty() }),
		z.strictObject({ anyOf: z.array(condition).nonempty() }),
		z.strictObject({ not: condition }),
		rowsTest,
		z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,3}$/), z.union([columnTest, rowsTest])).refine(
			(tests) =>
				Object.keys(tests).length > 0 && !('allOf' in tests) && !('anyOf' in tests) && !('not' in tests) && !('some' in tests)
				&& !('none' in tests),
			'a condition tests at least one column',
		),
	])
)

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
		read: tableAction,
		insert: tableAction.nullable(),
		update: tableAction.nullable(),
		delete: tableAction.nullable(),
		appRead: z.array(action).nonempty().optional(),
		appCount: z.array(action).nonempty().optional(),
	}),
	insert: names,
	update: names,
	version: nullableName,
	createdBy: nullableName,
	columns: record(z.strictObject({ read: tableAction.optional(), write: action.optional() })),
	files: z.record(name, name).optional(),
	view: z.literal(true).optional(),
	confers: record(z.strictObject({
		principal: name,
		node: name,
		expires: nullableName,
		when: condition.optional(),
		assign: z.strictObject({ maxDays: z.int().positive().nullable(), self: z.boolean() }).nullable(),
	})).optional(),
	when: z.record(action, condition).optional(),
	relationWhen: record(z.record(action, condition)).optional(),
	reveals: record(z.strictObject({
		to: name,
		actions: z.array(action).nonempty(),
		when: condition.optional(),
		assign: z.strictObject({ self: z.boolean() }).optional(),
	})).optional(),
	readThrough: z.record(name, name).optional(),
	writeThrough: z.record(name, z.array(action).nonempty()).optional(),
	memberReveals: record(z.strictObject({
		to: name,
		actions: z.array(action).nonempty(),
		when: condition.optional(),
		assign: z.strictObject({ self: z.boolean() }).optional(),
	})).optional(),
	access: record(
		z.strictObject({ view: name, row: name, principal: nullableName, member: nullableName }).refine(
			(access) => access.principal !== null || access.member !== null,
			'an access view binds the principal, a member node or both (ADR-0076)',
		),
	).optional(),
})

/** A contract artifact whose schemas `shape` parses. */
function artifactSchemaOf(shape: z.ZodType<SchemaShape>): z.ZodType<ContractArtifact> {
	return z.strictObject({
		format: z.literal(CONTRACT_FORMAT),
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
				via: record(actions.nonempty()).optional(),
			}).refine((role) => role.external !== true || role.member !== null, {
				path: ['external'],
				message: 'only a membership role admits external principals',
			}).refine((role) => role.via === undefined || role.external !== true, {
				path: ['via'],
				message: 'a relation holds actions through an internal role only, never an external one',
			}),
		),
		relations: record(z.strictObject({ dimension: name })).optional(),
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
		fileKinds: z.record(
			fileKindName,
			z.strictObject({ types: names, maxBytes: z.int().positive(), scan: z.literal(true).optional(), inline: z.literal(true).optional() }).refine(
				(kind) => kind.inline === undefined || kind.types.every((type) => inlineFileTypes('inline-file').includes(type)),
				'an inline kind admits only inert images and XML documents',
			),
		).optional(),
		jobs: record(z.strictObject({
			schedule: name,
			actions,
			scope: scopeBinding,
			timeoutMs: z.int().positive().max(JOB_LIMITS.maxTimeoutMs),
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
			workerSrc: z.tuple([z.strictObject({ origin: z.literal(WORKER_BLOB_SOURCE), purpose: z.string().min(1) })]).optional(),
		}),
		tables: record(tablePolicy),
		endpoints: z.array(endpointRowOf(shape)).superRefine((rows, context) => {
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
			actions: actions.nonempty().optional(),
			kicks: z.array(name).nonempty().optional(),
			binds: name.optional(),
			signs: z.array(name).nonempty().optional(),
			egress: z.union([z.array(z.string().refine((origin) => parseEgressEntry(origin).ok)).nonempty(), z.literal(PUBLIC_EGRESS)]).optional(),
		})).superRefine((declared, context) => {
			for (const [site, reach] of Object.entries(declared)) {
				if (reach.egress === PUBLIC_EGRESS && !site.startsWith(JOB_SITE_PREFIX)) {
					context.addIssue({ code: 'custom', path: [site, 'egress'], message: "egress: 'public' belongs to a cron job, keyed by job:<name>" })
				}
				if (reach.actions !== undefined && !isOwnWorkloadName('public', site)) {
					context.addIssue({ code: 'custom', path: [site, 'actions'], message: 'workload actions belong to a public procedure, keyed by its endpoint id' })
				}
			}
		}).optional(),
		directories: record(z.strictObject({ dimension: name, lists: z.boolean() })).optional(),
		locale: z.enum(LOCALES).optional(),
		displayName: z.string().refine((value) => displayNameProblem(value) === null, 'not a display name').optional(),
		mail: z.strictObject({ invitation: mailLocales('invitation'), enrollment: mailLocales('enrollment'), reset: mailLocales('reset') }).partial()
			.optional(),
		members: z.strictObject({ manage: action, list: action }).optional(),
		directory: z.literal('labels').optional(),
		terminal: z.strictObject({ identify: z.string().refine((path) => terminalIdentifyProblem(path) === null, 'not an identification path') })
			.optional(),
		procedures: record(z.strictObject({
			rate: z.strictObject({
				perClient: bucket,
				perCaller: bucket,
				perEndpoint: bucket,
				bytesPerHour: z.int().positive().max(PROCEDURE_LIMITS.maxBytesPerHour).nullable(),
			}),
			challenge: procedureChallenge.nullable(),
			timeoutMs: z.int().positive().max(PROCEDURE_LIMITS.maxTimeoutMs),
			query: shape.optional(),
			changesStateOnGet: z.literal(true).optional(),
		})).optional(),
		tokens: record(z.strictObject({ claims: shape, maxDays: z.int().positive().max(TOKEN_MAX_DAYS) })).optional(),
	}).superRefine((artifact, context) => {
		for (const row of artifact.endpoints) {
			// A row answering a file of an inline kind shows it, every other row that answers a file downloads it.
			if (row.output?.type === 'file' && (row.response === 'inline-file') !== (artifact.fileKinds?.[row.output.kind]?.inline === true)) {
				context.addIssue({ code: 'custom', path: ['endpoints'], message: `'${row.id}' is inline-file exactly when its file kind is inline` })
			}
			// Only the application writes a file of an inline kind: an uploaded document could render as a page.
			const inline = row.input === null ? undefined : fileKindsIn(row.input).find((kind) => artifact.fileKinds?.[kind]?.inline === true)
			if (inline !== undefined) {
				context.addIssue({
					code: 'custom',
					path: ['endpoints', artifact.endpoints.indexOf(row)],
					message: `'${row.id}' takes a file of the inline kind '${inline}', which only the application writes`,
				})
			}
			if (row.kind === 'public' && row.source.kind !== 'challenge' && artifact.declared?.[row.id]?.actions === undefined) {
				context.addIssue({ code: 'custom', path: ['declared', row.id], message: 'a public procedure declares its workload actions' })
			}
		}
		// Every ALTCHA challenge has exactly its own issuer, under its action, from the procedure's origins, with its own buckets.
		const rows = new Map(artifact.endpoints.map((row) => [row.id, row]))
		const issuers = artifact.endpoints.filter((row) => row.source.kind === 'challenge')
		for (const [id, rules] of Object.entries(artifact.procedures ?? {})) {
			if (rules.challenge?.provider !== 'altcha') continue
			const issuer = rows.get(challengeRowId(id))
			const procedure = rows.get(id)
			if (
				issuer === undefined || procedure === undefined || issuer.source.kind !== 'challenge' || issuer.source.name !== id
				|| issuer.path !== challengePath(rules.challenge.action) || issuer.crossOrigin !== procedure.crossOrigin
				|| artifact.procedures?.[issuer.id]?.challenge !== null
			) {
				context.addIssue({ code: 'custom', path: ['procedures', id, 'challenge'], message: 'an ALTCHA challenge has its own issuer row' })
			}
		}
		for (const issuer of issuers) {
			if (issuer.id !== challengeRowId(issuer.source.name) || artifact.procedures?.[issuer.source.name]?.challenge?.provider !== 'altcha') {
				context.addIssue({ code: 'custom', path: ['endpoints'], message: `'${issuer.id}' issues the challenge of no ALTCHA procedure` })
			}
		}
		if (issuers.length > 0 && !artifact.reservedPrefixes.includes(CHALLENGE_PREFIX)) {
			context.addIssue({ code: 'custom', path: ['reservedPrefixes'], message: `an issuer row reserves ${CHALLENGE_PREFIX}` })
		}
		if ((artifact.csp.workerSrc !== undefined) !== issuers.length > 0) {
			context.addIssue({ code: 'custom', path: ['csp', 'workerSrc'], message: 'workerSrc admits the workers of an ALTCHA challenge, and only those' })
		}
	})
}

export const contractArtifactSchema: z.ZodType<ContractArtifact> = artifactSchemaOf(schemaShapeSchema)

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

/** Whether a stored artifact is in the shared encoding, which `parseEncodedArtifact` reads, rather than plain. */
export function isEncodedArtifact(value: unknown): boolean {
	return typeof value === 'object' && value !== null && 'encoding' in value
}

const encodedArtifactSchema = z.strictObject({ encoding: z.literal(SHARED_SHAPES_ENCODING), shapes: z.array(z.unknown()), artifact: z.unknown() })

/**
 * Parses an artifact in the shared encoding (`encodeArtifact`): each shared shape over the shapes written before it,
 * then the artifact over all of them. The result is the canonical artifact, its shared shapes one object each; throws a
 * `ZodError` naming every mismatch.
 */
export function parseEncodedArtifact(value: unknown): ContractArtifact {
	const encoded = encodedArtifactSchema.parse(value)
	const shapes: SchemaShape[] = []
	const shape = shapeSchemaOf(shapes)
	for (const written of encoded.shapes) {
		shapes.push(shape.parse(written))
	}
	return artifactSchemaOf(shape).parse(encoded.artifact)
}
