// What an error report carries (ADR-0059): what was thrown, its stack frames and its causes, scrubbed of the
// environment's secrets and of credential patterns and bounded in size; and the reports of a process that fails
// outside any request or job run.

import { serveContract } from '@fabrika/app/bun'
import { createContractWorker } from '@fabrika/app/cloudflare'
import { describe, expect, spyOn, test } from 'bun:test'
import { type CrashEvents, type ProcessCrashKind, reportFatalCrashes, reportSurvivedCrashes } from '../implement/crashes'
import { ServerFault } from '../implement/faults'
import { exceptionChain, fitWithin, MAX_CAUSE_DEPTH, MAX_EXCEPTION_BYTES, MAX_FRAMES, MAX_MESSAGE_LENGTH, parseStack } from '../jobs/exception'
import type { CrashKind, CrashReporter } from '../jobs/report'
import { environmentScrubber, REDACTED, secretScrubber, secretValues } from '../jobs/scrub'
import { notesApp } from './fixtures/implement/app'
import { environment, FRAMEWORK_ENV, frameworkEnvFor, keepingProcessEnvironment, keySource, ORIGIN, PROXY_SECRET } from './fixtures/implement/harness'

const DSN = 'https://0123456789abcdef0123456789abcdef@operations.test/42'
const SERVICE_KEY = 'px_service-key-of-the-environment-0123'
const noSecrets = secretScrubber([])

const BUN_STACK = [
	'Error: boom',
	'second line of the message',
	'    at bar (/var/www/src/notes/endpoints.ts:12:31)',
	'    at <anonymous> (/var/www/node_modules/@fabrika/app/src/implement/dispatch.ts:300:11)',
	'    at processTicksAndRejections (native:7:39)',
].join('\n')

const V8_STACK = [
	"TypeError: Cannot read properties of undefined (reading 'id')",
	'    at Object.fetch (index.js:120:15)',
	'    at async Promise.all (index 0)',
	'    at new Store (index.js:30:7)',
	'    at index.js:5:1',
].join('\n')

function thrown(message: string, stack: string, options?: ErrorOptions): Error {
	const error = new Error(message, options)
	error.stack = stack
	return error
}

describe('the scrubber', () => {
	const scrubber = environmentScrubber(environment({
		...FRAMEWORK_ENV,
		FABRIKA_SERVICE_KEY: SERVICE_KEY,
		FABRIKA_OPERATIONS_DSN: DSN,
		FABRIKA_APP_DATABASE_URL: 'postgres://app_notes:db-p%40ssword-123@db:5432/notes',
		FABRIKA_RELEASE: 'release-2026-10-15',
		STRIPE_API_KEY: 'sk_live_0123456789abcdef',
		GREETING: 'hello world, everyone',
		PWD: '/var/www',
	}))

	test('a secret value of the environment is removed wherever it stands', () => {
		expect(scrubber.scrub(`IAM refused key ${SERVICE_KEY} for notes`)).toBe(`IAM refused key ${REDACTED} for notes`)
		expect(scrubber.scrub('charge failed with sk_live_0123456789abcdef')).toBe(`charge failed with ${REDACTED}`)
		expect(scrubber.scrub('password authentication failed: db-p@ssword-123')).toBe(`password authentication failed: ${REDACTED}`)
		expect(scrubber.scrub('ingest key 0123456789abcdef0123456789abcdef')).toBe(`ingest key ${REDACTED}`)
	})

	test('a public framework value, an application variable not named as a secret and a short value stay', () => {
		expect(scrubber.scrub('release-2026-10-15 of notes@prod at /var/www, hello world, everyone')).toBe(
			'release-2026-10-15 of notes@prod at /var/www, hello world, everyone',
		)
		expect(secretValues(environment({ FABRIKA_SERVICE_KEY: 'short', API_TOKEN: 'tiny' }))).toEqual([])
	})

	test("the platform transport's provider and URL stay, and its key is removed", () => {
		const platform = environmentScrubber(environment({
			FABRIKA_EMAIL_PROVIDER: 'platform',
			FABRIKA_PLATFORM_MAIL_URL: 'http://control:3000',
			FABRIKA_PLATFORM_MAIL_KEY: 'px_platform-mail-key-0123456789',
		}))
		expect(platform.scrub('platform mail at http://control:3000 refused px_platform-mail-key-0123456789')).toBe(
			`platform mail at http://control:3000 refused ${REDACTED}`,
		)
	})

	test('a JWT, an authorization scheme and a credential header are removed', () => {
		const jwt = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJl'
		expect(noSecrets.scrub(`token ${jwt} expired`)).toBe(`token ${REDACTED} expired`)
		expect(noSecrets.scrub('sent Bearer abcdefgh12345678 upstream')).toBe(`sent Bearer ${REDACTED} upstream`)
		expect(noSecrets.scrub('X-Fabrika-Token: opaque-value-123')).toBe(`X-Fabrika-Token: ${REDACTED}`)
		expect(noSecrets.scrub('{"cookie":"session=abc123"}')).toBe(`{"cookie":"${REDACTED}"}`)
	})

	test("a URL's userinfo and its sensitive query parameters are removed; the rest of the URL stays", () => {
		expect(noSecrets.scrub('connect postgres://notes:hunter2@db:5432/notes failed')).toBe(`connect postgres://${REDACTED}@db:5432/notes failed`)
		expect(noSecrets.scrub('GET https://api.test/v1/items?page=2&access_token=abc&apiKey=xyz&q=lamp')).toBe(
			`GET https://api.test/v1/items?page=2&access_token=${REDACTED}&apiKey=${REDACTED}&q=lamp`,
		)
	})
})

