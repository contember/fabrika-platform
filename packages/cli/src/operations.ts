// The `fabrika operations` command area: Operations' issues, releases and health, read through the console's
// `/operations/api/rpc`, the typed RPC the console's Operations pages call. It is read-only: every command is a read
// procedure of `OperationsRpcContract`, and the area reaches no write.

import { createRpcClient, type InferRpcClient, RpcError, type RpcFetch } from '@fabrika/app'
import type { ConsoleAccessDto, ControlRpcContract } from '@fabrika/control-contract'
import { OPERATIONS_ACTIONS } from '@fabrika/operations-contract/access'
import type { ActivityItem, DisplayFrame, EventBreadcrumb, EventDetail, EventException } from '@fabrika/operations-contract/operator'
import type {
	OperationsEventDetailResponseDto,
	OperationsHealthCheckDto,
	OperationsHealthResponseDto,
	OperationsIssueDetailResponseDto,
	OperationsIssueListResponseDto,
	OperationsIssueOccurrenceDto,
	OperationsIssueSummaryDto,
	OperationsReleaseListResponseDto,
	OperationsReleaseSummaryDto,
	OperationsSourceHealthDto,
	OperationsSourceListResponseDto,
	OperationsSourceSummaryDto,
} from '@fabrika/operations-contract/operator-api'
import type { OperationsIssueQuery, OperationsReleaseQuery, OperationsRpcContract } from '@fabrika/operations-contract/rpc'
import { z } from 'zod'
import { controlTransport, withoutControlKey } from './control.js'
import { printable } from './data.js'

const USAGE = `fabrika operations — read Operations (errors, releases, health) from the command line

Usage:
  fabrika operations issues [--app=<id>] [--env=<env>] [--service=<key>] [--status=<open|resolved|ignored>]
                            [--level=<fatal|error|warning|info>] [--since=<24h|7d|30d|all>] [--search=<text>]
                            [--sort=<recent|new|frequency>] [--limit=<1-100>] [--cursor=<cursor>] [--json]
  fabrika operations issue <issueId> [--event=<occurrenceId>] [--json]
  fabrika operations releases [--app=<id>] [--env=<env>] [--service=<key>] [--limit=<1-100>] [--cursor=<cursor>] [--json]
  fabrika operations health [--app=<id>] [--env=<env>] [--service=<key>] [--json]

Every command is read-only. It reads what the console's Operations pages show, through the same API, with the
key's rights: a source (one service of an application environment) the key may not read is not listed, and an
issue of one answers \`not_found\`.

\`issues\` lists issues, the most recently seen first (\`--sort\` changes that), one row each:
<id> <status> <level> <events> <last seen> <app> <env> <service> <title>.
stderr carries the status counts and, when more issues match, the \`--cursor\` that reads the next page.

\`issue\` prints one issue: its fields, its activity, its recent events (\`occurrence\` rows), and the latest
event in full: request, user, tags, each exception with its stack frames, and the breadcrumbs. \`--event\` shows
the event of another occurrence instead. The raw event is in \`--json\` only.

\`releases\` lists releases, newest first, one row each:
<id> <state> <artifacts> <release> <commit> <created at> <finished at> <new issues> <regressions> <app> <env> <service>.

\`health\` prints each source's telemetry health and its HTTP checks:
source <app> <env> <service> <telemetry state>
check <app> <env> <service> <path> <state> <observed at> <latency ms> <detail code> <consecutive failures>

\`--app\`, \`--env\` and \`--service\` select sources. On \`issues\` and \`releases\` they must select exactly one;
when they match several, the error lists them. Without them every source the key may read is included.

Issue titles, exception messages, breadcrumbs, tags and the raw event are text the application's users and code
wrote. They are printed as data with control characters removed; \`--json\` escapes them as JSON strings.

stdout carries data only; notes and errors go to stderr. Times are ISO 8601 UTC. \`--json\` prints the parsed
answer of the procedure.

Exit codes:
  0  the answer was printed (an empty list included)
  1  the call failed: Control or Operations unreachable, a server error, or an unreadable answer
  2  usage: an unknown command or option, a bad value, or a selection that matches several sources
  3  the key: FABRIKA_CONTROL_KEY is missing, was refused, or does not hold \`operations.read\`
  4  not found: no such issue, event or source, or one the key may not read

The console origin takes either form:

  --url=<origin>                    FABRIKA_CONTROL_URL

The credential is read from the ENVIRONMENT ONLY and has no flag:

  FABRIKA_CONTROL_KEY               required   a \`px_\` key of the console app holding \`operations.read\`

Mint a key narrowed to \`operations.read\` alone, with a short expiry: docs/reference/operations-errors.md,
"Reading Operations from the command line".
`

