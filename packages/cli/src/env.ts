// The `fabrika env` command area: an application environment's data as Control serves it (ADR-0068). Every command is
// one `data.*` procedure of `ControlRpcContract`, reached as `fabrika control` reaches Control: the same typed client,
// the origin from `--url` or FABRIKA_CONTROL_URL, the key from FABRIKA_CONTROL_KEY in the environment only.

import { createRpcClient, type InferRpcClient, RpcError } from '@fabrika/app'
import { OPS_ROW_COUNT_CAP, type OpsContentView, type OpsView, parseOpsContentView, parseOpsView } from '@fabrika/auth-core'
import type { ControlRpcContract, DataOperationDto } from '@fabrika/control-contract'
import { z } from 'zod'

const USAGE = `fabrika env — an application environment's data, through the control plane

Usage:
  fabrika env inspect <app> <env> [--content] [--json]
  fabrika env maintenance <app> <env> <open|read-only|closed> [--json]
  fabrika env operations <app> <env> [--json]
  fabrika env recover <app> <env> <operationId> <resume|open> [--json]

\`inspect\` prints the environment's data view: the object's maintenance mode and generation, the database size and
each table's row count (a count at ${OPS_ROW_COUNT_CAP} reads \`${OPS_ROW_COUNT_CAP}+\`: it is capped), the applied migrations,
the scheduler's alarm, each job's last run, file and webhook counts, and when the application last failed to boot.
It needs \`data.read\`. \`--content\` adds the boot failure's message and stack, which are the application's own text,
and needs \`data.content.read\` granted globally.

\`maintenance\` puts the environment into a mode: \`read-only\` refuses writes, \`closed\` refuses every request, and
\`open\` serves again. It starts a data operation and prints it; \`operations\` follows it. It needs \`data.manage\`.

\`operations\` lists the environment's data operations, newest first, one row each:
<id> <kind> <state> <step> <target mode> <generation> <error code> <created at>.

\`recover\` fences an environment whose operation is stuck in \`closed\` at a fresh generation, then \`resume\`s that
operation from its recorded step, or \`open\`s the environment. A failed operation can only be opened past. It needs
\`data.manage\`.

A release of the control plane that does not offer a command answers that it is not available; retrying does not
change that. An environment the caller may not see answers \`not_found\`, as one that does not exist.

stdout carries data only; progress and follow-up commands go to stderr. \`--json\` prints the result as JSON.

The control origin takes either form:

  --url=<origin>                    FABRIKA_CONTROL_URL

The credential is read from the ENVIRONMENT ONLY and has no flag:

  FABRIKA_CONTROL_KEY               required   a machine \`px_\` credential for the control app
`

type Environment = Readonly<Record<string, string | undefined>>

interface EnvArgs {
	readonly positional: readonly string[]
	readonly json: boolean
	readonly content: boolean
	readonly url: string | undefined
}

const COMMAND_FORMS: Readonly<Record<string, string>> = {
	inspect: '<app> <env> [--content] [--json]',
	maintenance: '<app> <env> <open|read-only|closed> [--json]',
	operations: '<app> <env> [--json]',
	recover: '<app> <env> <operationId> <resume|open> [--json]',
}

const parseEnvArgs = (argv: readonly string[]): EnvArgs => {
	const positional: string[] = []
	let json = false
	let content = false
	let url: string | undefined
	for (const arg of argv) {
		if (arg === '--json') json = true
		else if (arg === '--content') content = true
		else if (arg.startsWith('--url=')) url = arg.slice('--url='.length)
		else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
		else positional.push(arg)
	}
	return { positional, json, content, url }
}

/** The positional words of `command`, exactly `count` of them. */
const words = (command: string, args: EnvArgs, count: number): readonly string[] => {
	if (args.positional.length !== count || args.positional.some((word) => word.trim() === '')) {
		throw new Error(`Usage: fabrika env ${command} ${COMMAND_FORMS[command] ?? ''}`)
	}
	return args.positional
}

type ControlClient = InferRpcClient<ControlRpcContract>

