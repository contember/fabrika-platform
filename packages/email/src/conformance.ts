// The cases every `EmailSender` passes, built-in or not. An adapter's own test file calls
// `describeEmailSenderConformance` once with a harness: an HTTP adapter gets a stubbed fetch and says how to read its
// request and how its provider answers; a local sender says where it stores what it took.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { type EmailAttachmentContent, emailContentOf } from './content.js'
import {
	EMAIL_DELIVERY_ERRORS,
	EmailDeliveryError,
	type EmailDeliveryErrorCode,
	type EmailFetch,
	type EmailMessage,
	type EmailSender,
} from './email.js'

/** What the provider received, or what a local sender stored, in the message's own terms. */
export interface WireMessage {
	readonly to: string
	readonly subject: string
	readonly text: string
	readonly html?: string
	readonly replyTo?: string
	readonly fromName?: string
	readonly idempotencyKey?: string
	/** The URL of the `List-Unsubscribe` header, when `List-Unsubscribe-Post` says one click. */
	readonly unsubscribeUrl?: string
	/** Each attachment with its bytes as base64. */
	readonly attachments?: readonly EmailAttachmentContent[]
}

/** A stored or sent message in wire terms: what a local harness answers for an `EmailMessage` it kept. */
export function wireMessageOf(message: EmailMessage): WireMessage {
	return { ...emailContentOf(message), idempotencyKey: message.idempotencyKey }
}

/** How the provider answers. `inProgress` and `idempotencyConflict` are required when the sender is idempotent. */
export interface ProviderAnswers {
	accepted(request: Request): Response
	malformedSuccess(): Response
	unauthorized(): Response
	rejected(): Response
	rateLimited(): Response
	unavailable(): Response
	quotaExceeded?(): Response
	inProgress?(): Response
	idempotencyConflict?(): Response
}

export interface EmailSenderHttpHarness {
	readonly kind: 'http'
	/** Credentials the sender holds; none may appear in an error or a log line. */
	readonly secrets: readonly string[]
	create(fetch: EmailFetch, options: { readonly timeoutMs: number }): EmailSender
	readRequest(request: Request): Promise<WireMessage>
	readonly answers: ProviderAnswers
}

/** A local sender's I/O cannot be held open from outside, so the abort-during-I/O cases run for HTTP senders only. */
export interface EmailSenderLocalHarness {
	readonly kind: 'local'
	/** Called before each case. */
	create(): Promise<EmailSender>
	/** What the sender created by the last `create` stored, oldest first. */
	stored(): Promise<readonly WireMessage[]>
	/** Called after each case. */
	cleanup?(): Promise<void>
}

export type EmailSenderConformanceHarness = EmailSenderHttpHarness | EmailSenderLocalHarness

const TIMEOUT_MS = 50
const SUBJECT = 'Conformance subject 5d1c'
const TEXT = 'Conformance text body 8e2f'
const HTML = '<p>Conformance html body 3a7b</p>'
const MESSAGE_MARKERS = [SUBJECT, TEXT, HTML]
/** Shorter strings in a response body are field names and statuses, which an error message may share by chance. */
const MIN_BODY_MARKER_LENGTH = 8

const FULL_MESSAGE: EmailMessage = {
	to: 'recipient@example.test',
	subject: SUBJECT,
	text: TEXT,
	html: HTML,
	idempotencyKey: 'conformance/full-1',
	replyTo: 'replies@example.test',
	fromName: 'Conformance Sender',
}

const MINIMAL_MESSAGE: EmailMessage = {
	to: 'recipient@example.test',
	subject: SUBJECT,
	text: TEXT,
	idempotencyKey: 'conformance/minimal-1',
}

const UNSUBSCRIBE_MESSAGE: EmailMessage = {
	...MINIMAL_MESSAGE,
	idempotencyKey: 'conformance/unsubscribe-1',
	unsubscribeUrl: 'https://app.example.test/api/mail.unsubscribe?t=conformance-token-6c2e',
}

const ATTACHMENT_MESSAGE: EmailMessage = {
	...MINIMAL_MESSAGE,
	idempotencyKey: 'conformance/attachment-1',
	attachments: [{ filename: 'conformance report.txt', contentType: 'text/plain', content: new TextEncoder().encode('Conformance attachment 9d4e') }],
}