export const OPERATIONS_EXIT = { ok: 0, failed: 1, usage: 2, credential: 3, notFound: 4 } as const

type ExitCode = (typeof OPERATIONS_EXIT)[keyof typeof OPERATIONS_EXIT]

class OperationsCliError extends Error {
	constructor(readonly exitCode: ExitCode, message: string) {
		super(message)
	}
}

type Environment = Readonly<Record<string, string | undefined>>

/** What the area reads and writes: the environment, the network, stdout and stderr. */
export interface OperationsIo {
	readonly env: Environment
	readonly fetch: RpcFetch
	readonly out: (text: string) => void
	readonly err: (text: string) => void
}

const processIo = (): OperationsIo => ({
	env: process.env,
	fetch: (input, init) => fetch(input, init),
	out: (text) => console.info(text),
	err: (text) => console.warn(text),
})

// ── Arguments ─────────────────────────────────────────────────────────────────────────────────────────────────────

const COMMAND_OPTIONS: Readonly<Record<string, readonly string[]>> = {
	issues: ['app', 'env', 'service', 'status', 'level', 'since', 'search', 'sort', 'limit', 'cursor'],
	issue: ['event'],
	releases: ['app', 'env', 'service', 'limit', 'cursor'],
	health: ['app', 'env', 'service'],
}

interface Args {
	readonly positional: readonly string[]
	readonly options: ReadonlyMap<string, string>
	readonly json: boolean
	readonly url: string | undefined
}

const usageError = (message: string): OperationsCliError => new OperationsCliError(OPERATIONS_EXIT.usage, message)

const parseArgs = (command: string, argv: readonly string[]): Args => {
	const allowed = COMMAND_OPTIONS[command] ?? []
	const positional: string[] = []
	const options = new Map<string, string>()
	let json = false
	let url: string | undefined
	for (const arg of argv) {
		if (arg === '--json') {
			json = true
			continue
		}
		if (!arg.startsWith('-')) {
			positional.push(arg)
			continue
		}
		const eq = arg.indexOf('=')
		const name = eq === -1 ? arg.replace(/^-+/, '') : arg.slice(2, eq)
		if (!arg.startsWith('--') || (name !== 'url' && !allowed.includes(name))) {
			throw usageError(`Unknown option for \`operations ${command}\`: ${arg}`)
		}
		if (eq === -1 || arg.slice(eq + 1) === '') throw usageError(`Option --${name} needs a value: --${name}=<value>`)
		if (name === 'url') url = arg.slice(eq + 1)
		else options.set(name, arg.slice(eq + 1))
	}
	return { positional, options, json, url }
}

const oneOf = <T extends string>(args: Args, name: string, allowed: readonly T[]): T | undefined => {
	const value = args.options.get(name)
	if (value === undefined) return undefined
	const match = allowed.find((candidate) => candidate === value)
	if (match === undefined) throw usageError(`--${name} is one of ${allowed.join(', ')}, not "${value}"`)
	return match
}

const pageLimit = (args: Args): number | undefined => {
	const value = args.options.get('limit')
	if (value === undefined) return undefined
	const limit = Number(value)
	if (!/^\d+$/.test(value) || limit < 1 || limit > 100) throw usageError(`--limit is a whole number from 1 to 100, not "${value}"`)
	return limit
}

