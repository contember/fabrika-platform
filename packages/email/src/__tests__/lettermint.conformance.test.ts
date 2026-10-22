import { z } from 'zod'
import { describeEmailSenderConformance } from '../conformance.js'
import { LettermintEmailSender } from '../lettermint.js'

const PROJECT_TOKEN = 'lm_conformance_secret_5e3a'
const requestSchema = z.object({
	from: z.string(),
	to: z.tuple([z.string()]),
	subject: z.string(),
	text: z.string(),
	html: z.string().optional(),
	reply_to: z.tuple([z.string()]).optional(),
	headers: z.object({ 'List-Unsubscribe': z.string(), 'List-Unsubscribe-Post': z.literal('List-Unsubscribe=One-Click') }).strict().optional(),
	attachments: z.array(z.object({ filename: z.string(), content: z.string(), content_type: z.string() }).strict()).optional(),
})

function errorAnswer(status: number, code: string): Response {
	return Response.json({ error: { code, message: `private provider detail for ${code}`, details: null } }, { status })
}

describeEmailSenderConformance('LettermintEmailSender', {
	kind: 'http',
	secrets: [PROJECT_TOKEN],
	create: (fetch, { timeoutMs }) =>
		new LettermintEmailSender({ projectToken: PROJECT_TOKEN, from: { address: 'auth@example.test' }, fetch, timeoutMs }),
	async readRequest(request) {
		const body = requestSchema.parse(await request.json())
		const fromName = /^"?(.*?)"? <auth@example\.test>$/.exec(body.from)?.[1]
		return {
			to: body.to[0],
			subject: body.subject,
			text: body.text,
			...(body.html === undefined ? {} : { html: body.html }),
			...(body.reply_to === undefined ? {} : { replyTo: body.reply_to[0] }),
			...(fromName === undefined ? {} : { fromName }),
			...(body.headers === undefined ? {} : { unsubscribeUrl: body.headers['List-Unsubscribe'].replace(/^<(.*)>$/, '$1') }),
			...(body.attachments === undefined
				? {}
				: {
					attachments: body.attachments.map((attachment) => ({
						filename: attachment.filename,
						contentType: attachment.content_type,
						content: attachment.content,
					})),
				}),
			idempotencyKey: request.headers.get('idempotency-key') ?? undefined,
		}
	},
	answers: {
		accepted: () => Response.json({ message_id: 'lettermint-message-1', status: 'pending' }, { status: 202 }),
		malformedSuccess: () => Response.json({ status: 'private provider detail without an id' }, { status: 202 }),
		unauthorized: () => Response.json({ message: 'Provided API token is invalid.' }, { status: 401 }),
		rejected: () =>
			Response.json({
				message: "The domain 'example.com' is not verified or does not belong to your account.",
				errors: { from: ["The domain 'example.com' is not verified or does not belong to your account."] },
			}, { status: 422 }),
		rateLimited: () => errorAnswer(429, 'RATE_LIMITED'),
		unavailable: () => errorAnswer(500, 'INTERNAL_ERROR'),
		// The two 409s as a live project answered them in October 2026.
		inProgress: () =>
			Response.json({ message: 'Another request with the same idempotency key is currently being processed. Please retry this request later.' }, {
				status: 409,
			}),
		idempotencyConflict: () =>
			Response.json({
				message:
					'This idempotency key has already been used on a request with a different payload. Retrying this request requires changing the idempotency key or payload.',
			}, { status: 409 }),
	},
})
