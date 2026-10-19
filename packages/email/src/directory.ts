// A sender that keeps each message as a JSON file in a directory and delivers nothing: a local composition's mail
// capture, which its own tests read back with `readCapturedEmails`. Bun and Node only. The files hold the bodies, and
// with them every one-time link, so the directory belongs to the composition's disposable local state.

import { createHash, randomUUID } from 'node:crypto'
import { link, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { type EmailProvider, parseProviderVariables } from './config.js'
import { emailContentOf, sameEmailContent } from './content.js'
import { EmailDeliveryError, type EmailDeliveryResult, type EmailMessage, type EmailSender, type EmailSenderCapabilities } from './email.js'
import { validateEmailMessage } from './validation.js'

const capturedEmailSchema = z.object({
	messageId: z.string().min(1),
	idempotencyKey: z.string(),
	to: z.string(),
	subject: z.string(),
	text: z.string(),
	html: z.string().optional(),
	replyTo: z.string().optional(),
	fromName: z.string().optional(),
	unsubscribeUrl: z.string().optional(),
	capturedAt: z.number().int(),
})

export type CapturedEmail = z.infer<typeof capturedEmailSchema>

export interface DirectoryEmailSenderOptions {
	/** An existing directory, as an absolute path. */
	readonly directory: string
	readonly now?: () => number
}

export class DirectoryEmailSender implements EmailSender {
	readonly capabilities: EmailSenderCapabilities = { idempotent: true, confirmation: 'sync', maxBatch: 1, listUnsubscribe: true }
	readonly #directory: string
	readonly #now: () => number

	constructor(options: DirectoryEmailSenderOptions) {
		if (!isAbsolute(options.directory)) {
			throw new EmailDeliveryError('The mail capture directory must be an absolute path', { code: 'invalid_configuration' })
		}
		this.#directory = options.directory
		this.#now = options.now ?? Date.now
	}

	/** One file per idempotency key: a repeated send of the same message answers the first id, as a provider does. */
	async send(message: EmailMessage, signal: AbortSignal): Promise<EmailDeliveryResult> {
		validateEmailMessage(message)
		if (signal.aborted) throw new EmailDeliveryError('The mail capture was aborted by the caller', { code: 'aborted' })
		const messageId = createHash('sha256').update(message.idempotencyKey).digest('hex')
		const captured: CapturedEmail = { messageId, idempotencyKey: message.idempotencyKey, ...emailContentOf(message), capturedAt: this.#now() }
		const path = join(this.#directory, `${messageId}.json`)
		// Written aside and linked in, so a reader never sees a partial file and an existing one is never replaced.
		const pending = join(this.#directory, `.${messageId}.${randomUUID()}.tmp`)
		let existing: CapturedEmail | null
		try {
			await writeFile(pending, JSON.stringify(captured), { flag: 'wx' })
			existing = await link(pending, path).then(() => null, async (error: unknown) => {
				if (!isAlreadyCaptured(error)) throw error
				return readCapturedEmail(path)
			})
		} catch {
			throw new EmailDeliveryError('The mail capture directory could not be written', { code: 'provider_unavailable' })
		} finally {
			await unlink(pending).catch(() => undefined)
		}
		if (existing !== null && !sameEmailContent(existing, captured)) {
			throw new EmailDeliveryError('A different message was already captured under this idempotency key', { code: 'idempotency_conflict' })
		}
		return { status: 'accepted', provider: 'directory', messageId }
	}
}

const directoryVariablesSchema = z.object({ FABRIKA_EMAIL_DIRECTORY: z.string() })

/**
 * `FABRIKA_EMAIL_PROVIDER=directory`: a local composition's capture. Never in `builtinEmailProviders`; a composition
 * registers it. The capture records content only, so `FABRIKA_EMAIL_FROM` is not used.
 */
export const directoryEmailProvider: EmailProvider = {
	variables: [{ name: 'FABRIKA_EMAIL_DIRECTORY', secret: false, required: true }],
	create: ({ env }) => new DirectoryEmailSender({ directory: parseProviderVariables(directoryVariablesSchema, env).FABRIKA_EMAIL_DIRECTORY }),
}

/** Every message a `DirectoryEmailSender` captured in `directory`, oldest first. */
export async function readCapturedEmails(directory: string): Promise<CapturedEmail[]> {
	const names = (await readdir(directory)).filter((name) => name.endsWith('.json') && !name.startsWith('.'))
	const emails = await Promise.all(names.map((name) => readCapturedEmail(join(directory, name))))
	return emails.sort((left, right) => left.capturedAt - right.capturedAt || left.messageId.localeCompare(right.messageId))
}

async function readCapturedEmail(path: string): Promise<CapturedEmail> {
	return capturedEmailSchema.parse(JSON.parse(await readFile(path, 'utf8')))
}

function isAlreadyCaptured(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}
