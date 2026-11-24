// The CloudWatch Logs client against the fake endpoint: a log group created or kept with its retention, a stream read
// forward page by page, a stream that does not exist yet, and that a value of another form is refused before anything
// is sent.

import { describe, expect, test } from 'bun:test'
import { AWS_MAX_ANSWER_BYTES, LOGS } from '../aws/json'
import { LOGS_MAX_ANSWER_BYTES, logsClient, READ_PAGE_EVENTS } from '../aws/logs'
import { awsError, fakeAws } from './helpers/fake-aws'

const GROUP = '/aws/codebuild/fabrika-apps-build'
const STREAM = '0f1e2d3c-4b5a-4968-8776-655443322110'
const TAGS = { 'fabrika:app': 'notes' }

describe('logsClient', () => {
	test('creates a log group with its tags and sets its retention', async () => {
		const { options, calls } = fakeAws(LOGS, { CreateLogGroup: () => ({}), PutRetentionPolicy: () => ({}) })
		await logsClient(options).ensureLogGroup('/fabrika/apps/notes-prod', 30, { 'fabrika:app': 'notes' })
		expect(calls).toEqual([
			{
				operation: 'CreateLogGroup',
				target: 'Logs_20140328.CreateLogGroup',
				body: { logGroupName: '/fabrika/apps/notes-prod', tags: { 'fabrika:app': 'notes' } },
			},
			{
				operation: 'PutRetentionPolicy',
				target: 'Logs_20140328.PutRetentionPolicy',
				body: { logGroupName: '/fabrika/apps/notes-prod', retentionInDays: 30 },
			},
		])
	})

	test('an existing log group gets its retention set, and any other failure of the create is an error', async () => {
		const existing = fakeAws(LOGS, { CreateLogGroup: () => awsError('ResourceAlreadyExistsException'), PutRetentionPolicy: () => ({}) })
		await logsClient(existing.options).ensureLogGroup('/fabrika/apps/notes-prod', 14, TAGS)
		expect(existing.calls.map((call) => call.operation)).toEqual(['CreateLogGroup', 'PutRetentionPolicy'])
		const denied = fakeAws(LOGS, { CreateLogGroup: () => awsError('AccessDeniedException') })
		await expect(logsClient(denied.options).ensureLogGroup('/fabrika/apps/notes-prod', 14, TAGS)).rejects.toMatchObject({
			code: 'AccessDeniedException',
		})
		expect(denied.calls.map((call) => call.operation)).toEqual(['CreateLogGroup'])
	})

	test('reads a stream forward from its head, reads on past an empty page whose token moved, and ends where the token stays', async () => {
		const pages: Readonly<Record<string, { events: { timestamp: number; message: string; ingestionTime: number }[]; nextForwardToken: string }>> = {
			head: { events: [{ timestamp: 1_768_478_400_123, message: 'Entering phase BUILD\n', ingestionTime: 1_768_478_401_000 }], nextForwardToken: 'f/2' },
			// An empty page in the middle of the stream: the token moved, so there is more.
			'f/2': { events: [], nextForwardToken: 'f/3' },
			'f/3': { events: [{ timestamp: 1_768_478_400_456, message: 'done\n', ingestionTime: 1_768_478_401_000 }], nextForwardToken: 'f/4' },
			'f/4': { events: [], nextForwardToken: 'f/4' },
		}
		const { options, calls } = fakeAws(LOGS, {
			GetLogEvents: (body) => {
				const token = Object.entries(pages).find(([key]) => JSON.stringify(body).includes(`"nextToken":"${key}"`))?.[0] ?? 'head'
				return pages[token] ?? {}
			},
		})
		const logs = logsClient(options)
		expect(await logs.readForward(GROUP, STREAM)).toEqual({
			events: [{ at: new Date(1_768_478_400_123), message: 'Entering phase BUILD\n' }],
			cursor: 'f/2',
			atEnd: false,
		})
		expect(await logs.readForward(GROUP, STREAM, 'f/2')).toEqual({ events: [], cursor: 'f/3', atEnd: false })
		expect(await logs.readForward(GROUP, STREAM, 'f/3')).toEqual({
			events: [{ at: new Date(1_768_478_400_456), message: 'done\n' }],
			cursor: 'f/4',
			atEnd: false,
		})
		expect(await logs.readForward(GROUP, STREAM, 'f/4')).toEqual({ events: [], cursor: 'f/4', atEnd: true })
		expect(calls.map((call) => call.body)).toEqual([
			{ logGroupName: GROUP, logStreamName: STREAM, startFromHead: true, limit: READ_PAGE_EVENTS },
			{ logGroupName: GROUP, logStreamName: STREAM, startFromHead: true, limit: READ_PAGE_EVENTS, nextToken: 'f/2' },
			{ logGroupName: GROUP, logStreamName: STREAM, startFromHead: true, limit: READ_PAGE_EVENTS, nextToken: 'f/3' },
			{ logGroupName: GROUP, logStreamName: STREAM, startFromHead: true, limit: READ_PAGE_EVENTS, nextToken: 'f/4' },
		])
	})

	test('a page over the JSON client default bound, as escaped control characters make it, is read whatever the options say', async () => {
		// 500 events of 400 escape characters each: 200 KB of events, which the JSON writes as six bytes each, about 1.2 MB.
		const message = '\u001b'.repeat(400)
		const events = Array.from(
			{ length: READ_PAGE_EVENTS },
			(_, index) => ({ timestamp: 1_768_478_400_000 + index, message, ingestionTime: 1_768_478_401_000 }),
		)
		expect(JSON.stringify({ events, nextForwardToken: 'f/2' }).length).toBeGreaterThan(AWS_MAX_ANSWER_BYTES)
		const { options } = fakeAws(LOGS, { GetLogEvents: () => ({ events, nextForwardToken: 'f/2' }) })
		const page = await logsClient({ ...options, maxAnswerBytes: 1024 }).readForward(GROUP, STREAM)
		expect(page?.events.length).toBe(READ_PAGE_EVENTS)
		expect(LOGS_MAX_ANSWER_BYTES).toBeGreaterThan(6 * 1024 * 1024)
	})

	test('a time that is no whole millisecond is no answer', async () => {
		for (const timestamp of [1.5, -1, 9e15]) {
			const { options } = fakeAws(LOGS, { GetLogEvents: () => ({ events: [{ timestamp, message: 'x' }], nextForwardToken: 'f/2' }) })
			await expect(logsClient(options).readForward(GROUP, STREAM)).rejects.toMatchObject({ code: 'invalid_answer' })
		}
	})

	test('a stream that does not exist yet answers null, and a refusal is an error', async () => {
		const missing = fakeAws(LOGS, { GetLogEvents: () => awsError('ResourceNotFoundException') })
		expect(await logsClient(missing.options).readForward(GROUP, STREAM)).toBeNull()
		const throttled = fakeAws(LOGS, { GetLogEvents: () => awsError('ThrottlingException') })
		await expect(logsClient(throttled.options).readForward(GROUP, STREAM)).rejects.toMatchObject({ code: 'ThrottlingException', retryable: true })
	})

	test('refuses a value of another form before anything is sent', async () => {
		const { options, calls } = fakeAws(LOGS, {})
		const logs = logsClient(options)
		await expect(logs.ensureLogGroup('group with space', 30, TAGS)).rejects.toThrow('the log group')
		await expect(logs.ensureLogGroup('/fabrika/apps/notes', 31, TAGS)).rejects.toThrow('the retention')
		await expect(logs.ensureLogGroup('/fabrika/apps/notes', 30, { 'Aws:x': 'y' })).rejects.toThrow('a tag')
		// An untagged group could not be managed under a tag-scoped policy later.
		await expect(logs.ensureLogGroup('/fabrika/apps/notes', 30, {})).rejects.toThrow('the tags')
		const tooMany = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`k${index}`, 'v']))
		await expect(logs.ensureLogGroup('/fabrika/apps/notes', 30, tooMany)).rejects.toThrow('the tags')
		await expect(logs.readForward(GROUP, 'a:b')).rejects.toThrow('the log stream')
		await expect(logs.readForward(GROUP, STREAM, 'not a token')).rejects.toThrow('the cursor')
		expect(calls).toEqual([])
	})
})
