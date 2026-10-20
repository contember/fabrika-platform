import type { DevSeed } from '@fabrika/app/testing'
import type { contract } from '../fabrika.contract'

const seed: DevSeed<typeof contract> = async (dev, outside) => {
	const joined = await dev.fetch('/api/signups.join', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email: 'ada@signup.example', challengeToken: crypto.randomUUID() }),
	})
	if (!joined.ok) throw new Error(`the sign-up answered ${joined.status}`)
	const welcomed = await dev.runJob('welcome')
	if (welcomed.status !== 'succeeded') throw new Error(`the welcome job ${welcomed.status}`)
	if (outside.outbox().length !== 1) throw new Error('the welcome job sent no mail to the dev outbox')
	await dev.runJob('broken')
	const accepted = await dev.runJob('receipt')
	if (accepted.status !== 'succeeded') throw new Error(`the first receipt ${accepted.status}`)
	dev.mail.refuse('provider_rejected')
	const refused = await dev.runJob('receipt')
	dev.mail.heal()
	if (refused.status !== 'failed') throw new Error(`the refused receipt ${refused.status}`)
	if (outside.mails().length !== 2) throw new Error('the receipt job did not hand two messages to the mail stand-in')
	return {}
}

export default seed
