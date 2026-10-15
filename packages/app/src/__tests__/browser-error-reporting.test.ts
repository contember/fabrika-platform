// The page's error reporting: the DSN of the browser config becomes the envelope endpoint, every uncaught error and
// unhandled rejection one Sentry error event with its frames, and a page without a DSN reports nothing.

import { describe, expect, test } from 'bun:test'
import {
	envelopeUrlOf,
	installErrorReporting,
	MAX_REPORTS_PER_PAGE,
	parseBrowserStack,
	type ReportingPage,
	reportingTargetOf,
	startErrorReporting,
} from '../client/error-reporting'

const ORIGIN = 'https://notes.example'
const DSN = 'https://0123456789abcdef0123456789abcdef@errors.example/42'
const ENVELOPE = 'https://errors.example/api/42/envelope/?sentry_key=0123456789abcdef0123456789abcdef&sentry_version=7'
const TARGET = { envelopeUrl: ENVELOPE, release: 'fabrika/notes/prod/default/abc', environment: 'prod' }

class Thrown extends Event {
	constructor(readonly error: unknown, readonly message: string) {
		super('error')
	}
}

class Rejected extends Event {
	constructor(readonly reason: unknown) {
		super('unhandledrejection')
	}
}

const page = (): ReportingPage & { dispatch(event: Event): void } => {
	const events = new EventTarget()
	return {
		addEventListener: (type, listener) => events.addEventListener(type, listener),
		removeEventListener: (type, listener) => events.removeEventListener(type, listener),
		location: { origin: ORIGIN, pathname: '/notes/1' },
		dispatch: (event) => events.dispatchEvent(event),
	}
}

/** A fetch that records each envelope sent and answers the browser config `config`. */
const recorder = (config: unknown = { dsn: DSN, release: TARGET.release, environment: 'prod' }) => {
	const sent: { url: string; init: RequestInit | undefined }[] = []
	const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = String(input)
		if (url.endsWith('__fabrika-config.json')) return Response.json(config)
		sent.push({ url, init })
		return new Response(null, { status: 202 })
	}
	return { sent, fetch }
}

