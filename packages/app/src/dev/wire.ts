// The wire of the platform transport's source receiver (ADR-0064): what the launcher of a `dev` environment asks
// Control and what it reports back. Both sides import it, so the shapes and the one parser of each message cannot drift
// apart. Runtime-neutral: zod and Web APIs only.

import { z } from 'zod/v4'

/** The long poll under the receiver's URL (`FABRIKA_PLATFORM_SOURCE_URL`). */
export const DEV_SOURCE_WAIT_PATH = '/platform/source/wait'
/** Where the launcher reports what it serves. */
export const DEV_SOURCE_REPORT_PATH = '/platform/source/report'

/** How long Control holds a wait before it answers `idle`: below every proxy's idle timeout on the way. */
export const DEV_SOURCE_WAIT_MS = 25_000

/** The most log lines one report carries, and the longest line. */
export const DEV_REPORT_MAX_LINES = 200
export const DEV_REPORT_MAX_LINE_CHARACTERS = 2_000
export const DEV_REPORT_MAX_MESSAGE_CHARACTERS = 500

const commitSha = z.string().regex(/^[0-9a-f]{40}$/)
const generation = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

/**
 * Repository-relative with forward slashes: no leading slash, no backslash, no empty, `.` or `..` segment, no control
 * character. The launcher writes these paths under its root, so nothing it receives may name a path outside it.
 */
export function isSourcePath(path: string): boolean {
	return path.length > 0 && path.length <= 512 && !path.startsWith('/') && !path.includes('\\')
		&& ![...path].some((character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f)
		&& path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

const sourcePath = z.string().refine(isSourcePath, 'not a repository-relative path')

export const devWaitRequestSchema = z.object({
	/** The commit whose files the container holds now. */
	head: commitSha,
	/** The reset generation it applied last; null for a container with no record of one, which adopts the answer's. */
	reset: generation.nullable(),
	/** The check request it ran last; null as for `reset`. */
	checks: generation.nullable(),
	/** False at boot: answer at once, so the launcher reconciles before it serves. */
	hold: z.boolean(),
}).strict()

export type DevWaitRequest = z.infer<typeof devWaitRequestSchema>

/** One changed file at the target commit; `content` null deletes it. */
export const devSourceFileSchema = z.object({ path: sourcePath, content: z.string().nullable() }).strict()

export type DevSourceFile = z.infer<typeof devSourceFileSchema>

/** The files that bring the container from `from` to `to`. */
export const devSyncSchema = z.object({ from: commitSha, to: commitSha, files: z.array(devSourceFileSchema) }).strict()

export type DevSync = z.infer<typeof devSyncSchema>

/**
 * What to do. `sync` is null when the container holds the recorded head (or a head it refused). `reset` and `checks` are
 * the environment's current generations: one past what the container applied asks it to reset its schema, or to run
 * the check chain.
 */
export const devWaitAnswerSchema = z.object({ sync: devSyncSchema.nullable(), reset: generation, checks: generation }).strict()

export type DevWaitAnswer = z.infer<typeof devWaitAnswerSchema>

export const DEV_STATUSES = ['syncing', 'serving', 'failed', 'needs_bootstrap', 'resetting', 'checking'] as const

export type DevStatus = (typeof DEV_STATUSES)[number]

export const devLogLineSchema = z.object({
	/** The line's number in the launcher's output since it started; it only grows. */
	n: z.number().int().min(0),
	stream: z.enum(['stdout', 'stderr']),
	text: z.string().max(DEV_REPORT_MAX_LINE_CHARACTERS),
}).strict()

export type DevLogLine = z.infer<typeof devLogLineSchema>

export const devCheckResultSchema = z.object({
	name: z.string().min(1).max(64),
	ok: z.boolean(),
	exitCode: z.number().int().nullable(),
	/** The last lines of its output. */
	output: z.array(z.string().max(DEV_REPORT_MAX_LINE_CHARACTERS)).max(DEV_REPORT_MAX_LINES),
}).strict()

export type DevCheckResult = z.infer<typeof devCheckResultSchema>

export const devReportSchema = z.object({
	/** The commit whose files the container holds now. */
	head: commitSha,
	status: z.enum(DEV_STATUSES),
	/** The commit the launcher is syncing to or refused; null when it has none. */
	target: commitSha.nullable(),
	/** One line: why a sync was refused or failed. */
	message: z.string().max(DEV_REPORT_MAX_MESSAGE_CHARACTERS).nullable(),
	/** The newest lines of the application's and the launcher's output, oldest first. */
	log: z.array(devLogLineSchema).max(DEV_REPORT_MAX_LINES),
	reset: generation.nullable(),
	/** The newest check run: the request it answers, the commit whose files it checked, and each check's result. */
	checks: z.object({ request: generation, head: commitSha, results: z.array(devCheckResultSchema).max(8) }).strict().nullable(),
}).strict()

export type DevReport = z.infer<typeof devReportSchema>

/** The body of a wait as JSON text. */
export function encodeDevWaitRequest(request: DevWaitRequest): string {
	return JSON.stringify(devWaitRequestSchema.parse(request))
}

/** The body of a report as JSON text. */
export function encodeDevReport(report: DevReport): string {
	return JSON.stringify(devReportSchema.parse(report))
}

export type DevParse<T> = { readonly ok: true; readonly value: T } | { readonly ok: false }

function parseWith<T>(schema: z.ZodType<T>, json: unknown): DevParse<T> {
	const parsed = schema.safeParse(json)
	return parsed.success ? { ok: true, value: parsed.data } : { ok: false }
}

/** The one parser of a wait request; a field this release does not know is refused, never dropped. */
export const parseDevWaitRequest = (json: unknown): DevParse<DevWaitRequest> => parseWith(devWaitRequestSchema, json)
export const parseDevWaitAnswer = (json: unknown): DevParse<DevWaitAnswer> => parseWith(devWaitAnswerSchema, json)
export const parseDevReport = (json: unknown): DevParse<DevReport> => parseWith(devReportSchema, json)
