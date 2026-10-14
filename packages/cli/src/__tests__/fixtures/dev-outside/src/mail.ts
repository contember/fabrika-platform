import { defineDeps } from '@fabrika/app/implement'

export interface Mailer {
	send(to: string, signal: AbortSignal): Promise<void>
}

export const mailer = defineDeps((env): Mailer => ({
	async send(to, signal) {
		const url = env['MAIL_API_URL']
		if (typeof url !== 'string' || url === '') throw new Error('the application variable MAIL_API_URL is not set')
		const response = await fetch(url, {
			method: 'POST',
			headers: { Authorization: 'Bearer dev-mail-key', 'Content-Type': 'application/json' },
			body: JSON.stringify({ to, subject: 'Welcome aboard', text: `Hello ${to}, your sign-up is in.` }),
			signal,
		})
		if (!response.ok) throw new Error(`the mail provider answered ${response.status}`)
	},
}))
