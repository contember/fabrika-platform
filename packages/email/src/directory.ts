// A sender that keeps each message as a JSON file in a directory and delivers nothing: a local composition's mail
// capture, which its own tests read back with `readCapturedEmails`. Bun and Node only. The files hold the bodies, and
// with them every one-time link, so the directory belongs to the composition's disposable local state.

import { createHash, randomUUID } from 'node:crypto'
import { link, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { EmailDeliveryError, type EmailDeliveryResult, type EmailMessage, type EmailSender } from './email.js'
import { validateEmailMessage } from './validation.js'

const capturedEmailSchema = z.object({
	messageId: z.string().min(1),
	to: z.string(),
	subject: z.string(),
	text: z.string(),
	html: z.string().optional(),
	capturedAt: z.number().int(),
})

export type CapturedEmail = z.infer<typeof capturedEmailSchema>

export interface DirectoryEmailSenderOptions {
	/** An existing directory, as an absolute path. */
	readonly directory: string
	readonly now?: () => number
}

export class DirectoryEmailSender implements EmailSender {
	readonly #directory: string
	readonly #now: () => number

	constructor(options: DirectoryEmailSenderOptions) {
		if (!isAbsolute(options.directory)) {
			throw new EmailDeliveryError('The mail capture directory must be an absolute path', { code: 'invalid_configuration', retryable: false })
		}
		this.#directory = options.directory
		this.#now = options.now ?? Date.now
	}

	/** One file per idempotency key: a repeated send keeps the first message and answers the same id, as a provider does. */
	async send(message: EmailMessage): Promise<EmailDeliveryResult> {
		validateEmailMessage(message)
		const messageId = createHash('sha256').update(message.idempotencyKey).digest('hex')
		const captured: CapturedEmail = {
			messageId,
			to: message.to,
			subject: message.subject,
			text: message.text,
			...(message.html === undefined ? {} : { html: message.html }),
			capturedAt: this.#now(),
		}
		// Written aside and linked in, so a reader never sees a partial file and an existing one is never replaced.
		const pending = join(this.#directory, `.${messageId}.${randomUUID()}.tmp`)
		try {
			await writeFile(pending, JSON.stringify(captured), { flag: 'wx' })
			await link(pending, join(this.#directory, `${messageId}.json`)).catch((error: unknown) => {
				if (!isAlreadyCaptured(error)) throw error
			})
		} catch {
			throw new EmailDeliveryError('The mail capture directory could not be written', { code: 'provider_unavailable', retryable: true })
		} finally {
			await unlink(pending).catch(() => undefined)
		}
		return { status: 'accepted', provider: 'directory', messageId }
	}
}

/** Every message a `DirectoryEmailSender` captured in `directory`, oldest first. */
export async function readCapturedEmails(directory: string): Promise<CapturedEmail[]> {
	const names = (await readdir(directory)).filter((name) => name.endsWith('.json') && !name.startsWith('.'))
	const emails = await Promise.all(names.map(async (name) => capturedEmailSchema.parse(JSON.parse(await readFile(join(directory, name), 'utf8')))))
	return emails.sort((left, right) => left.capturedAt - right.capturedAt || left.messageId.localeCompare(right.messageId))
}

function isAlreadyCaptured(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}