describe('stack frames', () => {
	test("Bun's stack: oldest call first, a dependency's and the runtime's frames not in-app, the message lines skipped", () => {
		expect(parseStack(BUN_STACK, noSecrets)).toEqual([
			{ filename: 'native', function: 'processTicksAndRejections', lineno: 7, colno: 39, in_app: false },
			{ filename: '/var/www/node_modules/@fabrika/app/src/implement/dispatch.ts', function: '<anonymous>', lineno: 300, colno: 11, in_app: false },
			{ filename: '/var/www/src/notes/endpoints.ts', function: 'bar', lineno: 12, colno: 31, in_app: true },
		])
	})

	test("a Worker's V8 stack: async and constructor frames, a frame without a function, one without a position", () => {
		expect(parseStack(V8_STACK, noSecrets)).toEqual([
			{ filename: 'index.js', lineno: 5, colno: 1, in_app: true },
			{ filename: 'index.js', function: 'new Store', lineno: 30, colno: 7, in_app: true },
			{ filename: 'index 0', function: 'Promise.all', in_app: false },
			{ filename: 'index.js', function: 'Object.fetch', lineno: 120, colno: 15, in_app: true },
		])
	})

	test('only the frames nearest the throw are kept', () => {
		const stack = ['Error: deep', ...Array.from({ length: 80 }, (_, index) => `    at f${index} (/app/src/a.ts:${index + 1}:1)`)].join('\n')
		const frames = parseStack(stack, noSecrets)
		expect(frames).toHaveLength(MAX_FRAMES)
		expect(frames.at(-1)?.function).toBe('f0')
		expect(frames[0]?.function).toBe(`f${MAX_FRAMES - 1}`)
	})
})