/** The same message under its key, with other bytes in its one attachment. */
const OTHER_ATTACHMENT_MESSAGE: EmailMessage = {
	...ATTACHMENT_MESSAGE,
	attachments: [{ filename: 'conformance report.txt', contentType: 'text/plain', content: new TextEncoder().encode('Conformance attachment 0f1a') }],
}

function oversizedMessage(maxAttachmentBytes: number): EmailMessage {
	return {
		...MINIMAL_MESSAGE,
		idempotencyKey: 'conformance/oversized-1',
		attachments: [{ filename: 'large.bin', contentType: 'application/octet-stream', content: new Uint8Array(maxAttachmentBytes + 1) }],
	}
}

const ONE_BYTE = new Uint8Array([0x61])

const INVALID_MESSAGES: readonly { readonly problem: string; readonly message: EmailMessage }[] = [
	{ problem: 'a bad recipient', message: { ...MINIMAL_MESSAGE, to: 'not-an-address' } },
	{ problem: 'an empty subject', message: { ...MINIMAL_MESSAGE, subject: '' } },
	{ problem: 'a subject with CRLF', message: { ...MINIMAL_MESSAGE, subject: 'Bad\r\nsubject' } },
	{ problem: 'a blank text', message: { ...MINIMAL_MESSAGE, text: '   ' } },
	{ problem: 'an empty key', message: { ...MINIMAL_MESSAGE, idempotencyKey: '' } },
	{ problem: 'a key with a space', message: { ...MINIMAL_MESSAGE, idempotencyKey: 'has space' } },
	{ problem: 'a key over 256 characters', message: { ...MINIMAL_MESSAGE, idempotencyKey: 'x'.repeat(257) } },
	{ problem: 'a bad reply-to', message: { ...MINIMAL_MESSAGE, replyTo: 'not-an-address' } },
	{ problem: 'a sender name with brackets', message: { ...MINIMAL_MESSAGE, fromName: 'Bad <name>' } },
	{ problem: 'a sender name over 128 characters', message: { ...MINIMAL_MESSAGE, fromName: 'x'.repeat(129) } },
	{ problem: 'an unsubscribe URL over http', message: { ...MINIMAL_MESSAGE, unsubscribeUrl: 'http://app.example.test/u' } },
	{ problem: 'an unsubscribe URL with a bracket', message: { ...MINIMAL_MESSAGE, unsubscribeUrl: 'https://app.example.test/u>x' } },
	{
		problem: 'an attachment name with a path',
		message: { ...MINIMAL_MESSAGE, attachments: [{ filename: '../etc/passwd', contentType: 'text/plain', content: ONE_BYTE }] },
	},
	{
		problem: 'an attachment type with a line break',
		message: { ...MINIMAL_MESSAGE, attachments: [{ filename: 'a.txt', contentType: 'text/plain\r\nX-Bad: 1', content: ONE_BYTE }] },
	},
	{
		problem: 'more than 20 attachments',
		message: {
			...MINIMAL_MESSAGE,
			attachments: Array.from({ length: 21 }, () => ({ filename: 'a.txt', contentType: 'text/plain', content: ONE_BYTE })),
		},
	},
]

/**
 * Registers the conformance cases for one sender. HTTP harnesses also get the provider answer table, the thrown and
 * silent fetch, and an abort or a timeout while the request or the answer body is in flight; a local harness gets
 * only the already-aborted case, because nothing can hold its I/O open.
 */
export function describeEmailSenderConformance(name: string, harness: EmailSenderConformanceHarness): void {
	describe(`${name} conforms to EmailSender`, () => {
		if (harness.kind === 'http') describeHttpSender(harness)
		else describeLocalSender(harness)
	})
}

type Handler = (request: Request, signal: AbortSignal | undefined) => Promise<Response>

interface HttpCase {
	readonly sender: EmailSender
	readonly requests: Request[]
	/** Every string of length ≥ MIN_BODY_MARKER_LENGTH in the bodies the provider answered with. */
	readonly bodyMarkers: string[]
	/** The status of each answer, in order. */
	readonly statuses: number[]
}

