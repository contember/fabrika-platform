// The `fabrika env` command area: an application environment's data as Control serves it (ADR-0069). Every command is
// one `data.*` procedure of `ControlRpcContract`, reached through the client `fabrika control` uses (`connectControl`).

import { RpcError } from '@fabrika/app'
import {
	OPS_ROW_COUNT_CAP,
	type OpsContentView,
	type OpsView,
	parseApplicationObjectName,
	parseOpsContentView,
	parseOpsView,
} from '@fabrika/auth-core'
import { type DataBackupDto, type DataBackupScheduleDto, type DataOperationDto, startDataOperationInputSchema } from '@fabrika/control-contract'
import { z } from 'zod'
import { connectControl, type ControlClient, withoutControlKey } from './control.js'

const USAGE = `fabrika env — an application environment's data, through the control plane

Usage:
  fabrika env inspect <app> <env> [--content] [--json]
  fabrika env maintenance <app> <env> <open|read-only|closed> [--json]
  fabrika env operations <app> <env> [--json]
  fabrika env recover <app> <env> <operationId> <resume|open> [--json]
  fabrika env backups <app> <env> [--json]
  fabrika env backups schedule <app> <env> [on|off] [--json]
  fabrika env restore <app> <env> --at=<time> [--json]

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

\`backups\` lists the environment's consistent backups, newest first, one row each:
<id> <object> <state> <created at> <size bytes> <parts> <tables> <rehearsal> <rehearsal code> <error code> <expired>.
A backup counts as \`succeeded\` only once its rehearsal, an import into a scratch object, passed. One older than 30
days is \`expired\` and never offered for a restore. It needs \`data.read\`.

\`backups schedule\` prints whether the environment takes a daily backup; \`on\` or \`off\` sets it, which needs
\`data.manage\`. Turning it off stops the daily backup only: the backup before a migration still runs.

\`restore\` brings back the environment's data as it was at \`--at\`, an ISO 8601 time with an offset in the past. It
is a side restore: the serving object is frozen read-only and backed up, the backup is imported into a new clone
object, ordinary traffic is pointed at the clone, which serves the current data from then on, and the original is
rewound to that time and kept in \`inspect\`, serving nothing, for inspection. It starts a data operation and prints
it; \`operations\` follows it. It needs \`data.manage\`.

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
	/** \`''\` when \`--at\` closes the arguments with no time after it. */
	readonly at: string | undefined
}

const COMMAND_FORMS: Readonly<Record<string, string>> = {
	inspect: '<app> <env> [--content] [--json]',
	maintenance: '<app> <env> <open|read-only|closed> [--json]',
	operations: '<app> <env> [--json]',
	recover: '<app> <env> <operationId> <resume|open> [--json]',
	backups: '<app> <env> [--json]',
	'backups schedule': '<app> <env> [on|off] [--json]',
	restore: '<app> <env> --at=<time> [--json]',
}

const parseEnvArgs = (argv: readonly string[]): EnvArgs => {
	const positional: string[] = []
	let json = false
	let content = false
	let url: string | undefined
	let at: string | undefined
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] ?? ''
		if (arg === '--json') json = true
		else if (arg === '--content') content = true
		else if (arg.startsWith('--url=')) url = arg.slice('--url='.length)
		else if (arg.startsWith('--at=')) at = arg.slice('--at='.length)
		else if (arg === '--at') at = argv[++index] ?? ''
		else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
		else positional.push(arg)
	}
	return { positional, json, content, url, at }
}

/** The positional words of `command`, exactly `count` of them. */
const words = (command: string, args: EnvArgs, count: number): readonly string[] => {
	if (args.positional.length !== count || args.positional.some((word) => word.trim() === '')) throw usage(command)
	return args.positional
}

const usage = (command: string): Error => new Error(`Usage: fabrika env ${command} ${COMMAND_FORMS[command] ?? ''}`)

const controlClient = (args: EnvArgs, env: Environment): ControlClient => connectControl(args.url, env)

/** Control's own rule for an operation's or a backup's error code (`db/data-operations.ts`, `db/backups.ts`). */
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/

/** The known fields of an operation, validated; a field a newer Control adds is dropped, never printed. */
const dataOperationSchema: z.ZodType<DataOperationDto> = z.object({
	id: z.string().uuid(),
	appId: z.string(),
	env: z.string(),
	kind: z.enum(['maintenance', 'backup', 'migrate', 'recovery', 'restore']),
	step: z.enum([
		'reconcile',
		'restrict',
		'backup',
		'verify',
		'deploy',
		'migrate',
		'resume',
		'open',
		'list',
		'import',
		'promote',
		'point',
		'serve',
		'rewind',
		'check',
		'revert',
	]),
	targetMode: z.enum(['open', 'read-only', 'closed', 'inspect']),
	generation: z.number().int().nonnegative(),
	state: z.enum(['running', 'succeeded', 'failed']),
	errorCode: z.string().regex(ERROR_CODE).nullable(),
	actor: z.string(),
	createdAt: z.number().int().nonnegative(),
	updatedAt: z.number().int().nonnegative(),
	finishedAt: z.number().int().nonnegative().nullable(),
	recoversOperationId: z.string().uuid().nullable(),
	resolution: z.enum(['resume', 'open']).nullable(),
})

interface Target {
	readonly appId: string
	readonly env: string
}

/** An answer about the environment asked about, and of no other. */
const ofTarget = (answer: Target, target: Target): boolean => answer.appId === target.appId && answer.env === target.env

const parseOperation = (value: unknown, target: Target): DataOperationDto => {
	const parsed = dataOperationSchema.safeParse(value)
	if (!parsed.success || !ofTarget(parsed.data, target)) throw new Error('Control returned an unreadable data operation')
	return parsed.data
}

const dataOperationPageSchema = z.object({ items: z.array(dataOperationSchema), nextCursor: z.string().uuid().nullable() })

const parseOperationPage = (value: unknown, target: Target): { items: DataOperationDto[]; nextCursor: string | null } => {
	const parsed = dataOperationPageSchema.safeParse(value)
	if (!parsed.success || !parsed.data.items.every((operation) => ofTarget(operation, target))) {
		throw new Error('Control returned an unreadable list of data operations')
	}
	return parsed.data
}

/** The known fields of a backup, validated as an operation's are. */
const dataBackupSchema: z.ZodType<DataBackupDto> = z.object({
	id: z.string().uuid(),
	appId: z.string(),
	env: z.string(),
	operationId: z.string().uuid(),
	object: z.string().refine((name) => parseApplicationObjectName(name) !== null),
	state: z.enum(['running', 'succeeded', 'failed']),
	errorCode: z.string().regex(ERROR_CODE).nullable(),
	createdAt: z.number().int().nonnegative(),
	finishedAt: z.number().int().nonnegative().nullable(),
	bookmark: z.string().nullable(),
	sizeBytes: z.number().int().nonnegative().nullable(),
	parts: z.number().int().nonnegative().nullable(),
	tables: z.number().int().nonnegative().nullable(),
	rehearsal: z.enum(['pending', 'passed', 'failed']),
	rehearsalCode: z.string().regex(ERROR_CODE).nullable(),
	expired: z.boolean(),
})

const dataBackupPageSchema = z.object({ items: z.array(dataBackupSchema), nextCursor: z.string().uuid().nullable() })

const parseBackupPage = (value: unknown, target: Target): { items: DataBackupDto[]; nextCursor: string | null } => {
	const parsed = dataBackupPageSchema.safeParse(value)
	if (!parsed.success || !parsed.data.items.every((backup) => ofTarget(backup, target))) {
		throw new Error('Control returned an unreadable list of backups')
	}
	return parsed.data
}

const dataBackupScheduleSchema: z.ZodType<DataBackupScheduleDto> = z.object({
	appId: z.string(),
	env: z.string(),
	daily: z.boolean(),
	updatedAt: z.number().int().nonnegative().nullable(),
})

const parseSchedule = (value: unknown, target: Target): DataBackupScheduleDto => {
	const parsed = dataBackupScheduleSchema.safeParse(value)
	if (!parsed.success || !ofTarget(parsed.data, target)) throw new Error('Control returned an unreadable backup schedule')
	return parsed.data
}

const MAINTENANCE_MODES = ['open', 'read-only', 'closed'] as const
const RESOLUTIONS = ['resume', 'open'] as const
const SCHEDULE_SWITCHES = ['on', 'off'] as const

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

const backupLine = (backup: DataBackupDto): string =>
	[
		backup.id,
		backup.object,
		backup.state,
		isoSeconds(backup.createdAt),
		backup.sizeBytes === null ? '-' : String(backup.sizeBytes),
		backup.parts === null ? '-' : String(backup.parts),
		backup.tables === null ? '-' : String(backup.tables),
		backup.rehearsal,
		backup.rehearsalCode ?? '-',
		backup.errorCode ?? '-',
		backup.expired ? 'expired' : '-',
	].join('\t')

const scheduleLines = (schedule: DataBackupScheduleDto): string =>
	[`daily\t${schedule.daily ? 'on' : 'off'}`, `updatedAt\t${schedule.updatedAt === null ? '-' : isoSeconds(schedule.updatedAt)}`].join('\n')

/** Every control character but tab and line feed: an answer must not drive the operator's terminal. */
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
	return [...viewLines(view), '', failure.message, ...(failure.stack === null ? [] : [failure.stack])]
}

/** Human output and every note pass `printable`; `--json` escapes what JSON must. */
const emit = (args: EnvArgs, result: unknown, render: () => string): void => {
	console.info(args.json ? JSON.stringify(result, null, 2) : printable(render()))
}

const note = (text: string): void => {
	console.warn(printable(text))
}

/** An operation is an answer whatever its state; stderr names what follows it. */
const emitOperation = (args: EnvArgs, operation: DataOperationDto): void => {
	const coordinates = `${operation.appId} ${operation.env}`
	if (operation.state === 'running') note(`follow it: fabrika env operations ${coordinates}`)
	if (operation.state === 'failed') note(`open the environment past it: fabrika env recover ${coordinates} ${operation.id} open`)
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
	emitOperation(args, parseOperation(result, { appId, env: environment }))
}

const runOperations = async (args: EnvArgs, env: Environment): Promise<void> => {
	const [appId = '', environment = ''] = words('operations', args, 2)
	const page = parseOperationPage(await controlClient(args, env).data.operations.list({ appId, env: environment }), { appId, env: environment })
	if (page.nextCursor !== null) note(`showing the newest ${page.items.length} operations; older ones exist`)
	if (!args.json && page.items.length === 0) {
		note(`${appId} ${environment} has no data operations`)
		return
	}
	emit(args, page, () => page.items.map(operationLine).join('\n'))
}

const runRecover = async (args: EnvArgs, env: Environment): Promise<void> => {
	const [appId = '', environment = '', operationId = '', requested = ''] = words('recover', args, 4)
	const resolution = oneOf(requested, RESOLUTIONS)
	if (resolution === undefined) throw new Error(`The resolution is resume or open, not "${requested}"`)
	const result = await controlClient(args, env).data.recover({ appId, env: environment, operationId, resolution })
	emitOperation(args, parseOperation(result, { appId, env: environment }))
}

const runBackups = async (args: EnvArgs, env: Environment): Promise<void> => {
	if (args.positional[0] === 'schedule' && args.positional.length > 2) {
		await runBackupSchedule(args, env)
		return
	}
	const [appId = '', environment = ''] = words('backups', args, 2)
	const page = parseBackupPage(await controlClient(args, env).data.backups.list({ appId, env: environment }), { appId, env: environment })
	if (page.nextCursor !== null) note(`showing the newest ${page.items.length} backups; older ones exist`)
	if (!args.json && page.items.length === 0) {
		note(`${appId} ${environment} has no backups`)
		return
	}
	emit(args, page, () => page.items.map(backupLine).join('\n'))
}

const runBackupSchedule = async (args: EnvArgs, env: Environment): Promise<void> => {
	const [, appId = '', environment = '', requested] = args.positional
	if (args.positional.length > 4 || appId.trim() === '' || environment.trim() === '') throw usage('backups schedule')
	const client = controlClient(args, env)
	const target = { appId, env: environment }
	if (requested === undefined) {
		const schedule = parseSchedule(await client.data.backups.schedule(target), target)
		emit(args, schedule, () => scheduleLines(schedule))
		return
	}
	const daily = oneOf(requested, SCHEDULE_SWITCHES)
	if (daily === undefined) throw new Error(`The schedule is on or off, not "${requested}"`)
	const schedule = parseSchedule(await client.data.backups.setSchedule({ ...target, daily: daily === 'on' }), target)
	if (!schedule.daily) note('the backup before a migration still runs')
	emit(args, schedule, () => scheduleLines(schedule))
}

const runRestore = async (args: EnvArgs, env: Environment): Promise<void> => {
	const [appId = '', environment = ''] = words('restore', args, 2)
	if (args.at === undefined || args.at === '') throw usage('restore')
	// The contract's own rule for `at`, checked before anything is sent; whether it lies in the past is Control's to decide.
	const input = startDataOperationInputSchema.safeParse({ appId, env: environment, kind: 'restore', at: args.at })
	if (!input.success) throw new Error(`The time is ISO 8601 with an offset, such as 2026-10-24T12:00:00.000Z, not "${args.at}"`)
	const result = await controlClient(args, env).data.start(input.data)
	emitOperation(args, parseOperation(result, { appId, env: environment }))
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
		case 'backups':
			return runBackups
		case 'restore':
			return runRestore
		default:
			return undefined
	}
}

const diagnostic = (command: string, error: unknown): string => {
	if (!(error instanceof RpcError)) return error instanceof Error ? error.message : String(error)
	// Not offered by this release: a definite answer, unlike an outage, so nothing suggests trying again.
	if (error.httpStatus === 501) return `\`env ${command}\` is not available in this release of the control plane; retrying will not change that`
	// A refusal is an answer, not a transport fault: its type tells "Control said no" from "Control was unreachable".
	return `${error.type}: ${error.message}`
}

export const runEnvCli = async (command: string | undefined, argv: readonly string[], env: Environment = process.env): Promise<void> => {
	if (command === undefined) {
		console.info(USAGE)
		return
	}
	try {
		const run = commandRun(command)
		if (run === undefined) throw new Error(`Unknown env command: ${command}\n\n${USAGE}`)
		const args = parseEnvArgs(argv)
		if (args.content && command !== 'inspect') throw new Error('--content applies to `env inspect` only')
		if (args.at !== undefined && command !== 'restore') throw new Error('--at applies to `env restore` only')
		await run(args, env)
	} catch (error) {
		throw new Error(printable(withoutControlKey(diagnostic(command, error), env)))
	}
}

export { USAGE as ENV_USAGE }
