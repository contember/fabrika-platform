// The platform transport's mail receiver: an application environment, or IAM, posts one message; the relay
// authenticates the key, records the message under its idempotency key, decides the gate once, and queues it for the
// dispatcher when it passes. Runtime-neutral, but only the Bun process hands it a `MailRelay`.

import type { EmailMessage } from '@fabrika/email'
import {
	encodePlatformMailRequest,
	hashPlatformKey,
	installationMailKey,
	parsePlatformMailRequest,
	PLATFORM_MAIL_CAPABILITIES,
	PLATFORM_MAIL_SEND_PATH,
	platformMailAnswerResponse,
	type PlatformMailErrorCode,
	platformMailFingerprint,
} from '@fabrika/email/platform'
import { type JobQueue, uuidv7 } from '@fabrika/platform'
import type { ControlAppContext } from '../app'
import type { MailMessageRepository, MailMessageState, MailRuleAction, MailRuleRepository, PlatformTransportKeyRepository } from '../db'
import { error } from '../http'
import { repositories } from '../services'
import { enqueueMailDispatch, isInstallationSender, type MailDispatchMessage } from './queue'

/** The sender IAM's derived key authenticates as. */
export const INSTALLATION_IAM_SENDER = 'installation:iam'

const MAIL_RECEIVER = 'mail'

/** The base64 of the largest attachment total, plus room for the bodies and the JSON around them. */
export const MAIL_RELAY_MAX_BODY_BYTES = Math.ceil((PLATFORM_MAIL_CAPABILITIES.maxAttachmentBytes ?? 0) / 3) * 4 + 4 * 1024 * 1024

const GATE_STATES = { pass: 'queued', hold: 'held', drop: 'dropped' } as const satisfies Record<MailRuleAction, MailMessageState>

export interface MailAcceptDeps {
	readonly keys: PlatformTransportKeyRepository
	readonly messages: MailMessageRepository
	readonly rules: MailRuleRepository
	readonly queue: JobQueue<MailDispatchMessage>
	readonly installationSecret: string
	/** Whether Control has a mail transport; without one, every application message is held. */
	readonly hasTransport: boolean
	/** Unix seconds. */
	readonly now: () => number
}

/** `POST /platform/mail/send`; any other path under the row, and the Worker, which has no relay, answer 404. */
export function handleMailRelay(ctx: ControlAppContext): Promise<Response> {
	const relay = ctx.env.MAIL_RELAY
	if (relay === undefined || ctx.request.method !== 'POST' || new URL(ctx.request.url).pathname !== PLATFORM_MAIL_SEND_PATH) {
		return Promise.resolve(error(404, 'not found'))
	}
	const persistence = repositories(ctx.env)
	return acceptMail({
		keys: persistence.platformTransportKeys,
		messages: persistence.mailMessages,
		rules: persistence.mailRules,
		queue: relay.queue,
		installationSecret: relay.installationSecret,
		hasTransport: ctx.env.MAIL_TRANSPORT?.kind === 'transport',
		now: () => Math.floor(Date.now() / 1000),
	}, ctx.request)
}

export async function acceptMail(deps: MailAcceptDeps, request: Request): Promise<Response> {
	const bearer = bearerOf(request)
	if (bearer === null) return refuse('provider_unauthorized')
	let sender: string | null
	try {
		sender = await authenticate(deps, bearer)
	} catch {
		console.error('mail relay: key lookup failed')
		return refuse('provider_unavailable')
	}
	if (sender === null) return refuse('provider_unauthorized')

	const body = await readBoundedText(request, MAIL_RELAY_MAX_BODY_BYTES)
	if (body === null) return refuse('invalid_message')
	let json: unknown
	try {
		json = JSON.parse(body)
	} catch {
		return refuse('invalid_message')
	}
	const parsed = parsePlatformMailRequest(json)
	if (!parsed.ok) return refuse('invalid_message')

	try {
		return await record(deps, sender, parsed.message)
	} catch {
		console.error('mail relay: recording a message failed')
		return refuse('provider_unavailable')
	}
}