describe('the cause chain', () => {
	test('the deepest cause first and the thrown error last, each with its type, scrubbed message and frames', () => {
		const root = thrown('connect postgres://notes:hunter2@db/notes refused', V8_STACK)
		const error = new TypeError('could not load the note', { cause: root })
		const chain = exceptionChain(error, noSecrets)
		expect(chain.map((value) => [value.type, value.value])).toEqual([
			['Error', `connect postgres://${REDACTED}@db/notes refused`],
			['TypeError', 'could not load the note'],
		])
		expect(chain[0]?.stacktrace?.frames).toHaveLength(4)
		expect(chain[1]?.stacktrace?.frames.at(-1)?.in_app).toBe(true)
	})

	test(`at most ${MAX_CAUSE_DEPTH} errors of a longer or cyclic chain`, () => {
		let error = new Error('level 0')
		for (let level = 1; level < 12; level++) {
			error = new Error(`level ${level}`, { cause: error })
		}
		expect(exceptionChain(error, noSecrets).map((value) => value.value)).toEqual(['level 7', 'level 8', 'level 9', 'level 10', 'level 11'])
		const cyclic = new Error('one')
		cyclic.cause = new Error('two', { cause: cyclic })
		expect(exceptionChain(cyclic, noSecrets).map((value) => value.value)).toEqual(['two', 'one'])
	})

	test("a framework failure's message is replaced by its reason and catalog text; a name that is no identifier is Error", () => {
		const [fault] = exceptionChain(new ServerFault('output_refused', 'returned {"email":"jane@example.test"}'), noSecrets)
		expect(fault?.type).toBe('ServerFault')
		expect(fault?.value).toBe('output_refused: the handler returned a value its output schema refuses')
		const named = Object.assign(new Error('x'), { name: 'Driver failed: s3cret' })
		expect(exceptionChain(named, noSecrets)[0]?.type).toBe('Error')
	})

	test('a thrown string is its message; any other value says what it was and nothing of it', () => {
		expect(exceptionChain('plain text', noSecrets)).toEqual([{ type: 'Error', value: 'plain text' }])
		expect(exceptionChain({ secret: 'x' }, noSecrets)).toEqual([{ type: 'Error', value: 'a thrown object that is not an Error' }])
		expect(exceptionChain({ httpStatus: 502, type: 'upstream', message: 'gateway said no' }, noSecrets)).toEqual([
			{ type: 'upstream', value: 'gateway said no' },
		])
	})

	test('a message is cut, and a chain too large for one event loses its deepest causes, then half its frames', () => {
		const [long] = exceptionChain(new Error('x'.repeat(MAX_MESSAGE_LENGTH * 3)), noSecrets)
		expect(long?.value).toHaveLength(MAX_MESSAGE_LENGTH + 1)
		const frame = (index: number) => `    at ${'f'.repeat(400)}${index} (/app/src/${'d'.repeat(400)}.ts:${index}:1)`
		const stack = ['Error: big', ...Array.from({ length: 100 }, (_, index) => frame(index))].join('\n')
		let error = thrown('big 0', stack)
		for (let level = 1; level < 10; level++) {
			error = thrown(`big ${level}`, stack, { cause: error })
		}
		const fitted = exceptionChain(error, noSecrets)
		expect(new TextEncoder().encode(JSON.stringify(fitted)).length).toBeLessThanOrEqual(MAX_EXCEPTION_BYTES)
		expect(fitted.at(-1)?.value).toBe('big 9')
		expect(fitWithin([{ type: 'Error', value: 'small' }], 10)).toEqual([{ type: 'Error', value: 'small' }])
	})
})

function recordingReporter() {
	const reports: [CrashKind, unknown][] = []
	const reporter: CrashReporter = { report: (kind, error) => Promise.resolve(void reports.push([kind, error])) }
	return { reports, reporter }
}

function fakeEvents() {
	let listener: ((kind: ProcessCrashKind, error: unknown) => void) | null = null
	let listens = 0
	const events: CrashEvents = {
		listen(next) {
			listens++
			listener = next
			return () => {
				listener = null
			}
		},
	}
	return {
		events,
		fire: (kind: ProcessCrashKind, error: unknown) => listener?.(kind, error),
		listening: () => listener !== null,
		listens: () => listens,
	}
}

describe('a crash of the process', () => {
	test('the first crash is reported, then the listeners stop and the runtime fails as before; a second one is not reported', async () => {
		const { reports, reporter } = recordingReporter()
		const source = fakeEvents()
		const failed: [ProcessCrashKind, unknown][] = []
		const done = Promise.withResolvers<void>()
		reportFatalCrashes({ events: source.events, reporter, fail: (kind, error) => done.resolve(void failed.push([kind, error])) })
		const first = new Error('first')
		source.fire('unhandled_rejection', first)
		source.fire('uncaught_exception', new Error('second'))
		await done.promise
		expect(reports).toEqual([['unhandled_rejection', first]])
		expect(failed).toEqual([['unhandled_rejection', first]])
		expect(source.listening()).toBe(false)
	})

	test('a report that does not arrive in time does not keep the process alive', async () => {
		const source = fakeEvents()
		const done = Promise.withResolvers<ProcessCrashKind>()
		const hanging: CrashReporter = { report: () => new Promise<void>(() => {}) }
		reportFatalCrashes({ events: source.events, reporter: hanging, fail: (kind) => done.resolve(kind), flushMs: 5 })
		source.fire('uncaught_exception', new Error('boom'))
		expect(await done.promise).toBe('uncaught_exception')
	})

	test('an isolate that survives reports each rejection within the per-minute budget and keeps listening', () => {
		const { reports, reporter } = recordingReporter()
		const source = fakeEvents()
		let now = 1_000 * 60_000
		reportSurvivedCrashes(source.events, reporter, () => now)
		for (let index = 0; index < 40; index++) {
			source.fire('unhandled_rejection', new Error(`r${index}`))
		}
		expect(reports).toHaveLength(30)
		now += 60_000
		source.fire('unhandled_rejection', new Error('next minute'))
		expect(reports).toHaveLength(31)
		expect(source.listening()).toBe(true)
	})
})