interface SourceFilter {
	readonly app: string | undefined
	readonly env: string | undefined
	readonly service: string | undefined
}

const sourceFilter = (args: Args): SourceFilter => ({
	app: args.options.get('app'),
	env: args.options.get('env'),
	service: args.options.get('service'),
})

const filters = (filter: SourceFilter): boolean => filter.app !== undefined || filter.env !== undefined || filter.service !== undefined

const selects = (filter: SourceFilter, source: OperationsSourceSummaryDto): boolean =>
	(filter.app === undefined || source.appId === filter.app)
	&& (filter.env === undefined || source.environment === filter.env)
	&& (filter.service === undefined || source.serviceKey === filter.service)

const filterLabel = (filter: SourceFilter): string =>
	[
		filter.app === undefined ? null : `--app=${filter.app}`,
		filter.env === undefined ? null : `--env=${filter.env}`,
		filter.service === undefined
			? null
			: `--service=${filter.service}`,
	]
		.filter((part) => part !== null)
		.join(' ')

const noPositional = (command: string, args: Args): void => {
	if (args.positional.length > 0) throw usageError(`\`operations ${command}\` takes no argument: ${args.positional.join(' ')}`)
}

// ── Answers, parsed where they enter ──────────────────────────────────────────────────────────────────────────────
// Each schema projects the DTO's known fields: a field a newer Operations adds is dropped, never printed.

const unreadable = (what: string): OperationsCliError => new OperationsCliError(OPERATIONS_EXIT.failed, `Operations returned an unreadable ${what}`)

const parse = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown, what: string): T => {
	const parsed = schema.safeParse(value)
	if (!parsed.success) throw unreadable(what)
	return parsed.data
}

const time = z.number().finite()
const issueStatus = z.enum(['open', 'resolved', 'ignored'])

const sourceSchema: z.ZodType<OperationsSourceSummaryDto, z.ZodTypeDef, unknown> = z.object({
	id: z.string(),
	appId: z.string(),
	environment: z.string(),
	serviceKey: z.string(),
	displayName: z.string(),
	publicOrigin: z.string().nullable(),
	enabled: z.boolean(),
})

const sourceListSchema: z.ZodType<OperationsSourceListResponseDto, z.ZodTypeDef, unknown> = z.object({ items: z.array(sourceSchema) })

const issueSummaryFields = {
	id: z.string(),
	source: sourceSchema,
	title: z.string(),
	culprit: z.string().nullable(),
	level: z.string(),
	status: issueStatus,
	assignedTo: z.object({ id: z.string(), label: z.string().nullable() }).nullable(),
	regressedAt: time.nullable(),
	firstSeen: time,
	lastSeen: time,
	count: z.number().int().nonnegative(),
	trend: z.array(z.number()),
}

const issueSummarySchema: z.ZodType<OperationsIssueSummaryDto, z.ZodTypeDef, unknown> = z.object(issueSummaryFields)

const issueListSchema: z.ZodType<OperationsIssueListResponseDto, z.ZodTypeDef, unknown> = z.object({
	items: z.array(issueSummarySchema),
	nextCursor: z.string().nullable(),
	summary: z.object({
		total: z.number().int().nonnegative(),
		open: z.number().int().nonnegative(),
		resolved: z.number().int().nonnegative(),
		ignored: z.number().int().nonnegative(),
	}),
})

const occurrenceSchema: z.ZodType<OperationsIssueOccurrenceDto, z.ZodTypeDef, unknown> = z.object({
	id: z.string(),
	eventId: z.string(),
	receivedAt: time,
	release: z.string().nullable(),
})

const activitySchema: z.ZodType<ActivityItem, z.ZodTypeDef, unknown> = z.object({
	id: z.string(),
	kind: z.enum(['comment', 'status', 'assigned', 'regressed', 'snoozed', 'unsnoozed', 'merged']),
	actorLabel: z.string().nullable(),
	data: z.record(z.unknown()).nullable(),
	at: time,
})

