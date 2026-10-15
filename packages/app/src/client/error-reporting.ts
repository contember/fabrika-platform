// Browser error reporting on the paved road. `FabrikaProvider` reads the SPA mount's browser config and, when it names
// an Operations DSN, sends every uncaught error and unhandled rejection of the page to that ingest as one Sentry error
// event. Operations ingests error events only, so nothing else of the page leaves it.

import { z } from 'zod/v4'
import type { RpcFetch } from './transport'

const BrowserConfigSchema = z.object({
	dsn: z.string().nullable(),
	release: z.string().nullable(),
	environment: z.string().nullable(),
})

/** One stack frame in Sentry's shape, the file a script URL. */
export interface BrowserFrame {
	readonly filename: string
	readonly function?: string
	readonly lineno: number
	readonly colno: number
	/** A frame of a script of the page's own origin. */
	readonly in_app: boolean
}

/** Where the page reports, read from its browser config. */
export interface ReportingTarget {
	/** The ingest's envelope endpoint, authenticated by the DSN's public key in its query, as the Sentry SDK sends it. */
	readonly envelopeUrl: string
	readonly release: string | null
	readonly environment: string | null
}

/** What the reporter listens on and reads the page's address from: `window` in a page. */
export interface ReportingPage {
	addEventListener(type: 'error' | 'unhandledrejection', listener: (event: Event) => void): void
	removeEventListener(type: 'error' | 'unhandledrejection', listener: (event: Event) => void): void
	readonly location: { readonly origin: string; readonly pathname: string }
}

const PUBLIC_KEY = /^[0-9a-f]{32}$/
const PROJECT_ID = /^[1-9][0-9]{0,18}$/
/** A page that keeps failing stops reporting here; Operations rate-limits the whole source, not one page. */
export const MAX_REPORTS_PER_PAGE = 20
const MAX_FRAMES = 50
const MAX_TEXT = 2_048
const TYPE_NAME = /^[A-Za-z_$][\w$.]{0,127}$/

/**
 * The envelope endpoint of an ingest DSN `https://<key>@<host>/<project>`, or `null` for any other value. The server's
 * reporter parses the same DSN (`jobs/report.ts`); it is server code, so a page does not import it.
 */
export function envelopeUrlOf(dsn: string): string | null {
	let url: URL
	try {
		url = new URL(dsn.trim())
	} catch {
		return null
	}
	const project = url.pathname.slice(1)
	if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !PUBLIC_KEY.test(url.username) || url.password !== '' || !PROJECT_ID.test(project)) {
		return null
	}
	return `${url.origin}/api/${project}/envelope/?sentry_key=${url.username}&sentry_version=7`
}

/** The reporting target the browser config names, or `null` when it names no usable DSN. */
export function reportingTargetOf(config: unknown): ReportingTarget | null {
	const parsed = BrowserConfigSchema.safeParse(config)
	if (!parsed.success || parsed.data.dsn === null) return null
	const envelopeUrl = envelopeUrlOf(parsed.data.dsn)
	return envelopeUrl === null ? null : { envelopeUrl, release: parsed.data.release, environment: parsed.data.environment }
}

