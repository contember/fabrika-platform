import { z } from 'zod'
import { describeEmailSenderConformance } from '../conformance.js'
import { ResendEmailSender } from '../resend.js'

const API_KEY = 're_conformance_secret_4b9d'
const requestSchema = z.object({
	from: z.string(),
	to: z.string(),
	subject: z.string(),
	text: z.string(),
	html: z.string().optional(),
	reply_to: z.string().optional(),
	headers: z.object({ 'List-Unsubscribe': z.string(), 'List-Unsubscribe-Post': z.literal('List-Unsubscribe=One-Click') }).strict().optional(),
})

function errorAnswer(status: number, name: string): Response {
	return Response.json({ name, message: `private provider detail for ${name}` }, { status })
}

describeEmailSenderConformance('ResendEmailSender', {
	kind: 'http',
	secrets: [API_KEY],
	create: (fetch, { timeoutMs }) => new ResendEmailSender({ apiKey: API_KEY, from: { address: 'auth@example.test' }, fetch, timeoutMs }),
	async readRequest(request) {
		const body = requestSchema.parse(await request.json())
		const fromName = /^"?(.*?)"? <auth@example\.test>$/.exec(body.from)?.[1]
		return {
			to: body.to,
			subject: body.subject,
			text: body.text,
			...(body.html === undefined ? {} : { html: body.html }),
			...(body.reply_to === undefined ? {} : { replyTo: body.reply_to }),
			...(fromName === undefined ? {} : { fromName }),
			...(body.headers === undefined ? {} : { unsubscribeUrl: body.headers['List-Unsubscribe'].replace(/^<(.*)>$/, '$1') }),
			idempotencyKey: request.headers.get('idempotency-key') ?? undefined,
		}
	},
	answers: {
		accepted: () => Response.json({ id: 'resend-message-1' }),
		malformedSuccess: () => Response.json({ message: 'private provider detail without an id' }),
		unauthorized: () => errorAnswer(401, 'missing_api_key'),
		rejected: () => errorAnswer(422, 'validation_error'),
		rateLimited: () => errorAnswer(429, 'rate_limit_exceeded'),
		quotaExceeded: () => errorAnswer(429, 'daily_quota_exceeded'),
		unavailable: () => errorAnswer(500, 'internal_server_error'),
		inProgress: () => errorAnswer(409, 'concurrent_idempotent_requests'),
		idempotencyConflict: () => errorAnswer(409, 'invalid_idempotent_request'),
	},
})