const issueDetailSchema: z.ZodType<OperationsIssueDetailResponseDto, z.ZodTypeDef, unknown> = z.object({
	issue: z.object({
		...issueSummaryFields,
		snoozeUntil: time.nullable(),
		snoozeUntilCount: z.number().nullable(),
		resolvedInRelease: z.object({ id: z.string(), name: z.string() }).nullable(),
		mergedIntoIssueId: z.string().nullable(),
		activity: z.array(activitySchema),
		latestOccurrence: occurrenceSchema.nullable(),
		occurrences: z.array(occurrenceSchema),
		occurrencesNextCursor: z.string().nullable(),
	}),
})

const frameSchema: z.ZodType<DisplayFrame, z.ZodTypeDef, unknown> = z.object({
	file: z.string(),
	function: z.string().nullable(),
	line: z.number().nullable(),
	column: z.number().nullable(),
	inApp: z.boolean(),
	resolved: z.boolean(),
	source: z.object({ lines: z.array(z.string()), errorIndex: z.number(), startLine: z.number() }).optional(),
})

const exceptionSchema: z.ZodType<EventException, z.ZodTypeDef, unknown> = z.object({
	type: z.string().nullable(),
	value: z.string().nullable(),
	handled: z.boolean().nullable(),
	frames: z.array(frameSchema),
})

const breadcrumbSchema: z.ZodType<EventBreadcrumb, z.ZodTypeDef, unknown> = z.object({
	timestamp: z.union([z.number(), z.string()]).optional(),
	type: z.string().optional(),
	category: z.string().optional(),
	level: z.string().optional(),
	message: z.string().optional(),
})

const eventDetailSchema: z.ZodType<EventDetail, z.ZodTypeDef, unknown> = z.object({
	eventId: z.string().nullable(),
	platform: z.string().nullable(),
	release: z.string().nullable(),
	environment: z.string().nullable(),
	tags: z.array(z.object({ key: z.string(), value: z.string() })),
	request: z.object({ url: z.string().nullable(), method: z.string().nullable() }).nullable(),
	user: z.object({ id: z.string().nullable(), email: z.string().nullable(), username: z.string().nullable() }).nullable(),
	breadcrumbs: z.array(breadcrumbSchema),
	runtime: z.string().nullable(),
	os: z.string().nullable(),
	serverName: z.string().nullable(),
	traceId: z.string().nullable(),
	exceptions: z.array(exceptionSchema),
	rawEvent: z.string(),
})

const eventSchema: z.ZodType<OperationsEventDetailResponseDto, z.ZodTypeDef, unknown> = z.object({
	occurrenceId: z.string(),
	receivedAt: time,
	detail: eventDetailSchema,
})

const releaseSchema: z.ZodType<OperationsReleaseSummaryDto, z.ZodTypeDef, unknown> = z.object({
	id: z.string(),
	source: sourceSchema,
	runId: z.string(),
	commitSha: z.string(),
	state: z.string(),
	artifactState: z.enum(['pending', 'complete', 'incomplete', 'not_applicable']),
	releaseName: z.string(),
	createdAt: time,
	finishedAt: time.nullable(),
	newIssueCount: z.number().int().nonnegative(),
	regressionCount: z.number().int().nonnegative(),
})

const releaseListSchema: z.ZodType<OperationsReleaseListResponseDto, z.ZodTypeDef, unknown> = z.object({
	items: z.array(releaseSchema),
	nextCursor: z.string().nullable(),
})

const healthState = z.enum(['healthy', 'degraded', 'failed', 'stale', 'unavailable'])