function describeHttpSender(harness: EmailSenderHttpHarness): void {
	/** Read after the call settles, when the answer bodies are known. */
	const forbidden = (current: HttpCase) => (): string[] => [...MESSAGE_MARKERS, ...harness.secrets, ...current.bodyMarkers]

	/** `stalledBody`: the handler answers a body that never ends, which the stub must not read itself. */
	function httpCase(handler: Handler, options: { readonly stalledBody?: boolean } = {}): HttpCase {
		const requests: Request[] = []
		const bodyMarkers: string[] = []
		const statuses: number[] = []
		const fetch: EmailFetch = async (input, init) => {
			const request = new Request(input, init)
			requests.push(request.clone())
			const response = await handler(request, init?.signal ?? undefined)
			statuses.push(response.status)
			if (options.stalledBody !== true) bodyMarkers.push(...markersOf(await response.clone().text()))
			return response
		}
		return { sender: harness.create(fetch, { timeoutMs: TIMEOUT_MS }), requests, bodyMarkers, statuses }
	}

	const answering = (answer: () => Response): HttpCase => httpCase(async () => answer())

	test('reports its capabilities', () => {
		expectCapabilities(answering(() => harness.answers.malformedSuccess()).sender)
	})

	test('answers an accepted result', async () => {
		const current = httpCase(async (request) => harness.answers.accepted(request))
		expectAccepted(await current.sender.send(FULL_MESSAGE, new AbortController().signal))
		expect(current.requests).toHaveLength(1)
	})

	test('hands every field of the message to the provider', async () => {
		const current = httpCase(async (request) => harness.answers.accepted(request))
		await current.sender.send(FULL_MESSAGE, new AbortController().signal)
		const wire = await harness.readRequest(only(current.requests))
		expect(wire).toMatchObject(contentOf(FULL_MESSAGE))
		if (current.sender.capabilities.idempotent) expect(wire.idempotencyKey).toBe(FULL_MESSAGE.idempotencyKey)
	})

	test('leaves html, reply-to and sender name out when the message has none', async () => {
		const current = httpCase(async (request) => harness.answers.accepted(request))
		await current.sender.send(MINIMAL_MESSAGE, new AbortController().signal)
		expectOptionalFieldsAbsent(await harness.readRequest(only(current.requests)))
	})

	test('writes the one-click unsubscribe headers it says it writes, and refuses them otherwise', async () => {
		const current = httpCase(async (request) => harness.answers.accepted(request))
		if (current.sender.capabilities.listUnsubscribe === true) {
			await current.sender.send(UNSUBSCRIBE_MESSAGE, new AbortController().signal)
			expect((await harness.readRequest(only(current.requests))).unsubscribeUrl).toBe(UNSUBSCRIBE_MESSAGE.unsubscribeUrl)
			return
		}
		await expectRejection(() => current.sender.send(UNSUBSCRIBE_MESSAGE, new AbortController().signal), 'invalid_message', () => MESSAGE_MARKERS)
		expect(current.requests).toHaveLength(0)
	})

	test('hands the attachments it says it sends to the provider, and refuses them otherwise', async () => {
		const current = httpCase(async (request) => harness.answers.accepted(request))
		if (current.sender.capabilities.maxAttachmentBytes !== undefined) {
			await current.sender.send(ATTACHMENT_MESSAGE, new AbortController().signal)
			expect((await harness.readRequest(only(current.requests))).attachments).toEqual(wireMessageOf(ATTACHMENT_MESSAGE).attachments)
			return
		}
		await expectRejection(() => current.sender.send(ATTACHMENT_MESSAGE, new AbortController().signal), 'invalid_message', () => MESSAGE_MARKERS)
		expect(current.requests).toHaveLength(0)
	})

	test('refuses attachments over its limit without a request', async () => {
		const current = httpCase(async (request) => harness.answers.accepted(request))
		const limit = current.sender.capabilities.maxAttachmentBytes
		if (limit === undefined) return
		await expectRejection(() => current.sender.send(oversizedMessage(limit), new AbortController().signal), 'invalid_message', () => MESSAGE_MARKERS)
		expect(current.requests).toHaveLength(0)
	})

	test('refuses an attachment of a file type it says it refuses, without a request', async () => {
		const current = httpCase(async (request) => harness.answers.accepted(request))
		const extension = current.sender.capabilities.refusedAttachmentExtensions?.[0]
		if (extension === undefined || current.sender.capabilities.maxAttachmentBytes === undefined) return
		const message: EmailMessage = {
			...ATTACHMENT_MESSAGE,
			attachments: [{ filename: `report.${extension.toUpperCase()}`, contentType: 'application/octet-stream', content: ONE_BYTE }],
		}
		await expectRejection(() => current.sender.send(message, new AbortController().signal), 'invalid_message', () => MESSAGE_MARKERS)
		expect(current.requests).toHaveLength(0)
	})

	test('refuses a body shorter than it says it sends, counted in characters once trimmed, without a request', async () => {
		const current = httpCase(async (request) => harness.answers.accepted(request))
		const min = current.sender.capabilities.minBodyLength
		if (min === undefined) return
		const short = ` ${'😀'.repeat(min - 1)} `
		for (const message of [{ ...MINIMAL_MESSAGE, text: short }, { ...MINIMAL_MESSAGE, html: short }]) {
			await expectRejection(() => current.sender.send(message, new AbortController().signal), 'invalid_message', () => MESSAGE_MARKERS)
		}
		expect(current.requests).toHaveLength(0)
		await current.sender.send({ ...MINIMAL_MESSAGE, text: '😀'.repeat(min) }, new AbortController().signal)
		expect(current.requests).toHaveLength(1)
	})

	test.each(INVALID_MESSAGES)('refuses $problem as invalid_message without a request', async ({ message }) => {
		const current = httpCase(async (request) => harness.answers.accepted(request))
		await expectRejection(() => current.sender.send(message, new AbortController().signal), 'invalid_message', forbidden(current))
		expect(current.requests).toHaveLength(0)
	})

	test('an already aborted signal answers aborted without a request', async () => {
		const current = httpCase(async (request) => harness.answers.accepted(request))
		await expectRejection(() => current.sender.send(FULL_MESSAGE, AbortSignal.abort()), 'aborted', forbidden(current))
		expect(current.requests).toHaveLength(0)
	})

	test('an abort during the request answers aborted with an unknown outcome', async () => {
		const controller = new AbortController()
		const current = httpCase((_request, signal) => {
			if (signal === undefined) return Promise.reject(new Error('the request carries no signal'))
			const pending = new Promise<Response>((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
			})
			controller.abort()
			return pending
		})
		const error = await expectRejection(() => current.sender.send(FULL_MESSAGE, controller.signal), 'aborted', forbidden(current))
		expect(error.outcome).toBe('unknown')
	})

	test('every provider answer maps to its code and keeps the HTTP status', async () => {
		const probe = answering(() => harness.answers.malformedSuccess()).sender
		const answers = harness.answers
		const table: [string, (() => Response) | undefined, EmailDeliveryErrorCode][] = [
			['unauthorized', () => answers.unauthorized(), 'provider_unauthorized'],
			['rejected', () => answers.rejected(), 'provider_rejected'],
			['rateLimited', () => answers.rateLimited(), 'rate_limited'],
			['unavailable', () => answers.unavailable(), 'provider_unavailable'],
			['malformedSuccess', () => answers.malformedSuccess(), 'malformed_response'],
			['quotaExceeded', answers.quotaExceeded?.bind(answers), 'quota_exceeded'],
			['inProgress', answers.inProgress?.bind(answers), 'request_in_progress'],
			['idempotencyConflict', answers.idempotencyConflict?.bind(answers), 'idempotency_conflict'],
		]
		for (const [answerName, answer, code] of table) {
			if (answer === undefined) {
				const requiredByIdempotency = code === 'request_in_progress' || code === 'idempotency_conflict'
				if (requiredByIdempotency && probe.capabilities.idempotent) throw new Error(`An idempotent sender's harness must supply ${answerName}`)
				continue
			}
			const current = answering(answer)
			const error = await expectRejection(() => current.sender.send(FULL_MESSAGE, new AbortController().signal), code, forbidden(current))
			expect(error.httpStatus).toBe(only(current.statuses))
		}
	})

	test('a fetch that throws answers network_error', async () => {
		const current = httpCase(() => Promise.reject(new Error(`socket closed ${harness.secrets.join(' ')} ${TEXT}`)))
		await expectRejection(() => current.sender.send(FULL_MESSAGE, new AbortController().signal), 'network_error', forbidden(current))
	})

	test('a provider that never answers times out at the configured timeout', async () => {
		const current = httpCase((_request, signal) =>
			new Promise<Response>((_resolve, reject) => {
				signal?.addEventListener('abort', () => reject(new Error('timed out')), { once: true })
			})
		)
		const started = Date.now()
		await expectRejection(() => current.sender.send(FULL_MESSAGE, new AbortController().signal), 'request_timeout', forbidden(current))
		expect(Date.now() - started).toBeGreaterThanOrEqual(TIMEOUT_MS - 5)
	})

	test('an abort while the answer body arrives answers aborted', async () => {
		const controller = new AbortController()
		const current = httpCase(async () => {
			setTimeout(() => controller.abort(), 5)
			return stalledAnswer()
		}, { stalledBody: true })
		const error = await expectRejection(() => current.sender.send(FULL_MESSAGE, controller.signal), 'aborted', forbidden(current))
		expect(error.outcome).toBe('unknown')
	})

	test('an answer body that never finishes times out', async () => {
		const current = httpCase(async () => stalledAnswer(), { stalledBody: true })
		await expectRejection(() => current.sender.send(FULL_MESSAGE, new AbortController().signal), 'request_timeout', forbidden(current))
	})
}

