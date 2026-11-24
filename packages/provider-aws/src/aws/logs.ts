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
 * The most events one read asks for. CloudWatch Logs itself stops a page at 1 MB, which is the JSON client's answer
 * bound's order; a page of 500 keeps a relay step short.
 */
export const READ_PAGE_EVENTS = 500

/** One event of a stream: when it happened and its message. */
export interface LogEvent {
	readonly at: Date
	readonly message: string
}

/** A page of a stream read forward, and the cursor the next read starts from. */
export interface LogPage {
	readonly events: readonly LogEvent[]
	readonly cursor: string
}

export interface LogsClient {
	/** The log group `name`, created with `tags` when it does not exist; its retention is set to `retentionDays` either way. */
	ensureLogGroup(name: string, retentionDays: number, tags: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<void>
	/**
	 * The events of `stream` after `cursor` (from the start without one), at most `READ_PAGE_EVENTS`. `null` when the stream
	 * does not exist yet (a build that has not written). A page with no events answers the same cursor again.
	 */
	readForward(group: string, stream: string, cursor?: string, signal?: AbortSignal): Promise<LogPage | null>
}

const emptySchema = z.object({})
const eventsSchema = z.object({
	events: z.array(z.object({ timestamp: z.number(), message: z.string() })),
	nextForwardToken: z.string().regex(TOKEN),
})

/** Refuses a value of another form before anything is sent, naming the argument only. */
function refuse(what: string): never {
	throw new Error(`CloudWatch Logs: ${what} is not one CloudWatch Logs takes`)
}

/** CloudWatch Logs at `options.origin`; the client is of the `LOGS` service by construction. */
export function logsClient(options: AwsJsonClientOptions): LogsClient {
	const json = awsJsonClient(LOGS, options)
	return {
		async ensureLogGroup(name, retentionDays, tags, signal) {
			if (!LOG_GROUP.test(name)) refuse('the log group')
			if (!RETENTION_DAYS.has(retentionDays)) refuse('the retention')
			const entries = Object.entries(tags)
			if (entries.length > MAX_TAGS) refuse('the tags')
			for (const [key, value] of entries) {
				// AWS reserves the `aws:` prefix in any letter case.
				if (!TAG_KEY.test(key) || !TAG_VALUE.test(value) || key.toLowerCase().startsWith('aws:')) refuse('a tag')
			}
			try {
				// An empty tag map is left out: CloudWatch Logs takes `tags` with at least one entry.
				await json.call('CreateLogGroup', { logGroupName: name, ...(entries.length === 0 ? {} : { tags }) }, emptySchema, signal)
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
			// CloudWatch Logs writes an event's time in milliseconds since the epoch.
			return { events: page.events.map((event) => ({ at: new Date(event.timestamp), message: event.message })), cursor: page.nextForwardToken }
		},
	}
}