const healthCheckSchema: z.ZodType<OperationsHealthCheckDto, z.ZodTypeDef, unknown> = z.object({
	id: z.string(),
	sourceId: z.string(),
	path: z.string(),
	enabled: z.boolean(),
	intervalMs: z.number(),
	timeoutMs: z.number(),
	expectedStatus: z.number(),
	failureThreshold: z.number(),
	recoveryThreshold: z.number(),
	staleAfterMs: z.number(),
	current: z.object({
		state: z.enum(['healthy', 'degraded', 'failed', 'stale']),
		observedAt: time,
		latencyMs: z.number().nullable(),
		detailCode: z.string(),
		consecutiveFailures: z.number().int().nonnegative(),
		consecutiveSuccesses: z.number().int().nonnegative(),
	}).nullable(),
	history: z.array(z.object({
		id: z.string(),
		state: healthState,
		observedAt: time,
		latencyMs: z.number().nullable(),
		detailCode: z.string().nullable(),
		successful: z.boolean(),
		statusCode: z.number().nullable(),
	})),
})

const sourceHealthSchema: z.ZodType<OperationsSourceHealthDto, z.ZodTypeDef, unknown> = z.object({
	source: sourceSchema,
	httpChecks: z.array(healthCheckSchema),
	telemetryState: healthState,
})

const healthSchema: z.ZodType<OperationsHealthResponseDto, z.ZodTypeDef, unknown> = z.object({ sources: z.array(sourceHealthSchema) })

const consoleAccessSchema: z.ZodType<ConsoleAccessDto, z.ZodTypeDef, unknown> = z.object({
	principal: z.object({ id: z.string(), label: z.string() }).nullable(),
	global: z.array(z.string()),
	scopes: z.array(z.object({ type: z.string(), value: z.string(), actions: z.array(z.string()) })),
})

// ── Output ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Operations' times are Unix milliseconds. */
const iso = (milliseconds: number): string => new Date(milliseconds).toISOString()

const isoOrDash = (milliseconds: number | null): string => milliseconds === null ? '-' : iso(milliseconds)

/** One cell of a row: untrusted text loses its control characters, and a tab or line break would split the row. */
const cell = (value: string | number | boolean | null | undefined): string => {
	if (value === null || value === undefined || value === '') return '-'
	return printable(String(value)).replace(/[\t\n]+/g, ' ')
}

const row = (...cells: readonly (string | number | boolean | null | undefined)[]): string => cells.map(cell).join('\t')

const sourceCells = (source: OperationsSourceSummaryDto): string[] => [source.appId, source.environment, source.serviceKey]

const issueRow = (issue: OperationsIssueSummaryDto): string =>
	row(issue.id, issue.status, issue.level, issue.count, iso(issue.lastSeen), ...sourceCells(issue.source), issue.title)

const releaseRow = (release: OperationsReleaseSummaryDto): string =>
	row(
		release.id,
		release.state,
		release.artifactState,
		release.releaseName,
		release.commitSha,
		iso(release.createdAt),
		isoOrDash(release.finishedAt),
		release.newIssueCount,
		release.regressionCount,
		...sourceCells(release.source),
	)

const checkState = (check: OperationsHealthCheckDto): string => !check.enabled ? 'disabled' : check.current?.state ?? 'pending'

const healthLines = (health: OperationsSourceHealthDto): string[] => [
	row('source', ...sourceCells(health.source), health.telemetryState),
	...health.httpChecks.map((check) =>
		row(
			'check',
			...sourceCells(health.source),
			check.path,
			checkState(check),
			isoOrDash(check.current?.observedAt ?? null),
			check.current?.latencyMs,
			check.current?.detailCode,
			check.current?.consecutiveFailures ?? 0,
		)
	),
]

const frameLocation = (frame: DisplayFrame): string => [frame.file, frame.line, frame.column].filter((part) => part !== null).join(':')

