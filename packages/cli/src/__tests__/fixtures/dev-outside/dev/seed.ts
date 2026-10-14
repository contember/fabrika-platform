import type { DevSeed } from '@fabrika/app/testing'
import type { contract } from '../fabrika.contract'

const seed: DevSeed<typeof contract> = async (dev, outside) => {
	const joined = await dev.fetch('/join', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email: 'ada@signup.example', challengeToken: crypto.randomUUID() }),
	})
	if (!joined.ok) throw new Error(`the sign-up form answered ${joined.status}`)
	const welcomed = await dev.runJob('welcome')
	if (welcomed.status !== 'succeeded') throw new Error(`the welcome job ${welcomed.status}`)
	if (outside.outbox().length !== 1) throw new Error('the welcome job sent no mail to the dev outbox')
	await dev.runJob('broken')
	return {}
}

export default seed