const cut = (text: string): string => text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT)}…`

const V8_FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/
const GECKO_FRAME = /^(?:(.*?)@)?(.+?):(\d+):(\d+)$/

function parseFrame(line: string, origin: string): BrowserFrame | null {
	const match = /^\s*at /.test(line) ? V8_FRAME.exec(line) : GECKO_FRAME.exec(line)
	const filename = match?.[2]
	if (match === null || filename === undefined || !URL.canParse(filename)) return null
	const name = match[1]?.replace(/^(?:async|new) /, '').trim()
	return {
		filename: cut(filename),
		...(name === undefined || name === '' ? {} : { function: cut(name) }),
		lineno: Number(match[3]),
		colno: Number(match[4]),
		in_app: filename.startsWith(`${origin}/`),
	}
}

/**
 * The frames of a V8, SpiderMonkey or JavaScriptCore `stack`, oldest call first as Sentry orders them, the
 * `MAX_FRAMES` nearest the throw kept. A frame whose file is no URL (an `eval`, a native function) is left out.
 */
export function parseBrowserStack(stack: string, origin: string): BrowserFrame[] {
	const frames: BrowserFrame[] = []
	for (const line of stack.split('\n')) {
		const frame = parseFrame(line, origin)
		if (frame !== null) frames.push(frame)
		if (frames.length === MAX_FRAMES) break
	}
	return frames.reverse()
}

type Mechanism = 'onerror' | 'onunhandledrejection'

interface ReportedException {
	readonly type: string
	readonly value: string
	readonly mechanism: { readonly type: Mechanism; readonly handled: false }
	readonly stacktrace?: { readonly frames: readonly BrowserFrame[] }
}

function exceptionOf(thrown: unknown, message: string, mechanism: Mechanism, origin: string): ReportedException {
	if (thrown instanceof Error) {
		const frames = typeof thrown.stack === 'string' ? parseBrowserStack(thrown.stack, origin) : []
		return {
			type: TYPE_NAME.test(thrown.name) ? thrown.name : 'Error',
			value: cut(thrown.message),
			mechanism: { type: mechanism, handled: false },
			...(frames.length === 0 ? {} : { stacktrace: { frames } }),
		}
	}
	const value = typeof thrown === 'string' ? thrown : message !== '' ? message : `a ${typeof thrown} was thrown`
	return { type: mechanism === 'onerror' ? 'Error' : 'UnhandledRejection', value: cut(value), mechanism: { type: mechanism, handled: false } }
}

const hexId = (): string => crypto.randomUUID().replaceAll('-', '')

/** The envelope of one error event. The page's address goes without its query and fragment, which may carry a key. */
export function browserEnvelope(
	exception: ReportedException,
	target: ReportingTarget,
	page: ReportingPage['location'],
	now: Date,
): string {
	const eventId = hexId()
	const event = {
		event_id: eventId,
		timestamp: now.toISOString(),
		level: 'error',
		platform: 'javascript',
		logger: 'fabrika.browser',
		request: { url: `${page.origin}${page.pathname}` },
		exception: { values: [exception] },
		...(target.release === null ? {} : { release: target.release }),
		...(target.environment === null ? {} : { environment: target.environment }),
	}
	return [JSON.stringify({ event_id: eventId, sent_at: now.toISOString() }), JSON.stringify({ type: 'event' }), JSON.stringify(event), ''].join('\n')
}

const signatureOf = (exception: ReportedException): string =>
	JSON.stringify([exception.type, exception.value, exception.stacktrace?.frames.at(-1) ?? null])

/**
 * Listen for the page's uncaught errors and unhandled rejections and send each to `target`; answers the uninstall.
 * An error equal to the one just sent is not sent again, and the page sends at most `MAX_REPORTS_PER_PAGE`. A failed
 * delivery is dropped: reporting never throws into the page.
 */
export function installErrorReporting(page: ReportingPage, target: ReportingTarget, send: RpcFetch): () => void {
	let sent = 0
	let previous = ''
	const report = (exception: ReportedException): void => {
		const signature = signatureOf(exception)
		if (sent >= MAX_REPORTS_PER_PAGE || signature === previous) return
		sent++
		previous = signature
		// A simple request (no custom header, a text body) needs no CORS preflight; `keepalive` outlives a navigation.
		void send(target.envelopeUrl, {
			method: 'POST',
			headers: { 'content-type': 'text/plain;charset=UTF-8' },
			body: browserEnvelope(exception, target, page.location, new Date()),
			credentials: 'omit',
			keepalive: true,
		}).then((response) => response.body?.cancel(), () => {})
	}
	// Read by name: an `ErrorEvent`'s `error` and `message`, a `PromiseRejectionEvent`'s `reason`, whichever class made them.
	const onError = (event: Event): void => {
		const error: unknown = Reflect.get(event, 'error')
		const message: unknown = Reflect.get(event, 'message')
		report(exceptionOf(error, typeof message === 'string' ? message : '', 'onerror', page.location.origin))
	}
	const onRejection = (event: Event): void => {
		const reason: unknown = Reflect.get(event, 'reason')
		report(exceptionOf(reason, '', 'onunhandledrejection', page.location.origin))
	}
	page.addEventListener('error', onError)
	page.addEventListener('unhandledrejection', onRejection)
	return () => {
		page.removeEventListener('error', onError)
		page.removeEventListener('unhandledrejection', onRejection)
	}
}

/**
 * Read the browser config at `configUrl` and install reporting when it names a DSN; answers the uninstall, or `null`
 * when nothing was installed. A missing, refused or unreadable config (local development, a test) installs nothing.
 */
export async function startErrorReporting(configUrl: string, fetch: RpcFetch, page: ReportingPage): Promise<(() => void) | null> {
	let target: ReportingTarget | null
	try {
		const response = await fetch(configUrl, { credentials: 'same-origin' })
		target = response.ok ? reportingTargetOf(await response.json()) : null
	} catch {
		return null
	}
	return target === null ? null : installErrorReporting(page, target, fetch)
}