const eventLines = (event: OperationsEventDetailResponseDto): string[] => {
	const detail = event.detail
	return [
		row('event', event.occurrenceId, iso(event.receivedAt), detail.eventId),
		row('release', detail.release),
		row('environment', detail.environment),
		row('platform', detail.platform),
		row('runtime', detail.runtime),
		row('os', detail.os),
		row('server', detail.serverName),
		row('trace', detail.traceId),
		...(detail.request === null ? [] : [row('request', detail.request.method, detail.request.url)]),
		...(detail.user === null ? [] : [row('user', detail.user.id, detail.user.username, detail.user.email)]),
		...detail.tags.map((tag) => row('tag', tag.key, tag.value)),
		...detail.exceptions.flatMap((exception) => [
			row('exception', exception.type, exception.handled === null ? null : exception.handled ? 'handled' : 'unhandled', exception.value),
			...exception.frames.map((frame) => row('frame', frameLocation(frame), frame.function, frame.inApp ? 'app' : 'library')),
		]),
		...detail.breadcrumbs.map((crumb) => row('breadcrumb', crumb.timestamp, crumb.level, crumb.category ?? crumb.type, crumb.message)),
	]
}

const issueLines = (detail: OperationsIssueDetailResponseDto, event: OperationsEventDetailResponseDto | null): string[] => {
	const issue = detail.issue
	return [
		row('id', issue.id),
		row('title', issue.title),
		row('culprit', issue.culprit),
		row('status', issue.status),
		row('level', issue.level),
		row('source', ...sourceCells(issue.source)),
		row('events', issue.count),
		row('firstSeen', iso(issue.firstSeen)),
		row('lastSeen', iso(issue.lastSeen)),
		row('regressedAt', isoOrDash(issue.regressedAt)),
		row('assignedTo', issue.assignedTo?.label ?? issue.assignedTo?.id),
		row('snoozeUntil', isoOrDash(issue.snoozeUntil)),
		row('snoozeUntilCount', issue.snoozeUntilCount),
		row('resolvedInRelease', issue.resolvedInRelease?.name),
		row('mergedInto', issue.mergedIntoIssueId),
		...issue.activity.map((item) => row('activity', iso(item.at), item.kind, item.actorLabel, item.data === null ? null : JSON.stringify(item.data))),
		...issue.occurrences.map((occurrence) => row('occurrence', occurrence.id, iso(occurrence.receivedAt), occurrence.eventId, occurrence.release)),
		...(event === null ? [] : eventLines(event)),
	]
}

// ── Calls ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Clients {
	readonly operations: InferRpcClient<OperationsRpcContract>
	readonly control: InferRpcClient<ControlRpcContract>
}

const connect = (args: Args, io: OperationsIo): Clients => {
	const key = io.env['FABRIKA_CONTROL_KEY']
	if (key === undefined || key.trim() === '') {
		throw new OperationsCliError(OPERATIONS_EXIT.credential, 'FABRIKA_CONTROL_KEY is required (environment only — it has no flag).')
	}
	let transport: ReturnType<typeof controlTransport>
	try {
		transport = controlTransport(args.url, io.env, io.fetch)
	} catch (error) {
		throw usageError(error instanceof Error ? error.message : String(error))
	}
	return {
		operations: createRpcClient<OperationsRpcContract>({ baseUrl: `${transport.origin}/operations/api/rpc`, fetch: transport.fetch }),
		control: createRpcClient<ControlRpcContract>({ baseUrl: `${transport.origin}/api/rpc`, fetch: transport.fetch }),
	}
}

/**
 * Operations answers a key without `operations.read` with empty lists, as it answers a key scoped elsewhere. The
 * console's own navigation asks Control which actions the caller holds; so does this, to tell the two apart.
 */
const requireRead = async (clients: Clients): Promise<void> => {
	const access = parse(consoleAccessSchema, await clients.control.consoleAccess(), 'console access')
	const read = OPERATIONS_ACTIONS.READ
	if (access.global.includes(read) || access.scopes.some((scope) => scope.actions.includes(read))) return
	throw new OperationsCliError(
		OPERATIONS_EXIT.credential,
		`FABRIKA_CONTROL_KEY does not hold ${read} in any scope. Use a key of the console app narrowed to ${read}; see \`fabrika operations --help\`.`,
	)
}