/** A 200 whose body never ends. */
function stalledAnswer(): Response {
	return new Response(new ReadableStream({ start() {} }), { status: 200 })
}

function describeLocalSender(harness: EmailSenderLocalHarness): void {
	let sender: EmailSender | null = null
	const current = (): EmailSender => {
		if (sender === null) throw new Error('the harness created no sender')
		return sender
	}

	beforeEach(async () => {
		sender = await harness.create()
	})

	afterEach(async () => {
		sender = null
		await harness.cleanup?.()
	})

	test('reports its capabilities', () => {
		expectCapabilities(current())
	})

	test('answers an accepted result', async () => {
		expectAccepted(await current().send(FULL_MESSAGE, new AbortController().signal))
	})

	test('stores every field of the message', async () => {
		await current().send(FULL_MESSAGE, new AbortController().signal)
		expect(only(await harness.stored())).toMatchObject(contentOf(FULL_MESSAGE))
	})

	test('leaves html, reply-to and sender name out when the message has none', async () => {
		await current().send(MINIMAL_MESSAGE, new AbortController().signal)
		expectOptionalFieldsAbsent(only(await harness.stored()))
	})

	test('stores the one-click unsubscribe URL it says it writes, and refuses it otherwise', async () => {
		if (current().capabilities.listUnsubscribe === true) {
			await current().send(UNSUBSCRIBE_MESSAGE, new AbortController().signal)
			expect(only(await harness.stored()).unsubscribeUrl).toBe(UNSUBSCRIBE_MESSAGE.unsubscribeUrl)
			return
		}
		await expectRejection(() => current().send(UNSUBSCRIBE_MESSAGE, new AbortController().signal), 'invalid_message', () => MESSAGE_MARKERS)
		expect(await harness.stored()).toHaveLength(0)
	})

	test('stores the attachments it says it sends, and refuses them otherwise', async () => {
		const limit = current().capabilities.maxAttachmentBytes
		if (limit !== undefined) {
			await current().send(ATTACHMENT_MESSAGE, new AbortController().signal)
			expect(only(await harness.stored()).attachments).toEqual(wireMessageOf(ATTACHMENT_MESSAGE).attachments)
			await expectRejection(() => current().send(oversizedMessage(limit), new AbortController().signal), 'invalid_message', () => MESSAGE_MARKERS)
			expect(await harness.stored()).toHaveLength(1)
			return
		}
		await expectRejection(() => current().send(ATTACHMENT_MESSAGE, new AbortController().signal), 'invalid_message', () => MESSAGE_MARKERS)
		expect(await harness.stored()).toHaveLength(0)
	})

	test('an idempotent sender refuses other attachment bytes under the same key', async () => {
		const target = current()
		if (!target.capabilities.idempotent || target.capabilities.maxAttachmentBytes === undefined) return
		await target.send(ATTACHMENT_MESSAGE, new AbortController().signal)
		await expectRejection(() => target.send(OTHER_ATTACHMENT_MESSAGE, new AbortController().signal), 'idempotency_conflict', () => MESSAGE_MARKERS)
		expect(await harness.stored()).toHaveLength(1)
	})

	test.each(INVALID_MESSAGES)('refuses $problem as invalid_message and stores nothing', async ({ message }) => {
		await expectRejection(() => current().send(message, new AbortController().signal), 'invalid_message', () => MESSAGE_MARKERS)
		expect(await harness.stored()).toHaveLength(0)
	})

	test('an already aborted signal answers aborted and stores nothing', async () => {
		await expectRejection(() => current().send(FULL_MESSAGE, AbortSignal.abort()), 'aborted', () => MESSAGE_MARKERS)
		expect(await harness.stored()).toHaveLength(0)
	})

	test('an idempotent sender stores a repeated message once and refuses a different one under the same key', async () => {
		const target = current()
		if (!target.capabilities.idempotent) return
		const first = await target.send(FULL_MESSAGE, new AbortController().signal)
		const repeated = await target.send(FULL_MESSAGE, new AbortController().signal)
		expect(repeated.messageId).toBe(first.messageId)
		expect(await harness.stored()).toHaveLength(1)
		await expectRejection(
			() => target.send({ ...FULL_MESSAGE, text: `${TEXT} changed` }, new AbortController().signal),
			'idempotency_conflict',
			() => MESSAGE_MARKERS,
		)
		expect(await harness.stored()).toHaveLength(1)
	})
}

