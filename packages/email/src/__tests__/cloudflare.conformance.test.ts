import { z } from 'zod'
import { CloudflareEmailSender } from '../cloudflare.js'
import { describeEmailSenderConformance } from '../conformance.js'

const API_TOKEN = 'cf-conformance-secret-5a9d'
const ACCOUNT_ID = '023e105f4ecef8ad9ca31a8372d0c353'
const requestSchema = z.object({
	from: z.object({ address: z.literal('auth@example.test'), name: z.string().optional() }).strict(),
	to: z.string(),
	subject: z.string(),
	text: z.string(),
	html: z.string().optional(),
	reply_to: z.string().optional(),
	headers: z.object({ 'List-Unsubscribe': z.string(), 'List-Unsubscribe-Post': z.literal('List-Unsubscribe=One-Click') }).strict().optional(),
	attachments: z.array(
		z.object({ content: z.string(), filename: z.string(), type: z.string(), disposition: z.literal('attachment') }).strict(),
	).optional(),
}).strict()

function errorAnswer(status: number, code: number): Response {
	return Response.json({ success: false, errors: [{ code, message: `private provider detail for ${code}` }], messages: [], result: null }, { status })
}

describeEmailSenderConformance('CloudflareEmailSender', {
	kind: 'http',
	secrets: [API_TOKEN],
	create: (fetch, { timeoutMs }) =>
		new CloudflareEmailSender({ apiToken: API_TOKEN, accountId: ACCOUNT_ID, from: { address: 'auth@example.test' }, fetch, timeoutMs }),
	async readRequest(request) {
		const body = requestSchema.parse(await request.json())
		return {
			to: body.to,
			subject: body.subject,
			text: body.text,
			...(body.html === undefined ? {} : { html: body.html }),
			...(body.reply_to === undefined ? {} : { replyTo: body.reply_to }),
			...(body.from.name === undefined ? {} : { fromName: body.from.name }),
			...(body.headers === undefined ? {} : { unsubscribeUrl: body.headers['List-Unsubscribe'].replace(/^<(.*)>$/, '$1') }),
			...(body.attachments === undefined
				? {}
				: {
					attachments: body.attachments.map((attachment) => ({
						filename: attachment.filename,
						contentType: attachment.type,
						content: attachment.content,
					})),
				}),
		}
	},
	answers: {
		accepted: () =>
			Response.json({
				success: true,
				errors: [],
				messages: [],
				result: { delivered: ['recipient@example.test'], message_id: '<cloudflare-message-1@example.test>', permanent_bounces: [], queued: [] },
			}),
		malformedSuccess: () => Response.json({ success: true, errors: [], messages: [], result: { delivered: [] } }),
		// The status and code of each answer as Cloudflare's REST API reference documents them (October 2026).
		unauthorized: () => errorAnswer(401, 10101),
		rejected: () => errorAnswer(400, 10001),
		rateLimited: () => errorAnswer(429, 10004),
		unavailable: () => errorAnswer(500, 10002),
	},
})