/** The one source `filter` selects, or none when it selects nothing in particular. */
const selectedSource = async (clients: Clients, filter: SourceFilter): Promise<OperationsSourceSummaryDto | undefined> => {
	if (!filters(filter)) return undefined
	const sources = parse(sourceListSchema, await clients.operations.sources(), 'source list').items.filter((source) => selects(filter, source))
	const [only, ...others] = sources
	if (only === undefined) {
		throw new OperationsCliError(OPERATIONS_EXIT.notFound, `No Operations source matches ${filterLabel(filter)}, or the key may not read it`)
	}
	if (others.length > 0) {
		const listed = sources.map((source) => `  ${row(...sourceCells(source))}`).join('\n')
		throw usageError(`${filterLabel(filter)} matches ${sources.length} sources; add --env or --service to pick one:\n${listed}`)
	}
	return only
}

const emit = (args: Args, io: OperationsIo, result: unknown, lines: () => readonly string[]): void => {
	if (args.json) {
		io.out(JSON.stringify(result, null, 2))
		return
	}
	const text = lines()
	if (text.length > 0) io.out(text.join('\n'))
}

const note = (io: OperationsIo, text: string): void => io.err(printable(text))

const runIssues = async (args: Args, io: OperationsIo): Promise<void> => {
	noPositional('issues', args)
	const status = oneOf(args, 'status', ['open', 'resolved', 'ignored'] as const)
	const level = oneOf(args, 'level', ['fatal', 'error', 'warning', 'info'] as const)
	const window = oneOf(args, 'since', ['24h', '7d', '30d', 'all'] as const)
	const sort = oneOf(args, 'sort', ['recent', 'new', 'frequency'] as const)
	const limit = pageLimit(args)
	const search = args.options.get('search')
	const cursor = args.options.get('cursor')
	const clients = connect(args, io)
	await requireRead(clients)
	const source = await selectedSource(clients, sourceFilter(args))
	const query: OperationsIssueQuery = {
		...(source === undefined ? {} : { sourceId: source.id }),
		...(status === undefined ? {} : { status }),
		...(level === undefined ? {} : { level }),
		...(window === undefined ? {} : { window }),
		...(search === undefined ? {} : { query: search }),
		...(sort === undefined ? {} : { sort }),
		...(cursor === undefined ? {} : { cursor }),
		...(limit === undefined ? {} : { limit }),
	}
	const page = parse(issueListSchema, await clients.operations.issues(query), 'issue list')
	const { summary } = page
	note(io, `${summary.total} matching issues: ${summary.open} open, ${summary.resolved} resolved, ${summary.ignored} ignored`)
	if (page.nextCursor !== null) note(io, `more issues match; the next page: --cursor=${page.nextCursor}`)
	emit(args, io, page, () => page.items.map(issueRow))
}

const runIssue = async (args: Args, io: OperationsIo): Promise<void> => {
	const [issueId, ...extra] = args.positional
	if (issueId === undefined || issueId.trim() === '' || extra.length > 0) {
		throw usageError('Usage: fabrika operations issue <issueId> [--event=<occurrenceId>] [--json]')
	}
	const occurrenceId = args.options.get('event')
	const clients = connect(args, io)
	await requireRead(clients)
	const detail = parse(issueDetailSchema, await clients.operations.issue({ issueId }), 'issue')
	let event: OperationsEventDetailResponseDto | null = null
	if (occurrenceId !== undefined) {
		event = parse(eventSchema, await clients.operations.event({ issueId, occurrenceId }), 'event')
	} else if (detail.issue.latestOccurrence !== null) {
		try {
			event = parse(eventSchema, await clients.operations.latestEvent({ issueId }), 'event')
		} catch (error) {
			// The issue was readable a moment ago, so a missing latest event is a payload no longer stored.
			if (!(error instanceof RpcError) || error.httpStatus !== 404) throw error
			note(io, 'the latest event is no longer stored')
		}
	}
	if (detail.issue.occurrencesNextCursor !== null) {
		note(io, `showing the ${detail.issue.occurrences.length} most recent events of ${detail.issue.count}`)
	}
	emit(args, io, { ...detail, event }, () => issueLines(detail, event))
}