function capturingFetch() {
	const envelopes: string[] = []
	const fetch = async (request: Request): Promise<Response> => {
		envelopes.push(await request.text())
		return new Response(null, { status: 202 })
	}
	return { envelopes, fetch }
}

function eventOf(envelope: string | undefined): Record<string, unknown> {
	const event: unknown = JSON.parse(envelope?.split('\n')[2] ?? 'null')
	if (typeof event !== 'object' || event === null) throw new Error('no event in the envelope')
	return Object.fromEntries(Object.entries(event))
}

describe('serveContract', () => {
	test('a startup that throws is reported before it is rethrown, without a fingerprint, its secrets scrubbed', async () => {
		const { envelopes, fetch } = capturingFetch()
		const source = fakeEvents()
		await keepingProcessEnvironment(async () => {
			const env = { ...FRAMEWORK_ENV, FABRIKA_OPERATIONS_DSN: DSN, FABRIKA_SERVICE_KEY: SERVICE_KEY, PORT: '0' }
			const failing = () => Promise.reject(new Error(`the application module failed with ${SERVICE_KEY}`))
			await expect(serveContract(failing, env, { crashes: source.events, operationsFetch: fetch })).rejects.toThrow('the application module failed')
		})
		expect(envelopes).toHaveLength(1)
		expect(envelopes[0]).not.toContain(SERVICE_KEY)
		const event = eventOf(envelopes[0])
		expect(event['logger']).toBe('fabrika.process')
		expect(event['fingerprint']).toBeUndefined()
		expect(event['tags']).toEqual({ crash: 'boot_failed' })
		expect(event['exception']).toMatchObject({ values: [{ type: 'Error', value: `the application module failed with ${REDACTED}` }] })
		expect(source.listens()).toBe(0)
	})

	test('a served process listens for crashes only with a DSN, and stops when it stops', async () => {
		const source = fakeEvents()
		await keepingProcessEnvironment(async () => {
			const env = { ...frameworkEnvFor(notesApp(new Map())), FABRIKA_PROXY_SECRET: PROXY_SECRET, PORT: '0' }
			const load = () => Promise.resolve({ default: notesApp(new Map()) })
			const plain = await serveContract(load, env, { crashes: source.events })
			await plain.stop()
			expect(source.listens()).toBe(0)
			const reporting = await serveContract(load, { ...env, FABRIKA_OPERATIONS_DSN: DSN }, { crashes: source.events })
			expect(source.listening()).toBe(true)
			await reporting.stop()
			expect(source.listening()).toBe(false)
		})
	})
})

describe('createContractWorker', () => {
	const exec = () => {
		const pending: Promise<unknown>[] = []
		return { pending, context: { waitUntil: (promise: Promise<unknown>) => void pending.push(promise), passThroughOnException() {} } }
	}

	test("an isolate's first failed boot is reported once; once one booted, its rejections are reported", async () => {
		const { envelopes, fetch } = capturingFetch()
		const source = fakeEvents()
		const worker = createContractWorker(() => Promise.resolve({ default: notesApp(new Map()) }), { rejections: source.events, operationsFetch: fetch })
		const assets = { fetch: () => Promise.resolve(new Response('asset')) }
		const env = { ...frameworkEnvFor(notesApp(new Map())), FABRIKA_OPERATIONS_DSN: DSN, ASSETS: assets }
		const failing = exec()
		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(keepingProcessEnvironment(() => worker.fetch(new Request(`${ORIGIN}/healthz`), env, failing.context))).rejects.toThrow(
				'the IAM binding is missing',
			)
		}
		await Promise.all(failing.pending)
		expect(envelopes.map((envelope) => eventOf(envelope)['tags'])).toEqual([{ crash: 'boot_failed' }])
		expect(source.listens()).toBe(0)

		const serving = exec()
		const response = await keepingProcessEnvironment(() => worker.fetch(new Request(`${ORIGIN}/healthz`), { ...env, IAM: keySource }, serving.context))
		expect(response.status).toBe(200)
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			source.fire('unhandled_rejection', new RangeError('late'))
			await Bun.sleep(0)
		} finally {
			log.mockRestore()
		}
		expect(envelopes).toHaveLength(2)
		expect(eventOf(envelopes[1])['tags']).toEqual({ crash: 'unhandled_rejection' })
		expect(eventOf(envelopes[1])['exception']).toMatchObject({ values: [{ type: 'RangeError', value: 'late' }] })
	})
})
