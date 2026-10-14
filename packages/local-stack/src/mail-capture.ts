// IAM's mail in the local composition. `iam-server.ts` hands IAM a sender that writes each message to `.state/mail/`
// instead of delivering it; a browser suite reads a person's message back here and opens its link. The messages hold
// one-time links, so nothing here prints one.

import { type CapturedEmail, readCapturedEmails } from '@fabrika/email/directory'
import { resolve } from 'node:path'

/** The same path in the IAM container, which mounts the workspace, and on the host. */
export const MAIL_DIRECTORY = resolve(import.meta.dir, '..', '.state', 'mail')

const IAM_ORIGIN = 'http://iam.fabrika.localhost:18080'
const URL_PATTERN = /https?:\/\/\S+/g

export interface MailQuery {
	/** The mailbox, as IAM normalizes it. */
	readonly to: string
	/** Only a message captured at or after this time (ms since the epoch, the host's clock that the container shares). */
	readonly since: number
	readonly timeoutMs?: number
}

/** Wait for the newest message to `to` since `since`. */
export async function waitForMail(query: MailQuery): Promise<CapturedEmail> {
	const deadline = Date.now() + (query.timeoutMs ?? 15_000)
	for (;;) {
		const found = (await readCapturedEmails(MAIL_DIRECTORY)).filter((email) => email.to === query.to && email.capturedAt >= query.since).at(-1)
		if (found !== undefined) return found
		if (Date.now() > deadline) throw new Error('no e-mail reached the mailbox in time')
		await Bun.sleep(200)
	}
}

/** The one link to IAM a message carries: its action URL. */
export function actionLinkOf(email: CapturedEmail): string {
	const links = [...new Set(email.text.match(URL_PATTERN) ?? [])].filter((link) => link.startsWith(`${IAM_ORIGIN}/`))
	const [link] = links
	if (link === undefined || links.length !== 1) throw new Error('the e-mail does not carry exactly one IAM link')
	return link
}

/** Wait for the person's newest message since `since` and answer its action link. */
export async function waitForMailLink(query: MailQuery): Promise<string> {
	return actionLinkOf(await waitForMail(query))
}