const eventOf = (body: BodyInit | null | undefined): Record<string, unknown> => {
	const line = String(body).split('\n')[2] ?? ''
	const value: unknown = JSON.parse(line)
	if (typeof value !== 'object' || value === null) throw new Error('expected an event')
	return Object.fromEntries(Object.entries(value))
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('the reporting target', () => {
	test('an ingest DSN is its envelope endpoint, authenticated in the query as the Sentry SDK sends it', () => {
		expect(envelopeUrlOf(DSN)).toBe(ENVELOPE)
		for (
			const other of ['', 'not a url', 'https://errors.example/42', 'https://key:secret@errors.example/42', 'ftp://0123456789abcdef0123456789abcdef@x/1']
		) {
			expect(envelopeUrlOf(other)).toBeNull()
		}
	})

	test('a browser config without a usable DSN names no target', () => {
		expect(reportingTargetOf({ dsn: DSN, release: TARGET.release, environment: 'prod' })).toEqual(TARGET)
		expect(reportingTargetOf({ dsn: null, release: null, environment: null })).toBeNull()
		expect(reportingTargetOf({ dsn: 'nope', release: null, environment: null })).toBeNull()
		expect(reportingTargetOf('not a config')).toBeNull()
	})
})

describe('a browser stack', () => {
	test('V8 frames, oldest call first, in the app when the script is of the page origin', () => {
		const stack = [
			'TypeError: x is undefined',
			`    at render (${ORIGIN}/chunk-abc.js:1:2345)`,
			`    at async load (${ORIGIN}/chunk-abc.js:1:99)`,
			'    at https://cdn.example/lib.js:3:4',
			'    at eval (eval at run (https://notes.example/chunk-abc.js:1:5), <anonymous>:1:1)',
		].join('\n')
		expect(parseBrowserStack(stack, ORIGIN)).toEqual([
			{ filename: 'https://cdn.example/lib.js', lineno: 3, colno: 4, in_app: false },
			{ filename: `${ORIGIN}/chunk-abc.js`, function: 'load', lineno: 1, colno: 99, in_app: true },
			{ filename: `${ORIGIN}/chunk-abc.js`, function: 'render', lineno: 1, colno: 2345, in_app: true },
		])
	})

	test('SpiderMonkey and JavaScriptCore frames', () => {
		const stack = [`render@${ORIGIN}/chunk-abc.js:1:2345`, `@${ORIGIN}/chunk-abc.js:1:10`, '[native code]'].join('\n')
		expect(parseBrowserStack(stack, ORIGIN)).toEqual([
			{ filename: `${ORIGIN}/chunk-abc.js`, lineno: 1, colno: 10, in_app: true },
			{ filename: `${ORIGIN}/chunk-abc.js`, function: 'render', lineno: 1, colno: 2345, in_app: true },
		])
	})
})

describe('reporting the page', () => {
	test('an uncaught error is one error event with its release, environment and the address without query or fragment', async () => {
		const browser = page()
		const { sent, fetch } = recorder()
		installErrorReporting(browser, TARGET, fetch)
		const error = new TypeError('x is undefined')
		error.stack = `TypeError: x is undefined\n    at render (${ORIGIN}/chunk-abc.js:1:2345)`
		browser.dispatch(new Thrown(error, 'Uncaught TypeError: x is undefined'))
		await settle()

		expect(sent).toHaveLength(1)
		expect(sent[0]?.url).toBe(ENVELOPE)
		expect(new Headers(sent[0]?.init?.headers).get('content-type')).toBe('text/plain;charset=UTF-8')
		expect(sent[0]?.init?.credentials).toBe('omit')
		const event = eventOf(sent[0]?.init?.body)
		expect(event['release']).toBe(TARGET.release)
		expect(event['environment']).toBe('prod')
		expect(event['request']).toEqual({ url: `${ORIGIN}/notes/1` })
		expect(event['exception']).toEqual({
			values: [{
				type: 'TypeError',
				value: 'x is undefined',
				mechanism: { type: 'onerror', handled: false },
				stacktrace: { frames: [{ filename: `${ORIGIN}/chunk-abc.js`, function: 'render', lineno: 1, colno: 2345, in_app: true }] },
			}],
		})
	})

	test('an unhandled rejection is reported; a repeated one and one past the page limit are not', async () => {
		const browser = page()
		const { sent, fetch } = recorder()
		installErrorReporting(browser, TARGET, fetch)
		browser.dispatch(new Rejected('offline'))
		browser.dispatch(new Rejected('offline'))
		await settle()
		expect(sent).toHaveLength(1)
		expect(eventOf(sent[0]?.init?.body)['exception']).toEqual({
			values: [{ type: 'UnhandledRejection', value: 'offline', mechanism: { type: 'onunhandledrejection', handled: false } }],
		})
		for (let index = 0; index < MAX_REPORTS_PER_PAGE * 2; index++) browser.dispatch(new Rejected(`failure ${index}`))
		await settle()
		expect(sent).toHaveLength(MAX_REPORTS_PER_PAGE)
	})

	test('a failed delivery never throws into the page, and the uninstall stops reporting', async () => {
		const browser = page()
		let calls = 0
		const uninstall = installErrorReporting(browser, TARGET, () => {
			calls++
			return Promise.reject(new TypeError('blocked'))
		})
		browser.dispatch(new Thrown(new Error('first'), ''))
		await settle()
		uninstall()
		browser.dispatch(new Thrown(new Error('second'), ''))
		await settle()
		expect(calls).toBe(1)
	})
})

describe('starting from the browser config', () => {
	test('a config with a DSN installs reporting', async () => {
		const browser = page()
		const { sent, fetch } = recorder()
		expect(await startErrorReporting('/__fabrika-config.json', fetch, browser)).not.toBeNull()
		browser.dispatch(new Thrown(new Error('boom'), ''))
		await settle()
		expect(sent).toHaveLength(1)
	})

	test('no DSN, a refused config or an unreachable one installs nothing', async () => {
		expect(await startErrorReporting('/__fabrika-config.json', recorder({ dsn: null, release: null, environment: null }).fetch, page())).toBeNull()
		expect(await startErrorReporting('/__fabrika-config.json', async () => new Response(null, { status: 401 }), page())).toBeNull()
		expect(await startErrorReporting('/__fabrika-config.json', () => Promise.reject(new TypeError('offline')), page())).toBeNull()
	})
})
