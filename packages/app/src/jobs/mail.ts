// `ctx.mail` of a job that declares `mailer`, over the transport `boot` resolved: the installation's (`FABRIKA_EMAIL_*`),
// the application's own (`serve(contract, { mail })`) or the test kit's stand-in. An installation without a transport
// says so (`FABRIKA_EMAIL_PROVIDER=none`): its jobs get `ctx.mail` that is not available, and each send waits for one.
// Each key carries the prefix of the installation and the application environment, so senders on one provider account
// never share a key. Nothing here logs a message or a key.

import { type ContractArtifact, JOB_SITE_PREFIX, type JobMailer, sha256Hex } from '@fabrika/auth-core'
import {
	EMAIL_PROVIDER_VARIABLE,
	EmailDeliveryError,
	type EmailDeliveryResult,
	type EmailMessage,
	type EmailProviderRegistry,
	type EmailSender,
	emailSenderFromEnv,
	mayRetryDelivery,
	NO_EMAIL_PROVIDER,
	pickEmailEnvironment,
} from '@fabrika/email'
import { z } from 'zod/v4'
import type { ApplicationEnvironment } from '../implement/implement'
import type { AppMail, AppMailMessage } from './types'

export const MAX_APP_MAIL_KEY_LENGTH = 200
const PREFIX_DIGEST_LENGTH = 32
const APP_MAIL_KEY = new RegExp(`^[\\x21-\\x7E]{1,${MAX_APP_MAIL_KEY_LENGTH}}$`)

/** Whose keys a prefix separates: the installation, by IAM's public origin, and the application environment in it. */
export interface MailKeyScope {
	/** `FABRIKA_IAM_ISSUER` as an origin: it tells installations, and the local stack, apart. */
	readonly issuer: string
	/** `FABRIKA_IAM_APP_ID`, `<app>@<env>`. */
	readonly appId: string
}

/**
 * `fabrika:<the first 32 hex of sha256('<issuer>\n<app>@<env>')>:` — 41 characters, whatever the names hold. Renaming
 * IAM's domain changes every key once, so a message in flight across the rename may be sent again.
 */
export function mailKeyPrefix(scope: MailKeyScope): string {
	return `fabrika:${sha256Hex(`${scope.issuer}\n${scope.appId}`).slice(0, PREFIX_DIGEST_LENGTH)}:`
}

/** The key the transport receives for the application's `key`. */
export function transportMailKey(scope: MailKeyScope, key: string): string {
	return `${mailKeyPrefix(scope)}${key}`
}

/** A mailer job's transport: one that sends, or the stated absence of one, whose every send fails `mail_not_configured`. */
export interface JobMailTransport {
	readonly sender: EmailSender
	readonly available: boolean
}

/** The transports of a contract's mailer jobs, resolved once by `boot`; `null` where no job declares that mailer. */
export interface MailTransports {
	readonly installation: JobMailTransport | null
	readonly own: JobMailTransport | null
	readonly keyPrefix: string
}

/** The test kit's transport for every mailer job: a stand-in sender, or `'none'` for an installation without mail. */
export type MailStandIn = EmailSender | 'none'

/** The application's own transport, built once at boot from its own variables; `null` when they configure none. */
export type OwnMailTransport = (env: ApplicationEnvironment) => EmailSender | null

export interface JobMailInput {
	readonly transport: JobMailTransport
	readonly keyPrefix: string
	/** The attempt's `ctx.signal`: it aborts every send of the attempt. */
	readonly signal: AbortSignal
	/** Throws once the attempt has ended. */
	readonly assertLive: () => void
}

export function jobMail(input: JobMailInput): AppMail {
	const { transport: { sender, available }, keyPrefix, signal: attempt, assertLive } = input
	return Object.freeze({
		available,
		capabilities: sender.capabilities,
		async send(message: AppMailMessage, signal?: AbortSignal): Promise<EmailDeliveryResult> {
			assertLive()
			const key: unknown = message.idempotencyKey
			if (typeof key !== 'string' || !APP_MAIL_KEY.test(key)) {
				throw new EmailDeliveryError(`Email idempotency key is not 1..${MAX_APP_MAIL_KEY_LENGTH} visible ASCII characters`, { code: 'invalid_message' })
			}
			const transported: EmailMessage = {
				to: message.to,
				subject: message.subject,
				text: message.text,
				...(message.html === undefined ? {} : { html: message.html }),
				idempotencyKey: `${keyPrefix}${key}`,
				...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
				...(message.fromName === undefined ? {} : { fromName: message.fromName }),
				...(message.unsubscribe === undefined ? {} : { unsubscribeUrl: message.unsubscribe.url }),
			}
			try {
				return await sender.send(transported, signal === undefined ? attempt : AbortSignal.any([attempt, signal]))
			} catch (error) {
				if (error instanceof EmailDeliveryError) {
					throw error
				}
				// An application's own transport may throw anything, and its message may quote a credential: it is dropped unread.
				throw new EmailDeliveryError('The transport failed', { code: 'provider_unavailable' })
			}
		},
		mayRetry: (error: unknown): boolean => error instanceof EmailDeliveryError && mayRetryDelivery(error, sender.capabilities),
	})
}

export interface MailTransportInput {
	readonly artifact: ContractArtifact
	/** The framework's variables, whose `FABRIKA_EMAIL_*` configure the installation's transport. */
	readonly framework: Readonly<Record<string, string>>
	readonly application: ApplicationEnvironment
	/** `serve(contract, { mail })`. */
	readonly own: OwnMailTransport | undefined
	/** The test kit's transport for every mailer job; the variables and `own` are then not read. */
	readonly standIn: MailStandIn | undefined
	readonly registry: EmailProviderRegistry
	/** Whose keys the prefix separates. */
	readonly keyScope: MailKeyScope
	/** A local composition: a missing transport is no mail, as `FABRIKA_EMAIL_PROVIDER=none` is, instead of a refused boot. */
	readonly local: boolean
}