const runReleases = async (args: Args, io: OperationsIo): Promise<void> => {
	noPositional('releases', args)
	const limit = pageLimit(args)
	const cursor = args.options.get('cursor')
	const clients = connect(args, io)
	await requireRead(clients)
	const source = await selectedSource(clients, sourceFilter(args))
	const query: OperationsReleaseQuery = {
		...(source === undefined ? {} : { sourceId: source.id }),
		...(cursor === undefined ? {} : { cursor }),
		...(limit === undefined ? {} : { limit }),
	}
	const page = parse(releaseListSchema, await clients.operations.releases(query), 'release list')
	if (page.items.length === 0) note(io, 'no releases')
	if (page.nextCursor !== null) note(io, `more releases exist; the next page: --cursor=${page.nextCursor}`)
	emit(args, io, page, () => page.items.map(releaseRow))
}

const runHealth = async (args: Args, io: OperationsIo): Promise<void> => {
	noPositional('health', args)
	const filter = sourceFilter(args)
	const clients = connect(args, io)
	await requireRead(clients)
	const health = parse(healthSchema, await clients.operations.health(), 'health answer')
	const sources = health.sources.filter((entry) => selects(filter, entry.source))
	if (sources.length === 0) {
		if (filters(filter)) {
			throw new OperationsCliError(OPERATIONS_EXIT.notFound, `No Operations source matches ${filterLabel(filter)}, or the key may not read it`)
		}
		note(io, 'no Operations source is visible to this key')
	}
	emit(args, io, { sources }, () => sources.flatMap(healthLines))
}

const COMMANDS: Readonly<Record<string, (args: Args, io: OperationsIo) => Promise<void>>> = {
	issues: runIssues,
	issue: runIssue,
	releases: runReleases,
	health: runHealth,
}

/** An RPC refusal mapped to its exit code; the type and message are the server's, cleaned before they print. */
const rpcFailure = (error: RpcError): OperationsCliError => {
	const said = `${error.type}: ${error.message}`
	if (error.httpStatus === 401) {
		return new OperationsCliError(OPERATIONS_EXIT.credential, `The console refused FABRIKA_CONTROL_KEY (unknown, expired or revoked) — ${said}`)
	}
	if (error.httpStatus === 403) return new OperationsCliError(OPERATIONS_EXIT.credential, `FABRIKA_CONTROL_KEY may not make this call — ${said}`)
	if (error.httpStatus === 404 || error.type === 'not_found') {
		return new OperationsCliError(OPERATIONS_EXIT.notFound, `Not found, or the key may not read it — ${said}`)
	}
	if (error.httpStatus === 400) return usageError(said)
	return new OperationsCliError(OPERATIONS_EXIT.failed, said)
}

/** Runs one command and returns its exit code; every diagnostic goes to stderr with the key cut out. */
export const runOperationsCli = async (command: string | undefined, argv: readonly string[], io: OperationsIo = processIo()): Promise<number> => {
	if (command === undefined) {
		io.out(USAGE)
		return OPERATIONS_EXIT.ok
	}
	try {
		const run = COMMANDS[command]
		if (run === undefined) throw usageError(`Unknown operations command: ${command}\n\n${USAGE}`)
		await run(parseArgs(command, argv), io)
		return OPERATIONS_EXIT.ok
	} catch (error) {
		const failure = error instanceof OperationsCliError
			? error
			: error instanceof RpcError
			? rpcFailure(error)
			: new OperationsCliError(OPERATIONS_EXIT.failed, error instanceof Error ? error.message : String(error))
		io.err(`fabrika: ${printable(withoutControlKey(failure.message, io.env))}`)
		return failure.exitCode
	}
}

export { USAGE as OPERATIONS_USAGE }