const controlClient = (args: EnvArgs, env: Environment): ControlClient => {
	const origin = args.url ?? env['FABRIKA_CONTROL_URL']
	if (origin === undefined || origin.trim() === '') {
		throw new Error('Control origin is required. Pass --url=<origin> or set FABRIKA_CONTROL_URL.')
	}
	const key = env['FABRIKA_CONTROL_KEY']
	if (key === undefined || key.trim() === '') {
		throw new Error('FABRIKA_CONTROL_KEY is required (environment only — it has no flag).')
	}
	const bearer = `Bearer ${key.trim()}`
	return createRpcClient<ControlRpcContract>({
		baseUrl: `${origin.trim().replace(/\/+$/, '')}/api/rpc`,
		fetch: (input, init) => {
			const headers = new Headers(init?.headers)
			headers.set('authorization', bearer)
			// A redirect would carry the bearer to wherever it points.
			return fetch(input, { ...init, headers, redirect: 'manual' })
		},
	})
}

// Passthrough on purpose: `--json` shows the operator a field a newer Control adds to the record.
const dataOperationSchema: z.ZodType<DataOperationDto> = z.object({
	id: z.string(),
	appId: z.string(),
	env: z.string(),
	kind: z.enum(['maintenance', 'backup', 'migrate', 'recovery', 'restore']),
	step: z.enum(['reconcile', 'restrict', 'backup', 'verify', 'deploy', 'migrate', 'resume', 'open']),
	targetMode: z.enum(['open', 'read-only', 'closed', 'inspect']),
	generation: z.number().int().nonnegative(),
	state: z.enum(['running', 'succeeded', 'failed']),
	errorCode: z.string().nullable(),
	actor: z.string(),
	createdAt: z.number().int().nonnegative(),
	updatedAt: z.number().int().nonnegative(),
	finishedAt: z.number().int().nonnegative().nullable(),
	recoversOperationId: z.string().nullable(),
	resolution: z.enum(['resume', 'open']).nullable(),
}).passthrough()

const dataOperationPageSchema = z.object({ items: z.array(dataOperationSchema), nextCursor: z.string().nullable() })

const parseOperation = (value: unknown): DataOperationDto => {
	const parsed = dataOperationSchema.safeParse(value)
	if (!parsed.success) throw new Error('Control returned an unreadable data operation')
	return parsed.data
}

const MAINTENANCE_MODES = ['open', 'read-only', 'closed'] as const
const RESOLUTIONS = ['resume', 'open'] as const

const oneOf = <T extends string>(value: string, allowed: readonly T[]): T | undefined => allowed.find((candidate) => candidate === value)

/** Control's timestamps are Unix seconds. */
const isoSeconds = (seconds: number): string => new Date(seconds * 1000).toISOString()

const operationLine = (operation: DataOperationDto): string =>
	[
		operation.id,
		operation.kind,
		operation.state,
		operation.step,
		operation.targetMode,
		String(operation.generation),
		operation.errorCode ?? '-',
		isoSeconds(operation.createdAt),
	].join('\t')

/** Every control character but tab and line feed: the application's text must not drive the operator's terminal. */
const printable = (text: string): string => text.replace(/[^\P{Cc}\t\n]/gu, '')

const viewLines = (view: OpsView | OpsContentView): string[] => [
	`release\t${view.release}`,
	`mode\t${view.maintenance.mode}`,
	`generation\t${view.maintenance.generation ?? '-'}`,
	`published\t${view.maintenance.published ? 'yes' : 'no'}`,
	`databaseBytes\t${view.database.sizeBytes}`,
	...view.database.tables.map((table) => `table\t${table.name}\t${table.rows >= OPS_ROW_COUNT_CAP ? `${OPS_ROW_COUNT_CAP}+` : table.rows}`),
	...view.migrations.map((migration) => `migration\t${migration.bundle}\t${migration.name}\t${migration.appliedAt}`),
	`alarm\t${view.scheduler.alarm ?? '-'}`,
	...view.jobs.map((job) =>
		`job\t${job.job}\t${job.lastStatus ?? '-'}\t${job.lastStartedAt ?? '-'}\t${job.lastFinishedAt ?? '-'}\t${job.lastDurationMs ?? '-'}`
	),
	...view.files.map((file) => `file\t${file.kind}\t${file.status}\t${file.count}`),
	...view.webhooks.map((webhook) => `webhook\t${webhook.webhook}\t${webhook.state}\t${webhook.count}`),
	`bootFailure\t${view.bootFailure?.at ?? '-'}`,
]

const contentLines = (view: OpsContentView): string[] => {
	const failure = view.bootFailure
	if (failure === null) return viewLines(view)
	return [...viewLines(view), '', printable(failure.message), ...(failure.stack === null ? [] : [printable(failure.stack)])]
}

