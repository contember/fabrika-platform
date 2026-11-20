import { z } from 'zod'
import { BrevoEmailSender, brevoHtmlOfText } from '../brevo.js'
import { describeEmailSenderConformance } from '../conformance.js'

const API_KEY = 'xkeysib-conformance-secret-7e3b'
const requestSchema = z.object({
	sender: z.object({ email: z.literal('auth@example.test'), name: z.string().optional() }).strict(),
	to: z.tuple([z.object({ email: z.string() }).strict()]),
	subject: z.string(),
	htmlContent: z.string(),
	textContent: z.string(),
	replyTo: z.object({ email: z.string() }).strict().optional(),
	headers: z.object({ idempotencyKey: z.string().uuid() }).strict(),
	attachment: z.array(z.object({ name: z.string(), content: z.string() }).strict()).optional(),
}).strict()

/** Brevo takes no media type and derives it from the file name; the harness does the same for the kit's one file. */
const MEDIA_TYPES: Readonly<Record<string, string>> = { txt: 'text/plain' }

function errorAnswer(status: number, code: string): Response {
	return Response.json({ code, message: `private provider detail for ${code}` }, { status })
}

describeEmailSenderConformance('BrevoEmailSender', {
	kind: 'http',
	secrets: [API_KEY],
	create: (fetch, { timeoutMs }) => new BrevoEmailSender({ apiKey: API_KEY, from: { address: 'auth@example.test' }, fetch, timeoutMs }),
	async readRequest(request) {
		const body = requestSchema.parse(await request.json())
		// A text-only message carries its text as HTML, because Brevo requires one; that is no HTML of the message's own.
		const html = body.htmlContent === brevoHtmlOfText(body.textContent) ? undefined : body.htmlContent
		return {
			to: body.to[0].email,
			subject: body.subject,
			text: body.textContent,
			...(html === undefined ? {} : { html }),
			...(body.replyTo === undefined ? {} : { replyTo: body.replyTo.email }),
			...(body.sender.name === undefined ? {} : { fromName: body.sender.name }),
			...(body.attachment === undefined
				? {}
				: {
					attachments: body.attachment.map((attachment) => ({
						filename: attachment.name,
						contentType: MEDIA_TYPES[attachment.name.slice(attachment.name.lastIndexOf('.') + 1)] ?? 'application/octet-stream',
						content: attachment.content,
					})),
				}),
		}
	},
	answers: {
		accepted: () => Response.json({ messageId: '<202611201200.12345678901@smtp-relay.mailin.fr>' }, { status: 201 }),
		malformedSuccess: () => Response.json({ detail: 'private provider detail without an id' }, { status: 201 }),
		// A 401 carries `code: unauthorized`, a substring of the delivery code the kit forbids; the unit test covers it.
		unauthorized: () => errorAnswer(403, 'permission_denied'),
		rejected: () => errorAnswer(400, 'invalid_parameter'),
		rateLimited: () => errorAnswer(429, 'too_many_requests'),
		unavailable: () => new Response('private provider detail for the outage', { status: 502 }),
		quotaExceeded: () => errorAnswer(402, 'not_enough_credits'),
		// As Brevo's batch-sending guide documents a key it took within the last 30 minutes.
		idempotencyConflict: () =>
			Response.json({ code: 'duplicate_parameter', message: 'Email for the idempotency key has already been processed' }, { status: 400 }),
	},
})
