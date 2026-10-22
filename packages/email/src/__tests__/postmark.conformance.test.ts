import { z } from 'zod'
import { describeEmailSenderConformance } from '../conformance.js'
import { PostmarkEmailSender } from '../postmark.js'

const SERVER_TOKEN = 'postmark-conformance-secret-2c7d'
const requestSchema = z.object({
	From: z.string(),
	To: z.string(),
	Subject: z.string(),
	TextBody: z.string(),
	HtmlBody: z.string().optional(),
	ReplyTo: z.string().optional(),
	Headers: z.array(z.object({ Name: z.string(), Value: z.string() }).strict()).optional(),
	Attachments: z.array(z.object({ Name: z.string(), Content: z.string(), ContentType: z.string() }).strict()).optional(),
})

function errorAnswer(status: number, errorCode: number): Response {
	return Response.json({ ErrorCode: errorCode, Message: `private provider detail for ${errorCode}` }, { status })
}

describeEmailSenderConformance('PostmarkEmailSender', {
	kind: 'http',
	secrets: [SERVER_TOKEN],
	create: (fetch, { timeoutMs }) => new PostmarkEmailSender({ serverToken: SERVER_TOKEN, from: { address: 'auth@example.test' }, fetch, timeoutMs }),
	async readRequest(request) {
		const body = requestSchema.parse(await request.json())
		const fromName = /^"?(.*?)"? <auth@example\.test>$/.exec(body.From)?.[1]
		const unsubscribe = body.Headers?.find((header) => header.Name === 'List-Unsubscribe')
		const oneClick = body.Headers?.some((header) => header.Name === 'List-Unsubscribe-Post' && header.Value === 'List-Unsubscribe=One-Click')
		return {
			to: body.To,
			subject: body.Subject,
			text: body.TextBody,
			...(body.HtmlBody === undefined ? {} : { html: body.HtmlBody }),
			...(body.ReplyTo === undefined ? {} : { replyTo: body.ReplyTo }),
			...(fromName === undefined ? {} : { fromName }),
			...(unsubscribe === undefined || oneClick !== true ? {} : { unsubscribeUrl: unsubscribe.Value.replace(/^<(.*)>$/, '$1') }),
			...(body.Attachments === undefined
				? {}
				: {
					attachments: body.Attachments.map((attachment) => ({
						filename: attachment.Name,
						contentType: attachment.ContentType,
						content: attachment.Content,
					})),
				}),
		}
	},
	answers: {
		accepted: () =>
			Response.json({ To: 'recipient@example.test', SubmittedAt: '2026-10-22T10:00:00Z', MessageID: 'postmark-message-1', ErrorCode: 0, Message: 'OK' }),
		malformedSuccess: () => Response.json({ Message: 'private provider detail without an id' }),
		// As a live server answered in October 2026.
		unauthorized: () => Response.json({ ErrorCode: 10, Message: 'Request does not contain a valid Server token.' }, { status: 401 }),
		rejected: () =>
			Response.json({ ErrorCode: 300, Message: "Error parsing 'To': Illegal email address 'not-an-address'. It must contain the '@' symbol." }, {
				status: 422,
			}),
		rateLimited: () => new Response('private provider detail for the rate limit', { status: 429 }),
		unavailable: () => errorAnswer(500, 0),
		quotaExceeded: () => errorAnswer(422, 405),
	},
})