const emit = (args: EnvArgs, result: unknown, render: () => string): void => {
	console.info(args.json ? JSON.stringify(result, null, 2) : render())
}

/** An operation is an answer whatever its state; stderr names what follows it. */
const emitOperation = (args: EnvArgs, operation: DataOperationDto): void => {
	const coordinates = `${operation.appId} ${operation.env}`
	if (operation.state === 'running') console.warn(`follow it: fabrika env operations ${coordinates}`)
	if (operation.state === 'failed') console.warn(`open the environment past it: fabrika env recover ${coordinates} ${operation.id} open`)
	emit(args, operation, () => operationLine(operation))
}

const runInspect = async (args: EnvArgs, env: Environment): Promise<void> => {
	const [appId = '', environment = ''] = words('inspect', args, 2)
	const client = controlClient(args, env)
	if (args.content) {
		const view = parseOpsContentView(await client.data.content({ appId, env: environment }))
		if (view === null) throw new Error('Control returned an unreadable data view')
		emit(args, view, () => contentLines(view).join('\n'))
		return
	}
	const view = parseOpsView(await client.data.view({ appId, env: environment }))
	if (view === null) throw new Error('Control returned an unreadable data view')
	emit(args, view, () => viewLines(view).join('\n'))
}

const runMaintenance = async (args: EnvArgs, env: Environment): Promise<void> => {
	const [appId = '', environment = '', requested = ''] = words('maintenance', args, 3)
	const mode = oneOf(requested, MAINTENANCE_MODES)
	if (mode === undefined) throw new Error(`The mode is one of ${MAINTENANCE_MODES.join(', ')}, not "${requested}"`)
	const result = await controlClient(args, env).data.start({ appId, env: environment, kind: 'maintenance', mode })
	emitOperation(args, parseOperation(result))
}

const runOperations = async (args: EnvArgs, env: Environment): Promise<void> => {
	const [appId = '', environment = ''] = words('operations', args, 2)
	const parsed = dataOperationPageSchema.safeParse(await controlClient(args, env).data.operations.list({ appId, env: environment }))
	if (!parsed.success) throw new Error('Control returned an unreadable list of data operations')
	const page = parsed.data
	if (page.nextCursor !== null) console.warn(`showing the newest ${page.items.length} operations; older ones exist`)
	if (!args.json && page.items.length === 0) {
		console.warn(`${appId} ${environment} has no data operations`)
		return
	}
	emit(args, page, () => page.items.map(operationLine).join('\n'))
}

const runRecover = async (args: EnvArgs, env: Environment): Promise<void> => {
	const [appId = '', environment = '', operationId = '', requested = ''] = words('recover', args, 4)
	const resolution = oneOf(requested, RESOLUTIONS)
	if (resolution === undefined) throw new Error(`The resolution is resume or open, not "${requested}"`)
	const result = await controlClient(args, env).data.recover({ appId, env: environment, operationId, resolution })
	emitOperation(args, parseOperation(result))
}

const commandRun = (command: string): ((args: EnvArgs, env: Environment) => Promise<void>) | undefined => {
	switch (command) {
		case 'inspect':
			return runInspect
		case 'maintenance':
			return runMaintenance
		case 'operations':
			return runOperations
		case 'recover':
			return runRecover
		default:
			return undefined
	}
}

export const runEnvCli = async (command: string | undefined, argv: readonly string[], env: Environment = process.env): Promise<void> => {
	if (command === undefined) {
		console.info(USAGE)
		return
	}
	const run = commandRun(command)
	if (run === undefined) throw new Error(`Unknown env command: ${command}\n\n${USAGE}`)
	const args = parseEnvArgs(argv)
	if (args.content && command !== 'inspect') throw new Error('--content applies to `env inspect` only')
	try {
		await run(args, env)
	} catch (error) {
		if (!(error instanceof RpcError)) throw error
		// Not offered by this release: a definite answer, unlike an outage, so nothing suggests trying again.
		if (error.httpStatus === 501) {
			throw new Error(`\`env ${command}\` is not available in this release of the control plane; retrying will not change that`)
		}
		// A refusal is an answer, not a transport fault: its type tells "Control said no" from "Control was unreachable".
		throw new Error(`${error.type}: ${error.message}`)
	}
}

export { USAGE as ENV_USAGE }