/** The transports of the contract's mailer jobs, or why one of them cannot send, added to `problems`. */
export function resolveMailTransports(input: MailTransportInput, problems: string[]): MailTransports {
	const keyPrefix = mailKeyPrefix(input.keyScope)
	const jobs = mailerJobs(input.artifact)
	if (input.own === undefined) {
		for (const name of jobs.own) {
			problems.push(`job '${name}' declares mailer: 'own', and serve(contract, { … }) has no mail: pass mail: (env) => EmailSender`)
		}
	} else if (jobs.own.length === 0) {
		problems.push(`serve(contract, { mail }) builds a transport no job uses: declare mailer: 'own' on the job that sends, or remove mail`)
	}
	if (input.standIn !== undefined) {
		const standIn = input.standIn === 'none' ? NO_MAIL : { sender: input.standIn, available: true }
		return {
			installation: jobs.installation.length === 0 ? null : standIn,
			own: jobs.own.length === 0 ? null : standIn,
			keyPrefix,
		}
	}
	return {
		installation: jobs.installation.length === 0 ? null : installationTransport(jobs.installation, input, problems),
		own: jobs.own.length === 0 ? null : ownTransport(jobs.own, input, problems),
		keyPrefix,
	}
}

/** The names of the jobs that declare each mailer, by the approved artifact. */
function mailerJobs(artifact: ContractArtifact): Readonly<Record<JobMailer, readonly string[]>> {
	const jobs: Record<JobMailer, string[]> = { installation: [], own: [] }
	for (const name of Object.keys(artifact.jobs)) {
		const mailer = artifact.declared?.[`${JOB_SITE_PREFIX}${name}`]?.mailer
		if (mailer !== undefined) {
			jobs[mailer].push(name)
		}
	}
	return jobs
}

function installationTransport(names: readonly string[], input: MailTransportInput, problems: string[]): JobMailTransport | null {
	const env = pickEmailEnvironment(input.framework)
	let sender: EmailSender | null
	try {
		sender = emailSenderFromEnv(env, input.registry)
	} catch (error) {
		if (!(error instanceof EmailDeliveryError)) {
			throw error
		}
		// Its message names variables, never their values; a local installation is refused too, as it is misconfigured.
		problems.push(`the installation's mail transport: ${error.message}`)
		return null
	}
	if (sender !== null) {
		return { sender, available: true }
	}
	if (env[EMAIL_PROVIDER_VARIABLE] === NO_EMAIL_PROVIDER || input.local) {
		return noMail(names, 'installation')
	}
	// Control writes the variable on every deploy that needs it, `none` included: its absence means no deploy wrote it.
	for (const name of names) {
		problems.push(
			`job '${name}' declares mailer: 'installation', and FABRIKA_EMAIL_PROVIDER is not set: Control writes it when it deploys the application (none for an installation without a transport)`,
		)
	}
	return null
}

function ownTransport(names: readonly string[], input: MailTransportInput, problems: string[]): JobMailTransport | null {
	if (input.own === undefined) {
		return null
	}
	let built: unknown
	try {
		built = input.own(input.application)
	} catch (error) {
		if (!(error instanceof EmailDeliveryError)) {
			throw error
		}
		problems.push(`serve's mail: ${error.message}`)
		return null
	}
	const sender = parseSender(built)
	if (sender === undefined) {
		problems.push("serve's mail returned no EmailSender (capabilities and send(message, signal))")
		return null
	}
	if (sender !== null) {
		return { sender, available: true }
	}
	if (input.local) {
		return noMail(names, 'own')
	}
	for (const name of names) {
		problems.push(`job '${name}' declares mailer: 'own', and serve's mail built no transport from the application's variables`)
	}
	return null
}

const SenderCapabilities = z.object({ idempotent: z.boolean(), confirmation: z.enum(['sync', 'queued']), maxBatch: z.int().positive() })

/** What `serve`'s `mail` returned: a sender, `null` for none, `undefined` for anything else. */
function parseSender(value: unknown): EmailSender | null | undefined {
	if (value === null) {
		return null
	}
	if (typeof value !== 'object') {
		return undefined
	}
	const send: unknown = Reflect.get(value, 'send')
	const capabilities = SenderCapabilities.safeParse(Reflect.get(value, 'capabilities'))
	if (typeof send !== 'function' || !capabilities.success) {
		return undefined
	}
	return Object.freeze({
		capabilities: Object.freeze(capabilities.data),
		send: (message: EmailMessage, signal: AbortSignal): Promise<EmailDeliveryResult> => Reflect.apply(send, value, [message, signal]),
	})
}

/** Where the installation has no transport: every send fails `not_sent`, and the boot does not. */
export const NO_MAIL: JobMailTransport = Object.freeze({
	sender: Object.freeze({
		capabilities: Object.freeze({ idempotent: true, confirmation: 'sync', maxBatch: 1 }),
		send: () => Promise.reject(new EmailDeliveryError('This installation has no mail transport', { code: 'mail_not_configured' })),
	}),
	available: false,
})

function noMail(names: readonly string[], kind: JobMailer): JobMailTransport {
	for (const name of names) {
		console.warn(
			`fabrika: job '${name}' sends mail, and this installation has no ${kind} mail transport: ctx.mail.available is false, and every send fails with mail_not_configured`,
		)
	}
	return NO_MAIL
}