function expectCapabilities(sender: EmailSender): void {
	const { idempotent, confirmation, maxBatch } = sender.capabilities
	expect(typeof idempotent).toBe('boolean')
	expect(['sync', 'queued']).toContain(confirmation)
	expect(Number.isSafeInteger(maxBatch) && maxBatch > 0).toBe(true)
}

function expectAccepted(result: Awaited<ReturnType<EmailSender['send']>>): void {
	expect(result.status).toBe('accepted')
	expect(result.provider).not.toBe('')
	expect(result.messageId).not.toBe('')
}

function expectOptionalFieldsAbsent(wire: WireMessage): void {
	expect(wire.html).toBeUndefined()
	expect(wire.replyTo).toBeUndefined()
	expect(wire.fromName).toBeUndefined()
	expect(wire.unsubscribeUrl).toBeUndefined()
	expect(wire.attachments).toBeUndefined()
}

function contentOf(message: EmailMessage): WireMessage {
	return {
		to: message.to,
		subject: message.subject,
		text: message.text,
		...(message.html === undefined ? {} : { html: message.html }),
		...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
		...(message.fromName === undefined ? {} : { fromName: message.fromName }),
	}
}

/** The rejection, checked against the classification table and for anything it must never carry. */
async function expectRejection(
	run: () => Promise<unknown>,
	code: EmailDeliveryErrorCode,
	forbidden: () => readonly string[],
): Promise<EmailDeliveryError> {
	const logged: string[] = []
	const restore = captureConsole(logged)
	let reason: unknown
	try {
		reason = await run().then(() => undefined, (error: unknown) => error)
	} finally {
		restore()
	}
	if (!(reason instanceof EmailDeliveryError)) throw new Error(`expected an EmailDeliveryError with code ${code}`)
	expect(reason.code).toBe(code)
	expect({ retryable: reason.retryable, outcome: reason.outcome }).toEqual(EMAIL_DELIVERY_ERRORS[code])
	const surfaces = [reason.message, String(reason), JSON.stringify(reason), ...logged]
	for (const value of forbidden()) {
		for (const surface of surfaces) expect(surface).not.toContain(value)
	}
	return reason
}