async function record(deps: MailAcceptDeps, sender: string, message: EmailMessage): Promise<Response> {
	// Nothing would ever send it, and an accepted answer would keep IAM from offering its manual link instead.
	if (isInstallationSender(sender) && !deps.hasTransport) return refuse('mail_not_configured')
	const domain = recipientDomain(message.to)
	const fingerprint = await platformMailFingerprint(message)
	const decision = await gate(deps, sender, domain)
	const { row, created } = await deps.messages.insertOrFind({
		id: uuidv7(),
		sender,
		idempotency_key: message.idempotencyKey,
		fingerprint,
		recipient_domain: domain,
		state: decision.state,
		rule_id: decision.ruleId,
		content: encodePlatformMailRequest(message),
	}, deps.now())
	if (!created) {
		return row.fingerprint === fingerprint ? platformMailAnswerResponse({ status: 'accepted', messageId: row.id }) : refuse('idempotency_conflict')
	}
	if (row.state === 'queued') await enqueueMailDispatch(deps.queue, row.id)
	console.info(`mail relay: message ${row.id} accepted as ${row.state}`)
	return platformMailAnswerResponse({ status: 'accepted', messageId: row.id })
}

/** An installation sender always passes; without a transport a message waits for a person; else the most specific rule. */
async function gate(deps: MailAcceptDeps, sender: string, domain: string): Promise<{ state: MailMessageState; ruleId: string | null }> {
	if (isInstallationSender(sender)) return { state: 'queued', ruleId: null }
	if (!deps.hasTransport) return { state: 'held', ruleId: null }
	const rule = await deps.rules.resolve(sender, domain)
	if (rule === null) return { state: 'queued', ruleId: null }
	return { state: GATE_STATES[rule.action], ruleId: rule.id }
}

/** The sender a key authenticates, or `null`. */
async function authenticate(deps: MailAcceptDeps, bearer: string): Promise<string | null> {
	const hash = await hashPlatformKey(bearer)
	if (sameDigest(hash, await hashPlatformKey(await installationMailKey(deps.installationSecret)))) return INSTALLATION_IAM_SENDER
	const key = await deps.keys.findValidByHash(hash, deps.now())
	if (key === null || key.receiver !== MAIL_RECEIVER) return null
	return `${key.app_id}@${key.env}`
}

/** Compares two hex digests of equal length without stopping at the first difference. */
function sameDigest(left: string, right: string): boolean {
	if (left.length !== right.length) return false
	let difference = 0
	for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
	return difference === 0
}

function bearerOf(request: Request): string | null {
	const match = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')
	return match?.[1] ?? null
}

/** The validated recipient's domain, lowercase: what the rules and the console match on. */
function recipientDomain(address: string): string {
	return address.slice(address.lastIndexOf('@') + 1).toLowerCase()
}

/** The body as UTF-8 text, or `null` when it is larger than `maxBytes`, unreadable or not UTF-8. */
async function readBoundedText(request: Request, maxBytes: number): Promise<string | null> {
	const declared = Number(request.headers.get('content-length') ?? '')
	if (Number.isFinite(declared) && declared > maxBytes) {
		await request.body?.cancel().catch(() => {})
		return null
	}
	if (request.body === null) return ''
	const reader = request.body.getReader()
	const chunks: Uint8Array[] = []
	let size = 0
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			size += value.byteLength
			if (size > maxBytes) {
				await reader.cancel().catch(() => {})
				return null
			}
			chunks.push(value)
		}
	} catch {
		return null
	}
	const bytes = new Uint8Array(size)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	} catch {
		return null
	}
}

function refuse(code: PlatformMailErrorCode): Response {
	return platformMailAnswerResponse({ error: { code } })
}
