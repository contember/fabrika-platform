import { z } from 'zod'
import { describeEmailSenderConformance } from '../conformance.js'
import { SmartEmailingEmailSender } from '../smartemailing.js'

const USERNAME = 'conformance-user-7c2e'
const API_KEY = 'smartemailing_conformance_secret_1f8a'
const requestSchema = z.object({
	sender_credentials: z.object({ from: z.string(), sender_name: z.string().optional(), reply_to: z.string().optional() }),
	message_contents: z.object({ subject: z.string(), text_body: z.string(), html_body: z.string().optional() }),
	tasks: z.tuple([z.object({ recipient: z.object({ emailaddress: z.string() }) })]),
})

function errorAnswer(status: number): Response {
	return Response.json({ status: 'error', meta: [], message: `private provider detail for ${status}` }, { status })
}

describeEmailSenderConformance('SmartEmailingEmailSender', {
	kind: 'http',
	secrets: [USERNAME, API_KEY, btoa(`${USERNAME}:${API_KEY}`)],
	create: (fetch, { timeoutMs }) =>
		new SmartEmailingEmailSender({ username: USERNAME, apiKey: API_KEY, from: { address: 'auth@example.test' }, fetch, timeoutMs }),
	async readRequest(request) {
		const body = requestSchema.parse(await request.json())
		const { sender_credentials: sender, message_contents: contents } = body
		return {
			to: body.tasks[0].recipient.emailaddress,
			subject: contents.subject,
			text: contents.text_body,
			...(contents.html_body === undefined ? {} : { html: contents.html_body }),
			...(sender.reply_to === undefined ? {} : { replyTo: sender.reply_to }),
			...(sender.sender_name === undefined ? {} : { fromName: sender.sender_name }),
		}
	},
	answers: {
		accepted: () =>
			Response.json({ status: 'created', meta: [], data: [{ recipient: 'recipient@example.test', id: 'smartemailing-1' }] }, { status: 201 }),
		malformedSuccess: () => Response.json({ status: 'created', meta: [], data: [] }, { status: 201 }),
		unauthorized: () => errorAnswer(401),
		rejected: () => errorAnswer(422),
		rateLimited: () => errorAnswer(429),
		unavailable: () => errorAnswer(503),
	},
})
