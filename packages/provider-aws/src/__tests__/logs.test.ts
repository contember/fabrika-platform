// The CloudWatch Logs client against the fake endpoint: a log group created or kept with its retention, a stream read
// forward page by page, a stream that does not exist yet, and that a value of another form is refused before anything
// is sent.

import { describe, expect, test } from 'bun:test'
import { LOGS } from '../aws/json'
import { logsClient, READ_PAGE_EVENTS } from '../aws/logs'
import { awsError, fakeAws } from './helpers/fake-aws'

const GROUP = '/aws/codebuild/fabrika-apps-build'
const STREAM = '0f1e2d3c-4b5a-4968-8776-655443322110'

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
		await logsClient(existing.options).ensureLogGroup('/fabrika/apps/notes-prod', 14, {})
		// An empty tag map is left out of the create.
		expect(existing.calls.map((call) => call.body)).toEqual([
			{ logGroupName: '/fabrika/apps/notes-prod' },
			{ logGroupName: '/fabrika/apps/notes-prod', retentionInDays: 14 },
		])
		const denied = fakeAws(LOGS, { CreateLogGroup: () => awsError('AccessDeniedException') })
		await expect(logsClient(denied.options).ensureLogGroup('/fabrika/apps/notes-prod', 14, {})).rejects.toMatchObject({ code: 'AccessDeniedException' })
		expect(denied.calls.map((call) => call.operation)).toEqual(['CreateLogGroup'])
	})

	test('reads a stream forward from its head, then from the cursor, and an empty page keeps the cursor', async () => {
		const { options, calls } = fakeAws(LOGS, {
			GetLogEvents: (body) =>
				JSON.stringify(body).includes('nextToken')
					? { events: [], nextForwardToken: 'f/2' }
					: { events: [{ timestamp: 1_768_478_400_123, message: 'Entering phase BUILD\n', ingestionTime: 1_768_478_401_000 }], nextForwardToken: 'f/2' },
		})
		const logs = logsClient(options)
		expect(await logs.readForward(GROUP, STREAM)).toEqual({
			events: [{ at: new Date(1_768_478_400_123), message: 'Entering phase BUILD\n' }],
			cursor: 'f/2',
		})
		expect(await logs.readForward(GROUP, STREAM, 'f/2')).toEqual({ events: [], cursor: 'f/2' })
		expect(calls.map((call) => call.body)).toEqual([
			{ logGroupName: GROUP, logStreamName: STREAM, startFromHead: true, limit: READ_PAGE_EVENTS },
			{ logGroupName: GROUP, logStreamName: STREAM, startFromHead: true, limit: READ_PAGE_EVENTS, nextToken: 'f/2' },
		])
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
		await expect(logs.ensureLogGroup('group with space', 30, {})).rejects.toThrow('the log group')
		await expect(logs.ensureLogGroup('/fabrika/apps/notes', 31, {})).rejects.toThrow('the retention')
		await expect(logs.ensureLogGroup('/fabrika/apps/notes', 30, { 'Aws:x': 'y' })).rejects.toThrow('a tag')
		const tooMany = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`k${index}`, 'v']))
		await expect(logs.ensureLogGroup('/fabrika/apps/notes', 30, tooMany)).rejects.toThrow('the tags')
		await expect(logs.readForward(GROUP, 'a:b')).rejects.toThrow('the log stream')
		await expect(logs.readForward(GROUP, STREAM, 'not a token')).rejects.toThrow('the cursor')
		expect(calls).toEqual([])
	})
})