function captureConsole(logged: string[]): () => void {
	const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug }
	const record = (...args: unknown[]): void => {
		logged.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack ?? ''}` : safeString(arg))).join(' '))
	}
	console.log = record
	console.info = record
	console.warn = record
	console.error = record
	console.debug = record
	return () => {
		Object.assign(console, originals)
	}
}

function safeString(value: unknown): string {
	if (typeof value === 'string') return value
	try {
		return JSON.stringify(value) ?? String(value)
	} catch {
		return String(value)
	}
}

function markersOf(body: string): string[] {
	const markers: string[] = []
	const collect = (value: unknown): void => {
		// A delivery error code is the contract's own vocabulary, which a relay answers with, not provider content.
		if (typeof value === 'string' && value.length >= MIN_BODY_MARKER_LENGTH && !Object.hasOwn(EMAIL_DELIVERY_ERRORS, value)) markers.push(value)
		else if (Array.isArray(value)) value.forEach(collect)
		else if (typeof value === 'object' && value !== null) Object.values(value).forEach(collect)
	}
	try {
		collect(JSON.parse(body))
	} catch {
		collect(body)
	}
	return markers
}

function only<T>(items: readonly T[]): T {
	expect(items).toHaveLength(1)
	const item = items[0]
	if (item === undefined) throw new Error('expected exactly one item')
	return item
}
