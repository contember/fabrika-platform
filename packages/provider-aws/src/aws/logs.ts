// The CloudWatch Logs calls the AWS provider makes (ADR-0081): a log group per application environment with a retention,
// created on first use, and the forward read of one stream, which the run log relays (a build's log, its container's
// output). A page is bounded so its answer stays under the JSON client's limit, and a cursor carries the read on.
//
// UNVERIFIED: the operations' input and answer fields, the retention values and the forward token's behaviour at the
// end of a stream follow CloudWatch Logs' API reference; none was checked against an account.

import { z } from 'zod'
import { AwsError, awsJsonClient, type AwsJsonClientOptions, LOGS } from './json'

/** A log group's name. */
const LOG_GROUP = /^[A-Za-z0-9_\-/.#]{1,512}$/
/** A log stream's name: anything but `:` and `*`, at most 512. */
const LOG_STREAM = /^[^:*\n\r]{1,512}$/
/** A forward or backward token, as CloudWatch Logs writes it. */
const TOKEN = /^[A-Za-z0-9/+=_-]{1,1024}$/
/** A resource tag's key and value: letters, digits, spaces and `_.:/=+-@`, no line break. */
const TAG_KEY = /^[\p{L}\p{Zs}\p{N}_.:/=+@-]{1,128}$/u
const TAG_VALUE = /^[\p{L}\p{Zs}\p{N}_.:/=+@-]{0,256}$/u
/** The retentions, in days, CloudWatch Logs takes. */
export const RETENTION_DAYS: ReadonlySet<number> = new Set([
	1,
	3,
	5,
	7,
	14,
	30,
	60,
	90,
	120,
	150,
	180,
	365,
	400,
	545,
	731,
	1096,
	1827,
	2192,
	2557,
	2922,
	3288,
	3653,
])
/** The most tags a log group takes. */
const MAX_TAGS = 50
/**
 * The most events one read asks for: a page of 500 keeps a relay step short. CloudWatch Logs stops a page at 1 MB of
 * events on its own as well.
 */
export const READ_PAGE_EVENTS = 500
/**
 * The largest answer a read takes. CloudWatch Logs bounds a page at 1 MB of events, not of its JSON: the JSON escapes a
 * control character (an ANSI colour code in a build's output) as six bytes and wraps every event in its fields. Six
 * times the page bound and the wrappers of a full page stay under 7 MiB. A smaller bound would answer
 * `answer_too_large` for a page CloudWatch Logs sends again on the same cursor, and the relay would stop there for good.
 */
export const LOGS_MAX_ANSWER_BYTES = 7 * 1024 * 1024
/** The latest time a `Date` holds, in milliseconds since the epoch. */
const MAX_DATE_MS = 8_640_000_000_000_000

/** One event of a stream: when it happened and its message. */
export interface LogEvent {
	readonly at: Date
	readonly message: string
}

/** A page of a stream read forward, and the cursor the next read starts from. */
export interface LogPage {
	readonly events: readonly LogEvent[]
	readonly cursor: string
	/**
	 * The stream has nothing more for now: the token did not move. Wait before reading `cursor` again. When it is false,
	 * read on at once, even after a page with no events: CloudWatch Logs may answer an empty or partial page in the middle
	 * of a stream. The first read (without a cursor) is never at the end.
	 */
	readonly atEnd: boolean
}

export interface LogsClient {
	/**
	 * The log group `name`, created with `tags` when it does not exist; its retention is set to `retentionDays` either
	 * way. Tags apply only on create: an existing group keeps its own. At least one tag is required, because the
	 * provider's roles act only on resources tagged as theirs, and an untagged group could not be managed later.
	 */
	ensureLogGroup(name: string, retentionDays: number, tags: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<void>
	/**
	 * The events of `stream` after `cursor` (from the start without one), at most `READ_PAGE_EVENTS`.
	 *
	 * `null` for `ResourceNotFoundException`. That is a stream not written yet (a build that has not started writing),
	 * and also a group that does not exist: the caller bounds how long it waits on `null`.
	 *
	 * `group` and `stream` come from the run's own checkpoint (`buildId`) and the application's target, never from a
	 * request: the build group is one per installation, so the stream's name is what keeps one application from reading
	 * another's build log. The role that reads is scoped to the installation's groups.
	 *
	 * A cursor expires after 24 hours (UNVERIFIED); a relay that resumes a cursor stored for longer starts over.
	 */
	readForward(group: string, stream: string, cursor?: string, signal?: AbortSignal): Promise<LogPage | null>
}

const emptySchema = z.object({})
const eventsSchema = z.object({
	events: z.array(z.object({ timestamp: z.number().int().nonnegative().max(MAX_DATE_MS), message: z.string() })),
	nextForwardToken: z.string().regex(TOKEN),
})

/** Refuses a value of another form before anything is sent, naming the argument only. */
function refuse(what: string): never {
	throw new Error(`CloudWatch Logs: ${what} is not one CloudWatch Logs takes`)
}

/** CloudWatch Logs at `options.origin`; the client is of the `LOGS` service by construction. */
export function logsClient(options: AwsJsonClientOptions): LogsClient {
	// The answer bound is the logs client's own, whatever the options say: see `LOGS_MAX_ANSWER_BYTES`.
	const json = awsJsonClient(LOGS, { ...options, maxAnswerBytes: LOGS_MAX_ANSWER_BYTES })
	return {
		async ensureLogGroup(name, retentionDays, tags, signal) {
			if (!LOG_GROUP.test(name)) refuse('the log group')
			if (!RETENTION_DAYS.has(retentionDays)) refuse('the retention')
			const entries = Object.entries(tags)
			if (entries.length === 0 || entries.length > MAX_TAGS) refuse('the tags')
			for (const [key, value] of entries) {
				// AWS reserves the `aws:` prefix in any letter case.
				if (!TAG_KEY.test(key) || !TAG_VALUE.test(value) || key.toLowerCase().startsWith('aws:')) refuse('a tag')
			}
			try {
				await json.call('CreateLogGroup', { logGroupName: name, tags }, emptySchema, signal)
			} catch (error) {
				if (!(error instanceof AwsError) || error.code !== 'ResourceAlreadyExistsException') throw error
			}
			await json.call('PutRetentionPolicy', { logGroupName: name, retentionInDays: retentionDays }, emptySchema, signal)
		},

		async readForward(group, stream, cursor, signal) {
			if (!LOG_GROUP.test(group)) refuse('the log group')
			if (!LOG_STREAM.test(stream)) refuse('the log stream')
			if (cursor !== undefined && !TOKEN.test(cursor)) refuse('the cursor')
			let page: z.infer<typeof eventsSchema>
			try {
				page = await json.call(
					'GetLogEvents',
					{
						logGroupName: group,
						logStreamName: stream,
						startFromHead: true,
						limit: READ_PAGE_EVENTS,
						...(cursor === undefined ? {} : { nextToken: cursor }),
					},
					eventsSchema,
					signal,
				)
			} catch (error) {
				if (error instanceof AwsError && error.code === 'ResourceNotFoundException') return null
				throw error
			}
			return {
				// CloudWatch Logs writes an event's time in milliseconds since the epoch.
				events: page.events.map((event) => ({ at: new Date(event.timestamp), message: event.message })),
				cursor: page.nextForwardToken,
				// The end of the stream for now is a token that did not move, never an empty page.
				atEnd: cursor !== undefined && page.nextForwardToken === cursor,
			}
		},
	}
}
